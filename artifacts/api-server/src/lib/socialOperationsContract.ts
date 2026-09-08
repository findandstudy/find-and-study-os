import crypto from "node:crypto";

const UUID_V7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type SocialOperationsMode = "off" | "read" | "manage";
export type SocialPublicationGate = {
  enabled: boolean;
  workerEnabled: boolean;
  connectivityEnabled: boolean;
  providerPublishingEnabled: boolean;
  allowedProviders: string[];
  reason: string | null;
};
export type SocialProviderConnectionGate = {
  enabled: boolean;
  connectivityEnabled: boolean;
  allowedProviders: string[];
  reason: string | null;
};
export type SocialPerformanceGate = SocialProviderConnectionGate & {
  workerEnabled: boolean;
};
export type SocialCreativeGate = {
  enabled: boolean;
  workerEnabled: boolean;
  generationEnabled: boolean;
  allowedProviders: string[];
  reason: string | null;
};
export type SocialAdvertisingGate = {
  enabled: boolean;
  workerEnabled: boolean;
  connectivityEnabled: boolean;
  providerAdvertisingEnabled: boolean;
  allowedProviders: string[];
  maximumCampaignBudgetMinor: number | null;
  reason: string | null;
};

const PROVIDER_RE = /^[a-z][a-z0-9._-]{1,63}$/;
const SAFE_RUNTIME_ID_RE = /^[A-Za-z0-9._:-]{1,96}$/;
const SAFE_ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{2,63}$/;

function explicitTrue(value?: string): boolean {
  return value?.trim().toLowerCase() === "true";
}

