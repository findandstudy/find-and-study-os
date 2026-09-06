import crypto from "node:crypto";
import type { PoolClient } from "pg";
import {
  nextSocialId,
  normalizeSocialErrorCode,
  normalizeSocialRuntimeId,
  socialHash,
  socialPerformanceCadenceMs,
  socialPerformanceMaxAgeDays,
  socialRetryDelayMs,
} from "./socialOperationsContract";
import type { SocialOperationsContext } from "./socialOperationsStore";
import type {
  SocialPerformanceResult,
  SocialMetrics,
} from "./socialPublisherAdapter";

export type ClaimedSocialPerformance = {
  tenantId: string;
  organizationId: string;
  publicationId: string;
  provider: string;
  accountKey: string;
  integrationKey: string;
  leaseToken: string;
  claimedAt: Date;
  attemptNumber: number;
  maximumConsecutiveFailures: number;
  publishedAt: Date;
};

async function parkOneExpiredPerformanceSync(
  client: PoolClient,
  context: SocialOperationsContext,
  maximumAgeDays: number,
): Promise<boolean> {
  const parked = await client.query(
    `WITH candidate AS (
       SELECT state.tenant_id,state.publication_intent_id
       FROM social_performance_sync_state state
       JOIN social_publication_intents intent
         ON intent.tenant_id=state.tenant_id AND intent.id=state.publication_intent_id
       WHERE state.tenant_id=$1 AND state.organization_id=$2
         AND state.status IN ('PENDING','ACTIVE')
         AND intent.published_at < now()-make_interval(days=>$3)
       ORDER BY intent.published_at,state.publication_intent_id
       FOR UPDATE OF state SKIP LOCKED LIMIT 1
     )
     UPDATE social_performance_sync_state state
     SET status='PAUSED',next_sync_at=NULL,updated_at=now()
     FROM candidate
     WHERE state.tenant_id=candidate.tenant_id
       AND state.publication_intent_id=candidate.publication_intent_id`,
    [context.tenantId, context.organizationId, maximumAgeDays],
  );
  return (parked.rowCount ?? 0) > 0;
}

async function recoverOneExpiredLease(
  client: PoolClient,
  context: SocialOperationsContext,
): Promise<boolean> {
  const expired = await client.query<{
    publication_intent_id: string;
    total_attempt_count: string;
    consecutive_failure_count: number;
    maximum_consecutive_failures: number;
    worker_id: string;
    leased_at: Date;
  }>(
    `SELECT publication_intent_id,total_attempt_count,consecutive_failure_count,
            maximum_consecutive_failures,worker_id,leased_at
     FROM social_performance_sync_state
     WHERE tenant_id=$1 AND organization_id=$2 AND status='RUNNING'
       AND lease_expires_at<=now()
     ORDER BY lease_expires_at,publication_intent_id
     FOR UPDATE SKIP LOCKED LIMIT 1`,
    [context.tenantId, context.organizationId],
  );
  if (expired.rowCount !== 1) return false;
  const row = expired.rows[0];
  const failureCount = row.consecutive_failure_count + 1;
  const exhausted = failureCount >= row.maximum_consecutive_failures;
  const attemptNumber = Number(row.total_attempt_count);
  await client.query(
    `INSERT INTO social_performance_attempts
       (id,tenant_id,organization_id,publication_intent_id,attempt_number,worker_id,
        runtime_release_id,outcome,provider_request_hash,error_code,started_at,completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,'lease-recovery','LEASE_EXPIRED',$7,
       'PERFORMANCE_WORKER_LEASE_EXPIRED',$8,now())`,
    [
      nextSocialId(),
      context.tenantId,
      context.organizationId,
      row.publication_intent_id,
      attemptNumber,
      row.worker_id,
      socialHash({
        publicationId: row.publication_intent_id,
        attemptNumber,
        recovery: "PERFORMANCE_WORKER_LEASE_EXPIRED",
      }),
      row.leased_at,
    ],
  );
  await client.query(
    `UPDATE social_performance_sync_state
     SET status=$4,next_sync_at=$5,consecutive_failure_count=$6,
         last_error_code='PERFORMANCE_WORKER_LEASE_EXPIRED',last_error_at=now(),
         lease_token_hash=NULL,leased_at=NULL,lease_expires_at=NULL,worker_id=NULL,
         updated_at=now()
     WHERE tenant_id=$1 AND organization_id=$2 AND publication_intent_id=$3
       AND status='RUNNING'`,
    [
      context.tenantId,
      context.organizationId,
      row.publication_intent_id,
      exhausted ? "DEAD_LETTER" : "ACTIVE",
      exhausted
        ? null
        : new Date(Date.now() + socialRetryDelayMs(Math.min(failureCount, 12))),
      failureCount,
    ],
  );
  return true;
}

