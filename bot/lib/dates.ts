import type { DateRange } from "./types.js";

/**
 * Default lookback of complete UTC days ending yesterday.
 * Matches UA L7D / L30D reporting (exclude the partial current day).
 */
export function defaultDateRange(days = 7): DateRange {
  const until = new Date();
  until.setUTCHours(0, 0, 0, 0);
  until.setUTCDate(until.getUTCDate() - 1);
  const since = new Date(until);
  since.setUTCDate(since.getUTCDate() - (days - 1));
  return {
    since: since.toISOString().slice(0, 10),
    until: until.toISOString().slice(0, 10),
  };
}

export function resolveDateRange(input: {
  since?: string;
  until?: string;
  days?: number;
}): DateRange {
  if (input.since && input.until) {
    return { since: input.since, until: input.until };
  }
  return defaultDateRange(input.days ?? 7);
}
