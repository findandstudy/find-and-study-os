import { Router, type IRouter, raw } from "express";
import { createHash, randomUUID } from "node:crypto";
import { dispatchNotification } from "../lib/notificationDispatcher.js";
import { and, asc, count, desc, eq, getTableColumns, gte, ilike, inArray, isNotNull, isNull, lte, ne, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  applicationsTable,
  studentsTable,
  programsTable,
  universitiesTable,
  portalSubmissionsTable,
  portalUniversitiesTable,
  portalProgramMappingTable,
  portalProgramCacheTable,
  portalAdapterSpecsTable,
  portalAccountUniversitiesTable,
  portalAutomationSettingsTable,
  portalLifecycleProposalsTable,
  portalLifecycleProposalReviewsTable,
} from "@workspace/db";
import {
  buildWorkbookBuffer,
  parseWorkbookBuffer,
  XLSX_CONTENT_TYPE,
  PROGRAM_MAPPING_KIND,
  PROGRAM_MAPPING_SHEET,
  programMappingColumns,
  type WorkbookSpec,
} from "../lib/exportImportExcel";
import { ImportValidationError } from "../lib/exportImport";
import {
  findActivePortalUniversity,
  resolvePortalRouting,
  resolveStudentPortalRouting,
  scanAndEnqueueTriggerStageApplications,
  MAX_AUTO_FAILED_SUBMISSIONS,
  withEligiblePortalTriggerStages,
} from "../lib/portalAutoTrigger.js";
import { buildPageMeta, parsePaginationParams } from "@workspace/pagination";
import {
  resolveAdapterByKey,
  setCredsOverride,
  clearCredsOverride,
  parseAdapterSpec,
  specHasJsHook,
  specIsPrivileged,
  invalidateSpecAdapterCache,
  listSpecVersions,
  matchProgram,
  levelGroup,
  isSitMember,
  isSitExcludedUniversity,
  type ProgramCandidate,
  type PortalStatusCheckResult,
  type UniversityAdapter,
  type AdapterSession,
  type PortalStatusArtifactKind,
} from "@workspace/portal-adapters";
import { isAgentRole } from "@workspace/roles";
import { logAudit, requireAuth, requireRole } from "../lib/auth";
import { getAgentVisibleIds } from "../lib/agentVisibility";
import { ADMIN_ROLES, STAFF_ROLES } from "../lib/roles";
import { transliterateToLatin } from "../lib/textNormalize";
import { checkMandatoryDocsForApplication, checkMandatoryDocsForStudent } from "../lib/mandatoryDocs.js";
import { getDocLabel } from "../lib/docNaming.js";
import { getValidated, validate } from "../middlewares/validate";
import {
  claimById,
  claimNext,
  heartbeat,
  buildStudentProfile,
  runSubmission,
  writebackResult,
  resolveAdapterKey,
  resolveNationalityExclusion,
  getExperimentalExcludedUniversityKeys,
  type ClaimedSubmission,
  getApplicationMandatoryDocumentStatus,
  syncApplicationFinance,
  claimDuePortalStatusChecks,
  completePortalStatusCheck,
  failPortalStatusCheck,
  heartbeatPortalStatusCheck,
  classifyPortalStatusFailure,
  planPortalStatusSuccess,
  acquirePortalStatusLaneLease,
  releasePortalStatusChecks,
  type ClaimedPortalStatusCheck,
  getPortalExecutionVerification,
  loadPortalPartnerVerificationStates,
  recordPortalPartnerVerificationReceipt,
  samePortalPartnerVerificationBinding,
  assertPortalWorkerReady,
  enqueuePortalWorkerJob,
  PortalWorkerJobIdempotencyConflictError,
  PortalWorkerUnavailableError,
  buildPortalSubmissionIntent,
  createPortalSubmissionIntentFromSnapshot,
} from "@workspace/portal-runner";
import { resolvePortalCreds } from "../lib/portalCreds.js";
import { reconcilePortalUniversityCrmLinks } from "../lib/portalUniversityLinker.js";
import { enqueuePortalSubmissions } from "../lib/portalManualEnqueue.js";
import { prepareApplicationPortalPreflight } from "../lib/portalApplicationPreflight.js";
import {
  diagnosePortalSubmission,
  isDiagnosablePortalStatus,
} from "../lib/portalAiGuardian.js";
import { queuePortalLifecycleReview } from "../lib/portalLifecycleGuardian.js";
import { enqueueApprovedPortalLifecycleProposal } from "../lib/portalLifecycleExecution.js";
import { normalizePortalLifecycleObservation } from "../lib/portalLifecycleObservation.js";
import {
  mapPortalDispositionToSubmissionStatus,
  requiredPortalArtifactForSignal,
} from "../lib/portalLifecycleContract.js";
import { recordPortalLifecycleObservation } from "../lib/portalLifecycleObservationStore.js";
import { syncVerifiedPortalApplicationNumber } from "../lib/portalApplicationReferenceSync.js";
import {
  hasStoredPortalLifecycleArtifact,
  persistPortalStatusArtifacts,
} from "../lib/portalArtifactIntake.js";
import { resolveCanonicalPortalUniversity } from "../lib/portalUniversityResolver.js";
import {
  MAX_PORTAL_ADAPTER_SPEC_BYTES,
  buildPortalAdapterSpecPolicySnapshot,
  portalAdapterSpecActivationBlockers,
  portalAdapterSpecSha256,
} from "../lib/portalAdapterSpecPolicy.js";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------
const idParamsSchema = z.object({ id: z.coerce.number().int().positive() });
type IdSchemas = { params: typeof idParamsSchema };

// ---------------------------------------------------------------------------
// POST /applications/:appId/portal-submissions — Enqueue
// ---------------------------------------------------------------------------
const enqueueParamsSchema = z.object({ appId: z.coerce.number().int().positive() });
const enqueueBodySchema = z.object({
  universityKey: z.string().min(1),
  mode: z.enum(["dry", "real"]),
  confirm: z.boolean().optional(),
  requestKey: z.string().min(1).max(100).regex(/^[A-Za-z0-9._:-]+$/).optional(),
});
type EnqueueSchemas = { params: typeof enqueueParamsSchema; body: typeof enqueueBodySchema };

