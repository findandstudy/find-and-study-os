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
  107,
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
  `GRANT SELECT ON tenants,organizations,users,integrations TO fas_social_executor`,
);
await admin.query(`GRANT SELECT,INSERT,UPDATE ON
  social_accounts,social_content_briefs,social_publication_intents,
  social_performance_sync_state,social_worker_heartbeats,
  social_creative_requests TO fas_social_executor`);
await admin.query(`GRANT SELECT,INSERT ON
  social_media_assets,
  social_content_reviews,social_publication_reviews,social_publication_attempts,
  social_operation_receipts,social_performance_snapshots,
  social_account_verifications,social_performance_attempts,
  social_creative_attempts TO fas_social_executor`);
await admin.query(`GRANT SELECT ON
  social_attributed_leads,social_attributed_applications TO fas_social_executor`);

const tenantId = "0199a100-0000-7000-8000-000000000001";
const organizationId = "0199a100-0000-7000-8000-000000000002";
const otherTenantId = "0199a100-0000-7000-8000-000000000003";
const otherOrganizationId = "0199a100-0000-7000-8000-000000000004";
const makerUserId = 992101;
const checkerUserId = 992102;
const accountId = "0199a100-0000-7000-8000-000000000005";
const accountBId = "0199a100-0000-7000-8000-000000000009";
const briefId = "0199a100-0000-7000-8000-000000000006";
const secondBriefId = "0199a100-0000-7000-8000-00000000000c";
const intentA = "0199a100-0000-7000-8000-000000000007";
const intentB = "0199a100-0000-7000-8000-000000000008";
const expiredIntent = "0199a100-0000-7000-8000-00000000000a";
const mediaAssetId = "0199a100-0000-7000-8000-00000000000b";
const draftBriefId = "0199a100-0000-7000-8000-00000000000d";
const creativeRequestA = "0199a100-0000-7000-8000-00000000000e";
const creativeRequestB = "0199a100-0000-7000-8000-00000000000f";
const creativeRequestC = "0199a100-0000-7000-8000-000000000010";
const trackingKey = `fas_${briefId.replaceAll("-", "")}`;
const secondTrackingKey = `fas_${secondBriefId.replaceAll("-", "")}`;
const draftTrackingKey = `fas_${draftBriefId.replaceAll("-", "")}`;
const attributedLeadId = 992103;
const attributedStudentId = 992104;
const attributedApplicationId = 992105;

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
  `INSERT INTO integrations(key,name,category,is_enabled,config)
   VALUES ('social_creative_test','Social Creative Test','AI',true,'{}'::jsonb)
   ON CONFLICT (key) DO NOTHING`,
);
await admin.query(
  `INSERT INTO social_content_briefs
     (id,tenant_id,organization_id,title,objective,audience,content_kind,locales,channels,caption,tracking_key,status,created_by_legacy_user_id,reviewed_by_legacy_user_id,reviewed_at)
   VALUES
     ($1,$2,$3,'Approved test','Safety','Test','POST',ARRAY['tr'],ARRAY['instagram'],'Test copy',$4,'APPROVED',$5,$6,now()),
     ($7,$2,$3,'Second approved test','Safety','Test','POST',ARRAY['tr'],ARRAY['instagram'],'Second copy',$8,'APPROVED',$5,$6,now()),
     ($9,$2,$3,'Creative draft','Safety','Test','POST',ARRAY['tr'],ARRAY['instagram'],'Draft copy',$10,'DRAFT',$5,NULL,NULL)`,
  [
    briefId,
    tenantId,
    organizationId,
    trackingKey,
    makerUserId,
    checkerUserId,
    secondBriefId,
    secondTrackingKey,
    draftBriefId,
    draftTrackingKey,
  ],
);
await admin.query(
  `INSERT INTO social_creative_requests
     (id,tenant_id,organization_id,brief_id,output_kind,provider,integration_key,
      locale,prompt,max_cost_minor,currency_code,status,request_key,max_attempts,
      created_by_legacy_user_id)
   VALUES
     ($1,$2,$3,$4,'CAPTION','openai','social_creative_test','tr','Caption A',100,'USD',
      'PENDING_APPROVAL','social-creative-request-a',3,$5),
     ($6,$2,$3,$4,'CAPTION','openai','social_creative_test','tr','Caption B',100,'USD',
      'PENDING_APPROVAL','social-creative-request-b',3,$5),
     ($7,$2,$3,$4,'CAPTION','runway','social_creative_test','tr','Caption C',100,'USD',
      'PENDING_APPROVAL','social-creative-request-c',1,$5)`,
  [
    creativeRequestA,
    tenantId,
    organizationId,
    draftBriefId,
    makerUserId,
    creativeRequestB,
    creativeRequestC,
  ],
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
const { claimSocialCreative, completeSocialCreative } =
  await import("../src/lib/socialCreativeQueue");
const {
  createSocialWorkerHeartbeatState,
  isSocialWorkerHeartbeatDue,
  recordSocialWorkerHeartbeat,
  scheduleNextSocialWorkerHeartbeat,
} = await import("../src/lib/socialWorkerRuntime");

after(async () => {
  const tables = [
    "social_creative_attempts",
    "social_creative_requests",
    "social_attributed_applications",
    "social_attributed_leads",
    "social_worker_heartbeats",
    "social_media_assets",
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
  await admin.query("DELETE FROM applications WHERE id=$1", [
    attributedApplicationId,
  ]);
  await admin.query("DELETE FROM leads WHERE id=$1", [attributedLeadId]);
  await admin.query("DELETE FROM students WHERE id=$1", [attributedStudentId]);
  await admin.query("DELETE FROM integrations WHERE key='social_creative_test'");
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
  assert.equal(result.rowCount, 21);
  assert.equal(
    result.rows.every(
      (row) => row.relforcerowsecurity === true && row.delete_policies === 0,
    ),
    true,
  );
});

test("worker heartbeats are release-bound, throttled and tenant-isolated", async () => {
  const state = createSocialWorkerHeartbeatState({
    workerKind: "publication",
    workerId: "social-worker-heartbeat-a",
    runtimeReleaseId: "test-release-1",
    observedAt: new Date("2090-01-01T00:00:00.000Z"),
  });
  const firstObservedAt = new Date("2090-01-01T00:00:00.000Z");
  const first = isSocialWorkerHeartbeatDue(state, firstObservedAt);
  await withSocialOperationsContext(makerUserId, "manage", (client, context) =>
    recordSocialWorkerHeartbeat(client, context, state, firstObservedAt),
  );
  scheduleNextSocialWorkerHeartbeat(state, "30", firstObservedAt);
  const throttled = isSocialWorkerHeartbeatDue(
    state,
    new Date("2090-01-01T00:00:10.000Z"),
  );
  const refreshedObservedAt = new Date("2090-01-01T00:00:31.000Z");
  const refreshed = isSocialWorkerHeartbeatDue(state, refreshedObservedAt);
  await withSocialOperationsContext(makerUserId, "manage", (client, context) =>
    recordSocialWorkerHeartbeat(client, context, state, refreshedObservedAt),
  );
  scheduleNextSocialWorkerHeartbeat(state, "30", refreshedObservedAt);
  assert.equal(first, true);
  assert.equal(throttled, false);
  assert.equal(refreshed, true);
  const stored = await admin.query(
    `SELECT runtime_release_id,last_seen_at
     FROM social_worker_heartbeats
     WHERE tenant_id=$1 AND organization_id=$2 AND worker_kind='publication'
       AND worker_id='social-worker-heartbeat-a'`,
    [tenantId, organizationId],
  );
  assert.equal(stored.rowCount, 1);
  assert.equal(stored.rows[0].runtime_release_id, "test-release-1");
  assert.equal(
    new Date(stored.rows[0].last_seen_at).toISOString(),
    "2090-01-01T00:00:31.000Z",
  );
  const actor = new pg.Client({ connectionString: actorUrl });
  await actor.connect();
  try {
    await actor.query("BEGIN");
    await actor.query("SELECT set_config('app.tenant_id',$1,true)", [
      otherTenantId,
    ]);
    await actor.query("SELECT set_config('app.organization_id',$1,true)", [
      otherOrganizationId,
    ]);
    assert.equal(
      (
        await actor.query(
          "SELECT count(*)::integer AS count FROM social_worker_heartbeats",
        )
      ).rows[0].count,
      0,
    );
  } finally {
    await actor.query("ROLLBACK").catch(() => undefined);
    await actor.end();
  }
});

test("media assets are immutable, content-addressed and tenant-isolated", async () => {
  const objectPath = `/objects/social-media/assets/${tenantId}/${organizationId}/${"f".repeat(64)}.mp4`;
  await withSocialOperationsContext(makerUserId, "manage", (client, context) =>
    client.query(
      `INSERT INTO social_media_assets
         (id,tenant_id,organization_id,object_path,content_sha256,media_kind,
          mime_type,size_bytes,original_file_name,created_by_legacy_user_id)
       VALUES ($1,$2,$3,$4,$5,'video','video/mp4',1024,'campaign.mp4',$6)`,
      [
        mediaAssetId,
        context.tenantId,
        context.organizationId,
        objectPath,
        "f".repeat(64),
        makerUserId,
      ],
    ),
  );
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
          "SELECT count(*)::integer AS count FROM social_media_assets",
        )
      ).rows[0].count,
      1,
    );
    await actor.query("ROLLBACK");
    await actor.query("BEGIN");
    await actor.query("SELECT set_config('app.tenant_id',$1,true)", [
      otherTenantId,
    ]);
    await actor.query("SELECT set_config('app.organization_id',$1,true)", [
      otherOrganizationId,
    ]);
    assert.equal(
      (
        await actor.query(
          "SELECT count(*)::integer AS count FROM social_media_assets",
        )
      ).rows[0].count,
      0,
    );
  } finally {
    await actor.query("ROLLBACK").catch(() => undefined);
    await actor.end();
  }
  await assert.rejects(
    admin.query(
      "UPDATE social_media_assets SET original_file_name='tampered.mp4' WHERE tenant_id=$1 AND id=$2",
      [tenantId, mediaAssetId],
    ),
    /social media assets are immutable/,
  );
});

