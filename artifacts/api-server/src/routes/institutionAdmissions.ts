import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import type { PoolClient } from "pg";
import { requireAuth } from "../lib/auth";
import {
  isInstitutionAdmissionsEnabled,
} from "../lib/institutionAdmissionsFeature";
import { authorizeInstitutionRouteMutation } from "../lib/institutionAdmissionsAuthorizationRuntime";
import {
  assertCapability,
  assertAnyCapability,
  assertInstitutionDataScope,
  assertDecisionCanCreateOffer,
  assertIndependentChecker,
  isInstitutionRoleKey,
  hasInstitutionDataScope,
  projectInstitutionSharedProfile,
  type InstitutionCapability,
} from "../lib/institutionAdmissionsPolicy";
import {
  institutionHash,
  institutionScopeSql,
  nextInstitutionId,
  toPublicInstitutionContext,
  withInstitutionContext,
  type InstitutionRequestContext,
} from "../lib/institutionAdmissionsStore";

const router: IRouter = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{64}$/;
const CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const MAX_TEXT = 4_000;

function asUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw new Error("institution_id_invalid");
  return value;
}

function asText(value: unknown, max = MAX_TEXT): string {
  if (typeof value !== "string") throw new Error("institution_text_invalid");
  const text = value.trim();
  if (!text || Buffer.byteLength(text, "utf8") > max) throw new Error("institution_text_invalid");
  return text;
}

function asOptionalText(value: unknown, max = MAX_TEXT): string | null {
  return value == null || value === "" ? null : asText(value, max);
}

function asCode(value: unknown): string {
  const code = asText(value, 64).toUpperCase();
  if (!CODE_RE.test(code)) throw new Error("institution_code_invalid");
  return code;
}

function asPositiveInt(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("institution_number_invalid");
  return parsed;
}

function asIsoDate(value: unknown): Date | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new Error("institution_date_invalid");
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) throw new Error("institution_date_invalid");
  return date;
}

function institutionPortalGate(req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Cache-Control", "private, no-store");
  if (!req.user || req.user.role !== "institution_user") {
    res.status(403).json({ error: "Institution portal access required", code: "INSTITUTION_PORTAL_REQUIRED" });
    return;
  }
  if (req.apiTokenAuth) {
    res.status(403).json({ error: "Interactive institution session required", code: "INSTITUTION_SESSION_REQUIRED" });
    return;
  }
  if (!isInstitutionAdmissionsEnabled(req.user.id)) {
    res.status(404).json({ error: "Institution Admissions is not enabled", code: "INSTITUTION_FEATURE_DISABLED" });
    return;
  }
  next();
}

router.use("/institution", requireAuth, institutionPortalGate);

function statusForError(error: unknown): number {
  const code = error instanceof Error ? error.message : "institution_request_failed";
  if (!/^institution_[a-z0-9_]{2,96}$/.test(code)) return 500;
  if (code.includes("unavailable") || code.includes("denied") || code.includes("conflict")) return 403;
  if (code.includes("assurance_required")) return 503;
  if (code.endsWith("_invalid") || code.includes("requires_") || code.endsWith("_required") || code.includes("_not_")) return 400;
  return 500;
}

function sendFailure(res: Response, error: unknown): void {
  const code = error instanceof Error ? error.message : "institution_request_failed";
  const status = statusForError(error);
  if (status === 500) console.error("[institution-admissions] request failed");
  const publicCode = status === 500 ? "institution_request_failed" : code;
  res.status(status).json({ error: publicCode, code: publicCode.toUpperCase() });
}

async function appendEvent(
  client: PoolClient,
  context: InstitutionRequestContext,
  input: {
    applicationCaseId?: string | null;
    eventType: string;
    aggregateType: string;
    aggregateId: string;
    aggregateVersion: number;
    payload?: Record<string, unknown>;
  },
): Promise<{ id: string; eventHash: string }> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [context.relationshipId]);
  const previous = await client.query<{ event_hash: string }>(`
    SELECT event_hash FROM institution_admission_events
    WHERE relationship_id = $1
    ORDER BY occurred_at DESC, id DESC LIMIT 1
  `, [context.relationshipId]);
  const id = nextInstitutionId();
  const previousHash = previous.rows[0]?.event_hash ?? null;
  const eventHash = institutionHash({
    id,
    tenantId: context.tenantId,
    relationshipId: context.relationshipId,
    actorMembershipId: context.membershipId,
    previousHash,
    ...input,
  });
  await client.query(`
    INSERT INTO institution_admission_events (
      id, tenant_id, relationship_id, application_case_id, event_type,
      actor_membership_id, aggregate_type, aggregate_id, aggregate_version,
      payload, previous_hash, event_hash
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)
  `, [
    id, context.tenantId, context.relationshipId, input.applicationCaseId ?? null,
    input.eventType, context.membershipId, input.aggregateType, input.aggregateId,
    input.aggregateVersion, JSON.stringify(input.payload ?? {}), previousHash, eventHash,
  ]);
  return { id, eventHash };
}

function assertScopedCase(
  client: PoolClient,
  context: InstitutionRequestContext,
  caseId: string,
  lock = false,
) {
  const scope = institutionScopeSql(context, 2);
  return client.query(`
    SELECT * FROM institution_application_cases
    WHERE id = $1 AND ${scope.sql}
    ${lock ? "FOR UPDATE" : ""}
  `, [caseId, ...scope.values]);
}

router.get("/institution/me/context", async (req, res) => {
  try {
    const result = await withInstitutionContext(req.user!.id, async (_client, context) =>
      toPublicInstitutionContext(context));
    res.json({ schemaVersion: 1, enabled: true, ...result });
  } catch (error) { sendFailure(res, error); }
});

router.get("/institution/home", async (req, res) => {
  try {
    const result = await withInstitutionContext(req.user!.id, async (client, context) => {
      const scope = institutionScopeSql(context, 1);
      if (!hasInstitutionDataScope(context.dataScopes, "analytics.aggregate")) {
        return {
          context: toPublicInstitutionContext(context),
          applicationCounts: [],
          overdueCount: 0,
          pendingDecisionCount: 0,
          projection: "WORKSPACE_ONLY",
        };
      }
      const [counts, overdue, decisions] = await Promise.all([
        client.query(`SELECT lifecycle_state, count(*)::integer AS count
          FROM institution_application_cases WHERE ${scope.sql}
          GROUP BY lifecycle_state ORDER BY lifecycle_state`, scope.values),
        client.query(`SELECT count(*)::integer AS count
          FROM institution_application_cases WHERE ${scope.sql}
          AND lifecycle_state NOT IN ('ENROLLED','CLOSED')
          AND COALESCE(decision_due_at, review_due_at) < now()`, scope.values),
        client.query(`SELECT count(*)::integer AS count FROM institution_decisions
          WHERE state = 'SUBMITTED'`),
      ]);
      return {
        context: toPublicInstitutionContext(context),
        applicationCounts: counts.rows,
        overdueCount: overdue.rows[0]?.count ?? 0,
        pendingDecisionCount: decisions.rows[0]?.count ?? 0,
      };
    });
    res.json(result);
  } catch (error) { sendFailure(res, error); }
});

async function listCases(req: Request, res: Response, queueOnly: boolean): Promise<void> {
  try {
    const result = await withInstitutionContext(req.user!.id, async (client, context) => {
      assertAnyCapability(context.capabilities, ["institution.applications.review", "institution.decisions.approve", "institution.audit.read"]);
      assertInstitutionDataScope(context.dataScopes, "application.profile");
      const scope = institutionScopeSql(context, 1);
      const state = typeof req.query.state === "string" ? req.query.state : null;
      const rows = await client.query(`
        SELECT id, legacy_application_id, program_id, intake_key, masked_student_ref,
          lifecycle_state, priority, readiness_percent, blocker_code,
          assigned_reviewer_membership_id, review_due_at, decision_due_at,
          received_at, last_activity_at,
          CASE
            WHEN lifecycle_state NOT IN ('ENROLLED','CLOSED')
             AND COALESCE(decision_due_at, review_due_at) < now() THEN true
            ELSE false
          END AS sla_breached
        FROM institution_application_cases
        WHERE ${scope.sql}
          AND ($3::text IS NULL OR lifecycle_state = $3)
          ${queueOnly ? "AND lifecycle_state NOT IN ('ENROLLED','CLOSED')" : ""}
        ORDER BY
          CASE priority WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'NORMAL' THEN 3 ELSE 4 END,
          COALESCE(decision_due_at, review_due_at) NULLS LAST,
          received_at
        LIMIT 200
      `, [...scope.values, state]);
      return rows.rows;
    });
    res.json({ data: result });
  } catch (error) { sendFailure(res, error); }
}

