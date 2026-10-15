import { ADJUST_REPORT_URL } from "./config";

export const ADJUST_METRICS = [
  "installs",
  "retained_users_d1",
  "retained_users_d3",
  "retained_users_d7",
] as const;

export type AdjustMetric = (typeof ADJUST_METRICS)[number];

export type AdjustCreativeRow = {
  creativeIdNetwork: string;
  partnerName: string;
  installs: number;
  d1: number;
  d3: number;
  d7: number;
};

function normPartner(name: string): string {
  const n = (name || "").trim();
  if (/tiktok/i.test(n)) return "TikTok";
  if (/reddit/i.test(n)) return "Reddit";
  if (/facebook|meta/i.test(n)) return "Facebook";
  if (/applovin/i.test(n)) return "AppLovin";
  return n;
}

export async function fetchAdjustByCreative(
  token: string,
  since: string,
  until: string,
): Promise<AdjustCreativeRow[]> {
  const url = new URL(ADJUST_REPORT_URL);
  url.searchParams.set("date_period", `${since}:${until}`);
  url.searchParams.set("dimensions", "partner_name,creative_id_network");
  url.searchParams.set("metrics", ADJUST_METRICS.join(","));

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Adjust report HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    rows?: Array<Record<string, string | number>>;
  };
  return (json.rows || []).map((r) => ({
    creativeIdNetwork: String(r.creative_id_network || ""),
    partnerName: normPartner(String(r.partner_name || "")),
    installs: Number(r.installs || 0),
    d1: Number(r.retained_users_d1 || 0),
    d3: Number(r.retained_users_d3 || 0),
    d7: Number(r.retained_users_d7 || 0),
  }));
}
