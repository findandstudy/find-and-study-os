/**
 * portalManualEnqueue.ts
 *
 * Shared enqueue loop used by every "manually queue applications to the
 * portal automation worker" surface (admin Manual Submit dialog, Applications
 * list bulk "Run" action, ...). NEVER duplicate this loop — the
 * university/adapter is always resolved from the application's own record
 * via resolvePortalRouting, never hardcoded, and the duplicate guard is the
 * single source of truth for "already queued/running".
 */
import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db, applicationsTable, portalSubmissionsTable } from "@workspace/db";
import {
  resolvePortalRouting,
  resolveStudentPortalRouting,
} from "./portalAutoTrigger.js";
import {
  checkMandatoryDocsForApplication,
  parkApplicationInMissingDocsStage,
} from "./mandatoryDocs.js";
import { getDocLabel } from "./docNaming.js";
import {
  prepareApplicationPortalPreflight,
  type PreparedPortalPreflight,
} from "./portalApplicationPreflight.js";
import {
  buildPortalSubmissionIntent,
  getPortalExecutionVerification,
} from "@workspace/portal-runner";

export type PortalEnqueueSkipReason =
  | "NOT_FOUND"
  | "NO_PORTAL"
  | "ALREADY_QUEUED"
  | "RECONCILIATION_REQUIRED"
  | "MISSING_MANDATORY_DOCUMENTS"
  | "PREFLIGHT_NOT_READY"
  | "PARTNER_VERIFICATION_REQUIRED";

export interface PortalEnqueueQueuedRow {
  applicationId: number;
  submissionId: number;
  universityKey: string;
}

export interface PortalEnqueueSkippedRow {
  applicationId: number;
  reason: PortalEnqueueSkipReason;
  submissionId?: number;
  missingDocTypes?: string[];
  missingDocLabels?: string[];
  missingFields?: string[];
  incompatibleFields?: Array<{ field: string; reason: string }>;
  autoFilledFields?: string[];
}

export interface PortalEnqueueResult {
  queued: PortalEnqueueQueuedRow[];
  skipped: PortalEnqueueSkippedRow[];
}

// Namespace for PostgreSQL's two-int advisory lock API. The application id is
// the second key, so concurrent API processes serialize only submissions for
// the same application while unrelated bulk rows remain independent.
const PORTAL_MANUAL_ENQUEUE_LOCK_NAMESPACE = 4_602_019;

/**
 * Enqueues portal_submissions rows (status="queued") for the given
 * application IDs, resolving each application's active portal
 * university/adapter via resolvePortalRouting. Applications without an
 * active portal mapping are reported back with reason "NO_PORTAL" (adapter
 * missing) instead of being silently dropped. Applications with an existing
 * queued/running submission for the same university are skipped as
 * "ALREADY_QUEUED".
 */
