import { and, asc, eq, sql } from "drizzle-orm";
import {
  db,
  pool,
  portalLifecycleProposalsTable,
} from "@workspace/db";
import { enqueuePortalWorkerJob } from "@workspace/portal-runner";
import { syncApplicationFinance } from "@workspace/portal-runner";
import type { PoolClient } from "pg";

const targetStageBySignal = {
  submitted: "submitted",
  offer_received: "offer_received",
  deposit_paid: "upload_payment",
  acceptance_letter: "acceptance_letter",
  final_acceptance: "final_acceptance",
  student_card: "student_card",
  already_registered: "all_registered",
  quota_full: "quota_full",
  waitlisted: "waitlisted",
  withdrawn: "withdrawn",
  enrolled: "student_card",
  rejected: "rejected",
} as const;

const artifactStage = {
  offer_letter: "offer_received",
  deposit_receipt: "upload_payment",
  acceptance_letter: "acceptance_letter",
  final_acceptance: "final_acceptance",
  student_card: "student_card",
} as const;

type ExecutableSignal = keyof typeof targetStageBySignal;
type RequiredArtifact = keyof typeof artifactStage;

type LifecycleDecision = {
  signal: ExecutableSignal;
  targetStage: string;
  action: "review_stage_transition";
  requiredArtifact: RequiredArtifact | null;
  artifactVerified: true;
  humanApprovalRequired: true;
  allowPortalMutation: false;
};

