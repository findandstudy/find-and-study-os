/**
 * portalAutoTrigger.ts — automatic portal submission enqueue
 *
 * Event-driven: called (fire-and-forget) from PATCH /applications/:id whenever
 * the stage changes AND from POST /applications when a new application is
 * created at a trigger stage.  Batch: scanAndEnqueueTriggerStageApplications is
 * used by the "Run Now" endpoint to enqueue every eligible trigger-stage
 * application on demand.
 *
 * The eligibility gate (single source of truth in enqueueIfEligible) checks:
 *
 *   1. triggerStages — the stage must be in the configured list
 *   2. University lookup — the application's university must have an active
 *      portal_universities row (matched by crmUniversityId then by name)
 *   3. Scope filter:
 *        only_applied → university row exists + isActive (default)
 *        selected     → additionally, universityKey ∈ selectedUniversityKeys
 *        all          → same as only_applied (row must still exist + isActive)
 *   4. hasCredentials — DB row (portal_credentials) or env vars set
 *   5. Dedup — skip when a queued/running/submitted submission already exists
 *              for this application × universityKey pair
 *
 * The global isEnabled kill-switch is checked once by each caller before the
 * gate runs.  All single-trigger failures are logged via console.error and
 * swallowed so the HTTP response is never blocked.
 */

import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import {
  db,
  applicationsTable,
  portalAutomationSettingsTable,
  portalUniversitiesTable,
  portalSubmissionsTable,
  portalAccountUniversitiesTable,
  pipelineStagesTable,
  universitiesTable,
  studentsTable,
} from "@workspace/db";
import { logAudit } from "./auth.js";
import { checkHasPortalCredentials } from "./portalCreds.js";
import {
  isSitExcludedUniversity,
  shouldRouteTopkapiToMultico,
  validateIdentityFields,
  formatIdentityErrors,
} from "@workspace/portal-adapters";
import {
  checkMandatoryDocsForApplication,
  parkApplicationInMissingDocsStage,
} from "./mandatoryDocs.js";
import { prepareApplicationPortalPreflight } from "./portalApplicationPreflight.js";
import { buildPortalTriggerStageSnapshot } from "./portalTriggerStagePolicy.js";
import {
  buildPortalSubmissionIntent,
  getPortalExecutionVerification,
} from "@workspace/portal-runner";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AutoTriggerParams {
  applicationId: number;
  studentId:     number;
  newStage:      string;
  /** Application's university free-text name (nullable). */
  universityName: string | null;
  /** Application's universityId FK (→ universities.id; used for exact match). */
  universityId:   number | null;
  actorUserId:    number | null;
}

/** Settings row shape used by the eligibility gate. */
type PortalSettings = typeof portalAutomationSettingsTable.$inferSelect;
const ELIGIBLE_TRIGGER_STAGES = Symbol("eligiblePortalTriggerStages");
type EligiblePortalSettings = PortalSettings & {
  [ELIGIBLE_TRIGGER_STAGES]: true;
};

/**
 * Runtime projection of saved trigger keys against the current Application
 * Pipeline. This also protects execution immediately after rollout, before an
 * operator has re-saved any legacy configuration.
 */
export async function withEligiblePortalTriggerStages<T extends PortalSettings>(
  settings: T,
): Promise<T & EligiblePortalSettings> {
  if ((settings as Partial<EligiblePortalSettings>)[ELIGIBLE_TRIGGER_STAGES]) {
    return settings as T & EligiblePortalSettings;
  }
  const stages = await db
    .select({
      key: pipelineStagesTable.key,
      label: pipelineStagesTable.label,
      sortOrder: pipelineStagesTable.sortOrder,
      variant: pipelineStagesTable.variant,
      isCaseClose: pipelineStagesTable.isCaseClose,
    })
    .from(pipelineStagesTable)
    .where(eq(pipelineStagesTable.entityType, "application"))
    .orderBy(asc(pipelineStagesTable.sortOrder), asc(pipelineStagesTable.id));
  const snapshot = buildPortalTriggerStageSnapshot(
    stages,
    Array.isArray(settings.triggerStages) ? settings.triggerStages as string[] : [],
  );
  const runtimeSettings = {
    ...settings,
    triggerStages: snapshot.validConfiguredKeys,
  } as T & EligiblePortalSettings;
  Object.defineProperty(runtimeSettings, ELIGIBLE_TRIGGER_STAGES, {
    value: true,
    enumerable: false,
  });
  return runtimeSettings;
}