function providerAllowlist(value?: string): {
  rawProviders: string[];
  allowedProviders: string[];
  valid: boolean;
} {
  const rawProviders = (value ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const validProviders = rawProviders.filter((provider) =>
    PROVIDER_RE.test(provider),
  );
  return {
    rawProviders,
    allowedProviders: [...new Set(validProviders)],
    valid: rawProviders.length === validProviders.length,
  };
}

export function resolveSocialProviderConnectionGate(input: {
  connectivityEnabled?: string;
  allowLiveIntegrations?: string;
  providerAllowlist?: string;
}): SocialProviderConnectionGate {
  const connectivityEnabled = explicitTrue(input.connectivityEnabled);
  const liveIntegrationsEnabled = explicitTrue(input.allowLiveIntegrations);
  const allowlist = providerAllowlist(input.providerAllowlist);
  if (!connectivityEnabled)
    return {
      enabled: false,
      connectivityEnabled,
      allowedProviders: allowlist.allowedProviders,
      reason: "SOCIAL_PROVIDER_CONNECTIVITY_DISABLED",
    };
  if (!liveIntegrationsEnabled)
    return {
      enabled: false,
      connectivityEnabled,
      allowedProviders: allowlist.allowedProviders,
      reason: "LIVE_INTEGRATIONS_DISABLED",
    };
  if (!allowlist.valid)
    return {
      enabled: false,
      connectivityEnabled,
      allowedProviders: [],
      reason: "SOCIAL_PROVIDER_ALLOWLIST_INVALID",
    };
  if (allowlist.allowedProviders.length === 0)
    return {
      enabled: false,
      connectivityEnabled,
      allowedProviders: [],
      reason: "SOCIAL_PROVIDER_ALLOWLIST_EMPTY",
    };
  return {
    enabled: true,
    connectivityEnabled,
    allowedProviders: allowlist.allowedProviders,
    reason: null,
  };
}

export function resolveSocialPublicationGate(input: {
  workerEnabled?: string;
  connectivityEnabled?: string;
  providerPublishingEnabled?: string;
  allowLiveIntegrations?: string;
  providerAllowlist?: string;
}): SocialPublicationGate {
  const workerEnabled = explicitTrue(input.workerEnabled);
  const connectivityEnabled = explicitTrue(input.connectivityEnabled);
  const providerPublishingEnabled = explicitTrue(
    input.providerPublishingEnabled,
  );
  const liveIntegrationsEnabled = explicitTrue(input.allowLiveIntegrations);
  const allowlist = providerAllowlist(input.providerAllowlist);
  const allowedProviders = allowlist.allowedProviders;
  if (!workerEnabled)
    return {
      enabled: false,
      workerEnabled,
      connectivityEnabled,
      providerPublishingEnabled,
      allowedProviders,
      reason: "SOCIAL_PUBLICATION_WORKER_DISABLED",
    };
  if (!connectivityEnabled)
    return {
      enabled: false,
      workerEnabled,
      connectivityEnabled,
      providerPublishingEnabled,
      allowedProviders,
      reason: "SOCIAL_PROVIDER_CONNECTIVITY_DISABLED",
    };
  if (!providerPublishingEnabled)
    return {
      enabled: false,
      workerEnabled,
      connectivityEnabled,
      providerPublishingEnabled,
      allowedProviders,
      reason: "SOCIAL_PROVIDER_PUBLISHING_DISABLED",
    };
  if (!liveIntegrationsEnabled)
    return {
      enabled: false,
      workerEnabled,
      connectivityEnabled,
      providerPublishingEnabled,
      allowedProviders,
      reason: "LIVE_INTEGRATIONS_DISABLED",
    };
  if (!allowlist.valid)
    return {
      enabled: false,
      workerEnabled,
      connectivityEnabled,
      providerPublishingEnabled,
      allowedProviders: [],
      reason: "SOCIAL_PROVIDER_ALLOWLIST_INVALID",
    };
  if (allowedProviders.length === 0)
    return {
      enabled: false,
      workerEnabled,
      connectivityEnabled,
      providerPublishingEnabled,
      allowedProviders,
      reason: "SOCIAL_PROVIDER_ALLOWLIST_EMPTY",
    };
  return {
    enabled: true,
    workerEnabled,
    connectivityEnabled,
    providerPublishingEnabled,
    allowedProviders,
    reason: null,
  };
}

export function resolveSocialPerformanceGate(input: {
  workerEnabled?: string;
  connectivityEnabled?: string;
  allowLiveIntegrations?: string;
  providerAllowlist?: string;
}): SocialPerformanceGate {
  const workerEnabled = explicitTrue(input.workerEnabled);
  const connection = resolveSocialProviderConnectionGate(input);
  if (!workerEnabled) {
    return {
      ...connection,
      enabled: false,
      workerEnabled,
      reason: "SOCIAL_PERFORMANCE_WORKER_DISABLED",
    };
  }
  return { ...connection, workerEnabled };
}

export function resolveSocialCreativeGate(input: {
  workerEnabled?: string;
  generationEnabled?: string;
  allowLiveIntegrations?: string;
  providerAllowlist?: string;
}): SocialCreativeGate {
  const workerEnabled = explicitTrue(input.workerEnabled);
  const generationEnabled = explicitTrue(input.generationEnabled);
  const liveIntegrationsEnabled = explicitTrue(input.allowLiveIntegrations);
  const allowlist = providerAllowlist(input.providerAllowlist);
  const base = {
    workerEnabled,
    generationEnabled,
    allowedProviders: allowlist.allowedProviders,
  };
  if (!workerEnabled)
    return {
      ...base,
      enabled: false,
      reason: "SOCIAL_CREATIVE_WORKER_DISABLED",
    };
  if (!generationEnabled)
    return {
      ...base,
      enabled: false,
      reason: "SOCIAL_CREATIVE_GENERATION_DISABLED",
    };
  if (!liveIntegrationsEnabled)
    return { ...base, enabled: false, reason: "LIVE_INTEGRATIONS_DISABLED" };
  if (!allowlist.valid)
    return {
      ...base,
      enabled: false,
      allowedProviders: [],
      reason: "SOCIAL_CREATIVE_PROVIDER_ALLOWLIST_INVALID",
    };
  if (allowlist.allowedProviders.length === 0)
    return {
      ...base,
      enabled: false,
      reason: "SOCIAL_CREATIVE_PROVIDER_ALLOWLIST_EMPTY",
    };
  return { ...base, enabled: true, reason: null };
}

function parseAdvertisingBudgetLimit(value?: string): number | null {
  const raw = value?.trim() ?? "";
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) &&
    parsed >= 100 &&
    parsed <= 1_000_000_000_000
    ? parsed
    : null;
}

