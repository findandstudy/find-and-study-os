import assert from "node:assert/strict";
import test, { after } from "node:test";
import pg from "pg";

if (process.env.ALLOW_DISPOSABLE_INSTITUTION_ADMISSIONS_TEST !== "true") {
  throw new Error("institution_postgres_test_requires_explicit_disposable_opt_in");
}
const actorUrl = process.env.DATABASE_URL;
const adminUrl = process.env.INSTITUTION_TEST_ADMIN_DATABASE_URL;
if (!actorUrl || !adminUrl) throw new Error("institution_postgres_test_urls_required");

for (const raw of [actorUrl, adminUrl]) {
  const url = new URL(raw);
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname) || !/^(?:fas_(?:dev|it)_[a-z0-9_]+|fasos_apply_local)$/.test(url.pathname.slice(1))) {
    throw new Error("institution_postgres_test_requires_disposable_loopback_database");
  }
}

if (new URL(actorUrl).username !== "fas_institution_executor") {
  throw new Error("institution_postgres_test_requires_exact_executor_role");
}

const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
const migrationCount = await admin.query(
  "SELECT count(*)::integer AS count FROM drizzle.__drizzle_migrations",
);
assert.equal(migrationCount.rows[0]?.count, 100);
await admin.query(`DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fas_institution_executor') THEN
    CREATE ROLE fas_institution_executor LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END $$`);
await admin.query("ALTER ROLE fas_institution_executor NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS");
const databaseName = new URL(actorUrl).pathname.slice(1);
await admin.query(`GRANT CONNECT ON DATABASE ${databaseName} TO fas_institution_executor`);
await admin.query("GRANT USAGE ON SCHEMA public TO fas_institution_executor");
await admin.query(`GRANT SELECT ON TABLE
  tenants, users, principals, role_definitions, role_package_versions,
  role_package_capabilities, capability_definitions, policy_versions, universities, programs,
  institution_relationships TO fas_institution_executor`);
await admin.query(`GRANT SELECT ON TABLE institution_memberships TO fas_institution_executor`);
await admin.query(`GRANT SELECT, INSERT, UPDATE ON TABLE
  institution_sla_policies, institution_application_cases,
  institution_requirement_sets, institution_information_requests,
  institution_decisions, institution_offers, institution_enrolments
  TO fas_institution_executor`);
await admin.query(`GRANT SELECT, INSERT ON TABLE
  institution_requirements, institution_evidence_assessments,
  institution_decision_approvals, institution_admission_events
  TO fas_institution_executor`);
await admin.query(`GRANT SELECT ON TABLE institution_active_context_selections TO fas_institution_executor`);
await admin.query(`GRANT SELECT, UPDATE ON TABLE institution_step_up_receipts TO fas_institution_executor`);
await admin.query(`GRANT SELECT, INSERT ON TABLE
  institution_command_authorization_receipts, institution_membership_change_requests
  TO fas_institution_executor`);
await admin.query(`GRANT EXECUTE ON FUNCTION
  institution_current_program_scope_ids(), institution_current_intake_scopes(),
  institution_case_scope_matches(integer,text,uuid)
  TO fas_institution_executor`);
await admin.query(`GRANT USAGE ON SCHEMA fas_institution_v1 TO fas_institution_executor`);
await admin.query(`GRANT EXECUTE ON FUNCTION fas_institution_v1.lock_current_mutation_authority(
  uuid,uuid,uuid,bigint,uuid,uuid,uuid,integer,text,text,uuid,bigint,timestamptz
) TO fas_institution_executor`);
const actor = new pg.Client({ connectionString: actorUrl });
await actor.connect();

const tenantId = "018f9100-0000-7000-8000-000000000001";
const relationshipId = "018f9100-0000-7000-8000-000000000002";
const reviewerPrincipalId = "018f9100-0000-7000-8000-000000000003";
const approverPrincipalId = "018f9100-0000-7000-8000-000000000004";
const auditorPrincipalId = "018f9100-0000-7000-8000-000000000005";
const otherReviewerPrincipalId = "018f9100-0000-7000-8000-000000000010";
const adminPrincipalId = "018f9100-0000-7000-8000-000000000013";
const targetPrincipalId = "018f9100-0000-7000-8000-000000000014";
const reviewerMembershipId = "018f9100-0000-7000-8000-000000000006";
const approverMembershipId = "018f9100-0000-7000-8000-000000000007";
const auditorMembershipId = "018f9100-0000-7000-8000-000000000008";
const otherReviewerMembershipId = "018f9100-0000-7000-8000-000000000011";
const adminMembershipId = "018f9100-0000-7000-8000-000000000015";
const institutionSelectionId = "018f9100-0000-7000-8000-000000000016";
const institutionStepUpId = "018f9100-0000-7000-8000-000000000017";
const institutionAuthorizationId = "018f9100-0000-7000-8000-000000000018";
const membershipRequestId = "018f9100-0000-7000-8000-000000000019";
const institutionContextId = "018f9100-0000-7000-8000-00000000001a";
const policyId = "018f9100-0000-7000-8000-00000000001c";
const slaPolicyId = "018f9100-0000-7000-8000-00000000001d";
const slaStepUpId = "018f9100-0000-7000-8000-00000000001e";
const slaAuthorizationId = "018f9100-0000-7000-8000-00000000001f";
const caseId = "018f9100-0000-7000-8000-000000000009";
const assessmentId = "018f9100-0000-7000-8000-00000000000a";
const decisionId = "018f9100-0000-7000-8000-00000000000b";
const offerId = "018f9100-0000-7000-8000-00000000000c";
const universityId = 991001;
const programId = 991001;
const studentId = 991001;
const applicationId = 991001;
const otherApplicationId = 991002;
const reviewerUserId = 991001;
const approverUserId = 991002;
const auditorUserId = 991003;
const otherReviewerUserId = 991004;
const adminUserId = 991005;
const targetUserId = 991006;