/** Reason codes for a skipped application — surfaced to the Run Now UI. */
export type SkipReason =
  | "stage_not_trigger"
  | "no_active_portal_university"
  | "out_of_scope"
  | "no_credentials"
  | "duplicate"
  | "reconciliation_required"
  | "max_failures"
  | "missing_mandatory_documents"
  | "preflight_not_ready"
  | "partner_verification_required"
  /** mode=real submission blocked due to invalid/placeholder identity fields. */
  | "invalid_identity_fields";

export type EnqueueOutcome =
  | { status: "queued"; submissionId: number; universityKey: string }
  | { status: "skipped"; reason: SkipReason };

const ACTIVE_STATUSES = ["queued", "running", "submitted", "already_exists", "accepted"] as const;

/**
 * Cross-row automatic retry budget per application × university pair.
 *
 * Each enqueue creates a NEW portal_submissions row (attempts resets to 0), so
 * the per-row attempts/max_attempts columns alone cannot stop the auto-trigger
 * loop: a failed run leaves the row in "failed" (not in ACTIVE_STATUSES), the
 * next scan sees "no active duplicate" and enqueues a fresh row — forever.
 * This constant caps that: once this many failed rows exist for the pair, the
 * automatic paths stop re-enqueuing (skip reason "max_failures"). Manual
 * single-submission endpoints intentionally bypass this so staff can retry
 * after fixing the underlying cause.
 */
export const MAX_AUTO_FAILED_SUBMISSIONS = 3;

// ---------------------------------------------------------------------------
// Immediate drain trigger (Scheduled Auto-Process OFF)
// ---------------------------------------------------------------------------

type DrainTrigger = (label: string, triggerStages?: string[]) => void;

/**
 * Default: fire the shared non-blocking background drain in
 * routes/portalAutomation.ts. Dynamic import breaks the circular dependency
 * (portalAutomation.ts imports from this module) — same accepted pattern as
 * maybeFanOutStudentForApplication. Never awaited, never throws to callers.
 */
const defaultDrainTrigger: DrainTrigger = (label, triggerStages) => {
  void (async () => {
    try {
      const { triggerBackgroundDrain } = await import("../routes/portalAutomation.js");
      triggerBackgroundDrain(label, triggerStages);
    } catch (err) {
      console.error("[portal-auto] immediate drain trigger failed:", err);
    }
  })();
};

let drainTrigger: DrainTrigger = defaultDrainTrigger;

/** Test seam — inject a spy; pass null to restore the default trigger. */
export function __setDrainTriggerForTests(fn: DrainTrigger | null): void {
  drainTrigger = fn ?? defaultDrainTrigger;
}

/**
 * Fires a non-blocking drain right after a successful enqueue when Scheduled
 * Auto-Process is OFF (immediate mode). With Scheduled ON the periodic
 * auto-drain scheduler owns draining instead. Reuses the already-loaded
 * settings row — no extra query. The shared _processMutex makes concurrent
 * fires safe (an in-flight drain picks up the newly queued row).
 */
function maybeTriggerImmediateDrain(settings: PortalSettings, label: string): void {
  if (!settings.isEnabled || settings.autoProcessEnabled) return;
  const stages = Array.isArray(settings.triggerStages)
    ? (settings.triggerStages as string[])
    : [];
  drainTrigger(label, stages);
}

// ---------------------------------------------------------------------------
// findActivePortalUniversity
// ---------------------------------------------------------------------------

/**
 * Resolves the active portal_universities row for an application's university,
 * matching by crmUniversityId (exact) then universityName (case-insensitive).
 *
 * Single source of truth shared by the auto-trigger and the manual-submit
 * endpoint so both pick the same adapter from the application's OWN record
 * (never a hardcoded universityKey). Returns null when no active match exists.
 */
