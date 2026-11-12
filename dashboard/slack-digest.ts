import type { DebriefPayload } from "./debrief.js";

export type SlackDigestConfig = {
  configured: boolean;
  hasBotToken: boolean;
  hasChannel: boolean;
  channel: string | null;
  schedule: string;
};

function money(value: number | null | undefined): string {
  if (value == null) return "—";
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

function pct(value: number | null | undefined): string {
  return value == null ? "—" : `${value.toFixed(1)}%`;
}

export function slackDigestConfig(): SlackDigestConfig {
  const channel =
    process.env.CREATIVE_INTELLIGENCE_SLACK_DIGEST_CHANNEL?.trim() || null;
  const hasBotToken = Boolean(
    process.env.CREATIVE_INTELLIGENCE_SLACK_BOT_TOKEN?.trim(),
  );
  return {
    configured: Boolean(channel && hasBotToken),
    hasBotToken,
    hasChannel: Boolean(channel),
    channel,
    schedule: "Mondays at 14:00 UTC",
  };
}

export function buildSlackDigest(
  debrief: DebriefPayload,
  dashboardUrl: string,
): string {
  const winners = debrief.winners.slice(0, 5);
  const risks = debrief.retentionRisks.slice(0, 3);
  const scale = debrief.decisions
    .filter(
      (creative) =>
        creative.recommendedAction === "Scale" && !creative.promoted,
    )
    .slice(0, 5);
  const lines = [
    `*Creative Intelligence weekly digest · ${debrief.range.since} → ${debrief.range.until}*`,
    `${debrief.summary.tested} tested · ${debrief.summary.winners} winners · ${debrief.summary.losers} losers · ${money(debrief.summary.testingSpend)} testing spend · ${money(debrief.summary.cpsu)} CPSU`,
    `Benchmark retention: D1 ${pct(debrief.benchmarks.average.d1)} · D3 ${pct(debrief.benchmarks.average.d3)} · D7 ${pct(debrief.benchmarks.average.d7)}`,
    "",
    "*Top winners*",
    ...(winners.length
      ? winners.map(
          (creative, index) =>
            `${index + 1}. ${creative.readableName} — ${money(creative.testing.spend)} spend · ${money(creative.testing.cpsu)} CPSU · D7 ${pct(creative.testing.d7)}`,
        )
      : ["No mature winners in this window."]),
    "",
    "*Retention risks*",
    ...(risks.length
      ? risks.map(
          (creative) =>
            `• ${creative.readableName} — ${money(creative.testing.cpsu)} CPSU · ${creative.retentionHorizon || "retention"} ${pct(
              creative.retentionHorizon === "D7"
                ? creative.testing.d7
                : creative.retentionHorizon === "D3"
                  ? creative.testing.d3
                  : creative.testing.d1,
            )}`,
        )
      : ["• No sign-up-efficient retention risks detected."]),
    "",
    "*Ready to scale*",
    ...(scale.length
      ? scale.map(
          (creative) =>
            `• ${creative.readableName} — ${money(creative.testing.spend)} testing spend`,
        )
      : ["• No unpromoted scale candidates."]),
    "",
    `<${dashboardUrl}?page=debrief|Open Test Debrief>`,
  ];
  return lines.join("\n");
}

export async function sendSlackDigest(text: string): Promise<{
  channel: string;
  timestamp: string;
}> {
  const token =
    process.env.CREATIVE_INTELLIGENCE_SLACK_BOT_TOKEN?.trim();
  const channel =
    process.env.CREATIVE_INTELLIGENCE_SLACK_DIGEST_CHANNEL?.trim();
  if (!token || !channel) {
    throw new Error(
      "Set CREATIVE_INTELLIGENCE_SLACK_BOT_TOKEN and CREATIVE_INTELLIGENCE_SLACK_DIGEST_CHANNEL.",
    );
  }
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel,
      text,
      unfurl_links: false,
      unfurl_media: false,
    }),
  });
  const body = (await response.json()) as {
    ok?: boolean;
    error?: string;
    channel?: string;
    ts?: string;
  };
  if (!response.ok || !body.ok || !body.channel || !body.ts) {
    throw new Error(
      `Slack digest failed: ${body.error || response.statusText}`,
    );
  }
  return { channel: body.channel, timestamp: body.ts };
}
