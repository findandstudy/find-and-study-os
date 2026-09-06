import crypto from "node:crypto";
import type { PoolClient } from "pg";
import {
  assertSocialCreativeOutputCompatible,
  nextSocialId,
  normalizeSocialErrorCode,
  normalizeSocialRuntimeId,
  socialHash,
  socialRetryDelayMs,
} from "./socialOperationsContract";
import type { SocialOperationsContext } from "./socialOperationsStore";
import type {
  SocialCreativeJob,
  SocialCreativeResult,
  SocialCreativeUsage,
} from "./socialCreativeAdapter";
import {
  assertSocialContentMedia,
  validateSocialMediaBuffer,
  type SocialMediaRef,
} from "./socialMediaAssets";
import { ObjectStorageService } from "./objectStorage";

export type ClaimedSocialCreative = SocialCreativeJob & {
  tenantId: string;
  organizationId: string;
  briefId: string;
  createdByLegacyUserId: number;
  leaseToken: string;
  claimedAt: Date;
  failureCount: number;
  maxAttempts: number;
};

type MaterializedSocialCreativeResult =
  | Exclude<SocialCreativeResult, { ok: true; state: "COMPLETED" }>
  | {
      ok: true;
      state: "COMPLETED";
      providerReceipt: string;
      resolvedModel: string | null;
      usage: SocialCreativeUsage | null;
      output:
        | { kind: "CAPTION"; text: string }
        | {
            kind: "IMAGE" | "VIDEO";
            objectPath: string;
            fileName: string;
            mimeType: string;
            sha256: string;
            sizeBytes: number;
          };
    };

export async function materializeSocialCreativeResult(
  claim: ClaimedSocialCreative,
  result: SocialCreativeResult,
  storage = new ObjectStorageService(),
): Promise<MaterializedSocialCreativeResult> {
  if (!result.ok || result.state !== "COMPLETED") return result;
  if (result.output.kind === "CAPTION")
    return {
      ok: true,
      state: "COMPLETED",
      providerReceipt: result.providerReceipt,
      resolvedModel: result.resolvedModel,
      usage: result.usage,
      output: { kind: "CAPTION", text: result.output.text },
    };
  const verified = await validateSocialMediaBuffer({
    fileName: result.output.fileName,
    mimeType: result.output.mimeType,
    buffer: result.output.buffer,
  });
  if (verified.sha256 !== result.output.sha256)
    throw new Error("SOCIAL_CREATIVE_ASSET_HASH_MISMATCH");
  const objectPath = await storage.uploadContentAddressedBuffer({
    subdir: `social-media/assets/${claim.tenantId}/${claim.organizationId}`,
    contentSha256: verified.sha256,
    buffer: result.output.buffer,
    contentType: verified.mimeType,
    extension: verified.permanentExtension,
  });
  return {
    ok: true,
    state: "COMPLETED",
    providerReceipt: result.providerReceipt,
    resolvedModel: result.resolvedModel,
    usage: result.usage,
    output: {
      kind: result.output.kind,
      objectPath,
      fileName: result.output.fileName,
      mimeType: verified.mimeType,
      sha256: verified.sha256,
      sizeBytes: verified.sizeBytes,
    },
  };
}