export async function findActivePortalUniversity(args: {
  universityId: number | null;
  universityName: string | null;
}): Promise<typeof portalUniversitiesTable.$inferSelect | null> {
  const { universityId, universityName } = args;
  if (universityId == null && !universityName) return null;

  const baseConditions = [
    isNull(portalUniversitiesTable.deletedAt),
    eq(portalUniversitiesTable.isActive, true),
  ];

  let matchCondition;
  if (universityId != null && universityName) {
    matchCondition = or(
      eq(portalUniversitiesTable.crmUniversityId, universityId),
      sql`LOWER(${portalUniversitiesTable.universityName}) = LOWER(${universityName})`,
    );
  } else if (universityId != null) {
    matchCondition = eq(portalUniversitiesTable.crmUniversityId, universityId);
  } else {
    matchCondition = sql`LOWER(${portalUniversitiesTable.universityName}) = LOWER(${universityName!})`;
  }

  const [row] = await db
    .select()
    .from(portalUniversitiesTable)
    .where(and(...baseConditions, matchCondition!))
    .limit(1);

  return row ?? null;
}

// ---------------------------------------------------------------------------
// resolvePortalRouting — membership-aware target resolution
// ---------------------------------------------------------------------------

/**
 * The submission target for an application's university, resolving aggregator
 * membership FIRST (member → aggregator wins) and falling back to the
 * standalone portal_universities row.
 *
 *   1. MEMBERSHIP (aggregator) — if the application's catalog university has an
 *      ENABLED row in portal_account_universities pointing at an ACTIVE
 *      aggregator portal_universities row (SIT/United), the submission is routed
 *      to that aggregator: `portalUni` is the aggregator row and `target` names
 *      the member (catalog) university. This wins even when the member ALSO has
 *      its own standalone portal row (which lacks the aggregator's credentials).
 *   2. STANDALONE — otherwise the application uses its own portal row, exactly
 *      as before (`target` is null).
 *
 * Returns null when neither a membership nor a standalone row matches.
 */
export interface PortalRoutingResolution {
  /** The portal_universities row driving universityKey / adapter / credentials. */
  portalUni: typeof portalUniversitiesTable.$inferSelect;
  /**
   * When routed through an aggregator membership, the member (catalog)
   * university whose school must be selected inside the aggregator portal.
   * Null on the standalone path.
   */
  target: { catalogUniversityId: number; universityName: string } | null;
}

export interface StudentPortalRoutingResolution extends PortalRoutingResolution {
  /** Preserve the catalog university label when an exclusive route is used. */
  submissionUniversityName?: string;
  /** Non-sensitive routing proof persisted in portal_submissions.meta. */
  routingMeta?: {
    exclusiveNationalityRoute: "multico";
    routedFromUniversityKey: string;
  };
}

export async function resolvePortalRouting(args: {
  universityId: number | null;
  universityName: string | null;
}): Promise<PortalRoutingResolution | null> {
  const { universityId, universityName } = args;

  // Resolve the catalog university ID we will use for membership lookup.
  // When the application already carries the FK we use it directly; when only
  // a free-text name is available (universityId=null) we look the catalog row
  // up by name so that SIT/United members are routed to their aggregator even
  // without a universityId FK on the application row.
  let resolvedUniversityId = universityId;
  if (resolvedUniversityId == null && universityName) {
    const [cat] = await db
      .select({ id: universitiesTable.id })
      .from(universitiesTable)
      .where(sql`LOWER(${universitiesTable.name}) = LOWER(${universityName})`)
      .limit(1);
    resolvedUniversityId = cat?.id ?? null;
  }

  // ----- Rule 1: aggregator membership (wins over a standalone row) ---------
  if (resolvedUniversityId != null) {
    const [member] = await db
      .select({ portalKey: portalAccountUniversitiesTable.portalKey })
      .from(portalAccountUniversitiesTable)
      .where(
        and(
          eq(portalAccountUniversitiesTable.catalogUniversityId, resolvedUniversityId),
          eq(portalAccountUniversitiesTable.enabled, true),
        ),
      )
      .limit(1);

    if (member) {
      const [aggregator] = await db
        .select()
        .from(portalUniversitiesTable)
        .where(
          and(
            eq(portalUniversitiesTable.universityKey, member.portalKey),
            eq(portalUniversitiesTable.isActive, true),
            isNull(portalUniversitiesTable.deletedAt),
          ),
        )
        .limit(1);

      if (aggregator) {
        // Prefer the canonical catalog name (what the aggregator portal lists);
        // fall back to the application free-text, then the aggregator label.
        const [cat] = await db
          .select({ name: universitiesTable.name })
          .from(universitiesTable)
          .where(eq(universitiesTable.id, resolvedUniversityId))
          .limit(1);
        const memberName =
          cat?.name ?? universityName ?? aggregator.universityName;
        // Database membership is admin-managed and can become stale. Explicit
        // exclusions always win, but valid panel-managed dynamic SIT members
        // remain supported. Fall through to a dedicated standalone portal
        // when one exists.
        if (
          aggregator.adapterKey === "sit" &&
          isSitExcludedUniversity(memberName)
        ) {
          console.warn(
            `[portal-routing] ignored excluded SIT membership` +
              ` university=${memberName} catalogId=${resolvedUniversityId}`,
          );
        } else {
          return {
            portalUni: aggregator,
            target: { catalogUniversityId: resolvedUniversityId, universityName: memberName },
          };
        }
      }
      // Aggregator row missing/inactive → fall through to the standalone match.
    }
  }

  // ----- Rule 2: standalone portal row (legacy path, unchanged) ------------
  const standalone = await findActivePortalUniversity({ universityId, universityName });
  return standalone ? { portalUni: standalone, target: null } : null;
}