export function resolveSocialAdvertisingGate(input: {
  workerEnabled?: string;
  connectivityEnabled?: string;
  providerAdvertisingEnabled?: string;
  allowLiveIntegrations?: string;
  providerAllowlist?: string;
  maximumCampaignBudgetMinor?: string;
}): SocialAdvertisingGate {
  const workerEnabled = explicitTrue(input.workerEnabled);
  const connectivityEnabled = explicitTrue(input.connectivityEnabled);
  const providerAdvertisingEnabled = explicitTrue(
    input.providerAdvertisingEnabled,
  );
  const liveIntegrationsEnabled = explicitTrue(input.allowLiveIntegrations);
  const allowlist = providerAllowlist(input.providerAllowlist);
  const maximumCampaignBudgetMinor = parseAdvertisingBudgetLimit(
    input.maximumCampaignBudgetMinor,
  );
  const base = {
    workerEnabled,
    connectivityEnabled,
    providerAdvertisingEnabled,
    allowedProviders: allowlist.allowedProviders,
    maximumCampaignBudgetMinor,
  };
  if (!workerEnabled)
    return { ...base, enabled: false, reason: "SOCIAL_AD_WORKER_DISABLED" };
  if (!connectivityEnabled)
    return {
      ...base,
      enabled: false,
      reason: "SOCIAL_PROVIDER_CONNECTIVITY_DISABLED",
    };
  if (!providerAdvertisingEnabled)
    return {
      ...base,
      enabled: false,
      reason: "SOCIAL_PROVIDER_ADVERTISING_DISABLED",
    };
  if (!liveIntegrationsEnabled)
    return { ...base, enabled: false, reason: "LIVE_INTEGRATIONS_DISABLED" };
  if (!allowlist.valid)
    return {
      ...base,
      enabled: false,
      allowedProviders: [],
      reason: "SOCIAL_AD_PROVIDER_ALLOWLIST_INVALID",
    };
  if (allowlist.allowedProviders.length === 0)
    return {
      ...base,
      enabled: false,
      reason: "SOCIAL_AD_PROVIDER_ALLOWLIST_EMPTY",
    };
  if (maximumCampaignBudgetMinor === null)
    return {
      ...base,
      enabled: false,
      reason: "SOCIAL_AD_BUDGET_LIMIT_INVALID",
    };
  return { ...base, enabled: true, reason: null };
}

export function assertSocialAdvertisingBudget(input: {
  dailyBudgetMinor: number;
  lifetimeBudgetMinor: number;
  maximumCampaignBudgetMinor: number | null;
}): void {
  if (
    !Number.isSafeInteger(input.dailyBudgetMinor) ||
    !Number.isSafeInteger(input.lifetimeBudgetMinor) ||
    input.dailyBudgetMinor < 1 ||
    input.lifetimeBudgetMinor < input.dailyBudgetMinor
  )
    throw new Error("SOCIAL_AD_BUDGET_INVALID");
  if (
    input.maximumCampaignBudgetMinor === null ||
    input.lifetimeBudgetMinor > input.maximumCampaignBudgetMinor
  )
    throw new Error("SOCIAL_AD_BUDGET_LIMIT_EXCEEDED");
}

export function normalizeSocialAdDestinationUrl(value: string): string {
  if (value.length > 2048) throw new Error("SOCIAL_AD_DESTINATION_INVALID");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("SOCIAL_AD_DESTINATION_INVALID");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443") ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    /^\d+(?:\.\d+){3}$/.test(hostname) ||
    hostname.includes(":") ||
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(
      hostname,
    )
  )
    throw new Error("SOCIAL_AD_DESTINATION_INVALID");
  url.hostname = hostname;
  url.port = "";
  return url.toString();
}

export function normalizeSocialAdCountryCodes(values: string[]): string[] {
  const normalized = [
    ...new Set(values.map((value) => value.trim().toUpperCase())),
  ];
  if (
    normalized.length < 1 ||
    normalized.length > 25 ||
    normalized.some((value) => !/^[A-Z]{2}$/.test(value))
  )
    throw new Error("SOCIAL_AD_COUNTRY_CODES_INVALID");
  return normalized.sort();
}

