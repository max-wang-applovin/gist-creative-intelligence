export type DataSource = "live" | "fixture";

export type DateRange = {
  since: string;
  until: string;
};

export type MetaCreativeInsight = {
  creativeId: string;
  creativeName: string;
  adId: string;
  adName: string;
  campaignName: string;
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number;
  cpc: number;
  cpm: number;
  frequency: number;
  adCount: number;
};

export type AdjustCreativeRow = {
  creativeId: string;
  creativeName: string;
  adIds: string[];
  metaCreativeNames: string[];
  network: string;
  adCount: number;
  spend: number;
  impressions: number;
  clicks: number;
  installs: number;
  revenue: number;
  cost: number;
  roas: number;
  /** Retention rate as a percentage (0–100). */
  retentionD1: number;
  retentionD3: number;
  retentionD7: number;
  retainedD1: number;
  retainedD3: number;
  retainedD7: number;
  retentionDenD1: number;
  retentionDenD3: number;
  retentionDenD7: number;
};

export type DashboardCreative = {
  creativeId: string;
  creativeName: string;
  adIds: string[];
  /** Current Meta ad names represented by this Adjust historical label. */
  metaCreativeNames: string[];
  adCount: number;
  metaSpend: number;
  metaImpressions: number;
  metaClicks: number;
  metaCtr: number;
  metaCpc: number;
  metaCpm: number;
  metaFrequency: number;
  adjustInstalls: number;
  adjustRevenue: number;
  adjustRoas: number;
  cvr: number;
  cpi: number;
  adjustRetentionD1: number;
  adjustRetentionD3: number;
  adjustRetentionD7: number;
  adjustRetainedD1: number;
  adjustRetainedD3: number;
  adjustRetainedD7: number;
  adjustRetentionDenD1: number;
  adjustRetentionDenD3: number;
  adjustRetentionDenD7: number;
};
