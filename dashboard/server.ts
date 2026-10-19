import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchAdjustCreativePerformance } from "../bot/lib/adjust.js";
import {
  buildHelperCompatibleDashboard,
  summarizeBoard,
} from "../bot/lib/dashboard.js";
import { defaultDateRange } from "../bot/lib/dates.js";
import {
  fetchMetaDeliveryBreakdown,
  fetchMetaDailyTrend,
  type MetaBreakdownDimension,
} from "../bot/lib/meta-breakdowns.js";
import {
  fetchMetaAdMedia,
  fetchMetaAdPreview,
  type MetaAdMedia,
} from "../bot/lib/meta-media.js";
import {
  fetchMetaVideoMetrics,
  type MetaAdVideoMetrics,
} from "../bot/lib/meta-video.js";
import {
  analyzeCreative,
  creativeFingerprint,
  CreativeAnalysisStore,
  type CreativeAnalysis,
} from "./analysis.js";
import { fetchAdManageAssets } from "./admanage-assets.js";
import { fetchAdjacentCompetitorCreatives } from "./competitors.js";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
try {
  process.loadEnvFile(join(projectRoot, ".env.local"));
} catch {
  // Fixture mode still renders when local credentials are unavailable.
}

// Cloud Agent port forwarding detects all-interface bindings. The VM remains
// isolated; users access this through Cursor's Forwarded Ports/internal browser.
const host = process.env.DASHBOARD_HOST?.trim() || "0.0.0.0";
const port = Number(process.env.PORT ?? process.env.DASHBOARD_PORT ?? 4173);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT or DASHBOARD_PORT must be an integer from 1–65535.");
}
const dataDirectory = resolve(
  process.env.DASHBOARD_DATA_DIR?.trim() ||
    join(projectRoot, ".agent-serve"),
);
const dashboardUsername = process.env.DASHBOARD_USERNAME?.trim() ?? "";
const dashboardPassword = process.env.DASHBOARD_PASSWORD ?? "";
const hosted =
  process.env.RENDER === "true" || process.env.NODE_ENV === "production";
if (Boolean(dashboardUsername) !== Boolean(dashboardPassword)) {
  throw new Error(
    "Set both DASHBOARD_USERNAME and DASHBOARD_PASSWORD, or neither.",
  );
}
if (dashboardPassword && dashboardPassword.length < 12) {
  throw new Error("DASHBOARD_PASSWORD must contain at least 12 characters.");
}
if (hosted && (!dashboardUsername || !dashboardPassword)) {
  throw new Error(
    "Dashboard authentication is required in production. Set DASHBOARD_USERNAME and DASHBOARD_PASSWORD.",
  );
}
const maxDays = 90;
const maxScanLimit = 10_000;

