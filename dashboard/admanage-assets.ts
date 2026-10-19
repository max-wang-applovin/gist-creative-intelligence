export type AdManageAsset = {
  adId: string;
  thumbnailUrl: string | null;
  imageUrl: string | null;
  videoUrl: string | null;
};

/** Read-only asset fallback for Meta videos whose thumbnail metadata is denied. */
export async function fetchAdManageAssets(range: {
  since: string;
  until: string;
}): Promise<Record<string, AdManageAsset>> {
  const apiKey = process.env.ADMANAGE_API_KEY?.trim();
  const rawAccount = process.env.META_AD_ACCOUNT_ID?.trim();
  if (!apiKey || !rawAccount) return {};
  const accountId = rawAccount.startsWith("act_")
    ? rawAccount
    : `act_${rawAccount}`;
  const url = new URL("https://api.admanage.ai/v1/reports/query");
  url.searchParams.set("accountIds", accountId);
  url.searchParams.set("startDate", range.since);
  url.searchParams.set("endDate", range.until);
  url.searchParams.set(
    "metrics",
    "spend,impressions,thumbnailUrl,imageUrl,videoUrl",
  );
  url.searchParams.set("groupBy", "adId");
  url.searchParams.set("sortBy", "spend");
  url.searchParams.set("sortDirection", "DESC");
  url.searchParams.set("limit", "500");

  const response = await fetch(url, {
    signal: AbortSignal.timeout(60_000),
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `AdManage asset fallback ${response.status}: ${body.slice(0, 300)}`,
    );
  }
  const payload = (await response.json()) as {
    data?: Array<{
      adId?: string;
      thumbnailUrl?: string | null;
      imageUrl?: string | null;
      videoUrl?: string | null;
    }>;
  };
  return Object.fromEntries(
    (payload.data ?? [])
      .filter((row): row is typeof row & { adId: string } =>
        Boolean(row.adId),
      )
      .map((row) => [
        row.adId,
        {
          adId: row.adId,
          thumbnailUrl: row.thumbnailUrl ?? null,
          imageUrl: row.imageUrl ?? null,
          videoUrl: row.videoUrl ?? null,
        },
      ]),
  );
}
