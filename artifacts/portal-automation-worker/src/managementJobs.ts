import {
  clearCredsOverride,
  resolveAdapterByKey,
  setCredsOverride,
} from "@workspace/portal-adapters";
import { db, portalProgramCacheTable } from "@workspace/db";
import {
  completePortalWorkerJob,
  currentPortalRuntimeReleaseId,
  failPortalWorkerJob,
  getPortalExecutionVerification,
  loadPortalPartnerVerificationBinding,
  PortalVerificationIdempotencyConflictError,
  recordPortalPartnerVerificationReceipt,
  samePortalPartnerVerificationBinding,
  type ClaimedPortalWorkerJob,
} from "@workspace/portal-runner";
import { resolvePortalCreds } from "./credResolver.js";

const PORTAL_LOGIN_TIMEOUT_MS = 30_000;
const PROGRAM_DISCOVERY_TIMEOUT_MS = 90_000;

function loginWithTimeout<T>(
  promise: Promise<T & { close(): Promise<void> }>,
  timeoutMs = PORTAL_LOGIN_TIMEOUT_MS,
): Promise<T & { close(): Promise<void> }> {
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(new Error("PORTAL_LOGIN_TIMEOUT"));
    }, timeoutMs);
    timer.unref?.();
  });
  promise.then((session) => {
    if (expired) void session.close().catch(() => undefined);
  }).catch(() => undefined);
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    operation,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("PORTAL_OPERATION_TIMEOUT")), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function processTestLoginJob(job: ClaimedPortalWorkerJob, workerId: string): Promise<void> {
  const releaseId = currentPortalRuntimeReleaseId();
  if (!releaseId || job.requestedReleaseId !== releaseId) {
    await failPortalWorkerJob({ job, workerId, errorCode: "PORTAL_WORKER_RELEASE_MISMATCH" });
    return;
  }
  if (!job.portalUniversityId) {
    await failPortalWorkerJob({ job, workerId, errorCode: "PORTAL_PARTNER_BINDING_INVALID" });
    return;
  }

  const beforeBinding = await loadPortalPartnerVerificationBinding(job.portalUniversityId);
  if (!beforeBinding || beforeBinding.runtimeReleaseId !== releaseId) {
    await failPortalWorkerJob({ job, workerId, errorCode: "VERIFICATION_BINDING_NOT_READY" });
    return;
  }
  const adapter = await resolveAdapterByKey(beforeBinding.adapterKey);
  if (!adapter) {
    await failPortalWorkerJob({ job, workerId, errorCode: "PORTAL_ADAPTER_NOT_FOUND" });
    return;
  }

  let session: Awaited<ReturnType<typeof adapter.login>> | null = null;
  let outcome: "PASSED" | "FAILED" = "FAILED";
  let failureCode: string | undefined = "PORTAL_LOGIN_FAILED";
  try {
    const creds = await resolvePortalCreds(
      beforeBinding.universityKey,
      beforeBinding.adapterKey,
    );
    // Keep the compatibility override for older adapters, but also pass the
    // credentials through the session-local contract used by current ones.
    setCredsOverride(adapter.key, creds);
    session = await loginWithTimeout(adapter.login({ headless: true, credentials: creds }));
    outcome = "PASSED";
    failureCode = undefined;
  } catch {
    // Provider text can contain usernames, tokens or page content. It is
    // deliberately collapsed to one fixed failure category.
  } finally {
    clearCredsOverride(adapter.key);
    await session?.close().catch(() => undefined);
  }

  const afterBinding = await loadPortalPartnerVerificationBinding(job.portalUniversityId);
  if (!samePortalPartnerVerificationBinding(beforeBinding, afterBinding)) {
    await failPortalWorkerJob({ job, workerId, errorCode: "VERIFICATION_BINDING_CHANGED" });
    return;
  }

  try {
    await recordPortalPartnerVerificationReceipt({
      binding: beforeBinding,
      verificationType: "TEST_LOGIN",
      outcome,
      requestKey: job.requestKey,
      performedBy: job.requestedBy,
      failureCode,
      evidence: {
        executor: "portal-worker",
        headless: true,
        timeoutMs: PORTAL_LOGIN_TIMEOUT_MS,
      },
    });
  } catch (error) {
    if (error instanceof PortalVerificationIdempotencyConflictError) {
      await failPortalWorkerJob({ job, workerId, errorCode: "VERIFICATION_IDEMPOTENCY_CONFLICT" });
      return;
    }
    throw error;
  }

  await completePortalWorkerJob({
    job,
    workerId,
    evidence: { verificationOutcome: outcome },
  });
}

