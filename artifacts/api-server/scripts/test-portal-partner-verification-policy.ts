import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { pool } from "@workspace/db";
import {
  currentPortalRuntimeReleaseId,
  latestPortalPartnerReceiptPassed,
} from "@workspace/portal-runner";

const originalReleaseId = process.env.RELEASE_ID;

beforeEach(() => {
  delete process.env.RELEASE_ID;
});

after(async () => {
  if (originalReleaseId === undefined) delete process.env.RELEASE_ID;
  else process.env.RELEASE_ID = originalReleaseId;
  await pool.end();
});

test("PVR1: runtime identity is explicit, bounded and character restricted", () => {
  assert.equal(currentPortalRuntimeReleaseId(), null);
  process.env.RELEASE_ID = "staging-20260905T120000Z-abcdef12";
  assert.equal(
    currentPortalRuntimeReleaseId(),
    "staging-20260905T120000Z-abcdef12",
  );
  process.env.RELEASE_ID = "unsafe release id";
  assert.equal(currentPortalRuntimeReleaseId(), null);
  process.env.RELEASE_ID = "x".repeat(81);
  assert.equal(currentPortalRuntimeReleaseId(), null);
});

test("PVR2: newest current-binding result wins for each verification type", () => {
  const receipts = [
    { verificationType: "TEST_LOGIN", outcome: "FAILED" },
    { verificationType: "STRICT_DRY_RUN", outcome: "PASSED" },
    { verificationType: "TEST_LOGIN", outcome: "PASSED" },
  ];
  assert.equal(latestPortalPartnerReceiptPassed(receipts, "TEST_LOGIN"), false);
  assert.equal(latestPortalPartnerReceiptPassed(receipts, "STRICT_DRY_RUN"), true);
});

test("PVR3: missing or unknown outcomes fail closed", () => {
  assert.equal(latestPortalPartnerReceiptPassed([], "TEST_LOGIN"), false);
  assert.equal(
    latestPortalPartnerReceiptPassed(
      [{ verificationType: "TEST_LOGIN", outcome: "UNKNOWN" }],
      "TEST_LOGIN",
    ),
    false,
  );
});
