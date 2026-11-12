import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
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
import { normalizeCreativeName } from "../bot/lib/names.js";
import {
  analyzeCreative,
  creativeFingerprint,
  CreativeAnalysisStore,
  type CreativeAnalysis,
} from "./analysis.js";
import { fetchAdManageAssets } from "./admanage-assets.js";
import { fetchAdjacentCompetitorCreatives } from "./competitors.js";
import {
  buildDebriefPayload,
  refreshDebriefPayload,
  resolveDebriefRange,
} from "./debrief.js";
import { WorkspaceStore } from "./workspace.js";

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
const workspaceStore = new WorkspaceStore(
  join(dataDirectory, "creative-workspace.json"),
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

type DashboardDataHealth = {
  status: "healthy" | "degraded" | "loading";
  sources: {
    adjust: "live" | "fixture";
    meta: "live" | "error" | "pending";
    adManage: "live" | "unconfigured" | "error" | "pending";
  };
  coverage: {
    creatives: number;
    ads: number;
    matchedAds: number;
    unmatchedAds: number;
    creativesWithPreview: number;
    previewSpendPct: number;
    matureD1Creatives: number;
    matureD3Creatives: number;
    matureD7Creatives: number;
  };
};

type PayloadFreshness = {
  source: "live" | "memory" | "disk";
  refreshing: boolean;
  expiresAt: string;
};

type DashboardPayload = {
  source: string;
  range: { since: string; until: string };
  generatedAt: string;
  freshness?: PayloadFreshness;
  method: string;
  retention: {
    method: string;
    cutoffs: { d1: string; d3: string; d7: string };
  };
  adjustApp: string | null;
  totals: ReturnType<typeof summarizeBoard>;
  creatives: ApiCreative[];
  dataHealth: DashboardDataHealth;
  warnings: string[];
};

type MediaPayload = {
  generatedAt: string;
  range: { since: string; until: string };
  freshness?: PayloadFreshness;
  creatives: Record<string, MetaAdMedia[]>;
  dataHealth: DashboardDataHealth;
  warnings: string[];
};

type CacheEntry = { expiresAt: number; value: DashboardPayload };
const DASHBOARD_CACHE_TTL_MS = 5 * 60_000;
const MEDIA_CACHE_TTL_MS = 10 * 60_000;
const SNAPSHOTS_PER_KIND = 24;
const dashboardSnapshotDirectory = join(dataDirectory, "dashboard-cache");
const dataCache = new Map<string, CacheEntry>();
const dataInflight = new Map<string, Promise<DashboardPayload>>();
const mediaCache = new Map<
  string,
  { expiresAt: number; value: MediaPayload }
>();
const mediaInflight = new Map<string, Promise<MediaPayload>>();
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

type PayloadSnapshot<T> = {
  version: 1;
  kind: "metrics" | "media";
  savedAt: string;
  range: { since: string; until: string };
  value: T;
};

function payloadSnapshotPath(
  kind: "metrics" | "media",
  range: { since: string; until: string },
): string {
  return join(
    dashboardSnapshotDirectory,
    `${kind}_${range.since}_${range.until}.json`,
  );
}

async function readPayloadSnapshot<T extends { generatedAt: string }>(
  kind: "metrics" | "media",
  range: { since: string; until: string },
): Promise<{ savedAt: number; value: T } | null> {
  try {
    const parsed = JSON.parse(
      await readFile(payloadSnapshotPath(kind, range), "utf8"),
    ) as PayloadSnapshot<T>;
    const savedAt = Date.parse(parsed.savedAt);
    if (
      parsed.version !== 1 ||
      parsed.kind !== kind ||
      parsed.range.since !== range.since ||
      parsed.range.until !== range.until ||
      !Number.isFinite(savedAt) ||
      !parsed.value?.generatedAt
    ) {
      return null;
    }
    return { savedAt, value: parsed.value };
  } catch {
    return null;
  }
}

async function writePayloadSnapshot<T>(
  kind: "metrics" | "media",
  range: { since: string; until: string },
  value: T,
): Promise<void> {
  await mkdir(dashboardSnapshotDirectory, { recursive: true });
  const path = payloadSnapshotPath(kind, range);
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const snapshot: PayloadSnapshot<T> = {
    version: 1,
    kind,
    savedAt: new Date().toISOString(),
    range,
    value,
  };
  await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
  const older = (await readdir(dashboardSnapshotDirectory))
    .filter((name) => name.startsWith(`${kind}_`) && name.endsWith(".json"))
    .sort()
    .reverse()
    .slice(SNAPSHOTS_PER_KIND);
  await Promise.all(
    older.map((name) =>
      unlink(join(dashboardSnapshotDirectory, name)).catch(() => undefined),
    ),
  );
}

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

async function refreshPayload(range: {
  since: string;
  until: string;
}): Promise<DashboardPayload> {
  const key = `${range.since}:${range.until}`;
  const pending = dataInflight.get(key);
  if (pending) return pending;

  const promise = (async () => {
    const adjust = await fetchAdjustCreativePerformance(range, {
      partner: "meta",
    });
    const board = buildHelperCompatibleDashboard(adjust.rows, maxScanLimit);
    const creatives: ApiCreative[] = board.map((row) => ({
      ...row,
      media: [],
    }));
    const withSpend = creatives.filter((row) => row.metaSpend > 0);
    const adIds = [...new Set(board.flatMap((row) => row.adIds))];
    const dataHealth: DashboardDataHealth = {
      status: "loading",
      sources: {
        adjust: adjust.source,
        meta: "pending",
        adManage: process.env.ADMANAGE_API_KEY?.trim()
          ? "pending"
          : "unconfigured",
      },
      coverage: {
        creatives: withSpend.length,
        ads: adIds.length,
        matchedAds: 0,
        unmatchedAds: adIds.length,
        creativesWithPreview: 0,
        previewSpendPct: 0,
        matureD1Creatives: withSpend.filter(
          (row) => row.adjustRetentionDenD1 > 0,
        ).length,
        matureD3Creatives: withSpend.filter(
          (row) => row.adjustRetentionDenD3 > 0,
        ).length,
        matureD7Creatives: withSpend.filter(
          (row) => row.adjustRetentionDenD7 > 0,
        ).length,
      },
    };
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
      dataHealth,
      warnings: [],
    };
    dataCache.set(key, {
      expiresAt: Date.now() + DASHBOARD_CACHE_TTL_MS,
      value,
    });
    try {
      await writePayloadSnapshot("metrics", range, value);
    } catch (error) {
      process.stderr.write(
        `Dashboard metrics snapshot failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    return value;
  })().finally(() => dataInflight.delete(key));
  dataInflight.set(key, promise);
  return promise;
}

function withPayloadFreshness<T extends { freshness?: PayloadFreshness }>(
  value: T,
  source: PayloadFreshness["source"],
  refreshing: boolean,
  expiresAt: number,
): T {
  return {
    ...value,
    freshness: {
      source,
      refreshing,
      expiresAt: new Date(expiresAt).toISOString(),
    },
  };
}

async function buildPayload(
  range: { since: string; until: string },
  force = false,
): Promise<DashboardPayload> {
  if (force) {
    const value = await refreshPayload(range);
    return withPayloadFreshness(
      value,
      "live",
      false,
      dataCache.get(`${range.since}:${range.until}`)?.expiresAt ??
        Date.now() + DASHBOARD_CACHE_TTL_MS,
    );
  }
  const key = `${range.since}:${range.until}`;
  let source: PayloadFreshness["source"] = "memory";
  let cached = dataCache.get(key);
  if (!cached) {
    const snapshot = await readPayloadSnapshot<DashboardPayload>(
      "metrics",
      range,
    );
    if (snapshot) {
      source = "disk";
      cached = {
        expiresAt: snapshot.savedAt + DASHBOARD_CACHE_TTL_MS,
        value: snapshot.value,
      };
      dataCache.set(key, cached);
    }
  }
  if (cached) {
    const stale = cached.expiresAt <= Date.now();
    if (stale) {
      void refreshPayload(range).catch((error: unknown) => {
        process.stderr.write(
          `Dashboard metrics refresh failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      });
    }
    return withPayloadFreshness(
      cached.value,
      source,
      stale || dataInflight.has(key),
      cached.expiresAt,
    );
  }
  const value = await refreshPayload(range);
  return withPayloadFreshness(
    value,
    "live",
    false,
    dataCache.get(key)?.expiresAt ?? Date.now() + DASHBOARD_CACHE_TTL_MS,
  );
}

