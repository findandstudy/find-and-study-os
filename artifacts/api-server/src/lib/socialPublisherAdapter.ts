import { z } from "zod";
import {
  assertSocialProviderAllowed,
  normalizeSocialErrorCode,
  resolveSocialPublicationGate,
} from "./socialOperationsContract";

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
  mediaRefs: Array<{ kind: string; ref: string }>;
  utm: Record<string, string>;
  scheduledFor: string;
};

export type SocialPublisherResult =
  | { ok: true; providerReceipt: string; providerPostRef: string }
  | { ok: false; retryable: boolean; errorCode: string };

const responseSchema = z
  .object({
    receiptId: z.string().min(8).max(512),
    postId: z.string().min(1).max(512),
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

export async function publishSocialJob(
  job: SocialPublicationJob,
): Promise<SocialPublisherResult> {
  const gate = resolveSocialPublicationGate({
    workerEnabled: process.env.SOCIAL_PUBLICATION_WORKER_ENABLED,
    providerPublishingEnabled: process.env.SOCIAL_PROVIDER_PUBLISHING_ENABLED,
    allowLiveIntegrations: process.env.ALLOW_LIVE_INTEGRATIONS,
    providerAllowlist: process.env.SOCIAL_PUBLICATION_PROVIDER_ALLOWLIST,
  });
  assertSocialProviderAllowed(gate, job.provider);
  const config = configuration();
  const endpoint = new URL(
    "v1/publications",
    config.url.href.endsWith("/") ? config.url : new URL(`${config.url.href}/`),
  );
  if (endpoint.hostname.toLowerCase() !== config.allowedHost)
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
        "idempotency-key": job.id,
      },
      body: JSON.stringify(job),
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
    const result = responseSchema.safeParse(parsed);
    return result.success
      ? {
          ok: true,
          providerReceipt: result.data.receiptId,
          providerPostRef: result.data.postId,
        }
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
