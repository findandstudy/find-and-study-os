/**
 * force-drain-one.ts
 *
 * ONE-SHOT manual recovery: processes one exact portal_submission by ID.
 * It bypasses the auto-process scheduling gate, but never the version-bound
 * partner verification or strict dry-run execution gates.
 *
 * Usage:
 *   FORCE_SUBMISSION_ID=3 \
 *   DATABASE_URL=<prod_url> ENCRYPTION_KEY=<key> \
 *   tsx scripts/force-drain-one.ts
 *
 * What it does:
 *   1. Resets attempts=0, status=queued, locked_at=NULL for the target row
 *      (handles the exhausted-attempts case).
 *   2. Claims exactly that submission via claimById.
 *   3. Runs the portal adapter (login + submit).
 *   4. Writes result back to portal_submissions + updates application stage.
 *
 * Exit codes: 0 = done (even on adapter failure), 1 = fatal startup error.
 */

import os from "node:os";
import { randomUUID } from "node:crypto";
import {
  claimById,
  heartbeat,
  buildStudentProfile,
  runSubmission,
  writebackResult,
  resolveAdapterKey,
  getPortalExecutionVerification,
  recordPortalPartnerVerificationReceipt,
  samePortalPartnerVerificationBinding,
} from "@workspace/portal-runner";
import { resolvePortalCreds } from "../src/lib/portalCreds.js";
import { pool } from "@workspace/db";

const WORKER_ID = `force-drain-${os.hostname()}-${process.pid}`;

const rawId = process.env.FORCE_SUBMISSION_ID;
if (!rawId) {
  console.error("[force-drain] FORCE_SUBMISSION_ID env var is required (e.g. FORCE_SUBMISSION_ID=3)");
  process.exit(1);
}
const FORCE_ID = parseInt(rawId, 10);
if (isNaN(FORCE_ID) || FORCE_ID <= 0) {
  console.error(`[force-drain] FORCE_SUBMISSION_ID must be a positive integer, got: ${rawId}`);
  process.exit(1);
}