await admin.query(`
  INSERT INTO tenants (id,slug,legal_name,display_name,status,home_region)
  VALUES ('${tenantId}','institution-test','Institution Test','Institution Test','ACTIVE','eu-test');
  INSERT INTO users (id,email,first_name,last_name,role,is_active,email_verified) VALUES
    (${reviewerUserId},'reviewer@institution.test','Review','Maker','institution_user',true,true),
    (${approverUserId},'approver@institution.test','Decision','Checker','institution_user',true,true),
    (${auditorUserId},'auditor@institution.test','Read','Only','institution_user',true,true),
    (${otherReviewerUserId},'other-reviewer@institution.test','Other','Reviewer','institution_user',true,true),
    (${adminUserId},'admin@institution.test','Institution','Admin','institution_user',true,true),
    (${targetUserId},'target@institution.test','Target','Reviewer','institution_user',true,true);
  INSERT INTO principals (id,principal_type,issuer,subject,legacy_user_id,status,risk_state) VALUES
    ('${reviewerPrincipalId}','HUMAN','test','reviewer',${reviewerUserId},'ACTIVE','NORMAL'),
    ('${approverPrincipalId}','HUMAN','test','approver',${approverUserId},'ACTIVE','NORMAL'),
    ('${auditorPrincipalId}','HUMAN','test','auditor',${auditorUserId},'ACTIVE','NORMAL'),
    ('${otherReviewerPrincipalId}','HUMAN','test','other-reviewer',${otherReviewerUserId},'ACTIVE','NORMAL'),
    ('${adminPrincipalId}','HUMAN','test','institution-admin',${adminUserId},'ACTIVE','NORMAL'),
    ('${targetPrincipalId}','HUMAN','test','target-reviewer',${targetUserId},'ACTIVE','NORMAL');
  INSERT INTO universities (id,name,country,is_active) VALUES (${universityId},'Institution Test University','TR',true);
  INSERT INTO programs (id,university_id,name,is_active,intakes) VALUES (${programId},${universityId},'Institution Test Program',true,'Fall');
  INSERT INTO students (id,first_name,last_name) VALUES (${studentId},'Masked','Applicant');
  INSERT INTO applications (id,student_id,program_id,university_id,intake) VALUES
    (${applicationId},${studentId},${programId},${universityId},'Fall'),
    (${otherApplicationId},${studentId},${programId},${universityId},'Fall');
  INSERT INTO institution_relationships (id,tenant_id,institution_id,purpose_code,data_scopes,status)
  VALUES ('${relationshipId}','${tenantId}',${universityId},'admissions.review',ARRAY[
    'application.profile','application.evidence','application.communication','application.decision',
    'application.offer','application.enrolment','catalog.programs','catalog.requirements',
    'partner.operations','relationship.membership','integration.metadata','analytics.aggregate','audit.masked'
  ],'ACTIVE');
  INSERT INTO policy_versions (id,tenant_id,version_number,checksum,state,effective_at)
  VALUES ('${policyId}','${tenantId}',1,repeat('9',64),'ACTIVE',now());
  INSERT INTO institution_memberships (id,tenant_id,relationship_id,principal_id,role_package_version_id,legacy_user_id,role_key,status) VALUES
    ('${reviewerMembershipId}','${tenantId}','${relationshipId}','${reviewerPrincipalId}','018f9000-0000-7000-8000-000000000013',${reviewerUserId},'ADMISSIONS_REVIEWER','ACTIVE'),
    ('${approverMembershipId}','${tenantId}','${relationshipId}','${approverPrincipalId}','018f9000-0000-7000-8000-000000000014',${approverUserId},'DECISION_APPROVER','ACTIVE'),
    ('${auditorMembershipId}','${tenantId}','${relationshipId}','${auditorPrincipalId}','018f9000-0000-7000-8000-000000000016',${auditorUserId},'INSTITUTION_AUDITOR','ACTIVE'),
    ('${otherReviewerMembershipId}','${tenantId}','${relationshipId}','${otherReviewerPrincipalId}','018f9000-0000-7000-8000-000000000013',${otherReviewerUserId},'ADMISSIONS_REVIEWER','ACTIVE'),
    ('${adminMembershipId}','${tenantId}','${relationshipId}','${adminPrincipalId}','018f9000-0000-7000-8000-000000000011',${adminUserId},'INSTITUTION_ADMIN','ACTIVE');
  INSERT INTO institution_application_cases (
    id,tenant_id,relationship_id,legacy_application_id,institution_id,program_id,intake_key,
    masked_student_ref,shared_profile,lifecycle_state,readiness_percent
  ) VALUES ('${caseId}','${tenantId}','${relationshipId}',${applicationId},${universityId},${programId},'Fall',
    'APP-TEST-001','{"givenName":"Masked"}'::jsonb,'DECISION_PENDING_APPROVAL',100);
  INSERT INTO institution_application_cases (
    id,tenant_id,relationship_id,legacy_application_id,institution_id,program_id,intake_key,
    masked_student_ref,shared_profile,lifecycle_state,readiness_percent,assigned_reviewer_membership_id
  ) VALUES ('018f9100-0000-7000-8000-000000000012','${tenantId}','${relationshipId}',${otherApplicationId},${universityId},${programId},'Fall',
    'APP-TEST-002','{"givenName":"Other"}'::jsonb,'REVIEWING',25,'${otherReviewerMembershipId}');
  INSERT INTO institution_decisions (
    id,tenant_id,relationship_id,application_case_id,version_number,decision_type,state,
    reason_code,rationale,maker_membership_id,content_hash,submitted_at
  ) VALUES ('${decisionId}','${tenantId}','${relationshipId}','${caseId}',1,'CONDITIONAL_OFFER','SUBMITTED',
    'ACADEMIC_REVIEW','Fixture decision','${reviewerMembershipId}',repeat('b',64),now());
  INSERT INTO institution_offers (id,tenant_id,relationship_id,application_case_id,decision_id)
  VALUES ('${offerId}','${tenantId}','${relationshipId}','${caseId}','${decisionId}');
`);