router.post(
  "/applications/:appId/portal-submissions",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  validate({ params: enqueueParamsSchema, body: enqueueBodySchema }),
  async (req, res): Promise<void> => {
    const { appId } = getValidated<EnqueueSchemas>(req).params;
    const { universityKey, mode, confirm, requestKey } = getValidated<EnqueueSchemas>(req).body;

    if (mode === "real" && !confirm) {
      res.status(422).json({
        error: "CONFIRM_REQUIRED",
        message: "Set confirm:true to submit in real mode",
      });
      return;
    }

    const user = req.user!;

    const [app] = await db
      .select({
        id: applicationsTable.id,
        studentId: applicationsTable.studentId,
        universityId: applicationsTable.universityId,
      })
      .from(applicationsTable)
      .where(and(eq(applicationsTable.id, appId), isNull(applicationsTable.deletedAt)));

    if (!app) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }

    const docStatus = await checkMandatoryDocsForApplication(app.id);
    if (docStatus && docStatus.missing.length > 0) {
      res.status(422).json({
        error: "MISSING_MANDATORY_DOCUMENTS",
        message: "Mandatory documents must be uploaded before portal automation can run.",
        missingDocTypes: docStatus.missing,
        missingDocLabels: docStatus.missing.map(getDocLabel),
      });
      return;
    }

    const portalResolution = await resolveCanonicalPortalUniversity(universityKey);
    if (!portalResolution.ok) {
      const status = portalResolution.reason === "unknown" ? 404 : 409;
      const error = portalResolution.reason === "inactive"
        ? "PORTAL_UNIVERSITY_INACTIVE"
        : portalResolution.reason === "ambiguous"
          ? "AMBIGUOUS_PORTAL_ADAPTER"
          : "UNKNOWN_PORTAL_UNIVERSITY";
      res.status(status).json({
        error,
        message: portalResolution.reason === "ambiguous"
          ? "The adapter key matches multiple portals; submit the canonical university key."
          : "No unique active portal university matches the requested key.",
        matches: portalResolution.matches,
      });
      return;
    }

    const selectedPortalUni = portalResolution.portalUniversity;
    let finalUniversityKey = selectedPortalUni.universityKey;
    let finalUniversityName = selectedPortalUni.universityName;

    // Stamp the canonical adapter this row will run on (multi-portal routing
    // aware). Raw adapter aliases never become queue identities.
    let routedAdapterKey = selectedPortalUni.adapterKey;
    let routingMeta:
      | {
          exclusiveNationalityRoute: "multico";
          routedFromUniversityKey: string;
        }
      | undefined;
    const studentRouting = await resolveStudentPortalRouting({
      routing: { portalUni: selectedPortalUni, target: null },
      studentId: app.studentId,
      applicationId: app.id,
    });
    if (!studentRouting) {
      res.status(409).json({
        error: "PORTAL_ROUTE_UNAVAILABLE",
        message: "The required exclusive portal route is not available.",
      });
      return;
    }
    finalUniversityKey = studentRouting.portalUni.universityKey;
    finalUniversityName =
      studentRouting.submissionUniversityName ??
      studentRouting.portalUni.universityName;
    routedAdapterKey = studentRouting.portalUni.adapterKey;
    routingMeta = studentRouting.routingMeta;
    const verification = await getPortalExecutionVerification({
      universityKey: finalUniversityKey,
      adapterKey: routedAdapterKey,
    });
    const verificationReady = mode === "dry"
      ? verification?.testLoginPassed === true && verification.binding?.strictDryRunCapable === true
      : verification?.testLoginPassed === true && verification.strictDryRunPassed === true;
    if (!verificationReady) {
      res.status(409).json({
        error: "PARTNER_VERIFICATION_REQUIRED",
        message: mode === "dry"
          ? "Current Test Login evidence and a strict dry-run adapter are required."
          : "Current Test Login and Strict Dry Run evidence are required.",
      });
      return;
    }
    const preflight = await prepareApplicationPortalPreflight({
      applicationId: app.id,
      adapterKey: routedAdapterKey,
      actorUserId: user.id,
      ip: req.ip,
    });
    if (preflight.supported && !preflight.ready) {
      res.status(422).json({
        error: "PORTAL_PREFLIGHT_NOT_READY",
        message: "Application data is incomplete for the selected portal.",
        preflight,
      });
      return;
    }

    const intent = await buildPortalSubmissionIntent({
      applicationId: app.id,
      portalUniversity: studentRouting.portalUni,
      targetCatalogUniversityId: app.universityId,
      source: "manual",
      requestKey,
    });
    const outcome = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(${app.id}, hashtext(${intent.targetIdentitySha256}))`,
      );
      const [active] = await tx
        .select({ id: portalSubmissionsTable.id })
        .from(portalSubmissionsTable)
        .where(and(
          eq(portalSubmissionsTable.applicationId, app.id),
          or(
            eq(portalSubmissionsTable.targetIdentitySha256, intent.targetIdentitySha256),
            and(
              isNull(portalSubmissionsTable.targetIdentitySha256),
              eq(portalSubmissionsTable.universityKey, finalUniversityKey),
            ),
          ),
          eq(portalSubmissionsTable.mode, mode),
          inArray(portalSubmissionsTable.status, ["queued", "running"]),
          isNull(portalSubmissionsTable.deletedAt),
        ))
        .limit(1);
      if (active) return { kind: "active" as const, id: active.id };
      if (mode === "real") {
        const [submitted] = await tx
          .select({ id: portalSubmissionsTable.id })
          .from(portalSubmissionsTable)
          .where(and(
            eq(portalSubmissionsTable.applicationId, app.id),
            or(
              eq(portalSubmissionsTable.targetIdentitySha256, intent.targetIdentitySha256),
              and(
                isNull(portalSubmissionsTable.targetIdentitySha256),
                eq(portalSubmissionsTable.universityKey, finalUniversityKey),
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
      const [inserted] = await tx
        .insert(portalSubmissionsTable)
        .values({
          applicationId: app.id,
          studentId: app.studentId,
          universityKey: finalUniversityKey,
          universityName: finalUniversityName,
          adapterKey: routedAdapterKey,
          mode,
          status: "queued",
          enqueuedBy: user.id,
          submitIntentKey: intent.submitIntentKey,
          targetIdentitySha256: intent.targetIdentitySha256,
          targetIdentity: intent.targetIdentity,
          submissionAction: "submit",
          meta: { manual: true, preflight, ...(routingMeta ?? {}) },
        })
        .returning();
      return { kind: "inserted" as const, row: inserted };
    });
    if (outcome.kind === "active") {
      res.status(409).json({ error: "ALREADY_QUEUED", submissionId: outcome.id });
      return;
    }
    if (outcome.kind === "reconciliation") {
      res.status(409).json({ error: "RECONCILIATION_REQUIRED", submissionId: outcome.id });
      return;
    }
    const row = outcome.row;

    await logAudit(
      user.id,
      "enqueue_portal_submission",
      "portal_submission",
      row.id,
      {
        requestedUniversityKey: universityKey,
        universityKey: finalUniversityKey,
        mode,
      },
      req.ip,
    );

    res.status(201).json(row);
  },
);

// ---------------------------------------------------------------------------
// Manual submit — in-memory per-user rate limiter (short window).
// Prevents an admin from hammering the queue; counts /submit calls per user.
// ---------------------------------------------------------------------------
const MANUAL_SUBMIT_WINDOW_MS = 10_000;
const MANUAL_SUBMIT_MAX = 20;
const _manualSubmitHits = new Map<number, number[]>();

function manualSubmitRateLimited(userId: number): boolean {
  const now = Date.now();
  const recent = (_manualSubmitHits.get(userId) ?? []).filter(
    (t) => now - t < MANUAL_SUBMIT_WINDOW_MS,
  );
  recent.push(now);
  _manualSubmitHits.set(userId, recent);
  return recent.length > MANUAL_SUBMIT_MAX;
}

// ---------------------------------------------------------------------------
// POST /portal-automation/submit — manual enqueue of one or many applications
//
// Body: { applicationIds: number[], mode: "dry"|"real", confirm?: boolean }
// The university/adapter is resolved from each application's OWN record
// (findActivePortalUniversity); universityKey is never hardcoded. Queuing only
// inserts status='queued' rows — it never enables auto-process (drain-once
// still keys off portal_universities.autoProcess=true only).
// ---------------------------------------------------------------------------
const manualSubmitBodySchema = z.object({
  applicationIds: z.array(z.coerce.number().int().positive()).min(1).max(100),
  mode: z.enum(["dry", "real"]),
  confirm: z.boolean().optional(),
});
type ManualSubmitSchemas = { body: typeof manualSubmitBodySchema };

router.post(
  "/portal-automation/submit",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ body: manualSubmitBodySchema }),
  async (req, res): Promise<void> => {
    const user = req.user!;
    const { applicationIds, mode, confirm } = getValidated<ManualSubmitSchemas>(req).body;

    if (manualSubmitRateLimited(user.id)) {
      res.status(429).json({ error: "RATE_LIMITED", message: "Too many submissions, slow down." });
      return;
    }

    if (mode === "real" && !confirm) {
      res.status(422).json({
        error: "CONFIRM_REQUIRED",
        message: "Set confirm:true to submit in real mode",
      });
      return;
    }

    const uniqueIds = [...new Set(applicationIds)];

    const { queued, skipped } = await enqueuePortalSubmissions({
      applicationIds: uniqueIds,
      mode,
      userId: user.id,
    });

    // Single-application strictness: surface the precise failure instead of an
    // empty 200 so the per-application "Portala Gönder" button can react.
    if (uniqueIds.length === 1 && queued.length === 0) {
      const only = skipped[0];
      if (only?.reason === "NOT_FOUND") {
        res.status(404).json({ error: "NOT_FOUND" });
        return;
      }
      if (only?.reason === "NO_PORTAL") {
        res.status(400).json({
          error: "NO_PORTAL",
          message: "No active portal university matches this application",
        });
        return;
      }
      if (only?.reason === "MISSING_MANDATORY_DOCUMENTS") {
        res.status(422).json({
          error: "MISSING_MANDATORY_DOCUMENTS",
          message: "Mandatory documents must be uploaded before portal automation can run.",
          missingDocTypes: only.missingDocTypes ?? [],
          missingDocLabels: only.missingDocLabels ?? [],
        });
        return;
      }
      if (only?.reason === "PREFLIGHT_NOT_READY") {
        res.status(422).json({
          error: "PORTAL_PREFLIGHT_NOT_READY",
          message: "Application data is incomplete for the selected portal.",
          missingFields: only.missingFields ?? [],
          incompatibleFields: only.incompatibleFields ?? [],
          missingDocTypes: only.missingDocTypes ?? [],
          missingDocLabels: only.missingDocLabels ?? [],
          autoFilledFields: only.autoFilledFields ?? [],
        });
        return;
      }
      if (only?.reason === "PARTNER_VERIFICATION_REQUIRED") {
        res.status(409).json({
          error: "PARTNER_VERIFICATION_REQUIRED",
          message: mode === "dry"
            ? "Current Test Login evidence and a strict dry-run adapter are required."
            : "Current Test Login and Strict Dry Run evidence are required.",
        });
        return;
      }
      // ALREADY_QUEUED → fall through to a 200 idempotent response.
    }

    await logAudit(
      user.id,
      "portal.manualSubmit",
      "portal_submission",
      queued[0]?.submissionId ?? 0,
      { ids: uniqueIds, mode, queued: queued.length, skipped: skipped.length },
      req.ip,
    );

    res.status(queued.length > 0 ? 201 : 200).json({ queued, skipped });
  },
);

// ---------------------------------------------------------------------------
// GET /portal-automation/eligible-applications — searchable, paginated list of
// applications that can be manually submitted (deleted_at IS NULL AND map to an
// active portal_universities row). Optional filters: stage, universityKey, q.
// ---------------------------------------------------------------------------
const eligibleQuerySchema = z.object({
  stage:         z.string().min(1).optional(),
  universityKey: z.string().min(1).optional(),
  q:             z.string().trim().min(1).optional(),
});
type EligibleSchemas = { query: typeof eligibleQuerySchema };

router.get(
  "/portal-automation/eligible-applications",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ query: eligibleQuerySchema }),
  async (req, res): Promise<void> => {
    const { stage, universityKey, q } = getValidated<EligibleSchemas>(req).query;
    const pageParams = parsePaginationParams(req, { defaultLimit: 20, maxLimit: "small" });

    // An application is submittable when an active portal_universities row
    // matches its university by crmUniversityId (exact) OR name (case-insensitive)
    // OR when its catalog university is an enabled member of an aggregator
    // account (portal_account_universities → aggregator portal row).
    const membershipMatch = sql`${portalUniversitiesTable.universityKey} IN (
      SELECT ${portalAccountUniversitiesTable.portalKey}
      FROM ${portalAccountUniversitiesTable}
      WHERE ${portalAccountUniversitiesTable.catalogUniversityId} = ${applicationsTable.universityId}
        AND ${portalAccountUniversitiesTable.enabled} = TRUE
    )`;
    const joinCondition = and(
      isNull(portalUniversitiesTable.deletedAt),
      eq(portalUniversitiesTable.isActive, true),
      or(
        eq(portalUniversitiesTable.crmUniversityId, applicationsTable.universityId),
        sql`LOWER(${portalUniversitiesTable.universityName}) = LOWER(${applicationsTable.universityName})`,
        membershipMatch,
      ),
    );

    const filters = and(
      isNull(applicationsTable.deletedAt),
      stage !== undefined ? eq(applicationsTable.stage, stage) : undefined,
      universityKey !== undefined ? eq(portalUniversitiesTable.universityKey, universityKey) : undefined,
      q !== undefined
        ? or(
            ilike(studentsTable.firstName, `%${q}%`),
            ilike(studentsTable.lastName, `%${q}%`),
            ilike(studentsTable.email, `%${q}%`),
            sql`CAST(${applicationsTable.id} AS TEXT) = ${q}`,
          )
        : undefined,
    );

    const [{ total }] = await db
      .select({ total: count(sql`DISTINCT ${applicationsTable.id}`) })
      .from(applicationsTable)
      .innerJoin(studentsTable, eq(applicationsTable.studentId, studentsTable.id))
      .innerJoin(portalUniversitiesTable, joinCondition)
      .where(filters);

    const rows = await db
      .selectDistinctOn([applicationsTable.id], {
        id:                  applicationsTable.id,
        stage:               applicationsTable.stage,
        universityName:      applicationsTable.universityName,
        studentFirstName:    studentsTable.firstName,
        studentLastName:     studentsTable.lastName,
        studentEmail:        studentsTable.email,
        portalUniversityKey: portalUniversitiesTable.universityKey,
        portalUniversityName: portalUniversitiesTable.universityName,
      })
      .from(applicationsTable)
      .innerJoin(studentsTable, eq(applicationsTable.studentId, studentsTable.id))
      .innerJoin(portalUniversitiesTable, joinCondition)
      .where(filters)
      // When an application matches BOTH its standalone row and an aggregator
      // membership, DISTINCT ON keeps the first per id — prefer the aggregator.
      .orderBy(desc(applicationsTable.id), sql`CASE WHEN ${membershipMatch} THEN 0 ELSE 1 END`)
      .limit(pageParams.limit)
      .offset(pageParams.offset);

    res.json({ data: rows, ...buildPageMeta(total, pageParams) });
  },
);

// ---------------------------------------------------------------------------
// GET /portal-submissions — List with filters + pagination + isolation
// ---------------------------------------------------------------------------
const listQuerySchema = z.object({
  applicationId: z.coerce.number().int().positive().optional(),
  status: z
    .enum([
      "queued", "running", "submitted", "already_exists", "program_missing",
      "failed", "canceled", "dry_run", "program_full", "exclusive_region",
    ])
    .optional(),
  mode: z.enum(["dry", "real"]).optional(),
  // Comma-separated portal university keys — multi-select filter.
  universityKeys: z.string().trim().min(1).optional(),
  // Case-insensitive student full-name search (matches applications' student).
  studentName: z.string().trim().min(1).optional(),
  // Inclusive date range on portal_submissions.updated_at (ISO datetimes).
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  sortField: z.enum(["createdAt", "updatedAt", "status", "universityKey"]).optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
});
type ListSchemas = { query: typeof listQuerySchema };

router.get(
  "/portal-submissions",
  requireAuth,
  validate({ query: listQuerySchema }),
  async (req, res): Promise<void> => {
    const user = req.user!;
    const { applicationId, status, mode, universityKeys, studentName, dateFrom, dateTo, sortField, sortDir } =
      getValidated<ListSchemas>(req).query;
    const pageParams = parsePaginationParams(req, { defaultLimit: 20, maxLimit: "small" });

    const sortColumnMap = {
      createdAt: portalSubmissionsTable.createdAt,
      updatedAt: portalSubmissionsTable.updatedAt,
      status: portalSubmissionsTable.status,
      universityKey: portalSubmissionsTable.universityKey,
    } as const;
    const sortColumn = sortColumnMap[sortField ?? "createdAt"];
    const sortDirFn = sortDir === "asc" ? asc : desc;

    const universityKeyList = universityKeys
      ? universityKeys.split(",").map((k) => k.trim()).filter(Boolean)
      : [];

    // Student-name filter as an EXISTS subquery so the count query needs no join.
    // TR-fold both sides (İ/I/ı/i, dotted/dotless) for accent-insensitive match.
    const nameFold = (col: string) =>
      sql`lower(translate(${sql.raw(col)}, 'İIıçÇğĞöÖşŞüÜ', 'iiicCgGoOsSuU'))`;
    const studentNameCond = studentName
      ? sql`exists (
          select 1 from ${applicationsTable} a
          join ${studentsTable} s on s.id = a.student_id
          where a.id = ${portalSubmissionsTable.applicationId}
            and ${nameFold("concat_ws(' ', s.first_name, s.last_name)")}
                like ${"%" + studentName.toLocaleLowerCase("tr-TR")
                  .replace(/İ/g, "i").replace(/I/g, "i").replace(/ı/g, "i")
                  .replace(/ç/g, "c").replace(/Ç/g, "c")
                  .replace(/ğ/g, "g").replace(/Ğ/g, "g")
                  .replace(/ö/g, "o").replace(/Ö/g, "o")
                  .replace(/ş/g, "s").replace(/Ş/g, "s")
                  .replace(/ü/g, "u").replace(/Ü/g, "u") + "%"}
        )`
      : undefined;

    // Agent isolation: restrict to applications visible to this user
    let visibleAppIds: number[] | null = null;
    if (isAgentRole(user.role)) {
      const visibleAgentIds = await getAgentVisibleIds(user.id, user.role);
      if (visibleAgentIds.length > 0) {
        const apps = await db
          .select({ id: applicationsTable.id })
          .from(applicationsTable)
          .where(
            and(
              isNull(applicationsTable.deletedAt),
              inArray(applicationsTable.agentId, visibleAgentIds),
            ),
          );
        visibleAppIds = apps.map((a) => a.id);
        if (visibleAppIds.length === 0) {
          res.json({ data: [], ...buildPageMeta(0, pageParams) });
          return;
        }
      }
    }

    const where = and(
      isNull(portalSubmissionsTable.deletedAt),
      applicationId !== undefined ? eq(portalSubmissionsTable.applicationId, applicationId) : undefined,
      status !== undefined ? eq(portalSubmissionsTable.status, status) : undefined,
      mode !== undefined ? eq(portalSubmissionsTable.mode, mode) : undefined,
      universityKeyList.length > 0 ? inArray(portalSubmissionsTable.universityKey, universityKeyList) : undefined,
      dateFrom !== undefined ? gte(portalSubmissionsTable.updatedAt, dateFrom) : undefined,
      dateTo !== undefined ? lte(portalSubmissionsTable.updatedAt, dateTo) : undefined,
      studentNameCond,
      visibleAppIds !== null ? inArray(portalSubmissionsTable.applicationId, visibleAppIds) : undefined,
    );

    const [{ total }] = await db
      .select({ total: count() })
      .from(portalSubmissionsTable)
      .where(where);

    const rows = await db
      .select({
        ...getTableColumns(portalSubmissionsTable),
        supersededByApplicationId: applicationsTable.supersededByApplicationId,
        supersededFromApplicationId: applicationsTable.supersededFromApplicationId,
        mainApplicationId: applicationsTable.mainApplicationId,
        // Student full name + the program the automation actually targeted
        // (application is already the superseded/fallback one when applicable).
        studentName: sql<string | null>`nullif(trim(concat_ws(' ', ${studentsTable.firstName}, ${studentsTable.lastName})), '')`,
        programName: applicationsTable.programName,
        programLanguage: applicationsTable.instructionLanguage,
        programLevel: applicationsTable.level,
        // Program name on the ORIGINAL (parent) application when this row is a
        // fallback child — correlated subquery avoids the drizzle alias import.
        // Null for direct (non-superseded) submissions.
        appliedProgramName: sql<string | null>`(
          SELECT a2.program_name
          FROM applications a2
          WHERE a2.id = ${applicationsTable.supersededFromApplicationId}
        )`,
      })
      .from(portalSubmissionsTable)
      .leftJoin(
        applicationsTable,
        eq(applicationsTable.id, portalSubmissionsTable.applicationId),
      )
      .leftJoin(
        studentsTable,
        eq(studentsTable.id, portalSubmissionsTable.studentId),
      )
      .where(where)
      .orderBy(sortDirFn(sortColumn), desc(portalSubmissionsTable.id))
      .limit(pageParams.limit)
      .offset(pageParams.offset);

    // Every attempt carries a chain step label so the board can surface it:
    //   - Fallback children (superseded from another app) keep their PERSISTED
    //     meta.fallbackStep (X2/X3/Y2/Y3 for the automatic chain; null for the
    //     admin-rule path, which is intentionally unlabeled).
    //   - Step-1 original attempts (no supersession parent) are derived: X1 when
    //     the application is the applied/main app itself (same-university), Y1
    //     when it is a fan-out copy pointing at a different-university root.
    const data = rows.map((r) => {
      const persisted =
        (r.meta as { fallbackStep?: string | null } | null)?.fallbackStep ?? null;
      const isChild = r.supersededFromApplicationId != null;
      const fallbackStep = isChild
        ? persisted
        : persisted ??
          (r.mainApplicationId == null || r.mainApplicationId === r.applicationId
            ? "X1"
            : "Y1");
      return { ...r, fallbackStep };
    });

    res.json({ data, ...buildPageMeta(total, pageParams) });
  },
);

// ---------------------------------------------------------------------------
// GET /portal-submissions/universities — distinct universities that appear in
// this user's submissions, for the multi-select filter. MUST be registered
// before /portal-submissions/:id (static segment beats the :id param route).
// ---------------------------------------------------------------------------
router.get(
  "/portal-submissions/universities",
  requireAuth,
  async (req, res): Promise<void> => {
    const user = req.user!;

    let visibleAppIds: number[] | null = null;
    if (isAgentRole(user.role)) {
      const visibleAgentIds = await getAgentVisibleIds(user.id, user.role);
      if (visibleAgentIds.length > 0) {
        const apps = await db
          .select({ id: applicationsTable.id })
          .from(applicationsTable)
          .where(
            and(
              isNull(applicationsTable.deletedAt),
              inArray(applicationsTable.agentId, visibleAgentIds),
            ),
          );
        visibleAppIds = apps.map((a) => a.id);
        if (visibleAppIds.length === 0) {
          res.json({ data: [] });
          return;
        }
      }
    }

    // Job G: source filter options from the canonical portal_universities
    // table so every school appears exactly ONCE with its clean name. The
    // INNER JOIN drops submissions whose universityKey has no canonical row
    // (raw/unmapped keys), and the label is ALWAYS the canonical
    // university_name — never a raw key or a submission's stored spelling.
    // Dedup is by universityKey.
    const rows = await db
      .selectDistinctOn([portalSubmissionsTable.universityKey], {
        key: portalSubmissionsTable.universityKey,
        label: portalUniversitiesTable.universityName,
      })
      .from(portalSubmissionsTable)
      .innerJoin(
        portalUniversitiesTable,
        eq(portalUniversitiesTable.universityKey, portalSubmissionsTable.universityKey),
      )
      .where(
        and(
          isNull(portalSubmissionsTable.deletedAt),
          visibleAppIds !== null ? inArray(portalSubmissionsTable.applicationId, visibleAppIds) : undefined,
        ),
      )
      .orderBy(portalSubmissionsTable.universityKey, asc(portalUniversitiesTable.universityName));

    res.json({ data: rows });
  },
);

// ---------------------------------------------------------------------------
// GET /portal-submissions/:id
// ---------------------------------------------------------------------------
router.get(
  "/portal-submissions/:id",
  requireAuth,
  validate({ params: idParamsSchema }),
  async (req, res): Promise<void> => {
    const user = req.user!;
    const { id } = getValidated<IdSchemas>(req).params;

    const [row] = await db
      .select()
      .from(portalSubmissionsTable)
      .where(and(eq(portalSubmissionsTable.id, id), isNull(portalSubmissionsTable.deletedAt)));

    if (!row) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }

    // Isolation check for agent roles
    if (isAgentRole(user.role)) {
      const visibleAgentIds = await getAgentVisibleIds(user.id, user.role);
      if (visibleAgentIds.length > 0) {
        const [app] = await db
          .select({ agentId: applicationsTable.agentId })
          .from(applicationsTable)
          .where(eq(applicationsTable.id, row.applicationId));
        if (!app || app.agentId == null || !visibleAgentIds.includes(app.agentId)) {
          res.status(404).json({ error: "NOT_FOUND" });
          return;
        }
      }
    }

    res.json(row);
  },
);

// ---------------------------------------------------------------------------
// POST /portal-submissions/:id/ai-diagnose
// Admin-only, review-only diagnosis. This can spend AI budget, but it never
// retries a submission or mutates an external university portal.
// ---------------------------------------------------------------------------
router.post(
  "/portal-submissions/:id/ai-diagnose",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ params: idParamsSchema }),
  async (req, res): Promise<void> => {
    const { id } = getValidated<IdSchemas>(req).params;
    const [row] = await db
      .select({
        id: portalSubmissionsTable.id,
        status: portalSubmissionsTable.status,
        providerCommittedAt: portalSubmissionsTable.providerCommittedAt,
      })
      .from(portalSubmissionsTable)
      .where(
        and(
          eq(portalSubmissionsTable.id, id),
          isNull(portalSubmissionsTable.deletedAt),
        ),
      );
    if (!row) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }
    if (!isDiagnosablePortalStatus(row.status)) {
      res.status(409).json({
        error: "NOT_DIAGNOSABLE",
        message: "Only failed, program-missing, or program-full outcomes can be diagnosed",
      });
      return;
    }
    try {
      const guardian = await diagnosePortalSubmission(id, {
        triggeredBy: "manual",
        triggerActor: req.user!.id,
      });
      await logAudit(
        req.user!.id,
        "diagnose_portal_submission",
        "portal_submission",
        id,
        {
          runId: guardian.runId ?? null,
          actionId: guardian.actionId ?? null,
          reused: guardian.reused,
          executionMode: "review_only",
        },
        req.ip,
      );
      res.json({ guardian });
    } catch (error) {
      const code = (error as Error).message;
      if (code === "PORTAL_AI_GUARDIAN_INACTIVE") {
        res.status(409).json({
          error: code,
          message: "Activate the Portal Automation Guardian persona first",
        });
        return;
      }
      if (code === "PORTAL_AI_GUARDIAN_IN_PROGRESS") {
        res.status(409).json({ error: code, message: "Diagnosis is already in progress" });
        return;
      }
      if (code === "PORTAL_AI_GUARDIAN_DAILY_LIMIT") {
        res.status(429).json({
          error: code,
          message: "Portal AI Guardian daily run limit has been reached",
        });
        return;
      }
      console.error(
        `[portal-ai-guardian] manual diagnosis ${id} failed (${(error as Error).name || "Error"})`,
      );
      res.status(500).json({ error: "PORTAL_AI_DIAGNOSIS_FAILED" });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /portal-submissions/:id/retry
// ---------------------------------------------------------------------------
router.post(
  "/portal-submissions/:id/retry",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  validate({ params: idParamsSchema }),
  async (req, res): Promise<void> => {
    const user = req.user!;
    const { id } = getValidated<IdSchemas>(req).params;

    const [row] = await db
      .select({
        id: portalSubmissionsTable.id,
        status: portalSubmissionsTable.status,
        providerCommittedAt: portalSubmissionsTable.providerCommittedAt,
      })
      .from(portalSubmissionsTable)
      .where(and(eq(portalSubmissionsTable.id, id), isNull(portalSubmissionsTable.deletedAt)));

    if (!row) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }

    if (row.status !== "failed" && row.status !== "canceled") {
      res.status(409).json({
        error: "NOT_RETRYABLE",
        message: "Only failed or canceled submissions can be retried",
      });
      return;
    }

    if (row.providerCommittedAt !== null) {
      res.status(409).json({
        error: "RECONCILIATION_REQUIRED",
        message: "This target was already committed at the provider and cannot be retried as a new submit action",
      });
      return;
    }

    const [retryTarget] = await db
      .select({
        applicationId: portalSubmissionsTable.applicationId,
        adapterKey: portalSubmissionsTable.adapterKey,
      })
      .from(portalSubmissionsTable)
      .where(eq(portalSubmissionsTable.id, id))
      .limit(1);
    const docStatus = retryTarget
      ? await checkMandatoryDocsForApplication(retryTarget.applicationId)
      : null;
    if (docStatus && docStatus.missing.length > 0) {
      res.status(422).json({
        error: "MISSING_MANDATORY_DOCUMENTS",
        message: "Mandatory documents must be uploaded before retrying portal automation.",
        missingDocTypes: docStatus.missing,
        missingDocLabels: docStatus.missing.map(getDocLabel),
      });
      return;
    }
    if (retryTarget) {
      const preflight = await prepareApplicationPortalPreflight({
        applicationId: retryTarget.applicationId,
        adapterKey: retryTarget.adapterKey ?? "",
        actorUserId: user.id,
        ip: req.ip,
      });
      if (preflight.supported && !preflight.ready) {
        res.status(422).json({
          error: "PORTAL_PREFLIGHT_NOT_READY",
          message: "Application data is incomplete for this portal.",
          preflight,
        });
        return;
      }
    }

    await db
      .update(portalSubmissionsTable)
      .set({
        status: "queued",
        lockedAt: null,
        lockedBy: null,
        error: null,
        attempts: 0,
        meta: sql`coalesce(${portalSubmissionsTable.meta}, '{}'::jsonb) || '{"manual":true}'::jsonb`,
        resultJson: sql`coalesce(${portalSubmissionsTable.resultJson}, '{}'::jsonb) - 'aiGuardian'`,
      })
      .where(eq(portalSubmissionsTable.id, id));

    await logAudit(user.id, "retry_portal_submission", "portal_submission", id, {}, req.ip);

    res.json({ ok: true });
  },
);

// ---------------------------------------------------------------------------
// POST /portal-submissions/:id/cancel
// ---------------------------------------------------------------------------
router.post(
  "/portal-submissions/:id/cancel",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  validate({ params: idParamsSchema }),
  async (req, res): Promise<void> => {
    const user = req.user!;
    const { id } = getValidated<IdSchemas>(req).params;

    const [row] = await db
      .select({ id: portalSubmissionsTable.id, status: portalSubmissionsTable.status })
      .from(portalSubmissionsTable)
      .where(and(eq(portalSubmissionsTable.id, id), isNull(portalSubmissionsTable.deletedAt)));

    if (!row) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }

    if (row.status !== "queued") {
      res.status(409).json({
        error: row.status === "running"
          ? "RUNNING_SUBMISSION_WORKER_OWNED"
          : "NOT_CANCELABLE",
        message: row.status === "running"
          ? "A running browser action is owned by the worker and cannot be canceled without cooperative worker acknowledgement"
          : "Only queued submissions can be canceled",
      });
      return;
    }

    const canceled = await db
      .update(portalSubmissionsTable)
      .set({ status: "canceled", updatedAt: new Date() })
      .where(and(
        eq(portalSubmissionsTable.id, id),
        eq(portalSubmissionsTable.status, "queued"),
      ))
      .returning({ id: portalSubmissionsTable.id });

    if (canceled.length === 0) {
      res.status(409).json({
        error: "SUBMISSION_CLAIMED_CONCURRENTLY",
        message: "The worker claimed this submission before cancellation completed",
      });
      return;
    }

    await logAudit(user.id, "cancel_portal_submission", "portal_submission", id, {}, req.ip);

    res.json({ ok: true });
  },
);

// ---------------------------------------------------------------------------
// POST /portal-submissions/process-queued
// Processes ALL queued submissions sequentially; eşzaman 1.
// Runs releaseStale first, then drains with per-submission timeout + heartbeat.
// ---------------------------------------------------------------------------
router.post(
  "/portal-submissions/process-queued",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const user = req.user!;
    try {
      const queuedByMode = await db
        .select({ mode: portalSubmissionsTable.mode, total: count() })
        .from(portalSubmissionsTable)
        .where(and(
          eq(portalSubmissionsTable.status, "queued"),
          isNull(portalSubmissionsTable.deletedAt),
        ))
        .groupBy(portalSubmissionsTable.mode);
      for (const row of queuedByMode) await assertPortalWorkerReady(row.mode);
      const queued = queuedByMode.reduce((sum, row) => sum + row.total, 0);

      await logAudit(
        user.id,
        "request_portal_queue_drain",
        "portal_submission",
        undefined,
        { queued, modes: queuedByMode.map((row) => row.mode) },
        req.ip,
      );

      res.status(202).json({
        accepted: true,
        queued,
        statusUrl: "/api/portal-submissions?status=queued",
      });
    } catch (error) {
      if (error instanceof PortalWorkerUnavailableError) {
        res.status(503).json({ accepted: false, error: error.code });
        return;
      }
      throw error;
    }
  },
);

// ---------------------------------------------------------------------------
// POST /portal-automation/run-now
// Admin-only "Run Now": scans every trigger-stage application, enqueues the
// eligible ones (respecting all Automation Rules + dedup), then immediately
// drains the queue in-process — no 10-minute interval wait.
// ---------------------------------------------------------------------------
router.post(
  "/portal-automation/run-now",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const user = req.user!;

    // ----- Gate: global kill-switch -------------------------------------
    const [settings] = await db
      .select()
      .from(portalAutomationSettingsTable)
      .limit(1);

    if (!settings?.isEnabled) {
      res.status(409).json({
        error: "AUTOMATION_DISABLED",
        message: "Portal automation is disabled — enable it before running.",
      });
      return;
    }

    const runtimeSettings = await withEligiblePortalTriggerStages(settings);
    try {
      await assertPortalWorkerReady(runtimeSettings.mode);
    } catch (error) {
      if (error instanceof PortalWorkerUnavailableError) {
        res.status(503).json({ accepted: false, error: error.code });
        return;
      }
      throw error;
    }

    // ----- Enqueue every eligible trigger-stage application -------------
    const summary = await scanAndEnqueueTriggerStageApplications(user.id, runtimeSettings);

    await logAudit(
      user.id,
      "portal.runNow",
      "portal_submission",
      undefined,
      {
        scanned: summary.scanned,
        queued: summary.queued,
        skipped: summary.skipped,
        reasons: summary.reasons,
        acceptedByWorker: true,
      },
      req.ip,
    );

    res.status(202).json({
      accepted: true,
      scanned: summary.scanned,
      queued: summary.queued,
      skipped: summary.skipped,
      reasons: summary.reasons,
      queuedIds: summary.queuedIds,
      statusUrl: "/api/portal-submissions?status=queued",
    });
  },
);

// ---------------------------------------------------------------------------
// POST /portal-submissions/:id/process
// Processes a SINGLE submission by id; eşzaman 1.
// ---------------------------------------------------------------------------
router.post(
  "/portal-submissions/:id/process",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  validate({ params: idParamsSchema }),
  async (req, res): Promise<void> => {
    const user = req.user!;
    const { id } = getValidated<IdSchemas>(req).params;

    // Verify the submission exists and is queued before acquiring mutex
    const [row] = await db
      .select({ id: portalSubmissionsTable.id, status: portalSubmissionsTable.status, mode: portalSubmissionsTable.mode })
      .from(portalSubmissionsTable)
      .where(and(eq(portalSubmissionsTable.id, id), isNull(portalSubmissionsTable.deletedAt)));

    if (!row) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }

    if (row.status !== "queued") {
      res.status(409).json({
        error: "NOT_QUEUED",
        message: `Submission #${id} is ${row.status}, not queued`,
      });
      return;
    }

    try {
      await assertPortalWorkerReady(row.mode);

      await logAudit(
        user.id,
        "request_portal_submission_processing",
        "portal_submission",
        id,
        { status: row.status, mode: row.mode },
        req.ip,
      );
      res.status(202).json({
        accepted: true,
        submissionId: id,
        statusUrl: `/api/portal-submissions/${id}`,
      });
    } catch (error) {
      if (error instanceof PortalWorkerUnavailableError) {
        res.status(503).json({ accepted: false, error: error.code });
        return;
      }
      throw error;
    }
  },
);

// ---------------------------------------------------------------------------
// POST /portal-submissions/reset-stuck
// Running browser actions are worker-owned. Resetting their DB row from the
// API can overlap a still-active portal mutation, so this legacy endpoint is
// retained as an explicit fail-closed contract. The worker performs bounded
// stale-lease recovery after its own heartbeat checks.
// ---------------------------------------------------------------------------
const resetStuckBodySchema = z.object({
  thresholdMinutes: z.number().int().positive().min(1).max(60).default(10),
});
type ResetStuckSchemas = { body: typeof resetStuckBodySchema };

router.post(
  "/portal-submissions/reset-stuck",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  validate({ body: resetStuckBodySchema }),
  async (req, res): Promise<void> => {
    const { thresholdMinutes } = getValidated<ResetStuckSchemas>(req).body;
    res.status(409).json({
      error: "WORKER_OWNED_RECOVERY",
      message: "Stale running submissions are recovered only by the release-matched portal worker",
      thresholdMinutes,
    });
  },
);

// ---------------------------------------------------------------------------
// POST /portal-submissions/bulk-retry — mirrors :id/retry for many rows in
// one UPDATE. Only rows whose current status is retryable are touched;
// everything else is reported back as skipped (no partial-row errors).
// ---------------------------------------------------------------------------
const bulkIdsBodySchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(200),
});
type BulkIdsSchemas = { body: typeof bulkIdsBodySchema };