router.get("/institution/review-queue", (req, res) => void listCases(req, res, true));
router.get("/institution/applications", (req, res) => void listCases(req, res, false));

router.get("/institution/applications/:id", async (req, res) => {
  try {
    const id = asUuid(req.params.id);
    const result = await withInstitutionContext(req.user!.id, async (client, context) => {
      assertAnyCapability(context.capabilities, ["institution.applications.review", "institution.decisions.approve", "institution.audit.read"]);
      assertInstitutionDataScope(context.dataScopes, "application.profile");
      const application = await assertScopedCase(client, context, id);
      if (application.rowCount !== 1) throw new Error("institution_application_unavailable");
      const empty = { rows: [] as Record<string, unknown>[] };
      const [sharedEvidence, assessments, requests, decisions, offers, enrolments, events] = await Promise.all([
        hasInstitutionDataScope(context.dataScopes, "application.evidence") ? client.query(`SELECT share.id, share.requirement_code, share.content_sha256,
          share.receipt_hash, share.valid_until, share.created_at,
          eligible_requirement.id AS assessment_requirement_id,
          eligible_requirement.evidence_type AS assessment_evidence_type,
          COALESCE(latest.result='VERIFIED'
            AND upper(eligible_requirement.evidence_type)='ENROLMENT_CONFIRMATION', false)
            AS enrolment_eligible
          FROM institution_evidence_share_receipts share
          JOIN institution_application_cases case_record
            ON case_record.tenant_id=share.tenant_id
           AND case_record.relationship_id=share.relationship_id
           AND case_record.id=share.application_case_id
          LEFT JOIN LATERAL (
            SELECT requirement.id,requirement.evidence_type
            FROM institution_requirements requirement
            JOIN institution_requirement_sets requirement_set
              ON requirement_set.tenant_id=requirement.tenant_id
             AND requirement_set.id=requirement.requirement_set_id
            WHERE requirement_set.relationship_id=share.relationship_id
              AND requirement_set.program_id=case_record.program_id
              AND requirement_set.intake_key=case_record.intake_key
              AND requirement_set.state='PUBLISHED'
              AND requirement_set.effective_from IS NOT NULL
              AND requirement_set.effective_from <= now()
              AND (requirement_set.effective_until IS NULL OR requirement_set.effective_until > now())
              AND requirement.requirement_code=upper(translate(share.requirement_code,'.:-','___'))
            ORDER BY requirement_set.version_number DESC,requirement.id DESC LIMIT 1
          ) eligible_requirement ON true
          LEFT JOIN LATERAL (
            SELECT assessment.result
            FROM institution_evidence_assessments assessment
            WHERE assessment.application_case_id=share.application_case_id
              AND assessment.evidence_share_receipt_id=share.id
              AND assessment.requirement_id=eligible_requirement.id
            ORDER BY assessment.assessed_at DESC,assessment.id DESC LIMIT 1
          ) latest ON true
          WHERE share.application_case_id=$1 ORDER BY share.created_at DESC`, [id]) : Promise.resolve(empty),
        hasInstitutionDataScope(context.dataScopes, "application.evidence") ? client.query(`SELECT id, requirement_id, evidence_share_receipt_id, evidence_ref_hash, result, reason_code, notes,
          reviewer_membership_id, supersedes_assessment_id, assessed_at
          FROM institution_evidence_assessments WHERE application_case_id=$1 ORDER BY assessed_at DESC`, [id]) : Promise.resolve(empty),
        hasInstitutionDataScope(context.dataScopes, "application.communication") ? client.query(`SELECT id, requirement_code, request_code, message, status, due_at, created_at, responded_at
          FROM institution_information_requests WHERE application_case_id=$1 ORDER BY created_at DESC`, [id]) : Promise.resolve(empty),
        hasInstitutionDataScope(context.dataScopes, "application.decision") ? client.query(`SELECT id, version_number, decision_type, state, reason_code, rationale, conditions,
          maker_membership_id, checker_membership_id, created_at, submitted_at, decided_at
          FROM institution_decisions WHERE application_case_id=$1 ORDER BY version_number DESC`, [id]) : Promise.resolve(empty),
        hasInstitutionDataScope(context.dataScopes, "application.offer") ? client.query(`SELECT id, decision_id, state, conditions, acceptance_deadline, issued_at
          FROM institution_offers WHERE application_case_id=$1 ORDER BY created_at DESC`, [id]) : Promise.resolve(empty),
        hasInstitutionDataScope(context.dataScopes, "application.enrolment") ? client.query(`SELECT id, state, evidence_share_receipt_id,
          evidence_assessment_id, evidence_ref_hash, effective_at, updated_at
          FROM institution_enrolments WHERE application_case_id=$1`, [id]) : Promise.resolve(empty),
        client.query(`SELECT id, event_type, aggregate_type, aggregate_version, occurred_at
          FROM institution_admission_events WHERE application_case_id=$1 ORDER BY occurred_at DESC LIMIT 100`, [id]),
      ]);
      return {
        application: {
          ...application.rows[0],
          shared_profile: projectInstitutionSharedProfile(application.rows[0].shared_profile, context.roleKey),
        },
        sharedEvidence: sharedEvidence.rows,
        evidenceAssessments: assessments.rows,
        informationRequests: requests.rows,
        decisions: decisions.rows,
        offers: offers.rows,
        enrolments: enrolments.rows,
        events: events.rows,
      };
    });
    res.json(result);
  } catch (error) { sendFailure(res, error); }
});

router.post("/institution/applications/:id/claim", async (req, res) => {
  try {
    const id = asUuid(req.params.id);
    const result = await withInstitutionContext(req.user!.id, async (client, context) => {
      assertCapability(context.capabilities, "institution.applications.review");
      assertInstitutionDataScope(context.dataScopes, "application.profile");
      const current = await assertScopedCase(client, context, id, true);
      if (current.rowCount !== 1) throw new Error("institution_application_unavailable");
      if (!["RECEIVED", "REVIEWING"].includes(current.rows[0].lifecycle_state)) {
        throw new Error("institution_case_not_claimable");
      }
      const nextState = current.rows[0].lifecycle_state === "RECEIVED" ? "REVIEWING" : "REVIEWING";
      const version = Number(current.rows[0].aggregate_version) + 1;
      const updated = await client.query(`UPDATE institution_application_cases
        SET assigned_reviewer_membership_id=$2, lifecycle_state=$3, aggregate_version=$4
        WHERE id=$1 RETURNING id, lifecycle_state, assigned_reviewer_membership_id, aggregate_version`,
      [id, context.membershipId, nextState, version]);
      await appendEvent(client, context, {
        applicationCaseId: id, eventType: "institution.application.claimed.v1",
        aggregateType: "APPLICATION_CASE", aggregateId: id, aggregateVersion: version,
      });
      return updated.rows[0];
    });
    res.json(result);
  } catch (error) { sendFailure(res, error); }
});

