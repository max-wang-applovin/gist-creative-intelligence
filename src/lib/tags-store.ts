import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import type { CreativeTags } from "./types";

const DATA_DIR = path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "tag-overrides.json");

export function loadTagOverrides(): Record<string, CreativeTags> {
  try {
    if (!existsSync(FILE)) return {};
    return JSON.parse(readFileSync(FILE, "utf8")) as Record<string, CreativeTags>;
  } catch {
    return {};
  }
}

export function saveTagOverride(key: string, tags: CreativeTags): CreativeTags {
  mkdirSync(DATA_DIR, { recursive: true });
  const all = loadTagOverrides();
  const next = { ...(all[key] || {}), ...tags };
  all[key] = next;
  writeFileSync(FILE, JSON.stringify(all, null, 2) + "\n");
  return next;
}