router.post(
  "/portal-submissions/bulk-retry",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  validate({ body: bulkIdsBodySchema }),
  async (req, res): Promise<void> => {
    const user = req.user!;
    const { ids } = getValidated<BulkIdsSchemas>(req).body;

    const eligible = await db
      .select({
        id: portalSubmissionsTable.id,
        applicationId: portalSubmissionsTable.applicationId,
        adapterKey: portalSubmissionsTable.adapterKey,
      })
      .from(portalSubmissionsTable)
      .where(and(
        inArray(portalSubmissionsTable.id, ids),
        isNull(portalSubmissionsTable.deletedAt),
        or(
          eq(portalSubmissionsTable.status, "failed"),
          eq(portalSubmissionsTable.status, "canceled"),
          eq(portalSubmissionsTable.status, "dry_run"),
        ),
      ));
    const docChecks = await Promise.all(
      eligible.map(async (row) => ({
        row,
        status: await checkMandatoryDocsForApplication(row.applicationId),
      })),
    );
    const docReady = docChecks
      .filter(({ status }) => status !== null && status.missing.length === 0)
      .map(({ row }) => row);
    const missingMandatory = docChecks
      .filter(({ status }) => status !== null && status.missing.length > 0)
      .map(({ row, status }) => ({
        id: row.id,
        missingDocTypes: status!.missing,
        missingDocLabels: status!.missing.map(getDocLabel),
      }));
    const preflightReady: number[] = [];
    const preflightBlocked: Array<{
      id: number;
      missingFields: string[];
      incompatibleFields: Array<{ field: string; reason: string }>;
      missingDocuments: string[];
      autoFilledFields: string[];
    }> = [];
    // Deliberately sequential: a bulk retry may contain hundreds of rows and
    // preflight can invoke document extraction. Avoid an uncontrolled burst of
    // AI calls and object-storage downloads.
    for (const row of docReady) {
      const preflight = await prepareApplicationPortalPreflight({
        applicationId: row.applicationId,
        adapterKey: row.adapterKey ?? "",
        actorUserId: user.id,
        ip: req.ip,
      });
      if (preflight.supported && !preflight.ready) {
        preflightBlocked.push({
          id: row.id,
          missingFields: preflight.missingFields,
          incompatibleFields: preflight.incompatibleFields,
          missingDocuments: preflight.missingDocuments,
          autoFilledFields: preflight.autoFilledFields,
        });
      } else {
        preflightReady.push(row.id);
      }
    }
    const eligibleIds = preflightReady;

    if (eligibleIds.length > 0) {
      await db
        .update(portalSubmissionsTable)
        .set({
          status: "queued",
          lockedAt: null,
          lockedBy: null,
          error: null,
          attempts: 0,
          meta: sql`coalesce(${portalSubmissionsTable.meta}, '{}'::jsonb) || '{"manual":true}'::jsonb`,
          resultJson: sql`coalesce(${portalSubmissionsTable.resultJson}, '{}'::jsonb) - 'aiGuardian'`,
        })
        .where(inArray(portalSubmissionsTable.id, eligibleIds));
    }

    await logAudit(
      user.id,
      "bulk_retry_portal_submissions",
      "portal_submission",
      undefined,
      { requested: ids, retried: eligibleIds },
      req.ip,
    );

    res.json({
      retried: eligibleIds.length,
      ids: eligibleIds,
      skipped: ids.filter((id) => !eligibleIds.includes(id)),
      missingMandatory,
      preflightBlocked,
    });
  },
);

// ---------------------------------------------------------------------------
// POST /portal-submissions/bulk-cancel — mirrors :id/cancel for many rows.
// ---------------------------------------------------------------------------
router.post(
  "/portal-submissions/bulk-cancel",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  validate({ body: bulkIdsBodySchema }),
  async (req, res): Promise<void> => {
    const user = req.user!;
    const { ids } = getValidated<BulkIdsSchemas>(req).body;

    const eligible = await db
      .select({ id: portalSubmissionsTable.id })
      .from(portalSubmissionsTable)
      .where(and(
        inArray(portalSubmissionsTable.id, ids),
        isNull(portalSubmissionsTable.deletedAt),
        eq(portalSubmissionsTable.status, "queued"),
      ));
    const eligibleIds = eligible.map((r) => r.id);

    if (eligibleIds.length > 0) {
      await db
        .update(portalSubmissionsTable)
        .set({ status: "canceled", updatedAt: new Date() })
        .where(and(
          inArray(portalSubmissionsTable.id, eligibleIds),
          eq(portalSubmissionsTable.status, "queued"),
        ));
    }

    await logAudit(
      user.id,
      "bulk_cancel_portal_submissions",
      "portal_submission",
      undefined,
      { requested: ids, canceled: eligibleIds },
      req.ip,
    );

    res.json({
      canceled: eligibleIds.length,
      ids: eligibleIds,
      skipped: ids.filter((id) => !eligibleIds.includes(id)),
    });
  },
);

// ---------------------------------------------------------------------------
// POST /portal-submissions/bulk-process — processes only the given (queued)
// ids sequentially, reusing the same eşzaman-1 pipeline as process-queued /
// the single :id/process route. Guarded by the same module-level mutex.
// ---------------------------------------------------------------------------
router.post(
  "/portal-submissions/bulk-process",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  validate({ body: bulkIdsBodySchema }),
  async (req, res): Promise<void> => {
    const user = req.user!;
    const { ids } = getValidated<BulkIdsSchemas>(req).body;
    try {
      const queued = await db
        .select({ id: portalSubmissionsTable.id, mode: portalSubmissionsTable.mode })
        .from(portalSubmissionsTable)
        .where(and(
          inArray(portalSubmissionsTable.id, ids),
          eq(portalSubmissionsTable.status, "queued"),
          isNull(portalSubmissionsTable.deletedAt),
        ));
      for (const mode of [...new Set(queued.map((row) => row.mode))]) {
        await assertPortalWorkerReady(mode);
      }

      await logAudit(
        user.id,
        "request_bulk_portal_submission_processing",
        "portal_submission",
        undefined,
        { requested: ids, accepted: queued.map((row) => row.id) },
        req.ip,
      );

      res.status(202).json({
        accepted: queued.length,
        ids: queued.map((row) => row.id),
        skipped: ids.filter((id) => !queued.some((row) => row.id === id)),
        statusUrl: "/api/portal-submissions?status=queued",
      });
    } catch (error) {
      if (error instanceof PortalWorkerUnavailableError) {
        res.status(503).json({ accepted: false, error: error.code });
        return;
      }
      throw error;
    }
  },
);

// ---------------------------------------------------------------------------
// POST /portal-automation/apply-to-all — fan-out ONE application to ALL active
// portal universities that have an adapter + credentials configured.
//
// Body: { applicationId, mode: "dry"|"real", confirm?: boolean }
//
// Per candidate university:
//   - exclusion (nationality/region)                → outcome "excluded" (skip)
//   - program match at the SAME level (exact-first via matchProgram, then fuzzy;
//     no same-level programme / no confident match) → outcome "no-program"
//   - dedup/reuse the student's existing application at that university, else
//     create one from the matched CATALOG programme (fees/level/language copied
//     from the catalog, never from the source app)
//   - dedup an active (queued/running) submission    → outcome "duplicate"
//   - otherwise enqueue a queued submission          → outcome "queued"
//
// After enqueueing, a background drain is triggered (NON-BLOCKING) so queued
// rows process immediately per the chosen mode — the HTTP response returns the
// per-university result list right away instead of blocking for minutes. REUSES
// the existing queue / matcher / exclusion core (no parallel engine).
// ---------------------------------------------------------------------------
const applyToAllBodySchema = z.object({
  applicationId: z.coerce.number().int().positive(),
  mode: z.enum(["dry", "real"]),
  confirm: z.boolean().optional(),
});
type ApplyToAllSchemas = { body: typeof applyToAllBodySchema };

type ApplyToAllOutcome =
  | "queued"
  | "excluded"
  | "no-program"
  | "missing-docs"
  | "duplicate"
  | "reconciliation-required"
  | "failed";

interface ApplyToAllItem {
  universityKey: string;
  universityName: string;
  outcome: ApplyToAllOutcome;
  message?: string;
  applicationId?: number;
  submissionId?: number;
  programName?: string;
  confidence?: number;
}

// ---------------------------------------------------------------------------
// Shared apply-to-all fan-out core (reused by the single endpoint AND the bulk
// endpoint — no parallel engine / no copy-paste).
// ---------------------------------------------------------------------------

interface CredentialReadyUniversity {
  id: number;
  universityKey: string;
  universityName: string;
  adapterKey: string;
  crmUniversityId: number;
  verificationGeneration: number;
}

/**
 * Metadata for a user-initiated fan-out row.
 *
 * The queue worker deliberately requires `manual=true` before bypassing the
 * per-university auto-process and trigger-stage gates. Keep that marker on both
 * direct portal rows and aggregator-routed rows; `enqueuedBy` alone cannot be
 * used because automatic stage triggers also retain the acting user id.
 */
export function buildManualFanOutMeta(
  routeVia?: { universityKey: string; adapterKey: string },
  target?: { crmUniversityId: number; universityName: string },
): Record<string, unknown> {
  return {
    manual: true,
    ...(routeVia && target
      ? {
          targetCatalogUniversityId: target.crmUniversityId,
          targetUniversityName: target.universityName,
          routedViaAggregator: routeVia.universityKey,
        }
      : {}),
  };
}

/**
 * Loads the fan-out target universities: active, not deleted, mapped to a CRM
 * university (crm_university_id set so catalog programmes are resolvable) AND
 * current-verification-ready. Environment credentials alone cannot unlock a
 * target. Shared by the single + bulk endpoints so both target the exact same
 * set (and universitiesTargeted counts match).
 */
async function loadCredentialReadyPortalUniversities(
  mode: "dry" | "real",
): Promise<CredentialReadyUniversity[]> {
  const unis = await db
    .select({
      id: portalUniversitiesTable.id,
      universityKey: portalUniversitiesTable.universityKey,
      universityName: portalUniversitiesTable.universityName,
      adapterKey: portalUniversitiesTable.adapterKey,
      crmUniversityId: portalUniversitiesTable.crmUniversityId,
      verificationGeneration: portalUniversitiesTable.verificationGeneration,
    })
    .from(portalUniversitiesTable)
    .where(
      and(
        eq(portalUniversitiesTable.isActive, true),
        isNull(portalUniversitiesTable.deletedAt),
        isNotNull(portalUniversitiesTable.crmUniversityId),
      ),
    );
  const verificationStates = await loadPortalPartnerVerificationStates(unis);

  return unis
    .filter((uni) => {
      const verification = verificationStates.get(uni.id);
      return mode === "dry"
        ? verification?.testLoginPassed === true && verification.binding?.strictDryRunCapable === true
        : verification?.testLoginPassed === true && verification.strictDryRunPassed === true;
    })
    .map((uni) => ({
      id:              uni.id,
      universityKey:   uni.universityKey,
      universityName:  uni.universityName,
      adapterKey:      uni.adapterKey,
      crmUniversityId: uni.crmUniversityId as number,
      verificationGeneration: uni.verificationGeneration,
    }));
}

/**
 * Fan-out ONE application to the given credential-ready universities. Per
 * candidate university: exclusion → "excluded"; same-level program match
 * (exact-first via matchProgram, then fuzzy) → "no-program"; else advisory-
 * locked reuse/create application + dedup/enqueue submission → "duplicate" /
 * "queued". Does NOT trigger the drain, audit, or rate-limit — callers own those
 * so the bulk loop drains/audits once. REUSES the existing queue / matcher /
 * exclusion core.
 */
