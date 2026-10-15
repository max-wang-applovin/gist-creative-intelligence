import { LEAD_ACTION, META_AD_ACCOUNT_ID, META_API_VERSION } from "./config";

export type MetaInsightRow = {
  ad_id: string;
  ad_name: string;
  campaign_name: string;
  spend: number;
  leads: number;
};

export type MetaCreativePreview = {
  adId: string;
  thumbnailUrl: string | null;
  previewUrl: string | null;
};

async function graphGet<T>(
  path: string,
  params: Record<string, string>,
  token: string,
): Promise<T> {
  const base = path
    ? `https://graph.facebook.com/${META_API_VERSION}/${path.replace(/^\//, "")}`
    : `https://graph.facebook.com/${META_API_VERSION}/`;
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("access_token", token);
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Meta ${path} HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchMetaAdInsights(
  token: string,
  since: string,
  until: string,
): Promise<MetaInsightRow[]> {
  type Page = {
    data?: Array<{
      ad_id: string;
      ad_name: string;
      campaign_name: string;
      spend?: string;
      actions?: Array<{ action_type: string; value: string }>;
    }>;
    paging?: { next?: string };
  };

  const out: MetaInsightRow[] = [];
  let path: string | null = `${META_AD_ACCOUNT_ID}/insights`;
  let params: Record<string, string> | null = {
    level: "ad",
    time_range: JSON.stringify({ since, until }),
    fields: "ad_id,ad_name,campaign_name,spend,actions",
    limit: "500",
  };

  while (path) {
    let page: Page;
    if (params) {
      page = await graphGet<Page>(path, params, token);
    } else {
      const res = await fetch(path, { cache: "no-store" });
      if (!res.ok) throw new Error(`Meta paging HTTP ${res.status}`);
      page = (await res.json()) as Page;
    }

    for (const r of page.data || []) {
      const leads = (r.actions || [])
        .filter((a: { action_type: string; value: string }) =>
          a.action_type === LEAD_ACTION)
        .reduce(
          (s: number, a: { action_type: string; value: string }) =>
            s + Number(a.value || 0),
          0,
        );
      out.push({
        ad_id: r.ad_id,
        ad_name: r.ad_name,
        campaign_name: r.campaign_name,
        spend: Number(r.spend || 0),
        leads,
      });
    }

    if (page.paging?.next) {
      path = page.paging.next;
      params = null;
    } else {
      path = null;
    }
  }
  return out;
}

export async function fetchAdPreviews(
  token: string,
  adIds: string[],
): Promise<Record<string, MetaCreativePreview>> {
  const out: Record<string, MetaCreativePreview> = {};
  // Batch in chunks of 50 using ids filter.
  for (let i = 0; i < adIds.length; i += 40) {
    const chunk = adIds.slice(i, i + 40);
    if (!chunk.length) continue;
  try {
      // Root ids= lookup returns a map keyed by ad id.
      const map = await graphGet<
        Record<
          string,
          {
            id: string;
            creative?: {
              thumbnail_url?: string;
              effective_object_story_id?: string;
              object_story_spec?: { video_data?: { image_url?: string } };
            };
          }
        >
      >("", {
        ids: chunk.join(","),
        fields:
          "id,creative{thumbnail_url,effective_object_story_id,object_story_spec}",
      }, token);
      for (const id of chunk) {
        const row = map[id];
        if (!row) continue;
        const thumb =
          row.creative?.thumbnail_url ||
          row.creative?.object_story_spec?.video_data?.image_url ||
          null;
        out[id] = {
          adId: id,
          thumbnailUrl: thumb,
          previewUrl: row.creative?.effective_object_story_id
            ? `https://www.facebook.com/${row.creative.effective_object_story_id}`
            : null,
        };
      }
    } catch {
      // Previews are optional; keep performance rows even if media fails.
    }
  }
  return out;
}
