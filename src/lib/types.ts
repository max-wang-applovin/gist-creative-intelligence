export type CreativeTags = {
  valueProp?: string;
  message?: string;
  hook?: string;
  visualTreatment?: string;
  format?: "video" | "static" | "carousel" | "unknown";
  creator?: string;
  campaign?: string;
};

export type CreativeRow = {
  adId: string;
  adName: string;
  campaigns: string[];
  spend: number;
  metaInstalls: number;
  installs: number;
  d1: number;
  d3: number;
  d7: number;
  d1Rate: number | null;
  d3Rate: number | null;
  d7Rate: number | null;
  costPerD3: number | null;
  costPerD7: number | null;
  thumbnailUrl?: string | null;
  previewUrl?: string | null;
  tags: CreativeTags;
  tagSource: "ai" | "human" | "parsed" | "none";
};

export type PerformancePayload = {
  source: "live" | "mock";
  since: string;
  until: string;
  account: {
    spend: number;
    metaInstalls: number;
    installs: number;
    d1: number;
    d3: number;
    d7: number;
    unmatchedInstalls: number;
  };
  creatives: CreativeRow[];
  note?: string;
};