process.env.NODE_ENV = "test";
process.env.INSTITUTION_DATABASE_URL = actorUrl;

async function beginAs(
  userId: number,
  role: string,
  membershipId: string,
  programScopeIds: number[] = [],
  intakeScopes: string[] = [],
) {
  await actor.query("BEGIN");
  await actor.query("SELECT set_config('app.legacy_user_id',$1,true)",[String(userId)]);
  await actor.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
  await actor.query("SELECT set_config('app.institution_relationship_id',$1,true)",[relationshipId]);
  await actor.query("SELECT set_config('app.institution_role',$1,true)",[role]);
  await actor.query("SELECT set_config('app.institution_membership_id',$1,true)",[membershipId]);
  const principalId = membershipId === reviewerMembershipId ? reviewerPrincipalId
    : membershipId === approverMembershipId ? approverPrincipalId
    : membershipId === auditorMembershipId ? auditorPrincipalId
    : membershipId === adminMembershipId ? adminPrincipalId : otherReviewerPrincipalId;
  await actor.query("SELECT set_config('app.institution_principal_id',$1,true)",[principalId]);
  await actor.query("SELECT set_config('app.institution_program_scope_ids',$1,true)",[JSON.stringify(programScopeIds)]);
  await actor.query("SELECT set_config('app.institution_intake_scopes',$1,true)",[JSON.stringify(intakeScopes)]);
}
async function rollback() { try { await actor.query("ROLLBACK"); } catch {} }

after(async () => {
  await rollback();
  // The test target is required to be a disposable loopback database above.
  // TRUNCATE is used because append-only row triggers intentionally reject DELETE.
  await admin.query(`TRUNCATE TABLE
    institution_membership_change_requests,institution_command_authorization_receipts,
    institution_step_up_receipts,institution_active_context_selections,
    institution_admission_events,institution_decision_approvals,institution_offers,
    institution_enrolments,institution_evidence_assessments,institution_information_requests,
    institution_decisions,institution_requirements,institution_requirement_sets,
    institution_application_cases,institution_sla_policies,institution_memberships,
    institution_relationships CASCADE;
    DELETE FROM applications WHERE id IN (${applicationId},${otherApplicationId}); DELETE FROM students WHERE id=${studentId};
    DELETE FROM programs WHERE id=${programId}; DELETE FROM universities WHERE id=${universityId};
    DELETE FROM principals WHERE id IN ('${reviewerPrincipalId}','${approverPrincipalId}','${auditorPrincipalId}','${otherReviewerPrincipalId}','${adminPrincipalId}','${targetPrincipalId}');
    DELETE FROM policy_versions WHERE id='${policyId}';
    DELETE FROM users WHERE id IN (${reviewerUserId},${approverUserId},${auditorUserId},${otherReviewerUserId},${adminUserId},${targetUserId});
    DELETE FROM tenants WHERE id='${tenantId}';`);
  await actor.end(); await admin.end();
});

