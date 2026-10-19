import type { DateRange } from "./types.js";

export type MetaBreakdownDimension =
  | "demographic"
  | "publisher"
  | "device"
  | "os";

export type MetaBreakdownRow = {
  adId: string;
  spend: number;
  impressions: number;
  clicks: number;
  age?: string;
  gender?: string;
  publisher?: string;
  device?: string;
  operatingSystem?: string;
};

export type MetaDailyPoint = {
  date: string;
  spend: number;
  impressions: number;
  clicks: number;
};

type GraphBreakdownRow = {
  ad_id?: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  age?: string;
  gender?: string;
  publisher_platform?: string;
  device_platform?: string;
  impression_device?: string;
};

type GraphPage = {
  data?: GraphBreakdownRow[];
  paging?: { next?: string };
};

function num(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function accountId(): string {
  const raw = process.env.META_AD_ACCOUNT_ID?.trim();
  if (!raw) throw new Error("META_AD_ACCOUNT_ID is required for Meta slices.");
  return raw.startsWith("act_") ? raw : `act_${raw}`;
}

function token(): string {
  const value = process.env.META_ACCESS_TOKEN?.trim();
  if (!value) throw new Error("META_ACCESS_TOKEN is required for Meta slices.");
  return value;
}

function breakdowns(dimension: MetaBreakdownDimension): string {
  if (dimension === "demographic") return "age,gender";
  if (dimension === "publisher") return "publisher_platform";
  if (dimension === "os") return "impression_device";
  return "device_platform";
}

function operatingSystem(impressionDevice: string | undefined): string {
  const device = impressionDevice?.toLowerCase() ?? "";
  if (device.includes("android")) return "android";
  if (["iphone", "ipad", "ipod"].some((value) => device.includes(value))) {
    return "ios";
  }
  return "other";
}

/** Read ad-level Meta delivery split by one supported audience dimension. */
export async function fetchMetaDeliveryBreakdown(
  range: DateRange,
  dimension: MetaBreakdownDimension,
): Promise<MetaBreakdownRow[]> {
  const url = new URL(
    `https://graph.facebook.com/v21.0/${accountId()}/insights`,
  );
  url.searchParams.set("level", "ad");
  url.searchParams.set("fields", "ad_id,spend,impressions,clicks");
  url.searchParams.set("breakdowns", breakdowns(dimension));
  url.searchParams.set("time_range", JSON.stringify(range));
  url.searchParams.set("limit", "500");
  url.searchParams.set("access_token", token());

  const raw: GraphBreakdownRow[] = [];
  let next: string | undefined = url.toString();
  let pages = 0;
  while (next && pages < 50) {
    pages += 1;
    const response = await fetch(next);
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Meta ${dimension} breakdown ${response.status}: ${body.slice(0, 300)}`,
      );
    }
    const payload = (await response.json()) as GraphPage;
    raw.push(...(payload.data ?? []));
    next = payload.paging?.next;
  }

  return raw
    .filter((row) => /^\d+$/.test(row.ad_id ?? ""))
    .map((row) => ({
      adId: row.ad_id!,
      spend: num(row.spend),
      impressions: num(row.impressions),
      clicks: num(row.clicks),
      ...(dimension === "demographic"
        ? {
            age: row.age ?? "unknown",
            gender: row.gender ?? "unknown",
          }
        : dimension === "publisher"
          ? { publisher: row.publisher_platform ?? "unknown" }
          : dimension === "os"
            ? { operatingSystem: operatingSystem(row.impression_device) }
            : { device: row.device_platform ?? "unknown" }),
    }));
}

/** Fetch and aggregate daily Meta delivery for one creative's constituent ads. */
export async function fetchMetaDailyTrend(
  range: DateRange,
  adIds: string[],
): Promise<MetaDailyPoint[]> {
  const ids = [...new Set(adIds.filter((id) => /^\d+$/.test(id)))];
  if (ids.length === 0) return [];

  const url = new URL(
    `https://graph.facebook.com/v21.0/${accountId()}/insights`,
  );
  url.searchParams.set("level", "ad");
  url.searchParams.set(
    "fields",
    "ad_id,date_start,spend,impressions,clicks",
  );
  url.searchParams.set("time_increment", "1");
  url.searchParams.set("time_range", JSON.stringify(range));
  url.searchParams.set(
    "filtering",
    JSON.stringify([{ field: "ad.id", operator: "IN", value: ids }]),
  );
  url.searchParams.set("limit", "500");
  url.searchParams.set("access_token", token());

  const byDate = new Map<
    string,
    { spend: number; impressions: number; clicks: number }
  >();
  let next: string | undefined = url.toString();
  let pages = 0;
  while (next && pages < 50) {
    pages += 1;
    const response = await fetch(next);
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Meta daily trend ${response.status}: ${body.slice(0, 300)}`,
      );
    }
    const payload = (await response.json()) as GraphPage;
    for (const row of payload.data ?? []) {
      const date = (row as GraphBreakdownRow & { date_start?: string })
        .date_start;
      if (!date) continue;
      const existing = byDate.get(date) ?? {
        spend: 0,
        impressions: 0,
        clicks: 0,
      };
      existing.spend += num(row.spend);
      existing.impressions += num(row.impressions);
      existing.clicks += num(row.clicks);
      byDate.set(date, existing);
    }
    next = payload.paging?.next;
  }

  return [...byDate.entries()]
    .map(([date, metrics]) => ({
      date,
      spend: Math.round(metrics.spend * 100) / 100,
      impressions: metrics.impressions,
      clicks: metrics.clicks,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}
