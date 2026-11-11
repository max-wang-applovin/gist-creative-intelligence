import {
  cleanAdjustCreativeName,
  fetchAdjustReportRows,
  fullMatureCutoff,
  isMetaPartner,
  resolveAdjustApp,
  type AdjustReportRow,
} from "../bot/lib/adjust.js";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { defaultDateRange } from "../bot/lib/dates.js";
import { normalizeCreativeName } from "../bot/lib/names.js";

export const DEFAULT_DEBRIEF_SINCE = "2026-09-15";
const MAX_DEBRIEF_DAYS = 180;
const CACHE_TTL_MS = 30 * 60_000;
const snapshotDirectory = resolve(
  process.env.DASHBOARD_DATA_DIR?.trim() || ".agent-serve",
  "debrief",
);

/** Max's decision rule: decide at 7 days or $350, whichever comes first. */
const DECISION_SPEND = 350;
const DECISION_DAYS = 7;
const DECISION_MIN_SPEND_AT_DAYS = 100;
const WINNER_MIN_SIGNUPS = 10;
const LIST_SIZE = 10;
const MIN_RETENTION_COHORT = 20;
const RANKING_MIN_RETENTION_COHORT = 50;
/** Ignore funnel gaps smaller than ±15% when explaining a verdict. */
const MIN_REASON_GAP = Math.log(1.15);

export type DebriefSource =
  | "In-house"
  | "Donut"
  | "Hit Rate"
  | "Creator"
  | "Ambassador"
  | "CRM"
  | "Other";
export type DebriefVerdict = "Winner" | "Loser" | "Middle" | "Learning";
export type RetentionConfidence = "Low" | "Medium" | "High" | null;
export type DebriefAction = "Scale" | "Pause" | "Iterate" | "Wait";

export type DebriefStageMetrics = {
  spend: number;
  impressions: number;
  clicks: number;
  installs: number;
  signups: number;
  ctr: number;
  cpm: number;
  cpi: number | null;
  cpsu: number | null;
  d1: number | null;
  d3: number | null;
  d7: number | null;
  costPerRetainedD1: number | null;
  costPerRetainedD3: number | null;
  costPerRetainedD7: number | null;
  retainedD1: number;
  retainedD3: number;
  retainedD7: number;
  d1Cohort: number;
  d3Cohort: number;
  d7Cohort: number;
  retentionHorizon: "D1" | "D3" | "D7" | null;
  retentionCost: number | null;
  confidence: RetentionConfidence;
};

export type DebriefCreative = {
  name: string;
  readableName: string;
  creator: string | null;
  hook: string | null;
  category: string | null;
  source: DebriefSource;
  format: "Video" | "Static" | "Unknown";
  os: "iOS" | "Android" | "Both" | "Unknown";
  uploadedAt: string | null;
  /** Upload day in the ad account's timezone (or from the ad-name prefix). */
  uploadedDate: string | null;
  uploadedFrom: "meta" | "name" | null;
  /** Uploaded before the debrief window (e.g. a control re-run in testing). */
  carryover: boolean;
  daysLive: number | null;
  status: "Live" | "Paused";
  promoted: boolean;
  spend: number;
  testingSpend: number;
  scaledSpend: number;
  testing: DebriefStageMetrics;
  scaled: DebriefStageMetrics;
  impressions: number;
  clicks: number;
  ctr: number;
  cpm: number;
  installs: number;
  cpi: number | null;
  clickToInstall: number | null;
  installToSignup: number | null;
  signups: number;
  testingSignups: number;
  cpsu: number | null;
  d1: number | null;
  d3: number | null;
  d7: number | null;
  costPerRetainedD1: number | null;
  costPerRetainedD3: number | null;
  costPerRetainedD7: number | null;
  retentionHorizon: "D1" | "D3" | "D7" | null;
  retentionCost: number | null;
  retentionCostIndex: number | null;
  retentionConfidence: RetentionConfidence;
  recommendedAction: DebriefAction;
  actionReason: string;
  spendToDecision: number;
  daysToDecision: number | null;
  retainedD1: number;
  retainedD3: number;
  retainedD7: number;
  d1Cohort: number;
  d3Cohort: number;
  d7Cohort: number;
  eligible: boolean;
  verdict: DebriefVerdict;
  reasons: string[];
  thumbnailUrl: string | null;
  adIds: string[];
  campaigns: string[];
  adSets: string[];
};

type CreativeRef = {
  name: string;
  readableName: string;
  cpsu: number | null;
  retentionHorizon: "D1" | "D3" | "D7" | null;
  retentionCost: number | null;
  spend: number;
};

type DebriefBenchmark = {
  label: string;
  creativeName: string | null;
  count: number;
  cpsu: number | null;
  d1: number | null;
  d3: number | null;
  d7: number | null;
};

type DebriefSegmentBenchmark = DebriefBenchmark & {
  dimension: "Source" | "OS" | "Format";
  segment: string;
};

export type DebriefSourceSummary = {
  source: DebriefSource;
  tested: number;
  spend: number;
  testingSpend: number;
  scaledSpend: number;
  signups: number;
  cpsu: number | null;
  winners: number;
  losers: number;
  learning: number;
  promoted: number;
  best: CreativeRef | null;
  worst: CreativeRef | null;
};

export type DebriefPayload = {
  generatedAt: string;
  freshness?: {
    source: "live" | "memory" | "disk";
    refreshing: boolean;
    expiresAt: string;
  };
  adjustApp: string;
  range: { since: string; until: string };
  summary: {
    tested: number;
    winners: number;
    losers: number;
    middle: number;
    learning: number;
    promoted: number;
    paused: number;
    live: number;
    carryover: number;
    spend: number;
    testingSpend: number;
    scaledSpend: number;
    signups: number;
    testingSignups: number;
    scaledSignups: number;
    cpsu: number | null;
    since: string;
    until: string;
  };
  rules: {
    tested: string;
    eligible: string;
    winners: string;
    losers: string;
    promoted: string;
    retention: string;
    retentionRisks: string;
  };
  typical: {
    ctr: number | null;
    cpm: number | null;
    clickToInstall: number | null;
    installToSignup: number | null;
    d1: number | null;
    d3: number | null;
    d7: number | null;
    costPerRetainedD1: number | null;
    costPerRetainedD3: number | null;
    costPerRetainedD7: number | null;
    cpsu: number | null;
  };
  bySource: DebriefSourceSummary[];
  benchmarks: {
    average: DebriefBenchmark;
    best: DebriefBenchmark | null;
  };
  segmentBenchmarks: DebriefSegmentBenchmark[];
  winners: DebriefCreative[];
  losers: DebriefCreative[];
  retentionRisks: DebriefCreative[];
  scaledValidation: DebriefCreative[];
  decisions: DebriefCreative[];
  all: DebriefCreative[];
  warnings: string[];
};