export function assertSocialCreativeOutputCompatible(
  contentKind: string,
  outputKind: "CAPTION" | "IMAGE" | "VIDEO",
): void {
  if (outputKind === "CAPTION") return;
  if (outputKind === "IMAGE" && ["REEL", "VIDEO"].includes(contentKind))
    throw new Error("SOCIAL_CREATIVE_OUTPUT_INCOMPATIBLE");
  if (outputKind === "VIDEO" && contentKind === "ARTICLE")
    throw new Error("SOCIAL_CREATIVE_OUTPUT_INCOMPATIBLE");
}

export function socialPerformanceIntervalMs(value?: string): number {
  const raw = value?.trim() || "21600";
  if (!/^\d+$/.test(raw))
    throw new Error("SOCIAL_PERFORMANCE_INTERVAL_INVALID");
  const seconds = Number(raw);
  if (!Number.isSafeInteger(seconds) || seconds < 900 || seconds > 604_800)
    throw new Error("SOCIAL_PERFORMANCE_INTERVAL_INVALID");
  return seconds * 1000;
}

export function socialPerformanceMaxAgeDays(value?: string): number {
  const raw = value?.trim() || "180";
  if (!/^\d+$/.test(raw)) throw new Error("SOCIAL_PERFORMANCE_MAX_AGE_INVALID");
  const days = Number(raw);
  if (!Number.isSafeInteger(days) || days < 1 || days > 730)
    throw new Error("SOCIAL_PERFORMANCE_MAX_AGE_INVALID");
  return days;
}

export function socialPerformanceCadenceMs(input: {
  baseIntervalSeconds?: string;
  publicationAgeMs: number;
}): number {
  if (!Number.isFinite(input.publicationAgeMs) || input.publicationAgeMs < 0)
    throw new Error("SOCIAL_PERFORMANCE_PUBLICATION_AGE_INVALID");
  const base = socialPerformanceIntervalMs(input.baseIntervalSeconds);
  const day = 86_400_000;
  if (input.publicationAgeMs < 7 * day) return base;
  if (input.publicationAgeMs < 30 * day) return Math.max(base, day);
  return Math.max(base, 7 * day);
}

export function assertSocialProviderAllowed(
  gate: { enabled: boolean; allowedProviders: string[]; reason: string | null },
  provider: string,
): void {
  const normalized = provider.trim().toLowerCase();
  if (!gate.enabled)
    throw new Error(gate.reason ?? "SOCIAL_PUBLISHING_DISABLED");
  if (
    !PROVIDER_RE.test(normalized) ||
    !gate.allowedProviders.includes(normalized)
  )
    throw new Error("SOCIAL_PROVIDER_NOT_ALLOWED");
}

export function normalizeSocialRuntimeId(value: string): string {
  const normalized = value.trim();
  if (!SAFE_RUNTIME_ID_RE.test(normalized))
    throw new Error("SOCIAL_RUNTIME_ID_INVALID");
  return normalized;
}

export function normalizeSocialErrorCode(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!SAFE_ERROR_CODE_RE.test(normalized))
    throw new Error("SOCIAL_ERROR_CODE_INVALID");
  return normalized;
}

export function socialWorkerFailureCode(error: unknown): string {
  const candidates = [
    error instanceof Error ? error.message : "",
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "",
  ];
  for (const candidate of candidates) {
    const normalized = candidate.trim().toUpperCase();
    if (SAFE_ERROR_CODE_RE.test(normalized)) return normalized;
  }
  return "SOCIAL_WORKER_INFRASTRUCTURE_ERROR";
}

export function socialWorkerRetryDelayMs(consecutiveFailures: number): number {
  if (
    !Number.isSafeInteger(consecutiveFailures) ||
    consecutiveFailures < 1 ||
    consecutiveFailures > 12
  )
    throw new Error("SOCIAL_WORKER_FAILURE_COUNT_INVALID");
  return Math.min(30_000, 1_000 * 2 ** (consecutiveFailures - 1));
}

export function socialWorkerHeartbeatIntervalMs(value?: string): number {
  const raw = value?.trim() || "30";
  if (!/^\d+$/.test(raw))
    throw new Error("SOCIAL_WORKER_HEARTBEAT_INTERVAL_INVALID");
  const seconds = Number(raw);
  if (!Number.isSafeInteger(seconds) || seconds < 10 || seconds > 120)
    throw new Error("SOCIAL_WORKER_HEARTBEAT_INTERVAL_INVALID");
  return seconds * 1000;
}

