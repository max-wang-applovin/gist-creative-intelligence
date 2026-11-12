import { AsyncLocalStorage } from "node:async_hooks";

export type DataProfile = {
  id: string;
  label: string;
  metaAdAccountId: string;
  adjustAppName: string | null;
  adjustAppToken: string | null;
  useLegacyStorage: boolean;
};

const storage = new AsyncLocalStorage<DataProfile>();

function fallbackProfile(): DataProfile {
  return {
    id: "default",
    label: process.env.ADJUST_APP_NAME?.trim() || "Default account",
    metaAdAccountId: process.env.META_AD_ACCOUNT_ID?.trim() || "",
    adjustAppName: process.env.ADJUST_APP_NAME?.trim() || null,
    adjustAppToken: process.env.ADJUST_APP_TOKEN?.trim() || null,
    useLegacyStorage: true,
  };
}

export function configuredDataProfiles(): DataProfile[] {
  const raw = process.env.DASHBOARD_PROFILES_JSON?.trim();
  if (!raw) return [fallbackProfile()];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error(
        "DASHBOARD_PROFILES_JSON must contain at least one profile.",
      );
    }
    const profiles = (parsed as Array<Partial<DataProfile>>).map((profile) => {
      const id = String(profile.id ?? "")
        .trim()
        .toLowerCase();
      const metaAdAccountId = String(
        profile.metaAdAccountId ?? "",
      ).trim();
      const adjustAppName =
        String(profile.adjustAppName ?? "").trim() || null;
      const adjustAppToken =
        String(profile.adjustAppToken ?? "").trim() || null;
      if (
        !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) ||
        !metaAdAccountId ||
        (!adjustAppName && !adjustAppToken)
      ) {
        throw new Error(
          "Each dashboard profile requires a valid id, metaAdAccountId, and adjustAppName or adjustAppToken.",
        );
      }
      return {
        id,
        label: String(profile.label ?? "").trim().slice(0, 100) || id,
        metaAdAccountId,
        adjustAppName,
        adjustAppToken,
        useLegacyStorage: false,
      };
    });
    if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length) {
      throw new Error("DASHBOARD_PROFILES_JSON profile IDs must be unique.");
    }
    if (profiles.length) {
      profiles[0]!.useLegacyStorage = true;
      return profiles;
    }
    return [fallbackProfile()];
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("DASHBOARD_PROFILES_JSON must be valid profile JSON.");
    }
    throw error;
  }
}

export function activeDataProfile(): DataProfile {
  return storage.getStore() ?? fallbackProfile();
}

export function runWithDataProfile<T>(
  profile: DataProfile,
  task: () => T,
): T {
  return storage.run(profile, task);
}

export function activeProfileId(): string {
  return activeDataProfile().id;
}

export function activeProfileUsesLegacyStorage(): boolean {
  return activeDataProfile().useLegacyStorage;
}

export function activeMetaAdAccountId(): string {
  return activeDataProfile().metaAdAccountId;
}

export function activeAdjustAppName(): string | null {
  return activeDataProfile().adjustAppName;
}

export function activeAdjustAppToken(): string | null {
  return activeDataProfile().adjustAppToken;
}
