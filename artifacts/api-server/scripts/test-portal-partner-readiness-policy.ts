import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computePortalPartnerReadiness,
  safePortalHttpsUrl,
  type PortalPartnerReadinessInput,
} from "../src/lib/portalPartnerReadinessPolicy.js";

const READY: PortalPartnerReadinessInput = {
  adapterRegistered: true,
  portalUrl: "https://partner.example/login",
  hasCredentials: true,
  catalogLinked: true,
  activeProgramCount: 4,
  graduationRequired: true,
  successCount: 0,
  graduationThreshold: 3,
  runtimeIdentityReady: true,
  testLoginPassed: true,
  strictDryRunCapable: true,
  strictDryRunPassed: true,
  isActive: true,
  autoProcess: false,
};

test("PPR1: missing setup facts fail closed with every actionable blocker", () => {
  const result = computePortalPartnerReadiness({
    ...READY,
    adapterRegistered: false,
    portalUrl: null,
    hasCredentials: false,
    catalogLinked: false,
    activeProgramCount: 0,
    runtimeIdentityReady: false,
    isActive: false,
  });
  assert.equal(result.configurationReady, false);
  assert.equal(result.manualPilotEligible, false);
  assert.equal(result.automaticEligible, false);
  assert.equal(result.phase, "configuration_required");
  assert.deepEqual(result.blockers, [
    "ADAPTER_REQUIRED",
    "SECURE_PORTAL_URL_REQUIRED",
    "CREDENTIALS_REQUIRED",
    "CATALOG_LINK_REQUIRED",
    "ACTIVE_PROGRAM_REQUIRED",
    "RUNTIME_IDENTITY_REQUIRED",
  ]);
});

test("PPR2: portal URL accepts only credential-free HTTPS origins", () => {
  assert.equal(safePortalHttpsUrl("http://partner.example/login"), null);
  assert.equal(safePortalHttpsUrl("https://user:pass@partner.example/login"), null);
  assert.equal(safePortalHttpsUrl("not a url"), null);
  assert.equal(
    safePortalHttpsUrl("https://partner.example/login"),
    "https://partner.example/login",
  );
});

test("PPR3: configured experimental adapter remains manual-only at zero proofs", () => {
  const result = computePortalPartnerReadiness(READY);
  assert.equal(result.configurationReady, true);
  assert.equal(result.manualPilotEligible, true);
  assert.equal(result.automaticEligible, false);
  assert.equal(result.successProofsRemaining, 3);
  assert.equal(result.phase, "manual_pilot");
  assert.deepEqual(result.requiredVerifications, ["TEST_LOGIN", "STRICT_DRY_RUN"]);
});

test("PPR4: proof progress is bounded and does not graduate early", () => {
  const result = computePortalPartnerReadiness({ ...READY, successCount: 2 });
  assert.equal(result.successProofsRemaining, 1);
  assert.equal(result.automaticEligible, false);
  assert.equal(result.phase, "manual_pilot");
});

test("PPR5: three proofs unlock automation eligibility but do not enable it", () => {
  const result = computePortalPartnerReadiness({ ...READY, successCount: 3 });
  assert.equal(result.successProofsRemaining, 0);
  assert.equal(result.automaticEligible, true);
  assert.equal(result.phase, "automation_ready");
});

test("PPR6: trusted adapter with complete setup can wait inactive for activation", () => {
  const result = computePortalPartnerReadiness({
    ...READY,
    graduationRequired: false,
    isActive: false,
  });
  assert.equal(result.automaticEligible, true);
  assert.equal(result.manualPilotEligible, false);
  assert.equal(result.phase, "activation_ready");
});

test("PPR7: automated phase requires both eligibility and auto-process state", () => {
  const result = computePortalPartnerReadiness({
    ...READY,
    successCount: 8,
    autoProcess: true,
  });
  assert.equal(result.automaticEligible, true);
  assert.equal(result.phase, "automated");
});

test("PPR8: negative counters cannot manufacture or over-require proof", () => {
  assert.equal(
    computePortalPartnerReadiness({ ...READY, successCount: -8 }).successProofsRemaining,
    3,
  );
  assert.equal(
    computePortalPartnerReadiness({ ...READY, successCount: 99 }).successProofsRemaining,
    0,
  );
});

test("PPR9: configuration never substitutes for a current test-login receipt", () => {
  const result = computePortalPartnerReadiness({
    ...READY,
    testLoginPassed: false,
    strictDryRunPassed: false,
    isActive: false,
  });
  assert.equal(result.configurationReady, true);
  assert.equal(result.activationEligible, false);
  assert.equal(result.phase, "test_login_required");
  assert.deepEqual(result.activationBlockers, ["TEST_LOGIN_REQUIRED"]);
});

test("PPR10: activation after login permits only strict dry-run onboarding", () => {
  const result = computePortalPartnerReadiness({
    ...READY,
    strictDryRunPassed: false,
  });
  assert.equal(result.activationEligible, true);
  assert.equal(result.manualPilotEligible, false);
  assert.equal(result.automaticEligible, false);
  assert.equal(result.phase, "strict_dry_run_required");
  assert.deepEqual(result.executionBlockers, ["STRICT_DRY_RUN_REQUIRED"]);
});

test("PPR11: a non-strict adapter cannot mint the required dry-run proof", () => {
  const result = computePortalPartnerReadiness({
    ...READY,
    strictDryRunCapable: false,
    strictDryRunPassed: false,
  });
  assert.equal(result.manualPilotEligible, false);
  assert.deepEqual(result.executionBlockers, ["STRICT_DRY_RUN_ADAPTER_REQUIRED"]);
});
