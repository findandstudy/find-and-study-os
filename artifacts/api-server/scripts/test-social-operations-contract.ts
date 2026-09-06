import assert from "node:assert/strict";
import test from "node:test";

import {
  assertSocialProviderAllowed,
  nextSocialId,
  normalizeSocialErrorCode,
  resolveSocialOperationsConfiguration,
  resolveSocialPublicationGate,
  socialHash,
  socialRetryDelayMs,
  socialRetryDisposition,
} from "../src/lib/socialOperationsContract";
import { DEFAULT_ROLE_PERMISSIONS } from "../../../lib/db/src/schema/roles";

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
    providerPublishingEnabled: "true",
    allowLiveIntegrations: "false",
    providerAllowlist: "meta",
  });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.reason, "LIVE_INTEGRATIONS_DISABLED");
  const enabled = resolveSocialPublicationGate({
    workerEnabled: "true",
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
});
