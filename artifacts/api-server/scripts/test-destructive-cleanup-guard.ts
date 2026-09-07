import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cleanupScriptUrl = new URL(
  "../../../lib/db/cleanup-data.mjs",
  import.meta.url,
);
const cleanupScriptPath = fileURLToPath(cleanupScriptUrl);
const cleanupScriptSource = readFileSync(cleanupScriptUrl, "utf8");
const runtimeCleanupSource = readFileSync(
  new URL("../src/lib/dataCleanup.ts", import.meta.url),
  "utf8",
);
const apiIndexSource = readFileSync(
  new URL("../src/index.ts", import.meta.url),
  "utf8",
);
const deployScriptSource = readFileSync(
  new URL("../../../deploy/deploy.sh", import.meta.url),
  "utf8",
);
const postMergeScriptSource = readFileSync(
  new URL("../../../scripts/post-merge.sh", import.meta.url),
  "utf8",
);
const embedDuplicateCleanupSource = readFileSync(
  new URL("./cleanup-embed-duplicates.ts", import.meta.url),
  "utf8",
);
const publicLeadCleanupSource = readFileSync(
  new URL("./cleanup-public-lead-duplicates.ts", import.meta.url),
  "utf8",
);
const assignmentBackfillSource = readFileSync(
  new URL("./sync-assignment-backfill.ts", import.meta.url),
  "utf8",
);

test("manual cleanup requires the exact destructive cleanup flag before DB access", () => {
  for (const value of [undefined, "", "false", "1", "yes", "TRUE"]) {
    const env = { ...process.env };
    delete env.DATABASE_URL;
    if (value === undefined) delete env.ALLOW_DESTRUCTIVE_DATA_CLEANUP;
    else env.ALLOW_DESTRUCTIVE_DATA_CLEANUP = value;

    const result = spawnSync(process.execPath, [cleanupScriptPath], {
      env,
      encoding: "utf8",
    });
    assert.equal(result.status, 1, `value=${String(value)}`);
    assert.match(result.stderr, /ALLOW_DESTRUCTIVE_DATA_CLEANUP=true is required/);
    assert.doesNotMatch(result.stderr, /DATABASE_URL not set/);
  }

  const allowed = spawnSync(process.execPath, [cleanupScriptPath], {
    env: {
      ...process.env,
      ALLOW_DESTRUCTIVE_DATA_CLEANUP: "true",
      DATABASE_URL: "",
    },
    encoding: "utf8",
  });
  assert.equal(allowed.status, 0);
  assert.match(allowed.stderr, /DATABASE_URL not set/);
});

test("runtime cleanup has an independent exact-match production guard", () => {
  assert.match(
    runtimeCleanupSource,
    /process\.env\[CLEANUP_FLAG\] !== "true"/,
  );
  assert.match(runtimeCleanupSource, /process\.env\.NODE_ENV === "production"/);
  assert.match(runtimeCleanupSource, /throw new Error\(message\)/);
});

test("API boot and deployment never invoke destructive cleanup automatically", () => {
  assert.doesNotMatch(apiIndexSource, /runDataCleanupOnce/);
  assert.doesNotMatch(deployScriptSource, /cleanup-data\.mjs/);
  assert.doesNotMatch(deployScriptSource, /ALLOW_DESTRUCTIVE_DATA_CLEANUP/);
  assert.doesNotMatch(postMergeScriptSource, /cleanup-(?:embed-duplicates|public-lead-duplicates)/);
  assert.doesNotMatch(postMergeScriptSource, /sync-assignment-backfill/);
});

test("both cleanup implementations retain the shared explicit flag contract", () => {
  assert.match(cleanupScriptSource, /ALLOW_DESTRUCTIVE_DATA_CLEANUP/);
  assert.match(runtimeCleanupSource, /ALLOW_DESTRUCTIVE_DATA_CLEANUP/);
  assert.match(embedDuplicateCleanupSource, /ALLOW_DESTRUCTIVE_DATA_CLEANUP/);
  assert.match(publicLeadCleanupSource, /ALLOW_DESTRUCTIVE_DATA_CLEANUP/);
  assert.match(assignmentBackfillSource, /ALLOW_ASSIGNMENT_BACKFILL/);
});