async function recoverOneExpiredLease(
  client: PoolClient,
  context: SocialOperationsContext,
): Promise<void> {
  const expired = await client.query<{
    id: string;
    attempt_count: number;
    failure_count: number;
    max_attempts: number;
    worker_id: string;
    leased_at: Date;
  }>(
    `SELECT id,attempt_count,failure_count,max_attempts,worker_id,leased_at
     FROM social_creative_requests
     WHERE tenant_id=$1 AND organization_id=$2 AND status='RUNNING'
       AND lease_expires_at<=now()
     ORDER BY lease_expires_at,id FOR UPDATE SKIP LOCKED LIMIT 1`,
    [context.tenantId, context.organizationId],
  );
  if (expired.rowCount !== 1) return;
  const row = expired.rows[0];
  const failureCount = row.failure_count + 1;
  const exhausted =
    failureCount >= row.max_attempts || row.attempt_count >= 120;
  const nextAttemptAt = exhausted
    ? null
    : new Date(Date.now() + socialRetryDelayMs(failureCount));
  await client.query(
    `INSERT INTO social_creative_attempts
       (id,tenant_id,organization_id,creative_request_id,attempt_number,worker_id,
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
      socialHash({ requestId: row.id, recovery: "WORKER_LEASE_EXPIRED" }),
      row.leased_at,
    ],
  );
  await client.query(
    `UPDATE social_creative_requests
     SET status=$4,failure_count=$5,next_attempt_at=$6,
         last_error_code='WORKER_LEASE_EXPIRED',last_error_at=now(),
         lease_token_hash=NULL,leased_at=NULL,lease_expires_at=NULL,worker_id=NULL,
         updated_at=now()
     WHERE tenant_id=$1 AND organization_id=$2 AND id=$3 AND status='RUNNING'`,
    [
      context.tenantId,
      context.organizationId,
      row.id,
      exhausted ? "DEAD_LETTER" : "QUEUED",
      failureCount,
      nextAttemptAt,
    ],
  );
}

export async function claimSocialCreative(
  client: PoolClient,
  context: SocialOperationsContext,
  workerIdInput: string,
  leaseSeconds = 120,
): Promise<ClaimedSocialCreative | null> {
  const workerId = normalizeSocialRuntimeId(workerIdInput);
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 60 || leaseSeconds > 600)
    throw new Error("SOCIAL_CREATIVE_LEASE_INVALID");
  await recoverOneExpiredLease(client, context);
  const candidate = await client.query<{
    id: string;
    status: string;
    provider: string;
    integration_key: string;
  }>(
    `SELECT request.id,request.status,request.provider,request.integration_key
     FROM social_creative_requests request
     WHERE request.tenant_id=$1 AND request.organization_id=$2
       AND request.status IN ('APPROVED','QUEUED')
       AND COALESCE(request.next_attempt_at,now())<=now()
       AND EXISTS (
         SELECT 1 FROM integrations integration
         WHERE integration.key=request.integration_key
           AND integration.is_enabled=true
           AND (
             lower(integration.category)='ai'
             OR integration.key IN ('openai','claude','anthropic','runway')
             OR integration.key LIKE 'claude:%'
             OR integration.key LIKE 'anthropic:%'
           )
       )
       AND NOT EXISTS (
         SELECT 1 FROM social_creative_requests running
         WHERE running.tenant_id=request.tenant_id
           AND running.organization_id=request.organization_id
           AND running.provider=request.provider
           AND running.integration_key=request.integration_key
           AND running.status='RUNNING'
       )
     ORDER BY (request.provider_job_ref IS NULL),
       COALESCE(request.next_attempt_at,request.created_at),request.created_at,request.id
     FOR UPDATE SKIP LOCKED LIMIT 1`,
    [context.tenantId, context.organizationId],
  );
  if (candidate.rowCount !== 1) return null;
  const lane = `${context.tenantId}:${context.organizationId}:${candidate.rows[0].provider}:${candidate.rows[0].integration_key}`;
  const advisory = await client.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked",
    [`social-creative-provider:${lane}`],
  );
  if (advisory.rows[0]?.locked !== true) return null;
  if (candidate.rows[0].status === "APPROVED")
    await client.query(
      `UPDATE social_creative_requests SET status='QUEUED',next_attempt_at=now(),updated_at=now()
       WHERE tenant_id=$1 AND organization_id=$2 AND id=$3 AND status='APPROVED'`,
      [context.tenantId, context.organizationId, candidate.rows[0].id],
    );
  const leaseToken = crypto.randomBytes(32).toString("hex");
  const leaseTokenHash = socialHash(leaseToken);
  const claimed = await client.query<{
    id: string;
    tenant_id: string;
    organization_id: string;
    brief_id: string;
    output_kind: "CAPTION" | "IMAGE" | "VIDEO";
    provider: string;
    integration_key: string;
    model: string | null;
    locale: string;
    prompt: string;
    negative_prompt: string | null;
    aspect_ratio: "1:1" | "4:5" | "9:16" | "16:9" | null;
    duration_seconds: number | null;
    max_cost_minor: number;
    currency_code: string;
    provider_job_ref: string | null;
    attempt_count: number;
    failure_count: number;
    max_attempts: number;
    created_by_legacy_user_id: number;
  }>(
    `UPDATE social_creative_requests
     SET status='RUNNING',attempt_count=attempt_count+1,next_attempt_at=NULL,
         lease_token_hash=$4,leased_at=now(),lease_expires_at=now()+make_interval(secs=>$6),
         worker_id=$5,updated_at=now()
     WHERE tenant_id=$1 AND organization_id=$2 AND id=$3 AND status='QUEUED'
     RETURNING id,tenant_id,organization_id,brief_id,output_kind,provider,integration_key,
       model,locale,prompt,negative_prompt,aspect_ratio,duration_seconds,
       max_cost_minor,currency_code,provider_job_ref,
       attempt_count,failure_count,max_attempts,created_by_legacy_user_id`,
    [
      context.tenantId,
      context.organizationId,
      candidate.rows[0].id,
      leaseTokenHash,
      workerId,
      leaseSeconds,
    ],
  );
  if (claimed.rowCount !== 1) return null;
  const row = claimed.rows[0];
  return {
    id: row.id,
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    briefId: row.brief_id,
    createdByLegacyUserId: row.created_by_legacy_user_id,
    provider: row.provider,
    integrationKey: row.integration_key,
    outputKind: row.output_kind,
    model: row.model,
    locale: row.locale,
    prompt: row.prompt,
    negativePrompt: row.negative_prompt,
    aspectRatio: row.aspect_ratio,
    durationSeconds: row.duration_seconds,
    maxCostMinor: row.max_cost_minor,
    currencyCode: row.currency_code,
    providerJobRef: row.provider_job_ref,
    leaseToken,
    claimedAt: new Date(),
    attemptNumber: row.attempt_count,
    failureCount: row.failure_count,
    maxAttempts: row.max_attempts,
  };
}

export async function completeSocialCreative(
  client: PoolClient,
  context: SocialOperationsContext,
  claim: ClaimedSocialCreative,
  workerIdInput: string,
  runtimeReleaseIdInput: string,
  result: MaterializedSocialCreativeResult,
): Promise<"QUEUED" | "GENERATED" | "DEAD_LETTER"> {
  const workerId = normalizeSocialRuntimeId(workerIdInput);
  const runtimeReleaseId = normalizeSocialRuntimeId(runtimeReleaseIdInput);
  const leaseTokenHash = socialHash(claim.leaseToken);
  const requestHash = socialHash({
    requestId: claim.id,
    provider: claim.provider,
    integrationKey: claim.integrationKey,
    outputKind: claim.outputKind,
    model: claim.model,
    locale: claim.locale,
    prompt: claim.prompt,
    negativePrompt: claim.negativePrompt,
    aspectRatio: claim.aspectRatio,
    durationSeconds: claim.durationSeconds,
    maxCostMinor: claim.maxCostMinor,
    currencyCode: claim.currencyCode,
    providerJobRef: claim.providerJobRef,
    attemptNumber: claim.attemptNumber,
  });
  const locked = await client.query<{
    attempt_count: number;
    failure_count: number;
    max_attempts: number;
    brief_id: string;
    created_by_legacy_user_id: number;
  }>(
    `SELECT attempt_count,failure_count,max_attempts,brief_id,created_by_legacy_user_id
     FROM social_creative_requests
     WHERE tenant_id=$1 AND organization_id=$2 AND id=$3 AND status='RUNNING'
       AND worker_id=$4 AND lease_token_hash=$5 AND lease_expires_at>now() FOR UPDATE`,
    [context.tenantId, context.organizationId, claim.id, workerId, leaseTokenHash],
  );
  if (locked.rowCount !== 1) throw new Error("SOCIAL_CREATIVE_LEASE_LOST");
  const completedAt = new Date();
  if (result.ok && result.state === "PENDING") {
    const pollLimitReached = locked.rows[0].attempt_count >= 120;
    const receiptHash = socialHash(result.providerReceipt);
    const jobRefHash = socialHash(result.providerJobRef);
    await client.query(
      `INSERT INTO social_creative_attempts
         (id,tenant_id,organization_id,creative_request_id,attempt_number,worker_id,
          runtime_release_id,outcome,provider_request_hash,provider_receipt_hash,
          resolved_model,usage,error_code,started_at,completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15)`,
      [
        nextSocialId(), context.tenantId, context.organizationId, claim.id,
        claim.attemptNumber, workerId, runtimeReleaseId,
        pollLimitReached ? "DEAD_LETTER" : "PENDING", requestHash, receiptHash,
        result.resolvedModel, JSON.stringify(result.usage),
        pollLimitReached ? "PROVIDER_JOB_POLL_LIMIT" : null,
        claim.claimedAt, completedAt,
      ],
    );
    await client.query(
      `UPDATE social_creative_requests
       SET status=$6,provider_request_hash=$7,provider_job_ref=$8,
           provider_job_ref_hash=$9,provider_receipt_hash=$10,resolved_model=$11,
           usage=$12::jsonb,next_attempt_at=$13,last_error_code=$14,
           last_error_at=CASE WHEN $14::text IS NULL THEN NULL ELSE now() END,
           lease_token_hash=NULL,leased_at=NULL,lease_expires_at=NULL,worker_id=NULL,
           updated_at=now()
       WHERE tenant_id=$1 AND organization_id=$2 AND id=$3
         AND status='RUNNING' AND worker_id=$4 AND lease_token_hash=$5`,
      [
        context.tenantId, context.organizationId, claim.id, workerId, leaseTokenHash,
        pollLimitReached ? "DEAD_LETTER" : "QUEUED", requestHash,
        result.providerJobRef, jobRefHash, receiptHash, result.resolvedModel,
        JSON.stringify(result.usage),
        pollLimitReached ? null : new Date(Date.now() + 30_000),
        pollLimitReached ? "PROVIDER_JOB_POLL_LIMIT" : null,
      ],
    );
    return pollLimitReached ? "DEAD_LETTER" : "QUEUED";
  }

  if (result.ok) {
    const receiptHash = socialHash(result.providerReceipt);
    let resultCaption: string | null = null;
    let assetId: string | null = null;
    let assetSha256: string | null = null;
    let applied = false;
    const brief = await client.query<{
      content_kind: string;
      media_refs: SocialMediaRef[];
      status: string;
    }>(
      `SELECT content_kind,media_refs,status FROM social_content_briefs
       WHERE tenant_id=$1 AND organization_id=$2 AND id=$3 FOR UPDATE`,
      [context.tenantId, context.organizationId, locked.rows[0].brief_id],
    );
    if (result.output.kind === "CAPTION") {
      resultCaption = result.output.text;
      if (brief.rows[0]?.status === "DRAFT") {
        await client.query(
          `UPDATE social_content_briefs SET caption=$4,version=version+1,updated_at=now()
           WHERE tenant_id=$1 AND organization_id=$2 AND id=$3 AND status='DRAFT'`,
          [context.tenantId, context.organizationId, claim.briefId, resultCaption],
        );
        applied = true;
      }
    } else {
      assetSha256 = result.output.sha256;
      const inserted = await client.query<{ id: string }>(
        `WITH created AS (
           INSERT INTO social_media_assets
             (id,tenant_id,organization_id,object_path,content_sha256,media_kind,
              mime_type,size_bytes,original_file_name,created_by_legacy_user_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (tenant_id,organization_id,content_sha256) DO NOTHING
           RETURNING id
         )
         SELECT id FROM created
         UNION ALL
         SELECT id FROM social_media_assets
         WHERE tenant_id=$2 AND organization_id=$3 AND content_sha256=$5
         LIMIT 1`,
        [
          nextSocialId(), context.tenantId, context.organizationId,
          result.output.objectPath, result.output.sha256,
          result.output.kind.toLowerCase(), result.output.mimeType,
          result.output.sizeBytes, result.output.fileName,
          locked.rows[0].created_by_legacy_user_id,
        ],
      );
      if (inserted.rowCount !== 1)
        throw new Error("SOCIAL_CREATIVE_ASSET_REGISTRATION_FAILED");
      assetId = inserted.rows[0].id;
      if (brief.rows[0]?.status === "DRAFT") {
        const nextRefs = [
          ...brief.rows[0].media_refs,
          {
            kind: result.output.kind.toLowerCase() as "image" | "video",
            ref: result.output.objectPath,
          },
        ];
        try {
          assertSocialCreativeOutputCompatible(
            brief.rows[0].content_kind,
            result.output.kind,
          );
          assertSocialContentMedia(brief.rows[0].content_kind, nextRefs);
          await client.query(
            `UPDATE social_content_briefs
             SET media_refs=$4::jsonb,version=version+1,updated_at=now()
             WHERE tenant_id=$1 AND organization_id=$2 AND id=$3 AND status='DRAFT'`,
            [
              context.tenantId,
              context.organizationId,
              claim.briefId,
              JSON.stringify(nextRefs),
            ],
          );
          applied = true;
        } catch {
          applied = false;
        }
      }
    }
    await client.query(
      `INSERT INTO social_creative_attempts
         (id,tenant_id,organization_id,creative_request_id,attempt_number,worker_id,
          runtime_release_id,outcome,provider_request_hash,provider_receipt_hash,
          generated_asset_sha256,resolved_model,usage,started_at,completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'GENERATED',$8,$9,$10,$11,$12::jsonb,$13,$14)`,
      [
        nextSocialId(), context.tenantId, context.organizationId, claim.id,
        claim.attemptNumber, workerId, runtimeReleaseId, requestHash, receiptHash,
        assetSha256, result.resolvedModel, JSON.stringify(result.usage),
        claim.claimedAt, completedAt,
      ],
    );
    await client.query(
      `UPDATE social_creative_requests
       SET status='GENERATED',provider_request_hash=$6,provider_receipt_hash=$7,
           result_caption=$8,generated_asset_id=$9,resolved_model=$10,usage=$11::jsonb,
           applied_at=$12,next_attempt_at=NULL,last_error_code=NULL,last_error_at=NULL,
           lease_token_hash=NULL,leased_at=NULL,lease_expires_at=NULL,worker_id=NULL,
           updated_at=now()
       WHERE tenant_id=$1 AND organization_id=$2 AND id=$3
         AND status='RUNNING' AND worker_id=$4 AND lease_token_hash=$5`,
      [
        context.tenantId, context.organizationId, claim.id, workerId, leaseTokenHash,
        requestHash, receiptHash, resultCaption, assetId, result.resolvedModel,
        JSON.stringify(result.usage), applied ? completedAt : null,
      ],
    );
    return "GENERATED";
  }

  const errorCode = normalizeSocialErrorCode(result.errorCode);
  const failureCount = locked.rows[0].failure_count + 1;
  const retry =
    result.retryable &&
    failureCount < locked.rows[0].max_attempts &&
    locked.rows[0].attempt_count < 120;
  await client.query(
    `INSERT INTO social_creative_attempts
       (id,tenant_id,organization_id,creative_request_id,attempt_number,worker_id,
        runtime_release_id,outcome,provider_request_hash,error_code,started_at,completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      nextSocialId(), context.tenantId, context.organizationId, claim.id,
      claim.attemptNumber, workerId, runtimeReleaseId,
      retry ? "RETRY" : "DEAD_LETTER", requestHash, errorCode,
      claim.claimedAt, completedAt,
    ],
  );
  await client.query(
    `UPDATE social_creative_requests
     SET status=$6,failure_count=$7,next_attempt_at=$8,last_error_code=$9,
         last_error_at=now(),lease_token_hash=NULL,leased_at=NULL,
         lease_expires_at=NULL,worker_id=NULL,updated_at=now()
     WHERE tenant_id=$1 AND organization_id=$2 AND id=$3
       AND status='RUNNING' AND worker_id=$4 AND lease_token_hash=$5`,
    [
      context.tenantId, context.organizationId, claim.id, workerId, leaseTokenHash,
      retry ? "QUEUED" : "DEAD_LETTER", failureCount,
      retry ? new Date(Date.now() + socialRetryDelayMs(failureCount)) : null,
      errorCode,
    ],
  );
  return retry ? "QUEUED" : "DEAD_LETTER";
}
