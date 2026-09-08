import os from "node:os";
import { pool } from "@workspace/db";
import {
  claimNextPortalWorkerJob,
  completePortalWorkerJob,
  currentPortalRuntimeReleaseId,
  enqueuePortalWorkerJob,
  failPortalWorkerJob,
  parsePortalWorkerExecutionModes,
  recordPortalWorkerHeartbeat,
} from "@workspace/portal-runner";
import { runPortalStatusSync } from "../routes/portalAutomation.js";

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const POLL_MS = positiveInt(process.env.PORTAL_STATUS_WORKER_POLL_MS, 5_000);
const SWEEP_INTERVAL_MS = positiveInt(
  process.env.PORTAL_STATUS_SWEEP_INTERVAL_MS,
  10 * 60_000,
);
const WORKER_ID = `${os.hostname()}-status-${process.pid}`;
const configuredReleaseId = currentPortalRuntimeReleaseId();
if (!configuredReleaseId) throw new Error("PORTAL_WORKER_RELEASE_INVALID");
const RELEASE_ID: string = configuredReleaseId;
const configuredModeSource = process.env.PORTAL_STATUS_WORKER_MODES?.trim();
if (!configuredModeSource) throw new Error("PORTAL_STATUS_WORKER_MODE_CONFIG_REQUIRED");
const configuredModes = parsePortalWorkerExecutionModes(configuredModeSource);
if (!configuredModes.has("status_check")) {
  throw new Error("PORTAL_STATUS_WORKER_MODE_DISABLED");
}
if ([...configuredModes].some((mode) => mode !== "status_check" && mode !== "artifact")) {
  throw new Error("PORTAL_STATUS_WORKER_MODE_SCOPE_INVALID");
}
const executionModes = new Set(
  [...configuredModes].filter((mode) => mode === "status_check" || mode === "artifact"),
);
let stopping = false;
let activeJob: Promise<void> | null = null;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function scheduleCurrentSweep(): Promise<void> {
  const bucket = Math.floor(Date.now() / SWEEP_INTERVAL_MS);
  await enqueuePortalWorkerJob({
    kind: "status_sweep",
    portalUniversityId: null,
    requestKey: `scheduled:${bucket}`,
    requestedBy: null,
    payload: { source: "schedule" },
  });
}

async function processOneJob(): Promise<void> {
  const job = await claimNextPortalWorkerJob({
    workerId: WORKER_ID,
    supportedKinds: ["status_sweep"],
  });
  if (!job) return;
  try {
    const result = await runPortalStatusSync({
      allowArtifacts: executionModes.has("artifact"),
    });
    await completePortalWorkerJob({ job, workerId: WORKER_ID, evidence: result });
  } catch {
    await failPortalWorkerJob({
      job,
      workerId: WORKER_ID,
      errorCode: "PORTAL_STATUS_SWEEP_FAILED",
    });
  }
}

async function loop(): Promise<void> {
  console.log(
    `[portal-status-worker] Starting — id=${WORKER_ID} release=${RELEASE_ID}` +
      ` modes=${[...executionModes].sort().join(",")}`,
  );
  while (!stopping) {
    try {
      await recordPortalWorkerHeartbeat({
        workerId: WORKER_ID,
        releaseId: RELEASE_ID,
        executionModes,
      });
      await scheduleCurrentSweep();
      activeJob = processOneJob();
      await activeJob;
    } catch {
      console.error("[portal-status-worker] Tick failed with a redacted infrastructure error");
    } finally {
      activeJob = null;
    }
    if (!stopping) await wait(POLL_MS);
  }
}

async function shutdown(): Promise<void> {
  stopping = true;
  await activeJob?.catch(() => undefined);
  await pool.end().catch(() => undefined);
}

process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());

loop().catch(() => {
  process.exitCode = 1;
  void shutdown();
});
