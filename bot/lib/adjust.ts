import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { FIXTURE_ADJUST_ROWS } from "./fixtures.js";
import { normalizeCreativeName } from "./names.js";
import {
  activeAdjustAppName,
  activeAdjustAppToken,
} from "./data-profile.js";
import type { AdjustCreativeRow, DataSource, DateRange } from "./types.js";

export type AdjustApp = {
  token: string;
  name: string;
};

const ADJUST_APPS_CACHE_TTL_MS = 60 * 60_000;
let adjustAppsCache:
  | { apiToken: string; expiresAt: number; apps: AdjustApp[] }
  | undefined;

export type AdjustPerformanceResult = {
  source: DataSource;
  appToken: string | null;
  appName: string | null;
  appsAvailable: AdjustApp[];
  partnerFilter: string;
  grouping: "adjust-creative-cleaned";
  retentionCutoffs: { d1: string; d3: string; d7: string };
  range: DateRange;
  missingEnv: string[];
  rows: AdjustCreativeRow[];
};

function missingAdjustEnv(): string[] {
  const missing: string[] = [];
  if (!process.env.ADJUST_API_TOKEN?.trim()) missing.push("ADJUST_API_TOKEN");
  return missing;
}

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Adjust retention rates arrive as 0–1 fractions; expose as 0–100 percentages. */
function retentionPct(value: unknown): number {
  const n = num(value);
  if (n <= 0) return 0;
  const pct = n <= 1 ? n * 100 : n;
  return Math.round(pct * 100) / 100;
}

export type AdjustReportRow = {
  day?: string;
  creative_id?: string;
  creative_name?: string;
  creative?: string;
  creative_id_network?: string;
  creative_network?: string;
  campaign_network?: string;
  adgroup_network?: string;
  partner_name?: string;
  network?: string;
  network_cost?: number | string;
  impressions?: number | string;
  clicks?: number | string;
  installs?: number | string;
  post_install_account_created_events?: number | string;
  revenue?: number | string;
  cost?: number | string;
  roas?: number | string;
  retention_rate_d1?: number | string;
  retention_rate_d3?: number | string;
  retention_rate_d7?: number | string;
  retained_users_d1?: number | string;
  retained_users_d3?: number | string;
  retained_users_d7?: number | string;
};

type FilterItem = {
  id?: string;
  name?: string;
  app_token?: string;
  token?: string;
  label?: string;
};

function asApps(payload: unknown): AdjustApp[] {
  const root = payload as {
    apps?: FilterItem[];
    data?: FilterItem[] | { apps?: FilterItem[] };
    filters?: { apps?: FilterItem[] };
  };

  const raw: FilterItem[] =
    root.apps ??
    root.filters?.apps ??
    (Array.isArray(root.data) ? root.data : root.data?.apps) ??
    [];

  const apps: AdjustApp[] = [];
  for (const item of raw) {
    const token = (item.id ?? item.app_token ?? item.token ?? "").trim();
    if (!token) continue;
    apps.push({
      token,
      name: (item.name ?? item.label ?? token).trim(),
    });
  }
  return apps;
}