export type PortalLifecycleExecutionResult =
  | { outcome: "executed"; proposalId: number; applicationId: number; targetStage: string }
  | { outcome: "already_executed"; proposalId: number; applicationId: number; targetStage: string }
  | { outcome: "not_executable"; proposalId: number; errorCode: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseExecutableDecision(value: unknown): LifecycleDecision | null {
  if (!isRecord(value)) return null;
  const signal = value.signal;
  const targetStage = value.targetStage;
  const requiredArtifact = value.requiredArtifact;
  if (
    typeof signal !== "string" ||
    !(signal in targetStageBySignal) ||
    typeof targetStage !== "string" ||
    targetStageBySignal[signal as ExecutableSignal] !== targetStage ||
    value.action !== "review_stage_transition" ||
    value.artifactVerified !== true ||
    value.humanApprovalRequired !== true ||
    value.allowPortalMutation !== false ||
    !(
      requiredArtifact === null ||
      (typeof requiredArtifact === "string" && requiredArtifact in artifactStage)
    )
  ) {
    return null;
  }
  return value as LifecycleDecision;
}

async function failProposal(
  client: PoolClient,
  proposalId: number,
  errorCode: string,
): Promise<PortalLifecycleExecutionResult> {
  await client.query(
    `UPDATE portal_lifecycle_proposals
        SET status = 'failed', last_error_code = $2, updated_at = now()
      WHERE id = $1 AND status = 'approved'`,
    [proposalId, errorCode],
  );
  return { outcome: "not_executable", proposalId, errorCode };
}

/**
 * Executes only the bounded internal CRM stage transition approved by a
 * second human. It never opens a portal, sends a message, forwards payment,
 * or mutates any external system.
 */
export async function executeApprovedPortalLifecycleProposal(
  proposalId: number,
): Promise<PortalLifecycleExecutionResult> {
  if (!Number.isSafeInteger(proposalId) || proposalId <= 0) {
    throw new Error("PORTAL_LIFECYCLE_PROPOSAL_ID_INVALID");
  }
  const client = await pool.connect();
  let result: PortalLifecycleExecutionResult;
  try {
    await client.query("BEGIN");
    const selected = await client.query<{
      id: string | number;
      applicationId: number;
      observationId: number;
      observationHash: string;
      status: string;
      currentStage: string;
      reviewedBy: number | null;
      reviewedAt: Date | null;
      executedAt: Date | null;
      decision: unknown;
      applicationStage: string;
      identityVerified: boolean;
      observedHash: string;
      reviewCount: number;
    }>(
      `SELECT proposal.id,
              proposal.application_id AS "applicationId",
              proposal.observation_id AS "observationId",
              proposal.observation_hash AS "observationHash",
              proposal.status,
              proposal.current_stage AS "currentStage",
              proposal.reviewed_by AS "reviewedBy",
              proposal.reviewed_at AS "reviewedAt",
              proposal.executed_at AS "executedAt",
              proposal.decision,
              application.stage AS "applicationStage",
              observation.identity_verified AS "identityVerified",
              observation.observation_hash AS "observedHash",
              (SELECT count(*)::int
                 FROM portal_lifecycle_proposal_reviews review
                WHERE review.proposal_id = proposal.id
                  AND review.decision = 'approve'
                  AND review.reviewer_id = proposal.reviewed_by) AS "reviewCount"
         FROM portal_lifecycle_proposals proposal
         JOIN applications application ON application.id = proposal.application_id
         JOIN portal_lifecycle_observations observation
           ON observation.id = proposal.observation_id
          AND observation.application_id = proposal.application_id
          AND observation.submission_id = proposal.submission_id
        WHERE proposal.id = $1
        FOR UPDATE OF proposal, application`,
      [proposalId],
    );
    const proposal = selected.rows[0];
    if (!proposal) {
      result = { outcome: "not_executable", proposalId, errorCode: "PROPOSAL_NOT_FOUND" };
      await client.query("COMMIT");
      return result;
    }
    const applicationId = proposal.applicationId;
    const priorDecision = parseExecutableDecision(proposal.decision);
    if (proposal.status === "executed" && proposal.executedAt && priorDecision) {
      result = {
        outcome: "already_executed",
        proposalId,
        applicationId,
        targetStage: priorDecision.targetStage,
      };
      await client.query("COMMIT");
      return result;
    }
    if (proposal.status !== "approved") {
      result = { outcome: "not_executable", proposalId, errorCode: "PROPOSAL_NOT_APPROVED" };
      await client.query("COMMIT");
      return result;
    }
    if (
      proposal.reviewedBy === null ||
      proposal.reviewedAt === null ||
      proposal.reviewCount !== 1
    ) {
      result = await failProposal(client, proposalId, "APPROVAL_EVIDENCE_INVALID");
      await client.query("COMMIT");
      return result;
    }
    if (
      proposal.identityVerified !== true ||
      proposal.observationHash !== proposal.observedHash
    ) {
      result = await failProposal(client, proposalId, "OBSERVATION_EVIDENCE_INVALID");
      await client.query("COMMIT");
      return result;
    }
    const decision = parseExecutableDecision(proposal.decision);
    if (!decision) {
      result = await failProposal(client, proposalId, "LIFECYCLE_DECISION_INVALID");
      await client.query("COMMIT");
      return result;
    }
    if (proposal.applicationStage === decision.targetStage) {
      await client.query(
        `UPDATE portal_lifecycle_proposals
            SET status = 'executed', executed_at = COALESCE(executed_at, now()),
                last_error_code = NULL, updated_at = now()
          WHERE id = $1 AND status = 'approved'`,
        [proposalId],
      );
      result = {
        outcome: "already_executed",
        proposalId,
        applicationId,
        targetStage: decision.targetStage,
      };
      await client.query("COMMIT");
      return result;
    }
    if (
      proposal.applicationStage !== proposal.currentStage ||
      !(await client.query(
        `SELECT 1 FROM pipeline_stages
          WHERE entity_type = 'application' AND key = $1 LIMIT 1`,
        [decision.targetStage],
      )).rows[0]
    ) {
      result = await failProposal(client, proposalId, "APPLICATION_STAGE_CHANGED");
      await client.query("COMMIT");
      return result;
    }
    if (decision.requiredArtifact !== null) {
      const stage = artifactStage[decision.requiredArtifact];
      const artifact = await client.query(
        `SELECT 1
           FROM application_stage_documents
          WHERE application_id = $1
            AND stage = $2
            AND is_missing_doc_note = false
            AND (file_data IS NOT NULL OR (file_url IS NOT NULL AND btrim(file_url) <> ''))
          LIMIT 1`,
        [applicationId, stage],
      );
      if (!artifact.rows[0]) {
        result = await failProposal(client, proposalId, "REQUIRED_ARTIFACT_MISSING");
        await client.query("COMMIT");
        return result;
      }
    }

    const transitioned = await client.query<{ id: number }>(
      `UPDATE applications
          SET stage = $2, updated_at = now()
        WHERE id = $1 AND stage = $3 AND deleted_at IS NULL
        RETURNING id`,
      [applicationId, decision.targetStage, proposal.currentStage],
    );
    if (!transitioned.rows[0]) {
      result = await failProposal(client, proposalId, "APPLICATION_STAGE_CHANGED");
      await client.query("COMMIT");
      return result;
    }
    await client.query(
      `UPDATE portal_lifecycle_proposals
          SET status = 'executed', executed_at = now(), last_error_code = NULL,
              updated_at = now()
        WHERE id = $1 AND status = 'approved'`,
      [proposalId],
    );
    await client.query(
      `INSERT INTO audit_logs (user_id, action, resource, resource_id, changes)
       VALUES ($1, 'execute_portal_lifecycle_proposal', 'application', $2, $3)`,
      [
        proposal.reviewedBy,
        applicationId,
        JSON.stringify({
          proposalId,
          observationId: proposal.observationId,
          fromStage: proposal.currentStage,
          toStage: decision.targetStage,
          externalMutation: false,
        }),
      ],
    );
    result = {
      outcome: "executed",
      proposalId,
      applicationId,
      targetStage: decision.targetStage,
    };
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  if (result.outcome === "executed") {
    await syncApplicationFinance(result.applicationId).catch(() => undefined);
  }
  return result;
}

export async function enqueueApprovedPortalLifecycleProposal(
  proposalId: number,
): Promise<{ queued: boolean; jobId?: number; reason?: string }> {
  const [proposal] = await db
    .select({
      id: portalLifecycleProposalsTable.id,
      status: portalLifecycleProposalsTable.status,
      proposalKey: portalLifecycleProposalsTable.proposalKey,
      decision: portalLifecycleProposalsTable.decision,
      reviewedBy: portalLifecycleProposalsTable.reviewedBy,
    })
    .from(portalLifecycleProposalsTable)
    .where(eq(portalLifecycleProposalsTable.id, proposalId))
    .limit(1);
  if (!proposal || proposal.status !== "approved") {
    return { queued: false, reason: "PROPOSAL_NOT_APPROVED" };
  }
  if (!parseExecutableDecision(proposal.decision)) {
    return { queued: false, reason: "ACTION_REQUIRES_MANUAL_EXECUTION" };
  }
  const job = await enqueuePortalWorkerJob({
    kind: "lifecycle_execute",
    portalUniversityId: null,
    requestKey: `lifecycle:${proposal.id}`,
    requestedBy: proposal.reviewedBy,
    payload: { proposalId: proposal.id, proposalKey: proposal.proposalKey },
  });
  return { queued: true, jobId: job.id };
}

export async function enqueueApprovedPortalLifecycleProposals(
  limit = 50,
): Promise<{ scanned: number; queued: number }> {
  const rows = await db
    .select({ id: portalLifecycleProposalsTable.id })
    .from(portalLifecycleProposalsTable)
    .where(and(
      eq(portalLifecycleProposalsTable.status, "approved"),
      sql`${portalLifecycleProposalsTable.decision}->>'action' = 'review_stage_transition'`,
    ))
    .orderBy(asc(portalLifecycleProposalsTable.createdAt), asc(portalLifecycleProposalsTable.id))
    .limit(Math.max(1, Math.min(100, limit)));
  let queued = 0;
  for (const row of rows) {
    const result = await enqueueApprovedPortalLifecycleProposal(row.id);
    if (result.queued) queued += 1;
  }
  return { scanned: rows.length, queued };
}
