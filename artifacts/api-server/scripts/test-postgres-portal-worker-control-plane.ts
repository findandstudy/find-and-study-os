import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import test, { after } from "node:test";
import express from "express";
import { pool } from "@workspace/db";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (
  process.env.ALLOW_DISPOSABLE_PORTAL_WORKER_CONTROL_TEST !== "true" ||
  databaseUrl.hostname !== "127.0.0.1" ||
  databaseUrl.port !== "5433" ||
  databaseUrl.pathname !== "/fasos_apply_local"
) {
  throw new Error(
    "Portal worker control-plane test requires the explicit disposable 127.0.0.1:5433/fasos_apply_local target",
  );
}

const releaseId = "ci-portal-worker-control-v1";
process.env.RELEASE_ID = releaseId;

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

after(async () => {
  await pool.end();
});

test("worker jobs are release-pinned, idempotent and append-only", async () => {
  const {
    PortalWorkerJobIdempotencyConflictError,
    PortalWorkerUnavailableError,
    assertPortalWorkerReady,
    claimNextPortalWorkerJob,
    completePortalWorkerJob,
    enqueuePortalWorkerJob,
    recordPortalWorkerHeartbeat,
  } = await import("@workspace/portal-runner");
  const suffix = `${process.pid}_${Date.now()}`;
  const workerId = `worker-control-${suffix}`;
  const partner = await pool.query<{ id: number }>(
    `INSERT INTO portal_universities
       (university_key, university_name, adapter_key, is_active)
     VALUES ($1, 'Worker Control Fixture', $1, false)
     RETURNING id`,
    [`worker_control_${suffix}`],
  );
  const partnerId = partner.rows[0]!.id;

  await pool.query(
    `INSERT INTO portal_worker_heartbeats
       (worker_kind, worker_id, runtime_release_id, execution_modes, updated_at)
     VALUES ('portal_execution', $1, 'old-release', ARRAY['real'], now() - interval '2 minutes')`,
    [`stale-${suffix}`],
  );
  await recordPortalWorkerHeartbeat({
    workerId,
    releaseId,
    executionModes: new Set(["test_login"]),
  });

  await assert.rejects(
    assertPortalWorkerReady("real"),
    (error: unknown) =>
      error instanceof PortalWorkerUnavailableError &&
      error.code === "PORTAL_WORKER_MODE_DISABLED",
  );

  await recordPortalWorkerHeartbeat({
    workerId,
    releaseId,
    executionModes: new Set(["test_login", "program_catalog_sync", "lifecycle_execute"]),
  });
  const ready = await assertPortalWorkerReady("test_login");
  assert.equal(ready.releaseId, releaseId);
  assert.ok(ready.workerId.length > 0);

  const requestKey = `test-login:${suffix}`;
  const first = await enqueuePortalWorkerJob({
    kind: "test_login",
    portalUniversityId: partnerId,
    requestKey,
    requestedBy: null,
    payload: { source: "control-test" },
  });
  assert.equal(first.replay, false);

  const replay = await enqueuePortalWorkerJob({
    kind: "test_login",
    portalUniversityId: partnerId,
    requestKey,
    requestedBy: null,
    payload: { source: "control-test" },
  });
  assert.equal(replay.id, first.id);
  assert.equal(replay.replay, true);

  await assert.rejects(
    enqueuePortalWorkerJob({
      kind: "test_login",
      portalUniversityId: partnerId,
      requestKey,
      requestedBy: null,
      payload: { source: "different-command" },
    }),
    PortalWorkerJobIdempotencyConflictError,
  );

  const claimed = await claimNextPortalWorkerJob({
    workerId,
    supportedKinds: ["test_login"],
  });
  assert.equal(claimed?.id, first.id);
  assert.equal(claimed?.requestedReleaseId, releaseId);
  assert.equal(claimed?.attempts, 1);
  await completePortalWorkerJob({
    job: claimed!,
    workerId,
    evidence: { outcome: "login_verified" },
  });

  const terminal = await pool.query<{
    status: string;
    finished_at: Date | null;
    receipt_id: string;
  }>(
    `SELECT job.status, job.finished_at, receipt.id AS receipt_id
       FROM portal_worker_jobs job
       JOIN portal_worker_job_receipts receipt ON receipt.job_id = job.id
      WHERE job.id = $1`,
    [first.id],
  );
  assert.equal(terminal.rows[0]?.status, "succeeded");
  assert.ok(terminal.rows[0]?.finished_at instanceof Date);
  const receiptId = terminal.rows[0]!.receipt_id;

  await assert.rejects(
    pool.query(
      "UPDATE portal_worker_jobs SET payload = '{\"changed\":true}'::jsonb WHERE id = $1",
      [first.id],
    ),
    (error: unknown) => (error as { code?: string }).code === "23514",
  );
  await assert.rejects(
    pool.query("UPDATE portal_worker_jobs SET status = 'queued', finished_at = NULL WHERE id = $1", [first.id]),
    (error: unknown) => (error as { code?: string }).code === "23514",
  );

  await assert.rejects(
    pool.query(
      "UPDATE portal_worker_job_receipts SET evidence = '{}'::jsonb WHERE id = $1",
      [receiptId],
    ),
    (error: unknown) => (error as { code?: string }).code === "23514",
  );
  await assert.rejects(
    pool.query("DELETE FROM portal_worker_job_receipts WHERE id = $1", [receiptId]),
    (error: unknown) => (error as { code?: string }).code === "23514",
  );

  await pool.query(
    `INSERT INTO portal_worker_jobs
       (job_kind, portal_university_id, request_key, requested_release_id,
        payload_sha256, payload)
     VALUES ('test_login', $1, $2, 'different-release', repeat('c', 64), '{}'::jsonb)`,
    [partnerId, `release-pin:${suffix}`],
  );
  assert.equal(
    await claimNextPortalWorkerJob({ workerId, supportedKinds: ["test_login"] }),
    null,
    "a worker must not claim a job pinned to another release",
  );
});