test("all institution tables have FORCE RLS and no DELETE policy", async () => {
  const result=await admin.query(`SELECT c.relname,c.relforcerowsecurity,
    count(p.policyname) FILTER(WHERE p.cmd='DELETE')::integer AS delete_policies
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_policies p ON p.schemaname=n.nspname AND p.tablename=c.relname
    WHERE n.nspname='public' AND c.relname LIKE 'institution_%' AND c.relkind='r'
    GROUP BY c.relname,c.relforcerowsecurity`);
  assert.equal(result.rowCount,19);
  assert.equal(result.rows.every(row=>row.relforcerowsecurity===true&&row.delete_policies===0),true);
});

test("runtime uses the exact least-privilege executor without owner or bypass authority", async () => {
  const identity = await actor.query(`SELECT current_user,r.rolsuper,r.rolcreatedb,r.rolcreaterole,
    r.rolinherit,r.rolbypassrls,
    pg_has_role(current_user,c.relowner,'MEMBER') AS owns_institution_table,
    has_table_privilege(current_user,'institution_application_cases','DELETE') AS can_delete,
    has_table_privilege(current_user,'institution_active_context_selections','UPDATE') AS can_update_selection,
    has_table_privilege(current_user,'institution_relationships','UPDATE') AS can_update_relationship,
    has_table_privilege(current_user,'institution_memberships','UPDATE') AS can_update_membership
    FROM pg_roles r CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE r.rolname=current_user AND n.nspname='public' AND c.relname='institution_application_cases'`);
  assert.deepEqual(identity.rows[0], {
    current_user:"fas_institution_executor", rolsuper:false, rolcreatedb:false,
    rolcreaterole:false, rolinherit:false, rolbypassrls:false,
    owns_institution_table:false, can_delete:false,can_update_selection:false,
    can_update_relationship:false,can_update_membership:false,
  });
});

test("server resolves one authoritative membership and versioned capability package", async () => {
  await actor.query("BEGIN");
  await actor.query("SELECT set_config('app.legacy_user_id',$1,true)",[String(reviewerUserId)]);
  const directlyVisible = await actor.query(`SELECT m.id,rd.key,rpv.status,rpv.effective_at
    FROM institution_memberships m
    JOIN principals p ON p.id=m.principal_id AND p.legacy_user_id=m.legacy_user_id
    JOIN role_package_versions rpv ON rpv.id=m.role_package_version_id
    JOIN role_definitions rd ON rd.id=rpv.role_definition_id
    WHERE m.legacy_user_id=$1 AND p.principal_type='HUMAN' AND p.status='ACTIVE'
      AND p.risk_state='NORMAL' AND m.status='ACTIVE' AND m.valid_from<=now()
      AND (m.valid_until IS NULL OR m.valid_until>now()) AND rpv.status='ACTIVE'
      AND rpv.effective_at<=now() AND (rpv.deprecated_at IS NULL OR rpv.deprecated_at>now())
      AND rd.status='ACTIVE' AND rd.key='institution.admissions_reviewer'`,[reviewerUserId]);
  assert.equal(directlyVisible.rowCount,1);
  await rollback();
  const { withInstitutionContext, toPublicInstitutionContext } = await import("../src/lib/institutionAdmissionsStore");
  const resolved = await withInstitutionContext(reviewerUserId, async (client, context) => ({
    context: toPublicInstitutionContext(context),
    visibleCases: Number((await client.query("SELECT count(*)::integer AS count FROM institution_application_cases")).rows[0].count),
  }));
  assert.equal(resolved.context.role,"ADMISSIONS_REVIEWER");
  assert.equal(resolved.context.capabilities.includes("institution.evidence.assess"),true);
  assert.equal(resolved.context.capabilities.includes("institution.decisions.approve"),false);
  assert.equal(resolved.visibleCases,1);
});

test("production store accepts only the exact non-bypass executor identity", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousExpectedRole = process.env.INSTITUTION_DB_EXECUTOR_ROLE;
  const { withInstitutionContext } = await import("../src/lib/institutionAdmissionsStore");
  try {
    process.env.NODE_ENV = "production";
    process.env.INSTITUTION_DB_EXECUTOR_ROLE = "fas_institution_executor";
    const currentUser = await withInstitutionContext(reviewerUserId, async (client) =>
      (await client.query<{ current_user:string }>("SELECT current_user")).rows[0].current_user);
    assert.equal(currentUser,"fas_institution_executor");
    process.env.INSTITUTION_DB_EXECUTOR_ROLE = "fas_app";
    await assert.rejects(withInstitutionContext(reviewerUserId, async () => true),/executor_identity_invalid/);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
    if (previousExpectedRole === undefined) delete process.env.INSTITUTION_DB_EXECUTOR_ROLE;
    else process.env.INSTITUTION_DB_EXECUTOR_ROLE = previousExpectedRole;
  }
});