async function fanOutApplicationToUniversities(
  srcApp: typeof applicationsTable.$inferSelect,
  unis: CredentialReadyUniversity[],
  mode: "dry" | "real",
  userId: number,
  /**
   * Aggregator routing (SIT/United). When set, every submission is enqueued on
   * the aggregator's universityKey (its adapter + credentials) while the
   * candidate's own name/CRM id name the MEMBER school to select inside the
   * portal — written to submission.meta exactly as enqueueIfEligible does. The
   * application row (and its dedup) still keys on the member CRM university.
   * Omitted → identical legacy behavior (apply-to-all / bulk are unchanged).
   */
  routeVia?: {
    id: number;
    universityKey: string;
    adapterKey: string;
    verificationGeneration: number;
  },
): Promise<ApplyToAllItem[]> {
  const [student] = await db
    .select({ nationality: studentsTable.nationality })
    .from(studentsTable)
    .where(eq(studentsTable.id, srcApp.studentId))
    .limit(1);
  const nationality = student?.nationality ?? null;

  const sourceProgramName = srcApp.programName ?? "";
  const sourceLevel = levelGroup(srcApp.level);

  const results: ApplyToAllItem[] = [];
  const preflightByAdapter = new Map<
    string,
    Promise<Awaited<ReturnType<typeof prepareApplicationPortalPreflight>>>
  >();

  for (const uni of unis) {
    const crmUniversityId = uni.crmUniversityId;
    // When routing via an aggregator, the submission is keyed on the aggregator
    // key (so dedup/adapter/credentials all resolve to it); otherwise the
    // candidate's own key. Each member still gets its own application row, so
    // (applicationId, submissionKey) stays unique per member.
    const submissionKey = routeVia?.universityKey ?? uni.universityKey;
    // Dedup scope: the legacy manual path treats only in-flight rows
    // (queued/running) as duplicates so a completed run can be retried from the
    // button. The aggregator-routed AUTO path additionally treats a prior
    // "submitted" row as a duplicate, so re-triggering on later stage changes is
    // idempotent (gap-filling only) and never double-submits a member. Failed
    // rows stay retryable in both paths.
    const submissionDedupStatuses: ("queued" | "running" | "submitted")[] =
      routeVia ? ["queued", "running", "submitted"] : ["queued", "running"];
    try {
      const adapterKey = routeVia?.adapterKey ?? uni.adapterKey;
      let preflightPromise = preflightByAdapter.get(adapterKey);
      if (!preflightPromise) {
        // The target programme is guaranteed to be the same level and is
        // resolved below. Readiness fields/documents belong to the same student,
        // so the source application is a safe, mutation-free preflight input.
        // Cache per adapter to avoid repeating AI extraction for every member.
        preflightPromise = prepareApplicationPortalPreflight({
          applicationId: srcApp.id,
          adapterKey,
          actorUserId: userId,
        });
        preflightByAdapter.set(adapterKey, preflightPromise);
      }
      const preflight = await preflightPromise;
      if (preflight.supported && !preflight.ready) {
        results.push({
          universityKey: uni.universityKey,
          universityName: uni.universityName,
          outcome:
            preflight.missingDocuments.length > 0
              ? "missing-docs"
              : "failed",
          message:
            `PORTAL_PREFLIGHT_NOT_READY` +
            ` fields=${preflight.missingFields.join(",") || "-"}` +
            ` documents=${preflight.missingDocuments.join(",") || "-"}`,
        });
        continue;
      }

      // --- Exclusion (nationality / exclusive region) ---
      // Check the SAME key the runner will use at submit time (the submission
      // key), so the preventive pre-filter and the reactive runner agree.
      const excl = await resolveNationalityExclusion(submissionKey, nationality);
      if (excl.excluded) {
        results.push({
          universityKey:  uni.universityKey,
          universityName: uni.universityName,
          outcome:        "excluded",
          message:        excl.agencyName ?? undefined,
        });
        continue;
      }

      // --- Program match at the SAME level ---
      const programs = await db
        .select({
          id:              programsTable.id,
          name:            programsTable.name,
          degree:          programsTable.degree,
          language:        programsTable.language,
          tuitionFee:      programsTable.tuitionFee,
          discountedFee:   programsTable.discountedFee,
          scholarship:     programsTable.scholarship,
          commissionRate:  programsTable.commissionRate,
          serviceFeeAmount: programsTable.serviceFeeAmount,
          applicationFee:  programsTable.applicationFee,
          depositFee:      programsTable.depositFee,
          advancedFee:     programsTable.advancedFee,
          languageFee:     programsTable.languageFee,
          currency:        programsTable.currency,
        })
        .from(programsTable)
        .where(
          and(
            eq(programsTable.universityId, crmUniversityId),
            eq(programsTable.isActive, true),
          ),
        );

      // When the source has a known level, only same-level programmes are
      // eligible (mandatory level match). Unknown source level → match by
      // name across all programmes (best effort).
      const candidatePrograms = sourceLevel
        ? programs.filter((p) => levelGroup(p.degree) === sourceLevel)
        : programs;

      if (candidatePrograms.length === 0) {
        results.push({
          universityKey:  uni.universityKey,
          universityName: uni.universityName,
          outcome:        "no-program",
        });
        continue;
      }

      const candidates: ProgramCandidate[] = candidatePrograms.map((p) => ({
        id:   String(p.id),
        name: p.name,
      }));
      const matched = matchProgram(sourceProgramName, candidates);
      if (!matched) {
        results.push({
          universityKey:  uni.universityKey,
          universityName: uni.universityName,
          outcome:        "no-program",
        });
        continue;
      }
      const program = candidatePrograms.find((p) => String(p.id) === matched.match.id)!;

      const docStatus = await checkMandatoryDocsForStudent(
        program.id,
        srcApp.studentId,
        program.degree,
      );
      if (docStatus.missing.length > 0) {
        results.push({
          universityKey: uni.universityKey,
          universityName: uni.universityName,
          outcome: "missing-docs",
          message: docStatus.missing.map(getDocLabel).join(", "),
        });
        continue;
      }

      // --- Dedup + reuse/create application, then dedup + enqueue submission.
      // Serialize both with transaction-scoped Postgres advisory locks
      // (studentId, crmUniversityId) for the application and
      // (applicationId, universityKey) for the submission — the latter mirrors
      // enqueueIfEligible so all enqueue paths serialize on the same key.
      const now = new Date();
      const txOutcome = await db.transaction(
        async (
          tx,
        ): Promise<
          | { kind: "duplicate"; appId: number; subId: number }
          | { kind: "reconciliation"; appId: number; subId: number }
          | { kind: "queued"; appId: number; subId: number }
        > => {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(${srcApp.studentId}, ${crmUniversityId})`,
          );

          let appId: number;
          let intentApplication: {
            id: number;
            universityId: number | null;
            programId: number | null;
            intake: string | null;
            season: string;
          };
          const [existingApp] = await tx
            .select({
              id: applicationsTable.id,
              universityId: applicationsTable.universityId,
              programId: applicationsTable.programId,
              intake: applicationsTable.intake,
              season: applicationsTable.season,
            })
            .from(applicationsTable)
            .where(
              and(
                eq(applicationsTable.studentId, srcApp.studentId),
                eq(applicationsTable.universityId, crmUniversityId),
                isNull(applicationsTable.deletedAt),
              ),
            )
            .limit(1);

          if (existingApp) {
            appId = existingApp.id;
            intentApplication = existingApp;
          } else {
            const [newApp] = await tx
              .insert(applicationsTable)
              .values({
                studentId:           srcApp.studentId,
                leadId:              srcApp.leadId,
                programId:           program.id,
                universityId:        crmUniversityId,
                agentId:             srcApp.agentId,
                assignedToId:        srcApp.assignedToId,
                season:              srcApp.season,
                stage:               "inquiry",
                level:               program.degree ?? srcApp.level ?? null,
                instructionLanguage: program.language ?? null,
                programName:         program.name,
                universityName:      uni.universityName,
                country:             srcApp.country,
                tuitionFee:          program.tuitionFee ?? null,
                discountedFee:       program.discountedFee ?? null,
                scholarship:         program.scholarship ?? null,
                commissionRate:      program.commissionRate ?? null,
                serviceFeeAmount:    program.serviceFeeAmount ?? null,
                applicationFee:      program.applicationFee ?? null,
                depositFee:          program.depositFee ?? null,
                advancedFee:         program.advancedFee ?? null,
                languageFee:         program.languageFee ?? null,
                currency:            program.currency ?? null,
                // Origin attribution copied verbatim from the source application.
                originType:          srcApp.originType,
                originEntityType:    srcApp.originEntityType,
                originEntityId:      srcApp.originEntityId,
                originDisplayName:   srcApp.originDisplayName,
                originLocked:        srcApp.originLocked,
                originStudentId:     srcApp.originStudentId,
                branchId:            srcApp.branchId,
                // Portal-automation fan-out (apply-to-all / apply-to-all-bulk).
                createdSource:       "automation",
                // Root/main application of the fallback chain: the student's
                // originally-applied app (or its own root if the source is itself
                // a chain member). Lets each fan-out hop recover the applied
                // programme/language/level and detect same-uni (X) vs diff-uni (Y).
                mainApplicationId:   srcApp.mainApplicationId ?? srcApp.id,
                createdAt:           now,
                updatedAt:           now,
              })
              .returning({
                id: applicationsTable.id,
                universityId: applicationsTable.universityId,
                programId: applicationsTable.programId,
                intake: applicationsTable.intake,
                season: applicationsTable.season,
              });
            appId = newApp.id;
            intentApplication = newApp;
          }

          const intent = createPortalSubmissionIntentFromSnapshot({
            application: intentApplication,
            portalUniversity: routeVia ?? uni,
            targetCatalogUniversityId: crmUniversityId,
            source: "fanout",
          });

          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(${appId}, hashtext(${intent.targetIdentitySha256}))`,
          );

          const [existingSub] = await tx
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
                eq(portalSubmissionsTable.applicationId, appId),
                or(
                  eq(portalSubmissionsTable.targetIdentitySha256, intent.targetIdentitySha256),
                  and(
                    isNull(portalSubmissionsTable.targetIdentitySha256),
                    eq(portalSubmissionsTable.universityKey, submissionKey),
                  ),
                ),
                eq(portalSubmissionsTable.mode, mode),
                or(
                  inArray(portalSubmissionsTable.status, [
                    ...submissionDedupStatuses,
                    "already_exists",
                    "accepted",
                  ]),
                  isNotNull(portalSubmissionsTable.providerCommittedAt),
                ),
                isNull(portalSubmissionsTable.deletedAt),
              ),
            )
            .limit(1);

          if (existingSub) {
            if (
              mode === "real" &&
              (existingSub.providerCommittedAt !== null ||
                (existingSub.targetIdentitySha256 === null &&
                  ["submitted", "already_exists", "accepted"].includes(existingSub.status) &&
                  existingSub.externalRef))
            ) {
              return { kind: "reconciliation", appId, subId: existingSub.id };
            }
            return { kind: "duplicate", appId, subId: existingSub.id };
          }

          // AUTO (aggregator-routed) fan-out only: cap cross-row retries.
          // Failed rows are outside submissionDedupStatuses, so a repeatedly
          // failing member would otherwise get a fresh queued row on every
          // auto re-trigger — an infinite loop that also blocks the queue.
          // The legacy manual apply-to-all path keeps failed rows retryable
          // (a human clicked, not a loop).
          if (routeVia) {
            const [failedCnt] = await tx
              .select({ n: sql<number>`count(*)::int` })
              .from(portalSubmissionsTable)
              .where(
                and(
                  eq(portalSubmissionsTable.applicationId, appId),
                  eq(portalSubmissionsTable.universityKey, submissionKey),
                  eq(portalSubmissionsTable.status, "failed"),
                  isNull(portalSubmissionsTable.deletedAt),
                ),
              );
            if ((failedCnt?.n ?? 0) >= MAX_AUTO_FAILED_SUBMISSIONS) {
              console.warn(
                `[portal-fanout] app=${appId} uni=${submissionKey}: ` +
                  `${failedCnt!.n} başarısız deneme — otomatik fan-out yeniden kuyruklama durduruldu (max_failures)`,
              );
              return { kind: "duplicate", appId, subId: 0 };
            }
          }

          const [subRow] = await tx
            .insert(portalSubmissionsTable)
            .values({
              applicationId:  appId,
              studentId:      srcApp.studentId,
              universityKey:  submissionKey,
              universityName: uni.universityName,
              // Aggregator-routed rows run on the aggregator's adapter;
              // direct fan-out rows on the candidate's own adapter.
              adapterKey:     routeVia ? routeVia.adapterKey : uni.adapterKey,
              mode,
              status:         "queued",
              enqueuedBy:     userId,
              submitIntentKey: intent.submitIntentKey,
              targetIdentitySha256: intent.targetIdentitySha256,
              targetIdentity: intent.targetIdentity,
              submissionAction: "submit",
              // Manual fan-out must bypass the university auto-process and
              // trigger-stage gates. Aggregator routing additionally names the
              // member school to select inside the portal.
              meta: buildManualFanOutMeta(routeVia, {
                crmUniversityId,
                universityName: uni.universityName,
              }),
            })
            .returning({ id: portalSubmissionsTable.id });

          return { kind: "queued", appId, subId: subRow.id };
        },
      );

      // Fan-out application creation bypasses the normal applications route.
      // Reconcile finance here so the new row immediately receives the same
      // commission/service-fee treatment as a manually-created application.
      await syncApplicationFinance(txOutcome.appId);

      results.push({
        universityKey:  uni.universityKey,
        universityName: uni.universityName,
        outcome:
          txOutcome.kind === "duplicate"
            ? "duplicate"
            : txOutcome.kind === "reconciliation"
              ? "reconciliation-required"
              : "queued",
        applicationId:  txOutcome.appId,
        submissionId:   txOutcome.subId,
        programName:    program.name,
        confidence:     matched.conf,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[apply-to-all] uni=${uni.universityKey} failed:`, msg);
      results.push({
        universityKey:  uni.universityKey,
        universityName: uni.universityName,
        outcome:        "failed",
        message:        msg,
      });
    }
  }

  return results;
}

/** Tally per-outcome counts for an apply-to-all result list. */
function computeApplyToAllCounts(results: ApplyToAllItem[]) {
  return {
    queued:    results.filter((r) => r.outcome === "queued").length,
    excluded:  results.filter((r) => r.outcome === "excluded").length,
    noProgram: results.filter((r) => r.outcome === "no-program").length,
    duplicate: results.filter((r) => r.outcome === "duplicate").length,
    reconciliationRequired: results.filter((r) => r.outcome === "reconciliation-required").length,
    failed:    results.filter((r) => r.outcome === "failed").length,
  };
}

/**
 * Notify that work is queued for the dedicated portal worker.
 *
 * When `triggerStages` is provided (auto-enqueue immediate drain), only
 * submissions whose application is currently in one of those stages are
 * claimed — same stage-gating convention as Run Now. When omitted (fan-out /
 * manual call sites), all queued submissions are drained regardless of stage.
 *
 * Portal browsers must never run fire-and-forget inside the API process. Long
 * SIT/United wizards exceed the API's inline response window; the historical
 * requeue path then launched overlapping Chromium sessions for one submission.
 * The always-on worker polls every five seconds and is the single owner.
 */
export function triggerBackgroundDrain(label: string, triggerStages?: string[]): void {
  void triggerStages;
  console.log(`[${label}] queued for dedicated portal worker`);
}

// ---------------------------------------------------------------------------
// Portal-agnostic 3-mode fan-out system
//
// Fan-out mode is DB-driven (portal_automation_settings.fan_out_mode for the
// global default; portal_universities.fan_out_mode for per-university overrides).
//
//   'off'    — no fan-out; only submit to the directly applied university (default).
//   'manual' — operator presses the "Fan-out" button to trigger for an application.
//   'auto'   — fan out automatically when a student reaches a trigger stage.
//
// The master kill-switch (settings.isEnabled=false) forces 'off' regardless.
// Legacy SIT_AUTO_FANOUT env is honoured as a fallback for the SIT aggregator
// when the DB does not explicitly set it to a non-default value.
//
// Target universities:
//   • Multi-portal aggregator (SIT, United…): members of that aggregator,
//     routed via the aggregator key (existing behaviour).
//   • Direct portal (Topkapi, etc.): all credential-ready, CRM-linked universities.
// ---------------------------------------------------------------------------

/** The SIT aggregator's portal key / adapter key (kept for routing checks). */
const SIT_AGGREGATOR_KEY = "sit";

/**
 * Resolve the effective fan-out mode for a given portal university key.
 *
 * Priority:
 *   1. Master kill-switch: if settings.isEnabled === false → always 'off'.
 *   2. Per-university override (portal_universities.fan_out_mode, non-null).
 *   3. Legacy SIT_AUTO_FANOUT env (for SIT key only, when DB has not set auto).
 *   4. Global default (portal_automation_settings.fan_out_mode, default 'off').
 *
 * @param universityKey  The resolved portal university key (after routing).
 * @param settings       Pre-fetched settings row (optional, avoids extra query).
 */
async function resolveFanOutMode(
  universityKey: string,
  settings?: typeof portalAutomationSettingsTable.$inferSelect,
): Promise<"off" | "manual" | "auto"> {
  const s = settings ??
    (await db.select().from(portalAutomationSettingsTable).limit(1))[0];

  // Master kill-switch always wins.
  if (!s?.isEnabled) return "off";

  // Per-university override (null = inherit).
  const [uni] = await db
    .select({ fanOutMode: portalUniversitiesTable.fanOutMode })
    .from(portalUniversitiesTable)
    .where(and(
      eq(portalUniversitiesTable.universityKey, universityKey),
      isNull(portalUniversitiesTable.deletedAt),
    ))
    .limit(1);

  const uniMode = uni?.fanOutMode as "off" | "manual" | "auto" | null | undefined;
  if (uniMode) return uniMode;

  // Legacy SIT_AUTO_FANOUT env compatibility: only applies to the SIT key and
  // only when the DB global is still at the default ('off' or unset).
  const globalMode = (s as { fanOutMode?: string }).fanOutMode as "off" | "manual" | "auto" | undefined;
  if (universityKey === SIT_AGGREGATOR_KEY && (!globalMode || globalMode === "off")) {
    const v = (process.env.SIT_AUTO_FANOUT ?? "").trim().toLowerCase();
    if (v === "true" || v === "1" || v === "yes" || v === "on") return "auto";
  }

  return globalMode ?? "off";
}

/**
 * Load the fan-out candidate universities for a MULTI-PORTAL aggregator.
 * Returns the aggregator's enabled member universities, each carrying the
 * member's CRM id + name (for program-match + application creation) and the
 * aggregator's key + adapter (for routing + credentials).
 * Returns [] when the aggregator row is missing or inactive.
 */
async function loadAggregatorMemberUniversities(
  aggregatorKey: string,
  mode: "dry" | "real",
): Promise<CredentialReadyUniversity[]> {
  const [aggregator] = await db
    .select({
      id:            portalUniversitiesTable.id,
      universityKey: portalUniversitiesTable.universityKey,
      adapterKey:    portalUniversitiesTable.adapterKey,
      verificationGeneration: portalUniversitiesTable.verificationGeneration,
    })
    .from(portalUniversitiesTable)
    .where(and(
      eq(portalUniversitiesTable.universityKey, aggregatorKey),
      eq(portalUniversitiesTable.isActive, true),
      isNull(portalUniversitiesTable.deletedAt),
    ))
    .limit(1);
  if (!aggregator) return [];
  const verification = await getPortalExecutionVerification({
    universityKey: aggregator.universityKey,
    adapterKey: aggregator.adapterKey,
  });
  const verificationReady = mode === "dry"
    ? verification?.testLoginPassed === true && verification.binding?.strictDryRunCapable === true
    : verification?.testLoginPassed === true && verification.strictDryRunPassed === true;
  if (!verificationReady) return [];

  const members = await db
    .select({
      catalogUniversityId: portalAccountUniversitiesTable.catalogUniversityId,
      name:                universitiesTable.name,
    })
    .from(portalAccountUniversitiesTable)
    .innerJoin(
      universitiesTable,
      eq(universitiesTable.id, portalAccountUniversitiesTable.catalogUniversityId),
    )
    .where(and(
      eq(portalAccountUniversitiesTable.portalKey, aggregatorKey),
      eq(portalAccountUniversitiesTable.enabled, true),
    ));

  // For the SIT aggregator, additionally gate on the agreed membership allowlist.
  const filtered = aggregatorKey === SIT_AGGREGATOR_KEY
    ? members.filter((m) => isSitMember(m.name))
    : members;

  return filtered.map((m) => ({
    id:              aggregator.id,
    universityKey:   aggregator.universityKey,
    universityName:  m.name,
    adapterKey:      aggregator.adapterKey,
    crmUniversityId: m.catalogUniversityId,
    verificationGeneration: aggregator.verificationGeneration,
  }));
}

/**
 * Fire-and-forget: portal-agnostic automatic fan-out gate.
 *
 * Called from enqueueOnStageChange (stage-change hook) for every application
 * whose university resolves to a portal with fanOutMode='auto'.
 *
 * Steps:
 *   1. Master kill-switch (settings.isEnabled) — early return.
 *   2. Trigger-stage gate — fan-out only when app is at a configured stage.
 *   3. Resolve portal routing for the application's university.
 *   4. resolveFanOutMode — return unless 'auto'.
 *   5. Credential check on the resolved portal.
 *   6. Load target universities (aggregator members OR all credential-ready).
 *   7. fanOutApplicationToUniversities — dedup+enqueue.
 *
 * Idempotent: re-invocation only fills gaps (dedup). Never throws.
 */
export async function maybeFanOutStudentForApplication(
  applicationId: number,
  actorUserId: number,
): Promise<void> {
  try {
    const [savedSettings] = await db
      .select()
      .from(portalAutomationSettingsTable)
      .limit(1);
    if (!savedSettings?.isEnabled) return;
    const settings = await withEligiblePortalTriggerStages(savedSettings);

    const [srcApp] = await db
      .select()
      .from(applicationsTable)
      .where(and(eq(applicationsTable.id, applicationId), isNull(applicationsTable.deletedAt)))
      .limit(1);
    if (!srcApp) return;

    // Gate on trigger stage — fan out only when the app is at a stage that
    // would itself be auto-submitted, so auto fan-out and per-app enqueue agree.
    const triggerStages = Array.isArray(settings.triggerStages)
      ? (settings.triggerStages as string[])
      : [];
    if (!triggerStages.includes(String(srcApp.stage))) return;

    // Resolve the portal (and aggregator routing) for this application.
    const routing = await resolvePortalRouting({
      universityId:   srcApp.universityId ?? null,
      universityName: srcApp.universityName ?? null,
    });
    if (!routing) return;

    const portalKey = routing.portalUni.universityKey;

    // Check fan-out mode for the resolved portal key.
    const fanOutMode = await resolveFanOutMode(portalKey, settings);
    if (fanOutMode !== "auto") return;

    // Automatic fan-out is a real execution path. Current release-bound Test
    // Login and Strict Dry Run receipts are required for the source portal;
    // environment credentials alone never unlock it.
    const sourceVerification = await getPortalExecutionVerification({
      universityKey: portalKey,
      adapterKey: routing.portalUni.adapterKey,
    });
    if (!sourceVerification?.testLoginPassed || !sourceVerification.strictDryRunPassed) {
      console.warn(`[portal-fanout] skipped app=${applicationId}: partner verification missing for ${portalKey}`);
      return;
    }

    // Target university selection:
    //   Multi-portal aggregator → load its member universities (routeVia set).
    //   Direct portal           → all credential-ready unis except the source.
    let unis: CredentialReadyUniversity[];
    let routeVia:
      | {
          id: number;
          universityKey: string;
          adapterKey: string;
          verificationGeneration: number;
        }
      | undefined;

    if (routing.portalUni.isMultiPortal) {
      unis    = await loadAggregatorMemberUniversities(portalKey, "real");
      routeVia = {
        id: routing.portalUni.id,
        universityKey: portalKey,
        adapterKey: routing.portalUni.adapterKey,
        verificationGeneration: routing.portalUni.verificationGeneration,
      };
    } else {
      unis = (await loadCredentialReadyPortalUniversities("real"))
        .filter((u) => u.universityKey !== portalKey);
    }

    if (unis.length === 0) return;

    const mode = settings.mode === "real" ? "real" : "dry";
    const results = await fanOutApplicationToUniversities(srcApp, unis, mode, actorUserId, routeVia);
    const counts  = computeApplyToAllCounts(results);

    if (counts.queued > 0) triggerBackgroundDrain(`fanout-${actorUserId}`);

    await logAudit(
      actorUserId,
      "portal.autoFanOut",
      "student",
      srcApp.studentId,
      {
        applicationId,
        portalKey,
        mode,
        unis: unis.length,
        ...counts,
        total: results.length,
      },
    );

    console.log(
      `[portal-fanout] app=${applicationId} student=${srcApp.studentId}` +
      ` portal=${portalKey} mode=${mode} unis=${unis.length}` +
      ` queued=${counts.queued} excluded=${counts.excluded}` +
      ` noProgram=${counts.noProgram} duplicate=${counts.duplicate} failed=${counts.failed}`,
    );
  } catch (err) {
    console.error(`[portal-fanout] failed for app=${applicationId}:`, err);
  }
}

/**
 * Backward-compat alias — applications.ts still imports this name.
 * Delegates to the portal-agnostic maybeFanOutStudentForApplication.
 */
export const maybeFanOutSitStudentForApplication = maybeFanOutStudentForApplication;

// ---------------------------------------------------------------------------
// POST /portal-automation/applications/:id/fanout — Manual fan-out for one app
//
// Fans out a single application to all credential-ready universities right now,
// regardless of the fan-out mode (operator decision). The only hard gate is the
// master kill-switch (settings.isEnabled=false → 409). Idempotent: re-triggering
// only fills gaps (dedup). Submission Mode (settings.mode) decides dry vs real.
// ---------------------------------------------------------------------------
const fanoutParamsSchema = z.object({ id: z.coerce.number().int().positive() });
type FanoutSchemas = { params: typeof fanoutParamsSchema };

router.post(
  "/portal-automation/applications/:id/fanout",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  validate({ params: fanoutParamsSchema }),
  async (req, res): Promise<void> => {
    const user = req.user!;
    const { id: applicationId } = getValidated<FanoutSchemas>(req).params;

    // Master kill-switch: isEnabled=false → manual fan-out also blocked.
    const [settings] = await db.select().from(portalAutomationSettingsTable).limit(1);
    if (!settings?.isEnabled) {
      res.status(409).json({
        error: "PORTAL_DISABLED",
        message: "Portal automation is disabled. Enable it in settings before fanning out.",
      });
      return;
    }

    const [srcApp] = await db
      .select()
      .from(applicationsTable)
      .where(and(eq(applicationsTable.id, applicationId), isNull(applicationsTable.deletedAt)))
      .limit(1);
    if (!srcApp) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }

    // Fan out to all credential-ready universities (same pool as apply-to-all).
    const mode  = settings.mode === "real" ? "real" : "dry";
    const unis  = await loadCredentialReadyPortalUniversities(mode);
    const results = await fanOutApplicationToUniversities(srcApp, unis, mode, user.id);
    const counts  = computeApplyToAllCounts(results);

    if (counts.queued > 0) triggerBackgroundDrain(`manual-fanout-${user.id}`);

    await logAudit(
      user.id,
      "portal.manualFanOut",
      "application",
      applicationId,
      { mode, unis: unis.length, ...counts, total: results.length },
      req.ip,
    );

    res.json({
      created:  counts.queued,
      excluded: counts.excluded,
      noProgram: counts.noProgram,
      duplicate: counts.duplicate,
      failed:   counts.failed,
      total:    results.length,
    });
  },
);

router.post(
  "/portal-automation/apply-to-all",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ body: applyToAllBodySchema }),
  async (req, res): Promise<void> => {
    const user = req.user!;
    const { applicationId, mode, confirm } = getValidated<ApplyToAllSchemas>(req).body;

    if (manualSubmitRateLimited(user.id)) {
      res.status(429).json({ error: "RATE_LIMITED", message: "Too many submissions, slow down." });
      return;
    }
    if (mode === "real" && !confirm) {
      res.status(422).json({
        error: "CONFIRM_REQUIRED",
        message: "Set confirm:true to submit in real mode",
      });
      return;
    }

    // ----- Source application ----------------------------------------------
    const [srcApp] = await db
      .select()
      .from(applicationsTable)
      .where(and(eq(applicationsTable.id, applicationId), isNull(applicationsTable.deletedAt)))
      .limit(1);
    if (!srcApp) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }

    // Fan-out via the shared core (credential-ready, CRM-linked universities).
    const unis = await loadCredentialReadyPortalUniversities(mode);
    const results = await fanOutApplicationToUniversities(srcApp, unis, mode, user.id);
    const counts = computeApplyToAllCounts(results);

    // ----- Trigger a background drain (non-blocking) -----------------------
    if (counts.queued > 0) triggerBackgroundDrain(`applyall-${user.id}`);

    await logAudit(
      user.id,
      "portal.applyToAll",
      "application",
      applicationId,
      { mode, ...counts, total: results.length },
      req.ip,
    );

    res.status(counts.queued > 0 ? 201 : 200).json({ mode, results, counts });
  },
);

// ---------------------------------------------------------------------------
// GET /portal-automation/apply-to-all-bulk/count — preview for the bulk confirm
// dialog: how many trigger-stage applications would fan out, and how many
// credential-ready universities they'd target. Read-only, no side effects.
// ---------------------------------------------------------------------------
router.get(
  "/portal-automation/apply-to-all-bulk/count",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (_req, res): Promise<void> => {
    const [settings] = await db
      .select()
      .from(portalAutomationSettingsTable)
      .limit(1);
    const runtimeSettings = settings
      ? await withEligiblePortalTriggerStages(settings)
      : null;
    const triggerStages = runtimeSettings?.triggerStages ?? [];

    if (triggerStages.length === 0) {
      res.json({ applications: 0, universities: 0, triggerStages: [] });
      return;
    }

    const [row] = await db
      .select({ n: count() })
      .from(applicationsTable)
      .where(and(
        inArray(applicationsTable.stage, triggerStages),
        isNull(applicationsTable.deletedAt),
      ));

    const unis = await loadCredentialReadyPortalUniversities(
      runtimeSettings?.mode === "real" ? "real" : "dry",
    );
    res.json({
      applications: Number(row?.n ?? 0),
      universities: unis.length,
      triggerStages,
    });
  },
);

// ---------------------------------------------------------------------------
// POST /portal-automation/apply-to-all-bulk — fan out EVERY application that is
// currently in a configured trigger stage to ALL credential-ready portal
// universities. Thin wrapper over the SAME shared fan-out core used by the
// single apply-to-all endpoint (no parallel engine). Existing per-university
// dedup means already-submitted (student+university) pairs are skipped, so
// re-runs never double-submit. Terminal stages are excluded automatically
// because they are never configured as trigger stages.
//
// Body: { mode: "dry"|"real", confirm?: boolean }
// ---------------------------------------------------------------------------
const applyToAllBulkBodySchema = z.object({
  mode: z.enum(["dry", "real"]),
  confirm: z.boolean().optional(),
});
type ApplyToAllBulkSchemas = { body: typeof applyToAllBulkBodySchema };

router.post(
  "/portal-automation/apply-to-all-bulk",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ body: applyToAllBulkBodySchema }),
  async (req, res): Promise<void> => {
    const user = req.user!;
    const { mode, confirm } = getValidated<ApplyToAllBulkSchemas>(req).body;

    if (manualSubmitRateLimited(user.id)) {
      res.status(429).json({ error: "RATE_LIMITED", message: "Too many submissions, slow down." });
      return;
    }
    if (mode === "real" && !confirm) {
      res.status(422).json({
        error: "CONFIRM_REQUIRED",
        message: "Set confirm:true to submit in real mode",
      });
      return;
    }

    // ----- Resolve trigger stages from settings ----------------------------
    const [settings] = await db
      .select()
      .from(portalAutomationSettingsTable)
      .limit(1);
    const runtimeSettings = settings
      ? await withEligiblePortalTriggerStages(settings)
      : null;
    const triggerStages = runtimeSettings?.triggerStages ?? [];
    if (triggerStages.length === 0) {
      res.status(409).json({
        error: "NO_TRIGGER_STAGES",
        message: "No trigger stages configured — select at least one before bulk submitting.",
      });
      return;
    }

    // ----- Source applications (trigger-stage, non-deleted) ----------------
    const srcApps = await db
      .select()
      .from(applicationsTable)
      .where(and(
        inArray(applicationsTable.stage, triggerStages),
        isNull(applicationsTable.deletedAt),
      ))
      .orderBy(asc(applicationsTable.id));

    // ----- Fan out each application via the shared core --------------------
    const unis = await loadCredentialReadyPortalUniversities(mode);
    const allResults: ApplyToAllItem[] = [];
    for (const srcApp of srcApps) {
      const results = await fanOutApplicationToUniversities(srcApp, unis, mode, user.id);
      allResults.push(...results);
    }
    const counts = computeApplyToAllCounts(allResults);

    // ----- Trigger a background drain (non-blocking) -----------------------
    if (counts.queued > 0) triggerBackgroundDrain(`applyallbulk-${user.id}`);

    await logAudit(
      user.id,
      "portal.applyToAllBulk",
      "application",
      undefined,
      {
        mode,
        applications: srcApps.length,
        universities: unis.length,
        ...counts,
        total: allResults.length,
      },
      req.ip,
    );

    res.status(counts.queued > 0 ? 201 : 200).json({
      mode,
      applications: srcApps.length,
      universities: unis.length,
      counts,
    });
  },
);

// ---------------------------------------------------------------------------
// GET /university-portals
// Returns active portal universities that have current execution evidence.
// Used by app-detail Submit dropdown; environment-only credentials and orphan
// registry adapters cannot unlock a newly onboarded partner.
// ---------------------------------------------------------------------------
router.get("/university-portals", requireAuth, async (_req, res): Promise<void> => {
  const unis = await db
    .select({
      id: portalUniversitiesTable.id,
      universityKey: portalUniversitiesTable.universityKey,
      universityName: portalUniversitiesTable.universityName,
      adapterKey: portalUniversitiesTable.adapterKey,
      verificationGeneration: portalUniversitiesTable.verificationGeneration,
    })
    .from(portalUniversitiesTable)
    .where(
      and(
        eq(portalUniversitiesTable.isActive, true),
        isNull(portalUniversitiesTable.deletedAt),
      ),
    );
  const verificationStates = await loadPortalPartnerVerificationStates(unis);
  const result = unis.flatMap((uni) => {
    const verification = verificationStates.get(uni.id);
    const dryRunReady =
      verification?.testLoginPassed === true &&
      verification.binding?.strictDryRunCapable === true;
    if (!dryRunReady) return [];
    return [{
      key: uni.universityKey,
      label: uni.universityName,
      adapterKey: uni.adapterKey,
      hasCredentials: verification.encryptedCredentialsReady,
      dryRunReady: true,
      realRunReady: verification.strictDryRunPassed,
    }];
  });

  res.json(result);
});

// ---------------------------------------------------------------------------
// POST /portal-automation/relink-universities
//
// Manually triggers the portal ⇄ CRM university auto-linker. Fills
// portal_universities.crm_university_id by Turkish-aware name matching so
// fan-out can see each portal university's CRM program catalog. Never
// wrong-links: ambiguous names are left NULL and surfaced as `unmatched`.
// `force` recomputes even already-linked rows (still safe).
// ---------------------------------------------------------------------------
const relinkUniversitiesBodySchema = z.object({
  force: z.boolean().optional(),
});
type RelinkUniversitiesSchemas = { body: typeof relinkUniversitiesBodySchema };

router.post(
  "/portal-automation/relink-universities",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ body: relinkUniversitiesBodySchema }),
  async (req, res): Promise<void> => {
    const { force } = getValidated<RelinkUniversitiesSchemas>(req).body;
    const result = await reconcilePortalUniversityCrmLinks({ force: !!force });
    logAudit(
      req.user!.id,
      "relink_portal_universities",
      "portal_universities",
      undefined,
      {
        force: !!force,
        linked: result.linked.length,
        alreadyLinked: result.alreadyLinked,
        unmatched: result.unmatched.length,
        stale: result.stale.length,
      },
      req.ip,
    );
    res.json(result);
  },
);

// ---------------------------------------------------------------------------
// Background job: scheduled auto-drain (Scheduled Auto-Process ON)
// ---------------------------------------------------------------------------

/** How often the scheduler checks whether a scheduled drain is due. */
const AUTO_DRAIN_TICK_MS = 60_000; // 1 minute

/** Fallback drain interval when the settings column is unset. */
const DEFAULT_AUTO_PROCESS_INTERVAL_MIN = 20;

/** Outcome of one scheduler tick — exported shape for the test script. */
export type AutoDrainTickResult =
  | { ran: false; reason: "disabled" | "scheduled_off" | "interval_not_elapsed" | "worker_unavailable" }
  | { ran: true; claimed: number; processed: number };

/**
 * One scheduled-drain tick. Loads settings fresh each tick so toggling the
 * Scheduled Auto-Process switch (or the kill-switch) takes effect without a
 * restart. Drains only when:
 *
 *   1. isEnabled (global kill-switch — single gate, nothing runs when off)
 *   2. autoProcessEnabled (Scheduled Auto-Process toggle)
 *   3. `auto_process_interval_minutes` have elapsed since last_auto_drain_at
 *      (never-drained → due immediately)
 *   4. a release-matched worker advertises the configured execution mode
 *
 * Browser execution never occurs here. The API scheduler only verifies worker
 * readiness and advances its observation timestamp; the dedicated worker owns
 * claims, browser sessions and stale-lock recovery.
 *
 * Exported separately from startPortalAutoDrain so the test script can drive
 * ticks deterministically without timers.
 */
export async function runPortalAutoDrainTick(): Promise<AutoDrainTickResult> {
  const [savedSettings] = await db
    .select()
    .from(portalAutomationSettingsTable)
    .limit(1);

  if (!savedSettings?.isEnabled)       return { ran: false, reason: "disabled" };
  const settings = await withEligiblePortalTriggerStages(savedSettings);
  if (!settings.autoProcessEnabled) return { ran: false, reason: "scheduled_off" };

  const intervalMin =
    settings.autoProcessIntervalMinutes ?? DEFAULT_AUTO_PROCESS_INTERVAL_MIN;
  const lastMs = settings.lastAutoDrainAt
    ? new Date(settings.lastAutoDrainAt).getTime()
    : 0;
  if (Date.now() - lastMs < intervalMin * 60_000) {
    return { ran: false, reason: "interval_not_elapsed" };
  }

  try {
    await assertPortalWorkerReady(settings.mode);
  } catch (error) {
    if (error instanceof PortalWorkerUnavailableError) {
      return { ran: false, reason: "worker_unavailable" };
    }
    throw error;
  }

  const [queued] = await db
    .select({ total: count() })
    .from(portalSubmissionsTable)
    .where(and(
      eq(portalSubmissionsTable.status, "queued"),
      eq(portalSubmissionsTable.mode, settings.mode),
      isNull(portalSubmissionsTable.deletedAt),
    ));

  await db
    .update(portalAutomationSettingsTable)
    .set({ lastAutoDrainAt: new Date() })
    .where(eq(portalAutomationSettingsTable.id, settings.id));

  return { ran: true, claimed: queued?.total ?? 0, processed: 0 };
}

/**
 * Starts the periodic scheduled-drain checker. Errors are caught and logged
 * per tick — the interval never crashes the process.
 */
export function startPortalAutoDrain(intervalMs = AUTO_DRAIN_TICK_MS): void {
  const run = (): void => {
    runPortalAutoDrainTick().catch((err) => {
      console.error("[portal-auto-drain] Tick error:", err);
    });
  };
  setInterval(run, intervalMs);
  console.log(`[portal-auto-drain] Started — tick=${intervalMs}ms`);
}

// ---------------------------------------------------------------------------
// Background job: distributed portal status sync
// ---------------------------------------------------------------------------

const PORTAL_STATUS_CHECK_TIMEOUT_MS = 60_000;

async function pollPortalStatusWithTimeout<T>(
  operation: Promise<T>,
  onTimeout: () => Promise<void>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("PORTAL_STATUS_CHECK_TIMEOUT"));
          void onTimeout();
        }, PORTAL_STATUS_CHECK_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * One distributed, fair status-sync sweep. Rows are leased with SKIP LOCKED
 * and grouped by portal-account lane. Each lane gets its own login/session;
 * a broken or slow university cannot block unrelated portals.
 */
export async function runPortalStatusSync(options: { allowArtifacts?: boolean } = {}): Promise<{ checked: number; updated: number }> {
  const workerId = `status-sync-${process.pid}-${Date.now()}`;
  const rows = await claimDuePortalStatusChecks({
    workerId,
    maxLanes: 4,
    rowsPerLane: 5,
  });
  if (rows.length === 0) return { checked: 0, updated: 0 };

  const lanes = new Map<string, ClaimedPortalStatusCheck[]>();
  for (const row of rows) {
    const lane = lanes.get(row.laneKey) ?? [];
    lane.push(row);
    lanes.set(row.laneKey, lane);
  }

  let updated = 0;
  const processRow = async (
    row: ClaimedPortalStatusCheck,
    result: PortalStatusCheckResult,
    adapter: UniversityAdapter,
    session: AdapterSession,
  ): Promise<void> => {
    const observation = normalizePortalLifecycleObservation({
      submissionId: row.id,
      applicationId: row.applicationId,
      adapterKey: row.adapterKey,
      result,
    });
    const recordedObservation = await recordPortalLifecycleObservation(observation);
    const referenceSync = observation.identityVerified
      ? await syncVerifiedPortalApplicationNumber({
          applicationId: row.applicationId,
          verifiedApplicationNumber: observation.verifiedApplicationNumber,
        })
      : "invalid";
    const requiredArtifact = requiredPortalArtifactForSignal(observation.signal) as
      | PortalStatusArtifactKind
      | null;
    let artifactStored = false;
    if (
      observation.identityVerified &&
      options.allowArtifacts === true &&
      requiredArtifact &&
      adapter.collectStatusArtifacts &&
      !(await hasStoredPortalLifecycleArtifact(row.applicationId, requiredArtifact))
    ) {
      const artifacts = await adapter.collectStatusArtifacts(
        session,
        row.externalRef,
        result,
        [requiredArtifact],
      );
      if (artifacts.some((artifact) => artifact.kind !== requiredArtifact)) {
        throw new Error("PORTAL_STATUS_ARTIFACT_KIND_MISMATCH");
      }
      const artifactOutcomes = await persistPortalStatusArtifacts({
        submissionId: row.id,
        applicationId: row.applicationId,
        observationId: recordedObservation.id,
        observationHash: observation.observationHash,
        identityVerified: observation.identityVerified,
        artifacts,
      });
      artifactStored = artifactOutcomes.some((artifact) => artifact.created);
    }
    const prevPortalStatus = row.resultJson?.portalStatus as string | undefined;
    const statusChanged = observation.rawStatus !== prevPortalStatus;
    const internalStatus = observation.identityVerified
      ? mapPortalDispositionToSubmissionStatus(observation.disposition)
      : null;
    const newResultJson = {
      ...(row.resultJson ?? {}),
      portalStatus: observation.rawStatus,
      portalStatusCheckedAt: new Date().toISOString(),
      portalLifecycle: {
        observationId: recordedObservation.id,
        disposition: observation.disposition,
        identityVerified: observation.identityVerified,
        missingDocumentCount: observation.missingDocuments.length,
        applicationReferenceSync: referenceSync,
      },
    };

    // A terminal portal result must not become invisible to operations. Queue
    // the idempotent review item before changing the submission status; if the
    // durable queue write fails, the outer worker retry keeps this row eligible.
    await queuePortalLifecycleReview({
      submissionId: row.id,
      applicationId: row.applicationId,
      rawStatus: observation.rawStatus,
      observationId: recordedObservation.id,
      observationHash: observation.observationHash,
      identityVerified: observation.identityVerified,
      missingDocuments: observation.missingDocuments,
      applicationReferenceSync: referenceSync,
    });

    if (internalStatus) {
      const transitioned = await db
        .update(portalSubmissionsTable)
        .set({ status: internalStatus, resultJson: newResultJson, updatedAt: new Date() })
        .where(
          and(
            eq(portalSubmissionsTable.id, row.id),
            eq(portalSubmissionsTable.statusCheckLockedBy, workerId),
            eq(portalSubmissionsTable.status, "submitted"),
          ),
        )
        .returning({ id: portalSubmissionsTable.id });
      if (transitioned.length === 0) {
        throw new Error("PORTAL_STATUS_CHECK_LEASE_LOST");
      }

      const [appRow] = await db
        .select({
          universityName: applicationsTable.universityName,
          programName: applicationsTable.programName,
          assignedToId: applicationsTable.assignedToId,
        })
        .from(applicationsTable)
        .where(eq(applicationsTable.id, row.applicationId))
        .limit(1);
      let studentName = "student";
      if (row.studentId) {
        const [student] = await db
          .select({ firstName: studentsTable.firstName, lastName: studentsTable.lastName })
          .from(studentsTable)
          .where(eq(studentsTable.id, row.studentId))
          .limit(1);
        if (student) {
          studentName = `${student.firstName ?? ""} ${student.lastName ?? ""}`.trim() || studentName;
        }
      }
      const universityName = appRow?.universityName ?? row.universityKey;
      const programName = appRow?.programName ?? "";
      const terminalPresentation = {
        accepted: { label: "Enrolled", icon: "CheckCircle" },
        rejected: { label: "Rejected", icon: "XCircle" },
        program_full: { label: "Program Full", icon: "AlertTriangle" },
        already_exists: { label: "Already Registered", icon: "AlertTriangle" },
        canceled: { label: "Withdrawn", icon: "XCircle" },
      }[internalStatus];
      dispatchNotification({
        event: `portal.application_${internalStatus}`,
        title: `Portal Application ${terminalPresentation.label}`,
        body: `${studentName}'s application to ${universityName}${programName ? ` / ${programName}` : ""} is now ${terminalPresentation.label.toLowerCase()} on the ${row.adapterKey} portal.`,
        actionUrl: `/staff/applications/${row.applicationId}`,
        icon: terminalPresentation.icon,
        recipientUserIds: appRow?.assignedToId ? [appRow.assignedToId] : undefined,
        templateVars: {
          studentName,
          universityName,
          programName,
          portalStatus: observation.rawStatus,
        },
      }).catch(() => {});
    } else {
      const refreshed = await db
        .update(portalSubmissionsTable)
        .set({ resultJson: newResultJson, updatedAt: new Date() })
        .where(
          and(
            eq(portalSubmissionsTable.id, row.id),
            eq(portalSubmissionsTable.statusCheckLockedBy, workerId),
          ),
        )
        .returning({ id: portalSubmissionsTable.id });
      if (refreshed.length === 0) {
        throw new Error("PORTAL_STATUS_CHECK_LEASE_LOST");
      }
    }

    const completed = await completePortalStatusCheck({
      submissionId: row.id,
      workerId,
      nextCheckAt: planPortalStatusSuccess({
        submissionId: row.id,
        disposition: observation.disposition,
      }),
    });
    if (!completed) {
      throw new Error("PORTAL_STATUS_CHECK_LEASE_LOST");
    }
    if (statusChanged || recordedObservation.created || referenceSync === "set" || artifactStored) {
      updated += 1;
    }
  };

  const laneEntries = [...lanes.entries()];
  const laneOutcomes = await Promise.allSettled(
    laneEntries.map(async ([laneKey, laneRows]) => {
      const laneLease = await acquirePortalStatusLaneLease({ laneKey });
      if (!laneLease) {
        await releasePortalStatusChecks({
          submissionIds: laneRows.map((row) => row.id),
          workerId,
        });
        return;
      }
      try {
        const first = laneRows[0]!;
        const verification = await getPortalExecutionVerification({
          universityKey: first.universityKey,
          adapterKey: first.adapterKey,
        });
        if (!verification?.testLoginPassed || !verification.strictDryRunPassed) {
          await Promise.all(
            laneRows.map((row) =>
              failPortalStatusCheck({
                submissionId: row.id,
                workerId,
                currentFailedAttempts: row.statusCheckAttempts,
                error: "STATUS_CHECK_AUTHENTICATION",
              }),
            ),
          );
          console.warn(
            `[portal-status-sync] lane ${laneKey} blocked: current partner verification is missing`,
          );
          return;
        }
        const adapter = await resolveAdapterByKey(first.adapterKey);
        if (!adapter?.checkStatus) {
          await Promise.all(
            laneRows.map((row) =>
              failPortalStatusCheck({
                submissionId: row.id,
                workerId,
                currentFailedAttempts: row.statusCheckAttempts,
                error: "STATUS_CHECK_UNSUPPORTED",
              }),
            ),
          );
          return;
        }

        let session: Awaited<ReturnType<typeof adapter.login>> | undefined;
        try {
          const credentials = await resolvePortalCreds(
            first.universityKey,
            first.adapterKey,
          );
          session = await adapter.login({ credentials, headless: true });
          for (const row of laneRows) {
            try {
              const leaseOwned = await heartbeatPortalStatusCheck({
                submissionId: row.id,
                workerId,
              });
              if (!leaseOwned) {
                console.warn(`[portal-status-sync] ${laneKey} submission #${row.id} lease lost before polling`);
                continue;
              }
              const result = await pollPortalStatusWithTimeout(
                adapter.checkStatus(session, row.externalRef),
                async () => session?.close().catch(() => {}),
              );
              if (result) {
                await processRow(row, result, adapter, session);
              } else {
                const completed = await completePortalStatusCheck({
                  submissionId: row.id,
                  workerId,
                  nextCheckAt: planPortalStatusSuccess({
                    submissionId: row.id,
                    disposition: "UNKNOWN",
                  }),
                });
                if (!completed) throw new Error("PORTAL_STATUS_CHECK_LEASE_LOST");
              }
            } catch (error) {
              const failure = await failPortalStatusCheck({
                submissionId: row.id,
                workerId,
                currentFailedAttempts: row.statusCheckAttempts,
                error,
              });
              console.warn(
                `[portal-status-sync] ${laneKey} submission #${row.id} failed: ${failure.errorCode}`,
              );
            }
          }
        } catch (error) {
          const failures = await Promise.all(
            laneRows.map((row) =>
              failPortalStatusCheck({
                submissionId: row.id,
                workerId,
                currentFailedAttempts: row.statusCheckAttempts,
                error,
              }),
            ),
          );
          console.warn(
            `[portal-status-sync] lane ${laneKey} login failed: ${failures[0]?.errorCode ?? classifyPortalStatusFailure(error)}`,
          );
        } finally {
          await session?.close().catch(() => {});
        }
      } finally {
        await laneLease.release();
      }
    }),
  );
  await Promise.allSettled(
    laneOutcomes.map((outcome, index) => {
      if (outcome.status === "fulfilled") return Promise.resolve();
      const [, laneRows] = laneEntries[index]!;
      return Promise.allSettled(
        laneRows.map((row) =>
          failPortalStatusCheck({
            submissionId: row.id,
            workerId,
            currentFailedAttempts: row.statusCheckAttempts,
            error: outcome.reason,
          }),
        ),
      ).then(() => undefined);
    }),
  );

  return { checked: rows.length, updated };
}

