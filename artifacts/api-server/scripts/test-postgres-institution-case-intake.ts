import assert from "node:assert/strict";
import { after, test } from "node:test";
import pg from "pg";
import { parseInstitutionCaseIntakeConfig } from "../src/lib/institutionCaseIntake";
import { PostgresInstitutionCaseIntakeStore } from "../src/lib/postgresInstitutionCaseIntakeStore";

if (process.env.ALLOW_DISPOSABLE_INSTITUTION_CASE_INTAKE_TEST !== "true") {
  throw new Error("institution_case_intake_test_requires_explicit_disposable_opt_in");
}
const adminUrl = process.env.INSTITUTION_INTAKE_TEST_ADMIN_DATABASE_URL;
const executorUrl = process.env.INSTITUTION_INTAKE_TEST_EXECUTOR_DATABASE_URL;
if (!adminUrl || !executorUrl) throw new Error("institution_case_intake_test_urls_required");
for (const raw of [adminUrl, executorUrl]) {
  const url = new URL(raw);
  if (
    !["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname) ||
    !/^(?:fas_(?:dev|it)_[a-z0-9_]+|fasos_apply_local)$/.test(url.pathname.slice(1))
  ) {
    throw new Error("institution_case_intake_test_requires_disposable_loopback_database");
  }
}
if (new URL(executorUrl).username !== "fas_institution_intake_executor") {
  throw new Error("institution_case_intake_test_requires_exact_executor_role");
}

const ID = {
  tenant: "018f9300-0000-7000-8000-000000000001",
  organization: "018f9300-0000-7000-8000-000000000002",
  relationship: "018f9300-0000-7000-8000-000000000003",
};
const LEGACY = {
  branch: 993001,
  university: 993001,
  program: 993001,
  student: 993001,
  application: 993001,
  dryApplication: 993002,
  concurrentApplication: 993003,
};

const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
const databaseName = new URL(adminUrl).pathname.slice(1);
const migrationCount = await admin.query(
  "SELECT count(*)::integer AS count FROM drizzle.__drizzle_migrations",
);
assert.equal(migrationCount.rows[0]?.count, 100);

await admin.query(`DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fas_institution_intake_owner') THEN
    CREATE ROLE fas_institution_intake_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fas_institution_intake_executor') THEN
    CREATE ROLE fas_institution_intake_executor LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END $$`);
await admin.query("ALTER ROLE fas_institution_intake_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS");
await admin.query("ALTER ROLE fas_institution_intake_executor LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS");
await admin.query(`GRANT CONNECT ON DATABASE ${databaseName} TO fas_institution_intake_executor`);
await admin.query("GRANT USAGE ON SCHEMA fas_institution_intake_v1 TO fas_institution_intake_executor");
await admin.query(`GRANT SELECT ON TABLE
  tenants, organizations, tenant_organization_legacy_branches,
  institution_relationships, institution_sla_policies,
  institution_case_intake_receipts, portal_submissions, applications,
  programs, portal_universities
  TO fas_institution_intake_owner`);
await admin.query(`GRANT INSERT ON TABLE
  institution_application_cases, institution_case_intake_receipts
  TO fas_institution_intake_owner`);
await admin.query(`ALTER FUNCTION fas_institution_intake_v1.create_case_from_portal_submission(
  uuid,uuid,integer,uuid,uuid
) OWNER TO fas_institution_intake_owner`);
await admin.query(`GRANT EXECUTE ON FUNCTION fas_institution_intake_v1.create_case_from_portal_submission(
  uuid,uuid,integer,uuid,uuid
) TO fas_institution_intake_executor`);

await admin.query(`
  INSERT INTO tenants (id,slug,legal_name,display_name,status,home_region)
  VALUES ('${ID.tenant}','institution-intake-test','Institution Intake Test','Institution Intake Test','ACTIVE','eu-test');
  INSERT INTO organizations (id,tenant_id,legal_name,display_name,organization_type,status)
  VALUES ('${ID.organization}','${ID.tenant}','Test Organization','Test Organization','OPERATING_ENTITY','ACTIVE');
  INSERT INTO branches (id,name) VALUES (${LEGACY.branch},'Institution Intake Test Branch');
  INSERT INTO tenant_organization_legacy_branches (tenant_id,organization_id,legacy_branch_id)
  VALUES ('${ID.tenant}','${ID.organization}',${LEGACY.branch});
  INSERT INTO universities (id,name,country,is_active)
  VALUES (${LEGACY.university},'Institution Intake University','TR',true);
  INSERT INTO programs (id,university_id,name,is_active,intakes)
  VALUES (${LEGACY.program},${LEGACY.university},'Institution Intake Program',true,'Fall');
  INSERT INTO students (id,first_name,last_name)
  VALUES (${LEGACY.student},'Must Not','Be Projected');
  INSERT INTO applications (id,student_id,program_id,university_id,intake,branch_id)
  VALUES
    (${LEGACY.application},${LEGACY.student},${LEGACY.program},${LEGACY.university},'Fall',${LEGACY.branch}),
    (${LEGACY.dryApplication},${LEGACY.student},${LEGACY.program},${LEGACY.university},'Fall',${LEGACY.branch}),
    (${LEGACY.concurrentApplication},${LEGACY.student},${LEGACY.program},${LEGACY.university},'Fall',${LEGACY.branch});
  INSERT INTO portal_universities
    (university_key,university_name,adapter_key,is_active,crm_university_id)
  VALUES ('institution-intake-test','Institution Intake University','test-adapter',true,${LEGACY.university});
  INSERT INTO institution_relationships
    (id,tenant_id,institution_id,purpose_code,data_scopes,status)
  VALUES ('${ID.relationship}','${ID.tenant}',${LEGACY.university},'admissions.review',ARRAY['application.profile'],'ACTIVE');
`);

const inserted = await admin.query<{ id: number }>(`
  INSERT INTO portal_submissions (
    application_id,student_id,university_key,university_name,adapter_key,
    mode,status,external_ref,attempts,max_attempts
  ) VALUES
    (${LEGACY.application},${LEGACY.student},'institution-intake-test','Institution Intake University',
      'test-adapter','real','submitted','RAW-PORTAL-REF-MUST-NOT-BE-STORED',1,3),
    (${LEGACY.dryApplication},${LEGACY.student},'institution-intake-test','Institution Intake University',
      'test-adapter','dry','dry_run','DRY-REF',1,3),
    (${LEGACY.concurrentApplication},${LEGACY.student},'institution-intake-test','Institution Intake University',
      'test-adapter','real','submitted','CONCURRENT-REF',1,3)
  RETURNING id
`);
const successfulSubmissionId = inserted.rows[0].id;
const drySubmissionId = inserted.rows[1].id;
const concurrentSubmissionId = inserted.rows[2].id;

const executorPool = new pg.Pool({
  connectionString: executorUrl,
  max: 3,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 5_000,
  statement_timeout: 8_000,
  query_timeout: 8_000,
  allowExitOnIdle: true,
});
const store = new PostgresInstitutionCaseIntakeStore({
  pool: executorPool,
  config: parseInstitutionCaseIntakeConfig({
    INSTITUTION_CASE_INTAKE_V1_MODE: "allowlist",
    INSTITUTION_CASE_INTAKE_V1_RELATIONSHIP_ALLOWLIST: ID.relationship,
  }),
});

after(async () => {
  await executorPool.end();
  await admin.query(`TRUNCATE TABLE
    institution_case_intake_receipts, institution_application_cases,
    institution_sla_policies, institution_memberships, institution_relationships CASCADE`);
  await admin.query(`DELETE FROM portal_submissions WHERE application_id IN (${LEGACY.application},${LEGACY.dryApplication},${LEGACY.concurrentApplication});
    DELETE FROM portal_universities WHERE university_key='institution-intake-test';
    DELETE FROM applications WHERE id IN (${LEGACY.application},${LEGACY.dryApplication},${LEGACY.concurrentApplication});
    DELETE FROM students WHERE id=${LEGACY.student};
    DELETE FROM programs WHERE id=${LEGACY.program};
    DELETE FROM universities WHERE id=${LEGACY.university};
    DELETE FROM tenant_organization_legacy_branches WHERE tenant_id='${ID.tenant}';
    DELETE FROM branches WHERE id=${LEGACY.branch};
    DELETE FROM organizations WHERE id='${ID.organization}';
    DELETE FROM tenants WHERE id='${ID.tenant}';`);
  await admin.end();
});

test("intake executor is EXECUTE-only and function owner is non-privileged", async () => {
  const roles = await admin.query(`SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolbypassrls,rolcanlogin
    FROM pg_roles WHERE rolname IN ('fas_institution_intake_owner','fas_institution_intake_executor')
    ORDER BY rolname`);
  assert.deepEqual(roles.rows, [
    { rolname: "fas_institution_intake_executor", rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolinherit: false, rolbypassrls: false, rolcanlogin: true },
    { rolname: "fas_institution_intake_owner", rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolinherit: false, rolbypassrls: false, rolcanlogin: false },
  ]);
  const boundary = await admin.query(`SELECT
    has_table_privilege('fas_institution_intake_executor','institution_application_cases','SELECT') AS case_select,
    has_table_privilege('fas_institution_intake_executor','institution_application_cases','INSERT') AS case_insert,
    has_table_privilege('fas_institution_intake_executor','institution_case_intake_receipts','SELECT') AS receipt_select,
    has_table_privilege('fas_institution_intake_executor','institution_case_intake_receipts','INSERT') AS receipt_insert,
    has_function_privilege('fas_institution_intake_executor',
      'fas_institution_intake_v1.create_case_from_portal_submission(uuid,uuid,integer,uuid,uuid)','EXECUTE') AS can_execute`);
  assert.deepEqual(boundary.rows[0], {
    case_select: false,
    case_insert: false,
    receipt_select: false,
    receipt_insert: false,
    can_execute: true,
  });
  const functionBoundary = await admin.query(`SELECT p.prosecdef,pg_get_userbyid(p.proowner) AS owner_name,p.proconfig
    FROM pg_proc p
    WHERE p.oid='fas_institution_intake_v1.create_case_from_portal_submission(uuid,uuid,integer,uuid,uuid)'::regprocedure`);
  assert.deepEqual(functionBoundary.rows[0], {
    prosecdef: true,
    owner_name: "fas_institution_intake_owner",
    proconfig: ["search_path=pg_catalog, public", "row_security=on"],
  });
});

test("default-off gate prevents a database mutation", async () => {
  const disabled = new PostgresInstitutionCaseIntakeStore({
    pool: executorPool,
    config: parseInstitutionCaseIntakeConfig({}),
  });
  await assert.rejects(disabled.intake({
    tenantId: ID.tenant,
    relationshipId: ID.relationship,
    portalSubmissionId: successfulSubmissionId,
  }), /institution_case_intake_disabled/);
  assert.equal((await admin.query("SELECT count(*)::integer AS count FROM institution_case_intake_receipts")).rows[0].count, 0);
});

test("dry or non-success source cannot create an institution case", async () => {
  await assert.rejects(store.intake({
    tenantId: ID.tenant,
    relationshipId: ID.relationship,
    portalSubmissionId: drySubmissionId,
  }), /institution intake source is not a successful real submission/);
});

test("successful intake is PII-minimized, immutable and idempotent", async () => {
  const first = await store.intake({
    tenantId: ID.tenant,
    relationshipId: ID.relationship,
    portalSubmissionId: successfulSubmissionId,
  });
  assert.equal(first.outcome, "CREATED");
  assert.match(first.maskedStudentRef, /^STU-[0-9A-F]{16}$/);
  const replay = await store.intake({
    tenantId: ID.tenant,
    relationshipId: ID.relationship,
    portalSubmissionId: successfulSubmissionId,
  });
  assert.deepEqual(replay, { ...first, outcome: "REPLAY" });

  const persisted = await admin.query(`SELECT
      c.shared_profile,c.lifecycle_state,c.readiness_percent,c.blocker_code,
      c.masked_student_ref,c.source_snapshot_hash,c.intake_receipt_hash,
      r.source_external_ref_hash,r.source_snapshot_hash AS receipt_source_hash,
      r.receipt_hash,r.executor_key,r.outcome
    FROM institution_application_cases c
    JOIN institution_case_intake_receipts r
      ON r.tenant_id=c.tenant_id AND r.relationship_id=c.relationship_id AND r.application_case_id=c.id`);
  assert.equal(persisted.rowCount, 1);
  assert.deepEqual(persisted.rows[0].shared_profile, {});
  assert.equal(persisted.rows[0].lifecycle_state, "RECEIVED");
  assert.equal(persisted.rows[0].readiness_percent, 0);
  assert.equal(persisted.rows[0].blocker_code, "EVIDENCE_NOT_SHARED");
  assert.equal(persisted.rows[0].masked_student_ref, first.maskedStudentRef);
  assert.equal(persisted.rows[0].source_snapshot_hash, first.sourceSnapshotHash);
  assert.equal(persisted.rows[0].receipt_source_hash, first.sourceSnapshotHash);
  assert.equal(persisted.rows[0].intake_receipt_hash, first.receiptHash);
  assert.equal(persisted.rows[0].receipt_hash, first.receiptHash);
  assert.equal(persisted.rows[0].executor_key, "institution.case_intake.v1");
  assert.equal(persisted.rows[0].outcome, "CREATED");
  assert.notEqual(persisted.rows[0].source_external_ref_hash, "RAW-PORTAL-REF-MUST-NOT-BE-STORED");
  assert.equal(JSON.stringify(persisted.rows).includes("RAW-PORTAL-REF-MUST-NOT-BE-STORED"), false);
  await assert.rejects(
    admin.query("UPDATE institution_case_intake_receipts SET outcome='CREATED'"),
    /append-only/,
  );
});

test("same-source concurrency produces one case and one immutable receipt", async () => {
  const request = {
    tenantId: ID.tenant,
    relationshipId: ID.relationship,
    portalSubmissionId: concurrentSubmissionId,
  };
  const [left, right] = await Promise.all([store.intake(request), store.intake(request)]);
  assert.deepEqual(new Set([left.outcome, right.outcome]), new Set(["CREATED", "REPLAY"]));
  assert.equal(left.applicationCaseId, right.applicationCaseId);
  assert.equal(left.receiptId, right.receiptId);
  assert.equal(left.sourceSnapshotHash, right.sourceSnapshotHash);
  assert.equal(left.receiptHash, right.receiptHash);
  const denominator = await admin.query(`SELECT
      (SELECT count(*)::integer FROM institution_application_cases WHERE source_portal_submission_id=$1) AS case_count,
      (SELECT count(*)::integer FROM institution_case_intake_receipts WHERE portal_submission_id=$1) AS receipt_count`,
    [concurrentSubmissionId]);
  assert.deepEqual(denominator.rows[0], { case_count: 1, receipt_count: 1 });
});