async function refreshMediaPayload(
  range: { since: string; until: string },
): Promise<MediaPayload> {
  const key = `${range.since}:${range.until}`;
  const pending = mediaInflight.get(key);
  if (pending) return pending;

  const promise = (async () => {
    const dashboard = await buildPayload(range);
    const adIds = [
      ...new Set(dashboard.creatives.flatMap((creative) => creative.adIds)),
    ];
    const adManageConfigured = Boolean(
      process.env.ADMANAGE_API_KEY?.trim(),
    );
    const [metaResult, assetResult] = await Promise.allSettled([
      fetchMetaAdMedia(adIds),
      adManageConfigured
        ? fetchAdManageAssets(range)
        : Promise.resolve({}),
    ]);
    const warnings: string[] = [];
    const metaFailed = metaResult.status === "rejected";
    const adManageFailed =
      adManageConfigured && assetResult.status === "rejected";
    const mediaByAd =
      metaResult.status === "fulfilled" ? metaResult.value : {};

    if (metaResult.status === "rejected") {
      warnings.push(
        `Media previews unavailable: ${metaResult.reason instanceof Error ? metaResult.reason.message : String(metaResult.reason)}`,
      );
    }
    if (assetResult.status === "fulfilled") {
      const assets = assetResult.value as Awaited<
        ReturnType<typeof fetchAdManageAssets>
      >;
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
    } else {
      warnings.push(
        `High-resolution asset fallback unavailable: ${assetResult.reason instanceof Error ? assetResult.reason.message : String(assetResult.reason)}`,
      );
    }

    const creatives = Object.fromEntries(
      dashboard.creatives.map((creative) => [
        creative.creativeId,
        creative.adIds
          .map((adId) => mediaByAd[adId])
          .filter((media): media is MetaAdMedia => media !== undefined),
      ]),
    );
    const withSpend = dashboard.creatives.filter(
      (creative) => creative.metaSpend > 0,
    );
    const previewCreatives = withSpend.filter(
      (creative) => creatives[creative.creativeId]?.length,
    );
    const totalSpend = withSpend.reduce(
      (sum, creative) => sum + creative.metaSpend,
      0,
    );
    const previewSpend = previewCreatives.reduce(
      (sum, creative) => sum + creative.metaSpend,
      0,
    );
    const matchedAds = adIds.filter((adId) => mediaByAd[adId]).length;
    const round2 = (number: number) => Math.round(number * 100) / 100;
    const value: MediaPayload = {
      generatedAt: new Date().toISOString(),
      range,
      creatives,
      dataHealth: {
        ...dashboard.dataHealth,
        status:
          dashboard.source === "live" && !metaFailed && !adManageFailed
            ? "healthy"
            : "degraded",
        sources: {
          adjust: dashboard.dataHealth.sources.adjust,
          meta: metaFailed ? "error" : "live",
          adManage: !adManageConfigured
            ? "unconfigured"
            : adManageFailed
              ? "error"
              : "live",
        },
        coverage: {
          ...dashboard.dataHealth.coverage,
          matchedAds,
          unmatchedAds: adIds.length - matchedAds,
          creativesWithPreview: previewCreatives.length,
          previewSpendPct:
            totalSpend > 0 ? round2((previewSpend / totalSpend) * 100) : 0,
        },
      },
      warnings,
    };
    mediaCache.set(key, {
      expiresAt: Date.now() + MEDIA_CACHE_TTL_MS,
      value,
    });
    try {
      await writePayloadSnapshot("media", range, value);
    } catch (error) {
      process.stderr.write(
        `Dashboard media snapshot failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    return value;
  })().finally(() => mediaInflight.delete(key));
  mediaInflight.set(key, promise);
  return promise;
}

async function buildMediaPayload(
  range: { since: string; until: string },
  force = false,
): Promise<MediaPayload> {
  if (force) {
    const value = await refreshMediaPayload(range);
    return withPayloadFreshness(
      value,
      "live",
      false,
      mediaCache.get(`${range.since}:${range.until}`)?.expiresAt ??
        Date.now() + MEDIA_CACHE_TTL_MS,
    );
  }
  const key = `${range.since}:${range.until}`;
  let source: PayloadFreshness["source"] = "memory";
  let cached = mediaCache.get(key);
  if (!cached) {
    const snapshot = await readPayloadSnapshot<MediaPayload>("media", range);
    if (snapshot) {
      source = "disk";
      cached = {
        expiresAt: snapshot.savedAt + MEDIA_CACHE_TTL_MS,
        value: snapshot.value,
      };
      mediaCache.set(key, cached);
    }
  }
  if (cached) {
    const stale = cached.expiresAt <= Date.now();
    if (stale) {
      void refreshMediaPayload(range).catch((error: unknown) => {
        process.stderr.write(
          `Dashboard media refresh failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      });
    }
    return withPayloadFreshness(
      cached.value,
      source,
      stale || mediaInflight.has(key),
      cached.expiresAt,
    );
  }
  const value = await refreshMediaPayload(range);
  return withPayloadFreshness(
    value,
    "live",
    false,
    mediaCache.get(key)?.expiresAt ?? Date.now() + MEDIA_CACHE_TTL_MS,
  );
}

