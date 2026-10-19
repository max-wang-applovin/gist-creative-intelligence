import type { DateRange } from "./types.js";

type ActionValue = { action_type?: string; value?: string };

type GraphVideoRow = {
  ad_id?: string;
  impressions?: string;
  actions?: ActionValue[];
  action_values?: ActionValue[];
  outbound_clicks?: ActionValue[];
  outbound_clicks_ctr?: ActionValue[];
  video_play_actions?: ActionValue[];
  video_continuous_2_sec_watched_actions?: ActionValue[];
  video_30_sec_watched_actions?: ActionValue[];
  video_thruplay_watched_actions?: ActionValue[];
  video_avg_time_watched_actions?: ActionValue[];
  video_p25_watched_actions?: ActionValue[];
  video_p50_watched_actions?: ActionValue[];
  video_p75_watched_actions?: ActionValue[];
  video_p100_watched_actions?: ActionValue[];
};

type GraphPage = {
  data?: GraphVideoRow[];
  paging?: { next?: string };
};

export type MetaAdVideoMetrics = {
  adId: string;
  impressions: number;
  videoStarts: number;
  twoSecondViews: number;
  threeSecondViews: number;
  thirtySecondViews: number;
  thruPlays: number;
  p25: number;
  p50: number;
  p75: number;
  p100: number;
  avgWatchSeconds: number;
  linkClicks: number;
  outboundClicks: number;
  outboundCtr: number;
  landingPageViews: number;
  leads: number;
  purchases: number;
  purchaseValue: number;
};

function num(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function actionValue(
  values: ActionValue[] | undefined,
  actionType = "video_view",
): number {
  return num(
    values?.find((value) => value.action_type === actionType)?.value ??
      values?.[0]?.value,
  );
}

function firstActionValue(
  values: ActionValue[] | undefined,
  actionTypes: string[],
): number {
  for (const actionType of actionTypes) {
    const hit = values?.find((value) => value.action_type === actionType);
    if (hit) return num(hit.value);
  }
  return 0;
}

function accountId(): string {
  const raw = process.env.META_AD_ACCOUNT_ID?.trim();
  if (!raw) throw new Error("META_AD_ACCOUNT_ID is required for video metrics.");
  return raw.startsWith("act_") ? raw : `act_${raw}`;
}

function token(): string {
  const value = process.env.META_ACCESS_TOKEN?.trim();
  if (!value) throw new Error("META_ACCESS_TOKEN is required for video metrics.");
  return value;
}

/** Fetch raw ad-level Meta video funnel metrics without collapsing the detail. */
export async function fetchMetaVideoMetrics(
  range: DateRange,
  adIds: string[],
): Promise<Record<string, MetaAdVideoMetrics>> {
  const ids = [...new Set(adIds.filter((id) => /^\d+$/.test(id)))];
  if (ids.length === 0) return {};

  const url = new URL(
    `https://graph.facebook.com/v21.0/${accountId()}/insights`,
  );
  url.searchParams.set("level", "ad");
  url.searchParams.set(
    "fields",
    [
      "ad_id",
      "impressions",
      "actions",
      "action_values",
      "outbound_clicks",
      "outbound_clicks_ctr",
      "video_play_actions",
      "video_continuous_2_sec_watched_actions",
      "video_30_sec_watched_actions",
      "video_thruplay_watched_actions",
      "video_avg_time_watched_actions",
      "video_p25_watched_actions",
      "video_p50_watched_actions",
      "video_p75_watched_actions",
      "video_p100_watched_actions",
    ].join(","),
  );
  url.searchParams.set("time_range", JSON.stringify(range));
  url.searchParams.set(
    "filtering",
    JSON.stringify([{ field: "ad.id", operator: "IN", value: ids }]),
  );
  url.searchParams.set("limit", "500");
  url.searchParams.set("access_token", token());

  const result: Record<string, MetaAdVideoMetrics> = {};
  let next: string | undefined = url.toString();
  let pages = 0;
  while (next && pages < 50) {
    pages += 1;
    const response = await fetch(next);
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Meta video metrics ${response.status}: ${body.slice(0, 300)}`);
    }
    const payload = (await response.json()) as GraphPage;
    for (const row of payload.data ?? []) {
      const adId = row.ad_id;
      if (!adId) continue;
      result[adId] = {
        adId,
        impressions: num(row.impressions),
        videoStarts: actionValue(row.video_play_actions),
        twoSecondViews: actionValue(
          row.video_continuous_2_sec_watched_actions,
        ),
        // Meta actions.video_view is the 3-second video-view action.
        threeSecondViews: actionValue(row.actions),
        thirtySecondViews: actionValue(row.video_30_sec_watched_actions),
        thruPlays: actionValue(row.video_thruplay_watched_actions),
        p25: actionValue(row.video_p25_watched_actions),
        p50: actionValue(row.video_p50_watched_actions),
        p75: actionValue(row.video_p75_watched_actions),
        p100: actionValue(row.video_p100_watched_actions),
        avgWatchSeconds: actionValue(row.video_avg_time_watched_actions),
        linkClicks: firstActionValue(row.actions, ["link_click"]),
        outboundClicks: firstActionValue(row.outbound_clicks, [
          "outbound_click",
        ]),
        outboundCtr: firstActionValue(row.outbound_clicks_ctr, [
          "outbound_click",
        ]),
        landingPageViews: firstActionValue(row.actions, [
          "landing_page_view",
          "omni_landing_page_view",
        ]),
        leads: firstActionValue(row.actions, [
          "lead",
          "onsite_web_lead",
          "offsite_conversion.fb_pixel_lead",
        ]),
        purchases: firstActionValue(row.actions, [
          "purchase",
          "omni_purchase",
          "offsite_conversion.fb_pixel_purchase",
        ]),
        purchaseValue: firstActionValue(row.action_values, [
          "purchase",
          "omni_purchase",
          "offsite_conversion.fb_pixel_purchase",
        ]),
      };
    }
    next = payload.paging?.next;
  }
  return result;
}