const lifecycleProposalListQuerySchema = z.object({
  status: z.enum(["pending_review", "approved", "rejected", "executing", "executed", "failed", "canceled"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const lifecycleProposalReviewBodySchema = z.object({
  decision: z.enum(["approve", "reject"]),
  reason: z.string().trim().max(1000).optional(),
  requestKey: z.string().min(1).max(100).regex(/^[A-Za-z0-9._:-]+$/),
}).strict();
type LifecycleProposalListSchemas = { query: typeof lifecycleProposalListQuerySchema };
type LifecycleProposalReviewSchemas = {
  params: typeof idParamsSchema;
  body: typeof lifecycleProposalReviewBodySchema;
};

router.get(
  "/portal-lifecycle-proposals",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ query: lifecycleProposalListQuerySchema }),
  async (req, res): Promise<void> => {
    const { status, limit } = getValidated<LifecycleProposalListSchemas>(req).query;
    const rows = await db
      .select({
        id: portalLifecycleProposalsTable.id,
        submissionId: portalLifecycleProposalsTable.submissionId,
        applicationId: portalLifecycleProposalsTable.applicationId,
        observationId: portalLifecycleProposalsTable.observationId,
        rawStatus: portalLifecycleProposalsTable.rawStatus,
        currentStage: portalLifecycleProposalsTable.currentStage,
        decision: portalLifecycleProposalsTable.decision,
        artifacts: portalLifecycleProposalsTable.artifacts,
        missingDocuments: portalLifecycleProposalsTable.missingDocuments,
        applicationReferenceSync: portalLifecycleProposalsTable.applicationReferenceSync,
        status: portalLifecycleProposalsTable.status,
        reviewedBy: portalLifecycleProposalsTable.reviewedBy,
        reviewedAt: portalLifecycleProposalsTable.reviewedAt,
        createdAt: portalLifecycleProposalsTable.createdAt,
      })
      .from(portalLifecycleProposalsTable)
      .where(status ? eq(portalLifecycleProposalsTable.status, status) : undefined)
      .orderBy(desc(portalLifecycleProposalsTable.createdAt), desc(portalLifecycleProposalsTable.id))
      .limit(limit);
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ items: rows });
  },
);

router.post(
  "/portal-lifecycle-proposals/:id/review",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ params: idParamsSchema, body: lifecycleProposalReviewBodySchema }),
  async (req, res): Promise<void> => {
    const { id } = getValidated<LifecycleProposalReviewSchemas>(req).params;
    const body = getValidated<LifecycleProposalReviewSchemas>(req).body;
    const requestKey = body.requestKey;
    const reason = body.reason?.trim() || null;
    const reviewerId = req.user!.id;
    const evidenceSha256 = createHash("sha256")
      .update(JSON.stringify({ id, reviewerId, decision: body.decision, reason, requestKey }))
      .digest("hex");

    const result = await db.transaction(async (tx) => {
      const [proposal] = await tx
        .select({
          id: portalLifecycleProposalsTable.id,
          status: portalLifecycleProposalsTable.status,
          proposedByUserId: portalLifecycleProposalsTable.proposedByUserId,
        })
        .from(portalLifecycleProposalsTable)
        .where(eq(portalLifecycleProposalsTable.id, id))
        .for("update")
        .limit(1);
      if (!proposal) return { kind: "not_found" as const };
      const [existingReview] = await tx
        .select({
          evidenceSha256: portalLifecycleProposalReviewsTable.evidenceSha256,
          decision: portalLifecycleProposalReviewsTable.decision,
        })
        .from(portalLifecycleProposalReviewsTable)
        .where(eq(portalLifecycleProposalReviewsTable.proposalId, id))
        .limit(1);
      if (existingReview) {
        return existingReview.evidenceSha256 === evidenceSha256
          ? { kind: "replay" as const, decision: existingReview.decision }
          : { kind: "conflict" as const };
      }
      if (proposal.status !== "pending_review") return { kind: "conflict" as const };
      if (proposal.proposedByUserId === reviewerId) return { kind: "maker_checker" as const };

      await tx.insert(portalLifecycleProposalReviewsTable).values({
        proposalId: id,
        reviewerId,
        decision: body.decision,
        reason,
        requestKey,
        evidenceSha256,
      });
      await tx
        .update(portalLifecycleProposalsTable)
        .set({
          status: body.decision === "approve" ? "approved" : "rejected",
          reviewedBy: reviewerId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(
          eq(portalLifecycleProposalsTable.id, id),
          eq(portalLifecycleProposalsTable.status, "pending_review"),
        ));
      return { kind: "reviewed" as const, decision: body.decision };
    });

    if (result.kind === "not_found") {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }
    if (result.kind === "maker_checker") {
      res.status(409).json({ error: "MAKER_CHECKER_REQUIRED" });
      return;
    }
    if (result.kind === "conflict") {
      res.status(409).json({ error: "PROPOSAL_ALREADY_REVIEWED" });
      return;
    }
    let executionQueued = false;
    let executionJobId: number | undefined;
    let executionReason: string | undefined;
    if (result.decision === "approve") {
      try {
        const queued = await enqueueApprovedPortalLifecycleProposal(id);
        executionQueued = queued.queued;
        executionJobId = queued.jobId;
        executionReason = queued.reason;
      } catch (error) {
        executionReason = error instanceof PortalWorkerUnavailableError
          ? error.code
          : "LIFECYCLE_EXECUTION_ENQUEUE_FAILED";
      }
    }
    await logAudit(
      reviewerId,
      "review_portal_lifecycle_proposal",
      "portal_lifecycle_proposal",
      id,
      {
        decision: result.decision,
        replay: result.kind === "replay",
        requestKey,
        executionQueued,
        executionJobId,
        executionReason,
      },
      req.ip,
    );
    res.json({
      proposalId: id,
      decision: result.decision,
      replay: result.kind === "replay",
      executionQueued,
      ...(executionJobId ? { executionJobId } : {}),
      ...(executionReason ? { executionReason } : {}),
    });
  },
);

