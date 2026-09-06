import { createHash } from "node:crypto";
import { z } from "zod";
import {
  assertSocialProviderAllowed,
  normalizeSocialErrorCode,
  resolveSocialCreativeGate,
} from "./socialOperationsContract";
import { validateSocialMediaMetadata } from "./socialMediaAssets";

export type SocialCreativeJob = {
  id: string;
  attemptNumber: number;
  provider: string;
  integrationKey: string;
  outputKind: "CAPTION" | "IMAGE" | "VIDEO";
  model: string | null;
  locale: string;
  prompt: string;
  negativePrompt: string | null;
  aspectRatio: "1:1" | "4:5" | "9:16" | "16:9" | null;
  durationSeconds: number | null;
  maxCostMinor: number;
  currencyCode: string;
  providerJobRef: string | null;
};

type SocialCreativeFailure = {
  ok: false;
  retryable: boolean;
  errorCode: string;
};
export type SocialCreativeUsage = {
  inputUnits?: number;
  outputUnits?: number;
  estimatedCostMinor?: number;
  currencyCode?: string;
};
export type SocialCreativeResult =
  | {
      ok: true;
      state: "PENDING";
      providerReceipt: string;
      providerJobRef: string;
      resolvedModel: string | null;
      usage: SocialCreativeUsage | null;
    }
  | {
      ok: true;
      state: "COMPLETED";
      providerReceipt: string;
      resolvedModel: string | null;
      usage: SocialCreativeUsage | null;
      output:
        | { kind: "CAPTION"; text: string }
        | {
            kind: "IMAGE" | "VIDEO";
            buffer: Buffer;
            fileName: string;
            mimeType: string;
            sha256: string;
          };
    }
  | SocialCreativeFailure;

const usageSchema = z
  .object({
    inputUnits: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    outputUnits: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    estimatedCostMinor: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    currencyCode: z.string().regex(/^[A-Z]{3}$/).optional(),
  })
  .strict()
  .refine(
    (value) =>
      (value.estimatedCostMinor === undefined) ===
      (value.currencyCode === undefined),
    "cost and currency must be paired",
  );
const completedUsageSchema = usageSchema.refine(
  (value) =>
    value.estimatedCostMinor !== undefined && value.currencyCode !== undefined,
  "completed generation must report cost",
);
const pendingSchema = z
  .object({
    state: z.literal("PENDING"),
    receiptId: z.string().min(8).max(512),
    jobId: z.string().min(1).max(512),
    resolvedModel: z.string().min(1).max(128).optional(),
    usage: usageSchema.optional(),
  })
  .strict();
const captionSchema = z
  .object({
    state: z.literal("COMPLETED"),
    receiptId: z.string().min(8).max(512),
    outputKind: z.literal("CAPTION"),
    text: z.string().trim().min(1).max(10_000),
    resolvedModel: z.string().min(1).max(128).optional(),
    usage: completedUsageSchema,
  })
  .strict();
const mediaSchema = z
  .object({
    state: z.literal("COMPLETED"),
    receiptId: z.string().min(8).max(512),
    outputKind: z.enum(["IMAGE", "VIDEO"]),
    asset: z
      .object({
        downloadPath: z
          .string()
          .regex(/^\/v1\/creative-assets\/[A-Za-z0-9._~/-]{1,512}$/),
        fileName: z.string().trim().min(1).max(240),
        mimeType: z.enum([
          "image/jpeg",
          "image/png",
          "image/webp",
          "video/mp4",
        ]),
        sizeBytes: z.number().int().positive(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict(),
    resolvedModel: z.string().min(1).max(128).optional(),
    usage: completedUsageSchema,
  })
  .strict();
const responseSchema = z.union([pendingSchema, captionSchema, mediaSchema]);

function configuration(): {
  url: URL;
  token: string;
  allowedHost: string;
} {
  const rawUrl = process.env.SOCIAL_CREATIVE_BASE_URL?.trim();
  const token = process.env.SOCIAL_CREATIVE_TOKEN?.trim();
  const allowedHost = process.env.SOCIAL_CREATIVE_ALLOWED_HOST?.trim().toLowerCase();
  if (!rawUrl || !token || !allowedHost)
    throw new Error("SOCIAL_CREATIVE_CONFIGURATION_MISSING");
  const url = new URL(rawUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.hostname.toLowerCase() !== allowedHost
  )
    throw new Error("SOCIAL_CREATIVE_ENDPOINT_INVALID");
  return { url, token, allowedHost };
}

export function assertSocialCreativeConfiguration(): void {
  configuration();
}

async function boundedBytes(
  response: Response,
  maximumBytes: number,
): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > maximumBytes)
        throw new Error("SOCIAL_CREATIVE_RESPONSE_TOO_LARGE");
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size);
}

