import assert from "node:assert/strict";
import test, { after } from "node:test";
import pg from "pg";

if (process.env.ALLOW_DISPOSABLE_SOCIAL_PUBLICATION_TEST !== "true")
  throw new Error(
    "social_publication_test_requires_explicit_disposable_opt_in",
  );
const actorUrl = process.env.DATABASE_URL;
const adminUrl = process.env.SOCIAL_TEST_ADMIN_DATABASE_URL;
if (!actorUrl || !adminUrl)
  throw new Error("social_publication_test_urls_required");
for (const raw of [actorUrl, adminUrl]) {
  const url = new URL(raw);
  if (
    !["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname) ||
    url.port !== "5433" ||
    url.pathname !== "/fasos_apply_local"
  )
    throw new Error(
      "social_publication_test_requires_disposable_loopback_database",
    );
}
if (new URL(actorUrl).username !== "fas_social_executor")
  throw new Error("social_publication_test_requires_exact_executor_role");

const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
assert.equal(
  (
    await admin.query(
      "SELECT count(*)::integer AS count FROM drizzle.__drizzle_migrations",
    )
  ).rows[0]?.count,
  101,
);
await admin.query(`DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='fas_social_executor') THEN
    CREATE ROLE fas_social_executor LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
END $$`);
await admin.query(
  "ALTER ROLE fas_social_executor NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS",
);
await admin.query(
  "GRANT CONNECT ON DATABASE fasos_apply_local TO fas_social_executor",
);
await admin.query("GRANT USAGE ON SCHEMA public TO fas_social_executor");
await admin.query(
  `GRANT SELECT ON tenants,organizations,users TO fas_social_executor`,
);
await admin.query(`GRANT SELECT,INSERT,UPDATE ON
  social_accounts,social_content_briefs,social_publication_intents,
  social_performance_sync_state TO fas_social_executor`);
await admin.query(`GRANT SELECT,INSERT ON
  social_content_reviews,social_publication_reviews,social_publication_attempts,
  social_operation_receipts,social_performance_snapshots,
  social_account_verifications,social_performance_attempts TO fas_social_executor`);

const tenantId = "0199a100-0000-7000-8000-000000000001";
const organizationId = "0199a100-0000-7000-8000-000000000002";
const otherTenantId = "0199a100-0000-7000-8000-000000000003";
const otherOrganizationId = "0199a100-0000-7000-8000-000000000004";
const makerUserId = 992101;
const checkerUserId = 992102;
const accountId = "0199a100-0000-7000-8000-000000000005";
const accountBId = "0199a100-0000-7000-8000-000000000009";
const briefId = "0199a100-0000-7000-8000-000000000006";
const intentA = "0199a100-0000-7000-8000-000000000007";
const intentB = "0199a100-0000-7000-8000-000000000008";
const expiredIntent = "0199a100-0000-7000-8000-00000000000a";

await admin.query(
  `INSERT INTO tenants(id,slug,legal_name,display_name,status,home_region) VALUES
   ($1,'social-orchestration-test','Social Test','Social Test','ACTIVE','eu-test'),
   ($2,'social-orchestration-other','Social Other','Social Other','ACTIVE','eu-test')`,
  [tenantId, otherTenantId],
);
await admin.query(
  `INSERT INTO organizations(id,tenant_id,legal_name,display_name,organization_type,status) VALUES
   ($1,$2,'Social Test','Social Test','OPERATING_ENTITY','ACTIVE'),
   ($3,$4,'Social Other','Social Other','OPERATING_ENTITY','ACTIVE')`,
  [organizationId, tenantId, otherOrganizationId, otherTenantId],
);
await admin.query(
  `INSERT INTO users(id,email,first_name,last_name,role,is_active,email_verified) VALUES
   ($1,'maker@social.test','Social','Maker','manager',true,true),
   ($2,'checker@social.test','Social','Checker','admin',true,true)`,
  [makerUserId, checkerUserId],
);
await admin.query(
  `INSERT INTO social_accounts
     (id,tenant_id,organization_id,provider,account_key,display_name,integration_key,
      external_account_ref_hash,verification_receipt_hash,verified_at,last_verification_at,
      status,created_by_legacy_user_id)
   VALUES
     ($1,$2,$3,'meta','meta:test','Test Account','meta_ads',repeat('b',64),repeat('c',64),now(),now(),'VERIFIED',$4),
     ($5,$2,$3,'linkedin','linkedin:test','Test Account B','linkedin',repeat('d',64),repeat('e',64),now(),now(),'VERIFIED',$4)`,
  [accountId, tenantId, organizationId, makerUserId, accountBId],
);
await admin.query(
  `INSERT INTO social_content_briefs
     (id,tenant_id,organization_id,title,objective,audience,content_kind,locales,channels,caption,status,created_by_legacy_user_id,reviewed_by_legacy_user_id,reviewed_at)
   VALUES ($1,$2,$3,'Approved test','Safety','Test','POST',ARRAY['tr'],ARRAY['instagram'],'Test copy','APPROVED',$4,$5,now())`,
  [briefId, tenantId, organizationId, makerUserId, checkerUserId],
);
await admin.query(
  `INSERT INTO social_publication_intents
     (id,tenant_id,organization_id,brief_id,account_id,scheduled_for,status,idempotency_key,max_attempts,next_attempt_at,created_by_legacy_user_id,approved_by_legacy_user_id)
   VALUES
     ($1,$2,$3,$4,$5,now(),'APPROVED','social-test-intent-a',3,now(),$6,$7),
     ($8,$2,$3,$4,$9,now(),'APPROVED','social-test-intent-b',3,now(),$6,$7)`,
  [
    intentA,
    tenantId,
    organizationId,
    briefId,
    accountId,
    makerUserId,
    checkerUserId,
    intentB,
    accountBId,
  ],
);
await admin.query(
  `INSERT INTO social_publication_intents
     (id,tenant_id,organization_id,brief_id,account_id,scheduled_for,status,
      idempotency_key,attempt_count,max_attempts,lease_token_hash,leased_at,
      lease_expires_at,worker_id,created_by_legacy_user_id,approved_by_legacy_user_id)
   VALUES ($1,$2,$3,$4,$5,now(),'RUNNING','social-test-intent-expired',1,3,
     repeat('a',64),now()-interval '5 minutes',now()-interval '3 minutes',
     'crashed-worker',$6,$7)`,
  [
    expiredIntent,
    tenantId,
    organizationId,
    briefId,
    accountId,
    makerUserId,
    checkerUserId,
  ],
);

process.env.NODE_ENV = "test";
process.env.SOCIAL_OPERATIONS_V1_MODE = "manage";
process.env.SOCIAL_OPERATIONS_TENANT_ID = tenantId;
process.env.SOCIAL_OPERATIONS_ORGANIZATION_ID = organizationId;

const {
  appendSocialOperationReceipt,
  findSocialOperationReplay,
  nextSocialId,
  withSocialOperationsContext,
} = await import("../src/lib/socialOperationsStore");
const { claimSocialPublication, completeSocialPublication } =
  await import("../src/lib/socialPublicationQueue");
const { claimSocialPerformance, completeSocialPerformance } =
  await import("../src/lib/socialPerformanceQueue");

after(async () => {
  const tables = [
    "social_performance_attempts",
    "social_performance_sync_state",
    "social_account_verifications",
    "social_publication_attempts",
    "social_publication_reviews",
    "social_operation_receipts",
    "social_performance_snapshots",
    "social_publication_intents",
    "social_content_reviews",
    "social_content_briefs",
    "social_accounts",
  ];
  for (const table of tables)
    await admin.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
  try {
    for (const table of tables)
      await admin.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [tenantId]);
  } finally {
    for (const table of tables)
      await admin.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
  }
  await admin.query(
    "DELETE FROM organizations WHERE tenant_id=ANY($1::uuid[])",
    [[tenantId, otherTenantId]],
  );
  await admin.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [
    [tenantId, otherTenantId],
  ]);
  await admin.query("DELETE FROM users WHERE id=ANY($1::integer[])", [
    [makerUserId, checkerUserId],
  ]);
  const { pool } = await import("@workspace/db");
  await pool.end();
  await admin.end();
});