function boundedEnvInt(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(process.env[name]);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

const scanConfig = {
  enabled: process.env.CREATIVE_SCAN_AUTO?.trim() !== "false",
  dailyLimit: boundedEnvInt(
    "CREATIVE_SCAN_DAILY_LIMIT",
    500,
    1,
    maxScanLimit,
  ),
  hourUtc: boundedEnvInt("CREATIVE_SCAN_HOUR_UTC", 7, 0, 23),
  days: boundedEnvInt("CREATIVE_SCAN_DAYS", 30, 1, 90),
  force: process.env.CREATIVE_SCAN_FORCE_DAILY?.trim() === "true",
  concurrency: boundedEnvInt("CREATIVE_SCAN_CONCURRENCY", 4, 1, 20),
};
let nextScheduledScanAt: string | null = null;
const analysisStore = new CreativeAnalysisStore(
  join(dataDirectory, "creative-analysis.json"),
);

type ScanJob = {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  total: number;
  completed: number;
  scanned: number;
  skipped: number;
  failed: number;
  current: string | null;
  errors: string[];
  startedAt: string;
  finishedAt: string | null;
  trigger: "manual" | "scheduled";
};

const scanJobs = new Map<string, ScanJob>();
let competitorCache:
  | {
      expiresAt: number;
      value: Awaited<ReturnType<typeof fetchAdjacentCompetitorCreatives>>;
    }
  | undefined;
const competitorCachePath = join(
  dataDirectory,
  "competitor-creatives.json",
);

async function competitorFeed(force = false): Promise<
  Awaited<ReturnType<typeof fetchAdjacentCompetitorCreatives>>
> {
  if (!force && competitorCache && competitorCache.expiresAt > Date.now()) {
    return competitorCache.value;
  }
  if (!force) {
    try {
      const stored = JSON.parse(
        await readFile(competitorCachePath, "utf8"),
      ) as Awaited<ReturnType<typeof fetchAdjacentCompetitorCreatives>>;
      const age = Date.now() - new Date(stored.generatedAt).getTime();
      if (Number.isFinite(age) && age >= 0 && age < 6 * 60 * 60_000) {
        competitorCache = {
          expiresAt: Date.now() + (6 * 60 * 60_000 - age),
          value: stored,
        };
        return stored;
      }
    } catch {
      // Missing or stale disk cache falls through to a live read.
    }
  }
  const value = await fetchAdjacentCompetitorCreatives();
  competitorCache = {
    expiresAt: Date.now() + 6 * 60 * 60_000,
    value,
  };
  await mkdir(dirname(competitorCachePath), { recursive: true });
  await writeFile(competitorCachePath, `${JSON.stringify(value)}\n`, {
    mode: 0o600,
  });
  return value;
}

type ApiCreative = ReturnType<typeof buildHelperCompatibleDashboard>[number] & {
  media: MetaAdMedia[];
};

type DashboardPayload = {
  source: string;
  range: { since: string; until: string };
  generatedAt: string;
  method: string;
  retention: {
    method: string;
    cutoffs: { d1: string; d3: string; d7: string };
  };
  adjustApp: string | null;
  totals: ReturnType<typeof summarizeBoard>;
  creatives: ApiCreative[];
  warnings: string[];
};

type CacheEntry = { expiresAt: number; value: DashboardPayload };
const dataCache = new Map<string, CacheEntry>();
const previewCache = new Map<string, { expiresAt: number; src: string }>();
const sliceCache = new Map<string, { expiresAt: number; value: SlicePayload }>();
const detailCache = new Map<
  string,
  {
    expiresAt: number;
    value: { creative: ApiCreative; rank: number; trend: Awaited<ReturnType<typeof fetchMetaDailyTrend>> };
  }
>();
const videoCache = new Map<
  string,
  { expiresAt: number; value: VideoMetricsPayload }
>();

type DeliveryMetrics = {
  spend: number;
  impressions: number;
  clicks: number;
  cpc: number;
  cpm: number;
  ctr: number;
};

type SliceSegment = {
  key: string;
  label: string;
  age?: string;
  gender?: string;
  publisher?: string;
  device?: string;
  operatingSystem?: string;
  totals: DeliveryMetrics;
  creatives: Record<string, DeliveryMetrics>;
};

type SlicePayload = {
  dimension: MetaBreakdownDimension;
  range: { since: string; until: string };
  segments: SliceSegment[];
};

type CreativeVideoMetrics = Omit<MetaAdVideoMetrics, "adId"> & {
  adCount: number;
  startRate: number;
  hookRate: number;
  holdRate: number;
  p25Rate: number;
  p50Rate: number;
  p75Rate: number;
  completionRate: number;
  clickToLandingRate: number;
  landingPageConversionRate: number;
};

type VideoMetricsPayload = {
  range: { since: string; until: string };
  totals: CreativeVideoMetrics;
  creatives: Record<string, CreativeVideoMetrics>;
};

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(value));
}

function text(
  res: ServerResponse,
  status: number,
  value: string,
  contentType: string,
): void {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
  });
  res.end(value);
}