export async function claimSocialPerformance(
  client: PoolClient,
  context: SocialOperationsContext,
  workerIdInput: string,
  leaseSeconds = 120,
  maximumAgeDays = socialPerformanceMaxAgeDays(
    process.env.SOCIAL_PERFORMANCE_MAX_PUBLICATION_AGE_DAYS,
  ),
): Promise<ClaimedSocialPerformance | null> {
  const workerId = normalizeSocialRuntimeId(workerIdInput);
  if (
    !Number.isSafeInteger(leaseSeconds) ||
    leaseSeconds < 30 ||
    leaseSeconds > 600
  )
    throw new Error("SOCIAL_PERFORMANCE_LEASE_INVALID");
  if (
    !Number.isSafeInteger(maximumAgeDays) ||
    maximumAgeDays < 1 ||
    maximumAgeDays > 730
  )
    throw new Error("SOCIAL_PERFORMANCE_MAX_AGE_INVALID");
  await parkOneExpiredPerformanceSync(client, context, maximumAgeDays);
  await recoverOneExpiredLease(client, context);
  const candidate = await client.query<{
    publication_intent_id: string;
    account_id: string;
  }>(
    `SELECT state.publication_intent_id,intent.account_id
     FROM social_performance_sync_state state
     JOIN social_publication_intents intent
       ON intent.tenant_id=state.tenant_id AND intent.id=state.publication_intent_id
     JOIN social_accounts account
       ON account.tenant_id=intent.tenant_id AND account.id=intent.account_id
     WHERE state.tenant_id=$1 AND state.organization_id=$2
       AND state.status IN ('PENDING','ACTIVE') AND state.next_sync_at<=now()
       AND intent.status='PUBLISHED' AND account.status='VERIFIED'
       AND intent.published_at>=now()-make_interval(days=>$3)
       AND NOT EXISTS (
         SELECT 1
         FROM social_performance_sync_state running_state
         JOIN social_publication_intents running_intent
           ON running_intent.tenant_id=running_state.tenant_id
          AND running_intent.id=running_state.publication_intent_id
         WHERE running_state.tenant_id=state.tenant_id
           AND running_state.organization_id=state.organization_id
           AND running_state.status='RUNNING'
           AND running_intent.account_id=intent.account_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM social_publication_intents running_publication
         WHERE running_publication.tenant_id=state.tenant_id
           AND running_publication.organization_id=state.organization_id
           AND running_publication.account_id=intent.account_id
           AND running_publication.status='RUNNING'
       )
     ORDER BY state.next_sync_at,state.publication_intent_id
     FOR UPDATE OF state SKIP LOCKED LIMIT 1`,
    [context.tenantId, context.organizationId, maximumAgeDays],
  );
  if (candidate.rowCount !== 1) return null;
  const accountLock = await client.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked",
    [`social-provider-account:${candidate.rows[0].account_id}`],
  );
  if (accountLock.rows[0]?.locked !== true) return null;
  const leaseToken = crypto.randomBytes(32).toString("hex");
  const claimed = await client.query<{
    publication_intent_id: string;
    tenant_id: string;
    organization_id: string;
    total_attempt_count: string;
    maximum_consecutive_failures: number;
    provider: string;
    account_key: string;
    integration_key: string | null;
    published_at: Date;
  }>(
    `WITH changed AS (
       UPDATE social_performance_sync_state state
       SET status='RUNNING',next_sync_at=NULL,
           total_attempt_count=state.total_attempt_count+1,
           lease_token_hash=$3,leased_at=now(),
           lease_expires_at=now()+make_interval(secs=>$5),worker_id=$4,updated_at=now()
       WHERE state.tenant_id=$1 AND state.organization_id=$2
         AND state.publication_intent_id=$6 AND state.status IN ('PENDING','ACTIVE')
       RETURNING state.*
     )
     SELECT changed.publication_intent_id,changed.tenant_id,changed.organization_id,
            changed.total_attempt_count,changed.maximum_consecutive_failures,
            account.provider,account.account_key,account.integration_key,
            intent.published_at
     FROM changed
     JOIN social_publication_intents intent
       ON intent.tenant_id=changed.tenant_id AND intent.id=changed.publication_intent_id
     JOIN social_accounts account
       ON account.tenant_id=intent.tenant_id AND account.id=intent.account_id
     WHERE intent.status='PUBLISHED' AND account.status='VERIFIED'`,
    [
      context.tenantId,
      context.organizationId,
      socialHash(leaseToken),
      workerId,
      leaseSeconds,
      candidate.rows[0].publication_intent_id,
    ],
  );
  if (claimed.rowCount !== 1) return null;
  const row = claimed.rows[0];
  if (!row.integration_key)
    throw new Error("SOCIAL_ACCOUNT_INTEGRATION_MISSING");
  return {
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    publicationId: row.publication_intent_id,
    provider: row.provider,
    accountKey: row.account_key,
    integrationKey: row.integration_key,
    leaseToken,
    claimedAt: new Date(),
    attemptNumber: Number(row.total_attempt_count),
    maximumConsecutiveFailures: row.maximum_consecutive_failures,
    publishedAt: row.published_at,
  };
}

