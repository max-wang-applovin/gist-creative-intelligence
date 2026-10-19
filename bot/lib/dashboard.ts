import { normalizeCreativeName } from "./names.js";
import type {
  AdjustCreativeRow,
  DashboardCreative,
  MetaCreativeInsight,
} from "./types.js";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Join Meta + Adjust on normalized creative name.
 * Rank by Meta spend (Gist helper convention).
 */
export function buildCreativeDashboard(
  metaRows: MetaCreativeInsight[],
  adjustRows: AdjustCreativeRow[],
  limit: number,
): DashboardCreative[] {
  const adjustByName = new Map(
    adjustRows.map((row) => [normalizeCreativeName(row.creativeName), row]),
  );
  const seen = new Set<string>();
  const joined: DashboardCreative[] = [];

  for (const meta of metaRows) {
    const key = normalizeCreativeName(meta.creativeName);
    seen.add(key);
    const adjust = adjustByName.get(key);
    const installs = adjust?.installs ?? 0;
    const clicks = meta.clicks;
    const cvr = clicks > 0 ? (installs / clicks) * 100 : 0;
    const cpi = installs > 0 ? meta.spend / installs : 0;
    joined.push({
      creativeId: key,
      creativeName: meta.creativeName,
      adIds: [],
      metaCreativeNames: [meta.creativeName],
      adCount: meta.adCount,
      metaSpend: meta.spend,
      metaImpressions: meta.impressions,
      metaClicks: clicks,
      metaCtr: meta.ctr,
      metaCpc: meta.cpc,
      metaCpm: meta.cpm,
      metaFrequency: meta.frequency,
      adjustInstalls: installs,
      adjustRevenue: adjust?.revenue ?? 0,
      adjustRoas: adjust?.roas ?? 0,
      cvr: round2(cvr),
      cpi: round2(cpi),
      adjustRetentionD1: adjust?.retentionD1 ?? 0,
      adjustRetentionD3: adjust?.retentionD3 ?? 0,
      adjustRetentionD7: adjust?.retentionD7 ?? 0,
      adjustRetainedD1: adjust?.retainedD1 ?? 0,
      adjustRetainedD3: adjust?.retainedD3 ?? 0,
      adjustRetainedD7: adjust?.retainedD7 ?? 0,
      adjustRetentionDenD1: adjust?.retentionDenD1 ?? 0,
      adjustRetentionDenD3: adjust?.retentionDenD3 ?? 0,
      adjustRetentionDenD7: adjust?.retentionDenD7 ?? 0,
    });
  }

  for (const adjust of adjustRows) {
    const key = normalizeCreativeName(adjust.creativeName);
    if (seen.has(key)) continue;
    joined.push({
      creativeId: key,
      creativeName: adjust.creativeName,
      adIds: adjust.adIds,
      metaCreativeNames: adjust.metaCreativeNames,
      adCount: 0,
      metaSpend: 0,
      metaImpressions: 0,
      metaClicks: 0,
      metaCtr: 0,
      metaCpc: 0,
      metaCpm: 0,
      metaFrequency: 0,
      adjustInstalls: adjust.installs,
      adjustRevenue: adjust.revenue,
      adjustRoas: adjust.roas,
      cvr: 0,
      cpi: 0,
      adjustRetentionD1: adjust.retentionD1,
      adjustRetentionD3: adjust.retentionD3,
      adjustRetentionD7: adjust.retentionD7,
      adjustRetainedD1: adjust.retainedD1,
      adjustRetainedD3: adjust.retainedD3,
      adjustRetainedD7: adjust.retainedD7,
      adjustRetentionDenD1: adjust.retentionDenD1,
      adjustRetentionDenD3: adjust.retentionDenD3,
      adjustRetentionDenD7: adjust.retentionDenD7,
    });
  }

  return joined
    .sort((a, b) => b.metaSpend - a.metaSpend || b.adjustInstalls - a.adjustInstalls)
    .slice(0, limit);
}

/**
 * Gist-helper-compatible board built from Adjust Report Service:
 * - display/group by cleaned historical Adjust creative label
 * - Meta/Facebook partner rows only
 * - spend = network_cost
 */
export function buildHelperCompatibleDashboard(
  rows: AdjustCreativeRow[],
  limit: number,
): DashboardCreative[] {
  return rows
    .map((row) => {
      const ctr =
        row.impressions > 0 ? (row.clicks / row.impressions) * 100 : 0;
      const cpc = row.clicks > 0 ? row.spend / row.clicks : 0;
      const cpm =
        row.impressions > 0 ? (row.spend / row.impressions) * 1000 : 0;
      const cvr = row.clicks > 0 ? (row.installs / row.clicks) * 100 : 0;
      const cpi = row.installs > 0 ? row.spend / row.installs : 0;
      return {
        creativeId: row.creativeId,
        creativeName: row.creativeName,
        adIds: row.adIds,
        metaCreativeNames: row.metaCreativeNames,
        adCount: row.adCount,
        metaSpend: row.spend,
        metaImpressions: row.impressions,
        metaClicks: row.clicks,
        metaCtr: round2(ctr),
        metaCpc: round2(cpc),
        metaCpm: round2(cpm),
        // Adjust Report Service does not expose Meta reach for this grouping.
        metaFrequency: 0,
        adjustInstalls: row.installs,
        adjustRevenue: row.revenue,
        adjustRoas: row.roas,
        cvr: round2(cvr),
        cpi: round2(cpi),
        adjustRetentionD1: row.retentionD1,
        adjustRetentionD3: row.retentionD3,
        adjustRetentionD7: row.retentionD7,
        adjustRetainedD1: row.retainedD1,
        adjustRetainedD3: row.retainedD3,
        adjustRetainedD7: row.retainedD7,
        adjustRetentionDenD1: row.retentionDenD1,
        adjustRetentionDenD3: row.retentionDenD3,
        adjustRetentionDenD7: row.retentionDenD7,
      };
    })
    .sort(
      (a, b) =>
        b.metaSpend - a.metaSpend || b.adjustInstalls - a.adjustInstalls,
    )
    .slice(0, limit);
}

export function summarizeBoard(board: DashboardCreative[]): {
  spend: number;
  impressions: number;
  clicks: number;
  installs: number;
  cpc: number;
  cpm: number;
  ctr: number;
  cvr: number;
  cpi: number;
} {
  const spend = board.reduce((s, r) => s + r.metaSpend, 0);
  const impressions = board.reduce((s, r) => s + r.metaImpressions, 0);
  const clicks = board.reduce((s, r) => s + r.metaClicks, 0);
  const installs = board.reduce((s, r) => s + r.adjustInstalls, 0);
  return {
    spend: round2(spend),
    impressions,
    clicks,
    installs,
    cpc: round2(clicks > 0 ? spend / clicks : 0),
    cpm: round2(impressions > 0 ? (spend / impressions) * 1000 : 0),
    ctr: round2(impressions > 0 ? (clicks / impressions) * 100 : 0),
    cvr: round2(clicks > 0 ? (installs / clicks) * 100 : 0),
    cpi: round2(installs > 0 ? spend / installs : 0),
  };
}
