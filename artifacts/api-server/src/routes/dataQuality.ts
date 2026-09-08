import { Router, type IRouter } from "express";
import { applicationsTable, db, leadsTable, studentsTable } from "@workspace/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { logAudit, requireAuth, requireRole } from "../lib/auth";
import { ADMIN_ROLES } from "../lib/roles";
import { duplicateCandidatesCte } from "../lib/reportingDuplicateSemantics";

const router: IRouter = Router();

type DuplicateRow = {
  entity: "student" | "lead";
  matchKey: "email" | "phone" | "passport";
  normalizedValue: string;
  recordIds: number[];
  recordCount: number;
};

type ApplicationLeadCandidate = {
  applicationId: number;
  studentId: number;
  candidateLeadIds: number[];
  activeApplicationCount: number;
  classification: "safe_candidate" | "review_unique_identity" | "ambiguous" | "no_candidate";
  evidence: string[];
};

/**
 * Read-only duplicate candidate report. Deliberately does not merge records:
 * a safe merge must account for documents, applications, conversations,
 * finance and audit ownership in one reviewed transaction.
 */
router.get("/admin/data-quality/duplicates", requireAuth, requireRole(...ADMIN_ROLES), async (_req, res): Promise<void> => {
  const result = await db.execute(sql.raw(`
    WITH ${duplicateCandidatesCte("global")}
    SELECT entity, match_key, normalized_value, record_ids, record_count
    FROM duplicate_candidates
    ORDER BY record_count DESC, entity, match_key
    LIMIT 500
  `));

  const rows = (result.rows ?? []) as Array<Record<string, unknown>>;
  const data: DuplicateRow[] = rows.map((row) => ({
    entity: row.entity as DuplicateRow["entity"],
    matchKey: row.match_key as DuplicateRow["matchKey"],
    normalizedValue: String(row.normalized_value ?? ""),
    recordIds: Array.isArray(row.record_ids) ? row.record_ids.map(Number) : [],
    recordCount: Number(row.record_count ?? 0),
  }));

  res.json({
    data,
    summary: {
      groups: data.length,
      affectedRecords: data.reduce((sum, row) => sum + row.recordCount, 0),
    },
    mergeAvailable: false,
    mergePolicy: "Review candidates before a dedicated transactional merge is enabled.",
  });
});

/**
 * One-shot, read-only health matrix for the Lead → Student → Application
 * lifecycle. This endpoint is deliberately count-only: it is safe to run on
 * production before a deployment and never guesses or repairs relationships.
 */
router.get("/admin/data-quality/lifecycle-integrity", requireAuth, requireRole(...ADMIN_ROLES), async (_req, res): Promise<void> => {
  const result = await db.execute(sql`
    SELECT
      (SELECT count(*)::int FROM applications a
       LEFT JOIN students s ON s.id = a.student_id
       WHERE a.deleted_at IS NULL AND (s.id IS NULL OR s.deleted_at IS NOT NULL)) AS active_apps_without_active_student,
      (SELECT count(*)::int FROM applications a
       JOIN leads l ON l.id = a.lead_id
       WHERE a.deleted_at IS NULL AND a.lead_id IS NOT NULL
         AND (l.deleted_at IS NOT NULL OR l.converted_student_id IS DISTINCT FROM a.student_id)) AS application_lead_student_mismatch,
      (SELECT count(*)::int FROM applications a
       WHERE a.deleted_at IS NULL AND a.lead_id IS NULL) AS active_apps_without_explicit_lead,
      (SELECT count(*)::int FROM leads l
       JOIN students s ON s.id = l.converted_student_id
       WHERE l.deleted_at IS NULL AND s.deleted_at IS NOT NULL) AS active_leads_pointing_to_deleted_students,
      (SELECT count(*)::int FROM students s
       LEFT JOIN leads l ON l.id = s.origin_lead_id
       WHERE s.deleted_at IS NULL AND s.origin_lead_id IS NOT NULL AND l.id IS NULL) AS orphan_student_origin_leads,
      (SELECT count(*)::int FROM leads l
       JOIN students s ON s.id = l.converted_student_id AND s.deleted_at IS NULL
       WHERE l.deleted_at IS NULL AND l.assigned_to_id IS DISTINCT FROM s.assigned_to_id) AS lead_student_assignment_mismatch,
      (SELECT count(*)::int FROM applications a
       JOIN students s ON s.id = a.student_id AND s.deleted_at IS NULL
       WHERE a.deleted_at IS NULL AND a.assigned_to_id IS DISTINCT FROM s.assigned_to_id) AS application_student_assignment_mismatch,
      (SELECT count(*)::int FROM applications a
       JOIN students s ON s.id = a.student_id AND s.deleted_at IS NULL
       WHERE a.deleted_at IS NULL AND a.branch_id IS NOT NULL AND s.branch_id IS NOT NULL
         AND a.branch_id IS DISTINCT FROM s.branch_id) AS application_student_branch_conflict,
      (SELECT count(*)::int FROM leads l
       JOIN students s ON s.id = l.converted_student_id AND s.deleted_at IS NULL
       WHERE l.deleted_at IS NULL AND l.branch_id IS NOT NULL AND s.branch_id IS NOT NULL
         AND l.branch_id IS DISTINCT FROM s.branch_id) AS lead_student_branch_conflict,
      (SELECT count(*)::int FROM lifecycle_cascade_state) AS recorded_lifecycle_cascades
  `);
  const row = (result.rows?.[0] ?? {}) as Record<string, unknown>;
  const counts = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value ?? 0)]));
  const blockingKeys = [
    "active_apps_without_active_student",
    "application_lead_student_mismatch",
    "active_leads_pointing_to_deleted_students",
    "orphan_student_origin_leads",
  ];
  res.json({
    generatedAt: new Date().toISOString(),
    mode: "read_only",
    counts,
    deploymentBlockers: blockingKeys.filter((key) => (counts[key] ?? 0) > 0),
    policy: "No records were changed. Unlinked legacy applications and ownership/branch mismatches require reviewed reconciliation, not automatic repair.",
  });
});