test("reviewer sees scoped case and can append evidence but cannot write approval", async () => {
  await beginAs(reviewerUserId,"ADMISSIONS_REVIEWER",reviewerMembershipId);
  const visible=await actor.query("SELECT id FROM institution_application_cases");
  assert.deepEqual(visible.rows.map(row=>row.id),[caseId]);
  await actor.query(`INSERT INTO institution_evidence_assessments (
    id,tenant_id,relationship_id,application_case_id,evidence_ref_hash,result,reason_code,
    reviewer_membership_id,assessment_hash
  ) VALUES ($1,$2,$3,$4,repeat('a',64),'VERIFIED','ACADEMIC_RECORD',$5,repeat('c',64))`,
  [assessmentId,tenantId,relationshipId,caseId,reviewerMembershipId]);
  await assert.rejects(actor.query(`INSERT INTO institution_decision_approvals (
    id,tenant_id,relationship_id,decision_id,checker_membership_id,outcome,reason_code,receipt_hash
  ) VALUES ('018f9100-0000-7000-8000-00000000000d',$1,$2,$3,$4,'APPROVED','INVALID',repeat('d',64))`,
  [tenantId,relationshipId,decisionId,reviewerMembershipId]),/row-level security|maker-checker mismatch/i);
  await rollback();
});

test("reviewer cannot see another reviewer assignment or escape program and intake scope", async () => {
  await beginAs(reviewerUserId,"ADMISSIONS_REVIEWER",reviewerMembershipId);
  assert.deepEqual((await actor.query("SELECT masked_student_ref FROM institution_application_cases ORDER BY masked_student_ref")).rows,
    [{masked_student_ref:"APP-TEST-001"}]);
  await rollback();

  await beginAs(reviewerUserId,"ADMISSIONS_REVIEWER",reviewerMembershipId,[programId],["Spring"]);
  assert.equal((await actor.query("SELECT count(*)::integer AS count FROM institution_application_cases")).rows[0].count,0);
  await rollback();
});

test("row policy binds inserted actor references to the current membership", async () => {
  await beginAs(reviewerUserId,"ADMISSIONS_REVIEWER",reviewerMembershipId);
  await assert.rejects(actor.query(`INSERT INTO institution_evidence_assessments (
    id,tenant_id,relationship_id,application_case_id,evidence_ref_hash,result,reason_code,
    reviewer_membership_id,assessment_hash
  ) VALUES ('018f9100-0000-7000-8000-000000000013',$1,$2,$3,repeat('9',64),'VERIFIED','SPOOFED',$4,repeat('8',64))`,
  [tenantId,relationshipId,caseId,otherReviewerMembershipId]),/row-level security/i);
  await rollback();
});

test("auditor is read-only and reviewer cannot self-approve", async () => {
  await beginAs(auditorUserId,"INSTITUTION_AUDITOR",auditorMembershipId);
  assert.equal((await actor.query("SELECT count(*)::integer AS count FROM institution_application_cases")).rows[0].count,2);
  await assert.rejects(actor.query(`INSERT INTO institution_evidence_assessments (
    id,tenant_id,relationship_id,application_case_id,evidence_ref_hash,result,reason_code,
    reviewer_membership_id,assessment_hash
  ) VALUES ('018f9100-0000-7000-8000-00000000000e',$1,$2,$3,repeat('a',64),'VERIFIED','INVALID',$4,repeat('e',64))`,
  [tenantId,relationshipId,caseId,auditorMembershipId]),/row-level security/i);
  await rollback();

  await beginAs(reviewerUserId,"ADMISSIONS_REVIEWER",reviewerMembershipId);
  await assert.rejects(actor.query(`UPDATE institution_decisions SET state='APPROVED',checker_membership_id=$2,
    decided_at=now(),effective_at=now() WHERE id=$1`,[decisionId,reviewerMembershipId]),/invalid institution decision transition|checker/i);
  await rollback();
});