function endpoint(config: ReturnType<typeof configuration>, path: string): URL {
  const target = new URL(
    path,
    config.url.href.endsWith("/") ? config.url : new URL(`${config.url.href}/`),
  );
  if (
    target.protocol !== "https:" ||
    target.hostname.toLowerCase() !== config.allowedHost ||
    target.username ||
    target.password ||
    target.search ||
    target.hash
  )
    throw new Error("SOCIAL_CREATIVE_ENDPOINT_INVALID");
  return target;
}

function failure(errorCode: string, retryable: boolean): SocialCreativeFailure {
  return {
    ok: false,
    retryable,
    errorCode: normalizeSocialErrorCode(errorCode),
  };
}

function usageWithinBudget(
  job: SocialCreativeJob,
  usage: SocialCreativeUsage,
): boolean {
  return (
    usage.estimatedCostMinor !== undefined &&
    usage.estimatedCostMinor <= job.maxCostMinor &&
    usage.currencyCode === job.currencyCode
  );
}

async function requestProvider(job: SocialCreativeJob) {
  const config = configuration();
  const path = job.providerJobRef ? "v1/creative/status" : "v1/creative/generate";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(endpoint(config, path), {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
        accept: "application/json",
        "idempotency-key": job.providerJobRef
          ? `${job.id}:poll:${job.attemptNumber}`
          : `${job.id}:create`,
      },
      body: JSON.stringify(
        job.providerJobRef
          ? {
              requestId: job.id,
              provider: job.provider,
              integrationKey: job.integrationKey,
              jobId: job.providerJobRef,
            }
          : {
              requestId: job.id,
              provider: job.provider,
              integrationKey: job.integrationKey,
              outputKind: job.outputKind,
              model: job.model,
              locale: job.locale,
              prompt: job.prompt,
              negativePrompt: job.negativePrompt,
              aspectRatio: job.aspectRatio,
              durationSeconds: job.durationSeconds,
              maxCostMinor: job.maxCostMinor,
              currencyCode: job.currencyCode,
            },
      ),
    });
    const body = (await boundedBytes(response, 65_536)).toString("utf8");
    if (!response.ok)
      return failure(
        `PROVIDER_HTTP_${response.status}`,
        response.status === 408 || response.status === 429 || response.status >= 500,
      );
    if (!response.headers.get("content-type")?.toLowerCase().includes("application/json"))
      return failure("PROVIDER_RESPONSE_TYPE_INVALID", false);
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      return failure("PROVIDER_RESPONSE_JSON_INVALID", false);
    }
    const parsed = responseSchema.safeParse(json);
    return parsed.success
      ? { ok: true as const, data: parsed.data, config }
      : failure("PROVIDER_RESPONSE_SCHEMA_INVALID", false);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("SOCIAL_")) throw error;
    return failure("PROVIDER_NETWORK_ERROR", true);
  } finally {
    clearTimeout(timer);
  }
}