test("all social tables force RLS and evidence tables expose no delete policy", async () => {
  const result = await admin.query(`SELECT c.relname,c.relforcerowsecurity,
    count(p.policyname) FILTER(WHERE p.cmd='DELETE')::integer AS delete_policies
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_policies p ON p.schemaname=n.nspname AND p.tablename=c.relname
    WHERE n.nspname='public' AND c.relname LIKE 'social_%' AND c.relkind='r'
    GROUP BY c.relname,c.relforcerowsecurity ORDER BY c.relname`);
  assert.equal(result.rowCount, 11);
  assert.equal(
    result.rows.every(
      (row) => row.relforcerowsecurity === true && row.delete_policies === 0,
    ),
    true,
  );
});

test("least privilege executor is scoped to the selected tenant and organization", async () => {
  const actor = new pg.Client({ connectionString: actorUrl });
  await actor.connect();
  try {
    await actor.query("BEGIN");
    await actor.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
    await actor.query("SELECT set_config('app.organization_id',$1,true)", [
      organizationId,
    ]);
    assert.equal(
      (
        await actor.query(
          "SELECT count(*)::integer AS count FROM social_accounts",
        )
      ).rows[0].count,
      2,
    );
    await actor.query("SELECT set_config('app.tenant_id',$1,true)", [
      otherTenantId,
    ]);
    await actor.query("SELECT set_config('app.organization_id',$1,true)", [
      otherOrganizationId,
    ]);
    assert.equal(
      (
        await actor.query(
          "SELECT count(*)::integer AS count FROM social_accounts",
        )
      ).rows[0].count,
      0,
    );
  } finally {
    await actor.query("ROLLBACK").catch(() => undefined);
    await actor.end();
  }
});