/**
 * Applies student-specific policy after normal university/membership routing.
 * Adapter identity is stable; universityKey is admin data (the live Topkapı
 * key is `topkapi_university`, not `topkapi`). Exclusive routes fail closed.
 */
export async function resolveStudentPortalRouting(args: {
  routing: PortalRoutingResolution;
  studentId: number;
  applicationId?: number;
}): Promise<StudentPortalRoutingResolution | null> {
  const { routing, studentId, applicationId } = args;
  if (routing.portalUni.adapterKey !== "topkapi") return { ...routing };

  const [studentRow] = await db
    .select({ nationality: studentsTable.nationality })
    .from(studentsTable)
    .where(eq(studentsTable.id, studentId))
    .limit(1);
  const nationality = studentRow?.nationality ?? null;
  if (!shouldRouteTopkapiToMultico(routing.portalUni.adapterKey, nationality)) {
    return { ...routing };
  }

  const [multicoRow] = await db
    .select()
    .from(portalUniversitiesTable)
    .where(
      and(
        eq(portalUniversitiesTable.universityKey, "multico"),
        eq(portalUniversitiesTable.isActive, true),
        isNull(portalUniversitiesTable.deletedAt),
      ),
    )
    .limit(1);
  if (!multicoRow) {
    console.warn(
      `[portal-routing] exclusive Multico target unavailable` +
      ` app=${applicationId ?? "?"} student=${studentId}`,
    );
    return null;
  }

  console.log(
    `[portal-routing] Multico redirect app=${applicationId ?? "?"}` +
    ` student=${studentId} from=${routing.portalUni.universityKey}`,
  );
  return {
    portalUni: multicoRow,
    target: routing.target,
    submissionUniversityName:
      routing.target?.universityName ?? routing.portalUni.universityName,
    routingMeta: {
      exclusiveNationalityRoute: "multico",
      routedFromUniversityKey: routing.portalUni.universityKey,
    },
  };
}

// ---------------------------------------------------------------------------
// enqueueIfEligible — the shared eligibility gate (single source of truth)
// ---------------------------------------------------------------------------

/**
 * Evaluates the portal-automation policy for one application/stage pair against
 * the provided settings and inserts a portal_submissions row when every gate
 * passes.  Does NOT check settings.isEnabled — callers gate on that once before
 * iterating.  Returns a structured outcome so batch callers can tally reasons.
 */
