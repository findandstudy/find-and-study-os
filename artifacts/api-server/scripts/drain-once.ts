/**
 * drain-once.ts — processes queued portal_submissions and exits.
 *
 * Designed for use with Replit Scheduled Deployments (see SCHEDULED_DRAIN.md).
 *
 * AUTO-DRAIN GATE (checked at startup):
 *   1. Reads portal_automation_settings.autoProcessEnabled — exits if false.
 *   2. Checks interval: if (now - lastAutoDrainAt) < autoProcessIntervalMinutes → exits.
 *   3. Fetches universities with autoProcess=true + isActive=true; exits if none.
 *   4. Only claims submissions for those universities (universityKeys filter).
 *   5. After drain: writes lastAutoDrainAt=NOW() and records audit entry.
 *
 * MANUAL PROCESS (POST /api/portal-submissions/process-queued or /:id/process):
 *   NOT affected by this gate — those API endpoints run independently and always
 *   process all active-portal queued submissions.
 *
 * Each submission:
 *   1. Claimed atomically (FOR UPDATE SKIP LOCKED — safe to run concurrently)
 *   2. Student profile built + docs downloaded to tmp dir
 *   3. Credentials resolved (DB-first, env fallback)
 *   4. Adapter login + submit (browser closed after each run — minimal memory)
 *   5. Result written back to portal_submissions + application stage updated
 *
 * Memory discipline:
 *   - Concurrency = 1 (submissions processed one at a time)
 *   - 2-second cooldown between submissions gives the V8 GC time to reclaim
 *     memory freed by browser.close() before the next Chromium process starts
 *   - Run with NODE_OPTIONS=--max-old-space-size=512 (set in package.json script)
 *
 * Usage:
 *   DATABASE_URL=... ENCRYPTION_KEY=... \
 *   pnpm --filter @workspace/api-server drain-once
 *
 * Exit codes:
 *   0 — completed (even if some submissions failed — failures are recorded in DB)
 *   1 — fatal startup error (DB unreachable, etc.)
 */

import os from "node:os";
import {
  claimNext,
  releaseStale,
  heartbeat,
  buildStudentProfile,
  runSubmission,
  writebackResult,
  portalEvidenceFromError,
  getNonGraduatedExperimentalAdapterKeys,
  getPortalExecutionVerification,
  loadPortalPartnerVerificationStates,
} from "@workspace/portal-runner";
import { resolvePortalCreds } from "../src/lib/portalCreds.js";
import { db, pool, portalUniversitiesTable, portalAutomationSettingsTable } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";

const WORKER_ID          = `drain-once-${os.hostname()}-${process.pid}`;
const STALE_MS           = 5 * 60 * 1000; // 5 minutes
const INTER_JOB_SLEEP_MS = 2_000;         // GC cooldown between browser sessions

