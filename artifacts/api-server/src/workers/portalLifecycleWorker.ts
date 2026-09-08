import os from "node:os";
import { pool } from "@workspace/db";
import {
  claimNextPortalWorkerJob,
  completePortalWorkerJob,
  currentPortalRuntimeReleaseId,
  failPortalWorkerJob,
  parsePortalWorkerExecutionModes,
  recordPortalWorkerHeartbeat,
} from "@workspace/portal-runner";
import {
  enqueueApprovedPortalLifecycleProposals,
  executeApprovedPortalLifecycleProposal,
} from "../lib/portalLifecycleExecution.js";

const POLL_MS = Math.max(1_000, Number(process.env.PORTAL_LIFECYCLE_WORKER_POLL_MS) || 5_000);
const WORKER_ID = `${os.hostname()}-lifecycle-${process.pid}`;
const configuredReleaseId = currentPortalRuntimeReleaseId();
if (!configuredReleaseId) throw new Error("PORTAL_WORKER_RELEASE_INVALID");
const RELEASE_ID: string = configuredReleaseId;
const configuredModeSource = process.env.PORTAL_LIFECYCLE_WORKER_MODES?.trim();
if (!configuredModeSource) throw new Error("PORTAL_LIFECYCLE_WORKER_MODE_CONFIG_REQUIRED");
const modes = parsePortalWorkerExecutionModes(configuredModeSource);
if (!modes.has("lifecycle_execute")) {
  throw new Error("PORTAL_LIFECYCLE_WORKER_MODE_DISABLED");
}
if ([...modes].some((mode) => mode !== "lifecycle_execute")) {
  throw new Error("PORTAL_LIFECYCLE_WORKER_MODE_SCOPE_INVALID");
}
const executionModes = new Set(["lifecycle_execute"] as const);
let stopping = false;
let activeJob: Promise<void> | null = null;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processOne(): Promise<void> {
  const job = await claimNextPortalWorkerJob({
    workerId: WORKER_ID,
    supportedKinds: ["lifecycle_execute"],
  });
  if (!job) return;
  try {
    const proposalId = Number(job.payload.proposalId);
    if (!Number.isSafeInteger(proposalId) || proposalId <= 0) {
      throw new Error("PORTAL_LIFECYCLE_PROPOSAL_ID_INVALID");
    }
    const result = await executeApprovedPortalLifecycleProposal(proposalId);
    await completePortalWorkerJob({ job, workerId: WORKER_ID, evidence: result });
  } catch {
    await failPortalWorkerJob({
      job,
      workerId: WORKER_ID,
      errorCode: "PORTAL_LIFECYCLE_EXECUTION_FAILED",
    });
  }
}

async function loop(): Promise<void> {
  console.log(`[portal-lifecycle-worker] Starting — id=${WORKER_ID} release=${RELEASE_ID}`);
  while (!stopping) {
    try {
      await recordPortalWorkerHeartbeat({
        workerId: WORKER_ID,
        releaseId: RELEASE_ID,
        executionModes,
      });
      await enqueueApprovedPortalLifecycleProposals();
      activeJob = processOne();
      await activeJob;
    } catch {
      console.error("[portal-lifecycle-worker] Tick failed with a redacted infrastructure error");
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
