/**
 * run-once.ts — debug helper: processes a single portal submission and exits.
 *
 * Usage:
 *   # Process a specific submission by ID
 *   pnpm --filter @workspace/portal-automation-worker run run-once -- --id <submission_id>
 *
 *   # Claim and process the next queued submission
 *   pnpm --filter @workspace/portal-automation-worker run run-once -- --next
 *
 *   # Dry-run override (forces mode=dry regardless of DB value)
 *   pnpm --filter @workspace/portal-automation-worker run run-once -- --next --dry
 *
 * Exit codes:
 *   0  — submission processed (any terminal status)
 *   1  — error / no submission found
 */

import os from "node:os";
import { randomUUID } from "node:crypto";
import { db, portalSubmissionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  claimNext,
  claimById,
  writebackResult,
  runSubmission,
  resolveAdapterKey,
  getPortalExecutionVerification,
  recordPortalPartnerVerificationReceipt,
  samePortalPartnerVerificationBinding,
} from "@workspace/portal-runner";
import { buildStudentProfile } from "../src/profile.js";
import { resolvePortalCreds } from "../src/credResolver.js";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const idArg = args.findIndex((a) => a === "--id");
const submissionId = idArg !== -1 ? parseInt(args[idArg + 1] ?? "", 10) : null;
const useNext = args.includes("--next");
// Honor BOTH the --dry flag and the PORTAL_DRYRUN=1 env var. The adapters'
// internal dry boundary already reads PORTAL_DRYRUN, so without this the env
// var produced a mismatched run: the adapter stopped at the dry boundary
// (submitted=false) while the runner believed mode=real (meta.dryRun unset)
// and the writeback fell through to "failed" — a cosmetic-but-confusing
// terminal status for a perfectly clean dry run. Now both signals map the run
// to mode=dry and the writeback lands on "dry_run".
const forceDry = args.includes("--dry") || process.env.PORTAL_DRYRUN === "1";
if (forceDry && !args.includes("--dry")) {
  console.log("[run-once] PORTAL_DRYRUN=1 detected — forcing mode=dry (status will be 'dry_run')");
}

