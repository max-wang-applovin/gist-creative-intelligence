/** Parse Gist convention ad names: {date}_{source}_{angle}_{who}_{hook} */

export type ParsedAdName = {
  date: string;
  source: string;
  angle: string;
  who: string;
  hook: string;
};

export function parseAdName(name: string): ParsedAdName | null {
  const parts = name.split("_");
  if (parts.length !== 5) return null;
  const [date, source, angle, who, hook] = parts;
  if (!/^\d{6}$/.test(date)) return null;
  return { date, source, angle, who, hook };
}

export function tagsFromAdName(name: string): {
  valueProp?: string;
  message?: string;
  hook?: string;
  creator?: string;
  format?: "unknown";
} {
  const parsed = parseAdName(name);
  if (!parsed) return {};
  return {
    valueProp: parsed.angle,
    message: parsed.angle,
    hook: parsed.hook,
    creator: parsed.who === "None" ? undefined : parsed.who,
    format: "unknown",
  };
}
