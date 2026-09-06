import assert from "node:assert/strict";
import pg from "pg";

import {
  STUDENT_DOCUMENT_REQUEST_RESPOND_CAPABILITY,
  createStudentDocumentIngestReceipt,
  executeStudentDocumentRequestResponse,
  type StudentDocumentRequestAuthority,
  type StudentDocumentRequestResponseStore,
  type StudentDocumentRequestResponseTransaction,
} from "../src/lib/studentDocumentRequestResponseCommand.js";
import { createPostgresStudentDocumentRequestResponseStore } from "../src/lib/postgresStudentDocumentRequestResponseStore.js";

const { Client, Pool } = pg;

assert.equal(
  process.env.ALLOW_DISPOSABLE_STUDENT_JOURNEY_G45_TEST,
  "true",
  "ALLOW_DISPOSABLE_STUDENT_JOURNEY_G45_TEST=true is required",
);
assert.equal(process.env.ALLOW_LIVE_INTEGRATIONS, "false");

const adminUrl = process.env.PG_JOURNEY_ADMIN_URL ?? "";
const migratorUrl = process.env.PG_JOURNEY_MIGRATOR_URL ?? "";
const executorUrl = process.env.PG_JOURNEY_EXECUTOR_URL ?? "";
const expectedServerPort = Number(process.env.PG_JOURNEY_SERVER_PORT ?? "5433");

function safeTarget(value: string, expectedUser: string): URL {
  const target = new URL(value);
  assert.equal(target.protocol, "postgresql:");
  assert.equal(target.hostname, "127.0.0.1");
  assert.equal(target.port, "5433");
  assert.equal(target.pathname, "/fasos_apply_local");
  assert.equal(target.username, expectedUser);
  assert.equal(target.password, "");
  assert.equal(target.search, "");
  assert.equal(target.hash, "");
  return target;
}

safeTarget(adminUrl, "postgres");
safeTarget(migratorUrl, "fas_migrator");
safeTarget(executorUrl, "fas_journey_executor");
assert.ok(Number.isSafeInteger(expectedServerPort));
assert.ok(expectedServerPort >= 1 && expectedServerPort <= 65_535);

const NOW = "2026-09-01T12:00:00.000Z";
const EARLIER = "2026-09-01T11:00:00.000Z";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const ID = {
  tenantA: "018f8200-0000-7000-8000-000000000001",
  organizationA: "018f8200-0000-7000-8000-000000000002",
  principalA: "018f8200-0000-7000-8000-000000000003",
  membershipA: "018f8200-0000-7000-8000-000000000004",
  policyA: "018f8200-0000-7000-8000-000000000005",
  selectionA: "018f8200-0000-7000-8000-000000000006",
  contextA: "018f8200-0000-7000-8000-000000000007",
  grantA: "018f8200-0000-7000-8000-000000000008",
  assignmentA: "018f8200-0000-7000-8000-000000000009",
  subjectA: "018f8200-0000-7000-8000-00000000000a",
  dossierA: "018f8200-0000-7000-8000-00000000000b",
  applicationA: "018f8200-0000-7000-8000-00000000000c",
  requestAck: "018f8200-0000-7000-8000-00000000000d",
  requestEvidence: "018f8200-0000-7000-8000-00000000000e",
  requestRevoked: "018f8200-0000-7000-8000-00000000000f",
  ingestA: "018f8200-0000-7000-8000-000000000010",
  requestConcurrent: "018f8200-0000-7000-8000-000000000011",
  requestRollback: "018f8200-0000-7000-8000-000000000012",
  tenantB: "018f8200-0000-7000-8000-000000000101",
  organizationB: "018f8200-0000-7000-8000-000000000102",
  principalB: "018f8200-0000-7000-8000-000000000103",
  membershipB: "018f8200-0000-7000-8000-000000000104",
  policyB: "018f8200-0000-7000-8000-000000000105",
  subjectB: "018f8200-0000-7000-8000-000000000106",
  dossierB: "018f8200-0000-7000-8000-000000000107",
  applicationB: "018f8200-0000-7000-8000-000000000108",
  requestB: "018f8200-0000-7000-8000-000000000109",
  role: "018f8200-0000-7000-8000-000000000201",
  rolePackage: "018f8200-0000-7000-8000-000000000202",
  commandAck: "018f8200-0000-7000-8000-000000000301",
  commandEvidence: "018f8200-0000-7000-8000-000000000302",
  commandCrossTenant: "018f8200-0000-7000-8000-000000000303",
  commandRevoked: "018f8200-0000-7000-8000-000000000304",
  commandConcurrent: "018f8200-0000-7000-8000-000000000305",
  commandRollback: "018f8200-0000-7000-8000-000000000306",
  requirementSetA: "018f8200-0000-7000-8000-000000000501",
  requirementItemA: "018f8200-0000-7000-8000-000000000502",
  dossierRevisionA: "018f8200-0000-7000-8000-000000000503",
  verificationAccessA: "018f8200-0000-7000-8000-000000000504",
  verifiedEvidenceA: "018f8200-0000-7000-8000-000000000505",
  requirementResultA: "018f8200-0000-7000-8000-000000000506",
  verifyTransitionA: "018f8200-0000-7000-8000-000000000507",
  verifyMilestoneA: "018f8200-0000-7000-8000-000000000508",
  submitTransitionA: "018f8200-0000-7000-8000-000000000509",
  submitMilestoneA: "018f8200-0000-7000-8000-00000000050a",
  invalidSnapshotA: "018f8200-0000-7000-8000-00000000050b",
  qavjpSnapshotA: "018f8200-0000-7000-8000-00000000050c",
  qavjpItemVerifyA: "018f8200-0000-7000-8000-00000000050d",
  qavjpItemSubmitA: "018f8200-0000-7000-8000-00000000050e",
} as const;

const LEGACY = {
  branchA: 9811,
  branchB: 9812,
  userA: 9821,
  userB: 9822,
  studentA: 9831,
  studentB: 9832,
  applicationA: 9841,
  applicationB: 9842,
} as const;