async function run(): Promise<void> {
  console.log(`[force-drain] Starting — id=${WORKER_ID}, target=submission#${FORCE_ID}`);
  console.log(`[force-drain] DATABASE_URL host: ${process.env.DATABASE_URL?.split("@")[1]?.split("/")[0] ?? "unknown"}`);

  // -------------------------------------------------------------------------
  // Step 1: Verify the submission exists
  // -------------------------------------------------------------------------
  const check = await pool.query<{ id: number; status: string; attempts: number; max_attempts: number; university_key: string; deleted_at: Date | null }>(
    `SELECT id, status, attempts, max_attempts, university_key, deleted_at
     FROM portal_submissions WHERE id = $1`,
    [FORCE_ID],
  );

  if (check.rows.length === 0) {
    console.error(`[force-drain] Submission #${FORCE_ID} not found in this database. Wrong DB?`);
    console.error(`[force-drain] DATABASE_URL points to: ${process.env.DATABASE_URL?.split("@")[1]?.split("/")[0] ?? "unknown"}`);
    process.exit(1);
  }

  const row = check.rows[0]!;
  console.log(`[force-drain] Found #${FORCE_ID}: status=${row.status}, attempts=${row.attempts}/${row.max_attempts}, uni=${row.university_key}, deleted=${row.deleted_at ?? "null"}`);

  if (row.deleted_at) {
    console.error(`[force-drain] Submission #${FORCE_ID} is soft-deleted — aborting.`);
    process.exit(1);
  }

  if (row.status === "submitted" || row.status === "already_exists") {
    console.log(`[force-drain] Submission #${FORCE_ID} already in terminal state: ${row.status}. Nothing to do.`);
    process.exit(0);
  }

  // -------------------------------------------------------------------------
  // Step 2: Reset to claimable state (bypass attempts gate + clear any lock)
  // -------------------------------------------------------------------------
  console.log(`[force-drain] Resetting #${FORCE_ID} → queued, attempts=0, locked=null`);
  await pool.query(
    `UPDATE portal_submissions
     SET status = 'queued', attempts = 0, max_attempts = GREATEST(max_attempts, 1),
         locked_at = NULL, locked_by = NULL, error = NULL, updated_at = NOW()
     WHERE id = $1`,
    [FORCE_ID],
  );
  console.log(`[force-drain] Reset complete.`);

  // -------------------------------------------------------------------------
  // Step 3: Claim exactly the requested row. A force operation must never
  // release unrelated locks or fall through to a different queued submission.
  // -------------------------------------------------------------------------
  const sub = await claimById(FORCE_ID, WORKER_ID);
  if (!sub) {
    console.error(`[force-drain] claimById returned null — submission #${FORCE_ID} was not picked up.`);
    console.error(`[force-drain] Possible reasons: another worker claimed it, or status/attempts still blocking.`);
    process.exit(1);
  }

  console.log(`[force-drain] Claimed #${sub.id} — uni=${sub.universityKey}, mode=${sub.mode}, attempt=${sub.attempts}/${sub.maxAttempts}`);

  // -------------------------------------------------------------------------
  // Step 5: Heartbeat every 30s (prevents stuck-reset from firing)
  // -------------------------------------------------------------------------
  const hbInterval = setInterval(() => {
    heartbeat(sub.id, WORKER_ID).catch(() => {});
  }, 30_000);

  let verificationBefore: Awaited<ReturnType<typeof getPortalExecutionVerification>> = null;
  let adapterRunStarted = false;
  let executionUniversityKey = sub.universityKey;
  let executionAdapterKey = sub.adapterKey;
  const dryRunRequestKey = sub.mode === "dry"
    ? `dry-run:${sub.id}:${randomUUID()}`
    : null;

  try {
    // -----------------------------------------------------------------------
    // Step 6: Build student profile + resolve portal credentials
    // -----------------------------------------------------------------------
    console.log(`[force-drain] Building student profile for #${sub.id}…`);
    const profileResult = await buildStudentProfile(sub.id);
    console.log(`[force-drain] Profile built — ${Object.keys(profileResult.files ?? {}).length} file(s) staged`);

    const { adapterKey, routedVia } = await resolveAdapterKey(sub.universityKey);
    executionUniversityKey = routedVia ?? sub.universityKey;
    executionAdapterKey = adapterKey;
    verificationBefore = await getPortalExecutionVerification({
      universityKey: executionUniversityKey,
      adapterKey,
    });
    const verified = sub.mode === "dry"
      ? verificationBefore?.testLoginPassed === true && verificationBefore.binding?.strictDryRunCapable === true
      : verificationBefore?.testLoginPassed === true && verificationBefore.strictDryRunPassed === true;
    if (!verified) {
      throw new Error(
        sub.mode === "dry"
          ? "PORTAL_TEST_LOGIN_OR_STRICT_ADAPTER_REQUIRED"
          : "PARTNER_VERIFICATION_REQUIRED",
      );
    }

    console.log(`[force-drain] Resolving credentials — adapterKey=${adapterKey}`);
    let creds: { user: string; password: string } | undefined;
    try {
      creds = await resolvePortalCreds(routedVia ?? sub.universityKey, adapterKey);
      console.log(`[force-drain] Credentials resolved (user: ${creds?.user ?? "none"})`);
    } catch (credsErr) {
      if (sub.mode === "real") {
        console.error(`[force-drain] FATAL: Cannot resolve credentials for real submission:`, credsErr);
        throw credsErr;
      }
      console.warn(`[force-drain] No creds for dry mode — adapter will attempt env fallback`);
    }

    // -----------------------------------------------------------------------
    // Step 7: Run portal adapter (login + document uploads + application submit)
    // -----------------------------------------------------------------------
    console.log(`[force-drain] Running portal adapter — this will open Chromium…`);
    adapterRunStarted = true;
    const runResult = await runSubmission(sub, profileResult.profile, profileResult.files, profileResult.tempDir, creds);

    if (sub.mode === "dry" && runResult.meta["dryRun"] === true) {
      const verificationAfter = await getPortalExecutionVerification({
        universityKey: executionUniversityKey,
        adapterKey: executionAdapterKey,
      });
      if (
        !verificationBefore?.binding ||
        !samePortalPartnerVerificationBinding(
          verificationBefore.binding,
          verificationAfter?.binding ?? null,
        )
      ) {
        throw new Error("STRICT_DRY_RUN_BINDING_CHANGED");
      }
      await recordPortalPartnerVerificationReceipt({
        binding: verificationBefore.binding,
        verificationType: "STRICT_DRY_RUN",
        outcome: "PASSED",
        requestKey: dryRunRequestKey!,
        performedBy: sub.enqueuedBy,
        applicationId: sub.applicationId,
        portalSubmissionId: sub.id,
        evidence: {
          mode: "dry",
          status: "dry_run",
          mutationBoundary: "strict",
          executor: "force-drain-one",
        },
      });
    }

    // -----------------------------------------------------------------------
    // Step 8: Write back result to DB + update application stage
    // -----------------------------------------------------------------------
    await writebackResult(sub.id, runResult, undefined, WORKER_ID);

    const status = runResult.meta["dryRun"]
      ? "dry_run"
      : runResult.result.submitted
        ? "submitted"
        : runResult.result.alreadyExists
          ? "already_exists"
          : runResult.result.programMissing
            ? "program_missing"
            : "failed";

    console.log(`\n[force-drain] === RESULT ===`);
    console.log(`[force-drain] #${sub.id} → ${status}`);
    if (runResult.result.error) console.log(`[force-drain] error: ${runResult.result.error}`);
    if (runResult.meta) console.log(`[force-drain] meta: ${JSON.stringify(runResult.meta)}`);
    console.log(`[force-drain] screenshotUrls: ${JSON.stringify(runResult.screenshotUrls ?? [])}`);
    console.log(`[force-drain] ==================`);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (sub.mode === "dry" && adapterRunStarted && verificationBefore?.binding) {
      const verificationAfter = await getPortalExecutionVerification({
        universityKey: executionUniversityKey,
        adapterKey: executionAdapterKey,
      }).catch(() => null);
      if (samePortalPartnerVerificationBinding(
        verificationBefore.binding,
        verificationAfter?.binding ?? null,
      )) {
        await recordPortalPartnerVerificationReceipt({
          binding: verificationBefore.binding,
          verificationType: "STRICT_DRY_RUN",
          outcome: "FAILED",
          requestKey: dryRunRequestKey!,
          performedBy: sub.enqueuedBy,
          failureCode: "STRICT_DRY_RUN_FAILED",
          applicationId: sub.applicationId,
          portalSubmissionId: sub.id,
          evidence: {
            mode: "dry",
            status: "failed",
            mutationBoundary: "strict",
            executor: "force-drain-one",
          },
        }).catch(() => undefined);
      }
    }
    console.error(`[force-drain] Adapter threw: ${msg}`);
    await writebackResult(sub.id, null, msg, WORKER_ID).catch(() => {});
  } finally {
    clearInterval(hbInterval);
  }

  console.log(`[force-drain] Done.`);
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[force-drain] Fatal:", err);
    process.exit(1);
  });