router.get(
  "/portal-automation/operations",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (_req, res): Promise<void> => {
    const [summaryResult, lanesResult, observationsResult, suspendedResult] =
      await Promise.all([
        db.execute<{
          tracked: number;
          due: number;
          checking: number;
          retrying: number;
          suspended: number;
          observations24h: number;
          unverified24h: number;
          missingDocuments24h: number;
          decisions24h: number;
          pendingReviews: number;
        }>(sql`
          SELECT
            count(*) FILTER (WHERE submission.status = 'submitted' AND submission.external_ref IS NOT NULL AND btrim(submission.external_ref) <> '')::int AS tracked,
            count(*) FILTER (WHERE submission.status = 'submitted' AND submission.external_ref IS NOT NULL AND btrim(submission.external_ref) <> '' AND submission.status_check_suspended_at IS NULL AND submission.status_check_next_at <= now())::int AS due,
            count(*) FILTER (WHERE submission.status = 'submitted' AND submission.external_ref IS NOT NULL AND btrim(submission.external_ref) <> '' AND submission.status_check_locked_at IS NOT NULL)::int AS checking,
            count(*) FILTER (WHERE submission.status = 'submitted' AND submission.external_ref IS NOT NULL AND btrim(submission.external_ref) <> '' AND submission.status_check_attempts > 0 AND submission.status_check_suspended_at IS NULL)::int AS retrying,
            count(*) FILTER (WHERE submission.status = 'submitted' AND submission.external_ref IS NOT NULL AND btrim(submission.external_ref) <> '' AND submission.status_check_suspended_at IS NOT NULL)::int AS suspended,
            (SELECT count(*)::int FROM portal_lifecycle_observations observation WHERE observation.observed_at >= now() - interval '24 hours') AS "observations24h",
            (SELECT count(*)::int FROM portal_lifecycle_observations observation WHERE observation.observed_at >= now() - interval '24 hours' AND NOT observation.identity_verified) AS "unverified24h",
            (SELECT count(*)::int FROM portal_lifecycle_observations observation WHERE observation.observed_at >= now() - interval '24 hours' AND observation.disposition = 'MISSING_DOCUMENT') AS "missingDocuments24h",
            (SELECT count(*)::int FROM portal_lifecycle_observations observation WHERE observation.observed_at >= now() - interval '24 hours' AND observation.disposition IN ('CONDITIONAL_OFFER', 'UNCONDITIONAL_OFFER', 'FINAL_ACCEPTANCE', 'REJECTED')) AS "decisions24h",
            (SELECT count(*)::int FROM portal_lifecycle_proposals proposal WHERE proposal.status = 'pending_review') AS "pendingReviews"
          FROM portal_submissions submission
          WHERE submission.deleted_at IS NULL
        `),
        db.execute<{
          laneKey: string;
          adapterKey: string;
          universityKey: string;
          tracked: number;
          due: number;
          checking: number;
          retrying: number;
          suspended: number;
          oldestDue: Date | null;
          lastCheckedAt: Date | null;
        }>(sql`
          SELECT
            lower(submission.adapter_key) || ':' || lower(submission.university_key) AS "laneKey",
            lower(submission.adapter_key) AS "adapterKey",
            lower(submission.university_key) AS "universityKey",
            count(*)::int AS tracked,
            count(*) FILTER (WHERE submission.status_check_suspended_at IS NULL AND submission.status_check_next_at <= now())::int AS due,
            count(*) FILTER (WHERE submission.status_check_locked_at IS NOT NULL)::int AS checking,
            count(*) FILTER (WHERE submission.status_check_attempts > 0 AND submission.status_check_suspended_at IS NULL)::int AS retrying,
            count(*) FILTER (WHERE submission.status_check_suspended_at IS NOT NULL)::int AS suspended,
            min(submission.status_check_next_at) FILTER (WHERE submission.status_check_suspended_at IS NULL AND submission.status_check_next_at <= now()) AS "oldestDue",
            max(submission.status_check_last_at) AS "lastCheckedAt"
          FROM portal_submissions submission
          WHERE submission.status = 'submitted'
            AND submission.deleted_at IS NULL
            AND submission.external_ref IS NOT NULL
            AND btrim(submission.external_ref) <> ''
            AND submission.adapter_key IS NOT NULL
            AND btrim(submission.adapter_key) <> ''
          GROUP BY lower(submission.adapter_key), lower(submission.university_key)
          ORDER BY suspended DESC, due DESC, "oldestDue" ASC NULLS LAST
          LIMIT 100
        `),
        db.execute<{
          id: number;
          submissionId: number;
          applicationId: number;
          adapterKey: string;
          universityKey: string;
          disposition: string;
          identityVerified: boolean;
          missingDocumentCount: number;
          observedAt: Date;
        }>(sql`
          SELECT
            observation.id,
            observation.submission_id AS "submissionId",
            observation.application_id AS "applicationId",
            observation.adapter_key AS "adapterKey",
            submission.university_key AS "universityKey",
            observation.disposition,
            observation.identity_verified AS "identityVerified",
            jsonb_array_length(observation.missing_documents)::int AS "missingDocumentCount",
            observation.observed_at AS "observedAt"
          FROM portal_lifecycle_observations observation
          JOIN portal_submissions submission ON submission.id = observation.submission_id
          ORDER BY observation.observed_at DESC, observation.id DESC
          LIMIT 50
        `),
        db.execute<{
          submissionId: number;
          applicationId: number;
          adapterKey: string;
          universityKey: string;
          attempts: number;
          suspendedAt: Date;
          errorCategory: string;
        }>(sql`
          SELECT
            submission.id AS "submissionId",
            submission.application_id AS "applicationId",
            submission.adapter_key AS "adapterKey",
            submission.university_key AS "universityKey",
            submission.status_check_attempts AS attempts,
            submission.status_check_suspended_at AS "suspendedAt",
            CASE
              WHEN submission.status_check_error = 'STATUS_CHECK_UNSUPPORTED' THEN 'unsupported'
              WHEN submission.status_check_error = 'STATUS_CHECK_TIMEOUT' THEN 'timeout'
              WHEN submission.status_check_error = 'STATUS_CHECK_AUTHENTICATION' THEN 'authentication'
              WHEN submission.status_check_error = 'STATUS_CHECK_PORTAL_DRIFT' THEN 'portal_drift'
              WHEN submission.status_check_error = 'STATUS_CHECK_NETWORK' THEN 'network'
              WHEN submission.status_check_error = 'STATUS_CHECK_LEASE_LOST' THEN 'lease_lost'
              WHEN submission.status_check_error = 'STATUS_CHECK_ARTIFACT' THEN 'artifact'
              ELSE 'other'
            END AS "errorCategory"
          FROM portal_submissions submission
          WHERE submission.status_check_suspended_at IS NOT NULL
            AND submission.deleted_at IS NULL
          ORDER BY submission.status_check_suspended_at DESC
          LIMIT 50
        `),
      ]);

    res.setHeader("Cache-Control", "private, no-store");
    res.json({
      summary: summaryResult.rows[0] ?? {
        tracked: 0,
        due: 0,
        checking: 0,
        retrying: 0,
        suspended: 0,
        observations24h: 0,
        unverified24h: 0,
        missingDocuments24h: 0,
        decisions24h: 0,
        pendingReviews: 0,
      },
      lanes: lanesResult.rows,
      recentObservations: observationsResult.rows,
      suspended: suspendedResult.rows,
      generatedAt: new Date().toISOString(),
    });
  },
);

router.post(
  "/portal-automation/status-sync/run",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const requestKey = `manual:${randomUUID()}`;
    try {
      const job = await enqueuePortalWorkerJob({
        kind: "status_sweep",
        portalUniversityId: null,
        requestKey,
        requestedBy: req.user!.id,
      });
      await logAudit(
        req.user!.id,
        "queue_portal_status_sync",
        "portal_submission",
        undefined,
        { workerJobId: job.id, requestKey, replay: job.replay },
        req.ip,
      );
      res.status(202).json({
        accepted: true,
        jobId: job.id,
        requestKey,
        replay: job.replay,
        statusUrl: job.statusUrl,
      });
    } catch (error) {
      if (error instanceof PortalWorkerJobIdempotencyConflictError) {
        res.status(409).json({ accepted: false, error: "PORTAL_WORKER_JOB_IDEMPOTENCY_CONFLICT" });
        return;
      }
      if (error instanceof PortalWorkerUnavailableError) {
        res.status(503).json({ accepted: false, error: error.code });
        return;
      }
      throw error;
    }
  },
);

router.post(
  "/portal-submissions/:id/status-check/resume",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ params: idParamsSchema }),
  async (req, res): Promise<void> => {
    const { id } = getValidated<IdSchemas>(req).params;
    const [submission] = await db
      .update(portalSubmissionsTable)
      .set({
        statusCheckAttempts: 0,
        statusCheckNextAt: new Date(),
        statusCheckError: null,
        statusCheckLockedAt: null,
        statusCheckLockedBy: null,
        statusCheckSuspendedAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(portalSubmissionsTable.id, id),
          eq(portalSubmissionsTable.status, "submitted"),
          isNull(portalSubmissionsTable.deletedAt),
          isNotNull(portalSubmissionsTable.statusCheckSuspendedAt),
        ),
      )
      .returning({ id: portalSubmissionsTable.id });
    if (!submission) {
      res.status(409).json({ error: "STATUS_CHECK_NOT_SUSPENDED" });
      return;
    }
    await logAudit(
      req.user!.id,
      "resume_portal_status_check",
      "portal_submission",
      id,
      { resetAttempts: true },
      req.ip,
    );
    res.json({ resumed: true, submissionId: id });
  },
);

/**
 * Starts the periodic distributed status-sync sweep. Call once per API
 * instance; database leases make overlapping instances safe.
 */
let portalStatusSyncTimer: ReturnType<typeof setInterval> | null = null;

export function startPortalStatusSync(intervalMs = 10 * 60_000): () => void {
  if (portalStatusSyncTimer) return stopPortalStatusSync;
  const run = (): void => {
    runPortalStatusSync().catch((err) => {
      console.error(`[portal-status-sync] Sweep error: ${classifyPortalStatusFailure(err)}`);
    });
  };
  portalStatusSyncTimer = setInterval(run, intervalMs);
  console.log(`[portal-status-sync] Started — interval=${intervalMs}ms`);
  return stopPortalStatusSync;
}

export function stopPortalStatusSync(): void {
  if (portalStatusSyncTimer) clearInterval(portalStatusSyncTimer);
  portalStatusSyncTimer = null;
}

// ===========================================================================
// PROGRAM EŞLEME (FAZ 1) — LIVE program options + CRM→portal program mapping
// ===========================================================================

/** Program option cache TTL — entries older than this are refetched. */
const PROGRAM_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Resolves an active (non-deleted) portal_universities row by universityKey.
 * Returns null when the key is unknown — callers respond 404.
 */
async function getPortalUniversity(
  universityKey: string,
): Promise<typeof portalUniversitiesTable.$inferSelect | null> {
  const [uni] = await db
    .select()
    .from(portalUniversitiesTable)
    .where(
      and(
        eq(portalUniversitiesTable.universityKey, universityKey),
        isNull(portalUniversitiesTable.deletedAt),
      ),
    )
    .limit(1);
  return uni ?? null;
}

const uniKeyParamsSchema = z.object({ key: z.string().min(1) });
type UniKeyParams = { params: typeof uniKeyParamsSchema };

// ---------------------------------------------------------------------------
// GET /portal-automation/universities/:key/program-options?level=&refresh=0|1
//
// Returns the portal's LIVE program option list ({ v, t }[]). Served from the
// portal_program_cache table; on cache miss / stale (>TTL) / refresh=1 the
// adapter is driven headless to fetch fresh options, which are then cached.
// ---------------------------------------------------------------------------
const programOptionsQuerySchema = z.object({
  level: z.string().optional(),
  refresh: z.coerce.number().int().optional(),
});
type ProgramOptionsSchemas = {
  params: typeof uniKeyParamsSchema;
  query: typeof programOptionsQuerySchema;
};

router.get(
  "/portal-automation/universities/:key/program-options",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ params: uniKeyParamsSchema, query: programOptionsQuerySchema }),
  async (req, res): Promise<void> => {
    const { key } = getValidated<ProgramOptionsSchemas>(req).params;
    const { level: levelRaw, refresh } = getValidated<ProgramOptionsSchemas>(req).query;
    const level = (levelRaw ?? "").trim();
    const forceRefresh = refresh === 1;

    const uni = await getPortalUniversity(key);
    if (!uni) {
      res.status(404).json({ error: "UNIVERSITY_NOT_FOUND" });
      return;
    }

    // Cache read (keyed by universityKey + normalized level).
    const [cached] = await db
      .select()
      .from(portalProgramCacheTable)
      .where(
        and(
          eq(portalProgramCacheTable.universityKey, key),
          eq(portalProgramCacheTable.level, level),
        ),
      )
      .limit(1);

    const isStale =
      !cached || Date.now() - cached.fetchedAt.getTime() > PROGRAM_CACHE_TTL_MS;

    if (cached && !isStale && !forceRefresh) {
      res.json({
        options: cached.options,
        cached: true,
        stale: false,
        fetchedAt: cached.fetchedAt,
      });
      return;
    }

    try {
      const levelFingerprint = createHash("sha256").update(level).digest("hex").slice(0, 12);
      const requestKey = `program:${uni.id}:${levelFingerprint}:${Math.floor(Date.now() / 60_000)}`;
      const job = await enqueuePortalWorkerJob({
        kind: "program_catalog_sync",
        portalUniversityId: uni.id,
        requestKey,
        requestedBy: req.user!.id,
        payload: { level },
      });
      res.status(202).json({
        options: cached?.options ?? [],
        cached: Boolean(cached),
        stale: true,
        fetchedAt: cached?.fetchedAt ?? null,
        refreshAccepted: true,
        jobId: job.id,
        statusUrl: job.statusUrl,
        replay: job.replay,
      });
    } catch (error) {
      if (error instanceof PortalWorkerJobIdempotencyConflictError) {
        res.status(409).json({ error: "PORTAL_WORKER_JOB_IDEMPOTENCY_CONFLICT" });
        return;
      }
      if (error instanceof PortalWorkerUnavailableError) {
        res.status(503).json({ error: error.code });
        return;
      }
      throw error;
    }
  },
);

// ---------------------------------------------------------------------------
// GET /portal-automation/universities/:key/mapping
// Returns the CRM→portal program mapping data for the university.
// ---------------------------------------------------------------------------
router.get(
  "/portal-automation/universities/:key/mapping",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ params: uniKeyParamsSchema }),
  async (req, res): Promise<void> => {
    const { key } = getValidated<UniKeyParams>(req).params;

    const uni = await getPortalUniversity(key);
    if (!uni) {
      res.status(404).json({ error: "UNIVERSITY_NOT_FOUND" });
      return;
    }

    const [row] = await db
      .select()
      .from(portalProgramMappingTable)
      .where(eq(portalProgramMappingTable.universityKey, key))
      .limit(1);

    res.json({
      universityKey: key,
      programOverrides: row?.programOverrides ?? {},
      synonyms: row?.synonyms ?? [],
      countryOverrides: row?.countryOverrides ?? {},
      updatedAt: row?.updatedAt ?? null,
    });
  },
);

// ---------------------------------------------------------------------------
// PUT /portal-automation/universities/:key/mapping
// Replaces the program_overrides object wholesale. Other mapping columns
// (synonyms, country_overrides) are left untouched. Audited.
// ---------------------------------------------------------------------------
const putMappingBodySchema = z.object({
  programOverrides: z.record(z.string()),
});
type PutMappingSchemas = {
  params: typeof uniKeyParamsSchema;
  body: typeof putMappingBodySchema;
};

router.put(
  "/portal-automation/universities/:key/mapping",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ params: uniKeyParamsSchema, body: putMappingBodySchema }),
  async (req, res): Promise<void> => {
    const { key } = getValidated<PutMappingSchemas>(req).params;
    const { programOverrides } = getValidated<PutMappingSchemas>(req).body;
    const user = req.user!;

    const uni = await getPortalUniversity(key);
    if (!uni) {
      res.status(404).json({ error: "UNIVERSITY_NOT_FOUND" });
      return;
    }

    const [existing] = await db
      .select()
      .from(portalProgramMappingTable)
      .where(eq(portalProgramMappingTable.universityKey, key))
      .limit(1);

    let row;
    if (existing) {
      [row] = await db
        .update(portalProgramMappingTable)
        .set({ programOverrides, updatedAt: new Date() })
        .where(eq(portalProgramMappingTable.id, existing.id))
        .returning();
    } else {
      [row] = await db
        .insert(portalProgramMappingTable)
        .values({ universityKey: key, programOverrides })
        .returning();
    }

    logAudit(
      user.id,
      "update_portal_program_mapping",
      "portal_program_mapping",
      row.id,
      { universityKey: key, programOverrides: Object.keys(programOverrides).length },
      req.ip,
    );

    res.json({
      universityKey: key,
      programOverrides: row.programOverrides,
      synonyms: row.synonyms,
      countryOverrides: row.countryOverrides,
      updatedAt: row.updatedAt,
    });
  },
);

// ===========================================================================
// PROGRAM EŞLEME (FAZ 2) — Bulk Excel template export + import
// ===========================================================================

/**
 * Folds a value for tolerant matching: lowercase, Turkish letters → ASCII,
 * strip diacritics, drop everything except [a-z0-9]. Mirrors the matcher's
 * intent (override resolves by exact option value OR folded option text).
 */
function foldProgramValue(s: string): string {
  return s
    .toLowerCase()
    .replace(/ı/g, "i")
    .replace(/i̇/g, "i")
    .replace(/ş/g, "s")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/** Resolves the CRM university id for a portal university (id, then name). */
async function resolveCrmUniversityId(
  uni: typeof portalUniversitiesTable.$inferSelect,
): Promise<number | null> {
  if (uni.crmUniversityId != null) return uni.crmUniversityId;
  const [u] = await db
    .select({ id: universitiesTable.id })
    .from(universitiesTable)
    .where(sql`LOWER(${universitiesTable.name}) = LOWER(${uni.universityName})`)
    .limit(1);
  return u?.id ?? null;
}

/**
 * Loads the deduped LIVE portal option list for a university from the Faz-1
 * cache (all cached levels merged). No headless fetch in the request path —
 * the cache is populated by the program-options endpoint.
 */
async function loadCachedPortalOptions(
  universityKey: string,
): Promise<Array<{ v: string; t: string }>> {
  const rows = await db
    .select({ options: portalProgramCacheTable.options })
    .from(portalProgramCacheTable)
    .where(eq(portalProgramCacheTable.universityKey, universityKey));
  const seen = new Set<string>();
  const out: Array<{ v: string; t: string }> = [];
  for (const r of rows) {
    for (const o of (r.options ?? []) as Array<{ v: unknown; t: unknown }>) {
      const v = String(o.v ?? "");
      if (!v || seen.has(v)) continue;
      seen.add(v);
      out.push({ v, t: String(o.t ?? "") });
    }
  }
  return out;
}

/** Suggests a live portal option for a CRM program name (exact fold, then substring). */
function suggestPortalHint(
  programName: string,
  options: Array<{ v: string; t: string }>,
): string {
  if (options.length === 0) return "";
  const folded = foldProgramValue(programName);
  if (!folded) return "";
  const exact = options.find((o) => foldProgramValue(o.t) === folded);
  const hit =
    exact ??
    options.find((o) => {
      const ft = foldProgramValue(o.t);
      return ft.includes(folded) || folded.includes(ft);
    });
  return hit ? `${hit.t} (${hit.v})` : "";
}

// ---------------------------------------------------------------------------
// GET /portal-automation/universities/:key/program-template.xlsx
// Per-university bulk program-mapping template: one row per CRM program with
// id + name + the current override (if any) + a live portal option hint, plus
// an empty portal_value column to fill in. Optionally includes a read-only
// "PortalOptions" reference sheet listing every live portal option.
// ---------------------------------------------------------------------------
router.get(
  "/portal-automation/universities/:key/program-template.xlsx",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ params: uniKeyParamsSchema }),
  async (req, res): Promise<void> => {
    const { key } = getValidated<UniKeyParams>(req).params;

    const uni = await getPortalUniversity(key);
    if (!uni) {
      res.status(404).json({ error: "UNIVERSITY_NOT_FOUND" });
      return;
    }

    const crmUniversityId = await resolveCrmUniversityId(uni);
    const programs = crmUniversityId
      ? await db
          .select({ id: programsTable.id, name: programsTable.name })
          .from(programsTable)
          .where(eq(programsTable.universityId, crmUniversityId))
          .orderBy(asc(programsTable.name))
      : [];

    const [mappingRow] = await db
      .select({ programOverrides: portalProgramMappingTable.programOverrides })
      .from(portalProgramMappingTable)
      .where(eq(portalProgramMappingTable.universityKey, key))
      .limit(1);
    const overrides = mappingRow?.programOverrides ?? {};

    const options = await loadCachedPortalOptions(key);

    const rows = programs.map((p) => {
      const id = String(p.id);
      return {
        crm_program_id: id,
        crm_program_name: p.name,
        current_portal_value: overrides[id] ?? "",
        portal_value: "",
        portal_option_hint: suggestPortalHint(p.name, options),
      };
    });

    const sheets: WorkbookSpec["sheets"] = [
      { name: PROGRAM_MAPPING_SHEET, columns: programMappingColumns, rows },
    ];
    if (options.length > 0) {
      sheets.push({
        name: "PortalOptions",
        columns: [
          { key: "v", header: "portal_value", kind: "string" as const, width: 28 },
          { key: "t", header: "portal_label", kind: "string" as const, width: 44 },
        ],
        rows: options.map((o) => ({ v: o.v, t: o.t })),
      });
    }

    const buf = await buildWorkbookBuffer({
      sheets,
      meta: {
        kind: PROGRAM_MAPPING_KIND,
        version: "1",
        universityKey: key,
        exportedAt: new Date().toISOString(),
      },
    });

    res.setHeader("Content-Type", XLSX_CONTENT_TYPE);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${key}-program-mapping-template.xlsx"`,
    );
    res.send(buf);
  },
);