router.post("/institution/applications/:id/evidence-assessments", async (req, res) => {
  try {
    const caseId = asUuid(req.params.id);
    const requirementId = asUuid(req.body?.requirementId);
    const evidenceShareReceiptId = asUuid(req.body?.evidenceShareReceiptId);
    const resultCode = asText(req.body?.result, 32).toUpperCase();
    if (!["PENDING", "VERIFIED", "NEEDS_INFORMATION", "REJECTED"].includes(resultCode)) {
      throw new Error("institution_evidence_result_invalid");
    }
    const reasonCode = asCode(req.body?.reasonCode);
    const notes = asOptionalText(req.body?.notes, 2_000);
    const supersedesId = req.body?.supersedesAssessmentId == null ? null : asUuid(req.body.supersedesAssessmentId);
    const result = await withInstitutionContext(req.user!.id, async (client, context) => {
      assertCapability(context.capabilities, "institution.evidence.assess");
      assertInstitutionDataScope(context.dataScopes, "application.evidence");
      const application = await assertScopedCase(client, context, caseId, true);
      if (application.rowCount !== 1) throw new Error("institution_application_unavailable");
      const share = await client.query<{ evidence_ref_hash: string }>(
        `SELECT evidence_ref_hash
         FROM fas_institution_evidence_v1.resolve_assessable_share(
           $1::uuid,$2::uuid,$3::uuid,$4::uuid,now()
         )`,
        [context.tenantId, context.relationshipId, caseId, evidenceShareReceiptId],
      );
      if (share.rowCount !== 1 || !HASH_RE.test(share.rows[0]?.evidence_ref_hash ?? "")) {
        throw new Error("institution_evidence_share_unavailable");
      }
      const evidenceRefHash = share.rows[0].evidence_ref_hash;
      const id = nextInstitutionId();
      const hash = institutionHash({ caseId, requirementId, evidenceShareReceiptId, evidenceRefHash, resultCode, reasonCode, notes, supersedesId });
      const inserted = await client.query(`INSERT INTO institution_evidence_assessments (
        id,tenant_id,relationship_id,application_case_id,requirement_id,
        evidence_share_receipt_id,evidence_ref_hash,result,reason_code,notes,
        reviewer_membership_id,supersedes_assessment_id,assessment_hash
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING id,evidence_share_receipt_id,result,reason_code,assessed_at`,
      [id, context.tenantId, context.relationshipId, caseId, requirementId,
        evidenceShareReceiptId, evidenceRefHash, resultCode, reasonCode, notes,
        context.membershipId, supersedesId, hash]);
      await appendEvent(client, context, {
        applicationCaseId: caseId, eventType: "institution.evidence.assessed.v1",
        aggregateType: "EVIDENCE_ASSESSMENT", aggregateId: id, aggregateVersion: 1,
        payload: { result: resultCode, reasonCode },
      });
      return inserted.rows[0];
    });
    res.status(201).json(result);
  } catch (error) { sendFailure(res, error); }
});

