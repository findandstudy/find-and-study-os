import assert from "node:assert/strict";
import test, { after } from "node:test";
import pg from "pg";

if (process.env.ALLOW_DISPOSABLE_SOCIAL_ADVERTISING_TEST !== "true")
  throw new Error(
    "social_advertising_test_requires_explicit_disposable_opt_in",
  );

const actorUrl = process.env.DATABASE_URL;
const adminUrl = process.env.SOCIAL_AD_TEST_ADMIN_DATABASE_URL;
if (!actorUrl || !adminUrl)
  throw new Error("social_advertising_test_urls_required");
for (const raw of [actorUrl, adminUrl]) {
  const url = new URL(raw);
  if (
    !["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname) ||
    url.port !== "5433" ||
    url.pathname !== "/fasos_apply_local"
  )
    throw new Error(
      "social_advertising_test_requires_disposable_loopback_database",
    );
}
if (new URL(actorUrl).username !== "fas_social_executor")
  throw new Error("social_advertising_test_requires_exact_executor_role");

const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
assert.equal(
  (
    await admin.query(
      "SELECT count(*)::integer AS count FROM drizzle.__drizzle_migrations",
    )
  ).rows[0]?.count,
  108,
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
  "GRANT SELECT ON tenants,organizations,users,integrations TO fas_social_executor",
);
await admin.query(
  `GRANT SELECT ON social_accounts,social_content_briefs TO fas_social_executor`,
);
await admin.query(`GRANT SELECT,INSERT,UPDATE ON
  social_ad_campaigns,social_ad_operations TO fas_social_executor`);
await admin.query(`GRANT SELECT,INSERT ON
  social_ad_operation_reviews,social_ad_operation_attempts TO fas_social_executor`);

const tenantId = "0199a200-0000-7000-8000-000000000001";
const organizationId = "0199a200-0000-7000-8000-000000000002";
const otherTenantId = "0199a200-0000-7000-8000-000000000003";
const otherOrganizationId = "0199a200-0000-7000-8000-000000000004";
const accountId = "0199a200-0000-7000-8000-000000000005";
const otherAccountId = "0199a200-0000-7000-8000-000000000006";
const briefId = "0199a200-0000-7000-8000-000000000007";
const otherBriefId = "0199a200-0000-7000-8000-000000000008";
const campaignId = "0199a200-0000-7000-8000-000000000009";
const otherCampaignId = "0199a200-0000-7000-8000-00000000000a";
const createOperationId = "0199a200-0000-7000-8000-00000000000b";
const resumeOperationId = "0199a200-0000-7000-8000-00000000000c";
const budgetOperationId = "0199a200-0000-7000-8000-00000000000d";
const disabledIntegrationOperationId = "0199a200-0000-7000-8000-00000000000f";
const makerUserId = 993101;
const checkerUserId = 993102;

await admin.query(
  `INSERT INTO tenants(id,slug,legal_name,display_name,status,home_region) VALUES
   ($1,'social-ad-test','Social Ad Test','Social Ad Test','ACTIVE','eu-test'),
   ($2,'social-ad-other','Social Ad Other','Social Ad Other','ACTIVE','eu-test')`,
  [tenantId, otherTenantId],
);
await admin.query(
  `INSERT INTO organizations(id,tenant_id,legal_name,display_name,organization_type,status) VALUES
   ($1,$2,'Social Ad Test','Social Ad Test','OPERATING_ENTITY','ACTIVE'),
   ($3,$4,'Social Ad Other','Social Ad Other','OPERATING_ENTITY','ACTIVE')`,
  [organizationId, tenantId, otherOrganizationId, otherTenantId],
);
await admin.query(
  `INSERT INTO users(id,email,first_name,last_name,role,is_active,email_verified) VALUES
   ($1,'maker@social-ad.test','Social Ad','Maker','manager',true,true),
   ($2,'checker@social-ad.test','Social Ad','Checker','admin',true,true)`,
  [makerUserId, checkerUserId],
);
await admin.query(
  `INSERT INTO integrations(key,name,category,is_enabled,config)
   VALUES ('social_ad_test','Social Ad Test','social',true,'{}'::jsonb)
   ON CONFLICT (key) DO UPDATE SET is_enabled=true,category='social'`,
);
await admin.query(
  `INSERT INTO social_accounts
     (id,tenant_id,organization_id,provider,account_key,display_name,integration_key,
      external_account_ref_hash,verification_receipt_hash,verified_at,last_verification_at,
      status,account_kind,currency_code,created_by_legacy_user_id)
   VALUES
     ($1,$2,$3,'meta','meta:ad:test','Ad Account','social_ad_test',repeat('1',64),repeat('2',64),now(),now(),'VERIFIED','AD_ACCOUNT','USD',$4),
     ($5,$6,$7,'meta','meta:ad:other','Other Ad Account','social_ad_test',repeat('3',64),repeat('4',64),now(),now(),'VERIFIED','AD_ACCOUNT','USD',$4)`,
  [
    accountId,
    tenantId,
    organizationId,
    makerUserId,
    otherAccountId,
    otherTenantId,
    otherOrganizationId,
  ],
);
await admin.query(
  `INSERT INTO social_content_briefs
     (id,tenant_id,organization_id,title,objective,audience,content_kind,locales,
      channels,caption,tracking_key,status,created_by_legacy_user_id,
      reviewed_by_legacy_user_id,reviewed_at)
   VALUES
     ($1,$2,$3,'Approved ad creative','Lead generation','Prospects','AD_CREATIVE',ARRAY['en'],ARRAY['instagram'],'Apply now','fas_0199a200000070008000000000000007','APPROVED',$4,$5,now()),
     ($6,$7,$8,'Other approved ad creative','Lead generation','Prospects','AD_CREATIVE',ARRAY['en'],ARRAY['instagram'],'Apply now','fas_0199a200000070008000000000000008','APPROVED',$4,$5,now())`,
  [
    briefId,
    tenantId,
    organizationId,
    makerUserId,
    checkerUserId,
    otherBriefId,
    otherTenantId,
    otherOrganizationId,
  ],
);

const campaignValues = `
  (id,tenant_id,organization_id,account_id,brief_id,provider,name,objective,
   destination_url,country_codes,language_codes,age_min,age_max,currency_code,
   requested_daily_budget_minor,requested_lifetime_budget_minor,
   current_daily_budget_minor,current_lifetime_budget_minor,starts_at,ends_at,
   status,definition_sha256,created_by_legacy_user_id,approved_by_legacy_user_id,approved_at)`;
await admin.query(
  `INSERT INTO social_ad_campaigns ${campaignValues} VALUES
   ($1,$2,$3,$4,$5,'meta','Safe test campaign','LEADS','https://findandstudy.com/apply',ARRAY['TR'],ARRAY['en'],18,55,'USD',1000,10000,1000,10000,now(),now()+interval '30 days','APPROVED',repeat('a',64),$6,$7,now()),
   ($8,$9,$10,$11,$12,'meta','Other campaign','LEADS','https://findandstudy.com/apply',ARRAY['GB'],ARRAY['en'],18,55,'USD',1000,10000,1000,10000,now(),now()+interval '30 days','APPROVED',repeat('b',64),$6,$7,now())`,
  [
    campaignId,
    tenantId,
    organizationId,
    accountId,
    briefId,
    makerUserId,
    checkerUserId,
    otherCampaignId,
    otherTenantId,
    otherOrganizationId,
    otherAccountId,
    otherBriefId,
  ],
);
await admin.query(
  `INSERT INTO social_ad_operations
     (id,tenant_id,organization_id,campaign_id,operation_type,
      requested_daily_budget_minor,requested_lifetime_budget_minor,status,
      request_key,payload_sha256,max_attempts,next_attempt_at,
      created_by_legacy_user_id,approved_by_legacy_user_id,approved_at)
   VALUES ($1,$2,$3,$4,'CREATE',1000,10000,'APPROVED','social-ad-create-test',repeat('c',64),3,now(),$5,$6,now())`,
  [
    createOperationId,
    tenantId,
    organizationId,
    campaignId,
    makerUserId,
    checkerUserId,
  ],
);

process.env.NODE_ENV = "test";
process.env.SOCIAL_OPERATIONS_V1_MODE = "manage";
process.env.SOCIAL_OPERATIONS_TENANT_ID = tenantId;
process.env.SOCIAL_OPERATIONS_ORGANIZATION_ID = organizationId;

const { withSocialOperationsContext } =
  await import("../src/lib/socialOperationsStore");
const { claimSocialAdOperation, completeSocialAdOperation } =
  await import("../src/lib/socialAdvertisingQueue");

after(async () => {
  await admin.query(
    "UPDATE social_ad_campaigns SET last_applied_operation_id=NULL WHERE tenant_id=ANY($1::uuid[])",
    [[tenantId, otherTenantId]],
  );
  for (const table of [
    "social_ad_operation_attempts",
    "social_ad_operation_reviews",
    "social_ad_operations",
    "social_ad_campaigns",
    "social_content_reviews",
    "social_content_briefs",
    "social_account_verifications",
    "social_accounts",
  ]) {
    await admin.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
    try {
      await admin.query(
        `DELETE FROM ${table} WHERE tenant_id=ANY($1::uuid[])`,
        [[tenantId, otherTenantId]],
      );
    } finally {
      await admin.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
    }
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
  await admin.query("DELETE FROM integrations WHERE key='social_ad_test'");
  const { pool } = await import("@workspace/db");
  await pool.end();
  await admin.end();
});

test("advertising tables enforce maker-checker and tenant RLS", async () => {
  await assert.rejects(
    admin.query(
      `INSERT INTO social_ad_operations
         (id,tenant_id,organization_id,campaign_id,operation_type,status,request_key,
          payload_sha256,max_attempts,next_attempt_at,created_by_legacy_user_id,
          approved_by_legacy_user_id,approved_at)
       VALUES ('0199a200-0000-7000-8000-00000000000e',$1,$2,$3,'PAUSE','APPROVED',
         'social-ad-bad-checker',repeat('d',64),3,now(),$4,$4,now())`,
      [tenantId, organizationId, campaignId, makerUserId],
    ),
    /social_ad_operations_approval_chk/i,
  );

  const visible = await withSocialOperationsContext(
    makerUserId,
    "read",
    async (client) =>
      client.query("SELECT id FROM social_ad_campaigns ORDER BY id"),
  );
  assert.deepEqual(
    visible.rows.map((row) => row.id),
    [campaignId],
  );
});

test("CREATE provisions PAUSED and requires a separate approved RESUME to spend", async () => {
  const createClaim = await withSocialOperationsContext(
    makerUserId,
    "manage",
    (client, context) =>
      claimSocialAdOperation(client, context, "social-ad-worker", 100_000),
  );
  assert.ok(createClaim);
  assert.equal(createClaim.operationType, "CREATE");

  const created = await withSocialOperationsContext(
    makerUserId,
    "manage",
    (client, context) =>
      completeSocialAdOperation(
        client,
        context,
        createClaim,
        "social-ad-worker",
        "social-ad-test-release",
        {
          ok: true,
          providerReceipt: "provider-ad-receipt-create",
          providerCampaignRef: "provider-ad-campaign-42",
          state: "PAUSED",
        },
      ),
  );
  assert.equal(created, "APPLIED");
  const paused = await admin.query(
    `SELECT status,provider_campaign_ref_hash,provider_receipt_hash
     FROM social_ad_campaigns WHERE tenant_id=$1 AND id=$2`,
    [tenantId, campaignId],
  );
  assert.equal(paused.rows[0]?.status, "PAUSED");
  assert.match(paused.rows[0]?.provider_campaign_ref_hash, /^[0-9a-f]{64}$/);
  assert.match(paused.rows[0]?.provider_receipt_hash, /^[0-9a-f]{64}$/);

  await admin.query(
    `INSERT INTO social_ad_operations
       (id,tenant_id,organization_id,campaign_id,operation_type,status,request_key,
        payload_sha256,max_attempts,next_attempt_at,created_by_legacy_user_id,
        approved_by_legacy_user_id,approved_at)
     VALUES ($1,$2,$3,$4,'RESUME','APPROVED','social-ad-resume-test',repeat('e',64),3,now(),$5,$6,now())`,
    [
      resumeOperationId,
      tenantId,
      organizationId,
      campaignId,
      makerUserId,
      checkerUserId,
    ],
  );
  const resumeClaim = await withSocialOperationsContext(
    makerUserId,
    "manage",
    (client, context) =>
      claimSocialAdOperation(client, context, "social-ad-worker", 100_000),
  );
  assert.ok(resumeClaim);
  assert.equal(resumeClaim.operationType, "RESUME");
  const resumed = await withSocialOperationsContext(
    makerUserId,
    "manage",
    (client, context) =>
      completeSocialAdOperation(
        client,
        context,
        resumeClaim,
        "social-ad-worker",
        "social-ad-test-release",
        {
          ok: true,
          providerReceipt: "provider-ad-receipt-resume",
          providerCampaignRef: "provider-ad-campaign-42",
          state: "ACTIVE",
        },
      ),
  );
  assert.equal(resumed, "APPLIED");
  assert.equal(
    (
      await admin.query(
        "SELECT status FROM social_ad_campaigns WHERE tenant_id=$1 AND id=$2",
        [tenantId, campaignId],
      )
    ).rows[0]?.status,
    "ACTIVE",
  );
});

test("execution-time budget gate fails closed without mutating the operation", async () => {
  await admin.query(
    `INSERT INTO social_ad_operations
       (id,tenant_id,organization_id,campaign_id,operation_type,
        requested_daily_budget_minor,requested_lifetime_budget_minor,status,
        request_key,payload_sha256,max_attempts,next_attempt_at,
        created_by_legacy_user_id,approved_by_legacy_user_id,approved_at)
     VALUES ($1,$2,$3,$4,'UPDATE_BUDGET',2000,20000,'APPROVED',
       'social-ad-budget-test',repeat('f',64),3,now(),$5,$6,now())`,
    [
      budgetOperationId,
      tenantId,
      organizationId,
      campaignId,
      makerUserId,
      checkerUserId,
    ],
  );
  await assert.rejects(
    withSocialOperationsContext(makerUserId, "manage", (client, context) =>
      claimSocialAdOperation(client, context, "social-ad-worker", 1_000),
    ),
    /SOCIAL_AD_BUDGET_LIMIT_EXCEEDED/,
  );
  const state = await admin.query(
    `SELECT status,attempt_count,lease_token_hash
     FROM social_ad_operations WHERE tenant_id=$1 AND id=$2`,
    [tenantId, budgetOperationId],
  );
  assert.deepEqual(state.rows[0], {
    status: "APPROVED",
    attempt_count: 0,
    lease_token_hash: null,
  });
});

test("provider campaign identity is checked before accepting an external result", async () => {
  const claim = await withSocialOperationsContext(
    makerUserId,
    "manage",
    (client, context) =>
      claimSocialAdOperation(client, context, "social-ad-worker", 100_000),
  );
  assert.ok(claim);
  const completed = await withSocialOperationsContext(
    makerUserId,
    "manage",
    (client, context) =>
      completeSocialAdOperation(
        client,
        context,
        claim,
        "social-ad-worker",
        "social-ad-test-release",
        {
          ok: true,
          providerReceipt: "provider-ad-receipt-wrong-target",
          providerCampaignRef: "provider-ad-campaign-wrong",
          state: "ACTIVE",
        },
      ),
  );
  assert.equal(completed, "DEAD_LETTER");
  const state = await admin.query(
    `SELECT operation.status,operation.last_error_code,campaign.status AS campaign_status
     FROM social_ad_operations operation
     JOIN social_ad_campaigns campaign ON campaign.id=operation.campaign_id
     WHERE operation.tenant_id=$1 AND operation.id=$2`,
    [tenantId, budgetOperationId],
  );
  assert.deepEqual(state.rows[0], {
    status: "DEAD_LETTER",
    last_error_code: "SOCIAL_AD_PROVIDER_CAMPAIGN_MISMATCH",
    campaign_status: "ACTIVE",
  });
});

test("disabled provider integration is rechecked before a worker claims work", async () => {
  await admin.query(
    `INSERT INTO social_ad_operations
       (id,tenant_id,organization_id,campaign_id,operation_type,status,request_key,
        payload_sha256,max_attempts,next_attempt_at,created_by_legacy_user_id,
        approved_by_legacy_user_id,approved_at)
     VALUES ($1,$2,$3,$4,'PAUSE','APPROVED','social-ad-disabled-integration',repeat('b',64),
       3,now(),$5,$6,now())`,
    [
      disabledIntegrationOperationId,
      tenantId,
      organizationId,
      campaignId,
      makerUserId,
      checkerUserId,
    ],
  );
  await admin.query(
    "UPDATE integrations SET is_enabled=false WHERE key='social_ad_test'",
  );
  try {
    await assert.rejects(
      withSocialOperationsContext(makerUserId, "manage", (client, context) =>
        claimSocialAdOperation(client, context, "social-ad-worker", 100_000),
      ),
      /SOCIAL_AD_EXECUTION_PREFLIGHT_FAILED/,
    );
  } finally {
    await admin.query(
      "UPDATE integrations SET is_enabled=true WHERE key='social_ad_test'",
    );
  }
  const state = await admin.query(
    `SELECT status,attempt_count FROM social_ad_operations
     WHERE tenant_id=$1 AND id=$2`,
    [tenantId, disabledIntegrationOperationId],
  );
  assert.deepEqual(state.rows[0], { status: "APPROVED", attempt_count: 0 });
});

test("advertising execution evidence is append-only", async () => {
  const attempts = await admin.query(
    `SELECT count(*)::integer AS count FROM social_ad_operation_attempts
     WHERE tenant_id=$1`,
    [tenantId],
  );
  assert.equal(attempts.rows[0]?.count, 3);
  await assert.rejects(
    admin.query(
      `UPDATE social_ad_operation_attempts SET provider_state='COMPLETED'
       WHERE tenant_id=$1`,
      [tenantId],
    ),
    /append-only/i,
  );
});