type MetaAd = {
  id: string;
  name: string;
  createdTime: string | null;
  effectiveStatus: string;
  adSetName: string;
  campaignName: string;
  objectType: string | null;
  videoId: string | null;
  thumbnailUrl: string | null;
};

type GraphAd = {
  id?: string;
  name?: string;
  created_time?: string;
  effective_status?: string;
  adset?: { name?: string };
  campaign?: { name?: string };
  creative?: {
    object_type?: string;
    thumbnail_url?: string;
    video_id?: string;
    asset_feed_spec?: { videos?: { video_id?: string }[] };
    object_story_spec?: { video_data?: { video_id?: string } };
  };
};

// The /ads edge rejects DELETED in effective_status, so deleted ads are absent.
const META_AD_STATUSES = [
  "ACTIVE",
  "PAUSED",
  "PENDING_REVIEW",
  "DISAPPROVED",
  "PREAPPROVED",
  "PENDING_BILLING_INFO",
  "CAMPAIGN_PAUSED",
  "ARCHIVED",
  "ADSET_PAUSED",
  "IN_PROCESS",
  "WITH_ISSUES",
];

async function fetchMetaAdInventory(): Promise<MetaAd[]> {
  const token = process.env.META_ACCESS_TOKEN?.trim();
  const account = process.env.META_AD_ACCOUNT_ID?.trim();
  if (!token || !account) {
    throw new Error("META_ACCESS_TOKEN and META_AD_ACCOUNT_ID are required.");
  }
  const adAccountId = account.startsWith("act_") ? account : `act_${account}`;
  const url = new URL(`https://graph.facebook.com/v23.0/${adAccountId}/ads`);
  url.searchParams.set(
    "fields",
    "id,name,created_time,effective_status,adset{name},campaign{name},creative.thumbnail_width(160).thumbnail_height(160){object_type,thumbnail_url,video_id,asset_feed_spec{videos},object_story_spec{video_data{video_id}}}",
  );
  url.searchParams.set("effective_status", JSON.stringify(META_AD_STATUSES));
  url.searchParams.set("limit", "500");
  url.searchParams.set("access_token", token);

  const ads: MetaAd[] = [];
  let next: string | undefined = url.toString();
  for (let page = 0; next && page < 40; page += 1) {
    const response = await fetch(next);
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Meta ads ${response.status}: ${body.slice(0, 300)}`);
    }
    const payload = (await response.json()) as {
      data?: GraphAd[];
      paging?: { next?: string };
    };
    for (const ad of payload.data ?? []) {
      if (!ad.id) continue;
      ads.push({
        id: ad.id,
        name: ad.name ?? ad.id,
        createdTime: ad.created_time ?? null,
        effectiveStatus: ad.effective_status ?? "UNKNOWN",
        adSetName: ad.adset?.name ?? "",
        campaignName: ad.campaign?.name ?? "",
        objectType: ad.creative?.object_type ?? null,
        videoId:
          ad.creative?.video_id ??
          ad.creative?.asset_feed_spec?.videos?.[0]?.video_id ??
          ad.creative?.object_story_spec?.video_data?.video_id ??
          null,
        thumbnailUrl: ad.creative?.thumbnail_url ?? null,
      });
    }
    next = payload.paging?.next;
  }
  return ads;
}

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

const round2 = (value: number) => Math.round(value * 100) / 100;
const ratio = (top: number, bottom: number) => (bottom > 0 ? top / bottom : null);
const pctOf = (top: number, bottom: number) =>
  bottom > 0 ? round2((top / bottom) * 100) : null;

function retentionConfidence(cohort: number): RetentionConfidence {
  if (cohort < MIN_RETENTION_COHORT) return null;
  if (cohort < RANKING_MIN_RETENTION_COHORT) return "Low";
  if (cohort < 200) return "Medium";
  return "High";
}

function stageMetrics(acc: StageAcc): DebriefStageMetrics {
  const d1 =
    acc.cohortD1 >= MIN_RETENTION_COHORT
      ? pctOf(acc.retainedD1, acc.cohortD1)
      : null;
  const d3 =
    acc.cohortD3 >= MIN_RETENTION_COHORT
      ? pctOf(acc.retainedD3, acc.cohortD3)
      : null;
  const d7 =
    acc.cohortD7 >= MIN_RETENTION_COHORT
      ? pctOf(acc.retainedD7, acc.cohortD7)
      : null;
  const retentionHorizon =
    d7 !== null ? "D7" : d3 !== null ? "D3" : d1 !== null ? "D1" : null;
  const costPerRetainedD1 =
    d1 !== null ? ratio(acc.cohortSpendD1, acc.retainedD1) : null;
  const costPerRetainedD3 =
    d3 !== null ? ratio(acc.cohortSpendD3, acc.retainedD3) : null;
  const costPerRetainedD7 =
    d7 !== null ? ratio(acc.cohortSpendD7, acc.retainedD7) : null;
  const retentionCost =
    retentionHorizon === "D7"
      ? costPerRetainedD7
      : retentionHorizon === "D3"
        ? costPerRetainedD3
        : retentionHorizon === "D1"
          ? costPerRetainedD1
          : null;
  const cohort =
    retentionHorizon === "D7"
      ? acc.cohortD7
      : retentionHorizon === "D3"
        ? acc.cohortD3
        : retentionHorizon === "D1"
          ? acc.cohortD1
          : 0;
  return {
    spend: round2(acc.spend),
    impressions: acc.impressions,
    clicks: acc.clicks,
    installs: acc.installs,
    signups: acc.signups,
    ctr: pctOf(acc.clicks, acc.impressions) ?? 0,
    cpm: round2(acc.impressions > 0 ? (acc.spend / acc.impressions) * 1000 : 0),
    cpi: ratio(acc.spend, acc.installs),
    cpsu: ratio(acc.spend, acc.signups),
    d1,
    d3,
    d7,
    costPerRetainedD1:
      costPerRetainedD1 === null ? null : round2(costPerRetainedD1),
    costPerRetainedD3:
      costPerRetainedD3 === null ? null : round2(costPerRetainedD3),
    costPerRetainedD7:
      costPerRetainedD7 === null ? null : round2(costPerRetainedD7),
    retainedD1: acc.retainedD1,
    retainedD3: acc.retainedD3,
    retainedD7: acc.retainedD7,
    d1Cohort: acc.cohortD1,
    d3Cohort: acc.cohortD3,
    d7Cohort: acc.cohortD7,
    retentionHorizon,
    retentionCost: retentionCost === null ? null : round2(retentionCost),
    confidence: retentionConfidence(cohort),
  };
}

function creativeKey(raw: string): string {
  return normalizeCreativeName(cleanAdjustCreativeName(raw));
}

function isTestingCampaign(name: string): boolean {
  return /testing/i.test(name);
}

function isMainCampaign(name: string): boolean {
  return !isTestingCampaign(name) && /leads_cbo on/i.test(name);
}

const SOURCE_CODES: Record<string, DebriefSource> = {
  IH: "In-house",
  DD: "Donut",
  CR: "Creator",
  AMB: "Ambassador",
  CRM: "CRM",
};

/** Codes like T2R5C06 or V2 stay intact; trailing counters (Hook2) split off. */
function splitCamel(token: string): string {
  return token
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/(\d)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z]{2})(\d+)$/, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

/** Ad-name convention: YYMMDD_<SOURCE>_<Category>_<Creator>_<Hook>[_…]. */
export function parseCreativeName(name: string): {
  sourceCode: string | null;
  uploadedFromName: string | null;
  category: string | null;
  creator: string | null;
  hook: string | null;
  readableName: string;
} {
  const tokens = name.split("_");
  const datePart = /^\d{6}$/.test(tokens[0] ?? "") ? tokens[0]! : null;
  if (!datePart) {
    return {
      sourceCode: null,
      uploadedFromName: null,
      category: null,
      creator: null,
      hook: null,
      readableName: name,
    };
  }
  const mm = Number(datePart.slice(2, 4));
  const dd = Number(datePart.slice(4, 6));
  const uploadedFromName =
    mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31
      ? `20${datePart.slice(0, 2)}-${datePart.slice(2, 4)}-${datePart.slice(4, 6)}`
      : null;
  const sourceCode = tokens[1]?.toUpperCase() ?? null;
  const category = tokens[2] ? splitCamel(tokens[2]) : null;
  const rawCreator = tokens[3] ?? "";
  const creator =
    rawCreator && rawCreator.toLowerCase() !== "none"
      ? splitCamel(rawCreator)
      : null;
  const hook = tokens[4] ? splitCamel(tokens[4]) : null;
  const readable = [creator, hook].filter(Boolean).join(" · ");
  return {
    sourceCode,
    uploadedFromName,
    category,
    creator,
    hook,
    readableName: readable || category || name,
  };
}

type StageAcc = {
  spend: number;
  impressions: number;
  clicks: number;
  installs: number;
  signups: number;
  retainedD1: number;
  retainedD3: number;
  retainedD7: number;
  cohortSpendD1: number;
  cohortSpendD3: number;
  cohortSpendD7: number;
  cohortD1: number;
  cohortD3: number;
  cohortD7: number;
};

type Acc = StageAcc & {
  key: string;
  name: string;
  testingImpressions: number;
  testingSignups: number;
  testing: StageAcc;
  scaled: StageAcc;
  campaigns: Set<string>;
  adSets: Set<string>;
};

function emptyStageAcc(): StageAcc {
  return {
    spend: 0,
    impressions: 0,
    clicks: 0,
    installs: 0,
    signups: 0,
    retainedD1: 0,
    retainedD3: 0,
    retainedD7: 0,
    cohortSpendD1: 0,
    cohortSpendD3: 0,
    cohortSpendD7: 0,
    cohortD1: 0,
    cohortD3: 0,
    cohortD7: 0,
  };
}

function median(values: number[]): number | null {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function benchmarkForRows(
  label: string,
  rows: DebriefCreative[],
): DebriefBenchmark {
  const total = (key: keyof DebriefStageMetrics) =>
    rows.reduce(
      (sum, creative) => sum + Number(creative.testing[key] || 0),
      0,
    );
  return {
    label,
    creativeName: null,
    count: rows.length,
    cpsu: ratio(total("spend"), total("signups")),
    d1: pctOf(total("retainedD1"), total("d1Cohort")),
    d3: pctOf(total("retainedD3"), total("d3Cohort")),
    d7: pctOf(total("retainedD7"), total("d7Cohort")),
  };
}

const fmtPct = (value: number) =>
  `${value >= 10 ? Math.round(value) : value.toFixed(1)}%`;
const fmtMoney = (value: number) =>
  `$${value >= 100 ? Math.round(value).toLocaleString("en-US") : value.toFixed(2)}`;

type Typical = DebriefPayload["typical"];

type Signal = {
  metric:
    | "ctr"
    | "cpm"
    | "clickToInstall"
    | "installToSignup"
    | "d1"
    | "d3"
    | "d7";
  /** ln(creative / typical) oriented so positive means better. */
  score: number;
  value: number;
  typical: number;
};

function signalsFor(creative: DebriefCreative, typical: Typical): Signal[] {
  const metrics = creative.testing;
  const signals: Signal[] = [];
  const push = (
    metric: Signal["metric"],
    value: number | null,
    base: number | null,
    higherIsBetter: boolean,
  ) => {
    if (value === null || base === null || base <= 0) return;
    const safe = Math.max(value, base / 1000);
    const score = higherIsBetter ? Math.log(safe / base) : Math.log(base / safe);
    signals.push({ metric, score, value, typical: base });
  };
  if (metrics.impressions > 0) {
    push("ctr", metrics.ctr, typical.ctr, true);
    push("cpm", metrics.cpm, typical.cpm, false);
  }
  push(
    "clickToInstall",
    pctOf(metrics.installs, metrics.clicks),
    typical.clickToInstall,
    true,
  );
  push(
    "installToSignup",
    pctOf(metrics.signups, metrics.installs),
    typical.installToSignup,
    true,
  );
  if (creative.retentionHorizon === "D7") {
    push("d7", metrics.d7, typical.d7, true);
  } else if (creative.retentionHorizon === "D3") {
    push("d3", metrics.d3, typical.d3, true);
  } else if (creative.retentionHorizon === "D1") {
    push("d1", metrics.d1, typical.d1, true);
  }
  return signals;
}

function describe(
  signal: Signal,
  good: boolean,
  all: Signal[],
  creative: DebriefCreative,
): string {
  const v = signal.value;
  const t = signal.typical;
  if (!good && v === 0 && signal.metric === "clickToInstall") {
    return `No installs from ${creative.testing.clicks.toLocaleString("en-US")} testing clicks`;
  }
  switch (signal.metric) {
    case "ctr":
      return good
        ? `Strong hook: CTR ${fmtPct(v)} vs ${fmtPct(t)} typical`
        : `Weak hook: CTR ${fmtPct(v)} vs ${fmtPct(t)} typical`;
    case "cpm":
      return good
        ? `Cheap reach: CPM ${fmtMoney(v)} vs ${fmtMoney(t)} typical`
        : `Expensive reach: CPM ${fmtMoney(v)} vs ${fmtMoney(t)} typical`;
    case "clickToInstall": {
      if (good) {
        return `Clicks turn into installs (CVR ${fmtPct(v)} vs ${fmtPct(t)})`;
      }
      const cheapClicks = all.some(
        (item) => (item.metric === "ctr" || item.metric === "cpm") && item.score > 0,
      );
      return cheapClicks
        ? `Cheap clicks but few installs (CVR ${fmtPct(v)} vs ${fmtPct(t)})`
        : `Few clicks turn into installs (CVR ${fmtPct(v)} vs ${fmtPct(t)})`;
    }
    case "installToSignup":
      return good
        ? `Installers sign up (${fmtPct(v)} vs ${fmtPct(t)} typical)`
        : `Installs don't sign up (${fmtPct(v)} vs ${fmtPct(t)} typical)`;
    case "d1":
    case "d3":
    case "d7": {
      const day = signal.metric.slice(1);
      return good
        ? `Day-${day} retention ${fmtPct(v)} vs ${fmtPct(t)} typical`
        : `Low day-${day} retention ${fmtPct(v)} vs ${fmtPct(t)} typical`;
    }
  }
}

