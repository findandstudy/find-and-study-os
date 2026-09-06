import assert from "node:assert/strict";
import test, { after } from "node:test";

const originalFetch = globalThis.fetch;
const originalEnvironment = {
  SOCIAL_PROVIDER_CONNECTIVITY_ENABLED:
    process.env.SOCIAL_PROVIDER_CONNECTIVITY_ENABLED,
  SOCIAL_PUBLICATION_WORKER_ENABLED:
    process.env.SOCIAL_PUBLICATION_WORKER_ENABLED,
  SOCIAL_PROVIDER_PUBLISHING_ENABLED:
    process.env.SOCIAL_PROVIDER_PUBLISHING_ENABLED,
  SOCIAL_PUBLICATION_PROVIDER_ALLOWLIST:
    process.env.SOCIAL_PUBLICATION_PROVIDER_ALLOWLIST,
  SOCIAL_PUBLISHER_BASE_URL: process.env.SOCIAL_PUBLISHER_BASE_URL,
  SOCIAL_PUBLISHER_ALLOWED_HOST: process.env.SOCIAL_PUBLISHER_ALLOWED_HOST,
  SOCIAL_PUBLISHER_TOKEN: process.env.SOCIAL_PUBLISHER_TOKEN,
  ALLOW_LIVE_INTEGRATIONS: process.env.ALLOW_LIVE_INTEGRATIONS,
};

after(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("managed social provider adapter is allowlisted, bounded and schema-strict", async () => {
  process.env.SOCIAL_PROVIDER_CONNECTIVITY_ENABLED = "true";
  process.env.SOCIAL_PUBLICATION_WORKER_ENABLED = "true";
  process.env.SOCIAL_PROVIDER_PUBLISHING_ENABLED = "true";
  process.env.SOCIAL_PUBLICATION_PROVIDER_ALLOWLIST = "meta";
  process.env.SOCIAL_PUBLISHER_BASE_URL = "https://publisher.example.test/";
  process.env.SOCIAL_PUBLISHER_ALLOWED_HOST = "publisher.example.test";
  process.env.SOCIAL_PUBLISHER_TOKEN = "test-token-never-log";
  process.env.ALLOW_LIVE_INTEGRATIONS = "true";

  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  let invalidMetrics = false;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    const payload = url.endsWith("/v1/accounts/verify")
      ? {
          receiptId: "verification-receipt-0001",
          externalAccountId: "provider-account-123",
          displayName: "Verified Account",
        }
      : url.endsWith("/v1/performance")
        ? {
            receiptId: "performance-receipt-0001",
            observedAt: new Date().toISOString(),
            metrics: invalidMetrics
              ? { impressions: -1 }
              : { impressions: 200, clicks: 12, leads: 2 },
          }
        : {
            receiptId: "publication-receipt-0001",
            postId: "provider-post-123",
          };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const {
    fetchSocialPerformance,
    publishSocialJob,
    socialPublisherFailureFromThrown,
    verifySocialAccount,
  } = await import("../src/lib/socialPublisherAdapter");
  assert.deepEqual(
    socialPublisherFailureFromThrown(new Error("SOCIAL_PROVIDER_NOT_ALLOWED")),
    {
      ok: false,
      retryable: false,
      errorCode: "SOCIAL_PROVIDER_NOT_ALLOWED",
    },
  );
  assert.deepEqual(socialPublisherFailureFromThrown(new TypeError("boom")), {
    ok: false,
    retryable: true,
    errorCode: "PROVIDER_EXECUTION_ERROR",
  });
  const verified = await verifySocialAccount({
    requestKey: "verify-account-0001",
    provider: "meta",
    accountKey: "meta:test",
    integrationKey: "meta_ads",
  });
  assert.equal(verified.ok, true);
  const published = await publishSocialJob({
    id: "0199a200-0000-7000-8000-000000000001",
    provider: "meta",
    accountKey: "meta:test",
    integrationKey: "meta_ads",
    title: "Test",
    caption: "Test",
    contentKind: "POST",
    locales: ["tr"],
    channels: ["instagram"],
    mediaRefs: [],
    utm: {},
    scheduledFor: new Date().toISOString(),
  });
  assert.equal(published.ok, true);
  const performance = await fetchSocialPerformance({
    idempotencyKey: "performance-account-0001",
    publicationId: "0199a200-0000-7000-8000-000000000001",
    provider: "meta",
    accountKey: "meta:test",
    integrationKey: "meta_ads",
  });
  assert.equal(performance.ok, true);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(new URL(call.url).hostname, "publisher.example.test");
    assert.equal(call.init?.redirect, "error");
    assert.equal(call.init?.method, "POST");
    assert.match(
      String((call.init?.headers as Record<string, string>)["idempotency-key"]),
      /\S/,
    );
  }

  invalidMetrics = true;
  const rejectedMetrics = await fetchSocialPerformance({
    idempotencyKey: "performance-account-0002",
    publicationId: "0199a200-0000-7000-8000-000000000001",
    provider: "meta",
    accountKey: "meta:test",
    integrationKey: "meta_ads",
  });
  assert.deepEqual(rejectedMetrics, {
    ok: false,
    retryable: false,
    errorCode: "PROVIDER_RESPONSE_SCHEMA_INVALID",
  });

  await assert.rejects(
    verifySocialAccount({
      requestKey: "verify-account-0002",
      provider: "not-allowed",
      accountKey: "other:test",
      integrationKey: "other",
    }),
    /SOCIAL_PROVIDER_NOT_ALLOWED/,
  );
  process.env.SOCIAL_PUBLICATION_WORKER_ENABLED = "false";
  await assert.rejects(
    publishSocialJob({
      id: "0199a200-0000-7000-8000-000000000002",
      provider: "meta",
      accountKey: "meta:test",
      integrationKey: "meta_ads",
      title: "Blocked",
      caption: "Blocked",
      contentKind: "POST",
      locales: ["tr"],
      channels: ["instagram"],
      mediaRefs: [],
      utm: {},
      scheduledFor: new Date().toISOString(),
    }),
    /SOCIAL_PUBLICATION_WORKER_DISABLED/,
  );
});