test("decision, offer, and enrolment transitions require matching receipts and current checker", async () => {
  await beginAs(approverUserId,"DECISION_APPROVER",approverMembershipId);
  await actor.query("SAVEPOINT before_case_decision");
  await assert.rejects(actor.query(`UPDATE institution_application_cases SET lifecycle_state='DECIDED',
    aggregate_version=aggregate_version+1 WHERE id=$1`,[caseId]),/requires approved decision evidence/i);
  await actor.query("ROLLBACK TO SAVEPOINT before_case_decision");

  await actor.query("SAVEPOINT before_decision_receipt");
  await assert.rejects(actor.query(`UPDATE institution_decisions SET state='APPROVED',checker_membership_id=$2,
    decided_at=now(),effective_at=now() WHERE id=$1`,[decisionId,approverMembershipId]),/requires matching approval receipt/i);
  await actor.query("ROLLBACK TO SAVEPOINT before_decision_receipt");

  await actor.query(`INSERT INTO institution_decision_approvals (
    id,tenant_id,relationship_id,decision_id,checker_membership_id,outcome,reason_code,receipt_hash
  ) VALUES ('018f9100-0000-7000-8000-00000000000f',$1,$2,$3,$4,'APPROVED','CHECKED',repeat('f',64))`,
  [tenantId,relationshipId,decisionId,approverMembershipId]);
  const approved=await actor.query(`UPDATE institution_decisions SET state='APPROVED',checker_membership_id=$2,
    decided_at=now(),effective_at=now() WHERE id=$1 RETURNING state`,[decisionId,approverMembershipId]);
  assert.equal(approved.rows[0].state,"APPROVED");
  await actor.query(`UPDATE institution_application_cases SET lifecycle_state='DECIDED',
    aggregate_version=aggregate_version+1 WHERE id=$1`,[caseId]);

  await actor.query("SAVEPOINT before_offer_jump");
  await assert.rejects(actor.query("UPDATE institution_offers SET state='ACCEPTED' WHERE id=$1",[offerId]),/invalid institution offer transition/i);
  await actor.query("ROLLBACK TO SAVEPOINT before_offer_jump");
  await actor.query(`UPDATE institution_offers SET state='ISSUED',issued_at=now(),
    issued_by_membership_id=$2,receipt_hash=repeat('6',64) WHERE id=$1`,[offerId,approverMembershipId]);
  await actor.query(`UPDATE institution_application_cases SET lifecycle_state='OFFER_ISSUED',
    aggregate_version=aggregate_version+1 WHERE id=$1`,[caseId]);

  const enrolmentId="018f9100-0000-7000-8000-000000000015";
  await actor.query("SAVEPOINT before_enrolment_insert");
  await assert.rejects(actor.query(`INSERT INTO institution_enrolments (
    id,tenant_id,relationship_id,application_case_id,state,evidence_ref_hash,
    verified_by_membership_id,receipt_hash,effective_at
  ) VALUES ($1,$2,$3,$4,'CONFIRMED',repeat('1',64),$5,repeat('2',64),now())`,
  [enrolmentId,tenantId,relationshipId,caseId,approverMembershipId]),/row-level security|requires evidence share receipt/i);
  await actor.query("ROLLBACK TO SAVEPOINT before_enrolment_insert");
  await actor.query(`INSERT INTO institution_enrolments (
    id,tenant_id,relationship_id,application_case_id,state
  ) VALUES ($1,$2,$3,$4,'PENDING_EVIDENCE')`,[enrolmentId,tenantId,relationshipId,caseId]);
  await actor.query("SAVEPOINT before_unbound_confirmation");
  await assert.rejects(actor.query(`UPDATE institution_enrolments SET state='CONFIRMED',
    evidence_ref_hash=repeat('1',64),verified_by_membership_id=$2,
    receipt_hash=repeat('2',64),effective_at=now(),version=version+1 WHERE id=$1`,
  [enrolmentId,approverMembershipId]),/requires evidence share receipt/i);
  await actor.query("ROLLBACK TO SAVEPOINT before_unbound_confirmation");
  const deferred=await actor.query(`UPDATE institution_enrolments SET state='DEFERRED',
    version=version+1 WHERE id=$1 RETURNING state`,[enrolmentId]);
  assert.equal(deferred.rows[0].state,"DEFERRED");
  await rollback();
});

