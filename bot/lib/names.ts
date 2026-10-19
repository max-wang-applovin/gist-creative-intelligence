/** Normalize creative/ad names for Meta↔Adjust joins and rollups. */
export function normalizeCreativeName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*\(\d+\s*ads?\)\s*$/i, "")
    .replace(/\s*\(\d+\)\s*$/i, "")
    .toLowerCase();
}
