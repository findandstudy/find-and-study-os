import assert from "node:assert/strict";
import { after, test } from "node:test";
import { pool } from "@workspace/db";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (
  process.env.ALLOW_DISPOSABLE_PORTAL_VERIFICATION_TEST !== "true" ||
  databaseUrl.hostname !== "127.0.0.1" ||
  databaseUrl.port !== "5433" ||
  databaseUrl.pathname !== "/fasos_apply_local"
) {
  throw new Error(
    "Portal verification PostgreSQL test requires the explicit disposable 127.0.0.1:5433/fasos_apply_local target",
  );
}

after(async () => {
  await pool.end();
});

test("partner verification receipts are constrained, idempotent and append-only", async () => {
  const client = await pool.connect();
  let savepointCounter = 0;
  const expectCode = async (statement: string, params: unknown[], code: string) => {
    const savepoint = `verification_expected_${++savepointCounter}`;
    await client.query(`SAVEPOINT ${savepoint}`);
    try {
      await client.query(statement, params);
      assert.fail(`Expected PostgreSQL error ${code}`);
    } catch (error) {
      assert.equal((error as { code?: string }).code, code);
    } finally {
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    }
  };

  try {
    await client.query("BEGIN");
    const suffix = `${process.pid}_${Date.now()}`;
    const partner = await client.query<{ id: number }>(
      `INSERT INTO portal_universities
         (university_key, university_name, adapter_key, is_active)
       VALUES ($1, 'Verification Fixture', $1, false)
       RETURNING id`,
      [`verification_fixture_${suffix}`],
    );
    const credential = await client.query<{ id: number }>(
      `INSERT INTO portal_credentials
         (organization_id, portal_key, label, username_enc, password_enc, is_active)
       VALUES (NULL, $1, 'Verification Fixture', 'enc::v1::fixture-user', 'enc::v1::fixture-pass', true)
       RETURNING id`,
      [`verification_fixture_${suffix}`],
    );
    const partnerId = partner.rows[0]!.id;
    const credentialId = credential.rows[0]!.id;
    const requestKey = `test-login:${suffix}`;
    const inserted = await client.query<{ id: number }>(
      `INSERT INTO portal_partner_verification_receipts
         (portal_university_id, verification_generation, verification_type,
          outcome, adapter_key, credential_id, credential_updated_at,
          runtime_release_id, binding_sha256, evidence_sha256, request_key,
          evidence)
       VALUES ($1, 1, 'TEST_LOGIN', 'PASSED', $2, $3, now(),
               'ci-portal-runtime-v1', repeat('a', 64), repeat('b', 64), $4,
               '{"headless":true}'::jsonb)
       RETURNING id`,
      [partnerId, `verification_fixture_${suffix}`, credentialId, requestKey],
    );
    const receiptId = inserted.rows[0]!.id;
    assert.ok(receiptId > 0);

    await expectCode(
      `INSERT INTO portal_partner_verification_receipts
         (portal_university_id, verification_generation, verification_type,
          outcome, adapter_key, credential_id, credential_updated_at,
          runtime_release_id, binding_sha256, evidence_sha256, request_key)
       VALUES ($1, 1, 'TEST_LOGIN', 'PASSED', $2, $3, now(),
               'ci-portal-runtime-v1', repeat('a', 64), repeat('b', 64), $4)`,
      [partnerId, `verification_fixture_${suffix}`, credentialId, requestKey],
      "23505",
    );
    await expectCode(
      "UPDATE portal_partner_verification_receipts SET outcome = 'FAILED' WHERE id = $1",
      [receiptId],
      "23514",
    );
    await expectCode(
      "DELETE FROM portal_partner_verification_receipts WHERE id = $1",
      [receiptId],
      "23514",
    );
    await expectCode(
      `INSERT INTO portal_partner_verification_receipts
         (portal_university_id, verification_generation, verification_type,
          outcome, adapter_key, credential_id, credential_updated_at,
          runtime_release_id, binding_sha256, evidence_sha256, request_key)
       VALUES ($1, 1, 'STRICT_DRY_RUN', 'PASSED', $2, $3, now(),
               'ci-portal-runtime-v1', repeat('a', 64), repeat('c', 64), $4)`,
      [partnerId, `verification_fixture_${suffix}`, credentialId, `dry-run:${suffix}`],
      "23514",
    );

    const student = await client.query<{ id: number }>(
      `INSERT INTO students (first_name, last_name, email)
       VALUES ('Verification', 'Binding', $1)
       RETURNING id`,
      [`verification_binding_${suffix}@test.local`],
    );
    const applicationA = await client.query<{ id: number }>(
      `INSERT INTO applications (student_id, university_name, stage)
       VALUES ($1, 'Verification Fixture', 'inquiry')
       RETURNING id`,
      [student.rows[0]!.id],
    );
    const applicationB = await client.query<{ id: number }>(
      `INSERT INTO applications (student_id, university_name, stage)
       VALUES ($1, 'Verification Fixture', 'inquiry')
       RETURNING id`,
      [student.rows[0]!.id],
    );
    const submissionA = await client.query<{ id: number }>(
      `INSERT INTO portal_submissions
         (application_id, student_id, university_key, university_name,
          adapter_key, mode, status)
       VALUES ($1, $2, $3, 'Verification Fixture', $3, 'dry', 'dry_run')
       RETURNING id`,
      [applicationA.rows[0]!.id, student.rows[0]!.id, `verification_fixture_${suffix}`],
    );

    await expectCode(
      `INSERT INTO portal_partner_verification_receipts
         (portal_university_id, verification_generation, verification_type,
          outcome, adapter_key, credential_id, credential_updated_at,
          runtime_release_id, binding_sha256, evidence_sha256, request_key,
          application_id, portal_submission_id)
       VALUES ($1, 1, 'STRICT_DRY_RUN', 'PASSED', $2, $3, now(),
               'ci-portal-runtime-v1', repeat('a', 64), repeat('d', 64), $4,
               $5, $6)`,
      [
        partnerId,
        `verification_fixture_${suffix}`,
        credentialId,
        `dry-run-mismatch:${suffix}`,
        applicationB.rows[0]!.id,
        submissionA.rows[0]!.id,
      ],
      "23503",
    );

    const boundReceipt = await client.query<{ id: number }>(
      `INSERT INTO portal_partner_verification_receipts
         (portal_university_id, verification_generation, verification_type,
          outcome, adapter_key, credential_id, credential_updated_at,
          runtime_release_id, binding_sha256, evidence_sha256, request_key,
          application_id, portal_submission_id)
       VALUES ($1, 1, 'STRICT_DRY_RUN', 'PASSED', $2, $3, now(),
               'ci-portal-runtime-v1', repeat('a', 64), repeat('e', 64), $4,
               $5, $6)
       RETURNING id`,
      [
        partnerId,
        `verification_fixture_${suffix}`,
        credentialId,
        `dry-run-bound:${suffix}`,
        applicationA.rows[0]!.id,
        submissionA.rows[0]!.id,
      ],
    );
    assert.ok(boundReceipt.rows[0]!.id > 0, "matching application/submission evidence is accepted");

    const generation = await client.query<{ verification_generation: number }>(
      `UPDATE portal_universities
          SET verification_generation = verification_generation + 1
        WHERE id = $1
        RETURNING verification_generation`,
      [partnerId],
    );
    assert.equal(generation.rows[0]?.verification_generation, 2);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
});
