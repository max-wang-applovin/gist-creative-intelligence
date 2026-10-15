import type { AdjustCreativeRow } from "./adjust";
import type { MetaInsightRow } from "./meta";
import { tagsFromAdName } from "./naming";
import type { CreativeRow, PerformancePayload } from "./types";
import { loadTagOverrides } from "./tags-store";

function rate(num: number, den: number): number | null {
  if (!den) return null;
  return num / den;
}

function cost(spend: number, users: number): number | null {
  if (!users) return null;
  return spend / users;
}

/** Default window: 14 days ending 8 days ago so D7 is mature (Cathy's rule). */
export function defaultWindow(today = new Date()): { since: string; until: string } {
  const utc = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
  );
  const until = new Date(utc);
  until.setUTCDate(until.getUTCDate() - 8);
  const since = new Date(until);
  since.setUTCDate(since.getUTCDate() - 13);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { since: iso(since), until: iso(until) };
}

export function joinMetaAdjust(
  metaRows: MetaInsightRow[],
  adjustRows: AdjustCreativeRow[],
  since: string,
  until: string,
  opts?: {
    source?: "live" | "mock";
    previews?: Record<
      string,
      { thumbnailUrl: string | null; previewUrl: string | null }
    >;
    note?: string;
  },
): PerformancePayload {
  const adj = new Map<string, { installs: number; d1: number; d3: number; d7: number }>();
  const fbTotals = { installs: 0, d1: 0, d3: 0, d7: 0 };
  for (const r of adjustRows) {
    if (r.partnerName !== "Facebook") continue;
    fbTotals.installs += r.installs;
    fbTotals.d1 += r.d1;
    fbTotals.d3 += r.d3;
    fbTotals.d7 += r.d7;
    const cur = adj.get(r.creativeIdNetwork) || {
      installs: 0,
      d1: 0,
      d3: 0,
      d7: 0,
    };
    cur.installs += r.installs;
    cur.d1 += r.d1;
    cur.d3 += r.d3;
    cur.d7 += r.d7;
    adj.set(r.creativeIdNetwork, cur);
  }

  const perAd = new Map<string, MetaInsightRow & { leads: number }>();
  for (const r of metaRows) {
    const prev = perAd.get(r.ad_id);
    if (!prev) {
      perAd.set(r.ad_id, { ...r });
    } else {
      prev.spend += r.spend;
      prev.leads += r.leads;
    }
  }

  const unmatchedInstalls = [...adj.entries()]
    .filter(([id]) => id && !perAd.has(id))
    .reduce((s, [, v]) => s + v.installs, 0);

  const byName = new Map<string, Array<MetaInsightRow & { leads: number }>>();
  for (const r of perAd.values()) {
    const list = byName.get(r.ad_name) || [];
    list.push(r);
    byName.set(r.ad_name, list);
  }

  const overrides = loadTagOverrides();
  const creatives: CreativeRow[] = [...byName.entries()]
    .map(([name, ads]) => {
      const spend = ads.reduce((s, a) => s + a.spend, 0);
      const metaInstalls = ads.reduce((s, a) => s + a.leads, 0);
      const metrics = ads.reduce(
        (acc, a) => {
          const m = adj.get(a.ad_id);
          if (!m) return acc;
          acc.installs += m.installs;
          acc.d1 += m.d1;
          acc.d3 += m.d3;
          acc.d7 += m.d7;
          return acc;
        },
        { installs: 0, d1: 0, d3: 0, d7: 0 },
      );
      const primaryId = [...ads].sort((a, b) => b.spend - a.spend)[0].ad_id;
      const parsed = tagsFromAdName(name);
      const human = overrides[primaryId] || overrides[name];
      const tags = { ...parsed, ...human };
      const tagSource = human
        ? ("human" as const)
        : parsed.hook
          ? ("parsed" as const)
          : ("none" as const);
      const preview = opts?.previews?.[primaryId];
      return {
        adId: primaryId,
        adName: name,
        campaigns: [...new Set(ads.map((a) => a.campaign_name))].sort(),
        spend: Math.round(spend * 100) / 100,
        metaInstalls,
        installs: metrics.installs,
        d1: metrics.d1,
        d3: metrics.d3,
        d7: metrics.d7,
        d1Rate: rate(metrics.d1, metrics.installs),
        d3Rate: rate(metrics.d3, metrics.installs),
        d7Rate: rate(metrics.d7, metrics.installs),
        costPerD3: cost(spend, metrics.d3),
        costPerD7: cost(spend, metrics.d7),
        thumbnailUrl: preview?.thumbnailUrl ?? null,
        previewUrl: preview?.previewUrl ?? null,
        tags,
        tagSource,
      };
    })
    .sort((a, b) => b.spend - a.spend);

  const totalSpend = [...perAd.values()].reduce((s, r) => s + r.spend, 0);
  const totalMetaInstalls = [...perAd.values()].reduce(
    (s, r) => s + r.leads,
    0,
  );

  return {
    source: opts?.source || "live",
    since,
    until,
    account: {
      spend: Math.round(totalSpend * 100) / 100,
      metaInstalls: totalMetaInstalls,
      installs: fbTotals.installs,
      d1: fbTotals.d1,
      d3: fbTotals.d3,
      d7: fbTotals.d7,
      unmatchedInstalls,
    },
    creatives,
    note: opts?.note,
  };
}