if (!submissionId && !useNext) {
  console.error("Usage: run-once -- --id <submission_id> | --next [--dry]");
  process.exit(1);
}
if (submissionId && isNaN(submissionId)) {
  console.error(`Invalid submission ID: "${args[idArg + 1]}"`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const WORKER_ID = `run-once-${os.hostname()}-${process.pid}`;

async function main(): Promise<void> {
  // ----- 1. Claim submission -----------------------------------------------
  let sub: Awaited<ReturnType<typeof claimNext>> | null = null;

  if (submissionId) {
    console.log(`[run-once] Claiming submission #${submissionId} …`);
    sub = await claimById(submissionId, WORKER_ID);
    if (!sub) {
      // Check if it exists at all
      const [row] = await db
        .select({ id: portalSubmissionsTable.id, status: portalSubmissionsTable.status })
        .from(portalSubmissionsTable)
        .where(eq(portalSubmissionsTable.id, submissionId));

      if (!row) {
        console.error(`[run-once] Submission #${submissionId} not found`);
      } else {
        console.error(
          `[run-once] Submission #${submissionId} not claimable — status="${row.status}" ` +
          `(only 'queued' rows can be claimed; use the admin panel to reset if needed)`,
        );
      }
      process.exit(1);
    }
  } else {
    console.log("[run-once] Claiming next queued submission …");
    sub = await claimNext(WORKER_ID);
    if (!sub) {
      console.log("[run-once] Queue is empty — nothing to process");
      process.exit(0);
    }
  }

  const effectiveMode = forceDry ? "dry" : sub.mode;

  console.log(
    `[run-once] Claimed #${sub.id}` +
    ` app=${sub.applicationId} uni=${sub.universityKey}` +
    ` mode=${effectiveMode} attempt=${sub.attempts}/${sub.maxAttempts}`,
  );

  // ----- 2. Build profile --------------------------------------------------
  let profileResult: Awaited<ReturnType<typeof buildStudentProfile>>;
  try {
    profileResult = await buildStudentProfile(sub.id);
    console.log(`[run-once] Profile built — email=${profileResult.profile.email} program="${profileResult.profile.programName}"`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[run-once] Profile build failed: ${msg}`);
    await writebackResult(sub.id, null, msg);
    process.exit(1);
  }

  // ----- 3. Run submission -------------------------------------------------
  // Resolve credentials for both dry and real mode.
  // Dry mode performs a real browser login + full form-fill smoke-test;
  // only the final submit click is skipped (doSubmit=false).
  let runResult: Awaited<ReturnType<typeof runSubmission>>;
  let verificationBefore: Awaited<ReturnType<typeof getPortalExecutionVerification>> = null;
  let adapterRunStarted = false;
  let executionUniversityKey = sub.universityKey;
  let executionAdapterKey = sub.adapterKey;
  const dryRunRequestKey = effectiveMode === "dry"
    ? `dry-run:${sub.id}:${randomUUID()}`
    : null;
  try {
    // Multi-portal / aggregator routing: a member university (e.g. "aydin")
    // routed to an aggregator (SIT=study_in_turkey→adapter "sit") must log in
    // with the AGGREGATOR's credentials, not its own. resolveAdapterKey returns
    // routedVia (the aggregator's portal key) when a redirect applies; passing
    // it + the adapter key lets resolvePortalCreds find the aggregator's row
    // instead of the member's own credentials. For direct portals routedVia is
    // null and adapterKey === universityKey, so behaviour is unchanged.
    const { adapterKey, routedVia } = await resolveAdapterKey(sub.universityKey);
    executionUniversityKey = routedVia ?? sub.universityKey;
    executionAdapterKey = adapterKey;
    verificationBefore = await getPortalExecutionVerification({
      universityKey: executionUniversityKey,
      adapterKey,
    });
    const verified = effectiveMode === "dry"
      ? verificationBefore?.testLoginPassed === true && verificationBefore.binding?.strictDryRunCapable === true
      : verificationBefore?.testLoginPassed === true && verificationBefore.strictDryRunPassed === true;
    if (!verified) {
      throw new Error(
        effectiveMode === "dry"
          ? "PORTAL_TEST_LOGIN_OR_STRICT_ADAPTER_REQUIRED"
          : "PARTNER_VERIFICATION_REQUIRED",
      );
    }
    const creds = await resolvePortalCreds(routedVia ?? sub.universityKey, adapterKey);
    adapterRunStarted = true;
    runResult = await runSubmission(
      { ...sub, mode: effectiveMode },
      profileResult.profile,
      profileResult.files,
      profileResult.tempDir,
      creds,
    );
    if (effectiveMode === "dry" && runResult.meta["dryRun"] === true) {
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
          executor: "run-once",
        },
      });
    }
    console.log("[run-once] Run complete:");
    console.log("  submitted     :", runResult.result.submitted);
    console.log("  alreadyExists :", runResult.result.alreadyExists);
    console.log("  programMissing:", runResult.result.programMissing);
    if (runResult.result.detail) console.log("  detail        :", runResult.result.detail);
    console.log("  screenshots   :", runResult.screenshotUrls.length);
    console.log("  meta          :", runResult.meta);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (effectiveMode === "dry" && adapterRunStarted && verificationBefore?.binding) {
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
            executor: "run-once",
          },
        }).catch(() => undefined);
      }
    }
    console.error(`[run-once] Run failed: ${msg}`);
    await writebackResult(sub.id, null, msg);
    process.exit(1);
  }

  // ----- 4. Write back result ----------------------------------------------
  await writebackResult(sub.id, runResult);
  console.log(`[run-once] Writeback complete — submission #${sub.id} done`);

  // Re-fetch final status
  const [final] = await db
    .select({ status: portalSubmissionsTable.status, error: portalSubmissionsTable.error })
    .from(portalSubmissionsTable)
    .where(eq(portalSubmissionsTable.id, sub.id));

  console.log(`[run-once] Final status: ${final?.status ?? "unknown"}${final?.error ? ` | error: ${final.error}` : ""}`);
}

main().catch((err) => {
  console.error("[run-once] Fatal:", err);
  process.exit(1);
});