/**
 * CPM, CTR, click→install and install→sign-up multiply out to cost per
 * sign-up, so their log gaps vs the median are comparable contributions.
 */
function reasonsFor(
  creative: DebriefCreative,
  typical: Typical,
  good: boolean,
): string[] {
  const reasons: string[] = [];
  if (!good && creative.testing.signups === 0) {
    reasons.push(
      `No sign-ups from ${fmtMoney(creative.testing.spend)} testing spend`,
    );
  }
  const signals = signalsFor(creative, typical);
  const ranked = signals
    .filter((signal) =>
      good ? signal.score >= MIN_REASON_GAP : signal.score <= -MIN_REASON_GAP,
    )
    .sort((a, b) => (good ? b.score - a.score : a.score - b.score));
  for (const signal of ranked) {
    if (reasons.length >= 2) break;
    if (
      creative.testing.signups === 0 &&
      signal.metric === "installToSignup"
    ) {
      continue;
    }
    reasons.push(describe(signal, good, signals, creative));
  }
  const typicalRetentionCost =
    creative.retentionHorizon === "D7"
      ? typical.costPerRetainedD7
      : creative.retentionHorizon === "D3"
        ? typical.costPerRetainedD3
        : creative.retentionHorizon === "D1"
          ? typical.costPerRetainedD1
          : null;
  if (
    reasons.length === 0 &&
    creative.retentionCost !== null &&
    typicalRetentionCost !== null &&
    creative.retentionHorizon
  ) {
    reasons.push(
      good
        ? `Efficient ${creative.retentionHorizon} retention (${fmtMoney(creative.retentionCost)} per retained user vs ${fmtMoney(typicalRetentionCost)} typical)`
        : `Expensive ${creative.retentionHorizon} retention (${fmtMoney(creative.retentionCost)} per retained user vs ${fmtMoney(typicalRetentionCost)} typical)`,
    );
  } else if (
    reasons.length === 0 &&
    creative.testing.cpsu !== null &&
    typical.cpsu !== null
  ) {
    reasons.push(
      good
        ? `Efficient testing funnel (${fmtMoney(creative.testing.cpsu)} per sign-up vs ${fmtMoney(typical.cpsu)} typical)`
        : `Weak testing funnel (${fmtMoney(creative.testing.cpsu)} per sign-up vs ${fmtMoney(typical.cpsu)} typical)`,
    );
  }
  return reasons;
}