function equalCredential(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function requestIsAuthorized(req: IncomingMessage): boolean {
  if (!dashboardUsername || !dashboardPassword) return true;
  const authorization = req.headers.authorization ?? "";
  const [scheme, encoded, ...rest] = authorization.split(" ");
  if (scheme?.toLowerCase() !== "basic" || !encoded || rest.length > 0) {
    return false;
  }
  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return false;
    return (
      equalCredential(decoded.slice(0, separator), dashboardUsername) &&
      equalCredential(decoded.slice(separator + 1), dashboardPassword)
    );
  } catch {
    return false;
  }
}

function requestAuthentication(res: ServerResponse): void {
  res.writeHead(401, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "www-authenticate":
      'Basic realm="Creative Intelligence", charset="UTF-8"',
    "x-content-type-options": "nosniff",
  });
  res.end("Authentication required.");
}

function parseDate(value: string | null): string | undefined {
  if (!value) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid date: ${value}`);
  }
  return value;
}

function resolveRange(url: URL): { since: string; until: string } {
  const since = parseDate(url.searchParams.get("since"));
  const until = parseDate(url.searchParams.get("until"));
  if (since || until) {
    if (!since || !until) throw new Error("Provide both since and until.");
    if (since > until) throw new Error("since must be before until.");
    const days =
      Math.floor(
        (new Date(`${until}T00:00:00Z`).getTime() -
          new Date(`${since}T00:00:00Z`).getTime()) /
          86_400_000,
      ) + 1;
    if (days < 1 || days > maxDays) {
      throw new Error(`Date window must be 1–${maxDays} days.`);
    }
    return { since, until };
  }

  const rawDays = Number(url.searchParams.get("days") ?? 7);
  if (!Number.isInteger(rawDays) || rawDays < 1 || rawDays > maxDays) {
    throw new Error(`days must be an integer from 1–${maxDays}.`);
  }
  return defaultDateRange(rawDays);
}

async function buildPayload(range: {
  since: string;
  until: string;
}, force = false): Promise<DashboardPayload> {
  const key = `${range.since}:${range.until}`;
  const cached = dataCache.get(key);
  if (!force && cached && cached.expiresAt > Date.now()) return cached.value;

  const adjust = await fetchAdjustCreativePerformance(range, {
    partner: "meta",
  });
  const board = buildHelperCompatibleDashboard(adjust.rows, maxScanLimit);
  const warnings: string[] = [];
  let mediaByAd: Record<string, MetaAdMedia> = {};
  try {
    mediaByAd = await fetchMetaAdMedia(board.flatMap((row) => row.adIds));
  } catch (error) {
    warnings.push(
      `Media previews unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    const assets = await fetchAdManageAssets(range);
    for (const [adId, media] of Object.entries(mediaByAd)) {
      const asset = assets[adId];
      if (!asset) continue;
      media.videoUrl = asset.videoUrl;
      if ((media.thumbnailWidth ?? 0) < 1000) {
        if (asset.imageUrl?.startsWith("https://")) {
          media.thumbnailUrl = asset.imageUrl;
        } else if (
          asset.thumbnailUrl?.startsWith("https://") &&
          !asset.thumbnailUrl.includes("media.admanage.")
        ) {
          media.thumbnailUrl = asset.thumbnailUrl;
        }
      }
    }
  } catch (error) {
    warnings.push(
      `High-resolution asset fallback unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const creatives: ApiCreative[] = board.map((row) => ({
    ...row,
    media: row.adIds
      .map((adId) => mediaByAd[adId])
      .filter((media): media is MetaAdMedia => media !== undefined),
  }));
  const withSpend = creatives.filter((row) => row.metaSpend > 0);
  const value: DashboardPayload = {
    source: adjust.source,
    range,
    generatedAt: new Date().toISOString(),
    method: "Gist helper-compatible Adjust creative grouping",
    retention: {
      method:
        "retained_users_dN / installs from mature Adjust UTC calendar cohorts",
      cutoffs: adjust.retentionCutoffs,
    },
    adjustApp: adjust.appName,
    totals: summarizeBoard(withSpend),
    creatives,
    warnings,
  };
  dataCache.set(key, { expiresAt: Date.now() + 5 * 60_000, value });
  return value;
}

async function buildAnalysisPayload(range: {
  since: string;
  until: string;
}): Promise<{
  available: boolean;
  model: string;
  coverage: { scanned: number; stale: number; total: number };
  schedule: {
    enabled: boolean;
    nextRunAt: string | null;
    dailyLimit: number;
    hourUtc: number;
    days: number;
    force: boolean;
    concurrency: number;
  };
  records: Array<{
    creativeId: string;
    status: "scanned" | "stale" | "unscanned";
    analysis: CreativeAnalysis | null;
  }>;
}> {
  const dashboard = await buildPayload(range);
  const saved = new Map(
    (await analysisStore.list()).map((record) => [record.creativeId, record]),
  );
  let scanned = 0;
  let stale = 0;
  const records = dashboard.creatives.map((creative) => {
    const analysis = saved.get(creative.creativeId);
    if (!analysis) {
      return {
        creativeId: creative.creativeId,
        status: "unscanned" as const,
        analysis: null,
      };
    }
    const current =
      analysis.fingerprint === creativeFingerprint(creative);
    if (current) scanned += 1;
    else stale += 1;
    return {
      creativeId: creative.creativeId,
      status: current ? ("scanned" as const) : ("stale" as const),
      analysis,
    };
  });
  return {
    available: Boolean(process.env.OPENAI_API_KEY?.trim()),
    model: process.env.OPENAI_ANALYSIS_MODEL?.trim() || "gpt-4.1-mini",
    coverage: { scanned, stale, total: dashboard.creatives.length },
    schedule: {
      enabled: scanConfig.enabled,
      nextRunAt: nextScheduledScanAt,
      dailyLimit: scanConfig.dailyLimit,
      hourUtc: scanConfig.hourUtc,
      days: scanConfig.days,
      force: scanConfig.force,
      concurrency: scanConfig.concurrency,
    },
    records,
  };
}

async function analyzeCreativeWithRetry(
  creative: ApiCreative,
): Promise<CreativeAnalysis> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await analyzeCreative(creative);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const transient =
        message.includes(" 429:") ||
        /\b5\d\d:/.test(message) ||
        message.includes("timed out") ||
        message.includes("fetch failed");
      if (!transient || attempt === 3) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, 1_000 * 2 ** attempt),
      );
    }
  }
  throw lastError;
}

async function runScanJob(
  job: ScanJob,
  range: { since: string; until: string },
  limit: number,
  force: boolean,
  concurrency = scanConfig.concurrency,
): Promise<void> {
  job.status = "running";
  try {
    const dashboard = await buildPayload(range);
    const candidates = dashboard.creatives
      .filter((creative) => creative.media.length > 0)
      .slice(0, limit);
    job.total = candidates.length;
    let cursor = 0;

    const worker = async (): Promise<void> => {
      while (cursor < candidates.length) {
        const creative = candidates[cursor++]!;
        job.current = creative.creativeName;
        try {
          const existing = await analysisStore.get(creative.creativeId);
          const fingerprint = creativeFingerprint(creative);
          if (!force && existing?.fingerprint === fingerprint) {
            job.skipped += 1;
          } else {
            await analysisStore.put(
              await analyzeCreativeWithRetry(creative),
            );
            job.scanned += 1;
          }
        } catch (error) {
          job.failed += 1;
          if (job.errors.length < 8) {
            job.errors.push(
              `${creative.creativeName}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        } finally {
          job.completed += 1;
        }
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(concurrency, Math.max(candidates.length, 1)) },
        () => worker(),
      ),
    );
    job.status = "completed";
  } catch (error) {
    job.status = "failed";
    job.errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    job.current = null;
    job.finishedAt = new Date().toISOString();
  }
}