const JOURNEY_TABLES = [
  "journey_subjects",
  "journey_requirement_sets",
  "journey_requirement_items",
  "journey_dossiers",
  "journey_dossier_revisions",
  "journey_application_cases",
  "journey_requirement_results",
  "journey_verified_evidence_receipts",
  "journey_consent_receipts",
  "journey_communication_preference_receipts",
  "journey_communication_suppression_receipts",
  "journey_notification_intents",
  "journey_communication_decision_receipts",
  "journey_document_requests",
  "journey_document_ingest_receipts",
  "journey_document_access_receipts",
  "journey_document_response_receipts",
  "journey_document_response_audits",
  "journey_document_ingest_consumptions",
  "journey_document_response_commands",
  "journey_state_transition_receipts",
  "journey_milestone_events",
  "journey_milestone_evidence",
  "journey_qavjp_snapshots",
  "journey_qavjp_items",
  "journey_outbox_events",
] as const;

const AUTHORITY_READ_TABLES = [
  "active_session_context_selections",
  "principals",
  "memberships",
  "tenants",
  "policy_versions",
  "access_assignments",
  "role_package_versions",
  "role_definitions",
  "role_package_capabilities",
  "capability_definitions",
] as const;

async function withClient<T>(
  connectionString: string,
  operation: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000,
    lock_timeout: 5_000,
    idle_in_transaction_session_timeout: 15_000,
  });
  await client.connect();
  try {
    const identity = await client.query(
      "SELECT current_user, current_database(), inet_server_port() AS server_port",
    );
    assert.equal(identity.rows[0]?.current_database, "fasos_apply_local");
    assert.equal(identity.rows[0]?.server_port, expectedServerPort);
    return await operation(client);
  } finally {
    await client.end();
  }
}

async function tenantTransaction<T>(
  client: pg.Client,
  tenantId: string,
  operation: () => Promise<T>,
): Promise<T> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await operation();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function seedTenant(
  client: pg.Client,
  input: {
    tenantId: string;
    organizationId: string;
    principalId: string;
    membershipId: string;
    policyId: string;
    branchId: number;
    userId: number;
    studentId: number;
    legacyApplicationId: number;
    subjectId: string;
    dossierId: string;
    applicationId: string;
    requestIds: readonly string[];
    slug: string;
  },
): Promise<void> {
  await tenantTransaction(client, input.tenantId, async () => {
    await client.query(
      `INSERT INTO tenants
        (id, slug, legal_name, display_name, status, home_region, policy_version)
       VALUES ($1, $2, $3, $3, 'ACTIVE', 'eu-central', 1)`,
      [input.tenantId, input.slug, `${input.slug} legal`],
    );
    await client.query(
      `INSERT INTO organizations
        (id, tenant_id, legal_name, display_name, organization_type, status)
       VALUES ($1, $2, $3, $3, 'OPERATING_ENTITY', 'ACTIVE')`,
      [input.organizationId, input.tenantId, `${input.slug} org`],
    );
    await client.query(
      `INSERT INTO policy_versions
        (id, tenant_id, version_number, checksum, state, predicate_document, effective_at)
       VALUES ($1, $2, 1, $3, 'ACTIVE', '{}'::jsonb, '2026-08-01T00:00:00Z')`,
      [input.policyId, input.tenantId, HASH_A],
    );
    await client.query(
      `INSERT INTO tenant_organization_legacy_branches
        (tenant_id, organization_id, legacy_branch_id)
       VALUES ($1, $2, $3)`,
      [input.tenantId, input.organizationId, input.branchId],
    );
    await client.query(
      `INSERT INTO memberships
        (id, tenant_id, organization_id, legacy_branch_id, principal_id,
         status, valid_from)
       VALUES ($1, $2, $3, $4, $5, 'ACTIVE', '2026-08-01T00:00:00Z')`,
      [
        input.membershipId,
        input.tenantId,
        input.organizationId,
        input.branchId,
        input.principalId,
      ],
    );
    await client.query(
      `INSERT INTO journey_subjects
        (id, tenant_id, organization_id, legacy_branch_id, legacy_student_id,
         legacy_user_id, subject_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $1::uuid::text)`,
      [
        input.subjectId,
        input.tenantId,
        input.organizationId,
        input.branchId,
        input.studentId,
        input.userId,
      ],
    );
    await client.query(
      `INSERT INTO journey_dossiers (id, tenant_id, subject_id)
       VALUES ($1, $2, $3)`,
      [input.dossierId, input.tenantId, input.subjectId],
    );
    await client.query(
      `INSERT INTO journey_application_cases (
         id, tenant_id, organization_id, legacy_branch_id, subject_id,
         dossier_id, legacy_application_id, corridor_code,
         owner_membership_id, owner_legacy_user_id, next_action, due_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, 'pilot.uk.undergraduate',
         $8, $9, 'upload_required_document', '2026-09-10T12:00:00Z'
       )`,
      [
        input.applicationId,
        input.tenantId,
        input.organizationId,
        input.branchId,
        input.subjectId,
        input.dossierId,
        input.legacyApplicationId,
        input.membershipId,
        input.userId,
      ],
    );
    for (const [index, requestId] of input.requestIds.entries()) {
      await client.query(
        `INSERT INTO journey_document_requests (
           id, tenant_id, subject_id, application_case_id, requirement_code,
           requested_by_principal_id, requested_by_membership_id, due_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, '2026-09-05T12:00:00Z')`,
        [
          requestId,
          input.tenantId,
          input.subjectId,
          input.applicationId,
          `pilot_document_${index + 1}`,
          input.principalId,
          input.membershipId,
        ],
      );
    }
  });
}

