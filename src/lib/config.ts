export const META_AD_ACCOUNT_ID =
  process.env.META_AD_ACCOUNT_ID || "act_990337856783605";
export const ADJUST_APP_NAME = process.env.ADJUST_APP_NAME || "Gist";
export const META_API_VERSION = "v26.0";
export const ADJUST_REPORT_URL =
  "https://automate.adjust.com/reports-service/report";
export const LEAD_ACTION = "offsite_conversion.fb_pixel_lead";

export function hasLiveCredentials(): boolean {
  if (process.env.GCI_FORCE_MOCK === "1") return false;
  return Boolean(
    process.env.META_ACCESS_TOKEN?.trim() &&
      process.env.ADJUST_API_TOKEN?.trim(),
  );
}
