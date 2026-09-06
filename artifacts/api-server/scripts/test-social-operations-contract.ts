import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";

import {
  assertSocialProviderAllowed,
  nextSocialId,
  normalizeSocialErrorCode,
  resolveSocialOperationsConfiguration,
  resolveSocialPerformanceGate,
  resolveSocialProviderConnectionGate,
  resolveSocialPublicationGate,
  socialHash,
  socialPerformanceCadenceMs,
  socialPerformanceIntervalMs,
  socialPerformanceMaxAgeDays,
  socialRetryDelayMs,
  socialRetryDisposition,
  socialWorkerFailureCode,
  socialWorkerHeartbeatIntervalMs,
  socialWorkerRetryDelayMs,
} from "../src/lib/socialOperationsContract";
import { DEFAULT_ROLE_PERMISSIONS } from "../../../lib/db/src/schema/roles";
import {
  assertSocialContentMedia,
  socialMediaSyntheticFileName,
  validateSocialMediaMetadata,
  verifyStoredSocialMediaRefs,
} from "../src/lib/socialMediaAssets";

const TENANT_ID = "018f47d2-4e80-7a4c-8bc4-112233445566";
const ORGANIZATION_ID = "018f47d2-4e81-7a4c-8bc4-112233445566";

test("production defaults social operations to fail-closed off", () => {
  assert.deepEqual(
    resolveSocialOperationsConfiguration({
      nodeEnv: "production",
      tenantId: TENANT_ID,
      organizationId: ORGANIZATION_ID,
    }),
    {
      enabled: false,
      mode: "off",
      reason: "SOCIAL_OPERATIONS_DISABLED",
    },
  );
});

test("manage mode requires exact UUIDv7 tenant and organization scope", () => {
  assert.equal(
    resolveSocialOperationsConfiguration({
      configuredMode: "manage",
      tenantId: "not-a-tenant",
      organizationId: ORGANIZATION_ID,
    }).reason,
    "SOCIAL_OPERATIONS_TENANT_INVALID",
  );
  assert.deepEqual(
    resolveSocialOperationsConfiguration({
      configuredMode: "manage",
      tenantId: TENANT_ID,
      organizationId: ORGANIZATION_ID,
    }),
    { enabled: true, mode: "manage", reason: null },
  );
});

test("generated ids are UUIDv7 and hashes use canonical key ordering", () => {
  assert.match(
    nextSocialId(1_789_545_600_000),
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(
    socialHash({ b: 2, nested: { z: 1, a: 3 }, a: 1 }),
    socialHash({ a: 1, nested: { a: 3, z: 1 }, b: 2 }),
  );
});

test("legacy transition permissions separate management from approval", () => {
  assert.ok(DEFAULT_ROLE_PERMISSIONS.admin.includes("social.approve"));
  assert.ok(DEFAULT_ROLE_PERMISSIONS.manager.includes("social.manage"));
  assert.equal(
    DEFAULT_ROLE_PERMISSIONS.manager.includes("social.approve"),
    false,
  );
});

test("publication execution needs all explicit kill switches and an allowlist", () => {
  const disabled = resolveSocialPublicationGate({
    workerEnabled: "true",
    connectivityEnabled: "true",
    providerPublishingEnabled: "true",
    allowLiveIntegrations: "false",
    providerAllowlist: "meta",
  });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.reason, "LIVE_INTEGRATIONS_DISABLED");
  const enabled = resolveSocialPublicationGate({
    workerEnabled: "true",
    connectivityEnabled: "true",
    providerPublishingEnabled: "true",
    allowLiveIntegrations: "true",
    providerAllowlist: "meta,linkedin,meta",
  });
  assert.deepEqual(enabled.allowedProviders, ["meta", "linkedin"]);
  assert.doesNotThrow(() => assertSocialProviderAllowed(enabled, "META"));
  assert.throws(
    () => assertSocialProviderAllowed(enabled, "tiktok"),
    /SOCIAL_PROVIDER_NOT_ALLOWED/,
  );
});

test("provider connectivity and performance cadence are independently fail-closed", () => {
  assert.equal(
    resolveSocialProviderConnectionGate({
      connectivityEnabled: "false",
      allowLiveIntegrations: "true",
      providerAllowlist: "meta",
    }).reason,
    "SOCIAL_PROVIDER_CONNECTIVITY_DISABLED",
  );
  assert.deepEqual(
    resolveSocialProviderConnectionGate({
      connectivityEnabled: "true",
      allowLiveIntegrations: "true",
      providerAllowlist: "meta,linkedin,meta",
    }),
    {
      enabled: true,
      connectivityEnabled: true,
      allowedProviders: ["meta", "linkedin"],
      reason: null,
    },
  );
  assert.equal(
    resolveSocialPerformanceGate({
      workerEnabled: "false",
      connectivityEnabled: "true",
      allowLiveIntegrations: "true",
      providerAllowlist: "meta",
    }).reason,
    "SOCIAL_PERFORMANCE_WORKER_DISABLED",
  );
  assert.equal(
    resolveSocialPerformanceGate({
      workerEnabled: "true",
      connectivityEnabled: "true",
      allowLiveIntegrations: "true",
      providerAllowlist: "meta",
    }).enabled,
    true,
  );
  assert.equal(socialPerformanceIntervalMs(undefined), 21_600_000);
  assert.equal(socialPerformanceIntervalMs("900"), 900_000);
  assert.equal(socialPerformanceMaxAgeDays(undefined), 180);
  assert.equal(
    socialPerformanceCadenceMs({
      baseIntervalSeconds: "21600",
      publicationAgeMs: 8 * 86_400_000,
    }),
    86_400_000,
  );
  assert.equal(
    socialPerformanceCadenceMs({
      baseIntervalSeconds: "21600",
      publicationAgeMs: 31 * 86_400_000,
    }),
    604_800_000,
  );
  assert.throws(() => socialPerformanceIntervalMs("899"));
  assert.throws(() => socialPerformanceMaxAgeDays("0"));
  assert.throws(() => socialPerformanceIntervalMs("not-a-number"));
  assert.equal(socialWorkerHeartbeatIntervalMs(undefined), 30_000);
  assert.equal(socialWorkerHeartbeatIntervalMs("10"), 10_000);
  assert.throws(() => socialWorkerHeartbeatIntervalMs("9"));
});