async function verifyLifecycleFoundation(client: pg.Client): Promise<void> {
  await tenantTransaction(client, ID.tenantA, async () => {
    await client.query(
      `INSERT INTO journey_requirement_sets (
         id, tenant_id, organization_id, legacy_branch_id, corridor_code,
         version_number, authority_source, authority_source_hash,
         effective_from, published_at, set_hash
       ) VALUES (
         $1, $2, $3, $4, 'pilot.uk.undergraduate', 1,
         'REVIEWED_MANUAL_IMPORT', $5, '2026-08-01T00:00:00Z',
         '2026-08-01T00:00:00Z', $6
       )`,
      [
        ID.requirementSetA,
        ID.tenantA,
        ID.organizationA,
        LEGACY.branchA,
        HASH_A,
        HASH_B,
      ],
    );
    await client.query(
      `INSERT INTO journey_requirement_items (
         id, tenant_id, requirement_set_id, requirement_code, evidence_kind,
         mandatory, ordinal, item_hash
       ) VALUES ($1, $2, $3, 'passport', 'passport', true, 1, $4)`,
      [ID.requirementItemA, ID.tenantA, ID.requirementSetA, HASH_A],
    );
    await client.query(
      `INSERT INTO journey_dossier_revisions (
         id, tenant_id, dossier_id, requirement_set_id, revision_number,
         revision_state, source_snapshot_hash, revision_hash, recorded_at
       ) VALUES ($1, $2, $3, $4, 1, 'VERIFIED', $5, $6, $7)`,
      [
        ID.dossierRevisionA,
        ID.tenantA,
        ID.dossierA,
        ID.requirementSetA,
        HASH_A,
        HASH_B,
        EARLIER,
      ],
    );
    await client.query(
      `INSERT INTO access_decision_receipts (
         id, tenant_id, context_id, actor_principal_id, membership_id,
         assignment_ids, role_package_version_ids, capability_key,
         resource_type, resource_id, decision, reason_code, policy_version_id,
         correlation_id, occurred_at
       ) VALUES (
         $1, $2, $3, $4, $5, ARRAY[$6]::uuid[], ARRAY[$7]::uuid[],
         'student.dossier.verify', 'DOSSIER_REVISION', $8, 'ALLOW',
         'g45_local_pilot_allow', $9, 'g45-dossier-verification', $10
       )`,
      [
        ID.verificationAccessA,
        ID.tenantA,
        ID.contextA,
        ID.principalA,
        ID.membershipA,
        ID.assignmentA,
        ID.rolePackage,
        ID.dossierRevisionA,
        ID.policyA,
        EARLIER,
      ],
    );
    await client.query(
      `INSERT INTO journey_verified_evidence_receipts (
         id, tenant_id, subject_id, application_case_id, dossier_revision_id,
         dossier_id, requirement_set_id, requirement_code, evidence_ref,
         content_sha256, verification_policy_version, verifier_principal_id,
         verifier_membership_id, access_decision_receipt_id, recorded_at,
         receipt_hash
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, 'passport', 'evidence:passport:verified',
         $8, 'g45_verification_v1', $9, $10, $11, $12, $13
       )`,
      [
        ID.verifiedEvidenceA,
        ID.tenantA,
        ID.subjectA,
        ID.applicationA,
        ID.dossierRevisionA,
        ID.dossierA,
        ID.requirementSetA,
        HASH_A,
        ID.principalA,
        ID.membershipA,
        ID.verificationAccessA,
        EARLIER,
        HASH_B,
      ],
    );
    await client.query(
      `INSERT INTO journey_requirement_results (
         id, tenant_id, dossier_revision_id, dossier_id, requirement_set_id,
         requirement_code, result_state, evidence_receipt_id, result_hash,
         recorded_at
       ) VALUES ($1, $2, $3, $4, $5, 'passport', 'VERIFIED', $6, $7, $8)`,
      [
        ID.requirementResultA,
        ID.tenantA,
        ID.dossierRevisionA,
        ID.dossierA,
        ID.requirementSetA,
        ID.verifiedEvidenceA,
        HASH_A,
        EARLIER,
      ],
    );
  });

  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [ID.tenantA]);
    await client.query("SAVEPOINT missing_transition_receipt");
    await client.query(
      `UPDATE journey_application_cases
       SET lifecycle_state = 'DOSSIER_VERIFIED', active_dossier_revision_id = $1,
           aggregate_version = 2, updated_at = $2
       WHERE tenant_id = $3 AND id = $4`,
      [ID.dossierRevisionA, NOW, ID.tenantA, ID.applicationA],
    );
    await assert.rejects(
      client.query(
        'SET CONSTRAINTS "journey_application_transition_receipt_guard" IMMEDIATE',
      ),
      /Journey transition receipt is missing/,
    );
    await client.query("ROLLBACK TO SAVEPOINT missing_transition_receipt");
    await client.query(
      'SET CONSTRAINTS "journey_application_transition_receipt_guard" DEFERRED',
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }

  await tenantTransaction(client, ID.tenantA, async () => {
    await client.query(
      `INSERT INTO journey_state_transition_receipts (
         id, tenant_id, application_case_id, actor_principal_id,
         actor_membership_id, from_state, to_state, previous_version,
         next_version, evidence_kind, evidence_ref, evidence_sha256,
         policy_version, occurred_at, receipt_hash
       ) VALUES (
         $1, $2, $3, $4, $5, 'DOSSIER_PREPARATION', 'DOSSIER_VERIFIED',
         1, 2, 'VERIFIED_EVIDENCE', $6, $7, 'g45_transition_v1', $8, $9
       )`,
      [
        ID.verifyTransitionA,
        ID.tenantA,
        ID.applicationA,
        ID.principalA,
        ID.membershipA,
        ID.verifiedEvidenceA,
        HASH_A,
        NOW,
        HASH_B,
      ],
    );
    await client.query(
      `INSERT INTO journey_milestone_events (
         id, tenant_id, application_case_id, subject_id, aggregate_version,
         lifecycle_ref, milestone_code, owner_legacy_user_id, next_action,
         due_at, completed_at, recorded_at, on_time, verification_kind,
         quality_factor_bps, quality_policy_version, quality_input_hash,
         dedup_key, event_hash
       ) VALUES (
         $1, $2, $3, $4, 2, 'DOSSIER_VERIFIED', 'dossier_verified', $5,
         'submit_application', '2026-09-05T12:00:00Z', $6, $6, true,
         'VERIFIED_EVIDENCE', 10000, 'g45_pilot_quality_v1', $7, $8, $9
       )`,
      [
        ID.verifyMilestoneA,
        ID.tenantA,
        ID.applicationA,
        ID.subjectA,
        LEGACY.userA,
        NOW,
        HASH_A,
        "c".repeat(64),
        "d".repeat(64),
      ],
    );
    await client.query(
      `INSERT INTO journey_milestone_evidence (
         tenant_id, milestone_event_id, ordinal, evidence_kind, evidence_ref,
         evidence_sha256
       ) VALUES ($1, $2, 1, 'VERIFIED_EVIDENCE', $3, $4)`,
      [ID.tenantA, ID.verifyMilestoneA, ID.verifiedEvidenceA, HASH_A],
    );
    await client.query(
      `UPDATE journey_application_cases
       SET lifecycle_state = 'DOSSIER_VERIFIED', active_dossier_revision_id = $1,
           aggregate_version = 2, next_action = 'submit_application',
           due_at = '2026-09-05T12:00:00Z', updated_at = $2
       WHERE tenant_id = $3 AND id = $4 AND aggregate_version = 1`,
      [ID.dossierRevisionA, NOW, ID.tenantA, ID.applicationA],
    );

    await client.query(
      `INSERT INTO journey_state_transition_receipts (
         id, tenant_id, application_case_id, actor_principal_id,
         actor_membership_id, from_state, to_state, previous_version,
         next_version, evidence_kind, evidence_ref, evidence_sha256,
         policy_version, occurred_at, receipt_hash
       ) VALUES (
         $1, $2, $3, $4, $5, 'DOSSIER_VERIFIED', 'APPLICATION_SUBMITTED',
         2, 3, 'PARTNER_RECEIPT', 'partner_receipt:synthetic:1', $6,
         'g45_transition_v1', $7, $8
       )`,
      [
        ID.submitTransitionA,
        ID.tenantA,
        ID.applicationA,
        ID.principalA,
        ID.membershipA,
        HASH_B,
        NOW,
        "e".repeat(64),
      ],
    );
    await client.query(
      `INSERT INTO journey_milestone_events (
         id, tenant_id, application_case_id, subject_id, aggregate_version,
         lifecycle_ref, milestone_code, owner_legacy_user_id, next_action,
         due_at, completed_at, recorded_at, on_time, verification_kind,
         quality_factor_bps, quality_policy_version, quality_input_hash,
         dedup_key, event_hash
       ) VALUES (
         $1, $2, $3, $4, 3, 'APPLICATION_SUBMITTED',
         'application_submitted', $5, 'monitor_submission_receipt',
         '2026-09-10T12:00:00Z', $6, $6, true, 'PARTNER_RECEIPT', 10000,
         'g45_pilot_quality_v1', $7, $8, $9
       )`,
      [
        ID.submitMilestoneA,
        ID.tenantA,
        ID.applicationA,
        ID.subjectA,
        LEGACY.userA,
        NOW,
        HASH_B,
        "f".repeat(64),
        "1".repeat(64),
      ],
    );
    await client.query(
      `INSERT INTO journey_milestone_evidence (
         tenant_id, milestone_event_id, ordinal, evidence_kind, evidence_ref,
         evidence_sha256
       ) VALUES ($1, $2, 1, 'PARTNER_RECEIPT', 'partner_receipt:synthetic:1', $3)`,
      [ID.tenantA, ID.submitMilestoneA, HASH_B],
    );
    await client.query(
      `UPDATE journey_application_cases
       SET lifecycle_state = 'APPLICATION_SUBMITTED', aggregate_version = 3,
           next_action = 'monitor_submission_receipt',
           due_at = '2026-09-10T12:00:00Z', updated_at = $1
       WHERE tenant_id = $2 AND id = $3 AND aggregate_version = 2`,
      [NOW, ID.tenantA, ID.applicationA],
    );
  });

  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [ID.tenantA]);
    await client.query("SAVEPOINT unreconciled_qavjp");
    await client.query(
      `INSERT INTO journey_qavjp_snapshots (
         id, tenant_id, cohort_ref, period_starts_at, period_ends_at,
         frozen_at, eligibility_policy_version, source_snapshot_hash,
         source_record_count, excluded_record_count, eligible_item_count,
         denominator_weight_bps, owner_coverage_bps,
         next_action_coverage_bps, snapshot_hash
       ) VALUES (
         $1, $2, 'g45_pilot_2026', '2026-09-01T00:00:00Z',
         '2026-10-01T00:00:00Z', '2026-08-31T23:59:59Z',
         'g45_eligibility_v1', $3, 1, 0, 1, 5000, 10000, 10000, $4
       )`,
      [ID.invalidSnapshotA, ID.tenantA, HASH_A, HASH_B],
    );
    await assert.rejects(
      client.query(
        'SET CONSTRAINTS "journey_qavjp_snapshot_reconciliation_guard" IMMEDIATE',
      ),
      /QAVJP frozen denominator derived fields do not reconcile/,
    );
    await client.query("ROLLBACK TO SAVEPOINT unreconciled_qavjp");
    await client.query(
      'SET CONSTRAINTS "journey_qavjp_snapshot_reconciliation_guard" DEFERRED',
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }

  await tenantTransaction(client, ID.tenantA, async () => {
    await client.query(
      `INSERT INTO journey_qavjp_snapshots (
         id, tenant_id, cohort_ref, period_starts_at, period_ends_at,
         frozen_at, eligibility_policy_version, source_snapshot_hash,
         source_record_count, excluded_record_count, eligible_item_count,
         denominator_weight_bps, owner_coverage_bps,
         next_action_coverage_bps, snapshot_hash
       ) VALUES (
         $1, $2, 'g45_pilot_2026', '2026-09-01T00:00:00Z',
         '2026-10-01T00:00:00Z', '2026-08-31T23:59:59Z',
         'g45_eligibility_v1', $3, 2, 0, 2, 10000, 10000, 10000, $4
       )`,
      [ID.qavjpSnapshotA, ID.tenantA, HASH_A, HASH_B],
    );
    await client.query(
      `INSERT INTO journey_qavjp_items (
         id, tenant_id, snapshot_id, application_case_id, subject_id,
         lifecycle_ref, milestone_code, due_at, owner_legacy_user_id,
         next_action, weight_bps, consent_evidence_kind,
         consent_evidence_ref, consent_evidence_sha256, dedup_key
       ) VALUES
         ($1, $2, $3, $4, $5, 'DOSSIER_VERIFIED', 'dossier_verified',
          '2026-09-05T12:00:00Z', $6, 'submit_application', 5000,
          'VERIFIED_EVIDENCE', 'consent:g45:synthetic', $7, $8),
         ($9, $2, $3, $4, $5, 'APPLICATION_SUBMITTED', 'application_submitted',
          '2026-09-10T12:00:00Z', $6, 'monitor_submission_receipt', 5000,
          'VERIFIED_EVIDENCE', 'consent:g45:synthetic', $7, $10)`,
      [
        ID.qavjpItemVerifyA,
        ID.tenantA,
        ID.qavjpSnapshotA,
        ID.applicationA,
        ID.subjectA,
        LEGACY.userA,
        HASH_A,
        "2".repeat(64),
        ID.qavjpItemSubmitA,
        "3".repeat(64),
      ],
    );
  });

  await tenantTransaction(client, ID.tenantA, async () => {
    const state = await client.query(
      `SELECT lifecycle_state, aggregate_version, active_dossier_revision_id
       FROM journey_application_cases WHERE tenant_id = $1 AND id = $2`,
      [ID.tenantA, ID.applicationA],
    );
    assert.deepEqual(state.rows[0], {
      lifecycle_state: "APPLICATION_SUBMITTED",
      aggregate_version: "3",
      active_dossier_revision_id: ID.dossierRevisionA,
    });
    const snapshot = await client.query(
      `SELECT eligible_item_count, denominator_weight_bps,
              owner_coverage_bps, next_action_coverage_bps
       FROM journey_qavjp_snapshots WHERE tenant_id = $1 AND id = $2`,
      [ID.tenantA, ID.qavjpSnapshotA],
    );
    assert.deepEqual(snapshot.rows[0], {
      eligible_item_count: 2,
      denominator_weight_bps: "10000",
      owner_coverage_bps: 10000,
      next_action_coverage_bps: 10000,
    });
  });
}