/** List apps visible to this API token via Report Service filters_data. */
export async function listAdjustApps(apiToken: string): Promise<AdjustApp[]> {
  if (
    adjustAppsCache?.apiToken === apiToken &&
    adjustAppsCache.expiresAt > Date.now()
  ) {
    return adjustAppsCache.apps;
  }
  const url = new URL("https://automate.adjust.com/reports-service/filters_data");
  url.searchParams.set("required_filters", "apps");

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiToken}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Adjust filters_data ${response.status}: ${body.slice(0, 400)}`);
  }

  const apps = asApps(await response.json());
  adjustAppsCache = {
    apiToken,
    expiresAt: Date.now() + ADJUST_APPS_CACHE_TTL_MS,
    apps,
  };
  return apps;
}

function resolveApp(
  apps: AdjustApp[],
  opts: { appToken?: string; appName?: string },
): AdjustApp {
  const envToken = activeAdjustAppToken();
  const envName = activeAdjustAppName();
  const wantToken = opts.appToken?.trim() || envToken;
  const wantName = opts.appName?.trim() || envName;

  if (wantToken) {
    const hit = apps.find((app) => app.token === wantToken);
    if (hit) return hit;
    return { token: wantToken, name: wantName || wantToken };
  }

  if (wantName) {
    const lower = wantName.toLowerCase();
    const exact = apps.find((app) => app.name.toLowerCase() === lower);
    if (exact) return exact;
    const partial = apps.filter((app) =>
      app.name.toLowerCase().includes(lower),
    );
    if (partial.length === 1) return partial[0]!;
    if (partial.length > 1) {
      throw new Error(
        `Multiple Adjust apps matched "${wantName}". Use an exact ADJUST_APP_NAME or ADJUST_APP_TOKEN: ${partial.map((app) => app.name).join(", ")}`,
      );
    }
    if (partial.length === 0) {
      const names = apps.map((app) => app.name).join(", ") || "(none)";
      throw new Error(
        `No Adjust app matched "${wantName}". Available: ${names}`,
      );
    }
  }

  if (apps.length === 0) {
    throw new Error(
      "Adjust API token works but filters_data returned no apps. Set ADJUST_APP_TOKEN or ADJUST_APP_NAME.",
    );
  }

  return apps[0]!;
}

/** Resolve the Adjust app (ADJUST_APP_TOKEN / ADJUST_APP_NAME) for report reads. */
export async function resolveAdjustApp(
  opts: { appToken?: string; appName?: string } = {},
): Promise<{ apiToken: string; app: AdjustApp }> {
  const apiToken = process.env.ADJUST_API_TOKEN?.trim();
  if (!apiToken) throw new Error("ADJUST_API_TOKEN is not configured.");
  return { apiToken, app: resolveApp(await listAdjustApps(apiToken), opts) };
}

/** One Report Service read for a resolved app; rows are returned unfiltered. */
export async function fetchAdjustReportRows(
  apiToken: string,
  appToken: string,
  range: DateRange,
  dimensions: string[],
  metrics: string[],
  label = "Adjust Report API",
): Promise<AdjustReportRow[]> {
  const url = new URL("https://automate.adjust.com/reports-service/report");
  url.searchParams.set("app_token__in", appToken);
  url.searchParams.set("date_period", `${range.since}:${range.until}`);
  url.searchParams.set("dimensions", dimensions.join(","));
  url.searchParams.set("metrics", metrics.join(","));
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiToken}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${label} ${response.status}: ${body.slice(0, 400)}`);
  }
  const payload = (await response.json()) as {
    rows?: AdjustReportRow[];
    data?: AdjustReportRow[];
  };
  return payload.rows ?? payload.data ?? [];
}

type DailyReportCache = {
  version: 1;
  days: Record<
    string,
    { savedAt: string; rows: AdjustReportRow[] }
  >;
};

const adjustDailyDirectory = resolve(
  process.env.DASHBOARD_DATA_DIR?.trim() || ".agent-serve",
  "adjust-daily",
);
const dailyReportMemory = new Map<
  string,
  { path: string; value: DailyReportCache }
>();
const dailyReportInflight = new Map<
  string,
  Promise<AdjustReportRow[]>
>();
const dailyReportTails = new Map<string, Promise<void>>();

