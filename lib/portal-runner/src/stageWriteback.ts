/**
 * stageWriteback.ts — applies the 4 writeback rules after a submission run.
 *
 * Rule 1: submitted=true       → portal_submissions.status='submitted'
 *                                 application.stage='awaiting_offer_letter'
 * Rule 2: programMissing=true  → portal_submissions.status='program_missing'
 *                                 application.stage='documents'
 * Rule 3: alreadyExists=true   → portal_submissions.status='already_exists'
 *                                 application.stage='already_registered'
 * Rule 4: programFull=true    → portal_submissions.status='program_full'
 *                                 portal_submissions.meta={requestedProgram,
 *                                 openPrograms, reason, detectedAt}
 *                                 Altınbaş only: application.stage='quota_full'
 *                                 Other adapters: application stage unchanged
 * Rule 5: error / none matched → portal_submissions.status='failed'
 *                                 application stage unchanged (stays in Inquiry)
 *
 * Stage changes are BEST-EFFORT: if the target pipeline stage key does not
 * exist in the pipeline_stages table the application is left untouched.
 */

import {
  db,
  portalSubmissionsTable,
  applicationsTable,
  pipelineStagesTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import type { RunResult } from "./runner.js";
import type { PortalRunEvidence } from "./portalEvidence.js";
import {
  resolveWritebackError,
  resolveWritebackTarget,
} from "./stageWritebackTarget.js";
import { planUniversityApplicationIdSync } from "@workspace/portal-adapters";
import { syncApplicationFinance } from "./applicationFinanceSync.js";

// ---------------------------------------------------------------------------
// writebackResult
// ---------------------------------------------------------------------------

/**
 * Updates portal_submissions and (best-effort) the application stage.
 *
 * @param submissionId  The ID of the portal_submissions row
 * @param runResult     Null when the run threw an error
 * @param errorMessage  Set when runResult is null
 * @param workerId      When provided the UPDATE is guarded with
 *                      `locked_by = workerId` so a stale background write
 *                      (e.g. after an inline timeout + requeue) cannot
 *                      clobber a row that has since been re-claimed by
 *                      drain-once or another worker.
 */
export async function writebackResult(
  submissionId: number,
  runResult: RunResult | null,
  errorMessage?: string,
  workerId?: string,
  failureEvidence?: PortalRunEvidence | null,
): Promise<void> {
  const result = runResult?.result ?? null;
  const { submissionStatus, stageKey } = resolveWritebackTarget(
    result,
    runResult?.meta,
  );

  // ----- 1. Load submission to get applicationId --------------------------
  const [sub] = await db
    .select({
      id:                  portalSubmissionsTable.id,
      applicationId:       portalSubmissionsTable.applicationId,
      mode:                portalSubmissionsTable.mode,
      submissionAction:    portalSubmissionsTable.submissionAction,
      providerCommittedAt: portalSubmissionsTable.providerCommittedAt,
    })
    .from(portalSubmissionsTable)
    .where(eq(portalSubmissionsTable.id, submissionId));

  if (!sub) {
    console.error(`[writeback] Submission ${submissionId} not found`);
    return;
  }

  // A provider commitment is deliberately separate from the mutable local
  // status enum. Dry runs never set it. Once set, migration 0095 makes the
  // timestamp immutable and its partial unique index prevents another REAL
  // submit intent for the same canonical application target from also being
  // recorded as provider-committed.
  const providerCommitted =
    sub.mode === "real" &&
    sub.submissionAction === "submit" &&
    (result?.submitted === true || result?.alreadyExists === true);

  // ----- 2. Update portal_submissions -------------------------------------
  // If workerId is provided we guard with locked_by = workerId so that a
  // stale background write (from an inline process that timed out and was
  // requeued) cannot clobber a row that has since been re-claimed.
  const updated = await db
    .update(portalSubmissionsTable)
    .set({
      status:         submissionStatus,
      resultJson:     runResult
                        ? {
                            ...runResult.meta,
                            result: runResult.result,
                            ...(runResult.portalEvidence
                              ? { portalEvidence: runResult.portalEvidence }
                              : {}),
                          }
                        : {
                            error: errorMessage ?? "unknown error",
                            ...(failureEvidence
                              ? { portalEvidence: failureEvidence }
                              : {}),
                          },
      screenshotUrls: runResult?.screenshotUrls ?? [],
      // Persist the portal-assigned reference (e.g. Topkapı success-page uuid)
      // only when present so a later non-submitted run never clobbers it.
      ...(result?.externalRef ? { externalRef: result.externalRef } : {}),
      ...(providerCommitted && sub.providerCommittedAt === null
        ? { providerCommittedAt: new Date() }
        : {}),
      // Structured quota-full context (Phase 2) → meta jsonb. Only set on
      // programFull so other flows never clobber the meta column.
      ...(result?.programFull
        ? {
            meta: {
              requestedProgram: result.requestedProgram,
              openPrograms:     result.openPrograms,
              reason:           "Kontenjan dolu",
              detectedAt:       new Date().toISOString(),
            },
          }
        : {}),
      // Program-not-in-dropdown context → meta jsonb. Only set when the dropdown
      // was reached (availablePrograms non-empty) so the orchestrator can
      // supersede; other flows never clobber the meta column.
      ...(result?.programMissing &&
      result.resolution === "not_in_dropdown" &&
      (result.availablePrograms?.length ?? 0) > 0
        ? {
            meta: {
              requestedProgram:  result.requestedProgram,
              availablePrograms: result.availablePrograms,
              resolution:        "not_in_dropdown",
              reason:            "Program portalda bulunamadı",
              detectedAt:        new Date().toISOString(),
            },
          }
        : {}),
      // Exclusive-region context → meta jsonb. Only set on exclusiveRegion so
      // other flows never clobber the meta column.
      ...(result?.exclusiveRegion
        ? {
            meta: {
              reason:          "Exclusive bölge",
              exclusiveAgency: result.exclusiveAgency ?? null,
              detectedAt:      new Date().toISOString(),
            },
          }
        : {}),
      // Non-SIT-member skip context → meta jsonb. Reuses the exclusive_region
      // status (no migration) but records the true reason so it is not confused
      // with a nationality exclusion. Only set on skippedNotMember.
      ...(result?.skippedNotMember
        ? {
            meta: {
              reason:     "SIT üyesi değil",
              routeTo:    result.routeTo ?? "direct",
              detectedAt: new Date().toISOString(),
            },
          }
        : {}),
      error:          resolveWritebackError(
                        result,
                        submissionStatus,
                        errorMessage,
                      ),
      lockedAt:       null,
      lockedBy:       null,
      updatedAt:      new Date(),
    })
    .where(
      workerId !== undefined
        ? and(
            eq(portalSubmissionsTable.id, submissionId),
            eq(portalSubmissionsTable.lockedBy, workerId),
          )
        : eq(portalSubmissionsTable.id, submissionId),
    )
    .returning({ id: portalSubmissionsTable.id });

  if (workerId !== undefined && updated.length === 0) {
    throw new Error("PORTAL_SUBMISSION_LEASE_LOST");
  }

  // ----- 3. Best-effort canonical application reference sync -------------
  // external_ref is an adapter-defined locator and never becomes the canonical
  // university number by itself. Only explicit proof-bearing evidence may
  // populate the Application tab; conflicting values are preserved.
  if (
    sub.applicationId &&
    (submissionStatus === "submitted" || submissionStatus === "already_exists") &&
    result?.verifiedApplicationNumber
  ) {
    try {
      const [application] = await db
        .select({ universityApplicationId: applicationsTable.universityApplicationId })
        .from(applicationsTable)
        .where(eq(applicationsTable.id, sub.applicationId));
      const plan = planUniversityApplicationIdSync(
        application?.universityApplicationId,
        result.verifiedApplicationNumber,
      );
      if (plan.action === "set") {
        const updated = await db
          .update(applicationsTable)
          .set({ universityApplicationId: plan.value, updatedAt: new Date() })
          .where(and(
            eq(applicationsTable.id, sub.applicationId),
            sql`(${applicationsTable.universityApplicationId} IS NULL OR btrim(${applicationsTable.universityApplicationId}) = '')`,
          ))
          .returning({ id: applicationsTable.id });
        if (updated.length > 0) {
          console.log(
            `[writeback] Submission #${submissionId}: canonical university application ID stored for app #${sub.applicationId}`,
          );
        } else {
          console.warn(
            `[writeback] Submission #${submissionId}: canonical university application ID changed concurrently for app #${sub.applicationId}; preserving current value`,
          );
        }
      } else if (plan.action === "conflict") {
        console.warn(
          `[writeback] Submission #${submissionId}: university application ID conflict for app #${sub.applicationId}; preserving canonical value`,
        );
      }
    } catch (err) {
      console.error("[writeback] Application reference sync failed (non-fatal):", err);
    }
  }

  // ----- 4. Best-effort application stage update --------------------------
  if (stageKey && sub.applicationId) {
    try {
      const [stageRow] = await db
        .select({ key: pipelineStagesTable.key })
        .from(pipelineStagesTable)
        .where(
          and(
            eq(pipelineStagesTable.entityType, "application"),
            eq(pipelineStagesTable.key, stageKey),
          ),
        );

      if (stageRow) {
        await db
          .update(applicationsTable)
          .set({ stage: stageKey, updatedAt: new Date() })
          .where(eq(applicationsTable.id, sub.applicationId));

        await syncApplicationFinance(sub.applicationId);

        console.log(
          `[writeback] Submission #${submissionId}: status=${submissionStatus} → app #${sub.applicationId} stage=${stageKey}`,
        );
      } else {
        console.warn(
          `[writeback] Target stage "${stageKey}" not found in pipeline_stages; skipping stage update`,
        );
      }
    } catch (err) {
      console.error("[writeback] Stage update failed (non-fatal):", err);
    }
  } else {
    console.log(
      `[writeback] Submission #${submissionId}: status=${submissionStatus} (no stage change)`,
    );
  }
}