function parseDay(value: string | null, label: string): string | undefined {
  if (!value) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`Invalid ${label} date: ${value}`);
  }
  return value;
}

export function resolveDebriefRange(
  sinceParam: string | null,
  untilParam: string | null,
): { since: string; until: string } {
  const yesterday = defaultDateRange(1).until;
  const since = parseDay(sinceParam, "since") ?? DEFAULT_DEBRIEF_SINCE;
  const until = parseDay(untilParam, "until") ?? yesterday;
  if (until > yesterday) throw new Error(`until must be ${yesterday} or earlier.`);
  if (since > until) throw new Error("since must be on or before until.");
  const days =
    (Date.parse(`${until}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) /
      86_400_000 +
    1;
  if (days > MAX_DEBRIEF_DAYS) {
    throw new Error(`Debrief window must be at most ${MAX_DEBRIEF_DAYS} days.`);
  }
  return { since, until };
}

function ref(creative: DebriefCreative | undefined): CreativeRef | null {
  if (!creative) return null;
  return {
    name: creative.name,
    readableName: creative.readableName,
    cpsu: creative.testing.cpsu,
    retentionHorizon: creative.retentionHorizon,
    retentionCost: creative.retentionCost,
    spend: creative.spend,
  };
}

/** Best first: lowest horizon-normalized cost per retained user. */
function compareBestFirst(a: DebriefCreative, b: DebriefCreative): number {
  const aCost = a.retentionCostIndex ?? Number.POSITIVE_INFINITY;
  const bCost = b.retentionCostIndex ?? Number.POSITIVE_INFINITY;
  if (aCost !== bCost) return aCost - bCost;
  const aSignupCost = a.testing.cpsu ?? Number.POSITIVE_INFINITY;
  const bSignupCost = b.testing.cpsu ?? Number.POSITIVE_INFINITY;
  if (aSignupCost !== bSignupCost) return aSignupCost - bSignupCost;
  return b.testing.spend - a.testing.spend;
}

/** Worst first: no retained users, then highest normalized retained-user cost. */
function compareWorstFirst(a: DebriefCreative, b: DebriefCreative): number {
  const aCost = a.retentionCostIndex ?? Number.POSITIVE_INFINITY;
  const bCost = b.retentionCostIndex ?? Number.POSITIVE_INFINITY;
  if (aCost !== bCost) return bCost - aCost;
  const aSignupCost = a.testing.cpsu ?? Number.POSITIVE_INFINITY;
  const bSignupCost = b.testing.cpsu ?? Number.POSITIVE_INFINITY;
  if (aSignupCost !== bSignupCost) return bSignupCost - aSignupCost;
  return b.testing.spend - a.testing.spend;
}

async function buildDebrief(range: {
  since: string;
  until: string;
}): Promise<DebriefPayload> {
  const warnings: string[] = [];
  const { apiToken, app } = await resolveAdjustApp();
  const [deliveryRows, retentionRows, metaAds] = await Promise.all([
    fetchAdjustReportRows(
      apiToken,
      app.token,
      range,
      ["partner_name", "campaign_network", "adgroup_network", "creative_network"],
      [
        "network_cost",
        "impressions",
        "clicks",
        "installs",
        "post_install_account_created_events",
      ],
    ),
    fetchAdjustReportRows(
      apiToken,
      app.token,
      range,
      ["day", "partner_name", "campaign_network", "creative_network"],
      [
        "installs",
        "network_cost",
        "retained_users_d1",
        "retained_users_d3",
        "retained_users_d7",
      ],
      "Adjust retention cohorts",
    ),
    fetchMetaAdInventory().catch((error: unknown) => {
      warnings.push(
        `Meta ad inventory unavailable; upload dates come from ad names and status/format are unknown: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [] as MetaAd[];
    }),
  ]);

  const usableName = (row: AdjustReportRow): string | null => {
    const raw = row.creative_network?.trim();
    if (!raw || raw === "unknown" || raw.includes("{{")) return null;
    if (!isMetaPartner(row.partner_name?.trim() || "unknown")) return null;
    return cleanAdjustCreativeName(raw);
  };

  const byKey = new Map<string, Acc>();
  for (const row of deliveryRows) {
    const name = usableName(row);
    if (!name) continue;
    const key = normalizeCreativeName(name);
    const campaign = cleanAdjustCreativeName(row.campaign_network?.trim() || "");
    const adSet = cleanAdjustCreativeName(row.adgroup_network?.trim() || "");
    let acc = byKey.get(key);
    if (!acc) {
      const totals = emptyStageAcc();
      acc = {
        key,
        name,
        ...totals,
        testingImpressions: 0,
        testingSignups: 0,
        testing: emptyStageAcc(),
        scaled: emptyStageAcc(),
        campaigns: new Set(),
        adSets: new Set(),
      };
      byKey.set(key, acc);
    }
    const spend = num(row.network_cost);
    const impressions = num(row.impressions);
    const clicks = num(row.clicks);
    const installs = num(row.installs);
    const signups = num(row.post_install_account_created_events);
    acc.spend += spend;
    acc.impressions += impressions;
    acc.clicks += clicks;
    acc.installs += installs;
    acc.signups += signups;
    if (spend > 0 || impressions > 0) {
      if (campaign) acc.campaigns.add(campaign);
      if (adSet) acc.adSets.add(adSet);
    }
    if (isTestingCampaign(campaign)) {
      acc.testing.spend += spend;
      acc.testing.impressions += impressions;
      acc.testing.clicks += clicks;
      acc.testing.installs += installs;
      acc.testing.signups += signups;
      acc.testingImpressions += impressions;
      acc.testingSignups += signups;
    } else if (isMainCampaign(campaign)) {
      acc.scaled.spend += spend;
      acc.scaled.impressions += impressions;
      acc.scaled.clicks += clicks;
      acc.scaled.installs += installs;
      acc.scaled.signups += signups;
    }
  }

  const cutoffD1 = fullMatureCutoff(1);
  const cutoffD3 = fullMatureCutoff(3);
  const cutoffD7 = fullMatureCutoff(7);
  const addMatureCohort = (
    target: StageAcc,
    row: AdjustReportRow,
  ): void => {
    const day = row.day ?? "";
    const installs = num(row.installs);
    const spend = num(row.network_cost);
    if (day && day <= cutoffD1) {
      target.retainedD1 += num(row.retained_users_d1);
      target.cohortD1 += installs;
      target.cohortSpendD1 += spend;
    }
    if (day && day <= cutoffD3) {
      target.retainedD3 += num(row.retained_users_d3);
      target.cohortD3 += installs;
      target.cohortSpendD3 += spend;
    }
    if (day && day <= cutoffD7) {
      target.retainedD7 += num(row.retained_users_d7);
      target.cohortD7 += installs;
      target.cohortSpendD7 += spend;
    }
  };
  for (const row of retentionRows) {
    const name = usableName(row);
    if (!name) continue;
    const acc = byKey.get(normalizeCreativeName(name));
    if (!acc) continue;
    addMatureCohort(acc, row);
    const campaign = cleanAdjustCreativeName(
      row.campaign_network?.trim() || "",
    );
    if (isTestingCampaign(campaign)) addMatureCohort(acc.testing, row);
    else if (isMainCampaign(campaign)) addMatureCohort(acc.scaled, row);
  }

  const adsByKey = new Map<string, MetaAd[]>();
  for (const ad of metaAds) {
    const key = creativeKey(ad.name);
    const list = adsByKey.get(key);
    if (list) list.push(ad);
    else adsByKey.set(key, [ad]);
  }

  const now = Date.now();
  const tested: DebriefCreative[] = [];
  let unmatched = 0;
  for (const acc of byKey.values()) {
    if (acc.testing.spend <= 0 && acc.testingImpressions <= 0) continue;
    const ads = (adsByKey.get(acc.key) ?? []).sort((a, b) =>
      (a.createdTime ?? "9999").localeCompare(b.createdTime ?? "9999"),
    );
    if (ads.length === 0) unmatched += 1;
    const parsed = parseCreativeName(acc.name);
    const adSets = new Set([...acc.adSets, ...ads.map((ad) => ad.adSetName)]);
    const campaigns = [
      ...new Set([...acc.campaigns, ...ads.map((ad) => ad.campaignName)]),
    ].filter(Boolean);
    const hitRate = [...adSets].some((name) => /^IH_Direct_HitRate/i.test(name));
    const source: DebriefSource = hitRate
      ? "Hit Rate"
      : (parsed.sourceCode && SOURCE_CODES[parsed.sourceCode]) || "Other";

    const metaCreated = ads.find((ad) => ad.createdTime)?.createdTime ?? null;
    const uploadedAt = metaCreated
      ? new Date(metaCreated).toISOString()
      : parsed.uploadedFromName
        ? `${parsed.uploadedFromName}T00:00:00.000Z`
        : null;
    const uploadedDate = metaCreated
      ? metaCreated.slice(0, 10)
      : parsed.uploadedFromName;
    const daysLive =
      uploadedAt !== null
        ? Math.max(0, Math.floor((now - Date.parse(uploadedAt)) / 86_400_000))
        : null;
    const ios = campaigns.some((name) => /ios/i.test(name));
    const android = campaigns.some((name) => /android/i.test(name));

    const overall = stageMetrics(acc);
    const testing = stageMetrics(acc.testing);
    const scaled = stageMetrics(acc.scaled);
    const eligible =
      testing.spend >= DECISION_SPEND ||
      (daysLive !== null &&
        daysLive >= DECISION_DAYS &&
        testing.spend >= DECISION_MIN_SPEND_AT_DAYS);

    tested.push({
      name: acc.name,
      readableName: parsed.readableName,
      creator: parsed.creator,
      hook: parsed.hook,
      category: parsed.category,
      source,
      format:
        ads.length === 0
          ? "Unknown"
          : ads.some((ad) => ad.objectType === "VIDEO" || ad.videoId)
            ? "Video"
            : "Static",
      os: ios && android ? "Both" : ios ? "iOS" : android ? "Android" : "Unknown",
      uploadedAt,
      uploadedDate,
      uploadedFrom: metaCreated ? "meta" : uploadedAt ? "name" : null,
      carryover: uploadedDate !== null && uploadedDate < range.since,
      daysLive,
      status: ads.some((ad) => ad.effectiveStatus === "ACTIVE") ? "Live" : "Paused",
      promoted: scaled.spend > 0,
      spend: overall.spend,
      testingSpend: testing.spend,
      scaledSpend: scaled.spend,
      testing,
      scaled,
      impressions: overall.impressions,
      clicks: overall.clicks,
      ctr: overall.ctr,
      cpm: overall.cpm,
      installs: overall.installs,
      cpi: overall.cpi,
      clickToInstall: pctOf(overall.installs, overall.clicks),
      installToSignup: pctOf(overall.signups, overall.installs),
      signups: overall.signups,
      testingSignups: testing.signups,
      cpsu: overall.cpsu,
      d1: overall.d1,
      d3: overall.d3,
      d7: overall.d7,
      costPerRetainedD1: overall.costPerRetainedD1,
      costPerRetainedD3: overall.costPerRetainedD3,
      costPerRetainedD7: overall.costPerRetainedD7,
      retentionHorizon: testing.retentionHorizon,
      retentionCost: testing.retentionCost,
      retentionCostIndex: null,
      retentionConfidence: testing.confidence,
      recommendedAction: "Wait",
      actionReason: "Waiting for enough testing evidence.",
      spendToDecision: round2(
        Math.max(
          0,
          (daysLive !== null && daysLive >= DECISION_DAYS
            ? DECISION_MIN_SPEND_AT_DAYS
            : DECISION_SPEND) - testing.spend,
        ),
      ),
      daysToDecision:
        daysLive === null ? null : Math.max(0, DECISION_DAYS - daysLive),
      retainedD1: overall.retainedD1,
      retainedD3: overall.retainedD3,
      retainedD7: overall.retainedD7,
      d1Cohort: overall.d1Cohort,
      d3Cohort: overall.d3Cohort,
      d7Cohort: overall.d7Cohort,
      eligible,
      verdict:
        eligible &&
        testing.retentionHorizon &&
        testing.confidence !== "Low"
          ? "Middle"
          : "Learning",
      reasons: [],
      thumbnailUrl: ads.find((ad) => ad.thumbnailUrl)?.thumbnailUrl ?? null,
      adIds: ads.map((ad) => ad.id),
      campaigns,
      adSets: [...adSets].filter(Boolean).sort(),
    });
  }
  if (metaAds.length > 0 && unmatched > 0) {
    warnings.push(
      `${unmatched} tested creative${unmatched === 1 ? "" : "s"} had no matching Meta ad (likely deleted); upload date falls back to the ad-name prefix.`,
    );
  }

  const eligible = tested.filter((creative) => creative.eligible);
  const typical: Typical = {
    ctr: median(
      eligible
        .filter((c) => c.testing.impressions > 0)
        .map((c) => c.testing.ctr),
    ),
    cpm: median(
      eligible
        .filter((c) => c.testing.impressions > 0)
        .map((c) => c.testing.cpm),
    ),
    clickToInstall: median(
      eligible.flatMap((c) => {
        const value = pctOf(c.testing.installs, c.testing.clicks);
        return value === null ? [] : [value];
      }),
    ),
    installToSignup: median(
      eligible.flatMap((c) => {
        const value = pctOf(c.testing.signups, c.testing.installs);
        return value === null ? [] : [value];
      }),
    ),
    d1: median(
      eligible.flatMap((c) =>
        c.testing.d1 !== null &&
        c.testing.d1Cohort >= MIN_RETENTION_COHORT
          ? [c.testing.d1]
          : [],
      ),
    ),
    d3: median(
      eligible.flatMap((c) =>
        c.testing.d3 !== null &&
        c.testing.d3Cohort >= MIN_RETENTION_COHORT
          ? [c.testing.d3]
          : [],
      ),
    ),
    d7: median(
      eligible.flatMap((c) =>
        c.testing.d7 !== null &&
        c.testing.d7Cohort >= MIN_RETENTION_COHORT
          ? [c.testing.d7]
          : [],
      ),
    ),
    costPerRetainedD1: median(
      eligible.flatMap((c) =>
        c.testing.costPerRetainedD1 === null
          ? []
          : [c.testing.costPerRetainedD1],
      ),
    ),
    costPerRetainedD3: median(
      eligible.flatMap((c) =>
        c.testing.costPerRetainedD3 === null
          ? []
          : [c.testing.costPerRetainedD3],
      ),
    ),
    costPerRetainedD7: median(
      eligible.flatMap((c) =>
        c.testing.costPerRetainedD7 === null
          ? []
          : [c.testing.costPerRetainedD7],
      ),
    ),
    cpsu: median(
      eligible.flatMap((c) =>
        c.testing.cpsu === null ? [] : [c.testing.cpsu],
      ),
    ),
  };
  for (const key of Object.keys(typical) as (keyof Typical)[]) {
    const value = typical[key];
    if (value !== null) typical[key] = round2(value);
  }

  for (const creative of eligible) {
    const typicalCost =
      creative.retentionHorizon === "D7"
        ? typical.costPerRetainedD7
        : creative.retentionHorizon === "D3"
          ? typical.costPerRetainedD3
          : creative.retentionHorizon === "D1"
            ? typical.costPerRetainedD1
            : null;
    creative.retentionCostIndex =
      creative.retentionCost !== null && typicalCost !== null && typicalCost > 0
        ? round2(creative.retentionCost / typicalCost)
        : null;
  }

  const ranked = eligible.filter(
    (creative) =>
      !creative.carryover &&
      creative.retentionHorizon !== null &&
      creative.retentionConfidence !== "Low",
  );
  const winners = ranked
    .filter(
      (creative) =>
        creative.testing.signups >= WINNER_MIN_SIGNUPS &&
        creative.retentionCostIndex !== null,
    )
    .sort(compareBestFirst)
    .slice(0, LIST_SIZE);
  const winnerSet = new Set(winners);
  const losers = ranked
    .filter((creative) => !winnerSet.has(creative))
    .sort(compareWorstFirst)
    .slice(0, LIST_SIZE);
  for (const creative of winners) {
    creative.verdict = "Winner";
    creative.reasons = reasonsFor(creative, typical, true);
  }
  for (const creative of losers) {
    creative.verdict = "Loser";
    creative.reasons = reasonsFor(creative, typical, false);
  }

  const retentionRate = (creative: DebriefCreative): number | null =>
    creative.retentionHorizon === "D7"
      ? creative.testing.d7
      : creative.retentionHorizon === "D3"
        ? creative.testing.d3
        : creative.retentionHorizon === "D1"
          ? creative.testing.d1
          : null;
  const typicalRetention = (creative: DebriefCreative): number | null =>
    creative.retentionHorizon === "D7"
      ? typical.d7
      : creative.retentionHorizon === "D3"
        ? typical.d3
        : creative.retentionHorizon === "D1"
          ? typical.d1
          : null;
  const retentionRisks = ranked
    .filter((creative) => {
      const rate = retentionRate(creative);
      const baseline = typicalRetention(creative);
      return (
        creative.testing.signups >= WINNER_MIN_SIGNUPS &&
        creative.testing.cpsu !== null &&
        typical.cpsu !== null &&
        creative.testing.cpsu <= typical.cpsu &&
        rate !== null &&
        baseline !== null &&
        rate < baseline
      );
    })
    .sort((a, b) => {
      const aRate = retentionRate(a) ?? 0;
      const bRate = retentionRate(b) ?? 0;
      const aBase = typicalRetention(a) ?? 1;
      const bBase = typicalRetention(b) ?? 1;
      return aRate / aBase - bRate / bBase || compareBestFirst(a, b);
    })
    .slice(0, LIST_SIZE);
  const retentionRiskSet = new Set(retentionRisks);
  const winnerSetForAction = new Set(winners);
  const loserSetForAction = new Set(losers);
  for (const creative of tested) {
    if (retentionRiskSet.has(creative)) {
      creative.recommendedAction = "Iterate";
      creative.actionReason =
        "Testing sign-ups are efficient, but mature retention is below its benchmark.";
    } else if (winnerSetForAction.has(creative)) {
      creative.recommendedAction = "Scale";
      creative.actionReason =
        "Testing retained-user cost ranks among the best with sufficient confidence.";
    } else if (loserSetForAction.has(creative)) {
      const severe =
        creative.testing.signups === 0 ||
        (creative.retentionCostIndex ?? 0) >= 1.5;
      creative.recommendedAction = severe ? "Pause" : "Iterate";
      creative.actionReason = severe
        ? "Testing retained-user cost is materially above benchmark."
        : "Testing performance is below benchmark but has a recoverable signal.";
    } else if (!creative.eligible) {
      creative.recommendedAction = "Wait";
      creative.actionReason =
        creative.spendToDecision > 0
          ? `${fmtMoney(creative.spendToDecision)} more testing spend needed, or wait ${creative.daysToDecision ?? "—"} day(s).`
          : "Waiting for the testing decision window.";
    } else if (
      creative.retentionConfidence === "Low" ||
      creative.retentionConfidence === null
    ) {
      creative.recommendedAction = "Wait";
      creative.actionReason =
        "Testing spend threshold is met, but the mature retention cohort is not yet large enough.";
    } else {
      creative.recommendedAction = "Iterate";
      creative.actionReason =
        "Testing evidence is mature but does not rank as a clear winner or loser.";
    }
  }
  const actionPriority: Record<DebriefAction, number> = {
    Scale: 0,
    Pause: 1,
    Iterate: 2,
    Wait: 3,
  };
  const decisions = [...tested].sort(
    (a, b) =>
      actionPriority[a.recommendedAction] -
        actionPriority[b.recommendedAction] ||
      (a.retentionCostIndex ?? Number.POSITIVE_INFINITY) -
        (b.retentionCostIndex ?? Number.POSITIVE_INFINITY) ||
      b.testing.spend - a.testing.spend,
  );

  const benchmarkAverage = benchmarkForRows(
    "Eligible testing weighted average",
    ranked,
  );
  const best = winners[0];
  const benchmarkBest: DebriefBenchmark | null = best
    ? {
        label: "Best retention-adjusted winner",
        creativeName: best.readableName,
        count: 1,
        cpsu: best.testing.cpsu,
        d1: best.testing.d1,
        d3: best.testing.d3,
        d7: best.testing.d7,
      }
    : null;
  const segmentBenchmarks: DebriefSegmentBenchmark[] = [];
  for (const [dimension, valueFor] of [
    ["Source", (creative: DebriefCreative) => creative.source],
    ["OS", (creative: DebriefCreative) => creative.os],
    ["Format", (creative: DebriefCreative) => creative.format],
  ] as const) {
    const groups = new Map<string, DebriefCreative[]>();
    for (const creative of ranked) {
      const segment = valueFor(creative);
      const group = groups.get(segment);
      if (group) group.push(creative);
      else groups.set(segment, [creative]);
    }
    for (const [segment, group] of groups) {
      segmentBenchmarks.push({
        dimension,
        segment,
        ...benchmarkForRows(`${dimension}: ${segment}`, group),
      });
    }
  }
  segmentBenchmarks.sort(
    (a, b) =>
      a.dimension.localeCompare(b.dimension) ||
      b.count - a.count ||
      a.segment.localeCompare(b.segment),
  );

  const all = [...tested].sort(
    (a, b) =>
      (b.uploadedAt ?? "").localeCompare(a.uploadedAt ?? "") ||
      b.spend - a.spend,
  );

  const sources = new Map<DebriefSource, DebriefCreative[]>();
  for (const creative of tested) {
    const list = sources.get(creative.source);
    if (list) list.push(creative);
    else sources.set(creative.source, [creative]);
  }
  const bySource: DebriefSourceSummary[] = [...sources.entries()]
    .map(([source, list]) => {
      const spend = list.reduce((sum, c) => sum + c.spend, 0);
      const signups = list.reduce((sum, c) => sum + c.testing.signups, 0);
      const ranked = list
        .filter(
          (c) =>
            c.eligible &&
            c.retentionHorizon !== null &&
            c.retentionConfidence !== "Low",
        )
        .sort(compareBestFirst);
      const withSignups = ranked.filter(
        (c) =>
          c.testing.signups >= WINNER_MIN_SIGNUPS &&
          c.retentionCostIndex !== null,
      );
      const worst = [...ranked].sort(compareWorstFirst)[0];
      return {
        source,
        tested: list.length,
        spend: round2(spend),
        testingSpend: round2(list.reduce((sum, c) => sum + c.testingSpend, 0)),
        scaledSpend: round2(list.reduce((sum, c) => sum + c.scaledSpend, 0)),
        signups,
        cpsu:
          signups > 0
            ? round2(
                list.reduce((sum, c) => sum + c.testing.spend, 0) /
                  signups,
              )
            : null,
        winners: list.filter((c) => c.verdict === "Winner").length,
        losers: list.filter((c) => c.verdict === "Loser").length,
        learning: list.filter((c) => c.verdict === "Learning").length,
        promoted: list.filter((c) => c.promoted).length,
        best: ref(withSignups[0] ?? ranked.find((c) => c.signups > 0)),
        worst: ranked.length > 1 ? ref(worst) : null,
      };
    })
    .sort((a, b) => b.spend - a.spend);

  const totalSpend = tested.reduce((sum, c) => sum + c.spend, 0);
  const totalSignups = tested.reduce((sum, c) => sum + c.signups, 0);
  const totalTestingSignups = tested.reduce(
    (sum, c) => sum + c.testing.signups,
    0,
  );
  const totalScaledSignups = tested.reduce(
    (sum, c) => sum + c.scaled.signups,
    0,
  );
  const totalTestingSpend = tested.reduce(
    (sum, c) => sum + c.testing.spend,
    0,
  );
  const count = (verdict: DebriefVerdict) =>
    tested.filter((c) => c.verdict === verdict).length;

  return {
    generatedAt: new Date().toISOString(),
    adjustApp: app.name,
    range,
    summary: {
      tested: tested.length,
      winners: winners.length,
      losers: losers.length,
      middle: count("Middle"),
      learning: count("Learning"),
      promoted: tested.filter((c) => c.promoted).length,
      paused: tested.filter((c) => c.status === "Paused").length,
      live: tested.filter((c) => c.status === "Live").length,
      carryover: tested.filter((c) => c.carryover).length,
      spend: round2(totalSpend),
      testingSpend: round2(tested.reduce((sum, c) => sum + c.testingSpend, 0)),
      scaledSpend: round2(tested.reduce((sum, c) => sum + c.scaledSpend, 0)),
      signups: totalSignups,
      testingSignups: totalTestingSignups,
      scaledSignups: totalScaledSignups,
      cpsu:
        totalTestingSignups > 0
          ? round2(totalTestingSpend / totalTestingSignups)
          : null,
      since: range.since,
      until: range.until,
    },
    rules: {
      tested:
        "Delivered in a Meta campaign whose name contains “Testing” during the window. Test verdicts use testing-campaign delivery only; scaled delivery is shown separately.",
      eligible: `Decided once testing spend ≥ $${DECISION_SPEND}, or ≥ ${DECISION_DAYS} days since upload with ≥ $${DECISION_MIN_SPEND_AT_DAYS} testing spend. Ranking requires ≥ ${RANKING_MIN_RETENTION_COHORT} mature testing installs (medium/high confidence); smaller cohorts remain learning.`,
      winners: `${LIST_SIZE} lowest testing cost per retained user among decided creatives uploaded in the window with ≥ ${WINNER_MIN_SIGNUPS} testing sign-ups. Uses testing D7 when mature, otherwise D3 then D1, normalized against the typical testing cost at that horizon.`,
      losers: `${LIST_SIZE} highest testing retention-adjusted costs among the other decided creatives uploaded in the window; mature testing cohorts with zero retained users rank worst. Older creatives are listed but not ranked.`,
      promoted: "Scaled = also spent in a main “Leads_CBO on” campaign; Testing only = no main-campaign spend.",
      retention: `D1/D3/D7 = retained users / installs from fully matured testing cohorts. Cost per retained user uses testing spend from those same cohorts. Confidence: low ${MIN_RETENTION_COHORT}–${RANKING_MIN_RETENTION_COHORT - 1}, medium ${RANKING_MIN_RETENTION_COHORT}–199, high 200+ mature installs.`,
      retentionRisks: `Good sign-ups, weak retention = ≥ ${WINNER_MIN_SIGNUPS} testing sign-ups and testing cost per sign-up at or below typical, but testing retention below typical at the most mature available horizon.`,
    },
    typical,
    bySource,
    benchmarks: {
      average: benchmarkAverage,
      best: benchmarkBest,
    },
    segmentBenchmarks,
    winners,
    losers,
    retentionRisks,
    scaledValidation: tested
      .filter(
        (creative) =>
          creative.promoted &&
          creative.testing.retentionHorizon !== null &&
          creative.scaled.spend > 0,
      )
      .sort(
        (a, b) =>
          b.scaled.spend - a.scaled.spend ||
          compareBestFirst(a, b),
      ),
    decisions,
    all,
    warnings,
  };
}