/**
 * Read-only legacy application → lead relationship analysis. A result marked
 * safe_candidate is still not written automatically: an administrator must
 * review it before a future transactional backfill is explicitly approved.
 */
router.get("/admin/data-quality/application-lead-links", requireAuth, requireRole(...ADMIN_ROLES), async (_req, res): Promise<void> => {
  const result = await db.execute(sql`
    WITH active_apps AS (
      SELECT a.id AS application_id, a.student_id,
             (
               SELECT count(*)::int
               FROM applications sibling
               WHERE sibling.student_id = a.student_id AND sibling.deleted_at IS NULL
             ) AS active_application_count
      FROM applications a
      WHERE a.deleted_at IS NULL AND a.lead_id IS NULL
    ),
    candidates AS (
      SELECT aa.application_id, aa.student_id, aa.active_application_count,
             l.id AS lead_id,
             (l.id = s.origin_lead_id OR l.converted_student_id = s.id) AS has_lineage,
             (nullif(lower(trim(s.email)), '') IS NOT NULL AND lower(trim(l.email)) = lower(trim(s.email))) AS email_match,
             (
               nullif(coalesce(nullif(trim(s.phone_e164), ''), regexp_replace(coalesce(s.phone, ''), '[^0-9]+', '', 'g')), '') IS NOT NULL
               AND coalesce(nullif(trim(l.phone_e164), ''), regexp_replace(coalesce(l.phone, ''), '[^0-9]+', '', 'g')) =
                   coalesce(nullif(trim(s.phone_e164), ''), regexp_replace(coalesce(s.phone, ''), '[^0-9]+', '', 'g'))
             ) AS phone_match
      FROM active_apps aa
      JOIN students s ON s.id = aa.student_id AND s.deleted_at IS NULL
      LEFT JOIN leads l ON l.deleted_at IS NULL AND (
        l.id = s.origin_lead_id OR
        l.converted_student_id = s.id OR
        (nullif(lower(trim(s.email)), '') IS NOT NULL AND lower(trim(l.email)) = lower(trim(s.email))) OR
        (
          nullif(coalesce(nullif(trim(s.phone_e164), ''), regexp_replace(coalesce(s.phone, ''), '[^0-9]+', '', 'g')), '') IS NOT NULL
          AND coalesce(nullif(trim(l.phone_e164), ''), regexp_replace(coalesce(l.phone, ''), '[^0-9]+', '', 'g')) =
              coalesce(nullif(trim(s.phone_e164), ''), regexp_replace(coalesce(s.phone, ''), '[^0-9]+', '', 'g'))
        )
      )
    ),
    grouped AS (
      SELECT application_id, student_id, active_application_count,
             array_agg(DISTINCT lead_id ORDER BY lead_id) FILTER (WHERE lead_id IS NOT NULL) AS candidate_lead_ids,
             bool_or(has_lineage) FILTER (WHERE lead_id IS NOT NULL) AS has_lineage,
             bool_or(email_match) FILTER (WHERE lead_id IS NOT NULL) AS has_email_match,
             bool_or(phone_match) FILTER (WHERE lead_id IS NOT NULL) AS has_phone_match,
             count(DISTINCT lead_id)::int AS candidate_count
      FROM candidates
      GROUP BY application_id, student_id, active_application_count
    )
    SELECT application_id, student_id, active_application_count,
           coalesce(candidate_lead_ids, ARRAY[]::integer[]) AS candidate_lead_ids,
           ARRAY_REMOVE(ARRAY[
             CASE WHEN has_lineage THEN 'student/lead lineage' END,
             CASE WHEN has_email_match THEN 'normalized email' END,
             CASE WHEN has_phone_match THEN 'normalized phone' END
           ], NULL) AS evidence,
           CASE
             WHEN candidate_count = 0 THEN 'no_candidate'
             WHEN candidate_count = 1 AND active_application_count = 1 AND has_lineage THEN 'safe_candidate'
             WHEN candidate_count = 1 AND active_application_count = 1 THEN 'review_unique_identity'
             ELSE 'ambiguous'
           END AS classification
    FROM grouped
    ORDER BY
      CASE
        WHEN candidate_count = 1 AND active_application_count = 1 AND has_lineage THEN 0
        WHEN candidate_count = 1 AND active_application_count = 1 THEN 1
        WHEN candidate_count > 1 OR active_application_count > 1 THEN 2
        ELSE 3
      END,
      application_id
    LIMIT 2000
  `);

  const rows = (result.rows ?? []) as Array<Record<string, unknown>>;
  const data: ApplicationLeadCandidate[] = rows.map((row) => ({
    applicationId: Number(row.application_id),
    studentId: Number(row.student_id),
    candidateLeadIds: Array.isArray(row.candidate_lead_ids) ? row.candidate_lead_ids.map(Number) : [],
    activeApplicationCount: Number(row.active_application_count ?? 0),
    classification: row.classification as ApplicationLeadCandidate["classification"],
    evidence: Array.isArray(row.evidence) ? row.evidence.map(String) : [],
  }));
  const countBy = (classification: ApplicationLeadCandidate["classification"]) =>
    data.filter((row) => row.classification === classification).length;

  res.json({
    data,
    summary: {
      unlinkedApplications: data.length,
      safeCandidates: countBy("safe_candidate"),
      uniqueIdentityReview: countBy("review_unique_identity"),
      ambiguous: countBy("ambiguous"),
      noCandidate: countBy("no_candidate"),
    },
    writeEnabled: false,
    policy: "Analysis only. No application or lead record was changed.",
  });
});