export function socialPerformanceIdempotencyKey(
  claim: Pick<ClaimedSocialPerformance, "publicationId" | "attemptNumber">,
): string {
  return `performance:${claim.publicationId}:${claim.attemptNumber}`;
}

export async function completeSocialPerformance(
  client: PoolClient,
  context: SocialOperationsContext,
  claim: ClaimedSocialPerformance,
  workerIdInput: string,
  runtimeReleaseIdInput: string,
  result: SocialPerformanceResult,
  intervalSeconds = process.env.SOCIAL_PERFORMANCE_SYNC_INTERVAL_SECONDS,
): Promise<"SNAPSHOT" | "RETRY" | "DEAD_LETTER"> {
  const workerId = normalizeSocialRuntimeId(workerIdInput);
  const runtimeReleaseId = normalizeSocialRuntimeId(runtimeReleaseIdInput);
  const locked = await client.query<{
    consecutive_failure_count: number;
    maximum_consecutive_failures: number;
  }>(
    `SELECT consecutive_failure_count,maximum_consecutive_failures
     FROM social_performance_sync_state
     WHERE tenant_id=$1 AND organization_id=$2 AND publication_intent_id=$3
       AND status='RUNNING' AND worker_id=$4 AND lease_token_hash=$5
       AND lease_expires_at>now() FOR UPDATE`,
    [
      context.tenantId,
      context.organizationId,
      claim.publicationId,
      workerId,
      socialHash(claim.leaseToken),
    ],
  );
  if (locked.rowCount !== 1) throw new Error("SOCIAL_PERFORMANCE_LEASE_LOST");
  const completedAt = new Date();
  const requestHash = socialHash({
    publicationId: claim.publicationId,
    provider: claim.provider,
    accountKey: claim.accountKey,
    attemptNumber: claim.attemptNumber,
  });
  if (result.ok) {
    const receiptHash = socialHash(result.providerReceipt);
    await client.query(
      `INSERT INTO social_performance_snapshots
         (id,tenant_id,organization_id,publication_intent_id,metrics,provider_receipt_hash,observed_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)
       ON CONFLICT (tenant_id,publication_intent_id,provider_receipt_hash) DO NOTHING`,
      [
        nextSocialId(),
        context.tenantId,
        context.organizationId,
        claim.publicationId,
        JSON.stringify(result.metrics satisfies SocialMetrics),
        receiptHash,
        result.observedAt,
      ],
    );
    await client.query(
      `INSERT INTO social_performance_attempts
         (id,tenant_id,organization_id,publication_intent_id,attempt_number,worker_id,
          runtime_release_id,outcome,provider_request_hash,provider_receipt_hash,started_at,completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'SNAPSHOT',$8,$9,$10,$11)`,
      [
        nextSocialId(),
        context.tenantId,
        context.organizationId,
        claim.publicationId,
        claim.attemptNumber,
        workerId,
        runtimeReleaseId,
        requestHash,
        receiptHash,
        claim.claimedAt,
        completedAt,
      ],
    );
    await client.query(
      `UPDATE social_performance_sync_state
       SET status='ACTIVE',next_sync_at=$6,consecutive_failure_count=0,
           lease_token_hash=NULL,leased_at=NULL,lease_expires_at=NULL,worker_id=NULL,
           last_error_code=NULL,last_error_at=NULL,last_success_at=now(),updated_at=now()
       WHERE tenant_id=$1 AND organization_id=$2 AND publication_intent_id=$3
         AND status='RUNNING' AND worker_id=$4 AND lease_token_hash=$5`,
      [
        context.tenantId,
        context.organizationId,
        claim.publicationId,
        workerId,
        socialHash(claim.leaseToken),
        new Date(
          Date.now() +
            socialPerformanceCadenceMs({
              baseIntervalSeconds: intervalSeconds,
              publicationAgeMs: Math.max(
                0,
                Date.now() - claim.publishedAt.getTime(),
              ),
            }),
        ),
      ],
    );
    return "SNAPSHOT";
  }
  const errorCode = normalizeSocialErrorCode(result.errorCode);
  const failureCount = locked.rows[0].consecutive_failure_count + 1;
  const retry =
    result.retryable &&
    failureCount < locked.rows[0].maximum_consecutive_failures;
  await client.query(
    `INSERT INTO social_performance_attempts
       (id,tenant_id,organization_id,publication_intent_id,attempt_number,worker_id,
        runtime_release_id,outcome,provider_request_hash,error_code,started_at,completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      nextSocialId(),
      context.tenantId,
      context.organizationId,
      claim.publicationId,
      claim.attemptNumber,
      workerId,
      runtimeReleaseId,
      retry ? "RETRY" : "DEAD_LETTER",
      requestHash,
      errorCode,
      claim.claimedAt,
      completedAt,
    ],
  );
  await client.query(
    `UPDATE social_performance_sync_state
     SET status=$6,next_sync_at=$7,consecutive_failure_count=$8,
         lease_token_hash=NULL,leased_at=NULL,lease_expires_at=NULL,worker_id=NULL,
         last_error_code=$9,last_error_at=now(),updated_at=now()
     WHERE tenant_id=$1 AND organization_id=$2 AND publication_intent_id=$3
       AND status='RUNNING' AND worker_id=$4 AND lease_token_hash=$5`,
    [
      context.tenantId,
      context.organizationId,
      claim.publicationId,
      workerId,
      socialHash(claim.leaseToken),
      retry ? "ACTIVE" : "DEAD_LETTER",
      retry
        ? new Date(Date.now() + socialRetryDelayMs(Math.min(failureCount, 12)))
        : null,
      failureCount,
      errorCode,
    ],
  );
  return retry ? "RETRY" : "DEAD_LETTER";
}
