import { joinMetaAdjust } from "./join";
import type { PerformancePayload } from "./types";

export function mockPerformance(since: string, until: string): PerformancePayload {
  const meta = [
    {
      ad_id: "120254152856330120",
      ad_name: "260928_AMB_General_Janelle_ThisAppPaysYouToBe",
      campaign_name: "2607_WEB_UA_iOS_US_Leads_CBO on_Testing",
      spend: 4200,
      leads: 180,
    },
    {
      ad_id: "120253747046220120",
      ad_name: "260915_CR_TravelGems_Christina_HiddenBeachWalk",
      campaign_name: "2606_WEB_UA_iOS_US_Leads_CBO on",
      spend: 3100,
      leads: 140,
    },
    {
      ad_id: "120254341832470120",
      ad_name: "260910_IH_General_None_CompetitionOnceUponaGist",
      campaign_name: "2606_WEB_UA_iOS_US_Leads_CBO on",
      spend: 8900,
      leads: 410,
    },
  ];
  const adjust = [
    {
      creativeIdNetwork: "120254152856330120",
      partnerName: "Facebook",
      installs: 128,
      d1: 35,
      d3: 22,
      d7: 14,
    },
    {
      creativeIdNetwork: "120253747046220120",
      partnerName: "Facebook",
      installs: 96,
      d1: 34,
      d3: 20,
      d7: 12,
    },
    {
      creativeIdNetwork: "120254341832470120",
      partnerName: "Facebook",
      installs: 300,
      d1: 72,
      d3: 48,
      d7: 30,
    },
    {
      creativeIdNetwork: "missing-ad",
      partnerName: "Facebook",
      installs: 12,
      d1: 2,
      d3: 1,
      d7: 0,
    },
  ];
  return joinMetaAdjust(meta, adjust, since, until, {
    source: "mock",
    previews: {
      "120254152856330120": {
        thumbnailUrl:
          "https://images.unsplash.com/photo-1611162616305-c69b3fa7fbe0?w=400&h=500&fit=crop",
        previewUrl: null,
      },
      "120253747046220120": {
        thumbnailUrl:
          "https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=400&h=500&fit=crop",
        previewUrl: null,
      },
      "120254341832470120": {
        thumbnailUrl:
          "https://images.unsplash.com/photo-1523474253046-8cd2748b5fd2?w=400&h=500&fit=crop",
        previewUrl: null,
      },
    },
    note: "Mock data. Set META_ACCESS_TOKEN and ADJUST_API_TOKEN in .env.local for live Meta + Adjust.",
  });
}