async function readJsonBody(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
    string,
    unknown
  >;
}

function aggregateVideoMetrics(
  metrics: MetaAdVideoMetrics[],
): CreativeVideoMetrics {
  const total = {
    impressions: 0,
    videoStarts: 0,
    twoSecondViews: 0,
    threeSecondViews: 0,
    thirtySecondViews: 0,
    thruPlays: 0,
    p25: 0,
    p50: 0,
    p75: 0,
    p100: 0,
    watchSecondsWeighted: 0,
    linkClicks: 0,
    outboundClicks: 0,
    landingPageViews: 0,
    leads: 0,
    purchases: 0,
    purchaseValue: 0,
  };
  for (const metric of metrics) {
    total.impressions += metric.impressions;
    total.videoStarts += metric.videoStarts;
    total.twoSecondViews += metric.twoSecondViews;
    total.threeSecondViews += metric.threeSecondViews;
    total.thirtySecondViews += metric.thirtySecondViews;
    total.thruPlays += metric.thruPlays;
    total.p25 += metric.p25;
    total.p50 += metric.p50;
    total.p75 += metric.p75;
    total.p100 += metric.p100;
    total.watchSecondsWeighted +=
      metric.avgWatchSeconds * metric.videoStarts;
    total.linkClicks += metric.linkClicks;
    total.outboundClicks += metric.outboundClicks;
    total.landingPageViews += metric.landingPageViews;
    total.leads += metric.leads;
    total.purchases += metric.purchases;
    total.purchaseValue += metric.purchaseValue;
  }
  const round = (value: number) => Math.round(value * 100) / 100;
  const views = total.threeSecondViews || 1;
  return {
    adCount: metrics.length,
    impressions: total.impressions,
    videoStarts: total.videoStarts,
    twoSecondViews: total.twoSecondViews,
    threeSecondViews: total.threeSecondViews,
    thirtySecondViews: total.thirtySecondViews,
    thruPlays: total.thruPlays,
    p25: total.p25,
    p50: total.p50,
    p75: total.p75,
    p100: total.p100,
    avgWatchSeconds: round(
      total.videoStarts > 0
        ? total.watchSecondsWeighted / total.videoStarts
        : 0,
    ),
    linkClicks: total.linkClicks,
    outboundClicks: total.outboundClicks,
    outboundCtr: round(
      total.impressions > 0
        ? (total.outboundClicks / total.impressions) * 100
        : 0,
    ),
    landingPageViews: total.landingPageViews,
    leads: total.leads,
    purchases: total.purchases,
    purchaseValue: round(total.purchaseValue),
    startRate: round(
      total.impressions > 0
        ? (total.videoStarts / total.impressions) * 100
        : 0,
    ),
    hookRate: round(
      total.impressions > 0
        ? (total.threeSecondViews / total.impressions) * 100
        : 0,
    ),
    holdRate: round((total.thruPlays / views) * 100),
    p25Rate: round((total.p25 / views) * 100),
    p50Rate: round((total.p50 / views) * 100),
    p75Rate: round((total.p75 / views) * 100),
    completionRate: round((total.p100 / views) * 100),
    clickToLandingRate: round(
      total.linkClicks > 0
        ? (total.landingPageViews / total.linkClicks) * 100
        : 0,
    ),
    landingPageConversionRate: round(
      total.landingPageViews > 0
        ? (total.purchases / total.landingPageViews) * 100
        : 0,
    ),
  };
}