async function buildEnrichedPayload(
  range: { since: string; until: string },
  force = false,
): Promise<DashboardPayload> {
  const [dashboard, media] = await Promise.all([
    buildPayload(range, force),
    buildMediaPayload(range, force),
  ]);
  return {
    ...dashboard,
    creatives: dashboard.creatives.map((creative) => ({
      ...creative,
      media: media.creatives[creative.creativeId] ?? [],
    })),
    dataHealth: media.dataHealth,
    warnings: [...dashboard.warnings, ...media.warnings],
  };
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
  const dashboard = await buildEnrichedPayload(range);
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
    const dashboard = await buildEnrichedPayload(range);
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
  const rows = await fetchMetaDeliveryBreakdown(
    range,
    dimension,
    [...creativeByAd.keys()],
  );
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

async function buildDebriefVisualLearnings(
  debrief: Awaited<ReturnType<typeof buildDebriefPayload>>,
): Promise<{
  coverage: { scanned: number; total: number };
  winningPatterns: Array<{
    dimension: string;
    value: string;
    creatives: number;
    testingSpend: number;
  }>;
  losingPatterns: Array<{
    dimension: string;
    value: string;
    creatives: number;
    testingSpend: number;
  }>;
  strengths: string[];
  risks: string[];
}> {
  const analyses = new Map(
    (await analysisStore.list()).map((analysis) => [
      analysis.creativeId,
      analysis,
    ]),
  );
  type Bucket = {
    dimension: string;
    value: string;
    winnerCount: number;
    loserCount: number;
    winnerSpend: number;
    loserSpend: number;
  };
  const buckets = new Map<string, Bucket>();
  const strengths: string[] = [];
  const risks: string[] = [];
  let scanned = 0;
  for (const creative of debrief.all) {
    const analysis = analyses.get(normalizeCreativeName(creative.name));
    if (analysis) {
      scanned += 1;
      if (creative.verdict === "Winner" && analysis.strengths[0]) {
        strengths.push(analysis.strengths[0]);
      }
      if (creative.verdict === "Loser" && analysis.risks[0]) {
        risks.push(analysis.risks[0]);
      }
    }
    if (creative.verdict !== "Winner" && creative.verdict !== "Loser") {
      continue;
    }
    const dimensions: Array<[string, string | null | undefined]> = [
      ["Source", creative.source],
      ["Format", creative.format],
      ["OS", creative.os],
      ["Category", creative.category],
      ["Creator", creative.creator],
    ];
    if (analysis) {
      dimensions.push(
        ["Theme", analysis.taxonomy.theme],
        ["Angle", analysis.taxonomy.angle],
        ["Visual format", analysis.taxonomy.format],
        ["Hook", analysis.taxonomy.hookType],
        ["Presenter", analysis.taxonomy.presenter],
        ["Color harmony", analysis.colorTheory.harmony],
        ["Palette", analysis.colorTheory.paletteTemperature],
      );
    }
    for (const [dimension, value] of dimensions) {
      if (!value) continue;
      const key = `${dimension}:${value}`;
      const bucket = buckets.get(key) ?? {
        dimension,
        value,
        winnerCount: 0,
        loserCount: 0,
        winnerSpend: 0,
        loserSpend: 0,
      };
      if (creative.verdict === "Winner") {
        bucket.winnerCount += 1;
        bucket.winnerSpend += creative.testing.spend;
      } else {
        bucket.loserCount += 1;
        bucket.loserSpend += creative.testing.spend;
      }
      buckets.set(key, bucket);
    }
  }
  const unique = (values: string[]) => [...new Set(values)].slice(0, 6);
  const winningPatterns = [...buckets.values()]
    .filter((bucket) => bucket.winnerCount > bucket.loserCount)
    .sort(
      (a, b) =>
        b.winnerCount - b.loserCount - (a.winnerCount - a.loserCount) ||
        b.winnerSpend - a.winnerSpend,
    )
    .slice(0, 8)
    .map((bucket) => ({
      dimension: bucket.dimension,
      value: bucket.value,
      creatives: bucket.winnerCount,
      testingSpend: Math.round(bucket.winnerSpend * 100) / 100,
    }));
  const losingPatterns = [...buckets.values()]
    .filter((bucket) => bucket.loserCount > bucket.winnerCount)
    .sort(
      (a, b) =>
        b.loserCount - b.winnerCount - (a.loserCount - a.winnerCount) ||
        b.loserSpend - a.loserSpend,
    )
    .slice(0, 8)
    .map((bucket) => ({
      dimension: bucket.dimension,
      value: bucket.value,
      creatives: bucket.loserCount,
      testingSpend: Math.round(bucket.loserSpend * 100) / 100,
    }));
  return {
    coverage: { scanned, total: debrief.all.length },
    winningPatterns,
    losingPatterns,
    strengths: unique(strengths),
    risks: unique(risks),
  };
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

  if (url.pathname === "/api/experiments") {
    try {
      if (req.method === "GET") {
        json(res, 200, { experiments: await workspaceStore.listExperiments() });
        return;
      }
      const body = await readJsonBody(req);
      if (req.method === "DELETE") {
        const id = url.searchParams.get("id") ?? "";
        json(res, (await workspaceStore.deleteExperiment(id)) ? 200 : 404, {
          deleted: id,
        });
        return;
      }
      if (req.method !== "POST") {
        json(res, 405, { error: "Method not allowed" });
        return;
      }
      const required = (key: string): string => {
        const value = String(body[key] ?? "").trim();
        if (!value) throw new Error(`${key} is required.`);
        return value.slice(0, 2_000);
      };
      const status = String(body.status ?? "Planned");
      if (!["Planned", "Running", "Decided"].includes(status)) {
        throw new Error("status must be Planned, Running, or Decided.");
      }
      json(res, 200, {
        experiment: await workspaceStore.upsertExperiment({
          id: body.id ? String(body.id) : undefined,
          name: required("name"),
          hypothesis: required("hypothesis"),
          control: String(body.control ?? "").trim().slice(0, 2_000),
          variants: String(body.variants ?? "").trim().slice(0, 2_000),
          owner: String(body.owner ?? "").trim().slice(0, 200),
          primaryMetric: required("primaryMetric"),
          guardrails: String(body.guardrails ?? "").trim().slice(0, 2_000),
          creativeIds: Array.isArray(body.creativeIds)
            ? [
                ...new Set(
                  body.creativeIds
                    .map((value) => String(value).trim().slice(0, 300))
                    .filter(Boolean),
                ),
              ].slice(0, 100)
            : [],
          testBriefId:
            String(body.testBriefId ?? "").trim().slice(0, 200) || null,
          status: status as "Planned" | "Running" | "Decided",
          notes: String(body.notes ?? "").trim().slice(0, 5_000),
        }),
      });
    } catch (error) {
      json(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (url.pathname === "/api/saved-reports") {
    try {
      if (req.method === "GET") {
        json(res, 200, { reports: await workspaceStore.listSavedReports() });
        return;
      }
      const body = await readJsonBody(req);
      if (req.method === "DELETE") {
        const id = url.searchParams.get("id") ?? "";
        json(res, (await workspaceStore.deleteSavedReport(id)) ? 200 : 404, {
          deleted: id,
        });
        return;
      }
      if (req.method !== "POST") {
        json(res, 405, { error: "Method not allowed" });
        return;
      }
      const name = String(body.name ?? "").trim();
      const reportUrl = String(body.url ?? "").trim();
      if (!name || !reportUrl.startsWith("/")) {
        throw new Error("name and a same-origin report URL are required.");
      }
      json(res, 200, {
        report: await workspaceStore.saveReport(
          name.slice(0, 200),
          reportUrl.slice(0, 2_000),
        ),
      });
    } catch (error) {
      json(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (url.pathname === "/api/test-briefs") {
    try {
      if (req.method === "GET") {
        json(res, 200, { briefs: await workspaceStore.listTestBriefs() });
        return;
      }
      if (req.method !== "POST") {
        json(res, 405, { error: "Method not allowed" });
        return;
      }
      const body = await readJsonBody(req);
      const title = String(body.title ?? "").trim();
      if (!title) throw new Error("title is required.");
      const status = String(body.status ?? "Draft");
      if (!["Draft", "Ready", "Launched"].includes(status)) {
        throw new Error("status must be Draft, Ready, or Launched.");
      }
      json(res, 200, {
        brief: await workspaceStore.upsertTestBrief({
          id: body.id ? String(body.id) : undefined,
          title: title.slice(0, 300),
          sourceBrand: String(body.sourceBrand ?? "").trim().slice(0, 200),
          sourceCreative: String(body.sourceCreative ?? "")
            .trim()
            .slice(0, 2_000),
          hypothesis: String(body.hypothesis ?? "").trim().slice(0, 2_000),
          valueProposition: String(body.valueProposition ?? "")
            .trim()
            .slice(0, 2_000),
          audience: String(body.audience ?? "").trim().slice(0, 1_000),
          variants: String(body.variants ?? "").trim().slice(0, 3_000),
          status: status as "Draft" | "Ready" | "Launched",
        }),
      });
    } catch (error) {
      json(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
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

  if (url.pathname === "/api/features/v1/creatives") {
    try {
      const range = resolveDebriefRange(
        url.searchParams.get("since"),
        url.searchParams.get("until"),
      );
      const debrief = await buildDebriefPayload(range);
      json(res, 200, {
        schemaVersion: 1,
        generatedAt: debrief.generatedAt,
        range: debrief.range,
        lineage: {
          delivery: "Adjust Report Service; Meta-partner creatives",
          retention:
            "retained_users_dN / installs from mature UTC calendar cohorts",
          identity:
            "cleaned Adjust creative label joined to Meta ad inventory",
        },
        features: debrief.all.map((creative) => ({
          creativeId: creative.creativeId,
          creativeName: creative.name,
          source: creative.source,
          format: creative.format,
          os: creative.os,
          category: creative.category,
          creator: creative.creator,
          hook: creative.hook,
          uploadedDate: creative.uploadedDate,
          status: creative.status,
          promoted: creative.promoted,
          verdict: creative.verdict,
          recommendedAction: creative.recommendedAction,
          retentionConfidence: creative.retentionConfidence,
          testing: creative.testing,
          scaled: creative.scaled,
        })),
      });
    } catch (error) {
      json(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
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

  if (url.pathname === "/api/creative-media") {
    try {
      const range = resolveRange(url);
      json(
        res,
        200,
        await buildMediaPayload(
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

  if (url.pathname === "/api/debrief") {
    try {
      const range = resolveDebriefRange(
        url.searchParams.get("since"),
        url.searchParams.get("until"),
      );
      const debrief = await buildDebriefPayload(
        range,
        url.searchParams.get("refresh") === "1",
      );
      json(res, 200, debrief);
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
      const dashboard = await buildEnrichedPayload(range);
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

function scheduleDebriefRefresh(): void {
  if (
    !process.env.ADJUST_API_TOKEN?.trim() ||
    !process.env.META_ACCESS_TOKEN?.trim() ||
    !process.env.META_AD_ACCOUNT_ID?.trim()
  ) {
    return;
  }
  const refresh = () => {
    void refreshDebriefPayload(resolveDebriefRange(null, null)).catch(
      (error: unknown) => {
        process.stderr.write(
          `Scheduled debrief refresh failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      },
    );
  };
  setTimeout(() => {
    void buildDebriefPayload(resolveDebriefRange(null, null)).catch(
      (error: unknown) => {
        process.stderr.write(
          `Initial debrief warm-up failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      },
    );
  }, 90_000);
  setInterval(refresh, 30 * 60_000);
}

let dashboardPrewarmRunning = false;

async function prewarmDashboardWindows(): Promise<void> {
  if (
    dashboardPrewarmRunning ||
    !process.env.ADJUST_API_TOKEN?.trim()
  ) {
    return;
  }
  dashboardPrewarmRunning = true;
  try {
    for (const days of [7, 28, 90]) {
      const range = defaultDateRange(days);
      try {
        await refreshPayload(range);
        if (days <= 28 && process.env.META_ACCESS_TOKEN?.trim()) {
          await refreshMediaPayload(range);
        }
      } catch (error) {
        process.stderr.write(
          `Dashboard ${days}-day prewarm failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
  } finally {
    dashboardPrewarmRunning = false;
  }
}

function scheduleDashboardPrewarm(): void {
  if (!process.env.ADJUST_API_TOKEN?.trim()) return;
  setTimeout(() => void prewarmDashboardWindows(), 3 * 60_000);
  const scheduleDaily = () => {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(0, 15, 0, 0);
    if (next.getTime() <= now.getTime()) {
      next.setUTCDate(next.getUTCDate() + 1);
    }
    setTimeout(() => {
      void prewarmDashboardWindows().finally(scheduleDaily);
    }, next.getTime() - now.getTime());
  };
  scheduleDaily();
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
  scheduleDebriefRefresh();
  scheduleDashboardPrewarm();
  const displayHost = host === "0.0.0.0" ? "localhost" : host;
  process.stdout.write(
    `Creative Intelligence dashboard: http://${displayHost}:${port}\n` +
      (nextScheduledScanAt
        ? `Next creative scan: ${nextScheduledScanAt} (limit ${scanConfig.dailyLimit})\n`
        : ""),
  );
});