test("approved lifecycle stage transitions execute once through a pinned worker job", async () => {
  const {
    claimNextPortalWorkerJob,
    completePortalWorkerJob,
    recordPortalWorkerHeartbeat,
  } = await import("@workspace/portal-runner");
  const {
    enqueueApprovedPortalLifecycleProposal,
    executeApprovedPortalLifecycleProposal,
  } = await import("../src/lib/portalLifecycleExecution.js");
  const suffix = `${process.pid}_${Date.now()}`;
  const workerId = `lifecycle-control-${suffix}`;
  await pool.query(
    `UPDATE portal_worker_jobs
        SET status = 'canceled', finished_at = now(), updated_at = now()
      WHERE job_kind = 'lifecycle_execute' AND status = 'queued'`,
  );
  await recordPortalWorkerHeartbeat({
    workerId,
    releaseId,
    executionModes: new Set(["lifecycle_execute"]),
  });
  await pool.query(
    `INSERT INTO pipeline_stages (entity_type, key, label, sort_order)
     VALUES ('application', 'rejected', 'Rejected', 999)
     ON CONFLICT (entity_type, key) DO NOTHING`,
  );
  const reviewer = await pool.query<{ id: number }>(
    `INSERT INTO users (email, role) VALUES ($1, 'admin') RETURNING id`,
    [`lifecycle_checker_${suffix}@test.local`],
  );
  const student = await pool.query<{ id: number }>(
    `INSERT INTO students (first_name, last_name, email)
     VALUES ('Lifecycle', 'Execution', $1) RETURNING id`,
    [`lifecycle_execution_${suffix}@test.local`],
  );
  const application = await pool.query<{ id: number }>(
    `INSERT INTO applications (student_id, university_name, stage)
     VALUES ($1, 'Lifecycle Execution Fixture', 'submitted') RETURNING id`,
    [student.rows[0]!.id],
  );
  const applicationId = application.rows[0]!.id;
  const submission = await pool.query<{ id: number }>(
    `INSERT INTO portal_submissions
       (application_id, student_id, university_key, university_name,
        adapter_key, mode, status)
     VALUES ($1, $2, 'lifecycle-execution', 'Lifecycle Execution',
             'lifecycle-execution', 'real', 'submitted')
     RETURNING id`,
    [applicationId, student.rows[0]!.id],
  );
  const observationHash = "7".repeat(64);
  const observation = await pool.query<{ id: number }>(
    `INSERT INTO portal_lifecycle_observations
       (submission_id, application_id, adapter_key, observation_hash,
        raw_status, signal, disposition, identity_verified, identity_source,
        observed_at)
     VALUES ($1, $2, 'lifecycle-execution', $3, 'Rejected', 'rejected',
             'REJECTED', true, 'matched_application_row', now())
     RETURNING id`,
    [submission.rows[0]!.id, applicationId, observationHash],
  );
  const proposalDecision = {
    signal: "rejected",
    disposition: "REJECTED",
    targetStage: "rejected",
    action: "review_stage_transition",
    requiredArtifact: null,
    artifactVerified: true,
    proposeStudentNotification: true,
    proposeUniversityForward: false,
    humanApprovalRequired: true,
    allowPortalMutation: false,
    reason: "fixture",
  };
  const proposal = await pool.query<{ id: string }>(
    `INSERT INTO portal_lifecycle_proposals
       (submission_id, application_id, observation_id, proposal_key,
        observation_hash, raw_status, current_stage, decision)
     VALUES ($1, $2, $3, $4, $5, 'Rejected', 'submitted', $6::jsonb)
     RETURNING id`,
    [
      submission.rows[0]!.id,
      applicationId,
      observation.rows[0]!.id,
      `portal_lifecycle:${sha256(`execution:${suffix}`)}`,
      observationHash,
      JSON.stringify(proposalDecision),
    ],
  );
  const proposalId = Number(proposal.rows[0]!.id);
  await pool.query(
    `INSERT INTO portal_lifecycle_proposal_reviews
       (proposal_id, reviewer_id, decision, request_key, evidence_sha256)
     VALUES ($1, $2, 'approve', $3, repeat('9', 64))`,
    [proposalId, reviewer.rows[0]!.id, `lifecycle-approve:${suffix}`],
  );
  await pool.query(
    `UPDATE portal_lifecycle_proposals
        SET status = 'approved', reviewed_by = $2, reviewed_at = now()
      WHERE id = $1`,
    [proposalId, reviewer.rows[0]!.id],
  );

  const queued = await enqueueApprovedPortalLifecycleProposal(proposalId);
  assert.equal(queued.queued, true);
  const job = await claimNextPortalWorkerJob({
    workerId,
    supportedKinds: ["lifecycle_execute"],
  });
  assert.equal(job?.id, queued.jobId);
  const executed = await executeApprovedPortalLifecycleProposal(proposalId);
  assert.deepEqual(executed, {
    outcome: "executed",
    proposalId,
    applicationId,
    targetStage: "rejected",
  });
  await completePortalWorkerJob({ job: job!, workerId, evidence: executed });

  const stored = await pool.query<{
    application_stage: string;
    proposal_status: string;
    executed_at: Date | null;
  }>(
    `SELECT application.stage AS application_stage,
            proposal.status AS proposal_status,
            proposal.executed_at
       FROM applications application
       JOIN portal_lifecycle_proposals proposal
         ON proposal.application_id = application.id
      WHERE proposal.id = $1`,
    [proposalId],
  );
  assert.equal(stored.rows[0]?.application_stage, "rejected");
  assert.equal(stored.rows[0]?.proposal_status, "executed");
  assert.ok(stored.rows[0]?.executed_at instanceof Date);
  assert.equal(
    (await executeApprovedPortalLifecycleProposal(proposalId)).outcome,
    "already_executed",
  );
});

