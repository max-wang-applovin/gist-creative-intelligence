export type MetaAdMedia = {
  adId: string;
  adName: string;
  status: string;
  creativeId: string | null;
  creativeName: string | null;
  campaignId: string | null;
  campaignName: string | null;
  adSetId: string | null;
  adSetName: string | null;
  primaryText: string | null;
  headline: string | null;
  description: string | null;
  destinationUrl: string | null;
  callToActionType: string | null;
  mediaType: "video" | "image" | "unknown";
  thumbnailUrl: string | null;
  thumbnailWidth: number | null;
  thumbnailHeight: number | null;
  videoId: string | null;
  videoUrl: string | null;
  videoLengthSeconds: number | null;
};

type GraphCreative = {
  id?: string;
  name?: string;
  thumbnail_url?: string;
  image_url?: string;
  video_id?: string;
  title?: string;
  body?: string;
  link_url?: string;
  call_to_action_type?: string;
  object_story_spec?: {
    video_data?: {
      video_id?: string;
      image_url?: string;
      message?: string;
      title?: string;
      link_description?: string;
      call_to_action?: {
        value?: { link?: string };
      };
    };
    link_data?: {
      picture?: string;
      message?: string;
      name?: string;
      description?: string;
      link?: string;
      call_to_action?: {
        value?: { link?: string };
      };
    };
    photo_data?: { caption?: string };
  };
};

type GraphAd = {
  id?: string;
  name?: string;
  status?: string;
  effective_status?: string;
  campaign?: { id?: string; name?: string };
  adset?: { id?: string; name?: string };
  creative?: GraphCreative;
};

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    result.push(values.slice(i, i + size));
  }
  return result;
}

function requireMetaToken(): string {
  const token = process.env.META_ACCESS_TOKEN?.trim();
  if (!token) {
    throw new Error("META_ACCESS_TOKEN is required for creative media previews.");
  }
  return token;
}