test("retry policy is bounded and dead-letters exhausted or permanent failures", () => {
  assert.equal(socialRetryDelayMs(1), 30_000);
  assert.equal(socialRetryDelayMs(12), 6 * 60 * 60 * 1000);
  assert.equal(
    socialRetryDisposition({
      attemptNumber: 2,
      maxAttempts: 5,
      retryable: true,
    }),
    "RETRY",
  );
  assert.equal(
    socialRetryDisposition({
      attemptNumber: 5,
      maxAttempts: 5,
      retryable: true,
    }),
    "DEAD_LETTER",
  );
  assert.equal(
    socialRetryDisposition({
      attemptNumber: 1,
      maxAttempts: 5,
      retryable: false,
    }),
    "DEAD_LETTER",
  );
  assert.equal(
    normalizeSocialErrorCode("provider_http_429"),
    "PROVIDER_HTTP_429",
  );
  assert.throws(() => normalizeSocialErrorCode("contains secret=value"));
  assert.equal(socialWorkerRetryDelayMs(1), 1_000);
  assert.equal(socialWorkerRetryDelayMs(12), 30_000);
  assert.equal(
    socialWorkerFailureCode(new Error("SOCIAL_TRANSACTION_RETRY_EXHAUSTED")),
    "SOCIAL_TRANSACTION_RETRY_EXHAUSTED",
  );
  assert.equal(
    socialWorkerFailureCode(new Error("provider secret leaked=value")),
    "SOCIAL_WORKER_INFRASTRUCTURE_ERROR",
  );
});

test("social media metadata and content-kind preflight are fail-closed", () => {
  assert.deepEqual(
    validateSocialMediaMetadata({
      fileName: "campaign.MP4",
      mimeType: "video/mp4",
      sizeBytes: 25 * 1024 * 1024,
    }),
    {
      kind: "video",
      mimeType: "video/mp4",
      sizeBytes: 25 * 1024 * 1024,
      permanentExtension: ".mp4",
    },
  );
  assert.equal(socialMediaSyntheticFileName("image/webp"), "upload.webp");
  assert.throws(() =>
    validateSocialMediaMetadata({
      fileName: "campaign.exe",
      mimeType: "video/mp4",
      sizeBytes: 1024,
    }),
  );
  const video = {
    kind: "video" as const,
    ref: `/objects/social-media/assets/${TENANT_ID}/${ORGANIZATION_ID}/${"a".repeat(64)}.mp4`,
  };
  assert.doesNotThrow(() => assertSocialContentMedia("REEL", [video]));
  assert.throws(
    () => assertSocialContentMedia("REEL", []),
    /SOCIAL_MEDIA_VIDEO_REQUIRED/,
  );
  assert.throws(
    () =>
      assertSocialContentMedia("POST", [
        { kind: "image", ref: "https://untrusted.example/media.jpg" },
      ]),
    /SOCIAL_MEDIA_REFERENCE_INVALID/,
  );
});

test("publication media storage preflight detects missing or changed bytes", async () => {
  const bytes = Buffer.from("immutable-social-media-fixture");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const ref = `/objects/social-media/assets/${TENANT_ID}/${ORGANIZATION_ID}/${sha256}.mp4`;
  const storage = {
    async getObjectEntityFile() {
      return {
        createReadStream: () => Readable.from([bytes]),
        getMetadata: async () => [
          { contentType: "video/mp4", size: bytes.length },
        ],
      };
    },
  };
  await assert.doesNotReject(() =>
    verifyStoredSocialMediaRefs(
      [{ kind: "video", ref }],
      storage as never,
    ),
  );
  const changedStorage = {
    async getObjectEntityFile() {
      return {
        createReadStream: () => Readable.from([Buffer.from("changed")]),
        getMetadata: async () => [
          { contentType: "video/mp4", size: bytes.length },
        ],
      };
    },
  };
  await assert.rejects(
    verifyStoredSocialMediaRefs(
      [{ kind: "video", ref }],
      changedStorage as never,
    ),
    /SOCIAL_MEDIA_SIZE_MISMATCH|SOCIAL_MEDIA_CONTENT_MISMATCH/,
  );
});