export async function enqueueIfEligible(
  params: AutoTriggerParams,
  settings: PortalSettings,
): Promise<EnqueueOutcome> {
  settings = await withEligiblePortalTriggerStages(settings);
  const { applicationId, studentId, newStage, universityName, universityId, actorUserId } = params;

  // ----- Gate 1: trigger stage -----------------------------------------
  const triggerStages = Array.isArray(settings.triggerStages)
    ? (settings.triggerStages as string[])
    : [];
  if (!triggerStages.includes(newStage)) {
    return { status: "skipped", reason: "stage_not_trigger" };
  }

  // ----- Gate 2: mandatory documents -----------------------------------
  // This is deliberately repeated at the final queue boundary. UI gates can
  // be bypassed by stale clients and creation flows can race with document
  // persistence; portal automation must never claim an incomplete record.
  const docStatus = await checkMandatoryDocsForApplication(applicationId);
  if (!docStatus || docStatus.missing.length > 0) {
    if (docStatus?.missing.length) {
      console.warn(
        `[portal-enqueue] mandatory documents missing for app=${applicationId}: ${docStatus.missing.join(",")}`,
      );
    }
    if (docStatus?.missing.length) {
      await parkApplicationInMissingDocsStage(applicationId);
    }
    return { status: "skipped", reason: "missing_mandatory_documents" };
  }

  // ----- Gate 3: resolve routing (membership → aggregator wins) ---------
  const routing = await resolvePortalRouting({ universityId, universityName });
  if (!routing) {
    return { status: "skipped", reason: "no_active_portal_university" };
  }
  const studentRouting = await resolveStudentPortalRouting({
    routing,
    studentId,
    applicationId,
  });
  if (!studentRouting) {
    return { status: "skipped", reason: "no_active_portal_university" };
  }
  const { portalUni, target, submissionUniversityName, routingMeta } = studentRouting;

  // ----- Gate 4: scope filter -------------------------------------------
  if (settings.scope === "selected") {
    const selectedKeys = Array.isArray(settings.selectedUniversityKeys)
      ? (settings.selectedUniversityKeys as string[])
      : [];
    if (!selectedKeys.includes(portalUni.universityKey)) {
      return { status: "skipped", reason: "out_of_scope" };
    }
  }
  // scope='only_applied' and scope='all' both pass when a portal_uni row exists

  // ----- Gate 5: application-scoped portal preflight + safe enrichment -----
  // This is the common cross-portal contract: recover high-confidence values
  // from existing documents into EMPTY CRM fields, re-evaluate, and keep an
  // incomplete application out of the queue.
  const preflight = await prepareApplicationPortalPreflight({
    applicationId,
    adapterKey: portalUni.adapterKey,
    actorUserId,
  });
  if (preflight.supported && !preflight.ready) {
    console.warn(
      `[portal-enqueue] preflight blocked app=${applicationId}` +
      ` adapter=${portalUni.adapterKey}` +
      ` missing=${preflight.missingFields.join(",") || "-"}` +
      ` docs=${preflight.missingDocuments.join(",") || "-"}`,
    );
    await parkApplicationInMissingDocsStage(applicationId);
    return { status: "skipped", reason: "preflight_not_ready" };
  }

  // ----- Gate 6: credentials check (DB-first + env fallback) -----------
  if (!await checkHasPortalCredentials(portalUni.universityKey, portalUni.adapterKey)) {
    return { status: "skipped", reason: "no_credentials" };
  }

  // ----- Gate 7: current, version-bound partner verification -------------
  // Automatic execution is stricter than the guided onboarding dry run: both
  // the login and strict dry-run receipts must match the current adapter,
  // credential, routing generation and runtime release.
  const verification = await getPortalExecutionVerification({
    universityKey: portalUni.universityKey,
    adapterKey: portalUni.adapterKey,
  });
  if (!verification?.testLoginPassed || !verification.strictDryRunPassed) {
    return { status: "skipped", reason: "partner_verification_required" };
  }

  // ----- Gate 8: identity field validation (mode=real only) ----------------
  // We never enqueue a real submission when critical identity fields are
  // missing, placeholder, or logically inconsistent — a wrong passport number
  // or garbled name is worse than no submission at all (it can block the
  // student's visa/registration). Dry runs bypass this gate so staff can test
  // portal connectivity without needing perfect data.
  if (settings.mode === "real") {
    const [studentForValidation] = await db
      .select({
        passportNumber:   studentsTable.passportNumber,
        firstName:        studentsTable.firstName,
        lastName:         studentsTable.lastName,
        dateOfBirth:      studentsTable.dateOfBirth,
        passportIssueDate: studentsTable.passportIssueDate,
        passportExpiry:   studentsTable.passportExpiry,
      })
      .from(studentsTable)
      .where(eq(studentsTable.id, studentId))
      .limit(1);
    if (studentForValidation) {
      const idErrors = validateIdentityFields({
        passportNumber:    studentForValidation.passportNumber,
        firstName:         studentForValidation.firstName,
        lastName:          studentForValidation.lastName,
        dateOfBirth:       studentForValidation.dateOfBirth,
        passportIssueDate: studentForValidation.passportIssueDate,
        passportExpiryDate: studentForValidation.passportExpiry,
      });
      if (idErrors.length > 0) {
        console.warn(
          `[portal-enqueue] identity validation FAILED for student=${studentId} app=${applicationId} uni=${portalUni.universityKey}: ${formatIdentityErrors(idErrors)}`,
        );
        await parkApplicationInMissingDocsStage(applicationId);
        return { status: "skipped", reason: "invalid_identity_fields" };
      }
    }
  }

  // ----- Gate 9: dedup + enqueue (atomic) -------------------------------
  // A plain SELECT-then-INSERT is racy: multiple callers (creation hook, PATCH
  // hook, Run Now scan, or multiple server instances) can fire for the same
  // application concurrently, all pass the read, and all insert duplicate
  // queued rows.  Schema changes are out of scope (no partial unique index), so
  // we serialize the check+insert with a transaction-scoped Postgres advisory
  // lock keyed by (applicationId, universityKey).  The lock is released
  // automatically on commit/rollback, guaranteeing at most one active
  // submission per application × university pair.
  const intent = await buildPortalSubmissionIntent({
    applicationId,
    portalUniversity: portalUni,
    targetCatalogUniversityId: target?.catalogUniversityId ?? universityId,
    source: "automatic",
  });
  const outcome = await db.transaction(async (tx): Promise<EnqueueOutcome> => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${applicationId}, hashtext(${portalUni.universityKey}))`,
    );

    const [existing] = await tx
      .select({
        id: portalSubmissionsTable.id,
        status: portalSubmissionsTable.status,
        externalRef: portalSubmissionsTable.externalRef,
        targetIdentitySha256: portalSubmissionsTable.targetIdentitySha256,
        providerCommittedAt: portalSubmissionsTable.providerCommittedAt,
      })
      .from(portalSubmissionsTable)
      .where(
        and(
          eq(portalSubmissionsTable.applicationId, applicationId),
          or(
            eq(portalSubmissionsTable.targetIdentitySha256, intent.targetIdentitySha256),
            and(
              isNull(portalSubmissionsTable.targetIdentitySha256),
              eq(portalSubmissionsTable.universityKey, portalUni.universityKey),
            ),
          ),
          or(
            inArray(portalSubmissionsTable.status, [...ACTIVE_STATUSES]),
            isNotNull(portalSubmissionsTable.providerCommittedAt),
          ),
          isNull(portalSubmissionsTable.deletedAt),
        ),
      )
      .limit(1);

    if (existing) {
      if (
        existing.providerCommittedAt !== null ||
        (existing.targetIdentitySha256 === null &&
          ["submitted", "already_exists", "accepted"].includes(existing.status) &&
          existing.externalRef)
      ) {
        return { status: "skipped", reason: "reconciliation_required" };
      }
      return { status: "skipped", reason: "duplicate" };
    }

    // Cross-row failure cap: failed rows are NOT in ACTIVE_STATUSES, so without
    // this every scan/trigger would insert a fresh queued row after each failure
    // — an infinite retry loop that also blocks the rest of the queue. Once the
    // pair has accumulated MAX_AUTO_FAILED_SUBMISSIONS failed rows, automatic
    // enqueue stops permanently; only a manual retry (separate endpoint) can
    // re-submit after the root cause is fixed.
    const [failedCountRow] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(portalSubmissionsTable)
      .where(
        and(
          eq(portalSubmissionsTable.applicationId, applicationId),
          eq(portalSubmissionsTable.universityKey, portalUni.universityKey),
          eq(portalSubmissionsTable.status, "failed"),
          isNull(portalSubmissionsTable.deletedAt),
        ),
      );
    if ((failedCountRow?.n ?? 0) >= MAX_AUTO_FAILED_SUBMISSIONS) {
      console.warn(
        `[portal-auto] app=${applicationId} uni=${portalUni.universityKey}: ` +
          `${failedCountRow!.n} başarısız deneme — otomatik yeniden kuyruklama durduruldu (max_failures)`,
      );
      return { status: "skipped", reason: "max_failures" };
    }

    const [row] = await tx
      .insert(portalSubmissionsTable)
      .values({
        applicationId,
        studentId,
        universityKey:  portalUni.universityKey,
        universityName: submissionUniversityName ?? (target ? target.universityName : portalUni.universityName),
        adapterKey:     portalUni.adapterKey,
        mode:           settings.mode,
        status:         "queued",
        enqueuedBy:     actorUserId,
        submitIntentKey: intent.submitIntentKey,
        targetIdentitySha256: intent.targetIdentitySha256,
        targetIdentity: intent.targetIdentity,
        submissionAction: "submit",
        meta: {
          preflight,
          ...(routingMeta ?? {}),
          ...(target
            ? {
                targetCatalogUniversityId: target.catalogUniversityId,
                targetUniversityName:      target.universityName,
                routedViaAggregator:       portalUni.universityKey,
              }
            : {}),
        },
      })
      .returning({ id: portalSubmissionsTable.id });

    return { status: "queued", submissionId: row.id, universityKey: portalUni.universityKey };
  });

  if (outcome.status === "queued") {
    logAudit(
      actorUserId,
      "auto_enqueue_portal_submission",
      "portal_submission",
      outcome.submissionId,
      {
        applicationId,
        universityKey: portalUni.universityKey,
        newStage,
        mode: settings.mode,
      },
    );
  }

  return outcome;
}

// ---------------------------------------------------------------------------
// maybeEnqueuePortalSubmission — event-driven single trigger (fire-and-forget)
// ---------------------------------------------------------------------------

/**
 * Evaluates the portal-automation policy for the given application/stage
 * transition and inserts a portal_submissions row when all gates pass.
 *
 * The function is intentionally async but callers MUST fire-and-forget:
 *   maybeEnqueuePortalSubmission(params).catch(err => console.error(...))
 */
export async function maybeEnqueuePortalSubmission(
  params: AutoTriggerParams,
): Promise<void> {
  // ----- Global kill-switch --------------------------------------------
  const [savedSettings] = await db
    .select()
    .from(portalAutomationSettingsTable)
    .limit(1);

  if (!savedSettings?.isEnabled) return;
  const settings = await withEligiblePortalTriggerStages(savedSettings);

  const outcome = await enqueueIfEligible(params, settings);

  if (outcome.status === "queued") {
    console.log(
      `[portal-auto] Enqueued submission #${outcome.submissionId}` +
      ` app=${params.applicationId} uni=${outcome.universityKey}` +
      ` stage=${params.newStage} mode=${settings.mode}`,
    );
    maybeTriggerImmediateDrain(settings, "auto-single");
  } else if (outcome.reason === "duplicate") {
    console.log(
      `[portal-auto] Dedup — active submission already exists ` +
      `for app #${params.applicationId}; skipping`,
    );
  }
}