async function buildVideoMetricsPayload(
  range: { since: string; until: string },
  force = false,
): Promise<VideoMetricsPayload> {
  const cacheKey = `${range.since}:${range.until}`;
  const cached = videoCache.get(cacheKey);
  if (!force && cached && cached.expiresAt > Date.now()) return cached.value;
  const dashboard = await buildPayload(range);
  const byAd = await fetchMetaVideoMetrics(
    range,
    dashboard.creatives.flatMap((creative) => creative.adIds),
  );
  const creatives: Record<string, CreativeVideoMetrics> = {};
  for (const creative of dashboard.creatives) {
    const metrics = creative.adIds
      .map((adId) => byAd[adId])
      .filter((metric): metric is MetaAdVideoMetrics => metric !== undefined);
    creatives[creative.creativeId] = aggregateVideoMetrics(metrics);
  }
  const value = {
    range,
    totals: aggregateVideoMetrics(Object.values(byAd)),
    creatives,
  };
  videoCache.set(cacheKey, {
    expiresAt: Date.now() + 10 * 60_000,
    value,
  });
  return value;
}

function deliveryMetrics(input: {
  spend: number;
  impressions: number;
  clicks: number;
}): DeliveryMetrics {
  const { spend, impressions, clicks } = input;
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    spend: round(spend),
    impressions,
    clicks,
    cpc: round(clicks > 0 ? spend / clicks : 0),
    cpm: round(impressions > 0 ? (spend / impressions) * 1000 : 0),
    ctr: round(impressions > 0 ? (clicks / impressions) * 100 : 0),
  };
}