async function seed(): Promise<ReturnType<typeof createStudentDocumentIngestReceipt>> {
  return withClient(migratorUrl, async (migrator) => {
    const migrationCount = await migrator.query(
      "SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations",
    );
    assert.equal(migrationCount.rows[0]?.count, 105);
    const defaultGrantCount = await migrator.query(
      `SELECT count(*)::int AS count
       FROM role_package_capabilities
       WHERE capability_key IN (
         'student.journey.read', 'student.document_request.respond',
         'student.dossier.verify'
       )`,
    );
    assert.equal(defaultGrantCount.rows[0]?.count, 0);

    await migrator.query(
      `INSERT INTO branches (id, name) VALUES ($1, 'Journey A'), ($2, 'Journey B')`,
      [LEGACY.branchA, LEGACY.branchB],
    );
    await migrator.query(
      `INSERT INTO users (id, email, first_name, last_name, role, language)
       VALUES
         ($1, 'journey-a@example.test', 'Journey', 'A', 'student', 'en'),
         ($2, 'journey-b@example.test', 'Journey', 'B', 'student', 'en')`,
      [LEGACY.userA, LEGACY.userB],
    );
    await migrator.query(
      `INSERT INTO students (id, user_id, first_name, last_name, email)
       VALUES
         ($1, $2, 'Journey', 'A', 'journey-a@example.test'),
         ($3, $4, 'Journey', 'B', 'journey-b@example.test')`,
      [LEGACY.studentA, LEGACY.userA, LEGACY.studentB, LEGACY.userB],
    );
    await migrator.query(
      `INSERT INTO applications (id, student_id, stage)
       VALUES ($1, $2, 'inquiry'), ($3, $4, 'inquiry')`,
      [
        LEGACY.applicationA,
        LEGACY.studentA,
        LEGACY.applicationB,
        LEGACY.studentB,
      ],
    );
    await migrator.query(
      `INSERT INTO principals
        (id, principal_type, issuer, subject, legacy_user_id, status, risk_state)
       VALUES
         ($1, 'HUMAN', 'journey-g45-test', 'student-a', $2, 'ACTIVE', 'NORMAL'),
         ($3, 'HUMAN', 'journey-g45-test', 'student-b', $4, 'ACTIVE', 'NORMAL')`,
      [ID.principalA, LEGACY.userA, ID.principalB, LEGACY.userB],
    );
    await migrator.query(
      `INSERT INTO role_definitions
        (id, key, display_name, purpose, principal_type, status)
       VALUES ($1, 'student.pilot', 'Student Pilot', 'G45 local pilot', 'HUMAN', 'ACTIVE')`,
      [ID.role],
    );
    await migrator.query(
      `INSERT INTO role_package_versions
        (id, role_definition_id, version_number, status, default_scope_type,
         constraint_document, checksum, effective_at)
       VALUES ($1, $2, 1, 'ACTIVE', 'LEGACY_BRANCH', '{}'::jsonb, $3,
               '2026-08-01T00:00:00Z')`,
      [ID.rolePackage, ID.role, HASH_A],
    );
    await migrator.query(
      `INSERT INTO role_package_capabilities
        (role_package_version_id, capability_key, effect)
       VALUES ($1, $2, 'ALLOW'), ($1, 'student.dossier.verify', 'ALLOW')`,
      [ID.rolePackage, STUDENT_DOCUMENT_REQUEST_RESPOND_CAPABILITY],
    );

    await seedTenant(migrator, {
      tenantId: ID.tenantA,
      organizationId: ID.organizationA,
      principalId: ID.principalA,
      membershipId: ID.membershipA,
      policyId: ID.policyA,
      branchId: LEGACY.branchA,
      userId: LEGACY.userA,
      studentId: LEGACY.studentA,
      legacyApplicationId: LEGACY.applicationA,
      subjectId: ID.subjectA,
      dossierId: ID.dossierA,
      applicationId: ID.applicationA,
      requestIds: [
        ID.requestAck,
        ID.requestEvidence,
        ID.requestRevoked,
        ID.requestConcurrent,
        ID.requestRollback,
      ],
      slug: "journey-g45-a",
    });
    await seedTenant(migrator, {
      tenantId: ID.tenantB,
      organizationId: ID.organizationB,
      principalId: ID.principalB,
      membershipId: ID.membershipB,
      policyId: ID.policyB,
      branchId: LEGACY.branchB,
      userId: LEGACY.userB,
      studentId: LEGACY.studentB,
      legacyApplicationId: LEGACY.applicationB,
      subjectId: ID.subjectB,
      dossierId: ID.dossierB,
      applicationId: ID.applicationB,
      requestIds: [ID.requestB],
      slug: "journey-g45-b",
    });

    await tenantTransaction(migrator, ID.tenantA, async () => {
      await migrator.query(
        `INSERT INTO authorization_change_receipts (
           id, tenant_id, receipt_type, actor_principal_id, actor_membership_id,
           resource_type, resource_id, reason_code, correlation_id, evidence,
           receipt_hash
         ) VALUES (
           $1, $2, 'GRANT', $3, $4, 'ACCESS_ASSIGNMENT', $5,
           'g45_local_pilot', 'g45-local-pilot-grant', '{}'::jsonb, $6
         )`,
        [ID.grantA, ID.tenantA, ID.principalA, ID.membershipA, ID.assignmentA, HASH_A],
      );
      await migrator.query(
        `INSERT INTO access_assignments (
           id, tenant_id, membership_id, role_package_version_id, scope_type,
           organization_id, legacy_branch_id, status, valid_from,
           granted_by_principal_id, granted_by_membership_id, grant_receipt_id
         ) VALUES (
           $1, $2, $3, $4, 'LEGACY_BRANCH', $5, $6, 'ACTIVE',
           '2026-08-01T00:00:00Z', $7, $3, $8
         )`,
        [
          ID.assignmentA,
          ID.tenantA,
          ID.membershipA,
          ID.rolePackage,
          ID.organizationA,
          LEGACY.branchA,
          ID.principalA,
          ID.grantA,
        ],
      );
      await migrator.query(
        `INSERT INTO active_session_context_selections (
           id, tenant_id, session_fingerprint, session_generation,
           legacy_user_id, principal_id, membership_id, organization_id,
           legacy_branch_id, status
         ) VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, 'ACTIVE')`,
        [
          ID.selectionA,
          ID.tenantA,
          HASH_B,
          LEGACY.userA,
          ID.principalA,
          ID.membershipA,
          ID.organizationA,
          LEGACY.branchA,
        ],
      );
    });

    const ingest = createStudentDocumentIngestReceipt({
      id: ID.ingestA,
      tenantId: ID.tenantA,
      subjectRef: ID.subjectA,
      applicationRef: ID.applicationA,
      requestRef: ID.requestEvidence,
      objectRef: "private:journey-g45:document-1",
      contentSha256: HASH_B,
      scanStatus: "PASSED",
      occurredAt: EARLIER,
    });
    await tenantTransaction(migrator, ID.tenantA, async () => {
      await migrator.query(
        `INSERT INTO journey_document_ingest_receipts (
           id, tenant_id, subject_id, application_case_id, document_request_id,
           object_ref, content_sha256, scan_status, occurred_at, receipt_hash
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          ingest.id,
          ingest.tenantId,
          ingest.subjectRef,
          ingest.applicationRef,
          ingest.requestRef,
          ingest.objectRef,
          ingest.contentSha256,
          ingest.scanStatus,
          ingest.occurredAt,
          ingest.receiptHash,
        ],
      );
      await migrator.query("SAVEPOINT external_channel_guard");
      await assert.rejects(
        migrator.query(
          `INSERT INTO journey_notification_intents (
             id, tenant_id, subject_id, application_case_id, task_state_ref,
             purpose, category, channel, locale, intended_at, dedup_key,
             policy_version, status
           ) VALUES (
             '018f8200-0000-7000-8000-000000000401', $1, $2, $3,
             'document.request.open', 'journey_action', 'ACTION_REQUIRED',
             'email', 'en', $4, $5, 'g45-pilot-v1', 'READY'
           )`,
          [ID.tenantA, ID.subjectA, ID.applicationA, NOW, HASH_A],
        ),
        /journey_notification_intents_default_off_chk/,
      );
      await migrator.query("ROLLBACK TO SAVEPOINT external_channel_guard");
    });
    await verifyLifecycleFoundation(migrator);
    return ingest;
  });
}

async function configureRuntimeAuthority(): Promise<void> {
  await withClient(adminUrl, async (admin) => {
    const roleIdentity = await admin.query(
      `SELECT rolsuper, rolcreatedb, rolcreaterole, rolinherit,
              rolreplication, rolbypassrls, rolcanlogin
       FROM pg_roles WHERE rolname = 'fas_journey_executor'`,
    );
    assert.deepEqual(roleIdentity.rows[0], {
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolinherit: false,
      rolreplication: false,
      rolbypassrls: false,
      rolcanlogin: true,
    });
    const ownerIdentity = await admin.query(
      `SELECT rolsuper, rolcreatedb, rolcreaterole, rolinherit,
              rolreplication, rolbypassrls, rolcanlogin,
              pg_has_role('fas_journey_executor', 'fas_journey_owner', 'MEMBER')
                AS executor_is_owner_member
       FROM pg_roles WHERE rolname = 'fas_journey_owner'`,
    );
    assert.deepEqual(ownerIdentity.rows[0], {
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolinherit: false,
      rolreplication: false,
      rolbypassrls: false,
      rolcanlogin: false,
      executor_is_owner_member: false,
    });
    await admin.query("GRANT CONNECT ON DATABASE fasos_apply_local TO fas_journey_executor");
    await admin.query("GRANT USAGE ON SCHEMA public TO fas_journey_executor");
    await admin.query(
      "GRANT USAGE ON SCHEMA fas_journey_v1 TO fas_journey_owner, fas_journey_executor",
    );
    for (const table of JOURNEY_TABLES) {
      await admin.query(`ALTER TABLE public.${table} OWNER TO fas_journey_owner`);
      await admin.query(`REVOKE ALL ON TABLE public.${table} FROM PUBLIC`);
      await admin.query(`REVOKE ALL ON TABLE public.${table} FROM fas_journey_executor`);
      await admin.query(`GRANT SELECT ON TABLE public.${table} TO fas_journey_executor`);
    }
    for (const table of AUTHORITY_READ_TABLES) {
      await admin.query(`REVOKE ALL ON TABLE public.${table} FROM fas_journey_executor`);
      await admin.query(`GRANT SELECT, UPDATE ON TABLE public.${table} TO fas_journey_owner`);
    }
    await admin.query(
      `ALTER FUNCTION fas_journey_v1.revalidate_document_request_response_authority(
         uuid, uuid, bigint, uuid, uuid, timestamp with time zone,
         uuid, uuid, uuid, uuid
       ) OWNER TO fas_journey_owner`,
    );
    await admin.query(
      `GRANT EXECUTE ON FUNCTION fas_journey_v1.revalidate_document_request_response_authority(
         uuid, uuid, bigint, uuid, uuid, timestamp with time zone,
         uuid, uuid, uuid, uuid
       ) TO fas_journey_executor`,
    );
    for (const table of [
      "journey_document_access_receipts",
      "journey_document_response_receipts",
      "journey_document_response_audits",
      "journey_document_ingest_consumptions",
      "journey_document_response_commands",
      "journey_outbox_events",
    ]) {
      await admin.query(`GRANT INSERT ON TABLE public.${table} TO fas_journey_executor`);
    }
    for (const table of [
      "journey_document_requests",
      "journey_document_response_commands",
    ]) {
      await admin.query(`GRANT UPDATE ON TABLE public.${table} TO fas_journey_executor`);
    }
    const tableBoundary = await admin.query(
      `SELECT count(*)::int AS table_count,
              count(*) FILTER (WHERE relrowsecurity)::int AS rls_count,
              count(*) FILTER (WHERE relforcerowsecurity)::int AS force_rls_count,
              count(*) FILTER (
                WHERE pg_get_userbyid(relowner) = 'fas_journey_owner'
              )::int AS owner_count
       FROM pg_class
       WHERE relnamespace = 'public'::regnamespace
         AND relkind = 'r'
         AND relname = ANY($1::text[])`,
      [[...JOURNEY_TABLES]],
    );
    assert.deepEqual(tableBoundary.rows[0], {
      table_count: JOURNEY_TABLES.length,
      rls_count: JOURNEY_TABLES.length,
      force_rls_count: JOURNEY_TABLES.length,
      owner_count: JOURNEY_TABLES.length,
    });
    const authorityFunction = await admin.query(
      `SELECT prosecdef,
              pg_get_userbyid(proowner) AS owner_name,
              proconfig
       FROM pg_proc
       WHERE oid = 'fas_journey_v1.revalidate_document_request_response_authority(
         uuid,uuid,bigint,uuid,uuid,timestamp with time zone,uuid,uuid,uuid,uuid
       )'::regprocedure`,
    );
    assert.equal(authorityFunction.rows[0]?.prosecdef, true);
    assert.equal(authorityFunction.rows[0]?.owner_name, "fas_journey_owner");
    assert.deepEqual(authorityFunction.rows[0]?.proconfig, [
      "search_path=pg_catalog, public",
      "row_security=on",
    ]);
  });
}

function authority(overrides: Partial<StudentDocumentRequestAuthority> = {}): StudentDocumentRequestAuthority {
  return {
    schemaVersion: 1,
    capabilityKey: STUDENT_DOCUMENT_REQUEST_RESPOND_CAPABILITY,
    resourceType: "student_document_request",
    tenantId: ID.tenantA,
    contextId: ID.contextA,
    selectionId: ID.selectionA,
    sessionGeneration: 1,
    actorPrincipalId: ID.principalA,
    actorMembershipId: ID.membershipA,
    subjectRef: ID.subjectA,
    applicationRef: ID.applicationA,
    requestRef: ID.requestAck,
    policyVersionId: ID.policyA,
    decision: "ALLOW",
    ...overrides,
  };
}

let generatedSequence = 500;
function newUuidV7(): string {
  generatedSequence += 1;
  return `018f82ff-0000-7000-8000-${String(generatedSequence).padStart(12, "0")}`;
}

async function inspectCount(table: string, tenantId = ID.tenantA): Promise<number> {
  return withClient(adminUrl, async (admin) => {
    const result = await admin.query(
      `SELECT count(*)::int AS count FROM public.${table} WHERE tenant_id = $1`,
      [tenantId],
    );
    return result.rows[0]?.count as number;
  });
}

async function verifyRuntime(
  ingest: ReturnType<typeof createStudentDocumentIngestReceipt>,
): Promise<void> {
  const pool = new Pool({
    connectionString: executorUrl,
    max: 4,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000,
  });
  const store = createPostgresStudentDocumentRequestResponseStore({
    pool,
    expectedRole: "fas_journey_executor",
  });
  const now = () => new Date(NOW);
  try {
    const authorityCurrent = await store.transaction(ID.tenantA, (tx) =>
      tx.revalidateAuthorityForUpdate({ authority: authority(), occurredAt: NOW }),
    );
    assert.equal(authorityCurrent, true, "seeded student authority must be current");

    const acknowledged = await executeStudentDocumentRequestResponse({
      command: {
        commandId: ID.commandAck,
        idempotencyKey: "g45-acknowledge-0001",
        expectedVersion: 1,
        response: { kind: "ACKNOWLEDGE" },
      },
      authority: authority(),
      store,
      now,
      newUuidV7,
    });
    assert.equal(acknowledged.ok, true, JSON.stringify(acknowledged));
    if (!acknowledged.ok) assert.fail(acknowledged.reason);
    assert.equal(acknowledged.replayed, false);
    assert.equal(acknowledged.receipt.toState, "OPEN");
    assert.equal(await inspectCount("journey_document_response_receipts"), 1);
    assert.equal(await inspectCount("journey_outbox_events"), 3);

    const replayed = await executeStudentDocumentRequestResponse({
      command: {
        commandId: ID.commandAck,
        idempotencyKey: "g45-acknowledge-0001",
        expectedVersion: 1,
        response: { kind: "ACKNOWLEDGE" },
      },
      authority: authority(),
      store,
      now,
      newUuidV7,
    });
    assert.equal(replayed.ok, true);
    if (!replayed.ok) assert.fail(replayed.reason);
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.receipt.id, acknowledged.receipt.id);
    assert.equal(await inspectCount("journey_document_response_receipts"), 1);
    assert.equal(await inspectCount("journey_document_access_receipts"), 2);

    const responded = await executeStudentDocumentRequestResponse({
      command: {
        commandId: ID.commandEvidence,
        idempotencyKey: "g45-evidence-submit-0001",
        expectedVersion: 1,
        response: { kind: "EVIDENCE_SUBMITTED", ingestReceipt: ingest },
      },
      authority: authority({ requestRef: ID.requestEvidence }),
      store,
      now,
      newUuidV7,
    });
    assert.equal(responded.ok, true);
    if (!responded.ok) assert.fail(responded.reason);
    assert.equal(responded.replayed, false);
    assert.equal(responded.receipt.toState, "RESPONDED");
    assert.equal(await inspectCount("journey_document_ingest_consumptions"), 1);
    assert.equal(await inspectCount("journey_document_response_receipts"), 2);
    assert.equal(await inspectCount("journey_outbox_events"), 4);

    const crossTenant = await executeStudentDocumentRequestResponse({
      command: {
        commandId: ID.commandCrossTenant,
        idempotencyKey: "g45-cross-tenant-0001",
        expectedVersion: 1,
        response: { kind: "ACKNOWLEDGE" },
      },
      authority: authority({
        subjectRef: ID.subjectB,
        applicationRef: ID.applicationB,
        requestRef: ID.requestB,
      }),
      store,
      now,
      newUuidV7,
    });
    assert.deepEqual(crossTenant, { ok: false, reason: "authority_revoked" });
    assert.equal(await inspectCount("journey_document_response_receipts", ID.tenantB), 0);

    const concurrentInput = {
      command: {
        commandId: ID.commandConcurrent,
        idempotencyKey: "g45-concurrent-ack-0001",
        expectedVersion: 1,
        response: { kind: "ACKNOWLEDGE" as const },
      },
      authority: authority({ requestRef: ID.requestConcurrent }),
      store,
      now,
      newUuidV7,
    };
    const concurrent = await Promise.all([
      executeStudentDocumentRequestResponse(concurrentInput),
      executeStudentDocumentRequestResponse(concurrentInput),
    ]);
    assert.equal(concurrent.every((result) => result.ok), true);
    assert.deepEqual(
      concurrent.map((result) => (result.ok ? result.replayed : null)).sort(),
      [false, true],
    );
    assert.equal(await inspectCount("journey_document_response_receipts"), 3);
    assert.equal(await inspectCount("journey_document_access_receipts"), 5);
    assert.equal(await inspectCount("journey_outbox_events"), 5);

    const rollbackStore: StudentDocumentRequestResponseStore = {
      async transaction<T>(
        tenantId: string,
        operation: (
          transaction: StudentDocumentRequestResponseTransaction,
        ) => Promise<T>,
      ): Promise<T> {
        return store.transaction(tenantId, (transaction) => {
          const injected = new Proxy(transaction, {
            get(target, property, receiver) {
              if (property === "insertResponseReceipt") {
                return async (...args: Parameters<typeof target.insertResponseReceipt>) => {
                  await target.insertResponseReceipt(...args);
                  throw new Error("synthetic_after_response_receipt_failure");
                };
              }
              const value = Reflect.get(target, property, receiver) as unknown;
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
          return operation(injected);
        });
      },
    };
    const rolledBack = await executeStudentDocumentRequestResponse({
      command: {
        commandId: ID.commandRollback,
        idempotencyKey: "g45-rollback-guard-0001",
        expectedVersion: 1,
        response: { kind: "ACKNOWLEDGE" },
      },
      authority: authority({ requestRef: ID.requestRollback }),
      store: rollbackStore,
      now,
      newUuidV7,
    });
    assert.deepEqual(rolledBack, { ok: false, reason: "store_unavailable" });
    assert.equal(await inspectCount("journey_document_response_receipts"), 3);
    assert.equal(await inspectCount("journey_document_access_receipts"), 5);
    assert.equal(await inspectCount("journey_outbox_events"), 5);
    await withClient(adminUrl, async (admin) => {
      const request = await admin.query(
        `SELECT state, version, acknowledged_at
         FROM journey_document_requests WHERE tenant_id = $1 AND id = $2`,
        [ID.tenantA, ID.requestRollback],
      );
      assert.deepEqual(request.rows[0], {
        state: "OPEN",
        version: "1",
        acknowledged_at: null,
      });
    });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [ID.tenantA]);
      const tenantARequests = await client.query(
        "SELECT count(*)::int AS count FROM journey_document_requests",
      );
      assert.equal(tenantARequests.rows[0]?.count, 5);
      await client.query("ROLLBACK");
      const noContext = await client.query(
        "SELECT count(*)::int AS count FROM journey_document_requests",
      );
      assert.equal(noContext.rows[0]?.count, 0);
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [ID.tenantB]);
      const tenantBRequests = await client.query(
        "SELECT count(*)::int AS count FROM journey_document_requests",
      );
      assert.equal(tenantBRequests.rows[0]?.count, 1);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    await withClient(executorUrl, async (executor) => {
      await assert.rejects(
        executor.query("SELECT id FROM active_session_context_selections LIMIT 1"),
        /permission denied for table active_session_context_selections/,
      );
      await executor.query("BEGIN");
      await executor.query("SELECT set_config('app.tenant_id', $1, true)", [ID.tenantA]);
      await assert.rejects(
        executor.query(
          "UPDATE journey_document_response_receipts SET receipt_hash = $1 WHERE tenant_id = $2",
          [HASH_B, ID.tenantA],
        ),
        /permission denied for table journey_document_response_receipts/,
      );
      await executor.query("ROLLBACK");
    });
    await withClient(adminUrl, async (admin) => {
      await assert.rejects(
        admin.query(
          "UPDATE journey_document_response_receipts SET receipt_hash = $1 WHERE tenant_id = $2",
          [HASH_B, ID.tenantA],
        ),
        /journey append-only record cannot be mutated/,
      );
    });

    await withClient(adminUrl, async (admin) => {
      await admin.query(
        `UPDATE active_session_context_selections
         SET status = 'REVOKED', termination_reason = 'SECURITY_REVOKE',
             row_version = row_version + 1
         WHERE tenant_id = $1 AND id = $2`,
        [ID.tenantA, ID.selectionA],
      );
    });
    const revoked = await executeStudentDocumentRequestResponse({
      command: {
        commandId: ID.commandRevoked,
        idempotencyKey: "g45-revoked-selection-0001",
        expectedVersion: 1,
        response: { kind: "ACKNOWLEDGE" },
      },
      authority: authority({ requestRef: ID.requestRevoked }),
      store,
      now,
      newUuidV7,
    });
    assert.deepEqual(revoked, { ok: false, reason: "authority_revoked" });
  } finally {
    await pool.end();
  }
}

const ingest = await seed();
await configureRuntimeAuthority();
await verifyRuntime(ingest);

console.log(
  "[student-journey-g45] PASS: default-off capability, lifecycle receipts/milestones, frozen QAVJP, dedicated executor, current authority, tenant RLS, idempotency concurrency, rollback, safe ingest consumption, outbox, immutable audit, and external-channel deny",
);