function reportDays(range: DateRange): string[] {
  const days: string[] = [];
  const cursor = new Date(`${range.since}T00:00:00Z`);
  const until = new Date(`${range.until}T00:00:00Z`);
  while (cursor <= until) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

function contiguousRanges(days: string[]): DateRange[] {
  const ranges: DateRange[] = [];
  for (const day of days.sort()) {
    const previous = ranges.at(-1);
    if (!previous) {
      ranges.push({ since: day, until: day });
      continue;
    }
    const next = new Date(`${previous.until}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    if (next.toISOString().slice(0, 10) === day) {
      previous.until = day;
    } else {
      ranges.push({ since: day, until: day });
    }
  }
  return ranges;
}

function dailyEntryFresh(
  day: string,
  entry: { savedAt: string; rows: AdjustReportRow[] },
): boolean {
  const saved = Date.parse(entry.savedAt);
  if (!Number.isFinite(saved)) return false;
  const ageDays = Math.floor(
    (Date.now() - Date.parse(`${day}T00:00:00Z`)) / 86_400_000,
  );
  const normalTtl =
    ageDays <= 7 ? 15 * 60_000 : 24 * 60 * 60_000;
  const ttl = entry.rows.length === 0
    ? Math.min(normalTtl, 5 * 60_000)
    : normalTtl;
  return saved + ttl > Date.now();
}

function recentReportDay(day: string): boolean {
  return (
    Math.floor(
      (Date.now() - Date.parse(`${day}T00:00:00Z`)) /
        86_400_000,
    ) <= 7
  );
}

async function readDailyReportCache(
  key: string,
): Promise<{ path: string; value: DailyReportCache }> {
  const remembered = dailyReportMemory.get(key);
  if (remembered) return remembered;
  const path = join(adjustDailyDirectory, `${key}.json`);
  let value: DailyReportCache = { version: 1, days: {} };
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as DailyReportCache;
    if (parsed.version === 1 && parsed.days) value = parsed;
  } catch {
    // The first successful read creates this query's daily cache.
  }
  const loaded = { path, value };
  dailyReportMemory.set(key, loaded);
  return loaded;
}

async function writeDailyReportCache(
  path: string,
  value: DailyReportCache,
): Promise<void> {
  const recentDays = Object.entries(value.days)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, 200);
  value.days = Object.fromEntries(recentDays);
  await mkdir(adjustDailyDirectory, { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
}

/**
 * Persist Library report rows by UTC day. Overlapping 7/28/90-day windows
 * reuse daily partitions and only fetch missing or expired days.
 */
export async function fetchAdjustDailyCachedRows(
  apiToken: string,
  appToken: string,
  range: DateRange,
  dimensions: string[],
  metrics: string[],
  label = "Adjust Report API",
  force = false,
): Promise<AdjustReportRow[]> {
  const cacheIdentity = JSON.stringify({
    appToken,
    dimensions: [...dimensions].sort(),
    metrics: [...metrics].sort(),
  });
  const key = createHash("sha256")
    .update(cacheIdentity)
    .digest("hex")
    .slice(0, 24);
  const inflightKey = `${key}:${range.since}:${range.until}:${force}`;
  const pending = dailyReportInflight.get(inflightKey);
  if (pending) return pending;
  const prior = dailyReportTails.get(key) ?? Promise.resolve();
  const promise = prior.catch(() => undefined).then(async () => {
    const cache = await readDailyReportCache(key);
    const days = reportDays(range);
    const missing = days.filter(
      (day) =>
        force ||
        !cache.value.days[day] ||
        !dailyEntryFresh(day, cache.value.days[day]!),
    );
    const queryDimensions = [
      "day",
      ...dimensions.filter((dimension) => dimension !== "day"),
    ];
    for (const segment of contiguousRanges(missing)) {
      const rows = await fetchAdjustReportRows(
        apiToken,
        appToken,
        segment,
        queryDimensions,
        metrics,
        label,
      );
      const byDay = new Map<string, AdjustReportRow[]>(
        reportDays(segment).map((day) => [day, []]),
      );
      const invalidRows: AdjustReportRow[] = [];
      for (const row of rows) {
        const day =
          row.day && byDay.has(row.day)
            ? row.day
            : segment.since === segment.until
              ? segment.since
              : null;
        if (day) byDay.get(day)!.push(row);
        else invalidRows.push(row);
      }
      if (invalidRows.length > 0) {
        for (const day of missing) delete cache.value.days[day];
        return fetchAdjustReportRows(
          apiToken,
          appToken,
          range,
          dimensions,
          metrics,
          `${label} uncached fallback`,
        );
      }
      const savedAt = new Date().toISOString();
      for (const [day, dayRows] of byDay) {
        if (dayRows.length === 0 && recentReportDay(day)) {
          delete cache.value.days[day];
        } else {
          cache.value.days[day] = { savedAt, rows: dayRows };
        }
      }
    }
    if (missing.length > 0) {
      await writeDailyReportCache(cache.path, cache.value);
    }
    return days.flatMap((day) => cache.value.days[day]?.rows ?? []);
  }).finally(() => dailyReportInflight.delete(inflightKey));
  dailyReportInflight.set(inflightKey, promise);
  dailyReportTails.set(
    key,
    promise.then(
      () => undefined,
      () => undefined,
    ),
  );
  return promise;
}

export function isMetaPartner(partner: string): boolean {
  const p = partner.toLowerCase();
  return (
    p.includes("facebook") ||
    p.includes("instagram") ||
    p.includes("meta") ||
    p === "off-facebook" ||
    p.includes("audience network")
  );
}

/**
 * Match Gist helper's display-name cleaner:
 * url_decode → remove trailing (ad id) → remove "- Copy [N]" → trim.
 */
export function cleanAdjustCreativeName(raw: string): string {
  let decoded = raw.replace(/\+/g, " ");
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Report Service normally returns decoded labels; keep malformed input.
  }
  return decoded
    .replace(/\s*\([0-9]+\)\s*$/, "")
    .replace(/\s*-\s*Copy( [0-9]+)?$/i, "")
    .trim();
}

/**
 * Last mature Adjust UTC calendar cohort day. D1 for cohort day T observes
 * activity on calendar day T+1 and becomes final when that UTC day closes.
 */
export function fullMatureCutoff(day: 1 | 3 | 7, asOf = new Date()): string {
  const cutoff = new Date(asOf);
  cutoff.setUTCHours(0, 0, 0, 0);
  cutoff.setUTCDate(cutoff.getUTCDate() - (day + 1));
  return cutoff.toISOString().slice(0, 10);
}

/** Roll Meta partner rows up to the helper's cleaned Adjust creative label. */
export function rollupAdjustByCreative(
  rows: AdjustCreativeRow[],
): AdjustCreativeRow[] {
  type Acc = {
    creativeName: string;
    creativeIds: Set<string>;
    spendCreativeIds: Set<string>;
    metaCreativeNames: Set<string>;
    network: string;
    spend: number;
    impressions: number;
    clicks: number;
    installs: number;
    revenue: number;
    cost: number;
    retainedD1: number;
    retainedD3: number;
    retainedD7: number;
    retentionDenD1: number;
    retentionDenD3: number;
    retentionDenD7: number;
  };
  const byName = new Map<string, Acc>();

  for (const row of rows) {
    // Helper groups exact cleaned strings, not current Meta ad names.
    const key = row.creativeName;
    if (!key || key === "unknown") continue;
    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, {
        creativeName: row.creativeName,
        creativeIds: new Set([row.creativeId]),
        spendCreativeIds: new Set(row.spend > 0 ? [row.creativeId] : []),
        metaCreativeNames: new Set(row.metaCreativeNames),
        network: row.network,
        spend: row.spend,
        impressions: row.impressions,
        clicks: row.clicks,
        installs: row.installs,
        revenue: row.revenue,
        cost: row.cost,
        retainedD1: row.retainedD1,
        retainedD3: row.retainedD3,
        retainedD7: row.retainedD7,
        retentionDenD1: row.retentionDenD1,
        retentionDenD3: row.retentionDenD3,
        retentionDenD7: row.retentionDenD7,
      });
      continue;
    }
    existing.creativeIds.add(row.creativeId);
    if (row.spend > 0) {
      existing.spendCreativeIds.add(row.creativeId);
    }
    for (const name of row.metaCreativeNames) {
      if (name) existing.metaCreativeNames.add(name);
    }
    existing.spend += row.spend;
    existing.impressions += row.impressions;
    existing.clicks += row.clicks;
    existing.installs += row.installs;
    existing.revenue += row.revenue;
    existing.cost += row.cost;
    existing.retainedD1 += row.retainedD1;
    existing.retainedD3 += row.retainedD3;
    existing.retainedD7 += row.retainedD7;
    existing.retentionDenD1 += row.retentionDenD1;
    existing.retentionDenD3 += row.retentionDenD3;
    existing.retentionDenD7 += row.retentionDenD7;
  }

  return [...byName.values()].map((acc) => {
    const roas = acc.cost > 0 ? acc.revenue / acc.cost : 0;
    return {
      creativeId: normalizeCreativeName(acc.creativeName),
      creativeName: acc.creativeName,
      adIds: [...acc.creativeIds].sort(),
      metaCreativeNames: [...acc.metaCreativeNames].sort(),
      network: acc.network,
      // Install-only attribution rows can introduce IDs absent from the spend
      // side. Count spend-bearing IDs to match the helper table's "(N ads)".
      adCount:
        acc.spendCreativeIds.size > 0
          ? acc.spendCreativeIds.size
          : acc.creativeIds.size,
      spend: Math.round(acc.spend * 100) / 100,
      impressions: acc.impressions,
      clicks: acc.clicks,
      installs: acc.installs,
      revenue: Math.round(acc.revenue * 100) / 100,
      cost: Math.round(acc.cost * 100) / 100,
      roas: Math.round(roas * 100) / 100,
      retentionD1:
        Math.round(
          (acc.retentionDenD1 > 0
            ? (acc.retainedD1 / acc.retentionDenD1) * 100
            : 0) * 100,
        ) / 100,
      retentionD3:
        Math.round(
          (acc.retentionDenD3 > 0
            ? (acc.retainedD3 / acc.retentionDenD3) * 100
            : 0) * 100,
        ) / 100,
      retentionD7:
        Math.round(
          (acc.retentionDenD7 > 0
            ? (acc.retainedD7 / acc.retentionDenD7) * 100
            : 0) * 100,
        ) / 100,
      retainedD1: acc.retainedD1,
      retainedD3: acc.retainedD3,
      retainedD7: acc.retainedD7,
      retentionDenD1: acc.retentionDenD1,
      retentionDenD3: acc.retentionDenD3,
      retentionDenD7: acc.retentionDenD7,
    };
  }).sort((a, b) => b.spend - a.spend);
}

export type FetchAdjustOptions = {
  appToken?: string;
  appName?: string;
  force?: boolean;
  /** Default Facebook/Meta only (matches Gist helper Meta creative reports). */
  partner?: "meta" | "all";
};

/**
 * Read Adjust creative-level report rows. Needs ADJUST_API_TOKEN only.
 * Defaults to Meta/Facebook partners so installs align with Meta creatives.
 */
export async function fetchAdjustCreativePerformance(
  range: DateRange,
  opts: FetchAdjustOptions = {},
): Promise<AdjustPerformanceResult> {
  const missing = missingAdjustEnv();
  const partnerMode = opts.partner ?? "meta";
  if (missing.length > 0) {
    return {
      source: "fixture",
      appToken: activeAdjustAppToken(),
      appName: activeAdjustAppName(),
      appsAvailable: [],
      partnerFilter: partnerMode,
      grouping: "adjust-creative-cleaned",
      retentionCutoffs: {
        d1: fullMatureCutoff(1),
        d3: fullMatureCutoff(3),
        d7: fullMatureCutoff(7),
      },
      range,
      missingEnv: missing,
      rows: FIXTURE_ADJUST_ROWS,
    };
  }

  const apiToken = process.env.ADJUST_API_TOKEN!.trim();
  const appsAvailable = await listAdjustApps(apiToken);
  const app = resolveApp(appsAvailable, opts);

  const performanceDimensions = [
    "creative_id_network",
    "creative",
    "creative_network",
    "partner_name",
  ];
  const performanceMetrics = [
    "installs",
    "network_cost",
    "impressions",
    "clicks",
    "revenue",
    "roas",
  ];
  const retentionDimensions = [
    "day",
    "creative_id_network",
    "creative",
    "partner_name",
  ];
  const retentionMetrics = [
    "installs",
    "retained_users_d1",
    "retained_users_d3",
    "retained_users_d7",
  ];
  const [raw, retentionRows] = await Promise.all([
    opts.force
      ? fetchAdjustReportRows(
          apiToken,
          app.token,
          range,
          performanceDimensions,
          performanceMetrics,
          "Adjust creative performance",
        )
      : fetchAdjustDailyCachedRows(
          apiToken,
          app.token,
          range,
          performanceDimensions,
          performanceMetrics,
          "Adjust creative performance",
        ),
    opts.force
      ? fetchAdjustReportRows(
          apiToken,
          app.token,
          range,
          retentionDimensions,
          retentionMetrics,
          "Adjust retention cohorts",
        )
      : fetchAdjustDailyCachedRows(
          apiToken,
          app.token,
          range,
          retentionDimensions,
          retentionMetrics,
          "Adjust retention cohorts",
        ),
  ]);
  const mapped: AdjustCreativeRow[] = [];
  for (const row of raw) {
    const network = row.partner_name?.trim() || row.network?.trim() || "unknown";
    if (partnerMode === "meta" && !isMetaPartner(network)) continue;

    // The helper deliberately labels by Adjust's historical creative string,
    // not Meta's current creative_network/ad_name.
    const creativeName = cleanAdjustCreativeName(
      row.creative?.trim() ||
      row.creative_network?.trim() ||
      row.creative_name?.trim() ||
      row.creative_id_network?.trim() ||
      "unknown",
    );
    const creativeId = row.creative_id_network?.trim();
    // Helper excludes rows without a repaired Meta ad id.
    if (!creativeId) continue;
    const spend = num(row.network_cost);
    const revenue = num(row.revenue);
    const roas = row.roas !== undefined ? num(row.roas) : spend > 0 ? revenue / spend : 0;
    const metaCreativeName = cleanAdjustCreativeName(
      row.creative_network?.trim() ?? "",
    );
    mapped.push({
      creativeId,
      creativeName,
      adIds: [creativeId],
      metaCreativeNames: metaCreativeName ? [metaCreativeName] : [],
      network,
      adCount: 1,
      spend,
      impressions: num(row.impressions),
      clicks: num(row.clicks),
      installs: num(row.installs),
      revenue,
      cost: spend,
      roas: Math.round(roas * 100) / 100,
      retentionD1: retentionPct(row.retention_rate_d1),
      retentionD3: retentionPct(row.retention_rate_d3),
      retentionD7: retentionPct(row.retention_rate_d7),
      retainedD1: 0,
      retainedD3: 0,
      retainedD7: 0,
      retentionDenD1: 0,
      retentionDenD3: 0,
      retentionDenD7: 0,
    });
  }

  // Retention rates need their own mature cohort denominators. Pull daily
  // retained-user numerators and count installs only for fully mature cohort
  // days; weighting aggregate rates by all installs biases newer creatives.
  const cutoffs = {
    1: fullMatureCutoff(1),
    3: fullMatureCutoff(3),
    7: fullMatureCutoff(7),
  };
  for (const row of retentionRows) {
    const network = row.partner_name?.trim() || row.network?.trim() || "unknown";
    if (partnerMode === "meta" && !isMetaPartner(network)) continue;
    const creativeId = row.creative_id_network?.trim();
    if (!creativeId) continue;
    const creativeName = cleanAdjustCreativeName(
      row.creative?.trim() ||
        row.creative_name?.trim() ||
        creativeId,
    );
    const day = row.day ?? "";
    const cohortInstalls = num(row.installs);
    const matureD1 = day !== "" && day <= cutoffs[1];
    const matureD3 = day !== "" && day <= cutoffs[3];
    const matureD7 = day !== "" && day <= cutoffs[7];
    mapped.push({
      creativeId,
      creativeName,
      adIds: [creativeId],
      metaCreativeNames: [],
      network,
      adCount: 1,
      spend: 0,
      impressions: 0,
      clicks: 0,
      installs: 0,
      revenue: 0,
      cost: 0,
      roas: 0,
      retentionD1: 0,
      retentionD3: 0,
      retentionD7: 0,
      retainedD1: matureD1 ? num(row.retained_users_d1) : 0,
      retainedD3: matureD3 ? num(row.retained_users_d3) : 0,
      retainedD7: matureD7 ? num(row.retained_users_d7) : 0,
      retentionDenD1: matureD1 ? cohortInstalls : 0,
      retentionDenD3: matureD3 ? cohortInstalls : 0,
      retentionDenD7: matureD7 ? cohortInstalls : 0,
    });
  }

  return {
    source: "live",
    appToken: null,
    appName: app.name,
    appsAvailable: appsAvailable.map((item) => ({
      token: "",
      name: item.name,
    })),
    partnerFilter: partnerMode,
    grouping: "adjust-creative-cleaned",
    retentionCutoffs: {
      d1: cutoffs[1],
      d3: cutoffs[3],
      d7: cutoffs[7],
    },
    range,
    missingEnv: [],
    rows: rollupAdjustByCreative(mapped),
  };
}