test("tracking-key triggers project CRM outcomes without exposing legacy tables", async () => {
  await admin.query(
    `INSERT INTO students(id,first_name,last_name,status,season)
     VALUES ($1,'Attributed','Student','active','2026')`,
    [attributedStudentId],
  );
  await admin.query(
    `INSERT INTO leads
       (id,first_name,last_name,status,season,utm_content,created_at,updated_at)
     VALUES ($1,'Attributed','Lead','new','2026',$2,now(),now())`,
    [attributedLeadId, trackingKey],
  );
  await admin.query(
    `INSERT INTO applications(id,student_id,lead_id,stage,season,created_at,updated_at)
     VALUES ($1,$2,$3,'inquiry','2026',now(),now())`,
    [attributedApplicationId, attributedStudentId, attributedLeadId],
  );
  await admin.query(
    "UPDATE leads SET status='qualified',converted_student_id=$2 WHERE id=$1",
    [attributedLeadId, attributedStudentId],
  );
  await admin.query(
    "UPDATE applications SET stage='submitted' WHERE id=$1",
    [attributedApplicationId],
  );
  await admin.query(
    "UPDATE leads SET utm_content=$2,status='won' WHERE id=$1",
    [attributedLeadId, secondTrackingKey],
  );

  const projected = await admin.query(
    `SELECT lead.brief_id,lead.lead_status,lead.converted_student_id,app.application_stage
     FROM social_attributed_leads lead
     JOIN social_attributed_applications app
       ON app.tenant_id=lead.tenant_id AND app.lead_id=lead.lead_id
     WHERE lead.tenant_id=$1 AND lead.lead_id=$2`,
    [tenantId, attributedLeadId],
  );
  assert.equal(projected.rowCount, 1);
  assert.deepEqual(projected.rows[0], {
    brief_id: briefId,
    lead_status: "won",
    converted_student_id: attributedStudentId,
    application_stage: "submitted",
  });

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
          "SELECT count(*)::integer AS count FROM social_attributed_leads",
        )
      ).rows[0].count,
      1,
    );
    await actor.query("ROLLBACK");
    await actor.query("BEGIN");
    await actor.query("SELECT set_config('app.tenant_id',$1,true)", [
      otherTenantId,
    ]);
    await actor.query("SELECT set_config('app.organization_id',$1,true)", [
      otherOrganizationId,
    ]);
    assert.equal(
      (
        await actor.query(
          "SELECT count(*)::integer AS count FROM social_attributed_leads",
        )
      ).rows[0].count,
      0,
    );
    await assert.rejects(
      actor.query(
        `INSERT INTO social_attributed_leads
           (tenant_id,organization_id,brief_id,tracking_key,lead_id,lead_status,first_touch_at)
         VALUES ($1,$2,$3,$4,$5,'forged',now())`,
        [tenantId, organizationId, briefId, trackingKey, attributedLeadId + 1],
      ),
      /permission denied|row-level security/i,
    );
  } finally {
    await actor.query("ROLLBACK").catch(() => undefined);
    await actor.end();
  }
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

