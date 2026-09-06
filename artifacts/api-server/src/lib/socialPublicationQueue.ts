import crypto from "node:crypto";
import type { PoolClient } from "pg";
import {
  nextSocialId,
  normalizeSocialErrorCode,
  normalizeSocialRuntimeId,
  socialHash,
  socialRetryDelayMs,
  socialRetryDisposition,
} from "./socialOperationsContract";
import type { SocialOperationsContext } from "./socialOperationsStore";
import type {
  SocialPublicationJob,
  SocialPublisherResult,
} from "./socialPublisherAdapter";

export type ClaimedSocialPublication = SocialPublicationJob & {
  tenantId: string;
  organizationId: string;
  leaseToken: string;
  claimedAt: Date;
  attemptNumber: number;
  maxAttempts: number;
};

async function recoverOneExpiredLease(
  client: PoolClient,
  context: SocialOperationsContext,
): Promise<boolean> {
  const expired = await client.query<{
    id: string;
    attempt_count: number;
    max_attempts: number;
    worker_id: string;
    leased_at: Date;
  }>(
    `SELECT id,attempt_count,max_attempts,worker_id,leased_at
     FROM social_publication_intents
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
    `INSERT INTO social_publication_attempts
       (id,tenant_id,organization_id,publication_intent_id,attempt_number,worker_id,
        runtime_release_id,outcome,provider_request_hash,error_code,started_at,completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,'lease-recovery','FAILED',$7,
       'WORKER_LEASE_EXPIRED',$8,now())`,
    [
      nextSocialId(),
      context.tenantId,
      context.organizationId,
      row.id,
      row.attempt_count,
      row.worker_id,
      socialHash({
        publicationId: row.id,
        attemptNumber: row.attempt_count,
        recovery: "WORKER_LEASE_EXPIRED",
      }),
      row.leased_at,
    ],
  );
  await client.query(
    `UPDATE social_publication_intents
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
  return true;
}

export async function claimSocialPublication(
  client: PoolClient,
  context: SocialOperationsContext,
  workerIdInput: string,
  leaseSeconds = 120,
): Promise<ClaimedSocialPublication | null> {
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
    status: string;
    account_id: string;
  }>(
    `SELECT intent.id,intent.status,intent.account_id
     FROM social_publication_intents intent
     WHERE intent.tenant_id=$1 AND intent.organization_id=$2
       AND intent.status IN ('APPROVED','FAILED','QUEUED')
       AND intent.next_attempt_at <= now()
       AND NOT EXISTS (
         SELECT 1 FROM social_publication_intents running
         WHERE running.tenant_id=intent.tenant_id
           AND running.organization_id=intent.organization_id
           AND running.account_id=intent.account_id AND running.status='RUNNING'
       )
       AND NOT EXISTS (
         SELECT 1
         FROM social_performance_sync_state performance_state
         JOIN social_publication_intents performance_intent
           ON performance_intent.tenant_id=performance_state.tenant_id
          AND performance_intent.id=performance_state.publication_intent_id
         WHERE performance_state.tenant_id=intent.tenant_id
           AND performance_state.organization_id=intent.organization_id
           AND performance_state.status='RUNNING'
           AND performance_intent.account_id=intent.account_id
       )
     ORDER BY intent.next_attempt_at,intent.created_at,intent.id
     FOR UPDATE SKIP LOCKED LIMIT 1`,
    [context.tenantId, context.organizationId],
  );
  if (candidate.rowCount !== 1) return null;
  const accountLock = await client.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked",
    [`social-provider-account:${candidate.rows[0].account_id}`],
  );
  if (accountLock.rows[0]?.locked !== true) return null;
  if (candidate.rows[0].status !== "QUEUED") {
    await client.query(
      `UPDATE social_publication_intents SET status='QUEUED',updated_at=now()
       WHERE tenant_id=$1 AND organization_id=$2 AND id=$3`,
      [context.tenantId, context.organizationId, candidate.rows[0].id],
    );
  }
  const leaseToken = crypto.randomBytes(32).toString("hex");
  const leaseTokenHash = socialHash(leaseToken);
  const claimed = await client.query<{
    id: string;
    tenant_id: string;
    organization_id: string;
    provider: string;
    account_key: string;
    integration_key: string | null;
    title: string;
    caption: string | null;
    content_kind: string;
    locales: string[];
    channels: string[];
    media_refs: SocialPublicationJob["mediaRefs"];
    utm: Record<string, string>;
    tracking_key: string;
    scheduled_for: string;
    attempt_count: number;
    max_attempts: number;
  }>(
    `WITH changed AS (
       UPDATE social_publication_intents intent
       SET status='RUNNING',attempt_count=intent.attempt_count+1,next_attempt_at=NULL,
           lease_token_hash=$3,leased_at=now(),lease_expires_at=now()+make_interval(secs=>$5),
           worker_id=$4,updated_at=now()
       WHERE intent.tenant_id=$1 AND intent.organization_id=$2 AND intent.id=$6
         AND intent.status='QUEUED'
       RETURNING intent.*
     )
     SELECT changed.id,changed.tenant_id,changed.organization_id,account.provider,
            account.account_key,account.integration_key,brief.title,brief.caption,
            brief.content_kind,brief.locales,brief.channels,brief.media_refs,brief.utm,
            brief.tracking_key,
            changed.scheduled_for,changed.attempt_count,changed.max_attempts
     FROM changed
     JOIN social_accounts account ON account.tenant_id=changed.tenant_id AND account.id=changed.account_id
     JOIN social_content_briefs brief ON brief.tenant_id=changed.tenant_id AND brief.id=changed.brief_id`,
    [
      context.tenantId,
      context.organizationId,
      leaseTokenHash,
      workerId,
      leaseSeconds,
      candidate.rows[0].id,
    ],
  );
  if (claimed.rowCount !== 1) return null;
  const row = claimed.rows[0];
  if (!row.integration_key)
    throw new Error("SOCIAL_ACCOUNT_INTEGRATION_MISSING");
  return {
    id: row.id,
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    provider: row.provider,
    accountKey: row.account_key,
    integrationKey: row.integration_key,
    title: row.title,
    caption: row.caption ?? "",
    contentKind: row.content_kind,
    locales: row.locales,
    channels: row.channels,
    mediaRefs: row.media_refs,
    utm: { ...row.utm, content: row.tracking_key },
    scheduledFor: row.scheduled_for,
    leaseToken,
    claimedAt: new Date(),
    attemptNumber: row.attempt_count,
    maxAttempts: row.max_attempts,
  };
}