/**
 * Explicit, one-row repair after an administrator has reviewed the read-only
 * candidate report. The endpoint never matches by e-mail/phone: the selected
 * lead must already declare this exact student as convertedStudentId.
 */
router.post("/admin/data-quality/application-lead-links/:applicationId/approve", requireAuth, requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const applicationId = Number(req.params.applicationId);
  const leadId = Number(req.body?.leadId);
  if (!Number.isInteger(applicationId) || applicationId <= 0 || !Number.isInteger(leadId) || leadId <= 0) {
    res.status(400).json({ error: "Valid applicationId and leadId are required" });
    return;
  }

  const outcome = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(78141, ${applicationId})`);
    const [app] = await tx.select({
      id: applicationsTable.id,
      studentId: applicationsTable.studentId,
      leadId: applicationsTable.leadId,
    }).from(applicationsTable).where(and(
      eq(applicationsTable.id, applicationId),
      isNull(applicationsTable.deletedAt),
    ));
    if (!app) return { status: 404 as const, error: "Active application not found" };
    if (app.leadId != null) {
      return app.leadId === leadId
        ? { status: 200 as const, app, idempotent: true }
        : { status: 409 as const, error: "Application is already linked to a different lead" };
    }
    const [student] = await tx.select({ id: studentsTable.id }).from(studentsTable).where(and(
      eq(studentsTable.id, app.studentId), isNull(studentsTable.deletedAt),
    ));
    const [lead] = await tx.select({ id: leadsTable.id, convertedStudentId: leadsTable.convertedStudentId }).from(leadsTable).where(and(
      eq(leadsTable.id, leadId), isNull(leadsTable.deletedAt),
    ));
    if (!student || !lead) return { status: 404 as const, error: "Active student or lead not found" };
    if (lead.convertedStudentId !== app.studentId) {
      return { status: 409 as const, error: "Lead does not authoritatively reference this application student" };
    }
    const [updated] = await tx.update(applicationsTable).set({ leadId })
      .where(and(eq(applicationsTable.id, applicationId), isNull(applicationsTable.leadId)))
      .returning({ id: applicationsTable.id, studentId: applicationsTable.studentId, leadId: applicationsTable.leadId });
    if (!updated) return { status: 409 as const, error: "Application link changed concurrently; reload the report" };
    return { status: 200 as const, app: updated, idempotent: false };
  });

  if ("error" in outcome) {
    res.status(outcome.status).json({ error: outcome.error });
    return;
  }
  const linkedApp = outcome.app;
  if (!outcome.idempotent) {
    await logAudit(req.user!.id, "approve_application_lead_link", "application", applicationId, {
      leadId,
      studentId: linkedApp.studentId,
    }, req.ip);
  }
  res.json({ success: true, application: linkedApp, idempotent: outcome.idempotent });
});

export default router;
