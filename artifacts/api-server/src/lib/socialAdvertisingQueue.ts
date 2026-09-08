import crypto from "node:crypto";
import type { PoolClient } from "pg";
import {
  assertSocialAdvertisingBudget,
  nextSocialId,
  normalizeSocialErrorCode,
  normalizeSocialRuntimeId,
  socialHash,
  socialRetryDelayMs,
  socialRetryDisposition,
} from "./socialOperationsContract";
import type { SocialOperationsContext } from "./socialOperationsStore";
import type {
  SocialAdOperationJob,
  SocialAdOperationResult,
} from "./socialPublisherAdapter";

export type ClaimedSocialAdOperation = SocialAdOperationJob & {
  tenantId: string;
  organizationId: string;
  leaseToken: string;
  claimedAt: Date;
  attemptNumber: number;
  maxAttempts: number;
  previousCampaignStatus: "ACTIVE" | "PAUSED" | "APPROVED";
};

async function recoverOneExpiredLease(
  client: PoolClient,
  context: SocialOperationsContext,
): Promise<boolean> {
  const expired = await client.query<{
    id: string;
    campaign_id: string;
    operation_type: string;
    attempt_count: number;
    max_attempts: number;
    worker_id: string;
    leased_at: Date;
  }>(
    `SELECT id,campaign_id,operation_type,attempt_count,max_attempts,worker_id,leased_at
     FROM social_ad_operations
     WHERE tenant_id=$1 AND organization_id=$2 AND status='RUNNING'
       AND lease_expires_at<=now()
     ORDER BY lease_expires_at,id FOR UPDATE SKIP LOCKED LIMIT 1`,
    [context.tenantId, context.organizationId],
  );
  if (expired.rowCount !== 1) return false;
  const row = expired.rows[0];
  const exhausted = row.attempt_count >= row.max_attempts;
  const nextAttemptAt = exhausted
    ? null
    : new Date(Date.now() + socialRetryDelayMs(row.attempt_count));
  await client.query(
    `INSERT INTO social_ad_operation_attempts
       (id,tenant_id,organization_id,operation_id,attempt_number,worker_id,
        runtime_release_id,outcome,provider_request_hash,error_code,started_at,completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,'lease-recovery','LEASE_EXPIRED',$7,
       'WORKER_LEASE_EXPIRED',$8,now())`,
    [
      nextSocialId(),
      context.tenantId,
      context.organizationId,
      row.id,
      row.attempt_count,
      row.worker_id,
      socialHash({
        operationId: row.id,
        attemptNumber: row.attempt_count,
        recovery: "WORKER_LEASE_EXPIRED",
      }),
      row.leased_at,
    ],
  );
  await client.query(
    `UPDATE social_ad_operations
     SET status=$4,next_attempt_at=$5,last_error_code='WORKER_LEASE_EXPIRED',
         last_error_at=now(),lease_token_hash=NULL,leased_at=NULL,
         lease_expires_at=NULL,worker_id=NULL,updated_at=now()
     WHERE tenant_id=$1 AND organization_id=$2 AND id=$3 AND status='RUNNING'`,
    [
      context.tenantId,
      context.organizationId,
      row.id,
      exhausted ? "DEAD_LETTER" : "FAILED",
      nextAttemptAt,
    ],
  );
  if (row.operation_type === "CREATE") {
    await client.query(
      `UPDATE social_ad_campaigns
       SET status=$4,last_error_code='WORKER_LEASE_EXPIRED',updated_at=now()
       WHERE tenant_id=$1 AND organization_id=$2 AND id=$3 AND status='PROVISIONING'`,
      [
        context.tenantId,
        context.organizationId,
        row.campaign_id,
        exhausted ? "FAILED" : "APPROVED",
      ],
    );
  }
  return true;
}

function assertOperationState(
  operationType: ClaimedSocialAdOperation["operationType"],
  campaignStatus: string,
): asserts campaignStatus is ClaimedSocialAdOperation["previousCampaignStatus"] {
  const valid =
    (operationType === "CREATE" && campaignStatus === "APPROVED") ||
    (operationType === "PAUSE" && campaignStatus === "ACTIVE") ||
    (operationType === "RESUME" && campaignStatus === "PAUSED") ||
    (operationType === "UPDATE_BUDGET" &&
      ["ACTIVE", "PAUSED"].includes(campaignStatus)) ||
    (operationType === "END" && ["ACTIVE", "PAUSED"].includes(campaignStatus));
  if (!valid) throw new Error("SOCIAL_AD_CAMPAIGN_STATE_CONFLICT");
}

