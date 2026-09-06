import { z } from "zod";
import {
  assertSocialProviderAllowed,
  normalizeSocialErrorCode,
  resolveSocialProviderConnectionGate,
  resolveSocialPublicationGate,
} from "./socialOperationsContract";
import {
  assertSocialContentMedia,
  type SocialMediaRef,
} from "./socialMediaAssets";

export type SocialPublicationJob = {
  id: string;
  provider: string;
  accountKey: string;
  integrationKey: string;
  title: string;
  caption: string;
  contentKind: string;
  locales: string[];
  channels: string[];
  mediaRefs: SocialMediaRef[];
  utm: Record<string, string>;
  scheduledFor: string;
};

export type SocialPublisherFailure = {
  ok: false;
  retryable: boolean;
  errorCode: string;
};
export type SocialPublisherResult =
  | { ok: true; providerReceipt: string; providerPostRef: string }
  | SocialPublisherFailure;
export type SocialAccountVerificationResult =
  | {
      ok: true;
      providerReceipt: string;
      externalAccountRef: string;
      displayName: string | null;
    }
  | SocialPublisherFailure;

const metricValue = z.number().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const socialMetricsSchema = z
  .object({
    impressions: metricValue.optional(),
    reach: metricValue.optional(),
    views: metricValue.optional(),
    engagements: metricValue.optional(),
    reactions: metricValue.optional(),
    comments: metricValue.optional(),
    shares: metricValue.optional(),
    saves: metricValue.optional(),
    clicks: metricValue.optional(),
    linkClicks: metricValue.optional(),
    videoViews: metricValue.optional(),
    watchTimeSeconds: metricValue.optional(),
    followersGained: metricValue.optional(),
    spendMinor: metricValue.optional(),
    conversions: metricValue.optional(),
    leads: metricValue.optional(),
  })
  .strict()
  .refine((metrics) => Object.keys(metrics).length > 0, "metrics required");
export type SocialMetrics = z.infer<typeof socialMetricsSchema>;
export type SocialPerformanceResult =
  | {
      ok: true;
      providerReceipt: string;
      observedAt: string;
      metrics: SocialMetrics;
    }
  | SocialPublisherFailure;

export function socialPublisherFailureFromThrown(
  error: unknown,
): SocialPublisherFailure {
  const code = error instanceof Error ? error.message.trim().toUpperCase() : "";
  if (/^SOCIAL_[A-Z0-9_]{2,56}$/.test(code)) {
    return { ok: false, retryable: false, errorCode: code };
  }
  return {
    ok: false,
    retryable: true,
    errorCode: "PROVIDER_EXECUTION_ERROR",
  };
}

const publicationResponseSchema = z
  .object({
    receiptId: z.string().min(8).max(512),
    postId: z.string().min(1).max(512),
  })
  .strict();
const verificationResponseSchema = z
  .object({
    receiptId: z.string().min(8).max(512),
    externalAccountId: z.string().min(1).max(512),
    displayName: z.string().trim().min(1).max(160).optional(),
  })
  .strict();
const performanceResponseSchema = z
  .object({
    receiptId: z.string().min(8).max(512),
    observedAt: z.string().datetime({ offset: true }),
    metrics: socialMetricsSchema,
  })
  .strict();

function configuration(): { url: URL; token: string; allowedHost: string } {
  const rawUrl = process.env.SOCIAL_PUBLISHER_BASE_URL?.trim();
  const token = process.env.SOCIAL_PUBLISHER_TOKEN?.trim();
  const allowedHost =
    process.env.SOCIAL_PUBLISHER_ALLOWED_HOST?.trim().toLowerCase();
  if (!rawUrl || !token || !allowedHost)
    throw new Error("SOCIAL_PUBLISHER_CONFIGURATION_MISSING");
  const url = new URL(rawUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.hostname.toLowerCase() !== allowedHost
  )
    throw new Error("SOCIAL_PUBLISHER_ENDPOINT_INVALID");
  return { url, token, allowedHost };
}

export function assertSocialPublisherConfiguration(): void {
  configuration();
}

async function boundedText(
  response: Response,
  maximumBytes = 65_536,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > maximumBytes)
        throw new Error("SOCIAL_PROVIDER_RESPONSE_TOO_LARGE");
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

