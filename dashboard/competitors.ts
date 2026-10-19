export type CompetitorCreative = {
  brand: string;
  pageName: string;
  adArchiveId: string;
  reportedViews: number;
  displayFormat: string;
  body: string;
  headline: string;
  ctaText: string;
  destinationUrl: string | null;
  startDate: string | null;
  endDate: string | null;
  platforms: string[];
  media: Array<{
    type: "video" | "image" | "unknown";
    url: string | null;
    thumbnailUrl: string | null;
  }>;
  libraryUrl: string;
};

type BrandConfig = {
  brand: string;
  search: string;
  pageMatches: RegExp[];
};

const adjacentBrands: BrandConfig[] = [
  {
    brand: "TikTok",
    search: "TikTok",
    pageMatches: [/^TikTok(?:\s*-\s*.+)?$/i],
  },
  {
    brand: "LinkedIn",
    search: "LinkedIn",
    pageMatches: [/^LinkedIn$/i],
  },
  {
    brand: "Pinterest",
    search: "Pinterest",
    pageMatches: [/^Pinterest$/i],
  },
  {
    brand: "Reddit",
    search: "Reddit",
    pageMatches: [/^Reddit$/i, /^Reddit for Business$/i],
  },
  {
    brand: "Instagram",
    search: "Instagram",
    pageMatches: [/^Instagram$/i],
  },
];

type AdScanAd = {
  adArchiveId?: string;
  pageName?: string;
  displayFormat?: string;
  startDate?: string;
  endDate?: string;
  body?: string;
  ctaText?: string;
  linkUrl?: string;
  copy?: {
    body?: string;
    headline?: string;
    title?: string;
    ctaText?: string;
    linkUrl?: string;
  };
  metrics?: {
    views?: number;
    reach?: number;
    publisherPlatforms?: string[];
  };
  media?: Array<{
    type?: string;
    url?: string;
    thumbnailUrl?: string;
  }>;
};

async function searchBrand(config: BrandConfig): Promise<CompetitorCreative[]> {
  const apiKey = process.env.ADMANAGE_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("ADMANAGE_API_KEY is required for competitor inspiration.");
  }
  const response = await fetch(
    "https://api.admanage.ai/v1/adscan/ad-library/search",
    {
      method: "POST",
      signal: AbortSignal.timeout(120_000),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        keyword: config.search,
        country: "GB",
        active_status: "active",
        media_type: "all",
        search_type: "keyword_exact_phrase",
        limit: 30,
        includeViews: true,
        includeRaw: false,
      }),
    },
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `AdScan ${config.brand} ${response.status}: ${body.slice(0, 300)}`,
    );
  }
  const payload = (await response.json()) as {
    ok?: boolean;
    ads?: AdScanAd[];
  };
  if (payload.ok !== true) return [];

  return (payload.ads ?? [])
    .filter((ad) =>
      config.pageMatches.some((pattern) => pattern.test(ad.pageName ?? "")),
    )
    .map((ad) => {
      const adArchiveId = ad.adArchiveId ?? "";
      return {
        brand: config.brand,
        pageName: ad.pageName ?? config.brand,
        adArchiveId,
        reportedViews: Number(ad.metrics?.views ?? ad.metrics?.reach ?? 0),
        displayFormat: ad.displayFormat ?? "UNKNOWN",
        body: ad.copy?.body ?? ad.body ?? "",
        headline: ad.copy?.headline ?? ad.copy?.title ?? "",
        ctaText: ad.copy?.ctaText ?? ad.ctaText ?? "",
        destinationUrl: ad.copy?.linkUrl ?? ad.linkUrl ?? null,
        startDate: ad.startDate ?? null,
        endDate: ad.endDate ?? null,
        platforms: ad.metrics?.publisherPlatforms ?? [],
        media: (ad.media ?? []).map((media) => ({
          type:
            media.type === "video"
              ? ("video" as const)
              : media.type === "image"
                ? ("image" as const)
                : ("unknown" as const),
          url: media.url ?? null,
          thumbnailUrl: media.thumbnailUrl ?? null,
        })),
        libraryUrl: adArchiveId
          ? `https://www.facebook.com/ads/library/?id=${encodeURIComponent(adArchiveId)}`
          : "https://www.facebook.com/ads/library/",
      };
    })
    .filter((ad) => ad.reportedViews > 0)
    .sort((a, b) => b.reportedViews - a.reportedViews);
}

export async function fetchAdjacentCompetitorCreatives(): Promise<{
  generatedAt: string;
  country: "GB";
  metric: "reported_views";
  disclosure: string;
  brands: string[];
  creatives: CompetitorCreative[];
  errors: string[];
}> {
  const creatives: CompetitorCreative[] = [];
  const errors: string[] = [];
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < adjacentBrands.length) {
      const brand = adjacentBrands[cursor++]!;
      try {
        creatives.push(...(await searchBrand(brand)).slice(0, 10));
      } catch (error) {
        errors.push(
          `${brand.brand}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  creatives.sort((a, b) => b.reportedViews - a.reportedViews);
  return {
    generatedAt: new Date().toISOString(),
    country: "GB",
    metric: "reported_views",
    disclosure:
      "Ranked by public Meta transparency views/reach for active GB ads. Exact commercial impressions are not published; reported views are the closest factual public signal.",
    brands: adjacentBrands.map((brand) => brand.brand),
    creatives,
    errors,
  };
}