test("submission intents and lifecycle reviews enforce database invariants", async () => {
  const client = await pool.connect();
  let savepointCounter = 0;
  const expectCode = async (
    statement: string,
    params: unknown[],
    code: string,
  ) => {
    const savepoint = `portal_control_expected_${++savepointCounter}`;
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
    const users = await client.query<{ id: number }>(
      `INSERT INTO users (email, role)
       VALUES ($1, 'admin'), ($2, 'admin')
       RETURNING id`,
      [`maker_${suffix}@test.local`, `checker_${suffix}@test.local`],
    );
    const makerId = users.rows[0]!.id;
    const checkerId = users.rows[1]!.id;
    const student = await client.query<{ id: number }>(
      `INSERT INTO students (first_name, last_name, email)
       VALUES ('Portal', 'Control', $1)
       RETURNING id`,
      [`portal_control_${suffix}@test.local`],
    );
    const application = await client.query<{ id: number }>(
      `INSERT INTO applications (student_id, university_name, stage)
       VALUES ($1, 'Portal Control Fixture', 'submitted')
       RETURNING id`,
      [student.rows[0]!.id],
    );
    const applicationId = application.rows[0]!.id;
    const targetHash = "a".repeat(64);
    const target = JSON.stringify({ schemaVersion: 1, applicationId });
    const submissions = await client.query<{ id: number }>(
      `INSERT INTO portal_submissions
         (application_id, student_id, university_key, university_name,
          adapter_key, mode, status, submit_intent_key,
          target_identity_sha256, target_identity)
       VALUES
         ($1, $2, 'portal-control', 'Portal Control', 'portal-control',
          'real', 'queued', $3, $5, $6::jsonb),
         ($1, $2, 'portal-control', 'Portal Control', 'portal-control',
          'real', 'queued', $4, $5, $6::jsonb)
       RETURNING id`,
      [
        applicationId,
        student.rows[0]!.id,
        `manual:${applicationId}:${suffix}:a`,
        `manual:${applicationId}:${suffix}:b`,
        targetHash,
        target,
      ],
    );
    const committedId = submissions.rows[0]!.id;
    const duplicateId = submissions.rows[1]!.id;
    await client.query(
      `UPDATE portal_submissions
          SET status = 'submitted', provider_committed_at = now()
        WHERE id = $1`,
      [committedId],
    );

    await expectCode(
      "UPDATE portal_submissions SET target_identity_sha256 = repeat('b', 64) WHERE id = $1",
      [committedId],
      "23514",
    );
    await expectCode(
      "UPDATE portal_submissions SET provider_committed_at = now() + interval '1 second' WHERE id = $1",
      [committedId],
      "23514",
    );
    await expectCode(
      "UPDATE portal_submissions SET provider_committed_at = now() WHERE id = $1",
      [duplicateId],
      "23505",
    );
    await expectCode(
      `INSERT INTO portal_submissions
         (application_id, university_key, university_name, mode, status,
          submit_intent_key, target_identity_sha256, target_identity,
          provider_committed_at)
       VALUES ($1, 'portal-control-dry', 'Portal Control Dry', 'dry', 'dry_run',
               $2, repeat('c', 64), $3::jsonb, now())`,
      [applicationId, `manual:${applicationId}:${suffix}:dry`, target],
      "23514",
    );

    const observation = await client.query<{ id: number }>(
      `INSERT INTO portal_lifecycle_observations
         (submission_id, application_id, adapter_key, observation_hash,
          raw_status, signal, disposition, identity_verified, identity_source,
          observed_at)
       VALUES ($1, $2, 'portal-control', repeat('d', 64), 'Offer Ready',
               'offer_received', 'CONDITIONAL_OFFER', true,
               'matched_application_row', now())
       RETURNING id`,
      [committedId, applicationId],
    );
    const proposal = await client.query<{ id: string }>(
      `INSERT INTO portal_lifecycle_proposals
         (submission_id, application_id, observation_id, proposal_key,
          observation_hash, raw_status, current_stage, decision,
          proposed_by_user_id)
       VALUES ($1, $2, $3, $4, repeat('d', 64), 'Offer Ready',
               'submitted', '{"action":"advance_stage"}'::jsonb, $5)
       RETURNING id`,
      [
        committedId,
        applicationId,
        observation.rows[0]!.id,
        `portal_lifecycle:${"e".repeat(64)}`,
        makerId,
      ],
    );
    const proposalId = proposal.rows[0]!.id;

    await expectCode(
      `UPDATE portal_lifecycle_proposals
          SET reviewed_by = $2, reviewed_at = now(), status = 'approved'
        WHERE id = $1`,
      [proposalId, makerId],
      "23514",
    );
    await expectCode(
      "UPDATE portal_lifecycle_proposals SET raw_status = 'Changed' WHERE id = $1",
      [proposalId],
      "23514",
    );

    const review = await client.query<{ id: string }>(
      `INSERT INTO portal_lifecycle_proposal_reviews
         (proposal_id, reviewer_id, decision, request_key, evidence_sha256)
       VALUES ($1, $2, 'approve', $3, repeat('f', 64))
       RETURNING id`,
      [proposalId, checkerId, `approve:${suffix}`],
    );
    await client.query(
      `UPDATE portal_lifecycle_proposals
          SET reviewed_by = $2, reviewed_at = now(), status = 'approved',
              updated_at = now()
        WHERE id = $1`,
      [proposalId, checkerId],
    );
    await expectCode(
      "UPDATE portal_lifecycle_proposals SET status = 'pending_review' WHERE id = $1",
      [proposalId],
      "23514",
    );
    await expectCode(
      "UPDATE portal_lifecycle_proposals SET status = 'rejected' WHERE id = $1",
      [proposalId],
      "23514",
    );
    await expectCode(
      "UPDATE portal_lifecycle_proposal_reviews SET reason = 'changed' WHERE id = $1",
      [review.rows[0]!.id],
      "23514",
    );
    await expectCode(
      "DELETE FROM portal_lifecycle_proposal_reviews WHERE id = $1",
      [review.rows[0]!.id],
      "23514",
    );
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
});

test("lifecycle review API requires an idempotency key and replays the same maker-checker decision", async () => {
  const { default: portalAutomationRouter } = await import("../src/routes/portalAutomation.js");
  const suffix = `${process.pid}_${Date.now()}`;
  const reviewer = await pool.query<{ id: number }>(
    `INSERT INTO users (email, role, is_active, email_verified)
     VALUES ($1, 'super_admin', true, true) RETURNING id`,
    [`lifecycle_api_checker_${suffix}@test.local`],
  );
  const reviewerId = reviewer.rows[0]!.id;
  const student = await pool.query<{ id: number }>(
    `INSERT INTO students (first_name, last_name)
     VALUES ('Lifecycle', 'Api Review') RETURNING id`,
  );
  const application = await pool.query<{ id: number }>(
    `INSERT INTO applications (student_id, university_name, stage)
     VALUES ($1, 'Lifecycle API Fixture', 'submitted') RETURNING id`,
    [student.rows[0]!.id],
  );
  const applicationId = application.rows[0]!.id;
  const submission = await pool.query<{ id: number }>(
    `INSERT INTO portal_submissions
       (application_id, student_id, university_key, university_name,
        adapter_key, mode, status)
     VALUES ($1, $2, 'lifecycle-api', 'Lifecycle API',
             'lifecycle-api', 'real', 'submitted') RETURNING id`,
    [applicationId, student.rows[0]!.id],
  );
  const observationHash = "1".repeat(64);
  const observation = await pool.query<{ id: number }>(
    `INSERT INTO portal_lifecycle_observations
       (submission_id, application_id, adapter_key, observation_hash,
        raw_status, signal, disposition, identity_verified, identity_source,
        observed_at)
     VALUES ($1, $2, 'lifecycle-api', $3, 'Rejected', 'rejected',
             'REJECTED', true, 'matched_application_row', now()) RETURNING id`,
    [submission.rows[0]!.id, applicationId, observationHash],
  );
  const proposal = await pool.query<{ id: string }>(
    `INSERT INTO portal_lifecycle_proposals
       (submission_id, application_id, observation_id, proposal_key,
        observation_hash, raw_status, current_stage, decision)
     VALUES ($1, $2, $3, $4, $5, 'Rejected', 'submitted', $6::jsonb)
     RETURNING id`,
    [
      submission.rows[0]!.id,
      applicationId,
      observation.rows[0]!.id,
      `portal_lifecycle:${sha256(`api-review:${suffix}`)}`,
      observationHash,
      JSON.stringify({
        signal: "rejected",
        disposition: "REJECTED",
        targetStage: "rejected",
        action: "review_stage_transition",
        requiredArtifact: null,
        artifactVerified: true,
        proposeStudentNotification: false,
        proposeUniversityForward: false,
        humanApprovalRequired: true,
        allowPortalMutation: false,
        reason: "fixture",
      }),
    ],
  );
  const proposalId = Number(proposal.rows[0]!.id);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: unknown }).user = {
      id: reviewerId,
      role: "super_admin",
      isActive: true,
      emailVerified: true,
    };
    next();
  });
  app.use("/api", portalAutomationRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const request = async (body: Record<string, unknown>) => {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/portal-lifecycle-proposals/${proposalId}/review`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  try {
    const missingKey = await request({ decision: "approve" });
    assert.equal(missingKey.status, 400);

    const body = {
      decision: "approve",
      reason: "verified by checker",
      requestKey: `lifecycle-api:${suffix}`,
    };
    const approved = await request(body);
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.decision, "approve");
    assert.equal(approved.body.replay, false);
    assert.equal(typeof approved.body.executionQueued, "boolean");

    const replay = await request(body);
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.replay, true);

    const conflict = await request({
      decision: "reject",
      requestKey: `lifecycle-api-conflict:${suffix}`,
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error, "PROPOSAL_ALREADY_REVIEWED");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