export function socialRetryDelayMs(attemptNumber: number): number {
  if (
    !Number.isSafeInteger(attemptNumber) ||
    attemptNumber < 1 ||
    attemptNumber > 12
  )
    throw new Error("SOCIAL_ATTEMPT_INVALID");
  return Math.min(6 * 60 * 60 * 1000, 30_000 * 2 ** (attemptNumber - 1));
}

export function socialRetryDisposition(input: {
  attemptNumber: number;
  maxAttempts: number;
  retryable: boolean;
}): "RETRY" | "DEAD_LETTER" {
  if (
    !Number.isSafeInteger(input.maxAttempts) ||
    input.maxAttempts < 1 ||
    input.maxAttempts > 12 ||
    !Number.isSafeInteger(input.attemptNumber) ||
    input.attemptNumber < 1 ||
    input.attemptNumber > input.maxAttempts
  )
    throw new Error("SOCIAL_ATTEMPT_INVALID");
  return input.retryable && input.attemptNumber < input.maxAttempts
    ? "RETRY"
    : "DEAD_LETTER";
}

export function resolveSocialOperationsConfiguration(input: {
  configuredMode?: string;
  nodeEnv?: string;
  tenantId?: string;
  organizationId?: string;
}): {
  enabled: boolean;
  mode: SocialOperationsMode;
  reason: string | null;
} {
  const raw =
    input.configuredMode ?? (input.nodeEnv === "production" ? "off" : "manage");
  const normalized = raw.trim().toLowerCase();
  const mode: SocialOperationsMode =
    normalized === "read" || normalized === "manage" ? normalized : "off";
  if (mode === "off") {
    return { enabled: false, mode, reason: "SOCIAL_OPERATIONS_DISABLED" };
  }
  if (!UUID_V7_RE.test(input.tenantId ?? "")) {
    return {
      enabled: false,
      mode,
      reason: "SOCIAL_OPERATIONS_TENANT_INVALID",
    };
  }
  if (!UUID_V7_RE.test(input.organizationId ?? "")) {
    return {
      enabled: false,
      mode,
      reason: "SOCIAL_OPERATIONS_ORGANIZATION_INVALID",
    };
  }
  return { enabled: true, mode, reason: null };
}

export function nextSocialId(observedAt = Date.now()): string {
  const bytes = crypto.randomBytes(16);
  const timestamp = BigInt(observedAt);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number((timestamp >> BigInt((5 - index) * 8)) & 0xffn);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  if (!UUID_V7_RE.test(id)) throw new Error("social_uuid_generation_failed");
  return id;
}

export function socialTrackingKey(briefId: string): string {
  if (!UUID_V7_RE.test(briefId))
    throw new Error("SOCIAL_TRACKING_BRIEF_ID_INVALID");
  return `fas_${briefId.toLowerCase().replaceAll("-", "")}`;
}

function utcDateOnly(value: string, label: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new Error(`SOCIAL_ATTRIBUTION_${label}_INVALID`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  )
    throw new Error(`SOCIAL_ATTRIBUTION_${label}_INVALID`);
  return parsed;
}

export function resolveSocialAttributionWindow(input: {
  from?: string;
  to?: string;
  now?: Date;
}): { from: Date; toExclusive: Date } {
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime()))
    throw new Error("SOCIAL_ATTRIBUTION_NOW_INVALID");
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const defaultFrom = new Date(today.getTime() - 29 * 86_400_000);
  const from = input.from
    ? utcDateOnly(input.from, "FROM")
    : defaultFrom;
  const to = input.to ? utcDateOnly(input.to, "TO") : today;
  const toExclusive = new Date(to.getTime() + 86_400_000);
  const durationDays = (toExclusive.getTime() - from.getTime()) / 86_400_000;
  if (durationDays < 1 || durationDays > 366)
    throw new Error("SOCIAL_ATTRIBUTION_WINDOW_INVALID");
  return { from, toExclusive };
}

function canonicalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function socialHash(value: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalize(value)), "utf8")
    .digest("hex");
}