export async function claimSocialAdOperation(
  client: PoolClient,
  context: SocialOperationsContext,
  workerIdInput: string,
  maximumCampaignBudgetMinor: number | null,
  leaseSeconds = 120,
): Promise<ClaimedSocialAdOperation | null> {
  const workerId = normalizeSocialRuntimeId(workerIdInput);
  if (
    !Number.isSafeInteger(leaseSeconds) ||
    leaseSeconds < 30 ||
    leaseSeconds > 600
  )
    throw new Error("SOCIAL_LEASE_INVALID");
  await recoverOneExpiredLease(client, context);
  const candidate = await client.query<{
    id: string;
    campaign_id: string;
    account_id: string;
  }>(
    `SELECT operation.id,operation.campaign_id,campaign.account_id
     FROM social_ad_operations operation
     JOIN social_ad_campaigns campaign
       ON campaign.tenant_id=operation.tenant_id AND campaign.id=operation.campaign_id
     WHERE operation.tenant_id=$1 AND operation.organization_id=$2
       AND operation.status IN ('APPROVED','FAILED','QUEUED')
       AND operation.next_attempt_at<=now()
       AND NOT EXISTS (
         SELECT 1 FROM social_ad_operations running
         JOIN social_ad_campaigns running_campaign
           ON running_campaign.tenant_id=running.tenant_id AND running_campaign.id=running.campaign_id
         WHERE running.tenant_id=operation.tenant_id
           AND running.organization_id=operation.organization_id
           AND running.status='RUNNING'
           AND running_campaign.account_id=campaign.account_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM social_publication_intents publication
         WHERE publication.tenant_id=operation.tenant_id
           AND publication.organization_id=operation.organization_id
           AND publication.account_id=campaign.account_id
           AND publication.status='RUNNING'
       )
       AND NOT EXISTS (
         SELECT 1 FROM social_performance_sync_state performance
         JOIN social_publication_intents publication
           ON publication.tenant_id=performance.tenant_id
          AND publication.id=performance.publication_intent_id
         WHERE performance.tenant_id=operation.tenant_id
           AND performance.organization_id=operation.organization_id
           AND performance.status='RUNNING'
           AND publication.account_id=campaign.account_id
       )
     ORDER BY
       CASE operation.operation_type WHEN 'PAUSE' THEN 0 WHEN 'END' THEN 1 ELSE 2 END,
       operation.next_attempt_at,operation.created_at,operation.id
     FOR UPDATE OF operation SKIP LOCKED LIMIT 1`,
    [context.tenantId, context.organizationId],
  );
  if (candidate.rowCount !== 1) return null;
  const accountLock = await client.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked",
    [`social-provider-account:${candidate.rows[0].account_id}`],
  );
  if (accountLock.rows[0]?.locked !== true) return null;

  const source = await client.query<{
    operation_id: string;
    operation_type: ClaimedSocialAdOperation["operationType"];
    requested_daily_budget_minor: string | null;
    requested_lifetime_budget_minor: string | null;
    max_attempts: number;
    campaign_id: string;
    campaign_status: string;
    provider: string;
    account_key: string;
    integration_key: string | null;
    integration_enabled: boolean | null;
    integration_category: string | null;
    account_status: string;
    account_kind: string;
    account_currency: string | null;
    name: string;
    objective: string;
    destination_url: string;
    country_codes: string[];
    language_codes: string[];
    age_min: number;
    age_max: number;
    currency_code: string;
    requested_campaign_daily_budget_minor: string;
    requested_campaign_lifetime_budget_minor: string;
    provider_campaign_ref_hash: string | null;
    starts_at: string;
    ends_at: string;
    brief_status: string;
    content_kind: string;
  }>(
    `SELECT operation.id AS operation_id,operation.operation_type,
            operation.requested_daily_budget_minor,operation.requested_lifetime_budget_minor,
            operation.max_attempts,campaign.id AS campaign_id,campaign.status AS campaign_status,
            campaign.provider,account.account_key,account.integration_key,
            account.status AS account_status,account.account_kind,
            account.currency_code AS account_currency,campaign.name,campaign.objective,
            campaign.destination_url,campaign.country_codes,campaign.language_codes,
            campaign.age_min,campaign.age_max,campaign.currency_code,
            campaign.requested_daily_budget_minor AS requested_campaign_daily_budget_minor,
            campaign.requested_lifetime_budget_minor AS requested_campaign_lifetime_budget_minor,
            campaign.provider_campaign_ref_hash,campaign.starts_at,campaign.ends_at,
            integration.is_enabled AS integration_enabled,
            integration.category AS integration_category,
            brief.status AS brief_status,brief.content_kind
     FROM social_ad_operations operation
     JOIN social_ad_campaigns campaign
       ON campaign.tenant_id=operation.tenant_id AND campaign.id=operation.campaign_id
     JOIN social_accounts account
       ON account.tenant_id=campaign.tenant_id AND account.id=campaign.account_id
     JOIN social_content_briefs brief
       ON brief.tenant_id=campaign.tenant_id AND brief.id=campaign.brief_id
     LEFT JOIN integrations integration ON integration.key=account.integration_key
     WHERE operation.tenant_id=$1 AND operation.organization_id=$2 AND operation.id=$3
     FOR UPDATE OF operation,campaign,account,brief`,
    [context.tenantId, context.organizationId, candidate.rows[0].id],
  );
  if (source.rowCount !== 1) return null;
  const row = source.rows[0];
  assertOperationState(row.operation_type, row.campaign_status);
  if (
    row.account_status !== "VERIFIED" ||
    row.account_kind !== "AD_ACCOUNT" ||
    !row.integration_key ||
    row.integration_enabled !== true ||
    !["social", "social_media"].includes(
      (row.integration_category ?? "").toLowerCase(),
    ) ||
    row.account_currency !== row.currency_code ||
    row.brief_status !== "APPROVED" ||
    row.content_kind !== "AD_CREATIVE"
  )
    throw new Error("SOCIAL_AD_EXECUTION_PREFLIGHT_FAILED");
  if (
    (row.operation_type === "CREATE" && row.provider_campaign_ref_hash) ||
    (row.operation_type !== "CREATE" && !row.provider_campaign_ref_hash)
  )
    throw new Error("SOCIAL_AD_PROVIDER_CAMPAIGN_REFERENCE_INVALID");
  const dailyBudgetMinor = Number(
    row.requested_daily_budget_minor ??
      row.requested_campaign_daily_budget_minor,
  );
  const lifetimeBudgetMinor = Number(
    row.requested_lifetime_budget_minor ??
      row.requested_campaign_lifetime_budget_minor,
  );
  if (["CREATE", "UPDATE_BUDGET"].includes(row.operation_type))
    assertSocialAdvertisingBudget({
      dailyBudgetMinor,
      lifetimeBudgetMinor,
      maximumCampaignBudgetMinor,
    });

  await client.query(
    `UPDATE social_ad_operations SET status='QUEUED',updated_at=now()
     WHERE tenant_id=$1 AND organization_id=$2 AND id=$3 AND status IN ('APPROVED','FAILED')`,
    [context.tenantId, context.organizationId, row.operation_id],
  );
  const leaseToken = crypto.randomBytes(32).toString("hex");
  const leaseTokenHash = socialHash(leaseToken);
  const claimed = await client.query<{ attempt_count: number }>(
    `UPDATE social_ad_operations
     SET status='RUNNING',attempt_count=attempt_count+1,next_attempt_at=NULL,
         lease_token_hash=$4,leased_at=now(),lease_expires_at=now()+make_interval(secs=>$6),
         worker_id=$5,last_error_code=NULL,last_error_at=NULL,updated_at=now()
     WHERE tenant_id=$1 AND organization_id=$2 AND id=$3 AND status='QUEUED'
     RETURNING attempt_count`,
    [
      context.tenantId,
      context.organizationId,
      row.operation_id,
      leaseTokenHash,
      workerId,
      leaseSeconds,
    ],
  );
  if (claimed.rowCount !== 1) return null;
  if (row.operation_type === "CREATE") {
    await client.query(
      `UPDATE social_ad_campaigns SET status='PROVISIONING',updated_at=now()
       WHERE tenant_id=$1 AND organization_id=$2 AND id=$3 AND status='APPROVED'`,
      [context.tenantId, context.organizationId, row.campaign_id],
    );
  }
  return {
    operationId: row.operation_id,
    campaignId: row.campaign_id,
    operationType: row.operation_type,
    provider: row.provider,
    accountKey: row.account_key,
    integrationKey: row.integration_key,
    name: row.name,
    objective: row.objective,
    destinationUrl: row.destination_url,
    countryCodes: row.country_codes,
    languageCodes: row.language_codes,
    ageMin: row.age_min,
    ageMax: row.age_max,
    currencyCode: row.currency_code,
    dailyBudgetMinor: ["CREATE", "UPDATE_BUDGET"].includes(row.operation_type)
      ? dailyBudgetMinor
      : null,
    lifetimeBudgetMinor: ["CREATE", "UPDATE_BUDGET"].includes(
      row.operation_type,
    )
      ? lifetimeBudgetMinor
      : null,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    expectedProviderCampaignRefHash: row.provider_campaign_ref_hash,
    tenantId: context.tenantId,
    organizationId: context.organizationId,
    leaseToken,
    claimedAt: new Date(),
    attemptNumber: claimed.rows[0].attempt_count,
    maxAttempts: row.max_attempts,
    previousCampaignStatus: row.campaign_status,
  };
}