router.post("/institution/applications/:id/information-requests", async (req, res) => {
  try {
    const caseId = asUuid(req.params.id);
    const requirementCode = asCode(req.body?.requirementCode);
    const requestCode = asCode(req.body?.requestCode);
    const message = asText(req.body?.message, 2_000);
    const dueAt = asIsoDate(req.body?.dueAt);
    const result = await withInstitutionContext(req.user!.id, async (client, context) => {
      assertCapability(context.capabilities, "institution.information.request");
      assertInstitutionDataScope(context.dataScopes, "application.communication");
      const application = await assertScopedCase(client, context, caseId, true);
      if (application.rowCount !== 1) throw new Error("institution_application_unavailable");
      if (!["REVIEWING", "INFORMATION_REQUESTED"].includes(application.rows[0].lifecycle_state)) {
        throw new Error("institution_case_not_reviewing");
      }
      const id = nextInstitutionId();
      await client.query(`INSERT INTO institution_information_requests (
        id,tenant_id,relationship_id,application_case_id,requirement_code,request_code,
        message,created_by_membership_id,due_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id,context.tenantId,context.relationshipId,
        caseId,requirementCode,requestCode,message,context.membershipId,dueAt]);
      if (application.rows[0].lifecycle_state === "REVIEWING") {
        await client.query(`UPDATE institution_application_cases SET lifecycle_state='INFORMATION_REQUESTED',
          aggregate_version=aggregate_version+1 WHERE id=$1`, [caseId]);
      } else {
        await client.query(`UPDATE institution_application_cases SET aggregate_version=aggregate_version+1 WHERE id=$1`, [caseId]);
      }
      const version = Number(application.rows[0].aggregate_version) + 1;
      await appendEvent(client, context, {
        applicationCaseId: caseId, eventType: "institution.information.requested.v1",
        aggregateType: "INFORMATION_REQUEST", aggregateId: id, aggregateVersion: 1,
        payload: { requirementCode, requestCode, delivery: "NOT_DISPATCHED" },
      });
      return { id, status: "OPEN", caseVersion: version, delivery: "NOT_DISPATCHED" };
    });
    res.status(201).json(result);
  } catch (error) { sendFailure(res, error); }
});

router.post("/institution/applications/:id/ready-for-decision", async (req, res) => {
  try {
    const caseId = asUuid(req.params.id);
    const result = await withInstitutionContext(req.user!.id, async (client, context) => {
      assertCapability(context.capabilities, "institution.applications.review");
      assertCapability(context.capabilities, "institution.evidence.assess");
      assertInstitutionDataScope(context.dataScopes, "application.evidence");
      assertInstitutionDataScope(context.dataScopes, "application.decision");
      const application = await assertScopedCase(client, context, caseId, true);
      if (application.rowCount !== 1 || !["REVIEWING", "INFORMATION_REQUESTED"].includes(application.rows[0].lifecycle_state)) {
        throw new Error("institution_case_not_reviewing");
      }
      const proof = await client.query<{ verified: string; unresolved: string; open_requests: string }>(`
        WITH latest AS (
          SELECT DISTINCT ON (evidence_ref_hash) evidence_ref_hash, result
          FROM institution_evidence_assessments
          WHERE application_case_id=$1
          ORDER BY evidence_ref_hash, assessed_at DESC, id DESC
        )
        SELECT
          count(*) FILTER (WHERE result='VERIFIED') AS verified,
          count(*) FILTER (WHERE result<>'VERIFIED') AS unresolved,
          (SELECT count(*) FROM institution_information_requests
           WHERE application_case_id=$1 AND status = 'OPEN') AS open_requests
        FROM latest
      `, [caseId]);
      if (Number(proof.rows[0].verified) < 1 || Number(proof.rows[0].unresolved) > 0 || Number(proof.rows[0].open_requests) > 0) {
        throw new Error("institution_verified_evidence_required");
      }
      const version = Number(application.rows[0].aggregate_version) + 1;
      await client.query(`UPDATE institution_application_cases SET lifecycle_state='READY_FOR_DECISION',
        readiness_percent=100,blocker_code=NULL,aggregate_version=$2 WHERE id=$1`, [caseId,version]);
      await appendEvent(client,context,{applicationCaseId:caseId,eventType:"institution.application.ready_for_decision.v1",
        aggregateType:"APPLICATION_CASE",aggregateId:caseId,aggregateVersion:version,
        payload:{verifiedEvidenceCount:Number(proof.rows[0].verified)}});
      return {id:caseId,lifecycleState:"READY_FOR_DECISION",aggregateVersion:version};
    });
    res.json(result);
  } catch(error){sendFailure(res,error);}
});

router.post("/institution/applications/:id/decisions", async (req, res) => {
  try {
    const caseId = asUuid(req.params.id);
    const decisionType = asText(req.body?.decisionType, 32).toUpperCase();
    if (!["WAITLISTED","CONDITIONAL_OFFER","UNCONDITIONAL_OFFER","REJECTED"].includes(decisionType)) {
      throw new Error("institution_decision_type_invalid");
    }
    const reasonCode = asCode(req.body?.reasonCode);
    const rationale = asText(req.body?.rationale, 4_000);
    const conditions = Array.isArray(req.body?.conditions) ? req.body.conditions.slice(0, 50) : [];
    const result = await withInstitutionContext(req.user!.id, async (client, context) => {
      assertCapability(context.capabilities, "institution.decisions.draft");
      assertInstitutionDataScope(context.dataScopes, "application.decision");
      const application = await assertScopedCase(client, context, caseId, true);
      if (application.rowCount !== 1) throw new Error("institution_application_unavailable");
      if (application.rows[0].lifecycle_state !== "READY_FOR_DECISION") throw new Error("institution_case_not_ready");
      const versionRow = await client.query<{ next_version: string }>(`SELECT COALESCE(max(version_number),0)+1 AS next_version
        FROM institution_decisions WHERE application_case_id=$1`, [caseId]);
      const version = Number(versionRow.rows[0].next_version);
      const id = nextInstitutionId();
      const contentHash = institutionHash({ caseId, version, decisionType, reasonCode, rationale, conditions });
      const inserted = await client.query(`INSERT INTO institution_decisions (
        id,tenant_id,relationship_id,application_case_id,version_number,decision_type,
        reason_code,rationale,conditions,maker_membership_id,content_hash
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)
      RETURNING id,version_number,decision_type,state,created_at`, [id,context.tenantId,context.relationshipId,
        caseId,version,decisionType,reasonCode,rationale,JSON.stringify(conditions),context.membershipId,contentHash]);
      await appendEvent(client, context, { applicationCaseId: caseId,
        eventType: "institution.decision.drafted.v1", aggregateType: "DECISION",
        aggregateId: id, aggregateVersion: version, payload: { decisionType, reasonCode } });
      return inserted.rows[0];
    });
    res.status(201).json(result);
  } catch (error) { sendFailure(res, error); }
});

router.post("/institution/decisions/:id/submit", async (req, res) => {
  try {
    const id = asUuid(req.params.id);
    const result = await withInstitutionContext(req.user!.id, async (client, context) => {
      assertCapability(context.capabilities, "institution.decisions.draft");
      assertInstitutionDataScope(context.dataScopes, "application.decision");
      const decision = await client.query(`SELECT * FROM institution_decisions WHERE id=$1 FOR UPDATE`, [id]);
      if (decision.rowCount !== 1 || decision.rows[0].maker_membership_id !== context.membershipId) {
        throw new Error("institution_decision_unavailable");
      }
      if (decision.rows[0].state !== "DRAFT") throw new Error("institution_decision_not_draft");
      const application = await assertScopedCase(client, context, decision.rows[0].application_case_id, true);
      if (application.rowCount !== 1 || application.rows[0].lifecycle_state !== "READY_FOR_DECISION") {
        throw new Error("institution_case_not_ready");
      }
      await client.query(`UPDATE institution_decisions SET state='SUBMITTED',submitted_at=now() WHERE id=$1`, [id]);
      const caseVersion = Number(application.rows[0].aggregate_version) + 1;
      await client.query(`UPDATE institution_application_cases SET lifecycle_state='DECISION_PENDING_APPROVAL',
        aggregate_version=$2 WHERE id=$1`, [decision.rows[0].application_case_id, caseVersion]);
      await appendEvent(client, context, { applicationCaseId: decision.rows[0].application_case_id,
        eventType: "institution.decision.submitted.v1", aggregateType: "DECISION",
        aggregateId: id, aggregateVersion: Number(decision.rows[0].version_number) });
      return { id, state: "SUBMITTED" };
    });
    res.json(result);
  } catch (error) { sendFailure(res, error); }
});

router.get("/institution/decisions", async (req, res) => {
  try {
    const data = await withInstitutionContext(req.user!.id, async (client, context) => {
      assertAnyCapability(context.capabilities, ["institution.decisions.draft", "institution.decisions.approve", "institution.audit.read"]);
      assertInstitutionDataScope(context.dataScopes, "application.decision");
      const rows = await client.query(`SELECT d.id,d.application_case_id,d.version_number,d.decision_type,
        d.state,d.reason_code,d.maker_membership_id,d.checker_membership_id,d.created_at,d.submitted_at,d.decided_at,
        c.masked_student_ref,c.program_id,c.intake_key
        FROM institution_decisions d JOIN institution_application_cases c ON c.id=d.application_case_id
        WHERE (cardinality($1::integer[])=0 OR c.program_id=ANY($1::integer[]))
          AND (cardinality($2::text[])=0 OR c.intake_key=ANY($2::text[]))
        ORDER BY COALESCE(d.submitted_at,d.created_at) DESC LIMIT 200`, [context.programScopeIds, context.intakeScopes]);
      return rows.rows;
    });
    res.json({ data });
  } catch (error) { sendFailure(res, error); }
});

async function decide(req: Request, res: Response, outcome: "APPROVED" | "RETURNED" | "REJECTED") {
  try {
    const id = asUuid(req.params.id);
    const reasonCode = asCode(req.body?.reasonCode ?? outcome);
    const comment = asOptionalText(req.body?.comment, 2_000);
    const requestHash = institutionHash({ operation:`DECISION_${outcome}`,id,reasonCode,comment });
    const result = await withInstitutionContext(req.user!.id, async (client, context) => {
      assertCapability(context.capabilities, "institution.decisions.approve");
      assertInstitutionDataScope(context.dataScopes, "application.decision");
      const decision = await client.query(`SELECT * FROM institution_decisions WHERE id=$1 FOR UPDATE`, [id]);
      if (decision.rowCount !== 1 || decision.rows[0].state !== "SUBMITTED") {
        throw new Error("institution_decision_unavailable");
      }
      assertIndependentChecker(decision.rows[0].maker_membership_id, context.membershipId);
      const application = await assertScopedCase(client, context, decision.rows[0].application_case_id, true);
      if (application.rowCount !== 1 || application.rows[0].lifecycle_state !== "DECISION_PENDING_APPROVAL") {
        throw new Error("institution_case_not_pending_approval");
      }
      const authorization = await authorizeInstitutionRouteMutation({
        request:req,client,context,capabilityKey:"institution.decisions.approve",
        requiredDataScope:"application.decision",resourceType:"institution_decision",
        resourceId:id,requestHash,approvalSatisfied:true,
      });
      const approvalId = nextInstitutionId();
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 1))", [context.relationshipId]);
      const previous = await client.query<{ receipt_hash: string }>(`SELECT receipt_hash FROM institution_decision_approvals
        ORDER BY created_at DESC,id DESC LIMIT 1`);
      const previousHash = previous.rows[0]?.receipt_hash ?? null;
      const receiptHash = institutionHash({ approvalId, decisionId:id, checker:context.membershipId,
        outcome, reasonCode, comment, previousHash });
      await client.query(`INSERT INTO institution_decision_approvals (
        id,tenant_id,relationship_id,decision_id,checker_membership_id,outcome,
        reason_code,comment,previous_hash,receipt_hash
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [approvalId,context.tenantId,
        context.relationshipId,id,context.membershipId,outcome,reasonCode,comment,previousHash,receiptHash]);
      await client.query(`UPDATE institution_decisions SET state=$2,checker_membership_id=$3,
        decided_at=CASE WHEN $2='APPROVED' THEN now() ELSE decided_at END,
        effective_at=CASE WHEN $2='APPROVED' THEN now() ELSE effective_at END WHERE id=$1`,
      [id,outcome,context.membershipId]);
      const caseState = outcome === "APPROVED" ? "DECIDED" : "READY_FOR_DECISION";
      const caseVersion = Number(application.rows[0].aggregate_version) + 1;
      await client.query(`UPDATE institution_application_cases SET lifecycle_state=$2,
        aggregate_version=$3 WHERE id=$1`, [decision.rows[0].application_case_id,caseState,caseVersion]);
      let offerId: string | null = null;
      if (outcome === "APPROVED" && ["CONDITIONAL_OFFER","UNCONDITIONAL_OFFER"].includes(decision.rows[0].decision_type)) {
        offerId = nextInstitutionId();
        await client.query(`INSERT INTO institution_offers (
          id,tenant_id,relationship_id,application_case_id,decision_id,conditions
        ) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`, [offerId,context.tenantId,context.relationshipId,
          decision.rows[0].application_case_id,id,JSON.stringify(decision.rows[0].conditions ?? [])]);
      }
      await appendEvent(client, context, { applicationCaseId: decision.rows[0].application_case_id,
        eventType: `institution.decision.${outcome.toLowerCase()}.v1`, aggregateType: "DECISION",
        aggregateId: id, aggregateVersion: Number(decision.rows[0].version_number),
        payload: { reasonCode, approvalReceiptHash: receiptHash,
          authorizationReceiptId:authorization.authorizationReceiptId } });
      return { id, state: outcome, offerId, approvalReceiptHash: receiptHash,
        authorizationReceiptId:authorization.authorizationReceiptId };
    });
    res.json(result);
  } catch (error) { sendFailure(res, error); }
}

router.post("/institution/decisions/:id/approve", (req,res) => void decide(req,res,"APPROVED"));
router.post("/institution/decisions/:id/return", (req,res) => void decide(req,res,"RETURNED"));
router.post("/institution/decisions/:id/reject", (req,res) => void decide(req,res,"REJECTED"));

router.get("/institution/offers", async (req, res) => {
  try {
    const data = await withInstitutionContext(req.user!.id, async (client, context) => {
      assertAnyCapability(context.capabilities, ["institution.offers.issue", "institution.enrolment.confirm", "institution.audit.read"]);
      assertInstitutionDataScope(context.dataScopes, "application.offer");
      const rows = await client.query(`SELECT o.id,o.application_case_id,o.decision_id,o.state,o.conditions,
        o.acceptance_deadline,o.issued_at,c.masked_student_ref,c.program_id,c.intake_key
        FROM institution_offers o JOIN institution_application_cases c ON c.id=o.application_case_id
        WHERE (cardinality($1::integer[])=0 OR c.program_id=ANY($1::integer[]))
          AND (cardinality($2::text[])=0 OR c.intake_key=ANY($2::text[]))
        ORDER BY o.created_at DESC LIMIT 200`, [context.programScopeIds,context.intakeScopes]);
      return rows.rows;
    });
    res.json({ data });
  } catch (error) { sendFailure(res, error); }
});

router.post("/institution/offers/:id/issue", async (req, res) => {
  try {
    const id = asUuid(req.params.id);
    const acceptanceDeadline = asIsoDate(req.body?.acceptanceDeadline);
    const requestHash = institutionHash({operation:"OFFER_ISSUE",id,
      acceptanceDeadline:acceptanceDeadline?.toISOString() ?? null});
    const result = await withInstitutionContext(req.user!.id, async (client, context) => {
      assertCapability(context.capabilities, "institution.offers.issue");
      assertInstitutionDataScope(context.dataScopes, "application.offer");
      const offer = await client.query(`SELECT o.*,d.state AS decision_state,d.decision_type
        FROM institution_offers o JOIN institution_decisions d ON d.id=o.decision_id
        WHERE o.id=$1 FOR UPDATE OF o`, [id]);
      if (offer.rowCount !== 1 || offer.rows[0].state !== "DRAFT") throw new Error("institution_offer_unavailable");
      assertDecisionCanCreateOffer({ state:offer.rows[0].decision_state, decisionType:offer.rows[0].decision_type });
      const application = await assertScopedCase(client, context, offer.rows[0].application_case_id, true);
      if (application.rowCount !== 1 || application.rows[0].lifecycle_state !== "DECIDED") {
        throw new Error("institution_case_not_decided");
      }
      const authorization = await authorizeInstitutionRouteMutation({
        request:req,client,context,capabilityKey:"institution.offers.issue",
        requiredDataScope:"application.offer",resourceType:"institution_offer",
        resourceId:id,requestHash,approvalSatisfied:true,
      });
      const receiptHash = institutionHash({ offerId:id, decisionId:offer.rows[0].decision_id,
        issuer:context.membershipId, acceptanceDeadline:acceptanceDeadline?.toISOString() ?? null });
      await client.query(`UPDATE institution_offers SET state='ISSUED',acceptance_deadline=$2,
        issued_by_membership_id=$3,receipt_hash=$4,issued_at=now(),updated_at=now() WHERE id=$1`,
      [id,acceptanceDeadline,context.membershipId,receiptHash]);
      const caseVersion = Number(application.rows[0].aggregate_version) + 1;
      await client.query(`UPDATE institution_application_cases SET lifecycle_state='OFFER_ISSUED',
        aggregate_version=$2 WHERE id=$1`, [offer.rows[0].application_case_id,caseVersion]);
      await appendEvent(client, context, { applicationCaseId:offer.rows[0].application_case_id,
        eventType:"institution.offer.issued.v1",aggregateType:"OFFER",aggregateId:id,aggregateVersion:1,
        payload:{ receiptHash, delivery:"NOT_DISPATCHED",
          authorizationReceiptId:authorization.authorizationReceiptId } });
      return { id,state:"ISSUED",receiptHash,delivery:"NOT_DISPATCHED",
        authorizationReceiptId:authorization.authorizationReceiptId };
    });
    res.json(result);
  } catch (error) { sendFailure(res, error); }
});

router.post("/institution/applications/:id/enrolment", async (req, res) => {
  try {
    const caseId = asUuid(req.params.id);
    const state = asText(req.body?.state, 32).toUpperCase();
    if (!["PENDING_EVIDENCE","CONFIRMED","DEFERRED","NOT_ENROLLED"].includes(state)) {
      throw new Error("institution_enrolment_state_invalid");
    }
    if (req.body?.evidenceRefHash != null) throw new Error("institution_enrolment_raw_evidence_hash_forbidden");
    const evidenceShareReceiptId = state === "CONFIRMED"
      ? asUuid(req.body?.evidenceShareReceiptId)
      : null;
    if (state !== "CONFIRMED" && req.body?.evidenceShareReceiptId != null) {
      throw new Error("institution_enrolment_evidence_receipt_unexpected");
    }
    const requestHash = institutionHash({operation:"ENROLMENT_TRANSITION",caseId,state,evidenceShareReceiptId});
    const result = await withInstitutionContext(req.user!.id, async (client, context) => {
      assertCapability(context.capabilities, "institution.enrolment.confirm");
      assertInstitutionDataScope(context.dataScopes, "application.enrolment");
      const application = await assertScopedCase(client, context, caseId, true);
      if (application.rowCount !== 1 || !["OFFER_ISSUED","ENROLMENT_PENDING"].includes(application.rows[0].lifecycle_state)) {
        throw new Error("institution_case_not_enrolment_ready");
      }
      const authorization = await authorizeInstitutionRouteMutation({
        request:req,client,context,capabilityKey:"institution.enrolment.confirm",
        requiredDataScope:"application.enrolment",resourceType:"institution_application",resourceId:caseId,requestHash,
        approvalSatisfied:true,
      });
      let evidenceRefHash: string | null = null;
      let evidenceAssessmentId: string | null = null;
      let sourceShareReceiptHash: string | null = null;
      let sourceAssessmentHash: string | null = null;
      if (state === "CONFIRMED") {
        const evidence = await client.query<{
          evidence_ref_hash: string;
          share_receipt_hash: string;
          evidence_assessment_id: string;
          evidence_assessment_hash: string;
        }>(`SELECT * FROM fas_institution_evidence_v1.resolve_enrolment_confirmation(
          $1::uuid,$2::uuid,$3::uuid,$4::uuid,now()
        )`, [context.tenantId,context.relationshipId,caseId,evidenceShareReceiptId]);
        if (evidence.rowCount !== 1
          || !HASH_RE.test(evidence.rows[0]?.evidence_ref_hash ?? "")
          || !HASH_RE.test(evidence.rows[0]?.share_receipt_hash ?? "")
          || !UUID_RE.test(evidence.rows[0]?.evidence_assessment_id ?? "")
          || !HASH_RE.test(evidence.rows[0]?.evidence_assessment_hash ?? "")) {
          throw new Error("institution_enrolment_evidence_unavailable");
        }
        evidenceRefHash = evidence.rows[0].evidence_ref_hash;
        evidenceAssessmentId = evidence.rows[0].evidence_assessment_id;
        sourceShareReceiptHash = evidence.rows[0].share_receipt_hash;
        sourceAssessmentHash = evidence.rows[0].evidence_assessment_hash;
      }
      const existing = await client.query(`SELECT * FROM institution_enrolments WHERE application_case_id=$1 FOR UPDATE`, [caseId]);
      const id = existing.rows[0]?.id ?? nextInstitutionId();
      const receiptHash = state === "CONFIRMED" ? institutionHash({
        caseId,evidenceShareReceiptId,evidenceAssessmentId,evidenceRefHash,
        sourceShareReceiptHash,sourceAssessmentHash,verifier:context.membershipId,
      }) : null;
      if (existing.rowCount === 0) {
        await client.query(`INSERT INTO institution_enrolments (
          id,tenant_id,relationship_id,application_case_id,state,
          evidence_share_receipt_id,evidence_assessment_id,evidence_ref_hash,
          verified_by_membership_id,receipt_hash,effective_at
        ) VALUES ($1,$2,$3,$4,'PENDING_EVIDENCE',NULL,NULL,NULL,NULL,NULL,NULL)`, [id,context.tenantId,context.relationshipId,caseId]);
        if (state !== "PENDING_EVIDENCE") {
          await client.query(`UPDATE institution_enrolments SET state=$2,
            evidence_share_receipt_id=$3,evidence_assessment_id=$4,evidence_ref_hash=$5,
            verified_by_membership_id=$6,receipt_hash=$7,effective_at=$8,
            version=version+1 WHERE id=$1`,
          [id,state,evidenceShareReceiptId,evidenceAssessmentId,evidenceRefHash,
            state === "CONFIRMED" ? context.membershipId : null,receiptHash,
            state === "CONFIRMED" ? new Date() : null]);
        }
      } else {
        await client.query(`UPDATE institution_enrolments SET state=$2,
          evidence_share_receipt_id=$3,evidence_assessment_id=$4,evidence_ref_hash=$5,
          verified_by_membership_id=$6,receipt_hash=$7,effective_at=$8,
          version=version+1,updated_at=now() WHERE id=$1`,
        [id,state,evidenceShareReceiptId,evidenceAssessmentId,evidenceRefHash,
          state==="CONFIRMED"?context.membershipId:null,receiptHash,
          state==="CONFIRMED"?new Date():null]);
      }
      let caseVersion = Number(application.rows[0].aggregate_version);
      if (application.rows[0].lifecycle_state === "OFFER_ISSUED") {
        caseVersion += 1;
        await client.query(`UPDATE institution_application_cases SET lifecycle_state='ENROLMENT_PENDING',
          aggregate_version=$2 WHERE id=$1`, [caseId,caseVersion]);
      }
      if (state === "CONFIRMED") {
        caseVersion += 1;
        await client.query(`UPDATE institution_application_cases SET lifecycle_state='ENROLLED',
          aggregate_version=$2,closed_at=now() WHERE id=$1`, [caseId,caseVersion]);
      }
      await appendEvent(client, context, { applicationCaseId:caseId,
        eventType:`institution.enrolment.${state.toLowerCase()}.v1`,aggregateType:"ENROLMENT",
        aggregateId:id,aggregateVersion:Number(existing.rows[0]?.version ?? 0)+1,
        payload:{ evidenceShareReceiptId:state==="CONFIRMED"?evidenceShareReceiptId:null,
          evidenceAssessmentId:state==="CONFIRMED"?evidenceAssessmentId:null,receiptHash,
          authorizationReceiptId:authorization.authorizationReceiptId } });
      return { id,state,evidenceShareReceiptId,evidenceAssessmentId,receiptHash,
        authorizationReceiptId:authorization.authorizationReceiptId };
    });
    res.json(result);
  } catch (error) { sendFailure(res, error); }
});

router.get("/institution/programs-intakes", async (req, res) => {
  try {
    const result = await withInstitutionContext(req.user!.id, async (client, context) => {
      assertCapability(context.capabilities,"institution.catalog.manage");
      assertInstitutionDataScope(context.dataScopes, "catalog.programs");
      const [rows, requests] = await Promise.all([
        client.query(`SELECT id,name,degree,field,language,duration,intakes,quota,is_active
        FROM programs WHERE university_id=$1
          AND (cardinality($2::integer[])=0 OR id=ANY($2::integer[]))
        ORDER BY name LIMIT 1000`, [context.institutionId,context.programScopeIds]),
        client.query(`SELECT id,aggregate_id,payload,occurred_at
          FROM institution_admission_events
          WHERE aggregate_type='CATALOG_CHANGE_REQUEST'
          ORDER BY occurred_at DESC LIMIT 100`),
      ]);
      return { data: rows.rows, changeRequests: requests.rows };
    });
    res.json(result);
  } catch (error) { sendFailure(res, error); }
});

router.post("/institution/programs-intakes/:id/change-requests", async (req,res)=>{
  try{
    const id=asPositiveInt(req.params.id);
    const quota=req.body?.quota==null?null:asPositiveInt(req.body.quota);
    const intakes=asOptionalText(req.body?.intakes,1000);
    const isActive=typeof req.body?.isActive==="boolean"?req.body.isActive:null;
    if(quota===null&&intakes===null&&isActive===null) throw new Error("institution_program_update_invalid");
    const result=await withInstitutionContext(req.user!.id,async(client,context)=>{
      assertCapability(context.capabilities,"institution.catalog.manage");
      assertInstitutionDataScope(context.dataScopes, "catalog.programs");
      if(context.programScopeIds.length&&!context.programScopeIds.includes(id)) throw new Error("institution_program_scope_denied");
      const program=await client.query(`SELECT id,name,intakes,quota,is_active FROM programs
        WHERE id=$1 AND university_id=$2`,[id,context.institutionId]);
      if(program.rowCount!==1) throw new Error("institution_program_unavailable");
      const requestId=nextInstitutionId();
      const requestedPatch={quota,intakes,isActive};
      const receipt=await appendEvent(client,context,{eventType:"institution.catalog.change_requested.v1",
        aggregateType:"CATALOG_CHANGE_REQUEST",aggregateId:requestId,aggregateVersion:1,
        payload:{programId:id,baseline:program.rows[0],requestedPatch,status:"PENDING_INTERNAL_CHANGESET",
          contentHash:institutionHash({programId:id,baseline:program.rows[0],requestedPatch})}});
      return {id:requestId,programId:id,status:"PENDING_INTERNAL_CHANGESET",receiptHash:receipt.eventHash};
    });
    res.status(202).json(result);
  }catch(error){sendFailure(res,error);}
});

router.get("/institution/requirements", async (req, res) => {
  try {
    const data = await withInstitutionContext(req.user!.id, async (client, context) => {
      assertAnyCapability(context.capabilities,["institution.requirements.manage","institution.audit.read"]);
      assertInstitutionDataScope(context.dataScopes, "catalog.requirements");
      const rows = await client.query(`SELECT s.id,s.program_id,p.name AS program_name,s.intake_key,
        s.version_number,s.state,s.source_ref,s.effective_from,s.effective_until,s.created_at,s.published_at,
        COALESCE(jsonb_agg(jsonb_build_object('id',r.id,'code',r.requirement_code,'title',r.title,
          'evidenceType',r.evidence_type,'mandatory',r.mandatory,'rule',r.rule,'sortOrder',r.sort_order)
          ORDER BY r.sort_order) FILTER (WHERE r.id IS NOT NULL),'[]'::jsonb) AS requirements
        FROM institution_requirement_sets s JOIN programs p ON p.id=s.program_id
        LEFT JOIN institution_requirements r ON r.requirement_set_id=s.id AND r.tenant_id=s.tenant_id
        WHERE (cardinality($1::integer[])=0 OR s.program_id=ANY($1::integer[]))
          AND (cardinality($2::text[])=0 OR s.intake_key=ANY($2::text[]))
        GROUP BY s.id,p.name ORDER BY s.created_at DESC LIMIT 300`, [context.programScopeIds,context.intakeScopes]);
      return rows.rows;
    });
    res.json({ data });
  } catch (error) { sendFailure(res, error); }
});

router.post("/institution/requirements", async (req, res) => {
  try {
    const programId = asPositiveInt(req.body?.programId);
    const intakeKey = asText(req.body?.intakeKey, 120);
    const sourceRef = asText(req.body?.sourceRef, 500);
    const sourceText = asText(req.body?.sourceText, 50_000);
    const sourceHash = institutionHash({ sourceRef, sourceText });
    const items = Array.isArray(req.body?.requirements) ? req.body.requirements.slice(0, 200) : [];
    if (items.length === 0) throw new Error("institution_requirements_invalid");
    const cleaned = items.map((item: any, index: number) => ({
      code: asCode(item?.code), title: asText(item?.title, 500), evidenceType: asText(item?.evidenceType, 100),
      mandatory: item?.mandatory !== false, rule: item?.rule && typeof item.rule === "object" ? item.rule : {}, sortOrder:index,
    }));
    const result = await withInstitutionContext(req.user!.id, async (client, context) => {
      assertCapability(context.capabilities,"institution.requirements.manage");
      assertInstitutionDataScope(context.dataScopes, "catalog.requirements");
      if (context.programScopeIds.length && !context.programScopeIds.includes(programId)) throw new Error("institution_program_scope_denied");
      if (context.intakeScopes.length && !context.intakeScopes.includes(intakeKey)) throw new Error("institution_intake_scope_denied");
      const program = await client.query(`SELECT id FROM programs WHERE id=$1 AND university_id=$2`,[programId,context.institutionId]);
      if (program.rowCount !== 1) throw new Error("institution_program_unavailable");
      const versionRow = await client.query<{ next_version:string }>(`SELECT COALESCE(max(version_number),0)+1 AS next_version
        FROM institution_requirement_sets WHERE program_id=$1 AND intake_key=$2`,[programId,intakeKey]);
      const version = Number(versionRow.rows[0].next_version);
      const id = nextInstitutionId();
      const contentHash = institutionHash({ programId,intakeKey,version,sourceHash,items:cleaned });
      await client.query(`INSERT INTO institution_requirement_sets (
        id,tenant_id,relationship_id,program_id,intake_key,version_number,source_ref,
        source_hash,content_hash,created_by_membership_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[id,context.tenantId,context.relationshipId,
        programId,intakeKey,version,sourceRef,sourceHash,contentHash,context.membershipId]);
      for (const item of cleaned) {
        await client.query(`INSERT INTO institution_requirements (
          id,tenant_id,requirement_set_id,requirement_code,title,evidence_type,mandatory,rule,sort_order
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,[nextInstitutionId(),context.tenantId,id,item.code,
          item.title,item.evidenceType,item.mandatory,JSON.stringify(item.rule),item.sortOrder]);
      }
      await appendEvent(client,context,{eventType:"institution.requirements.drafted.v1",aggregateType:"REQUIREMENT_SET",
        aggregateId:id,aggregateVersion:version,payload:{programId,intakeKey,itemCount:cleaned.length}});
      return {id,version,state:"DRAFT",contentHash};
    });
    res.status(201).json(result);
  } catch (error) { sendFailure(res,error); }
});

router.post("/institution/requirements/:id/submit", async (req,res) => {
  try {
    const id=asUuid(req.params.id);
    const result=await withInstitutionContext(req.user!.id,async(client,context)=>{
      assertCapability(context.capabilities,"institution.requirements.manage");
      assertInstitutionDataScope(context.dataScopes, "catalog.requirements");
      const updated=await client.query(`UPDATE institution_requirement_sets SET state='IN_REVIEW'
        WHERE id=$1 AND state='DRAFT' AND created_by_membership_id=$2 RETURNING id,state,version_number`,[id,context.membershipId]);
      if(updated.rowCount!==1) throw new Error("institution_requirement_set_unavailable");
      return updated.rows[0];
    });
    res.json(result);
  } catch(error){sendFailure(res,error);}
});

router.post("/institution/requirements/:id/publish", async (req,res) => {
  try {
    const id=asUuid(req.params.id);
    const effectiveFrom=asIsoDate(req.body?.effectiveFrom) ?? new Date();
    const requestHash=institutionHash({operation:"REQUIREMENT_PUBLISH",id,
      effectiveFrom:effectiveFrom.toISOString()});
    const result=await withInstitutionContext(req.user!.id,async(client,context)=>{
      assertCapability(context.capabilities,"institution.requirements.manage");
      assertInstitutionDataScope(context.dataScopes, "catalog.requirements");
      const current=await client.query(`SELECT * FROM institution_requirement_sets WHERE id=$1 FOR UPDATE`,[id]);
      if(current.rowCount!==1||current.rows[0].state!=="IN_REVIEW") throw new Error("institution_requirement_set_unavailable");
      assertIndependentChecker(current.rows[0].created_by_membership_id,context.membershipId);
      const authorization=await authorizeInstitutionRouteMutation({
        request:req,client,context,capabilityKey:"institution.requirements.manage",
        requiredDataScope:"catalog.requirements",resourceType:"institution_requirement_set",
        resourceId:id,requestHash,approvalSatisfied:true,
      });
      const updated=await client.query(`UPDATE institution_requirement_sets SET state='PUBLISHED',
        approved_by_membership_id=$2,published_at=now(),effective_from=$3 WHERE id=$1
        RETURNING id,state,version_number,published_at,effective_from`,[id,context.membershipId,effectiveFrom]);
      await appendEvent(client,context,{eventType:"institution.requirements.published.v1",aggregateType:"REQUIREMENT_SET",
        aggregateId:id,aggregateVersion:Number(current.rows[0].version_number),payload:{
          effectiveFrom:effectiveFrom.toISOString(),authorizationReceiptId:authorization.authorizationReceiptId}});
      return {...updated.rows[0],authorizationReceiptId:authorization.authorizationReceiptId};
    });
    res.json(result);
  }catch(error){sendFailure(res,error);}
});

router.get("/institution/sla", async(req,res)=>{
  try{
    const data=await withInstitutionContext(req.user!.id,async(client,context)=>{
      assertAnyCapability(context.capabilities,["institution.sla.manage","institution.audit.read"]);
      assertInstitutionDataScope(context.dataScopes, "partner.operations");
      const rows=await client.query(`SELECT id,name,timezone,review_target_hours,decision_target_hours,
        information_response_hours,status,version,created_at,updated_at
        FROM institution_sla_policies ORDER BY version DESC`);
      return rows.rows;
    });
    res.json({data});
  }catch(error){sendFailure(res,error);}
});

router.post("/institution/sla",async(req,res)=>{
  try{
    const name=asText(req.body?.name,200), timezone=asText(req.body?.timezone,100);
    const reviewHours=asPositiveInt(req.body?.reviewTargetHours), decisionHours=asPositiveInt(req.body?.decisionTargetHours);
    const informationHours=asPositiveInt(req.body?.informationResponseHours);
    if(Math.max(reviewHours,decisionHours,informationHours)>2160) throw new Error("institution_sla_invalid");
    const result=await withInstitutionContext(req.user!.id,async(client,context)=>{
      assertCapability(context.capabilities,"institution.sla.request");
      assertInstitutionDataScope(context.dataScopes, "partner.operations");
      const next=await client.query<{next_version:string}>(`SELECT COALESCE(max(version),0)+1 AS next_version FROM institution_sla_policies`);
      const id=nextInstitutionId(),version=Number(next.rows[0].next_version);
      const requestHash=institutionHash({operation:"SLA_CHANGE_REQUEST",id,name,timezone,
        reviewHours,decisionHours,informationHours,version});
      const authorization=await authorizeInstitutionRouteMutation({
        request:req,client,context,capabilityKey:"institution.sla.request",
        requiredDataScope:"partner.operations",resourceType:"institution_sla_policy",
        resourceId:id,requestHash,approvalSatisfied:false,
      });
      const inserted=await client.query(`INSERT INTO institution_sla_policies (
        id,tenant_id,relationship_id,name,timezone,review_target_hours,decision_target_hours,
        information_response_hours,status,version,created_by_membership_id,
        request_hash,authorization_receipt_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'DRAFT',$9,$10,$11,$12)
      RETURNING *`,[id,context.tenantId,context.relationshipId,name,timezone,reviewHours,
        decisionHours,informationHours,version,context.membershipId,requestHash,
        authorization.authorizationReceiptId]);
      await appendEvent(client,context,{eventType:"institution.sla.change_requested.v1",
        aggregateType:"SLA_POLICY",aggregateId:id,aggregateVersion:version,
        payload:{status:"PENDING_CONTROL_PLANE",authorizationReceiptId:authorization.authorizationReceiptId}});
      return {...inserted.rows[0],state:"PENDING_CONTROL_PLANE"};
    });
    res.status(202).json(result);
  }catch(error){sendFailure(res,error);}
});

router.get("/institution/analytics",async(req,res)=>{
  try{
    const data=await withInstitutionContext(req.user!.id,async(client,context)=>{
      assertCapability(context.capabilities,"institution.analytics.read");
      assertInstitutionDataScope(context.dataScopes, "analytics.aggregate");
      const scope=institutionScopeSql(context,1);
      const [states,sla,decisions,intakes]=await Promise.all([
        client.query(`SELECT lifecycle_state,count(*)::integer AS count FROM institution_application_cases
          WHERE ${scope.sql} GROUP BY lifecycle_state ORDER BY lifecycle_state`,scope.values),
        client.query(`SELECT count(*) FILTER(WHERE COALESCE(decision_due_at,review_due_at)<now()
          AND lifecycle_state NOT IN('ENROLLED','CLOSED'))::integer AS breached,
          count(*) FILTER(WHERE lifecycle_state NOT IN('ENROLLED','CLOSED'))::integer AS open
          FROM institution_application_cases WHERE ${scope.sql}`,scope.values),
        client.query(`SELECT decision_type,state,count(*)::integer AS count FROM institution_decisions
          GROUP BY decision_type,state ORDER BY decision_type,state`),
        client.query(`SELECT intake_key,count(*)::integer AS count FROM institution_application_cases
          WHERE ${scope.sql} GROUP BY intake_key ORDER BY count DESC NULLS LAST LIMIT 20`,scope.values),
      ]);
      return {states:states.rows,sla:sla.rows[0],decisions:decisions.rows,intakes:intakes.rows,piiProjection:"AGGREGATE_ONLY"};
    });
    res.json(data);
  }catch(error){sendFailure(res,error);}
});

router.get("/institution/team",async(req,res)=>{
  try{
    const data=await withInstitutionContext(req.user!.id,async(client,context)=>{
      assertCapability(context.capabilities,"institution.team.manage");
      assertInstitutionDataScope(context.dataScopes, "relationship.membership");
      const rows=await client.query(`SELECT m.id,m.legacy_user_id,m.role_key,m.program_scope_ids,m.intake_scopes,
        m.status,m.valid_from,m.valid_until,m.version,u.first_name,u.last_name,u.email
        FROM institution_memberships m JOIN users u ON u.id=m.legacy_user_id
        ORDER BY m.status,m.role_key,u.id`);
      return rows.rows;
    });
    res.json({data});
  }catch(error){sendFailure(res,error);}
});

router.post("/institution/team/memberships",async(req,res)=>{
  try{
    const userId=asPositiveInt(req.body?.userId);
    const roleKey=asText(req.body?.roleKey,64).toUpperCase();
    if(!isInstitutionRoleKey(roleKey)) throw new Error("institution_role_invalid");
    const programScopeIds=Array.isArray(req.body?.programScopeIds)?[...new Set(req.body.programScopeIds.map(asPositiveInt))].slice(0,500):[];
    const intakeScopes=Array.isArray(req.body?.intakeScopes)?[...new Set(req.body.intakeScopes.map((v:unknown)=>asText(v,120)))].slice(0,100):[];
    const result=await withInstitutionContext(req.user!.id,async(client,context)=>{
      assertCapability(context.capabilities,"institution.team.request");
      assertInstitutionDataScope(context.dataScopes, "relationship.membership");
      const authority=await client.query(`SELECT p.id AS principal_id,rpv.id AS package_id
        FROM principals p CROSS JOIN role_definitions rd JOIN role_package_versions rpv ON rpv.role_definition_id=rd.id
        WHERE p.legacy_user_id=$1 AND p.principal_type='HUMAN' AND p.status='ACTIVE'
          AND rd.key=$2 AND rd.status='ACTIVE' AND rpv.status='ACTIVE'
        ORDER BY rpv.version_number DESC LIMIT 1`,[userId,{
          INSTITUTION_ADMIN:"institution.admin",PROGRAM_INTAKE_MANAGER:"institution.program_intake_manager",
          ADMISSIONS_REVIEWER:"institution.admissions_reviewer",DECISION_APPROVER:"institution.decision_approver",
          INTEGRATION_ADMIN:"institution.integration_admin",INSTITUTION_AUDITOR:"institution.auditor",
        }[roleKey]]);
      if(authority.rowCount!==1) throw new Error("institution_principal_unavailable");
      const id=nextInstitutionId();
      const requestHash=institutionHash({operation:"MEMBERSHIP_CHANGE_REQUEST",userId,roleKey,
        programScopeIds,intakeScopes,principalId:authority.rows[0].principal_id,
        rolePackageVersionId:authority.rows[0].package_id});
      const authorization=await authorizeInstitutionRouteMutation({
        request:req,client,context,capabilityKey:"institution.team.request",
        requiredDataScope:"relationship.membership",resourceType:"institution_membership_request",
        resourceId:id,requestHash,approvalSatisfied:false,
      });
      const inserted=await client.query(`INSERT INTO institution_membership_change_requests (
        id,tenant_id,relationship_id,target_principal_id,target_legacy_user_id,
        requested_role_package_version_id,requested_role_key,requested_program_scope_ids,
        requested_intake_scopes,maker_membership_id,state,request_hash,authorization_receipt_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'PENDING_CONTROL_PLANE',$11,$12)
      RETURNING id,target_legacy_user_id,requested_role_key,state`,
      [id,context.tenantId,context.relationshipId,authority.rows[0].principal_id,userId,
        authority.rows[0].package_id,roleKey,programScopeIds,intakeScopes,context.membershipId,
        requestHash,authorization.authorizationReceiptId]);
      return inserted.rows[0];
    });
    res.status(202).json(result);
  }catch(error){sendFailure(res,error);}
});

router.get("/institution/integrations",async(req,res)=>{
  try{
    const data=await withInstitutionContext(req.user!.id,async(_client,context)=>{
      assertCapability(context.capabilities,"institution.integrations.manage");
      assertInstitutionDataScope(context.dataScopes, "integration.metadata");
      return {institutionId:context.institutionId,credentialVisibility:"SECRET_REFERENCES_ONLY",
        externalExecution:"DISABLED",configuredAdapters:[]};
    });
    res.json(data);
  }catch(error){sendFailure(res,error);}
});

router.get("/institution/audit",async(req,res)=>{
  try{
    const data=await withInstitutionContext(req.user!.id,async(client,context)=>{
      assertCapability(context.capabilities,"institution.audit.read");
      assertInstitutionDataScope(context.dataScopes,"audit.masked");
      const limitRaw=Number(req.query.limit ?? 100);
      const limit=Number.isSafeInteger(limitRaw)&&limitRaw>=1&&limitRaw<=200?limitRaw:100;
      const rows=await client.query(`SELECT id,event_type,aggregate_type,aggregate_version,
        left(actor_membership_id::text,8) AS actor_ref,previous_hash,event_hash,occurred_at
        FROM institution_admission_events
        ORDER BY occurred_at DESC,id DESC LIMIT $1`,[limit]);
      return rows.rows;
    });
    res.json({data,projection:"MASKED_APPEND_ONLY"});
  }catch(error){sendFailure(res,error);}
});

export default router;
