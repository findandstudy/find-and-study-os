import assert from "node:assert/strict";
import { after, test } from "node:test";
import pg from "pg";
import { parseInstitutionEvidenceShareConfig } from "../src/lib/institutionEvidenceShare";
import { PostgresInstitutionEvidenceShareStore } from "../src/lib/postgresInstitutionEvidenceShareStore";

if (process.env.ALLOW_DISPOSABLE_INSTITUTION_EVIDENCE_SHARE_TEST !== "true") {
  throw new Error("institution_evidence_share_test_requires_explicit_disposable_opt_in");
}
const adminUrl = process.env.INSTITUTION_EVIDENCE_TEST_ADMIN_DATABASE_URL;
const executorUrl = process.env.INSTITUTION_EVIDENCE_TEST_EXECUTOR_DATABASE_URL;
const actorUrl = process.env.INSTITUTION_EVIDENCE_TEST_ACTOR_DATABASE_URL;
if (!adminUrl || !executorUrl || !actorUrl) {
  throw new Error("institution_evidence_share_test_urls_required");
}
for (const raw of [adminUrl, executorUrl, actorUrl]) {
  const url = new URL(raw);
  if (
    !["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname) ||
    !/^(?:fas_(?:dev|it)_[a-z0-9_]+|fasos_apply_local)$/.test(url.pathname.slice(1))
  ) {
    throw new Error("institution_evidence_share_test_requires_disposable_loopback_database");
  }
}
if (new URL(executorUrl).username !== "fas_institution_evidence_share_executor") {
  throw new Error("institution_evidence_share_test_requires_exact_share_executor");
}
if (new URL(actorUrl).username !== "fas_institution_executor") {
  throw new Error("institution_evidence_share_test_requires_exact_institution_actor");
}

const ID = {
  tenant: "018f9500-0000-7000-8000-000000000001",
  organization: "018f9500-0000-7000-8000-000000000002",
  relationship: "018f9500-0000-7000-8000-000000000003",
  principal: "018f9500-0000-7000-8000-000000000004",
  membership: "018f9500-0000-7000-8000-000000000005",
  institutionMembership: "018f9500-0000-7000-8000-000000000006",
  policy: "018f9500-0000-7000-8000-000000000007",
  subject: "018f9500-0000-7000-8000-000000000008",
  dossier: "018f9500-0000-7000-8000-000000000009",
  requirementSet: "018f9500-0000-7000-8000-00000000000a",
  requirementItem: "018f9500-0000-7000-8000-00000000000b",
  dossierRevision: "018f9500-0000-7000-8000-00000000000c",
  journeyCase: "018f9500-0000-7000-8000-00000000000d",
  accessReceipt: "018f9500-0000-7000-8000-00000000000e",
  evidenceReceipt: "018f9500-0000-7000-8000-00000000000f",
  requirementResult: "018f9500-0000-7000-8000-000000000010",
  consentCaptured: "018f9500-0000-7000-8000-000000000011",
  consentWithdrawn: "018f9500-0000-7000-8000-000000000012",
  institutionCase: "018f9500-0000-7000-8000-000000000013",
  assessment: "018f9500-0000-7000-8000-000000000014",
  tamperedAssessment: "018f9500-0000-7000-8000-000000000015",
  context: "018f9500-0000-7000-8000-000000000017",
  inactiveMembershipAssessment: "018f9500-0000-7000-8000-000000000018",
  outOfScopeAssessment: "018f9500-0000-7000-8000-000000000019",
  institutionRequirementSet: "018f9500-0000-7000-8000-00000000001a",
  institutionRequirement: "018f9500-0000-7000-8000-00000000001b",
  approverPrincipal: "018f9500-0000-7000-8000-00000000001c",
  approverMembership: "018f9500-0000-7000-8000-00000000001d",
  enrolment: "018f9500-0000-7000-8000-00000000001e",
};
const LEGACY = {
  branch: 995001,
  user: 995001,
  approverUser: 995002,
  student: 995001,
  application: 995001,
  university: 995001,
  program: 995001,
};
const HASH = {
  a: "a".repeat(64),
  b: "b".repeat(64),
  c: "c".repeat(64),
  d: "d".repeat(64),
  e: "e".repeat(64),
};
const RAW_EVIDENCE_REF = "private:student:passport:must-not-leak";

const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
assert.equal((await admin.query(
  "SELECT count(*)::integer AS count FROM drizzle.__drizzle_migrations",
)).rows[0]?.count, 101);
const databaseName = new URL(adminUrl).pathname.slice(1);

await admin.query(`DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='fas_institution_evidence_owner') THEN
    CREATE ROLE fas_institution_evidence_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='fas_institution_evidence_share_executor') THEN
    CREATE ROLE fas_institution_evidence_share_executor LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='fas_institution_executor') THEN
    CREATE ROLE fas_institution_executor LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END $$`);
await admin.query("ALTER ROLE fas_institution_evidence_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS");
await admin.query("ALTER ROLE fas_institution_evidence_share_executor LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS");
await admin.query("ALTER ROLE fas_institution_executor LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS");
await admin.query(`GRANT CONNECT ON DATABASE ${databaseName} TO fas_institution_evidence_share_executor,fas_institution_executor`);
await admin.query("GRANT USAGE ON SCHEMA fas_institution_evidence_v1 TO fas_institution_evidence_share_executor,fas_institution_executor");
await admin.query(`GRANT SELECT ON TABLE
  tenants,institution_relationships,institution_application_cases,
  institution_memberships,institution_evidence_assessments,
  institution_requirements,institution_requirement_sets,
  institution_evidence_share_receipts,journey_application_cases,
  journey_verified_evidence_receipts,journey_requirement_results,
  journey_consent_receipts TO fas_institution_evidence_owner`);
await admin.query("GRANT INSERT ON TABLE institution_evidence_share_receipts TO fas_institution_evidence_owner");
await admin.query(`GRANT EXECUTE ON FUNCTION institution_current_program_scope_ids(),
  institution_current_intake_scopes(),institution_case_scope_matches(integer,text,uuid)
  TO fas_institution_evidence_owner`);
await admin.query(`ALTER FUNCTION fas_institution_evidence_v1.create_share_receipt(
  uuid,uuid,uuid,uuid,uuid,uuid
) OWNER TO fas_institution_evidence_owner`);
await admin.query(`ALTER FUNCTION fas_institution_evidence_v1.resolve_assessable_share(
  uuid,uuid,uuid,uuid,timestamptz
) OWNER TO fas_institution_evidence_owner`);
await admin.query(`ALTER FUNCTION fas_institution_evidence_v1.resolve_enrolment_confirmation(
  uuid,uuid,uuid,uuid,timestamptz
) OWNER TO fas_institution_evidence_owner`);
await admin.query(`GRANT EXECUTE ON FUNCTION fas_institution_evidence_v1.create_share_receipt(
  uuid,uuid,uuid,uuid,uuid,uuid
) TO fas_institution_evidence_share_executor`);
await admin.query(`GRANT EXECUTE ON FUNCTION fas_institution_evidence_v1.resolve_assessable_share(
  uuid,uuid,uuid,uuid,timestamptz
) TO fas_institution_executor`);
await admin.query(`GRANT EXECUTE ON FUNCTION fas_institution_evidence_v1.resolve_enrolment_confirmation(
  uuid,uuid,uuid,uuid,timestamptz
) TO fas_institution_executor`);
await admin.query(`GRANT USAGE ON SCHEMA public TO fas_institution_executor;
  GRANT SELECT ON TABLE institution_application_cases,institution_evidence_share_receipts,
    institution_evidence_assessments,institution_requirements,institution_requirement_sets
    TO fas_institution_executor;
  GRANT SELECT,INSERT ON TABLE institution_evidence_assessments TO fas_institution_executor;
  GRANT SELECT,INSERT,UPDATE ON TABLE institution_enrolments TO fas_institution_executor;
  GRANT EXECUTE ON FUNCTION institution_current_program_scope_ids(),
    institution_current_intake_scopes(),institution_case_scope_matches(integer,text,uuid)
    TO fas_institution_executor`);

await admin.query(`
  INSERT INTO branches (id,name) VALUES (${LEGACY.branch},'Institution Evidence Test Branch');
  INSERT INTO users (id,email,first_name,last_name,role,is_active,email_verified)
  VALUES (${LEGACY.user},'evidence-share@example.test','Evidence','Subject','student',true,true);
  INSERT INTO users (id,email,first_name,last_name,role,is_active,email_verified)
  VALUES (${LEGACY.approverUser},'evidence-approver@example.test','Evidence','Approver','institution_user',true,true);
  INSERT INTO students (id,user_id,first_name,last_name,email)
  VALUES (${LEGACY.student},${LEGACY.user},'Evidence','Subject','evidence-share@example.test');
  INSERT INTO universities (id,name,country,is_active)
  VALUES (${LEGACY.university},'Institution Evidence University','TR',true);
  INSERT INTO programs (id,university_id,name,is_active,intakes)
  VALUES (${LEGACY.program},${LEGACY.university},'Evidence Program',true,'Fall');
  INSERT INTO applications (id,student_id,program_id,university_id,intake,branch_id,stage)
  VALUES (${LEGACY.application},${LEGACY.student},${LEGACY.program},${LEGACY.university},'Fall',${LEGACY.branch},'submitted');
  INSERT INTO tenants (id,slug,legal_name,display_name,status,home_region,policy_version)
  VALUES ('${ID.tenant}','institution-evidence-test','Institution Evidence Test','Institution Evidence Test','ACTIVE','eu-test',1);
  INSERT INTO organizations (id,tenant_id,legal_name,display_name,organization_type,status)
  VALUES ('${ID.organization}','${ID.tenant}','Evidence Organization','Evidence Organization','OPERATING_ENTITY','ACTIVE');
  INSERT INTO tenant_organization_legacy_branches (tenant_id,organization_id,legacy_branch_id)
  VALUES ('${ID.tenant}','${ID.organization}',${LEGACY.branch});
  INSERT INTO principals (id,principal_type,issuer,subject,legacy_user_id,status,risk_state)
  VALUES ('${ID.principal}','HUMAN','institution-evidence-test','reviewer-and-verifier',${LEGACY.user},'ACTIVE','NORMAL');
  INSERT INTO principals (id,principal_type,issuer,subject,legacy_user_id,status,risk_state)
  VALUES ('${ID.approverPrincipal}','HUMAN','institution-evidence-test','decision-approver',${LEGACY.approverUser},'ACTIVE','NORMAL');
  INSERT INTO memberships (id,tenant_id,organization_id,legacy_branch_id,principal_id,status,valid_from)
  VALUES ('${ID.membership}','${ID.tenant}','${ID.organization}',${LEGACY.branch},'${ID.principal}','ACTIVE',now()-interval '1 day');
  INSERT INTO policy_versions (id,tenant_id,version_number,checksum,state,effective_at)
  VALUES ('${ID.policy}','${ID.tenant}',1,'${HASH.a}','ACTIVE',now()-interval '1 day');
  INSERT INTO institution_relationships (id,tenant_id,institution_id,purpose_code,data_scopes,status)
  VALUES ('${ID.relationship}','${ID.tenant}',${LEGACY.university},'admissions.review',ARRAY['application.profile','application.evidence','application.enrolment'],'ACTIVE');
  INSERT INTO institution_memberships (
    id,tenant_id,relationship_id,principal_id,role_package_version_id,
    legacy_user_id,role_key,status
  ) VALUES (
    '${ID.institutionMembership}','${ID.tenant}','${ID.relationship}','${ID.principal}',
    '018f9000-0000-7000-8000-000000000013',${LEGACY.user},'ADMISSIONS_REVIEWER','ACTIVE'
  );
  INSERT INTO institution_memberships (
    id,tenant_id,relationship_id,principal_id,role_package_version_id,
    legacy_user_id,role_key,status
  ) VALUES (
    '${ID.approverMembership}','${ID.tenant}','${ID.relationship}','${ID.approverPrincipal}',
    '018f9000-0000-7000-8000-000000000014',${LEGACY.approverUser},'DECISION_APPROVER','ACTIVE'
  );
  INSERT INTO institution_requirement_sets (
    id,tenant_id,relationship_id,program_id,intake_key,version_number,state,
    source_ref,source_hash,content_hash,effective_from,created_by_membership_id,
    approved_by_membership_id,published_at
  ) VALUES (
    '${ID.institutionRequirementSet}','${ID.tenant}','${ID.relationship}',
    ${LEGACY.program},'Fall',1,'PUBLISHED','synthetic-enrolment-policy',
    '${HASH.a}','${HASH.b}',now()-interval '1 day','${ID.institutionMembership}',
    '${ID.approverMembership}',now()-interval '1 day'
  );
  INSERT INTO institution_requirements (
    id,tenant_id,requirement_set_id,requirement_code,title,evidence_type,
    mandatory,rule,sort_order
  ) VALUES (
    '${ID.institutionRequirement}','${ID.tenant}','${ID.institutionRequirementSet}',
    'ENROLMENT_CONFIRMATION','Enrolment confirmation','ENROLMENT_CONFIRMATION',
    true,'{}'::jsonb,1
  );
  INSERT INTO journey_subjects (
    id,tenant_id,organization_id,legacy_branch_id,legacy_student_id,
    legacy_user_id,subject_ref
  ) VALUES (
    '${ID.subject}','${ID.tenant}','${ID.organization}',${LEGACY.branch},
    ${LEGACY.student},${LEGACY.user},'institution-evidence-subject'
  );
  INSERT INTO journey_requirement_sets (
    id,tenant_id,organization_id,legacy_branch_id,corridor_code,
    version_number,authority_source,authority_source_hash,effective_from,
    published_at,set_hash
  ) VALUES (
    '${ID.requirementSet}','${ID.tenant}','${ID.organization}',${LEGACY.branch},
    'pilot.uk.undergraduate',1,'REVIEWED_MANUAL_IMPORT','${HASH.a}',
    now()-interval '1 day',now()-interval '1 day','${HASH.b}'
  );
  INSERT INTO journey_requirement_items (
    id,tenant_id,requirement_set_id,requirement_code,evidence_kind,mandatory,ordinal,item_hash
  ) VALUES (
    '${ID.requirementItem}','${ID.tenant}','${ID.requirementSet}',
    'enrolment_confirmation','enrolment_confirmation',true,1,'${HASH.c}'
  );
  INSERT INTO journey_dossiers (id,tenant_id,subject_id)
  VALUES ('${ID.dossier}','${ID.tenant}','${ID.subject}');
  INSERT INTO journey_dossier_revisions (
    id,tenant_id,dossier_id,requirement_set_id,revision_number,revision_state,
    source_snapshot_hash,revision_hash,recorded_at
  ) VALUES (
    '${ID.dossierRevision}','${ID.tenant}','${ID.dossier}','${ID.requirementSet}',
    1,'VERIFIED','${HASH.a}','${HASH.b}',now()-interval '2 hours'
  );
  INSERT INTO journey_application_cases (
    id,tenant_id,organization_id,legacy_branch_id,subject_id,dossier_id,
    legacy_application_id,corridor_code,lifecycle_state,active_dossier_revision_id
  ) VALUES (
    '${ID.journeyCase}','${ID.tenant}','${ID.organization}',${LEGACY.branch},
    '${ID.subject}','${ID.dossier}',${LEGACY.application},'pilot.uk.undergraduate',
    'DOSSIER_VERIFIED','${ID.dossierRevision}'
  );
  INSERT INTO access_decision_receipts (
    id,tenant_id,context_id,actor_principal_id,membership_id,assignment_ids,
    role_package_version_ids,capability_key,resource_type,resource_id,decision,
    reason_code,policy_version_id,correlation_id,occurred_at
  ) VALUES (
    '${ID.accessReceipt}','${ID.tenant}','${ID.context}','${ID.principal}',
    '${ID.membership}',ARRAY[]::uuid[],ARRAY[]::uuid[],'student.dossier.verify',
    'DOSSIER_REVISION','${ID.dossierRevision}','ALLOW','synthetic_test_allow',
    '${ID.policy}','institution-evidence-test',now()-interval '90 minutes'
  );
  INSERT INTO journey_verified_evidence_receipts (
    id,tenant_id,subject_id,application_case_id,dossier_revision_id,dossier_id,
    requirement_set_id,requirement_code,evidence_ref,content_sha256,
    verification_policy_version,verifier_principal_id,verifier_membership_id,
    access_decision_receipt_id,recorded_at,receipt_hash
  ) VALUES (
    '${ID.evidenceReceipt}','${ID.tenant}','${ID.subject}','${ID.journeyCase}',
    '${ID.dossierRevision}','${ID.dossier}','${ID.requirementSet}','enrolment_confirmation',
    '${RAW_EVIDENCE_REF}','${HASH.d}','g45_verification_v1','${ID.principal}',
    '${ID.membership}','${ID.accessReceipt}',now()-interval '1 hour','${HASH.e}'
  );
  INSERT INTO journey_requirement_results (
    id,tenant_id,dossier_revision_id,dossier_id,requirement_set_id,
    requirement_code,result_state,evidence_receipt_id,result_hash,recorded_at
  ) VALUES (
    '${ID.requirementResult}','${ID.tenant}','${ID.dossierRevision}','${ID.dossier}',
    '${ID.requirementSet}','enrolment_confirmation','VERIFIED','${ID.evidenceReceipt}',
    '${HASH.a}',now()-interval '1 hour'
  );
`);
const portalSubmission = await admin.query<{ id: number }>(`
  INSERT INTO portal_submissions (
    application_id,student_id,university_key,university_name,adapter_key,
    mode,status,external_ref,attempts,max_attempts
  ) VALUES (
    ${LEGACY.application},${LEGACY.student},'institution-evidence-test',
    'Institution Evidence University','test-adapter','real','submitted',
    'RAW-PORTAL-REF',1,3
  ) RETURNING id
`);
const portalSubmissionId = portalSubmission.rows[0].id;
await admin.query(`INSERT INTO institution_application_cases (
  id,tenant_id,relationship_id,legacy_application_id,institution_id,program_id,
  intake_key,masked_student_ref,shared_profile,lifecycle_state,readiness_percent,
  blocker_code,source_portal_submission_id,source_snapshot_hash,intake_receipt_hash
) VALUES (
  $1,$2,$3,$4,$5,$6,'Fall','STU-0123456789ABCDEF','{}'::jsonb,'OFFER_ISSUED',0,
  'EVIDENCE_NOT_SHARED',$7,$8,$9
)`, [ID.institutionCase, ID.tenant, ID.relationship, LEGACY.application,
  LEGACY.university, LEGACY.program, portalSubmissionId, HASH.b, HASH.c]);

const executorPool = new pg.Pool({
  connectionString: executorUrl,
  max: 3,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 5_000,
  statement_timeout: 8_000,
  query_timeout: 8_000,
  allowExitOnIdle: true,
});
const actor = new pg.Client({ connectionString: actorUrl });
await actor.connect();
const enabledStore = new PostgresInstitutionEvidenceShareStore({
  pool: executorPool,
  config: parseInstitutionEvidenceShareConfig({
    INSTITUTION_EVIDENCE_SHARE_V1_MODE: "allowlist",
    INSTITUTION_EVIDENCE_SHARE_V1_RELATIONSHIP_ALLOWLIST: ID.relationship,
  }),
});

after(async () => {
  await executorPool.end();
  try { await actor.query("ROLLBACK"); } catch {}
  await actor.end();
  await admin.query(`TRUNCATE TABLE
    institution_enrolments,institution_evidence_share_receipts,
    institution_evidence_assessments,institution_requirements,
    institution_requirement_sets,institution_application_cases,
    institution_memberships,institution_relationships,
    journey_requirement_results,journey_verified_evidence_receipts,
    journey_consent_receipts,journey_application_cases,journey_dossier_revisions,
    journey_dossiers,journey_requirement_items,journey_requirement_sets,
    journey_subjects,access_decision_receipts,memberships,organizations,
    policy_versions,tenants CASCADE`);
  await admin.query(`DELETE FROM portal_submissions WHERE id=${portalSubmissionId};
    DELETE FROM applications WHERE id=${LEGACY.application};
    DELETE FROM students WHERE id=${LEGACY.student};
    DELETE FROM programs WHERE id=${LEGACY.program};
    DELETE FROM universities WHERE id=${LEGACY.university};
    DELETE FROM principals WHERE id IN ('${ID.principal}','${ID.approverPrincipal}');
    DELETE FROM users WHERE id IN (${LEGACY.user},${LEGACY.approverUser});
    DELETE FROM branches WHERE id=${LEGACY.branch};`);
  await admin.end();
});

async function insertConsent(
  id: string,
  action: "CAPTURED" | "WITHDRAWN",
  sequence: number,
  previousHash: string | null,
  receiptHash: string,
): Promise<void> {
  await admin.query(`INSERT INTO journey_consent_receipts (
    id,tenant_id,subject_id,purpose,lawful_basis,channel,locale,notice_version,
    policy_version,retention_policy_version,action,sequence,effective_at,
    recorded_at,valid_until,previous_receipt_hash,evidence_ref,evidence_sha256,
    receipt_hash
  ) VALUES (
    $1,$2,$3,'institution.admissions.evidence_share','policy_input.consent',
    'in_app','en','notice_v1','consent_policy_v1','retention_v1',$4,$5,
    now()-interval '1 minute',now(),now()+interval '1 day',$6,
    'consent:evidence-share',$7,$8
  )`, [id, ID.tenant, ID.subject, action, sequence, previousHash, HASH.d, receiptHash]);
}

async function beginReviewer(
  programScopeIds: number[] = [],
  intakeScopes: string[] = [],
): Promise<void> {
  await actor.query("BEGIN");
  await actor.query("SELECT set_config('app.legacy_user_id',$1,true)", [String(LEGACY.user)]);
  await actor.query("SELECT set_config('app.tenant_id',$1,true)", [ID.tenant]);
  await actor.query("SELECT set_config('app.institution_relationship_id',$1,true)", [ID.relationship]);
  await actor.query("SELECT set_config('app.institution_role','ADMISSIONS_REVIEWER',true)");
  await actor.query("SELECT set_config('app.institution_membership_id',$1,true)", [ID.institutionMembership]);
  await actor.query("SELECT set_config('app.institution_principal_id',$1,true)", [ID.principal]);
  await actor.query("SELECT set_config('app.institution_program_scope_ids',$1,true)", [
    JSON.stringify(programScopeIds),
  ]);
  await actor.query("SELECT set_config('app.institution_intake_scopes',$1,true)", [
    JSON.stringify(intakeScopes),
  ]);
}

async function beginApprover(): Promise<void> {
  await actor.query("BEGIN");
  await actor.query("SELECT set_config('app.legacy_user_id',$1,true)", [String(LEGACY.approverUser)]);
  await actor.query("SELECT set_config('app.tenant_id',$1,true)", [ID.tenant]);
  await actor.query("SELECT set_config('app.institution_relationship_id',$1,true)", [ID.relationship]);
  await actor.query("SELECT set_config('app.institution_role','DECISION_APPROVER',true)");
  await actor.query("SELECT set_config('app.institution_membership_id',$1,true)", [ID.approverMembership]);
  await actor.query("SELECT set_config('app.institution_principal_id',$1,true)", [ID.approverPrincipal]);
  await actor.query("SELECT set_config('app.institution_program_scope_ids','[]',true)");
  await actor.query("SELECT set_config('app.institution_intake_scopes','[]',true)");
}

test("share executor is EXECUTE-only and function owner is non-privileged", async () => {
  const roles = await admin.query(`SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,
    rolinherit,rolbypassrls,rolcanlogin FROM pg_roles
    WHERE rolname IN ('fas_institution_evidence_owner','fas_institution_evidence_share_executor')
    ORDER BY rolname`);
  assert.deepEqual(roles.rows, [
    { rolname: "fas_institution_evidence_owner", rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolinherit: false, rolbypassrls: false, rolcanlogin: false },
    { rolname: "fas_institution_evidence_share_executor", rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolinherit: false, rolbypassrls: false, rolcanlogin: true },
  ]);
  const boundary = await admin.query(`SELECT
    has_table_privilege('fas_institution_evidence_share_executor','journey_verified_evidence_receipts','SELECT') AS evidence_select,
    has_table_privilege('fas_institution_evidence_share_executor','journey_consent_receipts','SELECT') AS consent_select,
    has_table_privilege('fas_institution_evidence_share_executor','institution_evidence_share_receipts','SELECT') AS share_select,
    has_table_privilege('fas_institution_evidence_share_executor','institution_evidence_share_receipts','INSERT') AS share_insert,
    has_function_privilege('fas_institution_evidence_share_executor',
      'fas_institution_evidence_v1.create_share_receipt(uuid,uuid,uuid,uuid,uuid,uuid)','EXECUTE') AS can_execute`);
  assert.deepEqual(boundary.rows[0], {
    evidence_select: false,
    consent_select: false,
    share_select: false,
    share_insert: false,
    can_execute: true,
  });
  const functions = await admin.query(`SELECT p.proname,p.prosecdef,
    pg_get_userbyid(p.proowner) AS owner_name,p.proconfig
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='fas_institution_evidence_v1' ORDER BY p.proname`);
  assert.equal(functions.rowCount, 3);
  assert.equal(functions.rows.every((row) => row.prosecdef === true &&
    row.owner_name === "fas_institution_evidence_owner" &&
    row.proconfig.includes("row_security=on")), true);
});

test("default-off and missing consent both prevent a share receipt", async () => {
  const disabled = new PostgresInstitutionEvidenceShareStore({
    pool: executorPool,
    config: parseInstitutionEvidenceShareConfig({}),
  });
  const request = {
    tenantId: ID.tenant,
    relationshipId: ID.relationship,
    applicationCaseId: ID.institutionCase,
    journeyEvidenceReceiptId: ID.evidenceReceipt,
    journeyConsentReceiptId: ID.consentCaptured,
  };
  await assert.rejects(disabled.share(request), /institution_evidence_share_disabled/);
  await assert.rejects(enabledStore.share(request), /no data found|query returned no rows/i);
  assert.equal((await admin.query(
    "SELECT count(*)::integer AS count FROM institution_evidence_share_receipts",
  )).rows[0].count, 0);
});

test("active consent creates one PII-minimized receipt under concurrency", async () => {
  await insertConsent(ID.consentCaptured, "CAPTURED", 1, null, HASH.a);
  const request = {
    tenantId: ID.tenant,
    relationshipId: ID.relationship,
    applicationCaseId: ID.institutionCase,
    journeyEvidenceReceiptId: ID.evidenceReceipt,
    journeyConsentReceiptId: ID.consentCaptured,
  };
  const [left, right] = await Promise.all([enabledStore.share(request), enabledStore.share(request)]);
  assert.deepEqual(new Set([left.outcome, right.outcome]), new Set(["CREATED", "REPLAY"]));
  assert.equal(left.shareReceiptId, right.shareReceiptId);
  assert.equal(left.evidenceRefHash, right.evidenceRefHash);
  const persisted = await admin.query(`SELECT * FROM institution_evidence_share_receipts`);
  assert.equal(persisted.rowCount, 1);
  assert.equal(persisted.rows[0].id, left.shareReceiptId);
  assert.equal(persisted.rows[0].consent_purpose, "institution.admissions.evidence_share");
  assert.equal(persisted.rows[0].requirement_code, "enrolment_confirmation");
  assert.equal(persisted.rows[0].content_sha256, HASH.d);
  assert.equal(persisted.rows[0].executor_key, "institution.evidence_share.v1");
  assert.equal(JSON.stringify(persisted.rows).includes(RAW_EVIDENCE_REF), false);
  await assert.rejects(
    admin.query("UPDATE institution_evidence_share_receipts SET executor_key='institution.evidence_share.v1'"),
    /append-only/,
  );
});

test("intake case assessment accepts only the exact active share receipt", async () => {
  const share = (await admin.query<{ id: string; evidence_ref_hash: string }>(
    "SELECT id,evidence_ref_hash FROM institution_evidence_share_receipts",
  )).rows[0];
  await beginReviewer();
  await actor.query(`INSERT INTO institution_evidence_assessments (
    id,tenant_id,relationship_id,application_case_id,requirement_id,
    evidence_share_receipt_id,evidence_ref_hash,result,reason_code,
    reviewer_membership_id,assessment_hash,assessed_at
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,'VERIFIED','ENROLMENT_EVIDENCE_REVIEWED',$8,$9,
    '2000-01-01T00:00:00Z')`,
  [ID.assessment, ID.tenant, ID.relationship, ID.institutionCase,
    ID.institutionRequirement, share.id, share.evidence_ref_hash,
    ID.institutionMembership, HASH.b]);
  const recorded = await actor.query<{ server_timestamp: boolean }>(`
    SELECT assessed_at > now() - interval '1 minute' AS server_timestamp
    FROM institution_evidence_assessments WHERE id=$1
  `, [ID.assessment]);
  assert.equal(recorded.rows[0]?.server_timestamp, true);
  await actor.query("SAVEPOINT tampered_hash");
  await assert.rejects(actor.query(`INSERT INTO institution_evidence_assessments (
    id,tenant_id,relationship_id,application_case_id,evidence_share_receipt_id,
    evidence_ref_hash,result,reason_code,reviewer_membership_id,assessment_hash
  ) VALUES ($1,$2,$3,$4,$5,$6,'REJECTED','TAMPERED',$7,$8)`,
  [ID.tamperedAssessment, ID.tenant, ID.relationship, ID.institutionCase, share.id,
    HASH.e, ID.institutionMembership, HASH.c]), /evidence hash mismatch/i);
  await actor.query("ROLLBACK TO SAVEPOINT tampered_hash");
  await actor.query("SAVEPOINT missing_share");
  await assert.rejects(actor.query(`INSERT INTO institution_evidence_assessments (
    id,tenant_id,relationship_id,application_case_id,evidence_ref_hash,result,
    reason_code,reviewer_membership_id,assessment_hash
  ) VALUES ($1,$2,$3,$4,$5,'REJECTED','MISSING_SHARE',$6,$7)`,
  [ID.tamperedAssessment, ID.tenant, ID.relationship, ID.institutionCase,
    HASH.e, ID.institutionMembership, HASH.c]), /requires evidence share receipt/i);
  await actor.query("ROLLBACK TO SAVEPOINT missing_share");
  await actor.query("ROLLBACK");
});

test("program and intake scope hide the share receipt and prevent assessment", async () => {
  const share = (await admin.query<{ id: string; evidence_ref_hash: string }>(
    "SELECT id,evidence_ref_hash FROM institution_evidence_share_receipts",
  )).rows[0];
  await beginReviewer([LEGACY.program + 1]);
  const visible = await actor.query<{ count: number }>(`
    SELECT count(*)::integer AS count FROM institution_evidence_share_receipts WHERE id=$1
  `, [share.id]);
  assert.equal(visible.rows[0]?.count, 0);
  await actor.query("SAVEPOINT out_of_scope");
  await assert.rejects(actor.query(`INSERT INTO institution_evidence_assessments (
    id,tenant_id,relationship_id,application_case_id,evidence_share_receipt_id,
    evidence_ref_hash,result,reason_code,reviewer_membership_id,assessment_hash
  ) VALUES ($1,$2,$3,$4,$5,$6,'REJECTED','OUT_OF_SCOPE',$7,$8)`,
  [ID.outOfScopeAssessment, ID.tenant, ID.relationship, ID.institutionCase,
    share.id, share.evidence_ref_hash, ID.institutionMembership, HASH.d]),
  /institution evidence case unavailable|no data found|query returned no rows/i);
  await actor.query("ROLLBACK TO SAVEPOINT out_of_scope");
  await actor.query("ROLLBACK");
});

test("a stale or suspended reviewer membership cannot assess shared evidence", async () => {
  const share = (await admin.query<{ id: string; evidence_ref_hash: string }>(
    "SELECT id,evidence_ref_hash FROM institution_evidence_share_receipts",
  )).rows[0];
  await admin.query("UPDATE institution_memberships SET status='SUSPENDED' WHERE id=$1", [
    ID.institutionMembership,
  ]);
  await beginReviewer();
  await assert.rejects(actor.query(`INSERT INTO institution_evidence_assessments (
    id,tenant_id,relationship_id,application_case_id,evidence_share_receipt_id,
    evidence_ref_hash,result,reason_code,reviewer_membership_id,assessment_hash
  ) VALUES ($1,$2,$3,$4,$5,$6,'REJECTED','STALE_MEMBERSHIP',$7,$8)`,
  [ID.inactiveMembershipAssessment, ID.tenant, ID.relationship, ID.institutionCase,
    share.id, share.evidence_ref_hash, ID.institutionMembership, HASH.d]),
  /actor unavailable/i);
  await actor.query("ROLLBACK");
  await admin.query("UPDATE institution_memberships SET status='ACTIVE' WHERE id=$1", [
    ID.institutionMembership,
  ]);
});

test("enrolment confirmation requires the exact published reviewed evidence binding", async () => {
  const share = (await admin.query<{ id: string; evidence_ref_hash: string }>(
    "SELECT id,evidence_ref_hash FROM institution_evidence_share_receipts",
  )).rows[0];
  await beginReviewer();
  await actor.query(`INSERT INTO institution_evidence_assessments (
    id,tenant_id,relationship_id,application_case_id,requirement_id,
    evidence_share_receipt_id,evidence_ref_hash,result,reason_code,
    reviewer_membership_id,assessment_hash
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,'VERIFIED','ENROLMENT_EVIDENCE_REVIEWED',$8,$9)`,
  [ID.assessment, ID.tenant, ID.relationship, ID.institutionCase,
    ID.institutionRequirement, share.id, share.evidence_ref_hash,
    ID.institutionMembership, HASH.b]);
  await actor.query("COMMIT");

  await beginApprover();
  await actor.query(`INSERT INTO institution_enrolments (
    id,tenant_id,relationship_id,application_case_id,state
  ) VALUES ($1,$2,$3,$4,'PENDING_EVIDENCE')`,
  [ID.enrolment, ID.tenant, ID.relationship, ID.institutionCase]);
  await actor.query("SAVEPOINT unbound_enrolment");
  await assert.rejects(actor.query(`UPDATE institution_enrolments SET
    state='CONFIRMED',evidence_ref_hash=$2,verified_by_membership_id=$3,
    receipt_hash=$4,effective_at='2000-01-01T00:00:00Z',version=version+1
    WHERE id=$1`, [ID.enrolment, share.evidence_ref_hash,
    ID.approverMembership, HASH.c]), /confirmation requires evidence share receipt/i);
  await actor.query("ROLLBACK TO SAVEPOINT unbound_enrolment");
  await actor.query(`UPDATE institution_enrolments SET
    state='CONFIRMED',evidence_share_receipt_id=$2,evidence_assessment_id=$3,
    evidence_ref_hash=$4,verified_by_membership_id=$5,receipt_hash=$6,
    effective_at='2000-01-01T00:00:00Z',version=version+1 WHERE id=$1`,
  [ID.enrolment, share.id, ID.assessment, share.evidence_ref_hash,
    ID.approverMembership, HASH.c]);
  const confirmed = await actor.query<{
    state: string;
    evidence_share_receipt_id: string;
    evidence_assessment_id: string;
    server_timestamp: boolean;
  }>(`SELECT state,evidence_share_receipt_id,evidence_assessment_id,
      effective_at > now()-interval '1 minute' AS server_timestamp
    FROM institution_enrolments WHERE id=$1`, [ID.enrolment]);
  assert.deepEqual(confirmed.rows[0], {
    state: "CONFIRMED",
    evidence_share_receipt_id: share.id,
    evidence_assessment_id: ID.assessment,
    server_timestamp: true,
  });
  await actor.query("COMMIT");
});

test("withdrawal invalidates enrolment resolution and receipt replay", async () => {
  await insertConsent(ID.consentWithdrawn, "WITHDRAWN", 2, HASH.a, HASH.b);
  const share = (await admin.query<{ id: string; evidence_ref_hash: string }>(
    "SELECT id,evidence_ref_hash FROM institution_evidence_share_receipts",
  )).rows[0];
  await beginApprover();
  await assert.rejects(actor.query(`SELECT *
    FROM fas_institution_evidence_v1.resolve_enrolment_confirmation(
      $1::uuid,$2::uuid,$3::uuid,$4::uuid,now()
    )`, [ID.tenant,ID.relationship,ID.institutionCase,share.id]),
  /consent is not current and active/i);
  await actor.query("ROLLBACK");
  await assert.rejects(enabledStore.share({
    tenantId: ID.tenant,
    relationshipId: ID.relationship,
    applicationCaseId: ID.institutionCase,
    journeyEvidenceReceiptId: ID.evidenceReceipt,
    journeyConsentReceiptId: ID.consentCaptured,
  }), /consent is not current and active/i);
});
