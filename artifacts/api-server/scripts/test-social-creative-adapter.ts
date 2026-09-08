import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { after } from "node:test";

const originalFetch = globalThis.fetch;
const originalEnvironment = {
  SOCIAL_CREATIVE_WORKER_ENABLED: process.env.SOCIAL_CREATIVE_WORKER_ENABLED,
  SOCIAL_CREATIVE_GENERATION_ENABLED:
    process.env.SOCIAL_CREATIVE_GENERATION_ENABLED,
  SOCIAL_CREATIVE_PROVIDER_ALLOWLIST:
    process.env.SOCIAL_CREATIVE_PROVIDER_ALLOWLIST,
  SOCIAL_CREATIVE_BASE_URL: process.env.SOCIAL_CREATIVE_BASE_URL,
  SOCIAL_CREATIVE_ALLOWED_HOST: process.env.SOCIAL_CREATIVE_ALLOWED_HOST,
  SOCIAL_CREATIVE_TOKEN: process.env.SOCIAL_CREATIVE_TOKEN,
  ALLOW_LIVE_INTEGRATIONS: process.env.ALLOW_LIVE_INTEGRATIONS,
};

after(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const baseJob = {
  id: "0199a300-0000-7000-8000-000000000001",
  attemptNumber: 1,
  provider: "openai",
  integrationKey: "openai",
  outputKind: "CAPTION" as const,
  model: "gpt-test",
  locale: "tr",
  prompt: "Güvenli ve kısa bir başlık üret.",
  negativePrompt: null,
  aspectRatio: null,
  durationSeconds: null,
  maxCostMinor: 100,
  currencyCode: "USD",
  providerJobRef: null,
};

function enableCreativeGateway(): void {
  process.env.SOCIAL_CREATIVE_WORKER_ENABLED = "true";
  process.env.SOCIAL_CREATIVE_GENERATION_ENABLED = "true";
  process.env.SOCIAL_CREATIVE_PROVIDER_ALLOWLIST = "openai,runway";
  process.env.SOCIAL_CREATIVE_BASE_URL = "https://creative.example.test/gateway/";
  process.env.SOCIAL_CREATIVE_ALLOWED_HOST = "creative.example.test";
  process.env.SOCIAL_CREATIVE_TOKEN = "test-token-never-log";
  process.env.ALLOW_LIVE_INTEGRATIONS = "true";
}

test("creative adapter is kill-switched, schema-strict and async-job aware", async () => {
  enableCreativeGateway();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let responsePayload: unknown = {
    state: "COMPLETED",
    receiptId: "creative-receipt-caption-0001",
    outputKind: "CAPTION",
    text: "Doğrulanmış yaratıcı metin",
    resolvedModel: "gpt-test-2026-09",
    usage: {
      inputUnits: 20,
      outputUnits: 8,
      estimatedCostMinor: 5,
      currencyCode: "USD",
    },
  };
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(responsePayload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const {
    generateSocialCreative,
    socialCreativeFailureFromThrown,
  } = await import("../src/lib/socialCreativeAdapter");
  const caption = await generateSocialCreative(baseJob);
  assert.equal(caption.ok, true);
  if (!caption.ok || caption.state !== "COMPLETED")
    throw new Error("expected completed caption");
  assert.deepEqual(caption.output, {
    kind: "CAPTION",
    text: "Doğrulanmış yaratıcı metin",
  });
  assert.equal(new URL(calls[0].url).hostname, "creative.example.test");
  assert.equal(calls[0].init?.redirect, "error");
  assert.equal(calls[0].init?.method, "POST");
  assert.equal(
    (calls[0].init?.headers as Record<string, string>)["idempotency-key"],
    `${baseJob.id}:create`,
  );
  assert.deepEqual(
    Object.keys(JSON.parse(String(calls[0].init?.body))).sort(),
    [
      "aspectRatio",
      "currencyCode",
      "durationSeconds",
      "integrationKey",
      "locale",
      "maxCostMinor",
      "model",
      "negativePrompt",
      "outputKind",
      "prompt",
      "provider",
      "requestId",
    ].sort(),
  );

  responsePayload = {
    state: "PENDING",
    receiptId: "creative-receipt-pending-0001",
    jobId: "provider-job-001",
  };
  const pending = await generateSocialCreative({
    ...baseJob,
    attemptNumber: 2,
    providerJobRef: "provider-job-001",
  });
  assert.equal(pending.ok, true);
  if (!pending.ok || pending.state !== "PENDING")
    throw new Error("expected pending job");
  assert.equal(pending.providerJobRef, "provider-job-001");
  assert.equal(
    (calls[1].init?.headers as Record<string, string>)["idempotency-key"],
    `${baseJob.id}:poll:2`,
  );

  responsePayload = {
    state: "PENDING",
    receiptId: "creative-receipt-pending-0002",
    jobId: "different-provider-job",
  };
  const mismatchedJob = await generateSocialCreative({
    ...baseJob,
    attemptNumber: 3,
    providerJobRef: "provider-job-001",
  });
  assert.deepEqual(mismatchedJob, {
    ok: false,
    retryable: false,
    errorCode: "PROVIDER_JOB_REFERENCE_MISMATCH",
  });

  responsePayload = { state: "COMPLETED", receiptId: "too-short" };
  const invalid = await generateSocialCreative(baseJob);
  assert.deepEqual(invalid, {
    ok: false,
    retryable: false,
    errorCode: "PROVIDER_RESPONSE_SCHEMA_INVALID",
  });

  responsePayload = {
    state: "COMPLETED",
    receiptId: "creative-receipt-over-budget-0001",
    outputKind: "CAPTION",
    text: "Too expensive",
    usage: { estimatedCostMinor: 101, currencyCode: "USD" },
  };
  const overBudget = await generateSocialCreative(baseJob);
  assert.deepEqual(overBudget, {
    ok: false,
    retryable: false,
    errorCode: "PROVIDER_COST_LIMIT_VIOLATION",
  });

  process.env.ALLOW_LIVE_INTEGRATIONS = "false";
  await assert.rejects(
    generateSocialCreative(baseJob),
    /LIVE_INTEGRATIONS_DISABLED/,
  );
  assert.deepEqual(
    socialCreativeFailureFromThrown(new TypeError("network details")),
    {
      ok: false,
      retryable: true,
      errorCode: "PROVIDER_EXECUTION_ERROR",
    },
  );
});

test("creative media download is same-host, bounded and hash-verified", async () => {
  enableCreativeGateway();
  const bytes = Buffer.from("verified-image-fixture");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let assetHash = sha256;
  let invalidPath = false;
  const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/v1/creative-assets/")) {
      assert.equal(init?.redirect, "error");
      return new Response(bytes, {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": String(bytes.byteLength),
        },
      });
    }
    return new Response(
      JSON.stringify({
        state: "COMPLETED",
        receiptId: "creative-receipt-image-0001",
        outputKind: "IMAGE",
        usage: { estimatedCostMinor: 7, currencyCode: "USD" },
        asset: {
          downloadPath: invalidPath
            ? "https://attacker.example.test/file.png"
            : "/v1/creative-assets/verified.png",
          fileName: "verified.png",
          mimeType: "image/png",
          sizeBytes: bytes.byteLength,
          sha256: assetHash,
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const { generateSocialCreative } = await import(
    "../src/lib/socialCreativeAdapter"
  );
  const result = await generateSocialCreative({
    ...baseJob,
    outputKind: "IMAGE",
    aspectRatio: "1:1",
  });
  assert.equal(result.ok, true);
  if (!result.ok || result.state !== "COMPLETED")
    throw new Error("expected completed image");
  assert.equal(result.output.kind, "IMAGE");
  assert.equal(calls.length, 2);
  assert.ok(
    calls.every((url) => new URL(url).hostname === "creative.example.test"),
  );

  assetHash = "f".repeat(64);
  const hashMismatch = await generateSocialCreative({
    ...baseJob,
    outputKind: "IMAGE",
    aspectRatio: "1:1",
  });
  assert.deepEqual(hashMismatch, {
    ok: false,
    retryable: false,
    errorCode: "SOCIAL_CREATIVE_ASSET_HASH_MISMATCH",
  });

  assetHash = sha256;
  invalidPath = true;
  const pathRejected = await generateSocialCreative({
    ...baseJob,
    outputKind: "IMAGE",
    aspectRatio: "1:1",
  });
  assert.deepEqual(pathRejected, {
    ok: false,
    retryable: false,
    errorCode: "PROVIDER_RESPONSE_SCHEMA_INVALID",
  });

  process.env.SOCIAL_CREATIVE_ALLOWED_HOST = "different.example.test";
  await assert.rejects(
    generateSocialCreative(baseJob),
    /SOCIAL_CREATIVE_ENDPOINT_INVALID/,
  );
});
