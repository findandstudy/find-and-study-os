import test from "node:test";
import assert from "node:assert/strict";
import {
  simulatedIntegrationTestResult,
  unsupportedIntegrationTestResult,
} from "../src/lib/integrationTestResult";

test("simulated checks can never be projected as success or verified", () => {
  const result = simulatedIntegrationTestResult("Live call skipped");
  assert.equal(result.status, "simulated");
  assert.equal(result.success, false);
  assert.equal(result.verified, false);
  assert.equal(result.simulated, true);
});

test("unsupported generic checks are explicit and fail closed", () => {
  const result = unsupportedIntegrationTestResult("No real verifier exists");
  assert.equal(result.status, "not_supported");
  assert.equal(result.success, false);
  assert.equal(result.verified, false);
});