export async function completeSocialPublication(
  client: PoolClient,
  context: SocialOperationsContext,
  claim: ClaimedSocialPublication,
  workerIdInput: string,
  runtimeReleaseIdInput: string,
  result: SocialPublisherResult,
): Promise<"PUBLISHED" | "QUEUED" | "DEAD_LETTER"> {
  const workerId = normalizeSocialRuntimeId(workerIdInput);
  const runtimeReleaseId = normalizeSocialRuntimeId(runtimeReleaseIdInput);
  const leaseTokenHash = socialHash(claim.leaseToken);
  const startedAt = claim.claimedAt;
  const requestHash = socialHash({
    publicationId: claim.id,
    provider: claim.provider,
    accountKey: claim.accountKey,
    attemptNumber: claim.attemptNumber,
  });
  const locked = await client.query<{
    status: string;
    attempt_count: number;
    max_attempts: number;
  }>(
    `SELECT status,attempt_count,max_attempts FROM social_publication_intents
     WHERE tenant_id=$1 AND organization_id=$2 AND id=$3 AND status='RUNNING'
       AND worker_id=$4 AND lease_token_hash=$5 AND lease_expires_at>now() FOR UPDATE`,
    [
      context.tenantId,
      context.organizationId,
      claim.id,
      workerId,
      leaseTokenHash,
    ],
  );
  if (locked.rowCount !== 1) throw new Error("SOCIAL_PUBLICATION_LEASE_LOST");
  const completedAt = new Date();
  if (result.ok) {
    const receiptHash = socialHash(result.providerReceipt);
    const postRefHash = socialHash(result.providerPostRef);
    await client.query(
      `INSERT INTO social_publication_attempts
         (id,tenant_id,organization_id,publication_intent_id,attempt_number,worker_id,runtime_release_id,outcome,provider_request_hash,provider_receipt_hash,provider_post_ref_hash,started_at,completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'PUBLISHED',$8,$9,$10,$11,$12)`,
      [
        nextSocialId(),
        context.tenantId,
        context.organizationId,
        claim.id,
        claim.attemptNumber,
        workerId,
        runtimeReleaseId,
        requestHash,
        receiptHash,
        postRefHash,
        startedAt,
        completedAt,
      ],
    );
    await client.query(
      `UPDATE social_publication_intents SET status='PUBLISHED',provider_job_ref_hash=$6,
         execution_receipt_hash=$7,provider_post_ref_hash=$8,published_at=now(),
         lease_token_hash=NULL,leased_at=NULL,lease_expires_at=NULL,worker_id=NULL,updated_at=now()
       WHERE tenant_id=$1 AND organization_id=$2 AND id=$3 AND status='RUNNING' AND worker_id=$4 AND lease_token_hash=$5`,
      [
        context.tenantId,
        context.organizationId,
        claim.id,
        workerId,
        leaseTokenHash,
        requestHash,
        receiptHash,
        postRefHash,
      ],
    );
    await client.query(
      `INSERT INTO social_performance_sync_state
         (tenant_id,organization_id,publication_intent_id,status,next_sync_at)
       VALUES ($1,$2,$3,'PENDING',now())
       ON CONFLICT (tenant_id,publication_intent_id) DO NOTHING`,
      [context.tenantId, context.organizationId, claim.id],
    );
    return "PUBLISHED";
  }
  const errorCode = normalizeSocialErrorCode(result.errorCode);
  const disposition = socialRetryDisposition({
    attemptNumber: locked.rows[0].attempt_count,
    maxAttempts: locked.rows[0].max_attempts,
    retryable: result.retryable,
  });
  const nextAttemptAt =
    disposition === "RETRY"
      ? new Date(Date.now() + socialRetryDelayMs(claim.attemptNumber))
      : null;
  const outcome = disposition === "RETRY" ? "RETRY" : "DEAD_LETTER";
  await client.query(
    `INSERT INTO social_publication_attempts
       (id,tenant_id,organization_id,publication_intent_id,attempt_number,worker_id,runtime_release_id,outcome,provider_request_hash,error_code,started_at,completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      nextSocialId(),
      context.tenantId,
      context.organizationId,
      claim.id,
      claim.attemptNumber,
      workerId,
      runtimeReleaseId,
      outcome,
      requestHash,
      errorCode,
      startedAt,
      completedAt,
    ],
  );
  await client.query(
    `UPDATE social_publication_intents SET status=$6,next_attempt_at=$7,last_error_code=$8,last_error_at=now(),
       lease_token_hash=NULL,leased_at=NULL,lease_expires_at=NULL,worker_id=NULL,updated_at=now()
     WHERE tenant_id=$1 AND organization_id=$2 AND id=$3 AND status='RUNNING' AND worker_id=$4 AND lease_token_hash=$5`,
    [
      context.tenantId,
      context.organizationId,
      claim.id,
      workerId,
      leaseTokenHash,
      disposition === "RETRY" ? "QUEUED" : "DEAD_LETTER",
      nextAttemptAt,
      errorCode,
    ],
  );
  return disposition === "RETRY" ? "QUEUED" : "DEAD_LETTER";
}