test("creative requests enforce maker-checker, isolate provider lanes and safely apply output", async () => {
  await assert.rejects(
    admin.query(
      `UPDATE social_creative_requests
       SET status='APPROVED'
       WHERE tenant_id=$1 AND id=$2`,
      [tenantId, creativeRequestA],
    ),
    /social_creative_requests_approval_chk/i,
  );
  await admin.query(
    `UPDATE social_creative_requests
     SET status='APPROVED',approved_by_legacy_user_id=$2,approved_at=now(),
         next_attempt_at=now()
     WHERE tenant_id=$1 AND id=ANY($3::uuid[])`,
    [
      tenantId,
      checkerUserId,
      [creativeRequestA, creativeRequestB, creativeRequestC],
    ],
  );
  await assert.rejects(
    admin.query(
      `UPDATE social_creative_requests SET max_cost_minor=101
       WHERE tenant_id=$1 AND id=$2`,
      [tenantId, creativeRequestA],
    ),
    /social creative request definition is immutable/i,
  );

  const first = await withSocialOperationsContext(
    makerUserId,
    "manage",
    (client, context) =>
      claimSocialCreative(client, context, "creative-worker-a"),
  );
  assert.equal(
    first ? [creativeRequestA, creativeRequestB].includes(first.id) : false,
    true,
  );
  const otherLane = await withSocialOperationsContext(
    makerUserId,
    "manage",
    (client, context) =>
      claimSocialCreative(client, context, "creative-worker-b"),
  );
  assert.equal(otherLane?.id, creativeRequestC);
  const saturated = await withSocialOperationsContext(
    makerUserId,
    "manage",
    (client, context) =>
      claimSocialCreative(client, context, "creative-worker-c"),
  );
  assert.equal(saturated, null);
  if (!first || !otherLane) throw new Error("creative claims missing");

  const pending = await withSocialOperationsContext(
    makerUserId,
    "manage",
    (client, context) =>
      completeSocialCreative(
        client,
        context,
        first,
        "creative-worker-a",
        "test-release-creative",
        {
          ok: true,
          state: "PENDING",
          providerReceipt: "creative-pending-receipt-0001",
          providerJobRef: "provider-job-creative-0001",
          resolvedModel: "model-v1",
          usage: { inputUnits: 10, outputUnits: 0 },
        },
      ),
  );
  assert.equal(pending, "QUEUED");
  const deadLetter = await withSocialOperationsContext(
    makerUserId,
    "manage",
    (client, context) =>
      completeSocialCreative(
        client,
        context,
        otherLane,
        "creative-worker-b",
        "test-release-creative",
        {
          ok: false,
          retryable: false,
          errorCode: "PROVIDER_RESPONSE_SCHEMA_INVALID",
        },
      ),
  );
  assert.equal(deadLetter, "DEAD_LETTER");

  await admin.query(
    `UPDATE social_creative_requests SET next_attempt_at=now()
     WHERE tenant_id=$1 AND id=$2 AND status='QUEUED'`,
    [tenantId, first.id],
  );
  const poll = await withSocialOperationsContext(
    makerUserId,
    "manage",
    (client, context) =>
      claimSocialCreative(client, context, "creative-worker-a"),
  );
  assert.equal(poll?.id, first.id);
  assert.equal(poll?.providerJobRef, "provider-job-creative-0001");
  if (!poll) throw new Error("creative poll claim missing");
  await assert.rejects(
    admin.query(
      `UPDATE social_creative_requests
       SET status='GENERATED',provider_receipt_hash=repeat('a',64),
           result_caption='unmetered result',usage='{"inputUnits":1}'::jsonb,
           lease_token_hash=NULL,leased_at=NULL,lease_expires_at=NULL,worker_id=NULL
       WHERE tenant_id=$1 AND id=$2`,
      [tenantId, poll.id],
    ),
    /social_creative_requests_result_chk/i,
  );
  const generated = await withSocialOperationsContext(
    makerUserId,
    "manage",
    (client, context) =>
      completeSocialCreative(
        client,
        context,
        poll,
        "creative-worker-a",
        "test-release-creative",
        {
          ok: true,
          state: "COMPLETED",
          providerReceipt: "creative-completed-receipt-0001",
          resolvedModel: "model-v1",
          usage: {
            inputUnits: 10,
            outputUnits: 12,
            estimatedCostMinor: 3,
            currencyCode: "USD",
          },
          output: { kind: "CAPTION", text: "Generated safe caption" },
        },
      ),
  );
  assert.equal(generated, "GENERATED");

  const state = await admin.query(
    `SELECT request.status,request.attempt_count,request.failure_count,
            request.result_caption,request.applied_at,request.provider_job_ref_hash,
            brief.caption,brief.version
     FROM social_creative_requests request
     JOIN social_content_briefs brief
       ON brief.tenant_id=request.tenant_id AND brief.id=request.brief_id
     WHERE request.tenant_id=$1 AND request.id=$2`,
    [tenantId, first.id],
  );
  assert.deepEqual(
    {
      status: state.rows[0].status,
      attempts: state.rows[0].attempt_count,
      failures: state.rows[0].failure_count,
      result: state.rows[0].result_caption,
      applied: Boolean(state.rows[0].applied_at),
      jobRefHashed: Boolean(state.rows[0].provider_job_ref_hash),
      caption: state.rows[0].caption,
      briefVersion: Number(state.rows[0].version),
    },
    {
      status: "GENERATED",
      attempts: 2,
      failures: 0,
      result: "Generated safe caption",
      applied: true,
      jobRefHashed: true,
      caption: "Generated safe caption",
      briefVersion: 2,
    },
  );
  assert.equal(
    (
      await admin.query(
        `SELECT count(*)::integer AS count FROM social_creative_attempts
         WHERE tenant_id=$1 AND creative_request_id=$2`,
        [tenantId, first.id],
      )
    ).rows[0].count,
    2,
  );
  await assert.rejects(
    admin.query(
      `UPDATE social_creative_attempts SET outcome='DEAD_LETTER'
       WHERE tenant_id=$1 AND creative_request_id=$2`,
      [tenantId, first.id],
    ),
    /append-only/i,
  );
  await admin.query(
    "UPDATE integrations SET is_enabled=false WHERE key='social_creative_test'",
  );
  assert.equal(
    await withSocialOperationsContext(
      makerUserId,
      "manage",
      (client, context) =>
        claimSocialCreative(client, context, "creative-worker-disabled"),
    ),
    null,
  );

  const actor = new pg.Client({ connectionString: actorUrl });
  await actor.connect();
  try {
    await actor.query("BEGIN");
    await actor.query("SELECT set_config('app.tenant_id',$1,true)", [
      otherTenantId,
    ]);
    await actor.query("SELECT set_config('app.organization_id',$1,true)", [
      otherOrganizationId,
    ]);
    assert.equal(
      (
        await actor.query(
          "SELECT count(*)::integer AS count FROM social_creative_requests",
        )
      ).rows[0].count,
      0,
    );
  } finally {
    await actor.query("ROLLBACK").catch(() => undefined);
    await actor.end();
  }
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
