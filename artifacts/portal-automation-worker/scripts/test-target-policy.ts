import assert from "node:assert/strict";
import { test } from "node:test";

import { buildPortalWorkerTargetSets } from "../src/targetPolicy.js";

test("claims only active enabled graduated portals but reconciles every known portal", () => {
  const result = buildPortalWorkerTargetSets(
    [
      { universityKey: "topkapi_university", adapterKey: "topkapi", autoProcess: true, isActive: true, verificationReady: true },
      { universityKey: "isik_university", adapterKey: "isik", autoProcess: false, isActive: true, verificationReady: true },
      { universityKey: "disabled", adapterKey: "disabled_adapter", autoProcess: true, isActive: false, verificationReady: true },
      { universityKey: "experimental", adapterKey: "exp_adapter", autoProcess: true, isActive: true, verificationReady: true },
      { universityKey: "stale_proof", adapterKey: "stale_adapter", autoProcess: true, isActive: true, verificationReady: false },
    ],
    new Set(["exp_adapter"]),
  );

  assert.deepEqual(result.claimKeys, ["topkapi_university"]);
  assert.deepEqual(result.reconcileKeys, [
    "topkapi_university",
    "topkapi",
    "isik_university",
    "isik",
    "disabled",
    "disabled_adapter",
    "experimental",
    "exp_adapter",
    "stale_proof",
    "stale_adapter",
  ]);
});

test("aliases are deduplicated without widening the claim allowlist", () => {
  const result = buildPortalWorkerTargetSets(
    [
      { universityKey: "sit", adapterKey: "sit", autoProcess: true, isActive: true, verificationReady: true },
      { universityKey: "study_in_turkey", adapterKey: "sit", autoProcess: false, isActive: true, verificationReady: false },
    ],
    new Set(),
  );

  assert.deepEqual(result.claimKeys, ["sit"]);
  assert.deepEqual(result.reconcileKeys, ["sit", "study_in_turkey"]);
});