async function processProgramCatalogSyncJob(
  job: ClaimedPortalWorkerJob,
  workerId: string,
): Promise<void> {
  const releaseId = currentPortalRuntimeReleaseId();
  if (!releaseId || job.requestedReleaseId !== releaseId) {
    await failPortalWorkerJob({ job, workerId, errorCode: "PORTAL_WORKER_RELEASE_MISMATCH" });
    return;
  }
  if (!job.portalUniversityId) {
    await failPortalWorkerJob({ job, workerId, errorCode: "PORTAL_PARTNER_BINDING_INVALID" });
    return;
  }
  const level = typeof job.payload.level === "string"
    ? job.payload.level.trim().slice(0, 120)
    : "";
  const binding = await loadPortalPartnerVerificationBinding(job.portalUniversityId);
  if (!binding || binding.runtimeReleaseId !== releaseId) {
    await failPortalWorkerJob({ job, workerId, errorCode: "VERIFICATION_BINDING_NOT_READY" });
    return;
  }
  const verification = await getPortalExecutionVerification({
    universityKey: binding.universityKey,
    adapterKey: binding.adapterKey,
  });
  if (!verification?.testLoginPassed) {
    await failPortalWorkerJob({ job, workerId, errorCode: "PARTNER_VERIFICATION_REQUIRED" });
    return;
  }
  const adapter = await resolveAdapterByKey(binding.adapterKey);
  if (!adapter?.listPrograms) {
    await failPortalWorkerJob({ job, workerId, errorCode: "PROGRAM_DISCOVERY_UNSUPPORTED" });
    return;
  }

  let session: Awaited<ReturnType<typeof adapter.login>> | null = null;
  try {
    const creds = await resolvePortalCreds(binding.universityKey, binding.adapterKey);
    setCredsOverride(adapter.key, creds);
    session = await loginWithTimeout(
      adapter.login({ headless: true, credentials: creds }),
      PROGRAM_DISCOVERY_TIMEOUT_MS,
    );
    const options = await withTimeout(
      adapter.listPrograms(session, level || undefined),
      PROGRAM_DISCOVERY_TIMEOUT_MS,
    );
    const afterBinding = await loadPortalPartnerVerificationBinding(job.portalUniversityId);
    if (!samePortalPartnerVerificationBinding(binding, afterBinding)) {
      await failPortalWorkerJob({ job, workerId, errorCode: "VERIFICATION_BINDING_CHANGED" });
      return;
    }
    await db
      .insert(portalProgramCacheTable)
      .values({ universityKey: binding.universityKey, level, options })
      .onConflictDoUpdate({
        target: [portalProgramCacheTable.universityKey, portalProgramCacheTable.level],
        set: { options, fetchedAt: new Date() },
      });
    await completePortalWorkerJob({
      job,
      workerId,
      evidence: { level, optionCount: options.length },
    });
  } finally {
    clearCredsOverride(adapter.key);
    await session?.close().catch(() => undefined);
  }
}

export async function processPortalManagementJob(
  job: ClaimedPortalWorkerJob,
  workerId: string,
): Promise<void> {
  try {
    if (job.jobKind === "test_login") {
      await processTestLoginJob(job, workerId);
      return;
    }
    if (job.jobKind === "program_catalog_sync") {
      await processProgramCatalogSyncJob(job, workerId);
      return;
    }
    await failPortalWorkerJob({ job, workerId, errorCode: "PORTAL_WORKER_JOB_UNSUPPORTED" });
  } catch {
    // Never persist or log an untrusted provider exception. The fixed code is
    // enough for retry/dead-letter handling and operator diagnostics.
    await failPortalWorkerJob({
      job,
      workerId,
      errorCode: "PORTAL_WORKER_JOB_EXECUTION_FAILED",
    }).catch(() => undefined);
  }
}
