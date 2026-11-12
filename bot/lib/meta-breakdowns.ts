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
  date_start?: string;
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

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

/** Read ad-level Meta delivery split by one supported audience dimension. */
export async function fetchMetaDeliveryBreakdown(
  range: DateRange,
  dimension: MetaBreakdownDimension,
  adIds: string[] = [],
): Promise<MetaBreakdownRow[]> {
  const ids = [...new Set(adIds.filter((id) => /^\d+$/.test(id)))];
  if (adIds.length > 0 && ids.length === 0) return [];
  const batches: Array<string[] | undefined> =
    ids.length > 0 ? chunks(ids, 200) : [undefined];
  const raw: GraphBreakdownRow[] = [];
  for (const batch of batches) {
    const url = new URL(
      `https://graph.facebook.com/v21.0/${accountId()}/insights`,
    );
    url.searchParams.set("level", "ad");
    url.searchParams.set("fields", "ad_id,spend,impressions,clicks");
    url.searchParams.set("breakdowns", breakdowns(dimension));
    url.searchParams.set("time_range", JSON.stringify(range));
    if (batch) {
      url.searchParams.set(
        "filtering",
        JSON.stringify([{ field: "ad.id", operator: "IN", value: batch }]),
      );
    }
    url.searchParams.set("limit", "500");
    url.searchParams.set("access_token", token());

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
    if (next) {
      throw new Error(
        `Meta ${dimension} breakdown exceeded 50 pages for one ad batch.`,
      );
    }
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
export async function fetchMetaDailyTrends(
  range: DateRange,
  adIds: string[],
): Promise<Record<string, MetaDailyPoint[]>> {
  const ids = [...new Set(adIds.filter((id) => /^\d+$/.test(id)))];
  if (ids.length === 0) return {};
  const byAdDate = new Map<
    string,
    { spend: number; impressions: number; clicks: number }
  >();
  for (const batch of chunks(ids, 200)) {
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
      JSON.stringify([{ field: "ad.id", operator: "IN", value: batch }]),
    );
    url.searchParams.set("limit", "500");
    url.searchParams.set("access_token", token());

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
        const adId = row.ad_id;
        const date = row.date_start;
        if (!adId || !date) continue;
        const key = `${adId}:${date}`;
        const existing = byAdDate.get(key) ?? {
          spend: 0,
          impressions: 0,
          clicks: 0,
        };
        existing.spend += num(row.spend);
        existing.impressions += num(row.impressions);
        existing.clicks += num(row.clicks);
        byAdDate.set(key, existing);
      }
      next = payload.paging?.next;
    }
    if (next) {
      throw new Error(
        "Meta daily trend exceeded 50 pages for one ad batch.",
      );
    }
  }

  const result: Record<string, MetaDailyPoint[]> = {};
  for (const [key, metrics] of byAdDate) {
    const separator = key.indexOf(":");
    const adId = key.slice(0, separator);
    const date = key.slice(separator + 1);
    (result[adId] ??= []).push({
      date,
      spend: Math.round(metrics.spend * 100) / 100,
      impressions: metrics.impressions,
      clicks: metrics.clicks,
    });
  }
  for (const points of Object.values(result)) {
    points.sort((a, b) => a.date.localeCompare(b.date));
  }
  return result;
}

export async function fetchMetaDailyTrend(
  range: DateRange,
  adIds: string[],
): Promise<MetaDailyPoint[]> {
  const byAd = await fetchMetaDailyTrends(range, adIds);
  const byDate = new Map<
    string,
    { spend: number; impressions: number; clicks: number }
  >();
  for (const point of Object.values(byAd).flat()) {
    const existing = byDate.get(point.date) ?? {
      spend: 0,
      impressions: 0,
      clicks: 0,
    };
    existing.spend += point.spend;
    existing.impressions += point.impressions;
    existing.clicks += point.clicks;
    byDate.set(point.date, existing);
  }
  return [...byDate.entries()]
    .map(([date, metrics]) => ({
      date,
      ...metrics,
      spend: Math.round(metrics.spend * 100) / 100,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}