const cache = new Map<string, { expiresAt: number; value: DebriefPayload }>();
const inflight = new Map<string, Promise<DebriefPayload>>();

type DebriefSnapshot = {
  version: 1;
  savedAt: string;
  range: { since: string; until: string };
  value: DebriefPayload;
};

function debriefKey(range: { since: string; until: string }): string {
  return `${range.since}:${range.until}`;
}

function snapshotPath(range: { since: string; until: string }): string {
  return join(snapshotDirectory, `${range.since}_${range.until}.json`);
}

async function readSnapshot(range: {
  since: string;
  until: string;
}): Promise<{ savedAt: number; value: DebriefPayload } | null> {
  try {
    const parsed = JSON.parse(
      await readFile(snapshotPath(range), "utf8"),
    ) as DebriefSnapshot;
    const savedAt = Date.parse(parsed.savedAt);
    if (
      parsed.version !== 1 ||
      parsed.range.since !== range.since ||
      parsed.range.until !== range.until ||
      !Number.isFinite(savedAt) ||
      !parsed.value?.generatedAt
    ) {
      return null;
    }
    delete parsed.value.freshness;
    return { savedAt, value: parsed.value };
  } catch {
    return null;
  }
}

async function writeSnapshot(
  range: { since: string; until: string },
  value: DebriefPayload,
): Promise<void> {
  await mkdir(snapshotDirectory, { recursive: true });
  const path = snapshotPath(range);
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const snapshot: DebriefSnapshot = {
    version: 1,
    savedAt: new Date().toISOString(),
    range,
    value,
  };
  await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
}

