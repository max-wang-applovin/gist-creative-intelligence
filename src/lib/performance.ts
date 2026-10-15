import { fetchAdjustByCreative } from "./adjust";
import { hasLiveCredentials } from "./config";
import { defaultWindow, joinMetaAdjust } from "./join";
import { fetchAdPreviews, fetchMetaAdInsights } from "./meta";
import { mockPerformance } from "./mock";
import type { PerformancePayload } from "./types";

export async function getPerformance(opts?: {
  since?: string;
  until?: string;
  top?: number;
}): Promise<PerformancePayload> {
  const win = defaultWindow();
  const since = opts?.since || win.since;
  const until = opts?.until || win.until;

  if (!hasLiveCredentials()) {
    const mock = mockPerformance(since, until);
    if (opts?.top) mock.creatives = mock.creatives.slice(0, opts.top);
    return mock;
  }

  const metaToken = process.env.META_ACCESS_TOKEN!;
  const adjustToken = process.env.ADJUST_API_TOKEN!;

  const [metaRows, adjustRows] = await Promise.all([
    fetchMetaAdInsights(metaToken, since, until),
    fetchAdjustByCreative(adjustToken, since, until),
  ]);

  const topIds = [...metaRows]
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 40)
    .map((r) => r.ad_id);
  const previews = await fetchAdPreviews(metaToken, topIds);

  const payload = joinMetaAdjust(metaRows, adjustRows, since, until, {
    source: "live",
    previews,
  });
  if (opts?.top) payload.creatives = payload.creatives.slice(0, opts.top);
  return payload;
}
