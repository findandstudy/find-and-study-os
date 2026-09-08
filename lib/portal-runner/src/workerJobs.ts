import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import {
  db,
  pool,
  portalWorkerHeartbeatsTable,
  portalWorkerJobsTable,
} from "@workspace/db";
import { currentPortalRuntimeReleaseId } from "./partnerVerification.js";

export type PortalWorkerExecutionMode =
  | "test_login"
  | "dry"
  | "real"
  | "status_check"
  | "artifact"
  | "program_catalog_sync"
  | "lifecycle_execute";

export type PortalWorkerJobKind =
  | "test_login"
  | "status_sweep"
  | "program_catalog_sync"
  | "lifecycle_execute";

const ALL_EXECUTION_MODES = new Set<PortalWorkerExecutionMode>([
  "test_login",
  "dry",
  "real",
  "status_check",
  "artifact",
  "program_catalog_sync",
  "lifecycle_execute",
]);
const REQUEST_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/;
const ERROR_CODE_PATTERN = /^[A-Z0-9_:-]{1,80}$/;
const WORKER_HEARTBEAT_MAX_AGE_MS = 60_000;

function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
    .join(",")}}`;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

export function parsePortalWorkerExecutionModes(
  raw = process.env.WORKER_EXECUTION_MODES,
): ReadonlySet<PortalWorkerExecutionMode> {
  const source = raw?.trim() || "test_login,dry";
  const parsed = source
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (parsed.length === 0 || parsed.some((value) => !ALL_EXECUTION_MODES.has(value as PortalWorkerExecutionMode))) {
    throw new Error("WORKER_EXECUTION_MODES_INVALID");
  }
  return new Set(parsed as PortalWorkerExecutionMode[]);
}

export function requiredModeForPortalWorkerJob(
  kind: PortalWorkerJobKind,
): PortalWorkerExecutionMode {
  if (kind === "test_login") return "test_login";
  if (kind === "status_sweep") return "status_check";
  if (kind === "lifecycle_execute") return "lifecycle_execute";
  return "program_catalog_sync";
}

export class PortalWorkerUnavailableError extends Error {
  readonly code: "PORTAL_WORKER_UNAVAILABLE" | "PORTAL_WORKER_RELEASE_MISMATCH" | "PORTAL_WORKER_MODE_DISABLED";

  constructor(code: PortalWorkerUnavailableError["code"]) {
    super(code);
    this.name = "PortalWorkerUnavailableError";
    this.code = code;
  }
}

export class PortalWorkerJobIdempotencyConflictError extends Error {
  constructor() {
    super("PORTAL_WORKER_JOB_IDEMPOTENCY_CONFLICT");
    this.name = "PortalWorkerJobIdempotencyConflictError";
  }
}

export async function recordPortalWorkerHeartbeat(input: {
  workerId: string;
  releaseId: string;
  executionModes: ReadonlySet<PortalWorkerExecutionMode>;
}): Promise<void> {
  if (!input.workerId.trim() || input.workerId.length > 160) {
    throw new Error("PORTAL_WORKER_ID_INVALID");
  }
  if (currentPortalRuntimeReleaseId() !== input.releaseId) {
    throw new Error("PORTAL_WORKER_RELEASE_INVALID");
  }
  await db
    .insert(portalWorkerHeartbeatsTable)
    .values({
      workerKind: "portal_execution",
      workerId: input.workerId,
      runtimeReleaseId: input.releaseId,
      executionModes: [...input.executionModes].sort(),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        portalWorkerHeartbeatsTable.workerKind,
        portalWorkerHeartbeatsTable.workerId,
      ],
      set: {
        workerId: input.workerId,
        runtimeReleaseId: input.releaseId,
        executionModes: [...input.executionModes].sort(),
        updatedAt: new Date(),
      },
    });
}

export async function assertPortalWorkerReady(
  requiredMode: PortalWorkerExecutionMode,
): Promise<{ workerId: string; releaseId: string }> {
  const releaseId = currentPortalRuntimeReleaseId();
  if (!releaseId) throw new PortalWorkerUnavailableError("PORTAL_WORKER_RELEASE_MISMATCH");
  const heartbeats = await pool.query<{
    workerId: string;
    runtimeReleaseId: string;
    executionModes: string[];
  }>(
    `SELECT worker_id AS "workerId", runtime_release_id AS "runtimeReleaseId",
            execution_modes AS "executionModes"
       FROM portal_worker_heartbeats
      WHERE worker_kind = 'portal_execution'
        AND updated_at >= now() - ($1::int * interval '1 millisecond')`,
    [WORKER_HEARTBEAT_MAX_AGE_MS],
  );
  if (heartbeats.rows.length === 0) {
    throw new PortalWorkerUnavailableError("PORTAL_WORKER_UNAVAILABLE");
  }
  const releaseMatched = heartbeats.rows.filter((row) => row.runtimeReleaseId === releaseId);
  if (releaseMatched.length === 0) {
    throw new PortalWorkerUnavailableError("PORTAL_WORKER_RELEASE_MISMATCH");
  }
  const capable = releaseMatched.find((row) => row.executionModes.includes(requiredMode));
  if (!capable) {
    throw new PortalWorkerUnavailableError("PORTAL_WORKER_MODE_DISABLED");
  }
  return { workerId: capable.workerId, releaseId };
}

export async function enqueuePortalWorkerJob(input: {
  kind: PortalWorkerJobKind;
  portalUniversityId: number | null;
  requestKey: string;
  requestedBy: number | null;
  payload?: Record<string, unknown>;
}): Promise<{ id: number; replay: boolean; statusUrl: string }> {
  if (!REQUEST_KEY_PATTERN.test(input.requestKey)) {
    throw new Error("PORTAL_WORKER_REQUEST_KEY_INVALID");
  }
  const partnerless = input.kind === "status_sweep" || input.kind === "lifecycle_execute";
  if (partnerless ? input.portalUniversityId !== null : !Number.isSafeInteger(input.portalUniversityId) || input.portalUniversityId! <= 0) {
    throw new Error("PORTAL_WORKER_PARTNER_BINDING_INVALID");
  }
  const { releaseId } = await assertPortalWorkerReady(requiredModeForPortalWorkerJob(input.kind));
  const payload = input.payload ?? {};
  const payloadSha256 = sha256({
    kind: input.kind,
    portalUniversityId: input.portalUniversityId,
    releaseId,
    payload,
  });
  const [inserted] = await db
    .insert(portalWorkerJobsTable)
    .values({
      jobKind: input.kind,
      portalUniversityId: input.portalUniversityId,
      requestKey: input.requestKey,
      requestedReleaseId: releaseId,
      payloadSha256,
      payload,
      requestedBy: input.requestedBy,
    })
    .onConflictDoNothing()
    .returning({ id: portalWorkerJobsTable.id });
  if (inserted) {
    return {
      id: inserted.id,
      replay: false,
      statusUrl: `/api/portal-worker-jobs/${inserted.id}`,
    };
  }
  const [existing] = await db
    .select({
      id: portalWorkerJobsTable.id,
      requestedReleaseId: portalWorkerJobsTable.requestedReleaseId,
      payloadSha256: portalWorkerJobsTable.payloadSha256,
    })
    .from(portalWorkerJobsTable)
    .where(
      and(
        eq(portalWorkerJobsTable.jobKind, input.kind),
        input.portalUniversityId === null
          ? isNull(portalWorkerJobsTable.portalUniversityId)
          : eq(portalWorkerJobsTable.portalUniversityId, input.portalUniversityId),
        eq(portalWorkerJobsTable.requestKey, input.requestKey),
      ),
    )
    .limit(1);
  if (!existing || existing.requestedReleaseId !== releaseId || existing.payloadSha256 !== payloadSha256) {
    throw new PortalWorkerJobIdempotencyConflictError();
  }
  return { id: existing.id, replay: true, statusUrl: `/api/portal-worker-jobs/${existing.id}` };
}

export type ClaimedPortalWorkerJob = {
  id: number;
  jobKind: PortalWorkerJobKind;
  portalUniversityId: number | null;
  requestKey: string;
  requestedReleaseId: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  requestedBy: number | null;
};

export async function claimNextPortalWorkerJob(input: {
  workerId: string;
  supportedKinds: readonly PortalWorkerJobKind[];
}): Promise<ClaimedPortalWorkerJob | null> {
  if (input.supportedKinds.length === 0) return null;
  const releaseId = currentPortalRuntimeReleaseId();
  if (!releaseId) throw new Error("PORTAL_WORKER_RELEASE_INVALID");
  const result = await pool.query<Omit<ClaimedPortalWorkerJob, "id"> & { id: string | number }>(
    `WITH candidate AS (
       SELECT id
       FROM portal_worker_jobs
       WHERE status = 'queued'
         AND next_attempt_at <= now()
         AND job_kind = ANY($2::text[])
         AND requested_release_id = $3
       ORDER BY next_attempt_at, created_at, id
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE portal_worker_jobs job
     SET status = 'running', attempts = job.attempts + 1,
         locked_at = now(), locked_by = $1, updated_at = now()
     FROM candidate
     WHERE job.id = candidate.id
     RETURNING job.id, job.job_kind AS "jobKind",
       job.portal_university_id AS "portalUniversityId",
       job.request_key AS "requestKey",
       job.requested_release_id AS "requestedReleaseId",
       job.payload, job.attempts, job.max_attempts AS "maxAttempts",
       job.requested_by AS "requestedBy"`,
    [input.workerId, input.supportedKinds, releaseId],
  );
  const claimed = result.rows[0];
  if (!claimed) return null;
  const id = Number(claimed.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error("PORTAL_WORKER_JOB_ID_INVALID");
  }
  return { ...claimed, id };
}

async function finishPortalWorkerJob(input: {
  job: ClaimedPortalWorkerJob;
  workerId: string;
  outcome: "SUCCEEDED" | "FAILED" | "DEAD_LETTER";
  errorCode?: string;
  evidence?: Record<string, unknown>;
}): Promise<void> {
  const releaseId = currentPortalRuntimeReleaseId();
  if (!releaseId) throw new Error("PORTAL_WORKER_RELEASE_INVALID");
  const evidence = input.evidence ?? {};
  const evidenceSha256 = sha256({
    jobId: input.job.id,
    attempt: input.job.attempts,
    outcome: input.outcome,
    workerId: input.workerId,
    releaseId,
    errorCode: input.errorCode ?? null,
    evidence,
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const owned = await client.query<{ id: number }>(
      `SELECT id FROM portal_worker_jobs
       WHERE id = $1 AND status = 'running' AND locked_by = $2
       FOR UPDATE`,
      [input.job.id, input.workerId],
    );
    if (!owned.rows[0]) throw new Error("PORTAL_WORKER_JOB_LEASE_LOST");
    await client.query(
      `INSERT INTO portal_worker_job_receipts
       (job_id, attempt, outcome, worker_id, runtime_release_id, evidence_sha256, error_code, evidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        input.job.id,
        input.job.attempts,
        input.outcome,
        input.workerId,
        releaseId,
        evidenceSha256,
        input.errorCode ?? null,
        JSON.stringify(evidence),
      ],
    );
    const terminal = input.outcome !== "FAILED" || input.job.attempts >= input.job.maxAttempts;
    const status = input.outcome === "SUCCEEDED"
      ? "succeeded"
      : terminal
        ? "dead_letter"
        : "queued";
    await client.query(
      `UPDATE portal_worker_jobs
       SET status = $3, locked_at = NULL, locked_by = NULL,
           last_error_code = $4,
           next_attempt_at = CASE WHEN $3 = 'queued' THEN now() + (LEAST(300, 5 * power(2, attempts - 1)) * interval '1 second') ELSE next_attempt_at END,
           result = CASE WHEN $3 = 'succeeded' THEN $5::jsonb ELSE result END,
           finished_at = CASE WHEN $3 IN ('succeeded', 'dead_letter') THEN now() ELSE NULL END,
           updated_at = now()
       WHERE id = $1 AND locked_by = $2`,
      [
        input.job.id,
        input.workerId,
        status,
        input.errorCode ?? null,
        JSON.stringify(evidence),
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function completePortalWorkerJob(input: {
  job: ClaimedPortalWorkerJob;
  workerId: string;
  evidence?: Record<string, unknown>;
}): Promise<void> {
  await finishPortalWorkerJob({ ...input, outcome: "SUCCEEDED" });
}

export async function failPortalWorkerJob(input: {
  job: ClaimedPortalWorkerJob;
  workerId: string;
  errorCode: string;
  evidence?: Record<string, unknown>;
}): Promise<void> {
  if (!ERROR_CODE_PATTERN.test(input.errorCode)) {
    throw new Error("PORTAL_WORKER_ERROR_CODE_INVALID");
  }
  const deadLetter = input.job.attempts >= input.job.maxAttempts;
  await finishPortalWorkerJob({
    ...input,
    outcome: deadLetter ? "DEAD_LETTER" : "FAILED",
  });
}