export async function enqueuePortalSubmissions(opts: {
  applicationIds: number[];
  mode: "dry" | "real";
  userId: number;
}): Promise<PortalEnqueueResult> {
  const uniqueIds = [...new Set(opts.applicationIds)];

  const apps = await db
    .select({
      id: applicationsTable.id,
      studentId: applicationsTable.studentId,
      universityId: applicationsTable.universityId,
      universityName: applicationsTable.universityName,
    })
    .from(applicationsTable)
    .where(and(inArray(applicationsTable.id, uniqueIds), isNull(applicationsTable.deletedAt)));

  const appMap = new Map(apps.map((a) => [a.id, a]));

  const queued: PortalEnqueueQueuedRow[] = [];
  const skipped: PortalEnqueueSkippedRow[] = [];

  for (const appId of uniqueIds) {
    const app = appMap.get(appId);
    if (!app) {
      skipped.push({ applicationId: appId, reason: "NOT_FOUND" });
      continue;
    }

    const docStatus = await checkMandatoryDocsForApplication(appId);
    if (docStatus && docStatus.missing.length > 0) {
      await parkApplicationInMissingDocsStage(appId);
      skipped.push({
        applicationId: appId,
        reason: "MISSING_MANDATORY_DOCUMENTS",
        missingDocTypes: docStatus.missing,
        missingDocLabels: docStatus.missing.map(getDocLabel),
      });
      continue;
    }

    const baseRouting = await resolvePortalRouting({
      universityId: app.universityId,
      universityName: app.universityName,
    });
    if (!baseRouting) {
      skipped.push({ applicationId: appId, reason: "NO_PORTAL" });
      continue;
    }
    const routing = await resolveStudentPortalRouting({
      routing: baseRouting,
      studentId: app.studentId,
      applicationId: appId,
    });
    if (!routing) {
      skipped.push({ applicationId: appId, reason: "NO_PORTAL" });
      continue;
    }
    const { portalUni, target, submissionUniversityName, routingMeta } = routing;
    const verification = await getPortalExecutionVerification({
      universityKey: portalUni.universityKey,
      adapterKey: portalUni.adapterKey,
    });
    const verificationReady = opts.mode === "dry"
      ? verification?.testLoginPassed === true && verification.binding?.strictDryRunCapable === true
      : verification?.testLoginPassed === true && verification.strictDryRunPassed === true;
    if (!verificationReady) {
      skipped.push({
        applicationId: appId,
        reason: "PARTNER_VERIFICATION_REQUIRED",
      });
      continue;
    }
    const preflight = await prepareApplicationPortalPreflight({
      applicationId: appId,
      adapterKey: portalUni.adapterKey,
      actorUserId: opts.userId,
    });
    if (preflight.supported && !preflight.ready) {
      await parkApplicationInMissingDocsStage(appId);
      skipped.push({
        applicationId: appId,
        reason: "PREFLIGHT_NOT_READY",
        missingFields: preflight.missingFields,
        incompatibleFields: preflight.incompatibleFields,
        missingDocTypes: preflight.missingDocuments,
        missingDocLabels: preflight.missingDocuments.map(getDocLabel),
        autoFilledFields: preflight.autoFilledFields,
      });
      continue;
    }

    const intent = await buildPortalSubmissionIntent({
      applicationId: appId,
      portalUniversity: portalUni,
      targetCatalogUniversityId: target?.catalogUniversityId ?? app.universityId,
      source: "manual",
    });
    const outcome = await db.transaction(async (tx) => {
      // The former read-then-insert guard raced when the user clicked Run
      // again before the first request committed. An xact advisory lock makes
      // that check atomic across API processes without requiring a partial
      // unique index (historical queued rows prevent adding one safely).
      await tx.execute(
        sql`select pg_advisory_xact_lock(
          ${PORTAL_MANUAL_ENQUEUE_LOCK_NAMESPACE},
          ${appId}
        )`,
      );

      const [existing] = await tx
        .select({ id: portalSubmissionsTable.id })
        .from(portalSubmissionsTable)
        .where(
          and(
            eq(portalSubmissionsTable.applicationId, appId),
            or(
              eq(portalSubmissionsTable.targetIdentitySha256, intent.targetIdentitySha256),
              and(
                isNull(portalSubmissionsTable.targetIdentitySha256),
                eq(portalSubmissionsTable.universityKey, portalUni.universityKey),
              ),
            ),
            eq(portalSubmissionsTable.mode, opts.mode),
            inArray(portalSubmissionsTable.status, ["queued", "running"]),
            isNull(portalSubmissionsTable.deletedAt),
          ),
        )
        .limit(1);

      if (existing) {
        return { kind: "existing" as const, id: existing.id };
      }

      if (opts.mode === "real") {
        const [submitted] = await tx
          .select({ id: portalSubmissionsTable.id })
          .from(portalSubmissionsTable)
          .where(and(
            eq(portalSubmissionsTable.applicationId, appId),
            or(
              eq(portalSubmissionsTable.targetIdentitySha256, intent.targetIdentitySha256),
              and(
                isNull(portalSubmissionsTable.targetIdentitySha256),
                eq(portalSubmissionsTable.universityKey, portalUni.universityKey),
              ),
            ),
            eq(portalSubmissionsTable.mode, "real"),
            eq(portalSubmissionsTable.submissionAction, "submit"),
            or(
              isNotNull(portalSubmissionsTable.providerCommittedAt),
              and(
                isNull(portalSubmissionsTable.targetIdentitySha256),
                inArray(portalSubmissionsTable.status, ["submitted", "already_exists", "accepted"]),
                isNotNull(portalSubmissionsTable.externalRef),
              ),
            ),
            isNull(portalSubmissionsTable.deletedAt),
          ))
          .limit(1);
        if (submitted) return { kind: "reconciliation" as const, id: submitted.id };
      }

      const [row] = await tx
        .insert(portalSubmissionsTable)
        .values({
          applicationId: appId,
          studentId: app.studentId,
          universityKey: portalUni.universityKey,
          universityName:
            submissionUniversityName ??
            (target ? target.universityName : portalUni.universityName),
          adapterKey: portalUni.adapterKey,
          mode: opts.mode,
          status: "queued",
          enqueuedBy: opts.userId,
          submitIntentKey: intent.submitIntentKey,
          targetIdentitySha256: intent.targetIdentitySha256,
          targetIdentity: intent.targetIdentity,
          submissionAction: "submit",
          // manual:true marks this row as a deliberate user-selected submission
          // (Applications bulk "Run" action / admin Manual Submit dialog — the
          // only two callers of this shared enqueue loop). claimNext() uses this
          // flag to bypass the trigger-stage and autoProcess claim gates, which
          // exist only to scope AUTOMATIC/scheduled processing.
          meta: {
            manual: true,
            preflight: preflight as PreparedPortalPreflight,
            ...(routingMeta ?? {}),
            ...(target
              ? {
                  targetCatalogUniversityId: target.catalogUniversityId,
                  targetUniversityName: target.universityName,
                  routedViaAggregator: portalUni.universityKey,
                }
              : {}),
          },
        })
        .returning({ id: portalSubmissionsTable.id });

      return { kind: "inserted" as const, id: row.id };
    });

    if (outcome.kind === "existing") {
      skipped.push({
        applicationId: appId,
        reason: "ALREADY_QUEUED",
        submissionId: outcome.id,
      });
      continue;
    }
    if (outcome.kind === "reconciliation") {
      skipped.push({
        applicationId: appId,
        reason: "RECONCILIATION_REQUIRED",
        submissionId: outcome.id,
      });
      continue;
    }

    queued.push({
      applicationId: appId,
      submissionId: outcome.id,
      universityKey: portalUni.universityKey,
    });
  }

  return { queued, skipped };
}