test("institution executor cannot grant membership and consumes exact step-up only once", async () => {
  await beginAs(adminUserId,"INSTITUTION_ADMIN",adminMembershipId);
  await assert.rejects(actor.query(`INSERT INTO institution_memberships (
    id,tenant_id,relationship_id,principal_id,role_package_version_id,legacy_user_id,role_key,status
  ) VALUES ('018f9100-0000-7000-8000-00000000001b',$1,$2,$3,
    '018f9000-0000-7000-8000-000000000013',$4,'ADMISSIONS_REVIEWER','ACTIVE')`,
  [tenantId,relationshipId,targetPrincipalId,targetUserId]), /permission denied/i);
  await rollback();

  const requestHash="c".repeat(64);
  await admin.query(`INSERT INTO institution_active_context_selections (
    id,tenant_id,relationship_id,membership_id,principal_id,legacy_user_id,
    session_fingerprint,session_generation,status,expires_at
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,1,'ACTIVE',now()+interval '5 minutes')`,
  [institutionSelectionId,tenantId,relationshipId,adminMembershipId,adminPrincipalId,
    adminUserId,"a".repeat(64)]);
  await admin.query(`INSERT INTO institution_step_up_receipts (
    id,tenant_id,relationship_id,principal_id,membership_id,selection_id,
    session_generation,context_id,capability_key,resource_type,resource_id,request_hash,
    issuer_reference_hash,receipt_hash,status,issued_at,expires_at
  ) VALUES ($1,$2,$3,$4,$5,$6,1,$7,'institution.team.request',
    'institution_membership_request',$8,$9,$10,$11,'ACTIVE',now(),now()+interval '5 minutes')`,
  [institutionStepUpId,tenantId,relationshipId,adminPrincipalId,adminMembershipId,
    institutionSelectionId,institutionContextId,membershipRequestId,requestHash,"d".repeat(64),"e".repeat(64)]);

  const { resolveInstitutionCurrentAuthority, withInstitutionContext } = await import("../src/lib/institutionAdmissionsStore");
  const now = Date.now();
  const currentAuthority = await withInstitutionContext(adminUserId, async (client, context) =>
    resolveInstitutionCurrentAuthority(client, context, {
      context: {
        tokenVersion:2,contextId:institutionContextId,tenantId,organizationId:null,
        legacyBranchId:null,principalId:adminPrincipalId,membershipId:adminMembershipId,
        assignmentIds:[adminMembershipId],policyVersionId:policyId,policyVersion:1,
        issuedAt:now-1_000,expiresAt:now+240_000,selectionId:institutionSelectionId,
        sessionGeneration:1,
      } as never,
      identity:{authenticatedUserId:adminUserId,authenticatedPrincipalId:adminPrincipalId,
        tenantId,relationshipId,membershipId:adminMembershipId,sessionFingerprint:"a".repeat(64),
        impersonatorPrincipalId:null},
      resource:{tenantId,relationshipId,resourceType:"institution_membership_request",
        resourceId:membershipRequestId,requestHash},
      capabilityKey:"institution.team.request",stepUpReceiptId:institutionStepUpId,
    }));
  assert.equal(currentAuthority.selection.id,institutionSelectionId);
  assert.equal(currentAuthority.relationship.purposeCode,"admissions.review");
  assert.equal(currentAuthority.stepUpReceipt?.id,institutionStepUpId);
  assert.equal(currentAuthority.state.assignments[0].capabilities.some(
    capability=>capability.key==="institution.team.request"&&capability.effect==="ALLOW"),true);

  await beginAs(adminUserId,"INSTITUTION_ADMIN",adminMembershipId);
  const lockedAuthority=await actor.query<{allowed:boolean}>(`SELECT fas_institution_v1.lock_current_mutation_authority(
    $1,$2,$3,1,$4,$5,$6,$7,'institution.team.request','relationship.membership',$8,1,now()
  ) AS allowed`,[tenantId,relationshipId,institutionSelectionId,institutionContextId,
    adminPrincipalId,adminMembershipId,adminUserId,policyId]);
  assert.equal(lockedAuthority.rows[0]?.allowed,true);
  const consumed=await actor.query(`UPDATE institution_step_up_receipts
    SET status='CONSUMED',consumed_at=now()
    WHERE id=$1 AND status='ACTIVE' RETURNING id`,[institutionStepUpId]);
  assert.equal(consumed.rowCount,1);
  const replay=await actor.query(`UPDATE institution_step_up_receipts
    SET status='CONSUMED',consumed_at=now()
    WHERE id=$1 AND status='ACTIVE' RETURNING id`,[institutionStepUpId]);
  assert.equal(replay.rowCount,0);
  await actor.query(`INSERT INTO institution_command_authorization_receipts (
    id,tenant_id,relationship_id,context_id,selection_id,session_generation,
    actor_principal_id,actor_membership_id,capability_key,resource_type,resource_id,
    required_data_scope,policy_version_id,policy_version,request_hash,
    step_up_receipt_id,decision,decision_reason,authorization_hash
  ) VALUES ($1,$2,$3,$4,$5,1,$6,$7,'institution.team.request',
    'institution_membership_request',$8,'relationship.membership',$9,1,$10,$11,'ALLOW','allowed',$12)`,
  [institutionAuthorizationId,tenantId,relationshipId,institutionContextId,institutionSelectionId,
    adminPrincipalId,adminMembershipId,membershipRequestId,policyId,requestHash,institutionStepUpId,"f".repeat(64)]);
  await actor.query(`INSERT INTO institution_membership_change_requests (
    id,tenant_id,relationship_id,target_principal_id,target_legacy_user_id,
    requested_role_package_version_id,requested_role_key,maker_membership_id,state,
    request_hash,authorization_receipt_id
  ) VALUES ($1,$2,$3,$4,$5,'018f9000-0000-7000-8000-000000000013',
    'ADMISSIONS_REVIEWER',$6,'PENDING_CONTROL_PLANE',$7,$8)`,
  [membershipRequestId,tenantId,relationshipId,targetPrincipalId,targetUserId,
    adminMembershipId,requestHash,institutionAuthorizationId]);
  const request=await actor.query(`SELECT state FROM institution_membership_change_requests WHERE id=$1`,[membershipRequestId]);
  const targetMembership=await actor.query(`SELECT id FROM institution_memberships WHERE legacy_user_id=$1`,[targetUserId]);
  assert.equal(request.rows[0]?.state,"PENDING_CONTROL_PLANE");
  assert.equal(targetMembership.rowCount,0);
  await rollback();
});