// ---------------------------------------------------------------------------
// POST /portal-automation/universities/:key/program-import  (raw .xlsx body)
// Reads the filled template; skips empty portal_value rows; validates the rest
// against the LIVE portal option list (cache); UPSERTS valid rows into
// program_overrides (merge, never deletes). Returns { applied, skipped, errors }.
// ---------------------------------------------------------------------------
router.post(
  "/portal-automation/universities/:key/program-import",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  raw({ type: XLSX_CONTENT_TYPE, limit: "2mb" }),
  validate({ params: uniKeyParamsSchema }),
  async (req, res): Promise<void> => {
    const { key } = getValidated<UniKeyParams>(req).params;
    const user = req.user!;

    const uni = await getPortalUniversity(key);
    if (!uni) {
      res.status(404).json({ error: "UNIVERSITY_NOT_FOUND" });
      return;
    }

    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({
        error: "Upload an .xlsx file with Content-Type " + XLSX_CONTENT_TYPE,
      });
      return;
    }

    let parsed;
    try {
      parsed = await parseWorkbookBuffer(
        req.body,
        { expectedKind: PROGRAM_MAPPING_KIND },
        { [PROGRAM_MAPPING_SHEET]: programMappingColumns },
      );
    } catch (err) {
      const e = err as ImportValidationError;
      res.status(e.status || 400).json({ error: e.message });
      return;
    }

    const options = await loadCachedPortalOptions(key);
    if (options.length === 0) {
      res.status(400).json({
        error: "NO_LIVE_OPTIONS",
        message:
          "No live portal options cached for this university. Open Program Mapping and refresh the live options first.",
      });
      return;
    }

    const validValues = new Set(options.map((o) => o.v));
    // Map a folded label → canonical option value, so a label match is stored
    // as the portal `v` (keeps the "CRM id → portal value" contract intact).
    const foldedToValue = new Map<string, string>();
    for (const o of options) {
      const f = foldProgramValue(o.t);
      if (f && !foldedToValue.has(f)) foldedToValue.set(f, o.v);
    }

    const rawRows = parsed.sheets.get(PROGRAM_MAPPING_SHEET)?.rows ?? [];
    const errors: Array<{ row: number; reason: string }> = [];
    const toApply: Record<string, string> = {};
    let applied = 0;
    let skipped = 0;

    rawRows.forEach((r, i) => {
      const rowNo = i + 2; // +1 header, +1 to 1-base
      const id = String(r.crm_program_id ?? "").trim();
      const value = String(r.portal_value ?? "").trim();
      if (!value) {
        skipped++;
        return;
      }
      if (!id) {
        errors.push({ row: rowNo, reason: "MISSING_CRM_ID" });
        return;
      }
      // Resolve to the canonical portal `v`: exact value wins, else a folded
      // label match maps to its option value.
      const canonical = validValues.has(value)
        ? value
        : foldedToValue.get(foldProgramValue(value));
      if (!canonical) {
        errors.push({ row: rowNo, reason: "INVALID_PORTAL_VALUE" });
        return;
      }
      if (!(id in toApply)) applied++;
      toApply[id] = canonical;
    });

    // Resolve the applied CRM ids → program names so we can ALSO write the
    // name-based mappings { portalValue → crmProgramName } that the matcher now
    // consumes. programOverrides is kept in lockstep as a historical column.
    const appliedIds = [...new Set(Object.keys(toApply).map(Number))].filter(
      (n) => Number.isInteger(n) && n > 0,
    );
    const idToName = new Map<number, string>();
    if (appliedIds.length > 0) {
      const progs = await db
        .select({ id: programsTable.id, name: programsTable.name })
        .from(programsTable)
        .where(inArray(programsTable.id, appliedIds));
      for (const p of progs) idToName.set(p.id, p.name);
    }
    const nameToApply: Record<string, string> = {};
    for (const [idStr, portalValue] of Object.entries(toApply)) {
      const crmName = idToName.get(Number(idStr));
      if (crmName) nameToApply[portalValue] = crmName;
    }

    let rowId = 0;
    if (Object.keys(toApply).length > 0) {
      const [existing] = await db
        .select()
        .from(portalProgramMappingTable)
        .where(eq(portalProgramMappingTable.universityKey, key))
        .limit(1);
      const merged = { ...(existing?.programOverrides ?? {}), ...toApply };
      const mergedNames = { ...(existing?.mappings ?? {}), ...nameToApply };
      if (existing) {
        const [row] = await db
          .update(portalProgramMappingTable)
          .set({ programOverrides: merged, mappings: mergedNames, updatedAt: new Date() })
          .where(eq(portalProgramMappingTable.id, existing.id))
          .returning({ id: portalProgramMappingTable.id });
        rowId = row.id;
      } else {
        const [row] = await db
          .insert(portalProgramMappingTable)
          .values({ universityKey: key, programOverrides: merged, mappings: mergedNames })
          .returning({ id: portalProgramMappingTable.id });
        rowId = row.id;
      }
    }

    await logAudit(
      user.id,
      "portal.mapping.import",
      "portal_program_mapping",
      rowId,
      { universityKey: key, applied, skipped, errors: errors.length },
      req.ip,
    );

    res.json({ applied, skipped, errors });
  },
);

// ---------------------------------------------------------------------------
// GET /portal-automation/multi-portals
//
// Lists every multi-portal company (is_multi_portal=true) together with its
// member universities (rows whose routes_via points at the company's key).
// ---------------------------------------------------------------------------
router.get(
  "/portal-automation/multi-portals",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (_req, res): Promise<void> => {
    const portals = await db
      .select({
        universityKey: portalUniversitiesTable.universityKey,
        universityName: portalUniversitiesTable.universityName,
        adapterKey: portalUniversitiesTable.adapterKey,
        isActive: portalUniversitiesTable.isActive,
      })
      .from(portalUniversitiesTable)
      .where(
        and(
          eq(portalUniversitiesTable.isMultiPortal, true),
          isNull(portalUniversitiesTable.deletedAt),
        ),
      )
      .orderBy(asc(portalUniversitiesTable.universityName));

    const portalKeys = portals.map((p) => p.universityKey);
    const memberRows =
      portalKeys.length > 0
        ? await db
            .select({
              universityKey: portalUniversitiesTable.universityKey,
              universityName: portalUniversitiesTable.universityName,
              adapterKey: portalUniversitiesTable.adapterKey,
              routesVia: portalUniversitiesTable.routesVia,
            })
            .from(portalUniversitiesTable)
            .where(
              and(
                inArray(portalUniversitiesTable.routesVia, portalKeys),
                isNull(portalUniversitiesTable.deletedAt),
              ),
            )
            .orderBy(asc(portalUniversitiesTable.universityName))
        : [];

    const data = portals.map((p) => ({
      ...p,
      members: memberRows
        .filter((m) => m.routesVia === p.universityKey)
        .map((m) => ({
          universityKey: m.universityKey,
          universityName: m.universityName,
          adapterKey: m.adapterKey,
        })),
    }));

    res.json({ data });
  },
);

// ---------------------------------------------------------------------------
// PUT /portal-automation/multi-portals/:key/members
//
// Sets the full member list for a multi-portal company. Selected universities
// get routes_via=:key; universities previously routed here but omitted are
// reset to NULL (own adapter). Routing assignment does NOT enable auto-process.
// ---------------------------------------------------------------------------
const putMembersBodySchema = z.object({
  universityKeys: z.array(z.string().min(1)).max(1000),
});
type PutMembersSchemas = {
  params: typeof uniKeyParamsSchema;
  body: typeof putMembersBodySchema;
};

router.put(
  "/portal-automation/multi-portals/:key/members",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ params: uniKeyParamsSchema, body: putMembersBodySchema }),
  async (req, res): Promise<void> => {
    const { key } = getValidated<PutMembersSchemas>(req).params;
    const { universityKeys } = getValidated<PutMembersSchemas>(req).body;
    const user = req.user!;

    const portal = await getPortalUniversity(key);
    if (!portal) {
      res.status(404).json({ error: "PORTAL_NOT_FOUND" });
      return;
    }
    if (!portal.isMultiPortal) {
      res.status(400).json({
        error: "NOT_MULTI_PORTAL",
        message: `'${key}' is not a multi-portal company`,
      });
      return;
    }

    const requested = Array.from(new Set(universityKeys));

    if (requested.includes(key)) {
      res.status(400).json({
        error: "INVALID_MEMBER",
        message: "A multi-portal company cannot be its own member",
      });
      return;
    }

    if (requested.length > 0) {
      const rows = await db
        .select({
          universityKey: portalUniversitiesTable.universityKey,
          isMultiPortal: portalUniversitiesTable.isMultiPortal,
          routesVia: portalUniversitiesTable.routesVia,
        })
        .from(portalUniversitiesTable)
        .where(
          and(
            inArray(portalUniversitiesTable.universityKey, requested),
            isNull(portalUniversitiesTable.deletedAt),
          ),
        );

      const foundKeys = new Set(rows.map((r) => r.universityKey));
      const missing = requested.filter((k) => !foundKeys.has(k));
      if (missing.length > 0) {
        res.status(404).json({
          error: "MEMBER_NOT_FOUND",
          message: `Unknown university key(s): ${missing.join(", ")}`,
        });
        return;
      }

      const portalsAmongMembers = rows
        .filter((r) => r.isMultiPortal)
        .map((r) => r.universityKey);
      if (portalsAmongMembers.length > 0) {
        res.status(400).json({
          error: "INVALID_MEMBER",
          message: `Cannot route a multi-portal company through another: ${portalsAmongMembers.join(", ")}`,
        });
        return;
      }

      // Double-assign block: a university already routed to a DIFFERENT portal.
      const conflicts = rows
        .filter((r) => r.routesVia && r.routesVia !== key)
        .map((r) => r.universityKey);
      if (conflicts.length > 0) {
        res.status(409).json({
          error: "ALREADY_ASSIGNED",
          message: `Already assigned to another multi-portal: ${conflicts.join(", ")}`,
        });
        return;
      }
    }

    await db.transaction(async (tx) => {
      await resetAdapterExecutionStateTx(tx, portal.adapterKey);
      // Detach removed members (previously routed here, now omitted).
      const clearCondition =
        requested.length > 0
          ? and(
              eq(portalUniversitiesTable.routesVia, key),
              notInArray(portalUniversitiesTable.universityKey, requested),
              isNull(portalUniversitiesTable.deletedAt),
            )
          : and(
              eq(portalUniversitiesTable.routesVia, key),
              isNull(portalUniversitiesTable.deletedAt),
            );
      await tx
        .update(portalUniversitiesTable)
        .set({ routesVia: null, updatedAt: new Date() })
        .where(clearCondition);

      // Attach selected members. Note: only routes_via changes — auto_process
      // is intentionally left untouched so routing never enables auto-process.
      if (requested.length > 0) {
        await tx
          .update(portalUniversitiesTable)
          .set({ routesVia: key, updatedAt: new Date() })
          .where(
            and(
              inArray(portalUniversitiesTable.universityKey, requested),
              isNull(portalUniversitiesTable.deletedAt),
            ),
          );
      }
    });

    logAudit(
      user.id,
      "portal.routing.update",
      "portal_university",
      portal.id,
      { portalKey: key, universityKeys: requested },
      req.ip,
    );

    const members = await db
      .select({
        universityKey: portalUniversitiesTable.universityKey,
        universityName: portalUniversitiesTable.universityName,
        adapterKey: portalUniversitiesTable.adapterKey,
      })
      .from(portalUniversitiesTable)
      .where(
        and(
          eq(portalUniversitiesTable.routesVia, key),
          isNull(portalUniversitiesTable.deletedAt),
        ),
      )
      .orderBy(asc(portalUniversitiesTable.universityName));

    res.json({ portalKey: key, members });
  },
);

// ===========================================================================
// Phase 3 — multi-portal MEMBERSHIP (catalog-id keyed junction)
// ---------------------------------------------------------------------------
// The Phase 2 endpoints above route members by universityKey (portal_universities
// rows). Phase 3 manages members of a multi-portal ACCOUNT directly from the
// FAS-OS catalog (universities table), keyed by catalog id, via the
// portal_account_universities junction. UNIQUE(catalog_university_id) guarantees
// one school maps to at most one account; reassigning requires force.
// ===========================================================================

// ---------------------------------------------------------------------------
// GET /portal-automation/catalog-universities?q=&page=&pageSize=
// Searchable, paginated catalog list (id/name/country) for the member picker.
// Does NOT reuse /api/universities (that endpoint silently caps limit at 100).
// ---------------------------------------------------------------------------
const catalogUniversitiesQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  country: z.string().trim().max(120).optional(),
  type: z.string().trim().max(60).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});
type CatalogUniversitiesSchemas = { query: typeof catalogUniversitiesQuerySchema };

router.get(
  "/portal-automation/catalog-universities",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ query: catalogUniversitiesQuerySchema }),
  async (req, res): Promise<void> => {
    const { q, country, type, page, pageSize } = getValidated<CatalogUniversitiesSchemas>(req).query;
    const limit = pageSize ?? 20;
    const offset = ((page ?? 1) - 1) * limit;

    // Only active (non-soft-deleted) catalog universities. The filter-options
    // endpoint below applies this identical base filter, so a country/type can
    // only surface as an option when at least one matching university exists.
    const conditions = [];
    conditions.push(eq(universitiesTable.isActive, true));
    if (q) {
      // Turkish-aware, diacritic-folded substring match. Catalog names are
      // stored ASCII ("Kultur", "Gelisim") but admins type natural Turkish
      // ("Kültür", "Gelişim"), so fold ç/ğ/ı/İ/ö/ş/ü (+ common accents) and
      // lowercase BOTH sides before comparing. The query is folded in JS via
      // the shared normalizer; the column is folded in-SQL via translate() so
      // the match stays a plain case/diacritic-insensitive substring (includes).
      const foldedQuery = `%${transliterateToLatin(q).toLowerCase()}%`;
      const trFrom = "çÇğĞıİöÖşŞüÜâÂîÎûÛ";
      const trTo = "cCgGiIoOsSuUaAiIuU";
      conditions.push(
        or(
          sql`LOWER(translate(${universitiesTable.name}, ${trFrom}, ${trTo})) LIKE ${foldedQuery}`,
          sql`LOWER(translate(${universitiesTable.country}, ${trFrom}, ${trTo})) LIKE ${foldedQuery}`,
        ),
      );
    }
    if (country) conditions.push(ilike(universitiesTable.country, country));
    if (type) conditions.push(ilike(universitiesTable.universityType, type));
    const where = and(...conditions);

    const [rows, [{ total }]] = await Promise.all([
      db
        .select({
          id: universitiesTable.id,
          name: universitiesTable.name,
          country: universitiesTable.country,
          universityType: universitiesTable.universityType,
        })
        .from(universitiesTable)
        .where(where)
        .orderBy(asc(universitiesTable.name))
        .limit(limit)
        .offset(offset),
      db
        .select({ total: count() })
        .from(universitiesTable)
        .where(where),
    ]);

    res.json({
      data: rows,
      meta: buildPageMeta(total, { page: page ?? 1, limit, offset }),
    });
  },
);

// ---------------------------------------------------------------------------
// GET /portal-automation/catalog-university-filters
// Distinct non-empty country + university-type values, for the member picker's
// filter dropdowns. Keeps the picker's filter options in sync with the catalog.
// ---------------------------------------------------------------------------
router.get(
  "/portal-automation/catalog-university-filters",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (_req, res): Promise<void> => {
    const [countryRows, typeRows] = await Promise.all([
      db
        .selectDistinct({ country: universitiesTable.country })
        .from(universitiesTable)
        .where(and(
          eq(universitiesTable.isActive, true),
          isNotNull(universitiesTable.country),
          ne(universitiesTable.country, ""),
        ))
        .orderBy(asc(universitiesTable.country)),
      db
        .selectDistinct({ universityType: universitiesTable.universityType })
        .from(universitiesTable)
        .where(and(
          eq(universitiesTable.isActive, true),
          isNotNull(universitiesTable.universityType),
          ne(universitiesTable.universityType, ""),
        ))
        .orderBy(asc(universitiesTable.universityType)),
    ]);

    res.json({
      countries: countryRows.map((r) => r.country).filter((c): c is string => !!c),
      types: typeRows.map((r) => r.universityType).filter((t): t is string => !!t),
    });
  },
);

// ---------------------------------------------------------------------------
// GET /portal-automation/accounts/:key/members
// Current member universities (catalog ids) of a multi-portal account.
// ---------------------------------------------------------------------------
router.get(
  "/portal-automation/accounts/:key/members",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ params: uniKeyParamsSchema }),
  async (req, res): Promise<void> => {
    const { key } = getValidated<UniKeyParams>(req).params;

    const portal = await getPortalUniversity(key);
    if (!portal) {
      res.status(404).json({ error: "PORTAL_NOT_FOUND" });
      return;
    }
    if (!portal.isMultiPortal) {
      res.status(400).json({
        error: "NOT_MULTI_PORTAL",
        message: `'${key}' is not a multi-portal company`,
      });
      return;
    }

    const members = await db
      .select({
        catalogUniversityId: portalAccountUniversitiesTable.catalogUniversityId,
        enabled: portalAccountUniversitiesTable.enabled,
        universityName: universitiesTable.name,
        country: universitiesTable.country,
      })
      .from(portalAccountUniversitiesTable)
      .innerJoin(
        universitiesTable,
        eq(portalAccountUniversitiesTable.catalogUniversityId, universitiesTable.id),
      )
      .where(eq(portalAccountUniversitiesTable.portalKey, key))
      .orderBy(asc(universitiesTable.name));

    res.json({ portalKey: key, members });
  },
);

// ---------------------------------------------------------------------------
// PUT /portal-automation/accounts/:key/members
// Replace the account's member set with the given catalog ids. A catalog id
// already owned by a DIFFERENT account → 409 ALREADY_ASSIGNED unless force=true
// (then it is moved to this account). Members omitted from the set are removed.
// ---------------------------------------------------------------------------
const putAccountMembersBodySchema = z.object({
  catalogUniversityIds: z.array(z.number().int().positive()).max(2000),
  force: z.boolean().optional(),
});
type PutAccountMembersSchemas = {
  params: typeof uniKeyParamsSchema;
  body: typeof putAccountMembersBodySchema;
};

router.put(
  "/portal-automation/accounts/:key/members",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ params: uniKeyParamsSchema, body: putAccountMembersBodySchema }),
  async (req, res): Promise<void> => {
    const { key } = getValidated<PutAccountMembersSchemas>(req).params;
    const { catalogUniversityIds, force } = getValidated<PutAccountMembersSchemas>(req).body;
    const user = req.user!;

    const portal = await getPortalUniversity(key);
    if (!portal) {
      res.status(404).json({ error: "PORTAL_NOT_FOUND" });
      return;
    }
    if (!portal.isMultiPortal) {
      res.status(400).json({
        error: "NOT_MULTI_PORTAL",
        message: `'${key}' is not a multi-portal company`,
      });
      return;
    }

    const requested = Array.from(new Set(catalogUniversityIds));

    let conflictingPortalKeys: string[] = [];
    if (requested.length > 0) {
      // Validate every catalog id exists.
      const existing = await db
        .select({ id: universitiesTable.id, name: universitiesTable.name })
        .from(universitiesTable)
        .where(inArray(universitiesTable.id, requested));
      const foundIds = new Set(existing.map((r) => r.id));
      const missing = requested.filter((id) => !foundIds.has(id));
      if (missing.length > 0) {
        res.status(404).json({
          error: "MEMBER_NOT_FOUND",
          message: `Unknown catalog university id(s): ${missing.join(", ")}`,
        });
        return;
      }

      // Explicit direct/unsupported SIT exclusions always win over the panel's
      // dynamic Members list. Rejecting them at write time prevents a stale or
      // mistaken membership from creating doomed queue jobs later.
      if (portal.adapterKey === "sit") {
        const excluded = existing.filter((row) => isSitExcludedUniversity(row.name));
        if (excluded.length > 0) {
          res.status(422).json({
            error: "SIT_MEMBER_EXCLUDED",
            message: `These universities cannot be routed through SIT: ${excluded
              .map((row) => row.name)
              .join(", ")}`,
            excluded: excluded.map((row) => ({ id: row.id, name: row.name })),
          });
          return;
        }
      }

      // Conflict: a catalog id already owned by a DIFFERENT account.
      const conflicts = await db
        .select({
          catalogUniversityId: portalAccountUniversitiesTable.catalogUniversityId,
          portalKey: portalAccountUniversitiesTable.portalKey,
        })
        .from(portalAccountUniversitiesTable)
        .where(
          and(
            inArray(portalAccountUniversitiesTable.catalogUniversityId, requested),
            sql`${portalAccountUniversitiesTable.portalKey} <> ${key}`,
          ),
        );
      if (conflicts.length > 0 && !force) {
        res.status(409).json({
          error: "ALREADY_ASSIGNED",
          message: `Already assigned to another portal account: ${conflicts
            .map((c) => `${c.catalogUniversityId}→${c.portalKey}`)
            .join(", ")}`,
          conflicts,
        });
        return;
      }
      conflictingPortalKeys = [...new Set(conflicts.map((conflict) => conflict.portalKey))];
    }

    await db.transaction(async (tx) => {
      const affectedPortalKeys = [...new Set([key, ...conflictingPortalKeys])];
      const affectedPartners = await tx
        .select({ adapterKey: portalUniversitiesTable.adapterKey })
        .from(portalUniversitiesTable)
        .where(and(
          inArray(portalUniversitiesTable.universityKey, affectedPortalKeys),
          isNull(portalUniversitiesTable.deletedAt),
        ));
      for (const adapterKey of new Set(affectedPartners.map((partner) => partner.adapterKey))) {
        await resetAdapterExecutionStateTx(tx, adapterKey);
      }

      // Remove members of THIS account omitted from the new set.
      const removeCondition =
        requested.length > 0
          ? and(
              eq(portalAccountUniversitiesTable.portalKey, key),
              notInArray(portalAccountUniversitiesTable.catalogUniversityId, requested),
            )
          : eq(portalAccountUniversitiesTable.portalKey, key);
      await tx.delete(portalAccountUniversitiesTable).where(removeCondition);

      // Upsert requested. ON CONFLICT(catalog_university_id) → move to this
      // account (force path already validated above; without force there were
      // no cross-account conflicts so this only re-affirms same-account rows).
      if (requested.length > 0) {
        await tx
          .insert(portalAccountUniversitiesTable)
          .values(
            requested.map((catalogUniversityId) => ({
              portalKey: key,
              catalogUniversityId,
            })),
          )
          .onConflictDoUpdate({
            target: portalAccountUniversitiesTable.catalogUniversityId,
            set: { portalKey: key, updatedAt: new Date() },
          });
      }
    });

    logAudit(
      user.id,
      "portal.membership.update",
      "portal_university",
      portal.id,
      { portalKey: key, catalogUniversityIds: requested, force: force ?? false },
      req.ip,
    );

    const members = await db
      .select({
        catalogUniversityId: portalAccountUniversitiesTable.catalogUniversityId,
        enabled: portalAccountUniversitiesTable.enabled,
        universityName: universitiesTable.name,
        country: universitiesTable.country,
      })
      .from(portalAccountUniversitiesTable)
      .innerJoin(
        universitiesTable,
        eq(portalAccountUniversitiesTable.catalogUniversityId, universitiesTable.id),
      )
      .where(eq(portalAccountUniversitiesTable.portalKey, key))
      .orderBy(asc(universitiesTable.name));

    res.json({ portalKey: key, members });
  },
);