function segmentIdentity(
  dimension: MetaBreakdownDimension,
  row: {
    age?: string;
    gender?: string;
    publisher?: string;
    device?: string;
    operatingSystem?: string;
  },
): {
  key: string;
  label: string;
  age?: string;
  gender?: string;
  publisher?: string;
  device?: string;
  operatingSystem?: string;
} {
  if (dimension === "demographic") {
    const age = row.age ?? "unknown";
    const gender = row.gender ?? "unknown";
    const genderLabel =
      gender === "female" ? "Women" : gender === "male" ? "Men" : "Unknown";
    return {
      key: `${age}|${gender}`,
      label: `${genderLabel} · ${age}`,
      age,
      gender,
    };
  }
  if (dimension === "publisher") {
    const publisher = row.publisher ?? "unknown";
    return {
      key: publisher,
      label: publisher
        .split("_")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" "),
      publisher,
    };
  }
  if (dimension === "os") {
    const operatingSystem = row.operatingSystem ?? "other";
    const label =
      operatingSystem === "ios"
        ? "iOS"
        : operatingSystem === "android"
          ? "Android"
          : "Other / unknown";
    return {
      key: operatingSystem,
      label,
      operatingSystem,
    };
  }
  const device = row.device ?? "unknown";
  return {
    key: device,
    label: device
      .split("_")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" "),
    device,
  };
}

async function buildSlicePayload(
  range: { since: string; until: string },
  dimension: MetaBreakdownDimension,
  force = false,
): Promise<SlicePayload> {
  const cacheKey = `${range.since}:${range.until}:${dimension}`;
  const cached = sliceCache.get(cacheKey);
  if (!force && cached && cached.expiresAt > Date.now()) return cached.value;

  const dashboard = await buildPayload(range);
  const creativeByAd = new Map<string, string>();
  for (const creative of dashboard.creatives) {
    for (const adId of creative.adIds) {
      creativeByAd.set(adId, creative.creativeId);
    }
  }

  type Acc = {
    identity: ReturnType<typeof segmentIdentity>;
    spend: number;
    impressions: number;
    clicks: number;
    creatives: Map<
      string,
      { spend: number; impressions: number; clicks: number }
    >;
  };
  const segments = new Map<string, Acc>();
  const rows = await fetchMetaDeliveryBreakdown(range, dimension);
  for (const row of rows) {
    const creativeId = creativeByAd.get(row.adId);
    if (!creativeId) continue;
    const identity = segmentIdentity(dimension, row);
    let segment = segments.get(identity.key);
    if (!segment) {
      segment = {
        identity,
        spend: 0,
        impressions: 0,
        clicks: 0,
        creatives: new Map(),
      };
      segments.set(identity.key, segment);
    }
    segment.spend += row.spend;
    segment.impressions += row.impressions;
    segment.clicks += row.clicks;
    const creative = segment.creatives.get(creativeId) ?? {
      spend: 0,
      impressions: 0,
      clicks: 0,
    };
    creative.spend += row.spend;
    creative.impressions += row.impressions;
    creative.clicks += row.clicks;
    segment.creatives.set(creativeId, creative);
  }

  const value: SlicePayload = {
    dimension,
    range,
    segments: [...segments.values()]
      .map((segment) => ({
        ...segment.identity,
        totals: deliveryMetrics(segment),
        creatives: Object.fromEntries(
          [...segment.creatives.entries()].map(([creativeId, metrics]) => [
            creativeId,
            deliveryMetrics(metrics),
          ]),
        ),
      }))
      .sort((a, b) => b.totals.spend - a.totals.spend),
  };
  sliceCache.set(cacheKey, {
    expiresAt: Date.now() + 10 * 60_000,
    value,
  });
  return value;
}