test("SLA changes remain drafts until a separate Control Plane apply", async () => {
  await beginAs(adminUserId,"INSTITUTION_ADMIN",adminMembershipId);
  await assert.rejects(actor.query(`INSERT INTO institution_sla_policies (
    id,tenant_id,relationship_id,name,timezone,review_target_hours,
    decision_target_hours,information_response_hours,status,version,created_by_membership_id
  ) VALUES ($1,$2,$3,'Unsafe active SLA','Europe/Istanbul',24,48,24,'ACTIVE',1,$4)`,
  [slaPolicyId,tenantId,relationshipId,adminMembershipId]),/row-level security/i);
  await rollback();

  const requestHash="1".repeat(64);
  await admin.query(`INSERT INTO institution_step_up_receipts (
    id,tenant_id,relationship_id,principal_id,membership_id,selection_id,
    session_generation,context_id,capability_key,resource_type,resource_id,request_hash,
    issuer_reference_hash,receipt_hash,status,issued_at,expires_at
  ) VALUES ($1,$2,$3,$4,$5,$6,1,$7,'institution.sla.request',
    'institution_sla_policy',$8,$9,$10,$11,'ACTIVE',now(),now()+interval '5 minutes')`,
  [slaStepUpId,tenantId,relationshipId,adminPrincipalId,adminMembershipId,
    institutionSelectionId,institutionContextId,slaPolicyId,requestHash,"2".repeat(64),"3".repeat(64)]);

  await beginAs(adminUserId,"INSTITUTION_ADMIN",adminMembershipId);
  assert.equal((await actor.query(`UPDATE institution_step_up_receipts
    SET status='CONSUMED',consumed_at=now() WHERE id=$1 AND status='ACTIVE' RETURNING id`,
  [slaStepUpId])).rowCount,1);
  await actor.query(`INSERT INTO institution_command_authorization_receipts (
    id,tenant_id,relationship_id,context_id,selection_id,session_generation,
    actor_principal_id,actor_membership_id,capability_key,resource_type,resource_id,
    required_data_scope,policy_version_id,policy_version,request_hash,
    step_up_receipt_id,decision,decision_reason,authorization_hash
  ) VALUES ($1,$2,$3,$4,$5,1,$6,$7,'institution.sla.request',
    'institution_sla_policy',$8,'partner.operations',$9,1,$10,$11,'ALLOW','allowed',$12)`,
  [slaAuthorizationId,tenantId,relationshipId,institutionContextId,institutionSelectionId,
    adminPrincipalId,adminMembershipId,slaPolicyId,policyId,requestHash,slaStepUpId,"4".repeat(64)]);
  const draft=await actor.query(`INSERT INTO institution_sla_policies (
    id,tenant_id,relationship_id,name,timezone,review_target_hours,
    decision_target_hours,information_response_hours,status,version,created_by_membership_id,
    request_hash,authorization_receipt_id
  ) VALUES ($1,$2,$3,'Safe draft SLA','Europe/Istanbul',24,48,24,'DRAFT',1,$4,$5,$6)
  RETURNING status`,[slaPolicyId,tenantId,relationshipId,adminMembershipId,requestHash,slaAuthorizationId]);
  assert.equal(draft.rows[0]?.status,"DRAFT");
  await actor.query("SAVEPOINT before_sla_activation");
  const activation=await actor.query(`UPDATE institution_sla_policies SET status='ACTIVE' WHERE id=$1`,
    [slaPolicyId]);
  assert.equal(activation.rowCount,0);
  await actor.query("ROLLBACK TO SAVEPOINT before_sla_activation");
  await rollback();
});

test("append-only evidence cannot be rewritten", async () => {
  await admin.query(`INSERT INTO institution_evidence_assessments (
    id,tenant_id,relationship_id,application_case_id,evidence_ref_hash,result,reason_code,
    reviewer_membership_id,assessment_hash
  ) VALUES ($1,$2,$3,$4,repeat('a',64),'VERIFIED','ACADEMIC_RECORD',$5,repeat('c',64))`,
  [assessmentId,tenantId,relationshipId,caseId,reviewerMembershipId]);
  await assert.rejects(admin.query("UPDATE institution_evidence_assessments SET notes='tamper' WHERE id=$1",[assessmentId]),/append-only/i);
  await assert.rejects(admin.query(`INSERT INTO institution_evidence_assessments (
    id,tenant_id,relationship_id,application_case_id,evidence_ref_hash,result,reason_code,
    reviewer_membership_id,assessment_hash
  ) VALUES ('018f9100-0000-7000-8000-000000000014',$1,$2,$3,repeat('a',64),'REJECTED','RECHECK',$4,repeat('7',64))`,
  [tenantId,relationshipId,caseId,reviewerMembershipId]),/must supersede current assessment/i);
});