// ---------------------------------------------------------------------------
// GET /portal-automation/resolve?applicationId=
// Resolves the submission target for an application's university so the UI can
// show "Gönderim hedefi: <portal>". Mirrors runner resolution: own portal row →
// resolveAdapterKey → portalKey = routedVia ?? own universityKey.
// ---------------------------------------------------------------------------
const resolveQuerySchema = z.object({
  applicationId: z.coerce.number().int().positive(),
});
type ResolveSchemas = { query: typeof resolveQuerySchema };

router.get(
  "/portal-automation/resolve",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ query: resolveQuerySchema }),
  async (req, res): Promise<void> => {
    const { applicationId } = getValidated<ResolveSchemas>(req).query;

    const [app] = await db
      .select({
        universityId: applicationsTable.universityId,
        universityName: universitiesTable.name,
      })
      .from(applicationsTable)
      .leftJoin(universitiesTable, eq(applicationsTable.universityId, universitiesTable.id))
      .where(eq(applicationsTable.id, applicationId))
      .limit(1);
    if (!app) {
      res.status(404).json({ error: "APPLICATION_NOT_FOUND" });
      return;
    }

    const routing = await resolvePortalRouting({
      universityId: app.universityId,
      universityName: app.universityName,
    });
    if (!routing) {
      res.json({ resolved: false });
      return;
    }
    const { portalUni, target } = routing;

    const { adapterKey, routedVia, memberUniversityId } = await resolveAdapterKey(
      portalUni.universityKey,
    );

    res.json({
      resolved: true,
      ownUniversityKey: portalUni.universityKey,
      ownUniversityName: target ? target.universityName : portalUni.universityName,
      portalKey: routedVia ?? portalUni.universityKey,
      routed: routedVia != null || target != null,
      adapterKey,
      memberUniversityId: memberUniversityId ?? target?.catalogUniversityId ?? null,
    });
  },
);

// ===========================================================================
// Declarative adapter SPECs (opt-in, versioned parallel engine)
// ---------------------------------------------------------------------------
// CRUD/validate/version/rollback over portal_adapter_specs. The flat
// portal_adapters table is unchanged; these endpoints manage the richer,
// versioned spec format. jsHook execution is a separate, super_admin-gated
// trust decision (jsHookApproved); uploading a jsHook spec is super_admin-only.
// ===========================================================================

const specKeyParamsSchema = z.object({ key: z.string().min(1).max(100) });
const rawSpecObjectSchema = z.record(z.string(), z.unknown());

const validateSpecBodySchema = z.object({ spec: rawSpecObjectSchema });
const upsertSpecBodySchema = z
  .object({ spec: rawSpecObjectSchema })
  .strict();
const patchSpecBodySchema = z
  .object({
    enableVersion: z.number().int().positive().optional(),
    disable: z.boolean().optional(),
    rollbackTo: z.number().int().positive().optional(),
    /** Exact version whose approval flags are being changed. */
    approvalVersion: z.number().int().positive().optional(),
    jsHookApproved: z.boolean().optional(),
    privilegedApproved: z.boolean().optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    const changesApproval =
      body.jsHookApproved !== undefined ||
      body.privilegedApproved !== undefined;
    if (changesApproval && body.approvalVersion === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approvalVersion"],
        message: "approvalVersion is required for approval changes",
      });
    }
    if (!changesApproval && body.approvalVersion !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approvalVersion"],
        message: "approvalVersion requires an approval change",
      });
    }
    if (
      body.enableVersion !== undefined &&
      body.rollbackTo !== undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["enableVersion"],
        message: "enableVersion and rollbackTo are mutually exclusive",
      });
    }
    if (
      body.disable === true &&
      (body.enableVersion !== undefined || body.rollbackTo !== undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["disable"],
        message: "disable cannot be combined with enableVersion or rollbackTo",
      });
    }
    if (
      body.enableVersion === undefined &&
      body.rollbackTo === undefined &&
      body.disable !== true &&
      !changesApproval
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "At least one version, approval, or disable change is required",
      });
    }
  });

function isSuperAdmin(role: string): boolean {
  return role === "super_admin";
}

/**
 * Atomically makes a single version the enabled one for a key (disabling all
 * others). Pass version=null to disable all versions for the key.
 */
// Serialize all enable/rollback/version-creation for a given key. A transaction
// scoped advisory lock keyed by the adapter key prevents interleaving updates
// from leaving two enabled rows (which the partial unique index would otherwise
// reject with a 500) or from racing on the next version number.
type SpecTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function lockSpecKey(tx: SpecTx, key: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
}

// Enable exactly one version for a key (or disable all when version is null),
// inside an already-locked transaction.
async function setEnabledSpecVersionTx(
  tx: SpecTx,
  key: string,
  version: number | null,
): Promise<void> {
  await tx
    .update(portalAdapterSpecsTable)
    .set({ enabled: false, updatedAt: new Date() })
    .where(eq(portalAdapterSpecsTable.key, key));
  if (version !== null) {
    await tx
      .update(portalAdapterSpecsTable)
      .set({ enabled: true, updatedAt: new Date() })
      .where(
        and(
          eq(portalAdapterSpecsTable.key, key),
          eq(portalAdapterSpecsTable.version, version),
        ),
      );
  }
}

class AdapterChangeInFlightError extends Error {
  constructor(readonly runningCount: number) {
    super("Adapter behavior cannot change while submissions are running");
    this.name = "AdapterChangeInFlightError";
  }
}

async function resetAdapterExecutionStateTx(
  tx: SpecTx,
  key: string,
): Promise<{ partners: number; pendingSubmissions: number }> {
  // Lock and quarantine every not-yet-started row first. A concurrent claimant
  // either sees the canceled state after commit or wins the row lock and is
  // then detected by the running-row check below.
  const pending = await tx
    .update(portalSubmissionsTable)
    .set({
      status: "canceled",
      error: "ADAPTER_CONFIGURATION_CHANGED_REVIEW_REQUIRED",
      lockedAt: null,
      lockedBy: null,
      updatedAt: new Date(),
    })
    .where(and(
      eq(portalSubmissionsTable.adapterKey, key),
      eq(portalSubmissionsTable.status, "queued"),
      isNull(portalSubmissionsTable.deletedAt),
    ))
    .returning({ id: portalSubmissionsTable.id });

  const [inFlight] = await tx
    .select({ total: count(portalSubmissionsTable.id) })
    .from(portalSubmissionsTable)
    .where(and(
      eq(portalSubmissionsTable.adapterKey, key),
      eq(portalSubmissionsTable.status, "running"),
      isNull(portalSubmissionsTable.deletedAt),
    ));
  const runningCount = Number(inFlight?.total ?? 0);
  if (runningCount > 0) throw new AdapterChangeInFlightError(runningCount);

  const partners = await tx
    .update(portalUniversitiesTable)
    .set({
      isActive: false,
      autoProcess: false,
      fanOutMode: "off",
      verificationGeneration: sql`${portalUniversitiesTable.verificationGeneration} + 1`,
      updatedAt: new Date(),
    })
    .where(and(
      eq(portalUniversitiesTable.adapterKey, key),
      isNull(portalUniversitiesTable.deletedAt),
    ))
    .returning({ id: portalUniversitiesTable.id });

  return { partners: partners.length, pendingSubmissions: pending.length };
}

// GET /portal-automation/adapter-specs — one entry per key (enabled + latest).
router.get(
  "/portal-automation/adapter-specs",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (_req, res) => {
    let rows: (typeof portalAdapterSpecsTable.$inferSelect)[];
    try {
      rows = await db
        .select()
        .from(portalAdapterSpecsTable)
        .orderBy(
          asc(portalAdapterSpecsTable.key),
          desc(portalAdapterSpecsTable.version),
        );
    } catch (err) {
      console.warn(`[portalAutomation] failed to load adapter specs: ${String(err)}`);
      res.json({ specs: [] });
      return;
    }

    const byKey = new Map<
      string,
      {
        key: string;
        name: string;
        latestVersion: number;
        enabledVersion: number | null;
        versionCount: number;
        source: string;
        jsHookApproved: boolean;
        privilegedApproved: boolean;
        hasJsHook: boolean;
        privileged: boolean;
        latestSha256: string;
        latestActivationBlockers: string[];
        updatedAt: Date;
      }
    >();
    for (const row of rows) {
      const existing = byKey.get(row.key);
      if (!existing) {
        byKey.set(row.key, {
          key: row.key,
          name: row.name,
          latestVersion: row.version,
          enabledVersion: row.enabled ? row.version : null,
          versionCount: 1,
          source: row.source,
          jsHookApproved: row.jsHookApproved,
          privilegedApproved: row.privilegedApproved,
          hasJsHook: specHasJsHook(row.spec),
          privileged: specIsPrivileged(row.spec),
          latestSha256: portalAdapterSpecSha256(row.spec),
          latestActivationBlockers: portalAdapterSpecActivationBlockers({
            spec: row.spec,
            jsHookApproved: row.jsHookApproved,
            privilegedApproved: row.privilegedApproved,
          }),
          updatedAt: row.updatedAt,
        });
      } else {
        existing.versionCount += 1;
        if (row.enabled) existing.enabledVersion = row.version;
      }
    }

    res.json({ specs: Array.from(byKey.values()) });
  },
);

// GET /portal-automation/adapter-specs/:key/versions — full version history.
router.get(
  "/portal-automation/adapter-specs/:key/versions",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ params: specKeyParamsSchema }),
  async (req, res) => {
    const { key } = getValidated<{ params: typeof specKeyParamsSchema }>(req).params;
    const rows = await listSpecVersions(key);
    res.json({
      key,
      versions: rows.map((row) => ({
        version: row.version,
        name: row.name,
        enabled: row.enabled,
        source: row.source,
        jsHookApproved: row.jsHookApproved,
        privilegedApproved: row.privilegedApproved,
        hasJsHook: specHasJsHook(row.spec),
        privileged: specIsPrivileged(row.spec),
        sha256: portalAdapterSpecSha256(row.spec),
        activationBlockers: portalAdapterSpecActivationBlockers({
          spec: row.spec,
          jsHookApproved: row.jsHookApproved,
          privilegedApproved: row.privilegedApproved,
        }),
        createdBy: row.createdBy,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
    });
  },
);

// POST /portal-automation/adapter-specs/validate — validate without persisting.
router.post(
  "/portal-automation/adapter-specs/validate",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ body: validateSpecBodySchema }),
  async (req, res) => {
    const { spec } = getValidated<{ body: typeof validateSpecBodySchema }>(req).body;
    const parsed = parseAdapterSpec(spec);
    if (!parsed.ok) {
      res.json({ ok: false, error: parsed.error, issues: parsed.issues ?? [] });
      return;
    }
    const policy = buildPortalAdapterSpecPolicySnapshot(parsed.spec, {
      jsHookApproved: false,
      privilegedApproved: false,
    });
    if (policy.byteLength > MAX_PORTAL_ADAPTER_SPEC_BYTES) {
      res.json({
        ok: false,
        error: "SPEC_TOO_LARGE",
        message: `Canonical spec exceeds ${MAX_PORTAL_ADAPTER_SPEC_BYTES} bytes.`,
        issues: [],
      });
      return;
    }
    res.json({
      ok: true,
      key: parsed.spec.meta.key,
      name: parsed.spec.meta.name,
      hasJsHook: policy.hasJsHook,
      privileged: policy.privileged,
      sha256: policy.sha256,
      byteLength: policy.byteLength,
      activationBlockers: policy.activationBlockers,
      activationRequiresSeparateStep: true,
    });
  },
);

// POST /portal-automation/adapter-specs — create a new, inert version.
router.post(
  "/portal-automation/adapter-specs",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ body: upsertSpecBodySchema }),
  async (req, res) => {
    const user = req.user!;
    const { spec } = getValidated<{
      body: typeof upsertSpecBodySchema;
    }>(req).body;

    const parsed = parseAdapterSpec(spec);
    if (!parsed.ok) {
      res.status(400).json({ error: "INVALID_SPEC", message: parsed.error, issues: parsed.issues ?? [] });
      return;
    }

    const policy = buildPortalAdapterSpecPolicySnapshot(parsed.spec, {
      jsHookApproved: false,
      privilegedApproved: false,
    });
    if (policy.byteLength > MAX_PORTAL_ADAPTER_SPEC_BYTES) {
      res.status(413).json({
        error: "SPEC_TOO_LARGE",
        message: `Canonical spec exceeds ${MAX_PORTAL_ADAPTER_SPEC_BYTES} bytes.`,
      });
      return;
    }
    const hasJsHook = policy.hasJsHook;
    // Uploading a spec that contains jsHook steps is super_admin-only.
    if (hasJsHook && !isSuperAdmin(user.role)) {
      res.status(403).json({ error: "JSHOOK_FORBIDDEN", message: "Only super_admin may upload specs containing jsHook steps." });
      return;
    }
    // Approval is never inherited from the upload request. Each immutable
    // version starts unapproved and must be reviewed explicitly afterwards.
    const jsHookApproved = false;
    const privilegedApproved = false;

    const key = parsed.spec.meta.key;

    // Lock the key so the next-version computation, the insert, and the optional
    // write happen atomically — concurrent uploads can't collide on the
    // (key, version) unique index or leave two enabled rows.
    const { created, nextVersion } = await db.transaction(async (tx) => {
      await lockSpecKey(tx, key);
      const [maxRow] = await tx
        .select({ version: portalAdapterSpecsTable.version })
        .from(portalAdapterSpecsTable)
        .where(eq(portalAdapterSpecsTable.key, key))
        .orderBy(desc(portalAdapterSpecsTable.version))
        .limit(1);
      const next = (maxRow?.version ?? 0) + 1;
      const [row] = await tx
        .insert(portalAdapterSpecsTable)
        .values({
          key,
          name: parsed.spec.meta.name,
          spec: policy.canonicalSpec,
          version: next,
          enabled: false,
          source: "uploaded",
          jsHookApproved,
          privilegedApproved,
          createdBy: user.id,
        })
        .returning();
      return { created: row, nextVersion: next };
    });

    await logAudit(
      user.id,
      "upsert_adapter_spec",
      "portal_adapter_spec",
      created.id,
      {
        key,
        version: nextVersion,
        enabled: false,
        hasJsHook,
        jsHookApproved,
        privilegedApproved,
        specSha256: policy.sha256,
        specByteLength: policy.byteLength,
      },
      req.ip,
    );

    res.status(201).json({
      key,
      version: nextVersion,
      enabled: false,
      jsHookApproved,
      privilegedApproved,
      hasJsHook,
      privileged: policy.privileged,
      sha256: policy.sha256,
      byteLength: policy.byteLength,
      activationBlockers: policy.activationBlockers,
      activationRequiresSeparateStep: true,
    });
  },
);

// PATCH /portal-automation/adapter-specs/:key — enable/disable/rollback/approve.
router.patch(
  "/portal-automation/adapter-specs/:key",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ params: specKeyParamsSchema, body: patchSpecBodySchema }),
  async (req, res) => {
    const user = req.user!;
    const { key } = getValidated<{ params: typeof specKeyParamsSchema }>(req).params;
    const body = getValidated<{ body: typeof patchSpecBodySchema }>(req).body;

    const changesApproval =
      body.jsHookApproved !== undefined ||
      body.privilegedApproved !== undefined;
    if (changesApproval && !isSuperAdmin(user.role)) {
      res.status(403).json({
        error: "SPEC_APPROVAL_FORBIDDEN",
        message: "Only super_admin may change adapter spec approvals.",
      });
      return;
    }

    const targetVersion = body.enableVersion ?? body.rollbackTo;
    let mutation;
    try {
      mutation = await db.transaction(async (tx) => {
        await lockSpecKey(tx, key);
        const versions = await tx
          .select()
          .from(portalAdapterSpecsTable)
          .where(eq(portalAdapterSpecsTable.key, key))
          .orderBy(desc(portalAdapterSpecsTable.version));

        if (versions.length === 0) {
          return { ok: false as const, status: 404, error: "NOT_FOUND" };
        }

        const approvalRow = body.approvalVersion === undefined
          ? null
          : versions.find((row) => row.version === body.approvalVersion) ?? null;
        if (body.approvalVersion !== undefined && !approvalRow) {
          return {
            ok: false as const,
            status: 404,
            error: "VERSION_NOT_FOUND",
            message: `Version ${body.approvalVersion} does not exist for ${key}.`,
          };
        }

        const targetRow = targetVersion === undefined
          ? null
          : versions.find((row) => row.version === targetVersion) ?? null;
        if (targetVersion !== undefined && !targetRow) {
          return {
            ok: false as const,
            status: 404,
            error: "VERSION_NOT_FOUND",
            message: `Version ${targetVersion} does not exist for ${key}.`,
          };
        }

        if (targetRow) {
          const targetApprovals = {
            jsHookApproved:
              approvalRow?.version === targetRow.version && body.jsHookApproved !== undefined
                ? body.jsHookApproved
                : targetRow.jsHookApproved,
            privilegedApproved:
              approvalRow?.version === targetRow.version && body.privilegedApproved !== undefined
                ? body.privilegedApproved
                : targetRow.privilegedApproved,
          };
          const blockers = portalAdapterSpecActivationBlockers({
            spec: targetRow.spec,
            ...targetApprovals,
          });
          if (blockers.length > 0) {
            return {
              ok: false as const,
              status: 409,
              error: blockers[0],
              activationBlockers: blockers,
              message: `Version ${targetVersion} is not approved for activation.`,
            };
          }
        }

        let approvalDisablesEnabledVersion = false;
        if (approvalRow) {
          const nextJsHookApproved =
            body.jsHookApproved ?? approvalRow.jsHookApproved;
          const nextPrivilegedApproved =
            body.privilegedApproved ?? approvalRow.privilegedApproved;
          const mustDisable =
            approvalRow.enabled &&
            ((specHasJsHook(approvalRow.spec) && !nextJsHookApproved) ||
              (specIsPrivileged(approvalRow.spec) && !nextPrivilegedApproved));
          approvalDisablesEnabledVersion = mustDisable;
          await tx
            .update(portalAdapterSpecsTable)
            .set({
              jsHookApproved: nextJsHookApproved,
              privilegedApproved: nextPrivilegedApproved,
              ...(mustDisable ? { enabled: false } : {}),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(portalAdapterSpecsTable.key, key),
                eq(portalAdapterSpecsTable.version, approvalRow.version),
              ),
            );
        }

        if (body.disable) {
          await setEnabledSpecVersionTx(tx, key, null);
        } else if (targetVersion !== undefined) {
          await setEnabledSpecVersionTx(tx, key, targetVersion);
        }

        const adapterBehaviorChanged =
          body.disable === true ||
          targetVersion !== undefined ||
          approvalDisablesEnabledVersion;
        const safetyReset = adapterBehaviorChanged
          ? await resetAdapterExecutionStateTx(tx, key)
          : { partners: 0, pendingSubmissions: 0 };

        return {
          ok: true as const,
          auditResourceId: approvalRow?.id ?? targetRow?.id ?? versions[0].id,
          safetyReset,
        };
      });
    } catch (error) {
      if (error instanceof AdapterChangeInFlightError) {
        res.status(409).json({
          error: "ADAPTER_CHANGE_IN_FLIGHT",
          message: "Wait for running submissions to finish before changing this adapter.",
          runningCount: error.runningCount,
        });
        return;
      }
      throw error;
    }

    if (!mutation.ok) {
      res.status(mutation.status).json({
        error: mutation.error,
        ...(mutation.message ? { message: mutation.message } : {}),
        ...(mutation.activationBlockers
          ? { activationBlockers: mutation.activationBlockers }
          : {}),
      });
      return;
    }

    invalidateSpecAdapterCache();

    await logAudit(
      user.id,
      "patch_adapter_spec",
      "portal_adapter_spec",
      mutation.auditResourceId,
      {
        key,
        enableVersion: body.enableVersion,
        rollbackTo: body.rollbackTo,
        disable: body.disable === true,
        approvalVersion: body.approvalVersion,
        jsHookApproved: body.jsHookApproved,
        privilegedApproved: body.privilegedApproved,
        safetyReset: mutation.safetyReset,
      },
      req.ip,
    );

    const refreshed = await listSpecVersions(key);
    const enabled = refreshed.find((v) => v.enabled) ?? null;
    res.json({
      key,
      enabledVersion: enabled?.version ?? null,
      approvalVersion: body.approvalVersion ?? null,
      approval:
        body.approvalVersion === undefined
          ? null
          : (() => {
              const row = refreshed.find((item) => item.version === body.approvalVersion);
              return row
                ? {
                    jsHookApproved: row.jsHookApproved,
                    privilegedApproved: row.privilegedApproved,
                  }
                : null;
            })(),
      safetyReset: mutation.safetyReset,
    });
  },
);

export default router;