// ---------------------------------------------------------------------------
// enqueueOnStageChange — event-driven hook for any pipeline-stage update
// ---------------------------------------------------------------------------

/**
 * Best-effort immediate enqueue after any pipeline-stage change.
 * Call fire-and-forget (void) from every stage-change callsite.
 *
 * - If `applicationId` is provided (single application known): only that
 *   application is evaluated against the eligibility gate.
 * - Otherwise: every non-deleted application belonging to `studentId` is
 *   evaluated, covering student-status-level promotions where the applicationId
 *   is not directly at hand.
 *
 * `actorUserId` accepts null for system-initiated enqueues (public embed etc.).
 * Wrapped entirely in try/catch — never throws, never blocks the caller.
 */
export async function enqueueOnStageChange(opts: {
  studentId: number;
  newStage: string;
  actorUserId: number | null;
  applicationId?: number;
  universityName?: string | null;
  universityId?: number | null;
}): Promise<void> {
  try {
    const [savedSettings] = await db.select().from(portalAutomationSettingsTable).limit(1);
    if (!savedSettings?.isEnabled) return;
    const settings = await withEligiblePortalTriggerStages(savedSettings);

    const actorId = opts.actorUserId ?? 0;

    if (opts.applicationId !== undefined) {
      // Fast path — single application known
      const outcome = await enqueueIfEligible(
        {
          applicationId:  opts.applicationId,
          studentId:      opts.studentId,
          newStage:       opts.newStage,
          universityName: opts.universityName ?? null,
          universityId:   opts.universityId ?? null,
          actorUserId:    actorId,
        },
        settings,
      );
      if (outcome.status === "queued") {
        console.log(
          `[portal-auto] Stage-change enqueue: sub=#${outcome.submissionId}` +
          ` app=${opts.applicationId} stage=${opts.newStage}`,
        );
        maybeTriggerImmediateDrain(settings, "auto-stagechange");
      }

      // Auto fan-out (best-effort). Dynamic import breaks the circular dependency
      // with portalAutomation.ts (which itself imports from this module).
      void (async () => {
        try {
          const { maybeFanOutStudentForApplication } = await import("../routes/portalAutomation.js");
          await maybeFanOutStudentForApplication(opts.applicationId as number, actorId);
        } catch (_) { /* non-fatal */ }
      })();
      return;
    }

    // Student-level stage change — scan all non-deleted applications
    const apps = await db
      .select({
        id:             applicationsTable.id,
        universityId:   applicationsTable.universityId,
        universityName: applicationsTable.universityName,
      })
      .from(applicationsTable)
      .where(and(
        eq(applicationsTable.studentId, opts.studentId),
        isNull(applicationsTable.deletedAt),
      ));

    let anyQueued = false;
    for (const app of apps) {
      const outcome = await enqueueIfEligible(
        {
          applicationId:  app.id,
          studentId:      opts.studentId,
          newStage:       opts.newStage,
          universityName: app.universityName ?? null,
          universityId:   app.universityId ?? null,
          actorUserId:    actorId,
        },
        settings,
      );
      if (outcome.status === "queued") {
        anyQueued = true;
        console.log(
          `[portal-auto] Stage-change enqueue: sub=#${outcome.submissionId}` +
          ` app=${app.id} stage=${opts.newStage}`,
        );
      }

      // Auto fan-out per application (best-effort, dynamic import, non-blocking).
      void (async () => {
        try {
          const { maybeFanOutStudentForApplication } = await import("../routes/portalAutomation.js");
          await maybeFanOutStudentForApplication(app.id, actorId);
        } catch (_) { /* non-fatal */ }
      })();
    }

    // Fire ONCE after the sweep — a single drain picks up every row queued above.
    if (anyQueued) maybeTriggerImmediateDrain(settings, "auto-sweep");
  } catch (e) {
    console.error("[portal-auto] enqueueOnStageChange error (non-fatal):", e);
  }
}