/** Fetch ad thumbnails and media type without exposing the Meta token. */
export async function fetchMetaAdMedia(
  adIds: string[],
): Promise<Record<string, MetaAdMedia>> {
  if (adIds.length === 0) return {};
  const token = requireMetaToken();
  const unique = [...new Set(adIds.filter((id) => /^\d+$/.test(id)))];
  const result: Record<string, MetaAdMedia> = {};
  const fields =
    "id,name,status,effective_status,campaign{id,name},adset{id,name},creative{id,name,title,body,link_url,call_to_action_type,thumbnail_url,image_url,video_id,object_story_spec}";

  for (const batch of chunks(unique, 50)) {
    const url = new URL("https://graph.facebook.com/v21.0/");
    url.searchParams.set("ids", batch.join(","));
    url.searchParams.set("fields", fields);
    url.searchParams.set("access_token", token);

    const response = await fetch(url);
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Meta ad media ${response.status}: ${body.slice(0, 300)}`);
    }
    const payload = (await response.json()) as Record<string, GraphAd>;

    for (const [adId, ad] of Object.entries(payload)) {
      const creative = ad.creative;
      const videoId =
        creative?.video_id ??
        creative?.object_story_spec?.video_data?.video_id ??
        null;
      const thumbnailUrl =
        creative?.object_story_spec?.video_data?.image_url ??
        creative?.image_url ??
        creative?.object_story_spec?.link_data?.picture ??
        creative?.thumbnail_url ??
        null;
      const spec = creative?.object_story_spec;
      const video = spec?.video_data;
      const link = spec?.link_data;
      result[adId] = {
        adId,
        adName: ad.name ?? adId,
        status: ad.effective_status ?? ad.status ?? "UNKNOWN",
        creativeId: creative?.id ?? null,
        creativeName: creative?.name ?? null,
        campaignId: ad.campaign?.id ?? null,
        campaignName: ad.campaign?.name ?? null,
        adSetId: ad.adset?.id ?? null,
        adSetName: ad.adset?.name ?? null,
        primaryText:
          video?.message ??
          link?.message ??
          spec?.photo_data?.caption ??
          creative?.body ??
          null,
        headline: video?.title ?? link?.name ?? creative?.title ?? null,
        description: video?.link_description ?? link?.description ?? null,
        destinationUrl:
          video?.call_to_action?.value?.link ??
          link?.call_to_action?.value?.link ??
          link?.link ??
          creative?.link_url ??
          null,
        callToActionType: creative?.call_to_action_type ?? null,
        mediaType: videoId ? "video" : thumbnailUrl ? "image" : "unknown",
        thumbnailUrl,
        thumbnailWidth: null,
        thumbnailHeight: null,
        videoId,
        videoUrl: null,
        videoLengthSeconds: null,
      };
    }
  }

  const videoToAds = new Map<string, string[]>();
  for (const media of Object.values(result)) {
    if (!media.videoId) continue;
    const ads = videoToAds.get(media.videoId) ?? [];
    ads.push(media.adId);
    videoToAds.set(media.videoId, ads);
  }
  // The Meta token permits per-video metadata reads but rejects the `ids=`
  // multi-get for videos. Bound concurrency keeps this usable at scale.
  const videoIds = [...videoToAds.keys()];
  let videoCursor = 0;
  const videoWorker = async (): Promise<void> => {
    while (videoCursor < videoIds.length) {
      const videoId = videoIds[videoCursor++]!;
      const url = new URL(`https://graph.facebook.com/v21.0/${videoId}`);
      url.searchParams.set("fields", "id,length,thumbnails");
      url.searchParams.set("access_token", token);
      try {
        const response = await fetch(url);
        if (!response.ok) continue;
        const metadata = (await response.json()) as {
          length?: number;
          thumbnails?: {
            data?: Array<{
              uri?: string;
              width?: number;
              height?: number;
              is_preferred?: boolean;
            }>;
          };
        };
        const thumbnails = metadata.thumbnails?.data ?? [];
        const best = [...thumbnails].sort(
          (a, b) =>
            Number(b.is_preferred) - Number(a.is_preferred) ||
            (b.width ?? 0) * (b.height ?? 0) -
              (a.width ?? 0) * (a.height ?? 0),
        )[0];
        for (const adId of videoToAds.get(videoId) ?? []) {
          const media = result[adId]!;
          media.videoLengthSeconds =
            typeof metadata.length === "number" ? metadata.length : null;
          if (best?.uri) {
            media.thumbnailUrl = best.uri;
            media.thumbnailWidth = best.width ?? null;
            media.thumbnailHeight = best.height ?? null;
          }
        }
      } catch {
        // Leave this asset's duration unavailable.
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(10, videoIds.length) }, () => videoWorker()),
  );

  // Some video objects deny `thumbnails`, but their AdCreative still permits
  // an explicitly sized thumbnail. This upgrades the remaining 64×64/160×160
  // fallbacks without needing access to the original video object.
  const creativeToAds = new Map<string, string[]>();
  for (const media of Object.values(result)) {
    if (!media.creativeId || (media.thumbnailWidth ?? 0) >= 1000) continue;
    const ads = creativeToAds.get(media.creativeId) ?? [];
    ads.push(media.adId);
    creativeToAds.set(media.creativeId, ads);
  }
  const creativeIds = [...creativeToAds.keys()];
  let creativeCursor = 0;
  const creativeWorker = async (): Promise<void> => {
    while (creativeCursor < creativeIds.length) {
      const creativeId = creativeIds[creativeCursor++]!;
      const adIds = creativeToAds.get(creativeId) ?? [];
      const firstMedia = adIds.map((adId) => result[adId]).find(Boolean);
      const width = 1080;
      const height = firstMedia?.mediaType === "video" ? 1920 : 1080;
      const url = new URL(`https://graph.facebook.com/v21.0/${creativeId}`);
      url.searchParams.set("fields", "thumbnail_url");
      url.searchParams.set("thumbnail_width", String(width));
      url.searchParams.set("thumbnail_height", String(height));
      url.searchParams.set("access_token", token);
      try {
        const response = await fetch(url);
        if (!response.ok) continue;
        const payload = (await response.json()) as {
          thumbnail_url?: string;
        };
        if (!payload.thumbnail_url) continue;
        for (const adId of adIds) {
          const media = result[adId]!;
          media.thumbnailUrl = payload.thumbnail_url;
          media.thumbnailWidth = width;
          media.thumbnailHeight = height;
        }
      } catch {
        // Keep the best earlier fallback.
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(10, creativeIds.length) },
      () => creativeWorker(),
    ),
  );

  return result;
}

const previewFormats = new Set([
  "MOBILE_FEED_STANDARD",
  "DESKTOP_FEED_STANDARD",
  "INSTAGRAM_STANDARD",
]);

/** Return Meta's signed preview iframe URL, which supports video playback. */
export async function fetchMetaAdPreview(
  adId: string,
  format = "MOBILE_FEED_STANDARD",
): Promise<{ adId: string; format: string; src: string }> {
  if (!/^\d+$/.test(adId)) {
    throw new Error("Invalid Meta ad id.");
  }
  if (!previewFormats.has(format)) {
    throw new Error("Unsupported preview format.");
  }
  const token = requireMetaToken();
  const url = new URL(`https://graph.facebook.com/v21.0/${adId}/previews`);
  url.searchParams.set("ad_format", format);
  url.searchParams.set("access_token", token);

  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Meta ad preview ${response.status}: ${body.slice(0, 300)}`);
  }
  const payload = (await response.json()) as {
    data?: Array<{ body?: string }>;
  };
  const body = payload.data?.[0]?.body ?? "";
  const match = body.match(/<iframe[^>]+src="([^"]+)"/i);
  if (!match?.[1]) {
    throw new Error("Meta returned no preview iframe.");
  }
  const src = match[1].replaceAll("&amp;", "&");
  const previewUrl = new URL(src);
  if (
    previewUrl.protocol !== "https:" ||
    !(
      previewUrl.hostname === "facebook.com" ||
      previewUrl.hostname.endsWith(".facebook.com")
    )
  ) {
    throw new Error("Meta returned an unexpected preview host.");
  }
  return {
    adId,
    format,
    src,
  };
}