interface DrainResult {
  id: number;
  status: "submitted" | "already_exists" | "program_missing" | "failed" | "dry_run";
  error?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Write an audit entry without requiring a live user session (user_id = NULL). */
async function logDrainAudit(
  action: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, metadata, ip_address, created_at)
       VALUES (NULL, $1, 'portal_drain', NULL, $2, NULL, NOW())`,
      [action, JSON.stringify(metadata)],
    );
  } catch (err) {
    // Audit failure must not abort the drain
    console.warn("[drain-once] audit log write failed:", err instanceof Error ? err.message : err);
  }
}

/** Idempotently updates lastAutoDrainAt on the settings row. */
async function updateLastAutoDrainAt(settingsId: number): Promise<void> {
  try {
    await db
      .update(portalAutomationSettingsTable)
      .set({ lastAutoDrainAt: new Date() })
      .where(eq(portalAutomationSettingsTable.id, settingsId));
  } catch (err) {
    console.warn("[drain-once] Failed to update lastAutoDrainAt:", err instanceof Error ? err.message : err);
  }
}

async function drain(): Promise<void> {
  console.log(`[drain-once] Starting — id=${WORKER_ID}`);

  // ---------------------------------------------------------------------------
  // AUTO-DRAIN GATE
  // ---------------------------------------------------------------------------

  // Step 1: Read automation settings
  let autoProcessEnabled         = false;
  let autoProcessIntervalMinutes = 20;
  let lastAutoDrainAt: Date | null = null;
  let settingsId: number | null   = null;
  let triggerStages: string[]     = [];

  try {
    const [settings] = await db
      .select({
        id:                          portalAutomationSettingsTable.id,
        autoProcessEnabled:          portalAutomationSettingsTable.autoProcessEnabled,
        autoProcessIntervalMinutes:  portalAutomationSettingsTable.autoProcessIntervalMinutes,
        lastAutoDrainAt:             portalAutomationSettingsTable.lastAutoDrainAt,
        triggerStages:               portalAutomationSettingsTable.triggerStages,
      })
      .from(portalAutomationSettingsTable)
      .limit(1);

    if (settings) {
      autoProcessEnabled         = settings.autoProcessEnabled;
      autoProcessIntervalMinutes = settings.autoProcessIntervalMinutes ?? 20;
      lastAutoDrainAt            = settings.lastAutoDrainAt ? new Date(settings.lastAutoDrainAt) : null;
      settingsId                 = settings.id;
      triggerStages              = settings.triggerStages ?? [];
    }
  } catch (err) {
    console.error("[drain-once] Fatal: failed to read settings:", err instanceof Error ? err.message : err);
    process.exit(1);
  }

  // Step 2: Gate — autoProcessEnabled
  if (!autoProcessEnabled) {
    console.log("[drain-once] Auto-process disabled (autoProcessEnabled=false) — exiting");
    process.exit(0);
  }

  // Step 3: Gate — interval check
  if (lastAutoDrainAt) {
    const elapsedMs  = Date.now() - lastAutoDrainAt.getTime();
    const intervalMs = autoProcessIntervalMinutes * 60_000;
    if (elapsedMs < intervalMs) {
      const remainingMin = Math.ceil((intervalMs - elapsedMs) / 60_000);
      console.log(
        `[drain-once] Interval gate: ${remainingMin} min remaining (interval=${autoProcessIntervalMinutes} min, elapsed=${Math.floor(elapsedMs / 60_000)} min) — skipping`,
      );
      await logDrainAudit("auto_drain_skipped_interval", {
        intervalMinutes:  autoProcessIntervalMinutes,
        elapsedMinutes:   Math.floor(elapsedMs / 60_000),
        remainingMinutes: remainingMin,
        lastAutoDrainAt:  lastAutoDrainAt.toISOString(),
      });
      process.exit(0);
    }
  }

  // Step 4: Fetch autoProcess-enabled university keys
  // Aggregator families (salesforce/sit/united/emu) are NO LONGER hard-excluded
  // here — each aggregator opts in/out through its OWN portal_universities
  // row's `autoProcess` toggle (panel-managed), same as any standalone portal.
  // That toggle is condition 1 of the 3-condition gate for aggregator
  // auto-drain: (1) this toggle, (2) the application's university is an
  // active DB member (portal_account_universities — already enforced upstream
  // at enqueue time by enqueueIfEligible/resolvePortalRouting, which only
  // ever queues a member submission under the AGGREGATOR's own
  // universityKey), (3) trigger stage. Today the United row's autoProcess is
  // OFF in production, so removing this exclusion changes nothing until an
  // operator explicitly flips that toggle — and even then submissions are
  // still claimed and processed one at a time (no burst). This mirrors the
  // identical fix in portal-automation-worker/src/worker.ts.
  let autoProcessKeys: string[] = [];
  try {
    const unis = await db
      .select({
        id: portalUniversitiesTable.id,
        universityKey: portalUniversitiesTable.universityKey,
        adapterKey:    portalUniversitiesTable.adapterKey,
        verificationGeneration: portalUniversitiesTable.verificationGeneration,
      })
      .from(portalUniversitiesTable)
      .where(and(
        eq(portalUniversitiesTable.autoProcess, true),
        eq(portalUniversitiesTable.isActive, true),
        isNull(portalUniversitiesTable.deletedAt),
      ));

    // Adapter auto-graduation: exclude universities whose adapter is still
    // experimental (non-graduated). Mirrors the identical filter in
    // portal-automation-worker/src/worker.ts loadAutoProcessKeys().
    const nonGraduated = await getNonGraduatedExperimentalAdapterKeys(
      unis.map((u) => u.adapterKey),
    );
    const verificationStates = await loadPortalPartnerVerificationStates(unis);
    autoProcessKeys = unis
      .filter((u) => {
        const verification = verificationStates.get(u.id);
        return (
          !nonGraduated.has(u.adapterKey) &&
          verification?.testLoginPassed === true &&
          verification.strictDryRunPassed === true
        );
      })
      .map((u) => u.universityKey);
  } catch (err) {
    console.error("[drain-once] Fatal: failed to load auto-process universities:", err instanceof Error ? err.message : err);
    process.exit(1);
  }

  if (autoProcessKeys.length === 0) {
    console.log("[drain-once] No universities have autoProcess=true + isActive=true — exiting");
    if (settingsId !== null) await updateLastAutoDrainAt(settingsId);
    await logDrainAudit("auto_drain_completed", {
      processed: 0, skipped: 0,
      reason: "no_auto_process_universities",
    });
    process.exit(0);
  }

  console.log(
    `[drain-once] Auto-process filter: ${autoProcessKeys.length} university(ies) — ${autoProcessKeys.join(", ")}`,
  );

  // ---------------------------------------------------------------------------
  // Release stale locks (crash recovery for previous runs)
  // ---------------------------------------------------------------------------
  const staleIds = await releaseStale(STALE_MS);
  if (staleIds.length > 0) {
    console.log(`[drain-once] Released ${staleIds.length} stale submission(s): ${staleIds.join(",")}`);
  }

  const results: DrainResult[] = [];
  let processed = 0;

  // ---------------------------------------------------------------------------
  // Drain loop — only claims submissions for autoProcess universities
  // ---------------------------------------------------------------------------
  while (true) {
    // Pass the university key filter so non-autoProcess submissions are never
    // claimed, plus the trigger-stage filter so only applications currently in
    // a configured trigger stage are auto-processed (mirrors the enqueue scan).
    const sub = await claimNext(WORKER_ID, autoProcessKeys, triggerStages);
    if (!sub) break; // Queue drained for auto-process universities

    // Cooldown between jobs: let V8 GC reclaim the previous browser's heap
    // before allocating a new Chromium process (skip on first job).
    if (processed > 0) {
      console.log(`[drain-once] Cooldown ${INTER_JOB_SLEEP_MS}ms before next job…`);
      await sleep(INTER_JOB_SLEEP_MS);
    }

    console.log(
      `[drain-once] Processing #${sub.id} — uni=${sub.universityKey} mode=${sub.mode} attempt=${sub.attempts}/${sub.maxAttempts}`,
    );

    // Heartbeat: refresh locked_at every 30s so the periodic stuck-reset
    // job (threshold 10 min) never fires while this job is actively running.
    const hbInterval = setInterval(() => {
      heartbeat(sub.id, WORKER_ID).catch(() => {});
    }, 30_000);

    try {
      const profileResult = await buildStudentProfile(sub.id);

      // Resolve creds for both real and dry modes.
      // Dry mode uses the browser (doSubmit=false), so credentials are needed.
      // Credentials are stored under adapterKey (canonical); look it up from portal_universities.
      let adapterKey = sub.universityKey; // fallback: same as universityKey
      try {
        const [uniRow] = await db
          .select({ adapterKey: portalUniversitiesTable.adapterKey })
          .from(portalUniversitiesTable)
          .where(
            and(
              eq(portalUniversitiesTable.universityKey, sub.universityKey),
              isNull(portalUniversitiesTable.deletedAt),
            ),
          )
          .limit(1);
        if (uniRow) adapterKey = uniRow.adapterKey;
      } catch {}

      const verification = await getPortalExecutionVerification({
        universityKey: sub.universityKey,
        adapterKey,
      });
      if (!verification?.testLoginPassed || !verification.strictDryRunPassed) {
        throw new Error(
          "PARTNER_VERIFICATION_REQUIRED: current test-login and strict dry-run receipts are required",
        );
      }

      let creds: { user: string; password: string } | undefined;
      try {
        creds = await resolvePortalCreds(sub.universityKey, adapterKey);
      } catch (credsErr) {
        if (sub.mode === "real") throw credsErr; // required for real mode
        // dry mode: missing creds → adapter will throw at login → caught below
        console.warn(
          `[drain-once] No creds for "${sub.universityKey}" (dry mode — will attempt env fallback)`,
        );
      }

      const runResult = await runSubmission(
        sub,
        profileResult.profile,
        profileResult.files,
        profileResult.tempDir,
        creds,
      );

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

      results.push({ id: sub.id, status: status as DrainResult["status"] });
      console.log(`[drain-once] #${sub.id} → ${status}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[drain-once] #${sub.id} failed: ${msg}`);
      await writebackResult(
        sub.id,
        null,
        msg,
        WORKER_ID,
        portalEvidenceFromError(err),
      );
      results.push({ id: sub.id, status: "failed", error: msg });
    } finally {
      clearInterval(hbInterval);
    }

    processed++;
  }

  const submittedCount = results.filter((r) => r.status === "submitted" || r.status === "already_exists").length;
  const failedCount    = results.filter((r) => r.status === "failed").length;

  console.log(`\n[drain-once] Done — ${results.length} submission(s) processed`);
  if (results.length > 0) {
    for (const r of results) {
      const suffix = r.error ? ` (${r.error.slice(0, 80)})` : "";
      console.log(`  #${r.id}: ${r.status}${suffix}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Update lastAutoDrainAt + write audit record
  // ---------------------------------------------------------------------------
  if (settingsId !== null) await updateLastAutoDrainAt(settingsId);

  await logDrainAudit("auto_drain_completed", {
    processed:     results.length,
    submitted:     submittedCount,
    failed:        failedCount,
    universities:  autoProcessKeys,
    staleReleased: staleIds.length,
  });

  console.log("[drain-once] lastAutoDrainAt updated. Audit recorded.");
}

drain()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[drain-once] Fatal error:", err);
    process.exit(1);
  });