test("operation receipts are transactional, replayable, conflict-safe and append-only", async () => {
  const payload = { action: "test", value: 1 };
  const result = { accepted: true, id: intentA };
  await withSocialOperationsContext(
    makerUserId,
    "manage",
    async (client, context) => {
      await appendSocialOperationReceipt(client, context, {
        operation: "TEST_SOCIAL_RECEIPT",
        entityType: "social_publication_intent",
        entityId: intentA,
        requestKey: "social-test-receipt",
        payload,
        result,
      });
    },
  );
  const replay = await withSocialOperationsContext(
    makerUserId,
    "read",
    (client, context) =>
      findSocialOperationReplay(
        client,
        context,
        "social-test-receipt",
        payload,
      ),
  );
  assert.deepEqual(replay, { ...result, replay: true });
  await assert.rejects(
    withSocialOperationsContext(makerUserId, "read", (client, context) =>
      findSocialOperationReplay(client, context, "social-test-receipt", {
        action: "tamper",
      }),
    ),
    /SOCIAL_IDEMPOTENCY_CONFLICT/,
  );
  await assert.rejects(
    admin.query(
      "UPDATE social_operation_receipts SET result='{}'::jsonb WHERE tenant_id=$1 AND request_key='social-test-receipt'",
      [tenantId],
    ),
    /append-only/i,
  );
});

test("concurrent workers claim different jobs and record receipt-bound outcomes", async () => {
  const [first, second] = await Promise.all([
    withSocialOperationsContext(makerUserId, "manage", (client, context) =>
      claimSocialPublication(client, context, "social-worker-a"),
    ),
    withSocialOperationsContext(makerUserId, "manage", (client, context) =>
      claimSocialPublication(client, context, "social-worker-b"),
    ),
  ]);
  assert.ok(first);
  assert.ok(second);
  assert.notEqual(first.id, second.id);
  const saturated = await withSocialOperationsContext(
    makerUserId,
    "manage",
    (client, context) =>
      claimSocialPublication(client, context, "social-worker-c"),
  );
  assert.equal(saturated, null);
  const published = await withSocialOperationsContext(
    makerUserId,
    "manage",
    (client, context) =>
      completeSocialPublication(
        client,
        context,
        first,
        "social-worker-a",
        "test-release-1",
        {
          ok: true,
          providerReceipt: "provider-receipt-a",
          providerPostRef: "provider-post-a",
        },
      ),
  );
  const retry = await withSocialOperationsContext(
    makerUserId,
    "manage",
    (client, context) =>
      completeSocialPublication(
        client,
        context,
        second,
        "social-worker-b",
        "test-release-1",
        {
          ok: false,
          retryable: true,
          errorCode: "PROVIDER_HTTP_429",
        },
      ),
  );
  assert.equal(published, "PUBLISHED");
  assert.equal(retry, "QUEUED");
  const states = await admin.query(
    "SELECT status,attempt_count,execution_receipt_hash,provider_post_ref_hash,last_error_code FROM social_publication_intents WHERE tenant_id=$1 ORDER BY status",
    [tenantId],
  );
  assert.equal(
    states.rows.some(
      (row) =>
        row.status === "PUBLISHED" &&
        row.attempt_count === 1 &&
        row.execution_receipt_hash &&
        row.provider_post_ref_hash,
    ),
    true,
  );
  assert.equal(
    states.rows.some(
      (row) =>
        row.status === "QUEUED" &&
        row.attempt_count === 1 &&
        row.last_error_code === "PROVIDER_HTTP_429",
    ),
    true,
  );
  assert.equal(
    states.rows.some(
      (row) =>
        row.status === "FAILED" &&
        row.attempt_count === 1 &&
        row.last_error_code === "WORKER_LEASE_EXPIRED",
    ),
    true,
  );
  assert.equal(
    (
      await admin.query(
        "SELECT count(*)::integer AS count FROM social_publication_attempts WHERE tenant_id=$1 AND publication_intent_id=$2 AND outcome='FAILED'",
        [tenantId, expiredIntent],
      )
    ).rows[0].count,
    1,
  );
  await assert.rejects(
    admin.query(
      "UPDATE social_publication_attempts SET error_code='TAMPER' WHERE tenant_id=$1",
      [tenantId],
    ),
    /append-only/i,
  );
});