// ---------------------------------------------------------------------------
// scanAndEnqueueTriggerStageApplications — batch (Run Now)
// ---------------------------------------------------------------------------

export interface RunNowSummary {
  scanned: number;
  queued: number;
  skipped: number;
  /** Count of skips grouped by reason code. */
  reasons: Partial<Record<SkipReason, number>>;
  /** Ids of the submissions enqueued by this run. */
  queuedIds: number[];
}

/**
 * Scans every non-deleted application whose current stage is one of the
 * configured trigger stages and enqueues the eligible ones, reusing the exact
 * same per-application gate as the event-driven path (enqueueIfEligible).
 *
 * The caller MUST verify settings.isEnabled before calling.  Returns a summary
 * with per-reason skip counts so the UI can report N queued / M skipped.
 */
export async function scanAndEnqueueTriggerStageApplications(
  actorUserId: number,
  settings: PortalSettings,
): Promise<RunNowSummary> {
  settings = await withEligiblePortalTriggerStages(settings);
  const summary: RunNowSummary = {
    scanned: 0,
    queued: 0,
    skipped: 0,
    reasons: {},
    queuedIds: [],
  };

  const triggerStages = Array.isArray(settings.triggerStages)
    ? (settings.triggerStages as string[])
    : [];
  if (triggerStages.length === 0) return summary;

  const apps = await db
    .select({
      id:             applicationsTable.id,
      studentId:      applicationsTable.studentId,
      stage:          applicationsTable.stage,
      universityId:   applicationsTable.universityId,
      universityName: applicationsTable.universityName,
    })
    .from(applicationsTable)
    .where(
      and(
        inArray(applicationsTable.stage, triggerStages),
        isNull(applicationsTable.deletedAt),
      ),
    )
    .orderBy(asc(applicationsTable.id));

  for (const app of apps) {
    summary.scanned += 1;
    try {
      const outcome = await enqueueIfEligible(
        {
          applicationId:  app.id,
          studentId:      app.studentId,
          newStage:       app.stage,
          universityName: app.universityName ?? null,
          universityId:   app.universityId ?? null,
          actorUserId,
        },
        settings,
      );

      if (outcome.status === "queued") {
        summary.queued += 1;
        summary.queuedIds.push(outcome.submissionId);
      } else {
        summary.skipped += 1;
        summary.reasons[outcome.reason] = (summary.reasons[outcome.reason] ?? 0) + 1;
      }
    } catch (err) {
      summary.skipped += 1;
      console.error(`[portal-auto] Run Now gate failed for app #${app.id}:`, err);
    }
  }

  return summary;
}