const staticFiles: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
};

async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (url.pathname === "/healthz") {
    if (req.method !== "GET" && req.method !== "HEAD") {
      json(res, 405, { error: "Method not allowed" });
      return;
    }
    json(res, 200, { status: "ok" });
    return;
  }

  if (!requestIsAuthorized(req)) {
    requestAuthentication(res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/analysis/scan") {
    try {
      const range = resolveRange(url);
      const body = await readJsonBody(req);
      const rawLimit = Number(body.limit ?? 20);
      if (
        !Number.isInteger(rawLimit) ||
        rawLimit < 1 ||
        rawLimit > maxScanLimit
      ) {
        throw new Error(`limit must be an integer from 1–${maxScanLimit}.`);
      }
      if (!process.env.OPENAI_API_KEY?.trim()) {
        throw new Error("OPENAI_API_KEY is not configured.");
      }
      const job: ScanJob = {
        id: randomUUID(),
        status: "queued",
        total: 0,
        completed: 0,
        scanned: 0,
        skipped: 0,
        failed: 0,
        current: null,
        errors: [],
        startedAt: new Date().toISOString(),
        finishedAt: null,
        trigger: "manual",
      };
      scanJobs.set(job.id, job);
      void runScanJob(job, range, rawLimit, body.force === true);
      json(res, 202, { job });
    } catch (error) {
      json(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (req.method !== "GET") {
    json(res, 405, { error: "Method not allowed" });
    return;
  }

  if (url.pathname === "/api/creatives") {
    try {
      const range = resolveRange(url);
      json(
        res,
        200,
        await buildPayload(range, url.searchParams.get("refresh") === "1"),
      );
    } catch (error) {
      json(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (url.pathname === "/api/analysis") {
    try {
      json(res, 200, await buildAnalysisPayload(resolveRange(url)));
    } catch (error) {
      json(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (url.pathname === "/api/analysis/status") {
    const jobId = url.searchParams.get("jobId") ?? "";
    const job = scanJobs.get(jobId);
    if (!job) {
      json(res, 404, { error: "Scan job not found." });
    } else {
      json(res, 200, { job });
    }
    return;
  }

  if (url.pathname === "/api/video-metrics") {
    try {
      const range = resolveRange(url);
      json(
        res,
        200,
        await buildVideoMetricsPayload(
          range,
          url.searchParams.get("refresh") === "1",
        ),
      );
    } catch (error) {
      json(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (url.pathname === "/api/competitors") {
    try {
      json(
        res,
        200,
        await competitorFeed(url.searchParams.get("refresh") === "1"),
      );
    } catch (error) {
      json(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (url.pathname === "/api/creative-detail") {
    try {
      const range = resolveRange(url);
      const creativeId = url.searchParams.get("creativeId") ?? "";
      if (!creativeId) throw new Error("creativeId is required.");
      const cacheKey = `${range.since}:${range.until}:${creativeId}`;
      const cached = detailCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        json(res, 200, cached.value);
        return;
      }
      const dashboard = await buildPayload(range);
      const index = dashboard.creatives.findIndex(
        (creative) => creative.creativeId === creativeId,
      );
      if (index < 0) throw new Error("Creative not found.");
      const creative = dashboard.creatives[index]!;
      const value = {
        creative,
        rank: index + 1,
        trend: await fetchMetaDailyTrend(range, creative.adIds),
      };
      detailCache.set(cacheKey, {
        expiresAt: Date.now() + 10 * 60_000,
        value,
      });
      json(res, 200, value);
    } catch (error) {
      json(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (url.pathname === "/api/slices") {
    try {
      const range = resolveRange(url);
      const rawDimension = url.searchParams.get("dimension");
      if (
        rawDimension !== "demographic" &&
        rawDimension !== "publisher" &&
        rawDimension !== "device" &&
        rawDimension !== "os"
      ) {
        throw new Error(
          "dimension must be demographic, publisher, device, or os.",
        );
      }
      json(
        res,
        200,
        await buildSlicePayload(
          range,
          rawDimension,
          url.searchParams.get("refresh") === "1",
        ),
      );
    } catch (error) {
      json(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (url.pathname === "/api/preview") {
    try {
      const adId = url.searchParams.get("adId") ?? "";
      const format = url.searchParams.get("format") ?? "MOBILE_FEED_STANDARD";
      const cacheKey = `${adId}:${format}`;
      const cached = previewCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        json(res, 200, { adId, format, src: cached.src });
        return;
      }
      const preview = await fetchMetaAdPreview(adId, format);
      previewCache.set(cacheKey, {
        expiresAt: Date.now() + 30 * 60_000,
        src: preview.src,
      });
      json(res, 200, preview);
    } catch (error) {
      json(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  const asset = staticFiles[url.pathname];
  if (!asset) {
    text(res, 404, "Not found", "text/plain; charset=utf-8");
    return;
  }
  try {
    text(res, 200, await readFile(join(here, asset.file), "utf8"), asset.type);
  } catch {
    text(res, 500, "Dashboard asset unavailable", "text/plain; charset=utf-8");
  }
}

const scanScheduleStatePath = join(
  dataDirectory,
  "creative-analysis-schedule.json",
);

async function writeScheduleState(job: ScanJob): Promise<void> {
  await mkdir(dirname(scanScheduleStatePath), { recursive: true });
  await writeFile(
    scanScheduleStatePath,
    `${JSON.stringify(
      {
        lastTriggeredAt: job.startedAt,
        jobId: job.id,
        status: job.status,
        finishedAt: job.finishedAt,
        scanned: job.scanned,
        skipped: job.skipped,
        failed: job.failed,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}

async function runScheduledScan(): Promise<void> {
  const job: ScanJob = {
    id: randomUUID(),
    status: "queued",
    total: 0,
    completed: 0,
    scanned: 0,
    skipped: 0,
    failed: 0,
    current: null,
    errors: [],
    startedAt: new Date().toISOString(),
    finishedAt: null,
    trigger: "scheduled",
  };
  scanJobs.set(job.id, job);
  await writeScheduleState(job);
  await runScanJob(
    job,
    defaultDateRange(scanConfig.days),
    scanConfig.dailyLimit,
    scanConfig.force,
    scanConfig.concurrency,
  );
  await writeScheduleState(job);
}

function scheduleNextAutoScan(): void {
  if (!scanConfig.enabled || !process.env.OPENAI_API_KEY?.trim()) {
    nextScheduledScanAt = null;
    return;
  }
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(scanConfig.hourUtc, 0, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  nextScheduledScanAt = next.toISOString();
  const delay = next.getTime() - now.getTime();
  setTimeout(() => {
    void runScheduledScan().finally(scheduleNextAutoScan);
  }, delay);
}

const server = createServer((req, res) => {
  void handler(req, res).catch((error) => {
    json(res, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  });
});

await mkdir(dataDirectory, { recursive: true });

server.listen(port, host, () => {
  scheduleNextAutoScan();
  const displayHost = host === "0.0.0.0" ? "localhost" : host;
  process.stdout.write(
    `Creative Intelligence dashboard: http://${displayHost}:${port}\n` +
      (nextScheduledScanAt
        ? `Next creative scan: ${nextScheduledScanAt} (limit ${scanConfig.dailyLimit})\n`
        : ""),
  );
});