function withFreshness(
  value: DebriefPayload,
  source: "live" | "memory" | "disk",
  refreshing: boolean,
  expiresAt: number,
): DebriefPayload {
  return {
    ...value,
    freshness: {
      source,
      refreshing,
      expiresAt: new Date(expiresAt).toISOString(),
    },
  };
}

async function refreshDebrief(
  range: { since: string; until: string },
): Promise<DebriefPayload> {
  const key = debriefKey(range);
  const pending = inflight.get(key);
  if (pending) return pending;
  const promise = buildDebrief(range)
    .then(async (value) => {
      const expiresAt = Date.now() + CACHE_TTL_MS;
      cache.set(key, { expiresAt, value });
      await writeSnapshot(range, value);
      return value;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

export async function refreshDebriefPayload(range: {
  since: string;
  until: string;
}): Promise<DebriefPayload> {
  const value = await refreshDebrief(range);
  return withFreshness(
    value,
    "live",
    false,
    cache.get(debriefKey(range))?.expiresAt ?? Date.now() + CACHE_TTL_MS,
  );
}

export async function buildDebriefPayload(
  range: { since: string; until: string },
  force = false,
): Promise<DebriefPayload> {
  const key = debriefKey(range);
  let source: "memory" | "disk" = "memory";
  let cached = cache.get(key);
  if (!cached) {
    const snapshot = await readSnapshot(range);
    if (snapshot) {
      source = "disk";
      cached = {
        expiresAt: snapshot.savedAt + CACHE_TTL_MS,
        value: snapshot.value,
      };
      cache.set(key, cached);
    }
  }

  if (cached) {
    const stale = cached.expiresAt <= Date.now();
    const refreshing = force || stale || inflight.has(key);
    if (force || stale) {
      void refreshDebrief(range).catch((error: unknown) => {
        process.stderr.write(
          `Debrief background refresh failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      });
    }
    return withFreshness(
      cached.value,
      source,
      refreshing,
      cached.expiresAt,
    );
  }

  const value = await refreshDebrief(range);
  return withFreshness(
    value,
    "live",
    false,
    cache.get(key)?.expiresAt ?? Date.now() + CACHE_TTL_MS,
  );
}