test("account verification evidence is immutable and receipt-bound", async () => {
  await withSocialOperationsContext(
    makerUserId,
    "manage",
    async (client, context) => {
      await client.query(
        `INSERT INTO social_account_verifications
           (id,tenant_id,organization_id,account_id,actor_legacy_user_id,request_key,
            outcome,provider_request_hash,provider_receipt_hash,external_account_ref_hash)
         VALUES ($1,$2,$3,$4,$5,'social-account-verification-test','VERIFIED',
           repeat('1',64),repeat('2',64),repeat('3',64))`,
        [
          nextSocialId(),
          context.tenantId,
          context.organizationId,
          accountId,
          context.legacyUserId,
        ],
      );
    },
  );
  assert.equal(
    (
      await admin.query(
        "SELECT count(*)::integer AS count FROM social_account_verifications WHERE tenant_id=$1",
        [tenantId],
      )
    ).rows[0].count,
    1,
  );
  await assert.rejects(
    admin.query(
      "UPDATE social_account_verifications SET outcome='REAUTH_REQUIRED' WHERE tenant_id=$1",
      [tenantId],
    ),
    /append-only/i,
  );
});

test("performance collection stores bounded snapshots and dead-letters permanent failures", async () => {
  const first = await withSocialOperationsContext(
    makerUserId,
    "manage",
    (client, context) =>
      claimSocialPerformance(client, context, "metrics-worker-a"),
  );
  assert.ok(first);
  const snapshot = await withSocialOperationsContext(
    makerUserId,
    "manage",
    (client, context) =>
      completeSocialPerformance(
        client,
        context,
        first,
        "metrics-worker-a",
        "test-release-1",
        {
          ok: true,
          providerReceipt: "metrics-receipt-0001",
          observedAt: new Date().toISOString(),
          metrics: {
            impressions: 1200,
            reach: 900,
            engagements: 80,
            clicks: 25,
            leads: 4,
          },
        },
        "900",
      ),
  );
  assert.equal(snapshot, "SNAPSHOT");
  assert.equal(
    (
      await admin.query(
        `SELECT count(*)::integer AS count
         FROM social_performance_snapshots
         WHERE tenant_id=$1 AND publication_intent_id=$2
           AND metrics->>'impressions'='1200'`,
        [tenantId, first.publicationId],
      )
    ).rows[0].count,
    1,
  );
  await assert.rejects(
    admin.query(
      `INSERT INTO social_performance_snapshots
         (id,tenant_id,organization_id,publication_intent_id,metrics,provider_receipt_hash,observed_at)
       VALUES ($1,$2,$3,$4,'{"impressions":-1}'::jsonb,repeat('9',64),now())`,
      [nextSocialId(), tenantId, organizationId, first.publicationId],
    ),
    /social_performance_snapshots_payload_v2_chk/i,
  );
  await admin.query(
    `UPDATE social_performance_sync_state SET next_sync_at=now()
     WHERE tenant_id=$1 AND publication_intent_id=$2 AND status='ACTIVE'`,
    [tenantId, first.publicationId],
  );
  const second = await withSocialOperationsContext(
    makerUserId,
    "manage",
    (client, context) =>
      claimSocialPerformance(client, context, "metrics-worker-a"),
  );
  assert.ok(second);
  const deadLetter = await withSocialOperationsContext(
    makerUserId,
    "manage",
    (client, context) =>
      completeSocialPerformance(
        client,
        context,
        second,
        "metrics-worker-a",
        "test-release-1",
        {
          ok: false,
          retryable: false,
          errorCode: "PROVIDER_RESPONSE_SCHEMA_INVALID",
        },
      ),
  );
  assert.equal(deadLetter, "DEAD_LETTER");
  assert.equal(
    (
      await admin.query(
        `SELECT count(*)::integer AS count
         FROM social_performance_sync_state
         WHERE tenant_id=$1 AND publication_intent_id=$2
           AND status='DEAD_LETTER' AND last_error_code='PROVIDER_RESPONSE_SCHEMA_INVALID'`,
        [tenantId, first.publicationId],
      )
    ).rows[0].count,
    1,
  );
  await assert.rejects(
    admin.query(
      "UPDATE social_performance_snapshots SET metrics='{}'::jsonb WHERE tenant_id=$1",
      [tenantId],
    ),
    /append-only/i,
  );
});