async function downloadAsset(
  config: ReturnType<typeof configuration>,
  asset: z.infer<typeof mediaSchema>["asset"],
): Promise<Buffer> {
  const metadata = validateSocialMediaMetadata({
    fileName: asset.fileName,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(endpoint(config, asset.downloadPath), {
      redirect: "error",
      signal: controller.signal,
      headers: { authorization: `Bearer ${config.token}`, accept: asset.mimeType },
    });
    if (!response.ok)
      throw new Error(`SOCIAL_CREATIVE_ASSET_HTTP_${response.status}`);
    if (response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== asset.mimeType)
      throw new Error("SOCIAL_CREATIVE_ASSET_TYPE_MISMATCH");
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null && Number(declaredLength) !== asset.sizeBytes)
      throw new Error("SOCIAL_CREATIVE_ASSET_SIZE_MISMATCH");
    const buffer = await boundedBytes(response, metadata.sizeBytes);
    if (buffer.byteLength !== metadata.sizeBytes)
      throw new Error("SOCIAL_CREATIVE_ASSET_SIZE_MISMATCH");
    if (createHash("sha256").update(buffer).digest("hex") !== asset.sha256)
      throw new Error("SOCIAL_CREATIVE_ASSET_HASH_MISMATCH");
    return buffer;
  } finally {
    clearTimeout(timer);
  }
}

export async function generateSocialCreative(
  job: SocialCreativeJob,
): Promise<SocialCreativeResult> {
  const gate = resolveSocialCreativeGate({
    workerEnabled: process.env.SOCIAL_CREATIVE_WORKER_ENABLED,
    generationEnabled: process.env.SOCIAL_CREATIVE_GENERATION_ENABLED,
    allowLiveIntegrations: process.env.ALLOW_LIVE_INTEGRATIONS,
    providerAllowlist: process.env.SOCIAL_CREATIVE_PROVIDER_ALLOWLIST,
  });
  assertSocialProviderAllowed(gate, job.provider);
  const response = await requestProvider(job);
  if (!response.ok) return response;
  const data = response.data;
  if (
    data.state === "PENDING" &&
    job.providerJobRef &&
    data.jobId !== job.providerJobRef
  )
    return failure("PROVIDER_JOB_REFERENCE_MISMATCH", false);
  if (data.state === "PENDING")
    return {
      ok: true,
      state: "PENDING",
      providerReceipt: data.receiptId,
      providerJobRef: data.jobId,
      resolvedModel: data.resolvedModel ?? null,
      usage: data.usage ?? null,
    };
  if (data.outputKind !== job.outputKind)
    return failure("PROVIDER_OUTPUT_KIND_MISMATCH", false);
  if (!usageWithinBudget(job, data.usage))
    return failure("PROVIDER_COST_LIMIT_VIOLATION", false);
  if (data.outputKind === "CAPTION")
    return {
      ok: true,
      state: "COMPLETED",
      providerReceipt: data.receiptId,
      resolvedModel: data.resolvedModel ?? null,
      usage: data.usage,
      output: { kind: "CAPTION", text: data.text },
    };
  try {
    const buffer = await downloadAsset(response.config, data.asset);
    return {
      ok: true,
      state: "COMPLETED",
      providerReceipt: data.receiptId,
      resolvedModel: data.resolvedModel ?? null,
      usage: data.usage,
      output: {
        kind: data.outputKind,
        buffer,
        fileName: data.asset.fileName,
        mimeType: data.asset.mimeType,
        sha256: data.asset.sha256,
      },
    };
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    return failure(
      /^SOCIAL_[A-Z0-9_]{2,63}$/.test(code)
        ? code
        : "SOCIAL_CREATIVE_ASSET_DOWNLOAD_FAILED",
      !/MISMATCH|TOO_LARGE/.test(code),
    );
  }
}

export function socialCreativeFailureFromThrown(error: unknown): SocialCreativeFailure {
  const code = error instanceof Error ? error.message.trim().toUpperCase() : "";
  return /^SOCIAL_[A-Z0-9_]{2,63}$/.test(code)
    ? failure(code, false)
    : failure("PROVIDER_EXECUTION_ERROR", true);
}
