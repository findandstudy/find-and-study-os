import crypto from "node:crypto";

const UUID_V7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type SocialOperationsMode = "off" | "read" | "manage";
export type SocialPublicationGate = {
  enabled: boolean;
  workerEnabled: boolean;
  providerPublishingEnabled: boolean;
  allowedProviders: string[];
  reason: string | null;
};

const PROVIDER_RE = /^[a-z][a-z0-9._-]{1,63}$/;
const SAFE_RUNTIME_ID_RE = /^[A-Za-z0-9._:-]{1,96}$/;
const SAFE_ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{2,63}$/;

function explicitTrue(value?: string): boolean {
  return value?.trim().toLowerCase() === "true";
}

export function resolveSocialPublicationGate(input: {
  workerEnabled?: string;
  providerPublishingEnabled?: string;
  allowLiveIntegrations?: string;
  providerAllowlist?: string;
}): SocialPublicationGate {
  const workerEnabled = explicitTrue(input.workerEnabled);
  const providerPublishingEnabled = explicitTrue(
    input.providerPublishingEnabled,
  );
  const liveIntegrationsEnabled = explicitTrue(input.allowLiveIntegrations);
  const rawProviders = (input.providerAllowlist ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const validProviders = rawProviders.filter((provider) =>
    PROVIDER_RE.test(provider),
  );
  const allowedProviders = [...new Set(validProviders)];
  if (!workerEnabled)
    return {
      enabled: false,
      workerEnabled,
      providerPublishingEnabled,
      allowedProviders,
      reason: "SOCIAL_PUBLICATION_WORKER_DISABLED",
    };
  if (!providerPublishingEnabled)
    return {
      enabled: false,
      workerEnabled,
      providerPublishingEnabled,
      allowedProviders,
      reason: "SOCIAL_PROVIDER_PUBLISHING_DISABLED",
    };
  if (!liveIntegrationsEnabled)
    return {
      enabled: false,
      workerEnabled,
      providerPublishingEnabled,
      allowedProviders,
      reason: "LIVE_INTEGRATIONS_DISABLED",
    };
  if (rawProviders.length !== validProviders.length)
    return {
      enabled: false,
      workerEnabled,
      providerPublishingEnabled,
      allowedProviders: [],
      reason: "SOCIAL_PROVIDER_ALLOWLIST_INVALID",
    };
  if (allowedProviders.length === 0)
    return {
      enabled: false,
      workerEnabled,
      providerPublishingEnabled,
      allowedProviders,
      reason: "SOCIAL_PROVIDER_ALLOWLIST_EMPTY",
    };
  return {
    enabled: true,
    workerEnabled,
    providerPublishingEnabled,
    allowedProviders,
    reason: null,
  };
}

export function assertSocialProviderAllowed(
  gate: SocialPublicationGate,
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