async function providerPost<T>(input: {
  path: string;
  idempotencyKey: string;
  body: unknown;
  schema: z.ZodType<T>;
}): Promise<{ ok: true; data: T } | SocialPublisherFailure> {
  const config = configuration();
  const endpoint = new URL(
    input.path,
    config.url.href.endsWith("/") ? config.url : new URL(`${config.url.href}/`),
  );
  if (
    endpoint.protocol !== "https:" ||
    endpoint.hostname.toLowerCase() !== config.allowedHost ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error("SOCIAL_PUBLISHER_ENDPOINT_INVALID");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
        accept: "application/json",
        "idempotency-key": input.idempotencyKey,
      },
      body: JSON.stringify(input.body),
    });
    const body = await boundedText(response);
    if (!response.ok) {
      const retryable =
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500;
      return {
        ok: false,
        retryable,
        errorCode: normalizeSocialErrorCode(`PROVIDER_HTTP_${response.status}`),
      };
    }
    if (
      !response.headers
        .get("content-type")
        ?.toLowerCase()
        .includes("application/json")
    )
      return {
        ok: false,
        retryable: false,
        errorCode: "PROVIDER_RESPONSE_TYPE_INVALID",
      };
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return {
        ok: false,
        retryable: false,
        errorCode: "PROVIDER_RESPONSE_JSON_INVALID",
      };
    }
    const result = input.schema.safeParse(parsed);
    return result.success
      ? { ok: true, data: result.data }
      : {
          ok: false,
          retryable: false,
          errorCode: "PROVIDER_RESPONSE_SCHEMA_INVALID",
        };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("SOCIAL_"))
      throw error;
    return { ok: false, retryable: true, errorCode: "PROVIDER_NETWORK_ERROR" };
  } finally {
    clearTimeout(timeout);
  }
}

function assertProviderConnectivity(provider: string): void {
  const gate = resolveSocialProviderConnectionGate({
    connectivityEnabled: process.env.SOCIAL_PROVIDER_CONNECTIVITY_ENABLED,
    allowLiveIntegrations: process.env.ALLOW_LIVE_INTEGRATIONS,
    providerAllowlist: process.env.SOCIAL_PUBLICATION_PROVIDER_ALLOWLIST,
  });
  assertSocialProviderAllowed(gate, provider);
}

export async function verifySocialAccount(input: {
  requestKey: string;
  provider: string;
  accountKey: string;
  integrationKey: string;
}): Promise<SocialAccountVerificationResult> {
  assertProviderConnectivity(input.provider);
  const response = await providerPost({
    path: "v1/accounts/verify",
    idempotencyKey: input.requestKey,
    body: {
      provider: input.provider,
      accountKey: input.accountKey,
      integrationKey: input.integrationKey,
    },
    schema: verificationResponseSchema,
  });
  return response.ok
    ? {
        ok: true,
        providerReceipt: response.data.receiptId,
        externalAccountRef: response.data.externalAccountId,
        displayName: response.data.displayName ?? null,
      }
    : response;
}

export async function publishSocialJob(
  job: SocialPublicationJob,
): Promise<SocialPublisherResult> {
  assertSocialContentMedia(job.contentKind, job.mediaRefs);
  const gate = resolveSocialPublicationGate({
    workerEnabled: process.env.SOCIAL_PUBLICATION_WORKER_ENABLED,
    connectivityEnabled: process.env.SOCIAL_PROVIDER_CONNECTIVITY_ENABLED,
    providerPublishingEnabled: process.env.SOCIAL_PROVIDER_PUBLISHING_ENABLED,
    allowLiveIntegrations: process.env.ALLOW_LIVE_INTEGRATIONS,
    providerAllowlist: process.env.SOCIAL_PUBLICATION_PROVIDER_ALLOWLIST,
  });
  assertSocialProviderAllowed(gate, job.provider);
  const response = await providerPost({
    path: "v1/publications",
    idempotencyKey: job.id,
    body: job,
    schema: publicationResponseSchema,
  });
  return response.ok
    ? {
        ok: true,
        providerReceipt: response.data.receiptId,
        providerPostRef: response.data.postId,
      }
    : response;
}

export async function fetchSocialPerformance(input: {
  idempotencyKey: string;
  publicationId: string;
  provider: string;
  accountKey: string;
  integrationKey: string;
}): Promise<SocialPerformanceResult> {
  assertProviderConnectivity(input.provider);
  const response = await providerPost({
    path: "v1/performance",
    idempotencyKey: input.idempotencyKey,
    body: {
      publicationId: input.publicationId,
      provider: input.provider,
      accountKey: input.accountKey,
      integrationKey: input.integrationKey,
    },
    schema: performanceResponseSchema,
  });
  return response.ok
    ? {
        ok: true,
        providerReceipt: response.data.receiptId,
        observedAt: response.data.observedAt,
        metrics: response.data.metrics,
      }
    : response;
}