function expectedProviderState(
  operationType: ClaimedSocialAdOperation["operationType"],
  previousStatus: ClaimedSocialAdOperation["previousCampaignStatus"],
): "PAUSED" | "ACTIVE" | "COMPLETED" {
  if (operationType === "CREATE" || operationType === "PAUSE") return "PAUSED";
  if (operationType === "RESUME") return "ACTIVE";
  if (operationType === "END") return "COMPLETED";
  if (previousStatus === "APPROVED")
    throw new Error("SOCIAL_AD_CAMPAIGN_STATE_CONFLICT");
  return previousStatus;
}

export async function completeSocialAdOperation(
  client: PoolClient,
  context: SocialOperationsContext,
  claim: ClaimedSocialAdOperation,
  workerIdInput: string,
  runtimeReleaseIdInput: string,
  result: SocialAdOperationResult,
): Promise<"APPLIED" | "QUEUED" | "DEAD_LETTER"> {
  const workerId = normalizeSocialRuntimeId(workerIdInput);
  const runtimeReleaseId = normalizeSocialRuntimeId(runtimeReleaseIdInput);
  const leaseTokenHash = socialHash(claim.leaseToken);
  const locked = await client.query<{
    attempt_count: number;
    max_attempts: number;
  }>(
    `SELECT attempt_count,max_attempts FROM social_ad_operations
     WHERE tenant_id=$1 AND organization_id=$2 AND id=$3 AND status='RUNNING'
       AND worker_id=$4 AND lease_token_hash=$5 AND lease_expires_at>now() FOR UPDATE`,
    [
      context.tenantId,
      context.organizationId,
      claim.operationId,
      workerId,
      leaseTokenHash,
    ],
  );
  if (locked.rowCount !== 1) throw new Error("SOCIAL_AD_OPERATION_LEASE_LOST");
  const requestHash = socialHash({
    operationId: claim.operationId,
    campaignId: claim.campaignId,
    operationType: claim.operationType,
    provider: claim.provider,
    accountKey: claim.accountKey,
    attemptNumber: claim.attemptNumber,
  });
  const completedAt = new Date();
  const verifiedResult: SocialAdOperationResult =
    result.ok &&
    claim.operationType !== "CREATE" &&
    socialHash(result.providerCampaignRef) !==
      claim.expectedProviderCampaignRefHash
      ? {
          ok: false,
          retryable: false,
          errorCode: "SOCIAL_AD_PROVIDER_CAMPAIGN_MISMATCH",
        }
      : result;
  if (verifiedResult.ok) {
    const expectedState = expectedProviderState(
      claim.operationType,
      claim.previousCampaignStatus,
    );
    if (verifiedResult.state !== expectedState)
      throw new Error("SOCIAL_AD_PROVIDER_STATE_MISMATCH");
    const receiptHash = socialHash(verifiedResult.providerReceipt);
    const campaignRefHash = socialHash(verifiedResult.providerCampaignRef);
    await client.query(
      `INSERT INTO social_ad_operation_attempts
         (id,tenant_id,organization_id,operation_id,attempt_number,worker_id,
          runtime_release_id,outcome,provider_request_hash,provider_receipt_hash,
          provider_campaign_ref_hash,provider_state,started_at,completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'APPLIED',$8,$9,$10,$11,$12,$13)`,
      [
        nextSocialId(),
        context.tenantId,
        context.organizationId,
        claim.operationId,
        claim.attemptNumber,
        workerId,
        runtimeReleaseId,
        requestHash,
        receiptHash,
        campaignRefHash,
        verifiedResult.state,
        claim.claimedAt,
        completedAt,
      ],
    );
    await client.query(
      `UPDATE social_ad_operations
       SET status='APPLIED',provider_request_hash=$6,provider_receipt_hash=$7,
           provider_campaign_ref_hash=$8,provider_state=$9,
           lease_token_hash=NULL,leased_at=NULL,lease_expires_at=NULL,worker_id=NULL,
           updated_at=now()
       WHERE tenant_id=$1 AND organization_id=$2 AND id=$3
         AND status='RUNNING' AND worker_id=$4 AND lease_token_hash=$5`,
      [
        context.tenantId,
        context.organizationId,
        claim.operationId,
        workerId,
        leaseTokenHash,
        requestHash,
        receiptHash,
        campaignRefHash,
        verifiedResult.state,
      ],
    );
    await client.query(
      `UPDATE social_ad_campaigns
       SET status=$4,
           current_daily_budget_minor=CASE WHEN $5='UPDATE_BUDGET' THEN $6 ELSE current_daily_budget_minor END,
           current_lifetime_budget_minor=CASE WHEN $5='UPDATE_BUDGET' THEN $7 ELSE current_lifetime_budget_minor END,
           provider_campaign_ref_hash=$8,provider_receipt_hash=$9,
           last_applied_operation_id=$10,last_error_code=NULL,updated_at=now()
       WHERE tenant_id=$1 AND organization_id=$2 AND id=$3`,
      [
        context.tenantId,
        context.organizationId,
        claim.campaignId,
        verifiedResult.state,
        claim.operationType,
        claim.dailyBudgetMinor,
        claim.lifetimeBudgetMinor,
        campaignRefHash,
        receiptHash,
        claim.operationId,
      ],
    );
    return "APPLIED";
  }
  const errorCode = normalizeSocialErrorCode(verifiedResult.errorCode);
  const disposition = socialRetryDisposition({
    attemptNumber: locked.rows[0].attempt_count,
    maxAttempts: locked.rows[0].max_attempts,
    retryable: verifiedResult.retryable,
  });
  const nextAttemptAt =
    disposition === "RETRY"
      ? new Date(Date.now() + socialRetryDelayMs(claim.attemptNumber))
      : null;
  const outcome = disposition === "RETRY" ? "RETRY" : "DEAD_LETTER";
  await client.query(
    `INSERT INTO social_ad_operation_attempts
       (id,tenant_id,organization_id,operation_id,attempt_number,worker_id,
        runtime_release_id,outcome,provider_request_hash,error_code,started_at,completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      nextSocialId(),
      context.tenantId,
      context.organizationId,
      claim.operationId,
      claim.attemptNumber,
      workerId,
      runtimeReleaseId,
      outcome,
      requestHash,
      errorCode,
      claim.claimedAt,
      completedAt,
    ],
  );
  await client.query(
    `UPDATE social_ad_operations
     SET status=$6,next_attempt_at=$7,provider_request_hash=$8,
         last_error_code=$9,last_error_at=now(),lease_token_hash=NULL,
         leased_at=NULL,lease_expires_at=NULL,worker_id=NULL,updated_at=now()
     WHERE tenant_id=$1 AND organization_id=$2 AND id=$3
       AND status='RUNNING' AND worker_id=$4 AND lease_token_hash=$5`,
    [
      context.tenantId,
      context.organizationId,
      claim.operationId,
      workerId,
      leaseTokenHash,
      disposition === "RETRY" ? "QUEUED" : "DEAD_LETTER",
      nextAttemptAt,
      requestHash,
      errorCode,
    ],
  );
  if (claim.operationType === "CREATE") {
    await client.query(
      `UPDATE social_ad_campaigns
       SET status=$4,last_error_code=$5,updated_at=now()
       WHERE tenant_id=$1 AND organization_id=$2 AND id=$3 AND status='PROVISIONING'`,
      [
        context.tenantId,
        context.organizationId,
        claim.campaignId,
        disposition === "RETRY" ? "APPROVED" : "FAILED",
        errorCode,
      ],
    );
  }
  return disposition === "RETRY" ? "QUEUED" : "DEAD_LETTER";
}
