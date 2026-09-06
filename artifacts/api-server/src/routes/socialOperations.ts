import { Router, type IRouter, type Response } from "express";
import { z } from "zod";
import * as nodePath from "node:path";
import { requireAuth, requirePermission, logAudit } from "../lib/auth";
import { callerOwnsObject, recordObjectOwner } from "../lib/objectAuthz";
import {
  ObjectNotFoundError,
  ObjectStorageService,
} from "../lib/objectStorage";
import { checkAndIncrementRateLimit } from "../lib/pgRateLimiter";
import {
  appendSocialOperationReceipt,
  findSocialOperationReplay,
  nextSocialId,
  socialHash,
  socialOperationsConfiguration,
  withSocialOperationsContext,
} from "../lib/socialOperationsStore";
import {
  assertSocialCreativeOutputCompatible,
  resolveSocialAttributionWindow,
  resolveSocialCreativeGate,
  resolveSocialPerformanceGate,
  resolveSocialProviderConnectionGate,
  resolveSocialPublicationGate,
  socialTrackingKey,
} from "../lib/socialOperationsContract";
import { verifySocialAccount } from "../lib/socialPublisherAdapter";
import {
  assertSocialContentMedia,
  SOCIAL_MEDIA_MAX_ASSETS,
  validateSocialMediaBuffer,
  validateSocialMediaMetadata,
} from "../lib/socialMediaAssets";

const router: IRouter = Router();
const objectStorage = new ObjectStorageService();
const uuidSchema = z.string().uuid();
const requestKeySchema = z
  .string()
  .min(8)
  .max(160)
  .regex(/^[A-Za-z0-9._:-]+$/);
const channelSchema = z.enum([
  "instagram",
  "facebook",
  "linkedin",
  "youtube",
  "tiktok",
  "x",
  "blog",
]);
const contentKindSchema = z.enum([
  "POST",
  "STORY",
  "REEL",
  "VIDEO",
  "ARTICLE",
  "AD_CREATIVE",
]);
const briefBodySchema = z
  .object({
    requestKey: requestKeySchema,
    title: z.string().trim().min(1).max(240),
    objective: z.string().trim().min(1).max(2000),
    audience: z.string().trim().min(1).max(1000),
    contentKind: contentKindSchema,
    locales: z
      .array(
        z
          .string()
          .trim()
          .regex(/^[a-z]{2}(?:-[A-Z]{2})?$/),
      )
      .min(1)
      .max(20),
    channels: z.array(channelSchema).min(1).max(20),
    campaignKey: z
      .string()
      .trim()
      .max(96)
      .regex(/^[A-Za-z0-9._:-]+$/)
      .optional(),
    caption: z.string().max(10_000).optional(),
    mediaAssetIds: z.array(uuidSchema).max(SOCIAL_MEDIA_MAX_ASSETS).default([]),
    scheduledFor: z.string().datetime({ offset: true }).optional(),
    utm: z
      .object({
        source: z.string().trim().max(128).optional(),
        medium: z.string().trim().max(128).optional(),
        campaign: z.string().trim().max(128).optional(),
        term: z.string().trim().max(128).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.mediaAssetIds).size !== value.mediaAssetIds.length)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mediaAssetIds"],
        message: "Duplicate media assets are not allowed",
      });
  });
const socialMediaUploadBodySchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(240)
      .refine(
        (value) =>
          nodePath.basename(value) === value &&
          !/[\u0000-\u001f\u007f]/.test(value),
      ),
    size: z.number().int().positive(),
    contentType: z.string().trim().min(1).max(96),
  })
  .strict();
const socialMediaRegistrationBodySchema = z
  .object({
    requestKey: requestKeySchema,
    objectPath: z
      .string()
      .regex(
        /^\/objects\/social-media\/staging\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
    originalFileName: z
      .string()
      .trim()
      .min(1)
      .max(240)
      .refine(
        (value) =>
          nodePath.basename(value) === value &&
          !/[\u0000-\u001f\u007f]/.test(value),
      ),
    mimeType: z.string().trim().min(1).max(96),
    sizeBytes: z.number().int().positive(),
  })
  .strict();
const reviewBodySchema = z
  .object({
    decision: z.enum(["APPROVE", "REJECT"]),
    reason: z.string().trim().max(2000).optional(),
    requestKey: requestKeySchema,
  })
  .strict();
const accountBodySchema = z
  .object({
    requestKey: requestKeySchema,
    provider: z
      .string()
      .trim()
      .min(2)
      .max(64)
      .regex(/^[a-z][a-z0-9._-]+$/),
    accountKey: z
      .string()
      .trim()
      .min(2)
      .max(96)
      .regex(/^[a-z][a-z0-9._:-]+$/),
    displayName: z.string().trim().min(1).max(160),
    accountKind: z
      .enum(["PROFILE", "PAGE", "CHANNEL", "AD_ACCOUNT"])
      .default("PROFILE"),
    currencyCode: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    integrationKey: z
      .string()
      .trim()
      .max(96)
      .regex(/^[a-z][a-z0-9._:-]+$/)
      .optional(),
    externalAccountRef: z.string().trim().min(1).max(512).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.accountKind === "AD_ACCOUNT" && !value.currencyCode)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["currencyCode"],
        message: "Currency is required for ad accounts",
      });
    if (value.accountKind !== "AD_ACCOUNT" && value.currencyCode)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["currencyCode"],
        message: "Currency is only allowed for ad accounts",
      });
  });
const attributionQuerySchema = z
  .object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
const creativeRequestBodySchema = z
  .object({
    requestKey: requestKeySchema,
    briefId: uuidSchema,
    outputKind: z.enum(["CAPTION", "IMAGE", "VIDEO"]),
    provider: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z][a-z0-9._-]{1,63}$/),
    integrationKey: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z][a-z0-9._:-]{1,95}$/),
    model: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._:/-]{1,128}$/)
      .optional(),
    locale: z.string().trim().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/),
    prompt: z.string().trim().min(1).max(12_000),
    negativePrompt: z.string().trim().max(4_000).optional(),
    aspectRatio: z.enum(["1:1", "4:5", "9:16", "16:9"]).optional(),
    durationSeconds: z.number().int().min(1).max(60).optional(),
    maxCostMinor: z.number().int().min(1).max(100_000_000),
    currencyCode: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
    maxAttempts: z.number().int().min(1).max(5).default(3),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.outputKind === "CAPTION" && (value.aspectRatio || value.durationSeconds))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outputKind"],
        message: "Caption generation cannot use media formatting",
      });
    if (value.outputKind === "IMAGE" && (!value.aspectRatio || value.durationSeconds))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["aspectRatio"],
        message: "Image generation requires only an aspect ratio",
      });
    if (value.outputKind === "VIDEO" && (!value.aspectRatio || !value.durationSeconds))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["durationSeconds"],
        message: "Video generation requires aspect ratio and duration",
      });
  });
const creativeListQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(100).default(50) })
  .strict();
const submitBodySchema = z.object({ requestKey: requestKeySchema }).strict();
const publicationBodySchema = z
  .object({
    briefId: uuidSchema,
    accountId: uuidSchema,
    scheduledFor: z.string().datetime({ offset: true }),
    maxAttempts: z.number().int().min(1).max(12).default(5),
    requestKey: requestKeySchema,
  })
  .strict();

function publicationGate() {
  return resolveSocialPublicationGate({
    workerEnabled: process.env.SOCIAL_PUBLICATION_WORKER_ENABLED,
    connectivityEnabled: process.env.SOCIAL_PROVIDER_CONNECTIVITY_ENABLED,
    providerPublishingEnabled: process.env.SOCIAL_PROVIDER_PUBLISHING_ENABLED,
    allowLiveIntegrations: process.env.ALLOW_LIVE_INTEGRATIONS,
    providerAllowlist: process.env.SOCIAL_PUBLICATION_PROVIDER_ALLOWLIST,
  });
}

function providerConnectionGate() {
  return resolveSocialProviderConnectionGate({
    connectivityEnabled: process.env.SOCIAL_PROVIDER_CONNECTIVITY_ENABLED,
    allowLiveIntegrations: process.env.ALLOW_LIVE_INTEGRATIONS,
    providerAllowlist: process.env.SOCIAL_PUBLICATION_PROVIDER_ALLOWLIST,
  });
}

function performanceGate() {
  return resolveSocialPerformanceGate({
    workerEnabled: process.env.SOCIAL_PERFORMANCE_WORKER_ENABLED,
    connectivityEnabled: process.env.SOCIAL_PROVIDER_CONNECTIVITY_ENABLED,
    allowLiveIntegrations: process.env.ALLOW_LIVE_INTEGRATIONS,
    providerAllowlist: process.env.SOCIAL_PUBLICATION_PROVIDER_ALLOWLIST,
  });
}

function creativeGate() {
  return resolveSocialCreativeGate({
    workerEnabled: process.env.SOCIAL_CREATIVE_WORKER_ENABLED,
    generationEnabled: process.env.SOCIAL_CREATIVE_GENERATION_ENABLED,
    allowLiveIntegrations: process.env.ALLOW_LIVE_INTEGRATIONS,
    providerAllowlist: process.env.SOCIAL_CREATIVE_PROVIDER_ALLOWLIST,
  });
}

async function bestEffortAudit(
  ...args: Parameters<typeof logAudit>
): Promise<void> {
  try {
    await logAudit(...args);
  } catch (error) {
    console.error("[social-operations-audit-projection]", error);
  }
}

function failureStatus(error: unknown): number {
  const code =
    error instanceof Error ? error.message : "SOCIAL_OPERATIONS_FAILED";
  if (
    code.includes("DISABLED") ||
    code.includes("CONFIGURATION") ||
    code.includes("SCOPE_UNAVAILABLE")
  )
    return 503;
  if (code.includes("READ_ONLY")) return 403;
  if (code.includes("MEDIA_NOT_OWNED")) return 403;
  if (code.includes("NOT_FOUND")) return 404;
  if (
    code.includes("SOCIAL_MEDIA_") &&
    (code.includes("INVALID") ||
      code.includes("MISMATCH") ||
      code.includes("REQUIRED") ||
      code.includes("LIMIT_EXCEEDED"))
  )
    return 400;
  if (code.includes("CREATIVE_OUTPUT_INCOMPATIBLE")) return 400;
  if (
    code.includes("CONFLICT") ||
    code.includes("MAKER_CHECKER") ||
    code.includes("NOT_APPROVED") ||
    code.includes("NOT_VERIFIED") ||
    code.includes("NOT_ENABLED") ||
    code.includes("INTEGRATION_MISSING") ||
    code.includes("ALREADY_RUNNING")
  )
    return 409;
  return 500;
}

function sendFailure(res: Response, error: unknown): void {
  const code =
    error instanceof Error ? error.message : "SOCIAL_OPERATIONS_FAILED";
  const status = failureStatus(error);
  if (status === 500) console.error("[social-operations]", error);
  res.status(status).json({ error: code, code });
}

router.get(
  "/social/context",
  requireAuth,
  requirePermission("social.view"),
  async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const config = socialOperationsConfiguration();
    if (!config.enabled) {
      res.json({
        ...config,
        publishingEnabled: false,
        publicationGate: publicationGate(),
        performanceGate: performanceGate(),
        creativeGate: creativeGate(),
        providerConnectionGate: providerConnectionGate(),
      });
      return;
    }
    try {
      const context = await withSocialOperationsContext(
        req.user!.id,
        "read",
        async (_client, value) => value,
      );
      res.json({
        enabled: true,
        mode: context.mode,
        tenantId: context.tenantId,
        organizationId: context.organizationId,
        publishingEnabled: publicationGate().enabled,
        publicationGate: publicationGate(),
        performanceGate: performanceGate(),
        creativeGate: creativeGate(),
        providerConnectionGate: providerConnectionGate(),
      });
    } catch (error) {
      sendFailure(res, error);
    }
  },
);

router.get(
  "/social/overview",
  requireAuth,
  requirePermission("social.view"),
  async (req, res) => {
    try {
      const result = await withSocialOperationsContext(
        req.user!.id,
        "read",
        async (client, context) => {
          const [briefs, accounts, intents, recent, workers] =
            await Promise.all([
              client.query(
                `SELECT status, count(*)::int AS count FROM social_content_briefs WHERE tenant_id=$1 AND organization_id=$2 GROUP BY status`,
                [context.tenantId, context.organizationId],
              ),
              client.query(
                `SELECT status, count(*)::int AS count FROM social_accounts WHERE tenant_id=$1 AND organization_id=$2 GROUP BY status`,
                [context.tenantId, context.organizationId],
              ),
              client.query(
                `SELECT status, count(*)::int AS count FROM social_publication_intents WHERE tenant_id=$1 AND organization_id=$2 GROUP BY status`,
                [context.tenantId, context.organizationId],
              ),
              client.query(
                `SELECT id,title,content_kind,channels,locales,media_refs,tracking_key,status,scheduled_for,created_by_legacy_user_id,reviewed_by_legacy_user_id,created_at,updated_at FROM social_content_briefs WHERE tenant_id=$1 AND organization_id=$2 ORDER BY scheduled_for ASC NULLS LAST, created_at DESC LIMIT 100`,
                [context.tenantId, context.organizationId],
              ),
              client.query<{
                worker_kind: "publication" | "performance" | "creative";
                active_workers: number;
                current_release_workers: number;
                last_seen_at: Date | null;
              }>(
                `SELECT worker_kind,
                      count(*) FILTER (WHERE last_seen_at>=now()-interval '90 seconds')::int AS active_workers,
                      count(*) FILTER (
                        WHERE last_seen_at>=now()-interval '90 seconds'
                          AND runtime_release_id=$3
                      )::int AS current_release_workers,
                      max(last_seen_at) AS last_seen_at
               FROM social_worker_heartbeats
               WHERE tenant_id=$1 AND organization_id=$2
               GROUP BY worker_kind`,
                [
                  context.tenantId,
                  context.organizationId,
                  (
                    process.env.RELEASE_ID ??
                    process.env.GIT_COMMIT ??
                    ""
                  ).trim(),
                ],
              ),
            ]);
          const heartbeatByKind = new Map(
            workers.rows.map((row) => [row.worker_kind, row]),
          );
          const workerHealth = (
            [
              ["publication", publicationGate()],
              ["performance", performanceGate()],
              ["creative", creativeGate()],
            ] as const
          ).map(([kind, gate]) => {
            const heartbeat = heartbeatByKind.get(kind);
            const activeWorkers = heartbeat?.active_workers ?? 0;
            const currentReleaseWorkers =
              heartbeat?.current_release_workers ?? 0;
            return {
              kind,
              expected: gate.enabled,
              status: !gate.enabled
                ? "DISABLED"
                : currentReleaseWorkers > 0
                  ? "READY"
                  : activeWorkers > 0
                    ? "RELEASE_MISMATCH"
                    : "STALE",
              activeWorkers,
              currentReleaseWorkers,
              lastSeenAt: heartbeat?.last_seen_at ?? null,
              reason: gate.reason,
            };
          });
          return {
            briefCounts: briefs.rows,
            accountCounts: accounts.rows,
            publicationCounts: intents.rows,
            briefs: recent.rows,
            publishingEnabled: publicationGate().enabled,
            publicationGate: publicationGate(),
            performanceGate: performanceGate(),
            creativeGate: creativeGate(),
            providerConnectionGate: providerConnectionGate(),
            workerHealth,
          };
        },
      );
      res.setHeader("Cache-Control", "private, no-store");
      res.json(result);
    } catch (error) {
      sendFailure(res, error);
    }
  },
);

router.get(
  "/social/creative-integrations",
  requireAuth,
  requirePermission("social.view"),
  async (req, res) => {
    try {
      const data = await withSocialOperationsContext(
        req.user!.id,
        "read",
        async (client) =>
          (
            await client.query<{ key: string; name: string; category: string }>(
              `SELECT key,name,category FROM integrations
               WHERE is_enabled=true AND (
                 lower(category)='ai'
                 OR key IN ('openai','claude','anthropic','runway')
                 OR key LIKE 'claude:%' OR key LIKE 'anthropic:%'
               )
               ORDER BY name,key`,
            )
          ).rows,
      );
      res.setHeader("Cache-Control", "private, no-store");
      res.json({ data });
    } catch (error) {
      sendFailure(res, error);
    }
  },
);

router.get(
  "/social/account-integrations",
  requireAuth,
  requirePermission("social.view"),
  async (req, res) => {
    try {
      const data = await withSocialOperationsContext(
        req.user!.id,
        "read",
        async (client) =>
          (
            await client.query<{ key: string; name: string; category: string }>(
              `SELECT key,name,category FROM integrations
               WHERE is_enabled=true AND (
                 lower(category) IN ('social','social_media')
                 OR key IN ('facebook_messenger','instagram')
               )
               ORDER BY name,key`,
            )
          ).rows,
      );
      res.setHeader("Cache-Control", "private, no-store");
      res.json({ data });
    } catch (error) {
      sendFailure(res, error);
    }
  },
);

router.get(
  "/social/creative-requests",
  requireAuth,
  requirePermission("social.view"),
  async (req, res) => {
    const query = creativeListQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "SOCIAL_CREATIVE_QUERY_INVALID" });
      return;
    }
    try {
      const data = await withSocialOperationsContext(
        req.user!.id,
        "read",
        async (client, context) =>
          (
            await client.query(
              `SELECT request.id,request.brief_id,brief.title AS brief_title,
                      request.output_kind,request.provider,request.integration_key,
                      request.model,request.locale,request.prompt,request.negative_prompt,
                      request.aspect_ratio,request.duration_seconds,request.status,
                      request.max_cost_minor,request.currency_code,
                      request.attempt_count,request.failure_count,request.max_attempts,
                      request.next_attempt_at,request.result_caption,
                      request.generated_asset_id,asset.object_path AS generated_asset_path,
                      asset.media_kind AS generated_asset_kind,request.resolved_model,
                      request.usage,request.applied_at,request.last_error_code,
                      request.created_by_legacy_user_id,request.approved_by_legacy_user_id,
                      request.approved_at,request.rejection_reason,
                      request.created_at,request.updated_at
               FROM social_creative_requests request
               JOIN social_content_briefs brief
                 ON brief.tenant_id=request.tenant_id AND brief.id=request.brief_id
               LEFT JOIN social_media_assets asset
                 ON asset.tenant_id=request.tenant_id AND asset.id=request.generated_asset_id
               WHERE request.tenant_id=$1 AND request.organization_id=$2
               ORDER BY request.created_at DESC,request.id DESC LIMIT $3`,
              [context.tenantId, context.organizationId, query.data.limit],
            )
          ).rows,
      );
      res.setHeader("Cache-Control", "private, no-store");
      res.json({ data, creativeGate: creativeGate() });
    } catch (error) {
      sendFailure(res, error);
    }
  },
);

router.post(
  "/social/creative-requests",
  requireAuth,
  requirePermission("social.manage"),
  async (req, res) => {
    const body = creativeRequestBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({
        error: "SOCIAL_CREATIVE_REQUEST_INVALID",
        issues: body.error.flatten(),
      });
      return;
    }
    try {
      const result = await withSocialOperationsContext(
        req.user!.id,
        "manage",
        async (client, context) => {
          const replay = await findSocialOperationReplay(
            client,
            context,
            body.data.requestKey,
            body.data,
          );
          if (replay) return replay;
          const brief = await client.query<{
            content_kind: string;
            status: string;
            locales: string[];
          }>(
            `SELECT content_kind,status,locales FROM social_content_briefs
             WHERE tenant_id=$1 AND organization_id=$2 AND id=$3 FOR UPDATE`,
            [context.tenantId, context.organizationId, body.data.briefId],
          );
          if (brief.rowCount !== 1)
            throw new Error("SOCIAL_CREATIVE_BRIEF_NOT_FOUND");
          if (brief.rows[0].status !== "DRAFT")
            throw new Error("SOCIAL_CREATIVE_BRIEF_STATE_CONFLICT");
          if (!brief.rows[0].locales.includes(body.data.locale))
            throw new Error("SOCIAL_CREATIVE_LOCALE_CONFLICT");
          const integration = await client.query(
            `SELECT 1 FROM integrations
             WHERE key=$1 AND is_enabled=true AND (
               lower(category)='ai'
               OR key IN ('openai','claude','anthropic','runway')
               OR key LIKE 'claude:%' OR key LIKE 'anthropic:%'
             )`,
            [body.data.integrationKey],
          );
          if (integration.rowCount !== 1)
            throw new Error("SOCIAL_CREATIVE_INTEGRATION_NOT_ENABLED");
          assertSocialCreativeOutputCompatible(
            brief.rows[0].content_kind,
            body.data.outputKind,
          );
          const id = nextSocialId();
          const created = (
            await client.query(
              `INSERT INTO social_creative_requests
                 (id,tenant_id,organization_id,brief_id,output_kind,provider,
                  integration_key,model,locale,prompt,negative_prompt,aspect_ratio,
                  duration_seconds,max_cost_minor,currency_code,status,request_key,max_attempts,
                  created_by_legacy_user_id)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
                       'PENDING_APPROVAL',$16,$17,$18)
               RETURNING id,brief_id,output_kind,provider,integration_key,model,
                         locale,prompt,negative_prompt,aspect_ratio,duration_seconds,
                         max_cost_minor,currency_code,
                         status,attempt_count,failure_count,max_attempts,
                         created_by_legacy_user_id,created_at,updated_at`,
              [
                id,
                context.tenantId,
                context.organizationId,
                body.data.briefId,
                body.data.outputKind,
                body.data.provider,
                body.data.integrationKey,
                body.data.model ?? null,
                body.data.locale,
                body.data.prompt,
                body.data.negativePrompt ?? null,
                body.data.aspectRatio ?? null,
                body.data.durationSeconds ?? null,
                body.data.maxCostMinor,
                body.data.currencyCode,
                body.data.requestKey,
                body.data.maxAttempts,
                context.legacyUserId,
              ],
            )
          ).rows[0];
          await appendSocialOperationReceipt(client, context, {
            operation: "CREATE_SOCIAL_CREATIVE_REQUEST",
            entityType: "social_creative_request",
            entityId: id,
            requestKey: body.data.requestKey,
            payload: body.data,
            result: created,
          });
          return created;
        },
      );
      await bestEffortAudit(
        req.user!.id,
        "create_social_creative_request",
        "social_creative_request",
        undefined,
        { socialCreativeRequestId: result.id, outputKind: body.data.outputKind },
        req.ip,
      );
      res.status(201).json(result);
    } catch (error: any) {
      if (error?.code === "23505") {
        res.status(409).json({ error: "SOCIAL_CREATIVE_REQUEST_CONFLICT" });
        return;
      }
      sendFailure(res, error);
    }
  },
);

router.post(
  "/social/creative-requests/:id/review",
  requireAuth,
  requirePermission("social.approve"),
  async (req, res) => {
    const id = uuidSchema.safeParse(req.params.id);
    const body = reviewBodySchema.safeParse(req.body);
    if (!id.success || !body.success) {
      res.status(400).json({ error: "SOCIAL_CREATIVE_REVIEW_INVALID" });
      return;
    }
    try {
      const result = await withSocialOperationsContext(
        req.user!.id,
        "manage",
        async (client, context) => {
          const payload = { creativeRequestId: id.data, ...body.data };
          const replay = await findSocialOperationReplay(
            client,
            context,
            body.data.requestKey,
            payload,
          );
          if (replay) return replay;
          const current = await client.query<{
            status: string;
            created_by_legacy_user_id: number;
          }>(
            `SELECT status,created_by_legacy_user_id
             FROM social_creative_requests
             WHERE tenant_id=$1 AND organization_id=$2 AND id=$3 FOR UPDATE`,
            [context.tenantId, context.organizationId, id.data],
          );
          if (current.rowCount !== 1)
            throw new Error("SOCIAL_CREATIVE_REQUEST_NOT_FOUND");
          if (current.rows[0].status !== "PENDING_APPROVAL")
            throw new Error("SOCIAL_CREATIVE_REVIEW_STATE_CONFLICT");
          if (current.rows[0].created_by_legacy_user_id === context.legacyUserId)
            throw new Error("SOCIAL_CREATIVE_MAKER_CHECKER_REQUIRED");
          if (body.data.decision === "REJECT" && !body.data.reason)
            throw new Error("SOCIAL_CREATIVE_REJECTION_REASON_REQUIRED");
          const status = body.data.decision === "APPROVE" ? "APPROVED" : "REJECTED";
          await client.query(
            `UPDATE social_creative_requests
             SET status=$4,approved_by_legacy_user_id=$5,approved_at=now(),
                 rejection_reason=$6,next_attempt_at=$7,updated_at=now()
             WHERE tenant_id=$1 AND organization_id=$2 AND id=$3`,
            [
              context.tenantId,
              context.organizationId,
              id.data,
              status,
              context.legacyUserId,
              body.data.decision === "REJECT" ? body.data.reason : null,
              body.data.decision === "APPROVE" ? new Date() : null,
            ],
          );
          const answer = { id: id.data, status, replay: false };
          await appendSocialOperationReceipt(client, context, {
            operation: "REVIEW_SOCIAL_CREATIVE_REQUEST",
            entityType: "social_creative_request",
            entityId: id.data,
            requestKey: body.data.requestKey,
            payload,
            result: answer,
          });
          return answer;
        },
      );
      await bestEffortAudit(
        req.user!.id,
        "review_social_creative_request",
        "social_creative_request",
        undefined,
        { socialCreativeRequestId: id.data, status: result.status },
        req.ip,
      );
      res.json(result);
    } catch (error: any) {
      if (error?.code === "23505") {
        res.status(409).json({ error: "SOCIAL_CREATIVE_REVIEW_CONFLICT" });
        return;
      }
      sendFailure(res, error);
    }
  },
);

router.get(
  "/social/attribution",
  requireAuth,
  requirePermission("social.view"),
  async (req, res) => {
    const parsed = attributionQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "SOCIAL_ATTRIBUTION_QUERY_INVALID" });
      return;
    }
    let window: ReturnType<typeof resolveSocialAttributionWindow>;
    try {
      window = resolveSocialAttributionWindow(parsed.data);
    } catch {
      res.status(400).json({ error: "SOCIAL_ATTRIBUTION_QUERY_INVALID" });
      return;
    }
    try {
      const result = await withSocialOperationsContext(
        req.user!.id,
        "read",
        async (client, context) => {
          const parameters = [
            context.tenantId,
            context.organizationId,
            window.from,
            window.toExclusive,
          ];
          const [summary, stages, briefs, providerMetrics, spend] =
            await Promise.all([
              client.query<{
                tracked_leads: number;
                converted_students: number;
                applications: number;
              }>(
                `WITH cohort AS (
                   SELECT lead_id,converted_student_id
                   FROM social_attributed_leads
                   WHERE tenant_id=$1 AND organization_id=$2
                     AND first_touch_at >= $3 AND first_touch_at < $4
                     AND lead_deleted_at IS NULL
                 )
                 SELECT count(*)::int AS tracked_leads,
                        count(converted_student_id)::int AS converted_students,
                        (SELECT count(*)::int
                         FROM social_attributed_applications app
                         JOIN cohort ON cohort.lead_id=app.lead_id
                         WHERE app.tenant_id=$1 AND app.organization_id=$2
                           AND app.application_deleted_at IS NULL) AS applications
                 FROM cohort`,
                parameters,
              ),
              client.query<{ application_stage: string; count: number }>(
                `WITH cohort AS (
                   SELECT lead_id FROM social_attributed_leads
                   WHERE tenant_id=$1 AND organization_id=$2
                     AND first_touch_at >= $3 AND first_touch_at < $4
                     AND lead_deleted_at IS NULL
                 )
                 SELECT app.application_stage,count(*)::int AS count
                 FROM social_attributed_applications app
                 JOIN cohort ON cohort.lead_id=app.lead_id
                 WHERE app.tenant_id=$1 AND app.organization_id=$2
                   AND app.application_deleted_at IS NULL
                 GROUP BY app.application_stage
                 ORDER BY count(*) DESC,app.application_stage`,
                parameters,
              ),
              client.query<{
                brief_id: string;
                title: string;
                campaign_key: string | null;
                tracking_key: string;
                tracked_leads: number;
                converted_students: number;
                applications: number;
              }>(
                `WITH cohort AS (
                   SELECT brief_id,lead_id,converted_student_id
                   FROM social_attributed_leads
                   WHERE tenant_id=$1 AND organization_id=$2
                     AND first_touch_at >= $3 AND first_touch_at < $4
                     AND lead_deleted_at IS NULL
                 )
                 SELECT brief.id AS brief_id,brief.title,brief.campaign_key,
                        brief.tracking_key,
                        count(DISTINCT cohort.lead_id)::int AS tracked_leads,
                        count(DISTINCT cohort.converted_student_id)::int AS converted_students,
                        count(DISTINCT app.application_id)::int AS applications
                 FROM social_content_briefs brief
                 LEFT JOIN cohort ON cohort.brief_id=brief.id
                 LEFT JOIN social_attributed_applications app
                   ON app.tenant_id=brief.tenant_id
                  AND app.organization_id=brief.organization_id
                  AND app.brief_id=brief.id
                  AND app.lead_id=cohort.lead_id
                  AND app.application_deleted_at IS NULL
                 WHERE brief.tenant_id=$1 AND brief.organization_id=$2
                   AND (
                     cohort.lead_id IS NOT NULL
                     OR (COALESCE(brief.scheduled_for,brief.created_at) >= $3
                         AND COALESCE(brief.scheduled_for,brief.created_at) < $4)
                   )
                 GROUP BY brief.id,brief.title,brief.campaign_key,brief.tracking_key
                 ORDER BY count(DISTINCT cohort.lead_id) DESC,
                          count(DISTINCT app.application_id) DESC,brief.id DESC
                 LIMIT $5`,
                [...parameters, parsed.data.limit],
              ),
              client.query<{
                provider_clicks: string;
                provider_leads: string;
                provider_conversions: string;
              }>(
                `WITH latest AS (
                   SELECT DISTINCT ON (snapshot.publication_intent_id)
                          snapshot.publication_intent_id,snapshot.metrics
                   FROM social_performance_snapshots snapshot
                   WHERE snapshot.tenant_id=$1 AND snapshot.organization_id=$2
                     AND snapshot.observed_at < $4
                   ORDER BY snapshot.publication_intent_id,snapshot.observed_at DESC,snapshot.id DESC
                 )
                 SELECT COALESCE(sum(COALESCE((latest.metrics->>'linkClicks')::numeric,
                                             (latest.metrics->>'clicks')::numeric,0)),0)::text AS provider_clicks,
                        COALESCE(sum(COALESCE((latest.metrics->>'leads')::numeric,0)),0)::text AS provider_leads,
                        COALESCE(sum(COALESCE((latest.metrics->>'conversions')::numeric,0)),0)::text AS provider_conversions
                 FROM latest
                 JOIN social_publication_intents intent
                   ON intent.tenant_id=$1 AND intent.id=latest.publication_intent_id
                 WHERE intent.organization_id=$2
                   AND intent.published_at >= $3 AND intent.published_at < $4`,
                parameters,
              ),
              client.query<{ currency_code: string; spend_minor: string }>(
                `WITH latest AS (
                   SELECT DISTINCT ON (snapshot.publication_intent_id)
                          snapshot.publication_intent_id,snapshot.metrics
                   FROM social_performance_snapshots snapshot
                   WHERE snapshot.tenant_id=$1 AND snapshot.organization_id=$2
                     AND snapshot.observed_at < $4
                   ORDER BY snapshot.publication_intent_id,snapshot.observed_at DESC,snapshot.id DESC
                 )
                 SELECT account.currency_code,
                        sum((latest.metrics->>'spendMinor')::numeric)::text AS spend_minor
                 FROM latest
                 JOIN social_publication_intents intent
                   ON intent.tenant_id=$1 AND intent.id=latest.publication_intent_id
                 JOIN social_accounts account
                   ON account.tenant_id=intent.tenant_id AND account.id=intent.account_id
                 WHERE intent.organization_id=$2
                   AND intent.published_at >= $3 AND intent.published_at < $4
                   AND account.account_kind='AD_ACCOUNT'
                   AND account.currency_code IS NOT NULL
                   AND latest.metrics ? 'spendMinor'
                 GROUP BY account.currency_code
                 ORDER BY account.currency_code`,
                parameters,
              ),
            ]);
          return {
            period: {
              from: window.from.toISOString().slice(0, 10),
              to: new Date(window.toExclusive.getTime() - 86_400_000)
                .toISOString()
                .slice(0, 10),
            },
            summary: summary.rows[0] ?? {
              tracked_leads: 0,
              converted_students: 0,
              applications: 0,
            },
            providerMetrics: providerMetrics.rows[0] ?? {
              provider_clicks: "0",
              provider_leads: "0",
              provider_conversions: "0",
            },
            applicationStages: stages.rows,
            spendByCurrency: spend.rows,
            briefs: briefs.rows,
          };
        },
      );
      res.setHeader("Cache-Control", "private, no-store");
      res.json(result);
    } catch (error) {
      sendFailure(res, error);
    }
  },
);

router.get(
  "/social/accounts",
  requireAuth,
  requirePermission("social.view"),
  async (req, res) => {
    try {
      const rows = await withSocialOperationsContext(
        req.user!.id,
        "read",
        async (client, context) =>
          (
            await client.query(
              `
      SELECT id,provider,account_key,display_name,account_kind,currency_code,integration_key,status,
             verified_at,last_verification_at,last_verification_error_code,
             created_at,updated_at
      FROM social_accounts WHERE tenant_id=$1 AND organization_id=$2 ORDER BY provider,display_name
    `,
              [context.tenantId, context.organizationId],
            )
          ).rows,
      );
      res.setHeader("Cache-Control", "private, no-store");
      res.json({ data: rows });
    } catch (error) {
      sendFailure(res, error);
    }
  },
);

router.post(
  "/social/accounts/:id/verify",
  requireAuth,
  requirePermission("social.manage"),
  async (req, res) => {
    const id = uuidSchema.safeParse(req.params.id);
    const body = submitBodySchema.safeParse(req.body);
    if (!id.success || !body.success) {
      res.status(400).json({ error: "SOCIAL_ACCOUNT_VERIFY_INVALID" });
      return;
    }
    const payload = { accountId: id.data };
    try {
      const source = await withSocialOperationsContext(
        req.user!.id,
        "read",
        async (client, context) => {
          const replay = await findSocialOperationReplay(
            client,
            context,
            body.data.requestKey,
            payload,
          );
          if (replay) return { replay } as const;
          const account = await client.query<{
            provider: string;
            account_key: string;
            integration_key: string | null;
            status: string;
          }>(
            `SELECT provider,account_key,integration_key,status
             FROM social_accounts
             WHERE tenant_id=$1 AND organization_id=$2 AND id=$3`,
            [context.tenantId, context.organizationId, id.data],
          );
          if (account.rowCount !== 1)
            throw new Error("SOCIAL_ACCOUNT_NOT_FOUND");
          if (account.rows[0].status === "DISABLED")
            throw new Error("SOCIAL_ACCOUNT_DISABLED");
          if (!account.rows[0].integration_key)
            throw new Error("SOCIAL_ACCOUNT_INTEGRATION_MISSING");
          return { account: account.rows[0] } as const;
        },
      );
      if ("replay" in source) {
        res.json(source.replay);
        return;
      }
      const verification = await verifySocialAccount({
        requestKey: body.data.requestKey,
        provider: source.account.provider,
        accountKey: source.account.account_key,
        integrationKey: source.account.integration_key!,
      });
      const result = await withSocialOperationsContext(
        req.user!.id,
        "manage",
        async (client, context) => {
          const replay = await findSocialOperationReplay(
            client,
            context,
            body.data.requestKey,
            payload,
          );
          if (replay) return replay;
          const account = await client.query<{
            provider: string;
            account_key: string;
            integration_key: string | null;
            status: string;
          }>(
            `SELECT provider,account_key,integration_key,status
             FROM social_accounts
             WHERE tenant_id=$1 AND organization_id=$2 AND id=$3 FOR UPDATE`,
            [context.tenantId, context.organizationId, id.data],
          );
          if (account.rowCount !== 1)
            throw new Error("SOCIAL_ACCOUNT_NOT_FOUND");
          const current = account.rows[0];
          if (
            current.status === "DISABLED" ||
            current.provider !== source.account.provider ||
            current.account_key !== source.account.account_key ||
            current.integration_key !== source.account.integration_key
          )
            throw new Error("SOCIAL_ACCOUNT_VERIFY_STATE_CONFLICT");
          const providerRequestHash = socialHash({
            provider: current.provider,
            accountKey: current.account_key,
            integrationKey: current.integration_key,
          });
          const outcome = verification.ok
            ? "VERIFIED"
            : verification.retryable
              ? "RETRYABLE_FAILURE"
              : "REAUTH_REQUIRED";
          const providerReceiptHash = verification.ok
            ? socialHash(verification.providerReceipt)
            : null;
          const externalAccountRefHash = verification.ok
            ? socialHash(verification.externalAccountRef)
            : null;
          const errorCode = verification.ok ? null : verification.errorCode;
          await client.query(
            `INSERT INTO social_account_verifications
               (id,tenant_id,organization_id,account_id,actor_legacy_user_id,
                request_key,outcome,provider_request_hash,provider_receipt_hash,
                external_account_ref_hash,error_code)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [
              nextSocialId(),
              context.tenantId,
              context.organizationId,
              id.data,
              context.legacyUserId,
              body.data.requestKey,
              outcome,
              providerRequestHash,
              providerReceiptHash,
              externalAccountRefHash,
              errorCode,
            ],
          );
          if (verification.ok) {
            await client.query(
              `UPDATE social_accounts
               SET status='VERIFIED',external_account_ref_hash=$4,
                   verification_receipt_hash=$5,verified_at=now(),
                   last_verification_at=now(),last_verification_error_code=NULL,
                   display_name=COALESCE($6,display_name),updated_at=now()
               WHERE tenant_id=$1 AND organization_id=$2 AND id=$3`,
              [
                context.tenantId,
                context.organizationId,
                id.data,
                externalAccountRefHash,
                providerReceiptHash,
                verification.displayName,
              ],
            );
          } else if (!verification.retryable) {
            await client.query(
              `UPDATE social_accounts
               SET status='REAUTH_REQUIRED',verification_receipt_hash=NULL,
                   verified_at=NULL,last_verification_at=now(),
                   last_verification_error_code=$4,updated_at=now()
               WHERE tenant_id=$1 AND organization_id=$2 AND id=$3`,
              [context.tenantId, context.organizationId, id.data, errorCode],
            );
          } else if (current.status !== "VERIFIED") {
            await client.query(
              `UPDATE social_accounts
               SET status='CONNECTED_UNVERIFIED',verification_receipt_hash=NULL,
                   verified_at=NULL,last_verification_at=now(),
                   last_verification_error_code=$4,updated_at=now()
               WHERE tenant_id=$1 AND organization_id=$2 AND id=$3`,
              [context.tenantId, context.organizationId, id.data, errorCode],
            );
          } else {
            // Preserve the last provider-backed verification evidence while
            // making a transient connectivity failure visible to operators.
            await client.query(
              `UPDATE social_accounts
               SET last_verification_at=now(),last_verification_error_code=$4,
                   updated_at=now()
               WHERE tenant_id=$1 AND organization_id=$2 AND id=$3`,
              [context.tenantId, context.organizationId, id.data, errorCode],
            );
          }
          const answer = {
            id: id.data,
            status: verification.ok
              ? "VERIFIED"
              : verification.retryable
                ? current.status
                : "REAUTH_REQUIRED",
            outcome,
            errorCode,
          };
          await appendSocialOperationReceipt(client, context, {
            operation: "VERIFY_SOCIAL_ACCOUNT",
            entityType: "social_account",
            entityId: id.data,
            requestKey: body.data.requestKey,
            payload,
            result: answer,
          });
          return answer;
        },
      );
      await bestEffortAudit(
        req.user!.id,
        "verify_social_account_connection",
        "social_account",
        undefined,
        { socialAccountId: id.data, outcome: result.outcome },
        req.ip,
      );
      res.json(result);
    } catch (error: any) {
      if (error?.code === "23505") {
        res.status(409).json({ error: "SOCIAL_ACCOUNT_VERIFY_CONFLICT" });
        return;
      }
      sendFailure(res, error);
    }
  },
);

router.post(
  "/social/accounts",
  requireAuth,
  requirePermission("social.manage"),
  async (req, res) => {
    const parsed = accountBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "SOCIAL_ACCOUNT_INVALID",
        issues: parsed.error.flatten(),
      });
      return;
    }
    try {
      const row = await withSocialOperationsContext(
        req.user!.id,
        "manage",
        async (client, context) => {
          const replay = await findSocialOperationReplay(
            client,
            context,
            parsed.data.requestKey,
            parsed.data,
          );
          if (replay) return replay;
          if (parsed.data.integrationKey) {
            const integration = await client.query(
              `SELECT 1 FROM integrations
               WHERE key=$1 AND is_enabled=true AND (
                 lower(category) IN ('social','social_media')
                 OR key IN ('facebook_messenger','instagram')
               )`,
              [parsed.data.integrationKey],
            );
            if (integration.rowCount !== 1)
              throw new Error("SOCIAL_ACCOUNT_INTEGRATION_NOT_ENABLED");
          }
          const id = nextSocialId();
          const created = (
            await client.query(
              `
      INSERT INTO social_accounts (id,tenant_id,organization_id,provider,account_key,display_name,account_kind,currency_code,integration_key,external_account_ref_hash,status,created_by_legacy_user_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING id,provider,account_key,display_name,account_kind,currency_code,integration_key,status,created_at,updated_at
    `,
              [
                id,
                context.tenantId,
                context.organizationId,
                parsed.data.provider,
                parsed.data.accountKey,
                parsed.data.displayName,
                parsed.data.accountKind,
                parsed.data.currencyCode ?? null,
                parsed.data.integrationKey ?? null,
                parsed.data.externalAccountRef
                  ? socialHash(parsed.data.externalAccountRef)
                  : null,
                parsed.data.integrationKey
                  ? "CONNECTED_UNVERIFIED"
                  : "DISCONNECTED",
                context.legacyUserId,
              ],
            )
          ).rows[0];
          await appendSocialOperationReceipt(client, context, {
            operation: "CREATE_SOCIAL_ACCOUNT",
            entityType: "social_account",
            entityId: id,
            requestKey: parsed.data.requestKey,
            payload: parsed.data,
            result: created,
          });
          return created;
        },
      );
      await bestEffortAudit(
        req.user!.id,
        "create_social_account_registry",
        "social_account",
        undefined,
        { socialAccountId: row.id, provider: parsed.data.provider },
        req.ip,
      );
      res.status(201).json(row);
    } catch (error: any) {
      if (error?.code === "23505") {
        res.status(409).json({ error: "SOCIAL_ACCOUNT_CONFLICT" });
        return;
      }
      sendFailure(res, error);
    }
  },
);

router.post(
  "/social/media/uploads/request-url",
  requireAuth,
  requirePermission("social.manage"),
  async (req, res) => {
    const parsed = socialMediaUploadBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "SOCIAL_MEDIA_UPLOAD_INVALID" });
      return;
    }
    try {
      validateSocialMediaMetadata({
        fileName: parsed.data.name,
        mimeType: parsed.data.contentType,
        sizeBytes: parsed.data.size,
      });
      const allowed = await checkAndIncrementRateLimit(
        `social-media-upload:${req.user!.id}`,
        30,
        15 * 60 * 1000,
      );
      if (!allowed) {
        res.status(429).json({ error: "SOCIAL_MEDIA_UPLOAD_RATE_LIMITED" });
        return;
      }
      const uploadURL = await objectStorage.getObjectEntityUploadURL(
        "social-media/staging",
      );
      const objectPath = objectStorage.normalizeObjectEntityPath(uploadURL);
      if (!(await recordObjectOwner(objectPath, req.user!.id))) {
        res.status(503).json({ error: "SOCIAL_MEDIA_UPLOAD_AUTH_UNAVAILABLE" });
        return;
      }
      res.setHeader("Cache-Control", "private, no-store");
      res.json({
        uploadURL,
        objectPath,
        metadata: {
          name: parsed.data.name,
          size: parsed.data.size,
          contentType: parsed.data.contentType.toLowerCase(),
        },
      });
    } catch (error) {
      sendFailure(res, error);
    }
  },
);

router.post(
  "/social/media",
  requireAuth,
  requirePermission("social.manage"),
  async (req, res) => {
    const parsed = socialMediaRegistrationBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "SOCIAL_MEDIA_REGISTRATION_INVALID" });
      return;
    }
    const payload = parsed.data;
    try {
      const initial = await withSocialOperationsContext(
        req.user!.id,
        "manage",
        async (client, context) => ({
          replay: await findSocialOperationReplay(
            client,
            context,
            payload.requestKey,
            payload,
          ),
          tenantId: context.tenantId,
          organizationId: context.organizationId,
        }),
      );
      if (initial.replay) {
        res.json(initial.replay);
        return;
      }
      if (!(await callerOwnsObject(req.user!.id, payload.objectPath)))
        throw new Error("SOCIAL_MEDIA_NOT_OWNED");
      const source = await objectStorage.getObjectEntityFile(
        payload.objectPath,
      );
      const [storedMetadata] = await source.getMetadata();
      const storedSize = Number(storedMetadata.size);
      const storedMimeType = String(storedMetadata.contentType ?? "")
        .trim()
        .toLowerCase();
      if (
        storedSize !== payload.sizeBytes ||
        storedMimeType !== payload.mimeType.trim().toLowerCase()
      )
        throw new Error("SOCIAL_MEDIA_METADATA_MISMATCH");
      const [buffer] = await source.download();
      if (buffer.byteLength !== storedSize)
        throw new Error("SOCIAL_MEDIA_SIZE_MISMATCH");
      const verified = await validateSocialMediaBuffer({
        fileName: payload.originalFileName,
        mimeType: storedMimeType,
        buffer,
      });
      const objectPath = await objectStorage.uploadContentAddressedBuffer({
        subdir: `social-media/assets/${initial.tenantId}/${initial.organizationId}`,
        contentSha256: verified.sha256,
        buffer,
        contentType: verified.mimeType,
        extension: verified.permanentExtension,
      });
      const asset = await withSocialOperationsContext(
        req.user!.id,
        "manage",
        async (client, context) => {
          const replay = await findSocialOperationReplay(
            client,
            context,
            payload.requestKey,
            payload,
          );
          if (replay) return replay;
          const id = nextSocialId();
          const result = await client.query<{
            id: string;
            object_path: string;
            media_kind: "image" | "video";
            mime_type: string;
            size_bytes: number;
            original_file_name: string;
            created_at: Date;
          }>(
            `WITH inserted AS (
               INSERT INTO social_media_assets
                 (id,tenant_id,organization_id,object_path,content_sha256,media_kind,
                  mime_type,size_bytes,original_file_name,created_by_legacy_user_id)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
               ON CONFLICT (tenant_id,organization_id,content_sha256) DO NOTHING
               RETURNING id,object_path,media_kind,mime_type,size_bytes,original_file_name,created_at
             )
             SELECT id,object_path,media_kind,mime_type,size_bytes::integer AS size_bytes,
                    original_file_name,created_at FROM inserted
             UNION ALL
             SELECT id,object_path,media_kind,mime_type,size_bytes::integer AS size_bytes,
                    original_file_name,created_at
             FROM social_media_assets
             WHERE tenant_id=$2 AND organization_id=$3 AND content_sha256=$5
             LIMIT 1`,
            [
              id,
              context.tenantId,
              context.organizationId,
              objectPath,
              verified.sha256,
              verified.kind,
              verified.mimeType,
              verified.sizeBytes,
              payload.originalFileName,
              context.legacyUserId,
            ],
          );
          if (result.rowCount !== 1)
            throw new Error("SOCIAL_MEDIA_REGISTRATION_FAILED");
          const answer = result.rows[0];
          await appendSocialOperationReceipt(client, context, {
            operation: "REGISTER_SOCIAL_MEDIA_ASSET",
            entityType: "social_media_asset",
            entityId: answer.id,
            requestKey: payload.requestKey,
            payload,
            result: answer,
          });
          return answer;
        },
      );
      await source.delete({ ignoreNotFound: true }).catch(() => {
        console.error("[social-media] staging_object_cleanup_failed");
      });
      await bestEffortAudit(
        req.user!.id,
        "register_social_media_asset",
        "social_media_asset",
        undefined,
        { socialMediaAssetId: asset.id, mediaKind: asset.media_kind },
        req.ip,
      );
      res.status(201).json(asset);
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        res.status(404).json({ error: "SOCIAL_MEDIA_UPLOAD_NOT_FOUND" });
        return;
      }
      sendFailure(res, error);
    }
  },
);

router.get(
  "/social/media/:id/content",
  requireAuth,
  requirePermission("social.view"),
  async (req, res) => {
    const id = uuidSchema.safeParse(req.params.id);
    if (!id.success) {
      res.status(400).json({ error: "SOCIAL_MEDIA_ASSET_ID_INVALID" });
      return;
    }
    try {
      const asset = await withSocialOperationsContext(
        req.user!.id,
        "read",
        async (client, context) => {
          const result = await client.query<{
            object_path: string;
            mime_type: string;
            original_file_name: string;
          }>(
            `SELECT object_path,mime_type,original_file_name
             FROM social_media_assets
             WHERE tenant_id=$1 AND organization_id=$2 AND id=$3`,
            [context.tenantId, context.organizationId, id.data],
          );
          if (result.rowCount !== 1)
            throw new Error("SOCIAL_MEDIA_ASSET_NOT_FOUND");
          return result.rows[0];
        },
      );
      const object = await objectStorage.getObjectEntityFile(asset.object_path);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader(
        "Content-Disposition",
        `inline; filename*=UTF-8''${encodeURIComponent(asset.original_file_name)}`,
      );
      await objectStorage.streamObjectToResponse(req, res, object, {
        contentType: asset.mime_type,
        cacheControl: "private, no-store",
      });
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        res.status(404).json({ error: "SOCIAL_MEDIA_ASSET_NOT_FOUND" });
        return;
      }
      sendFailure(res, error);
    }
  },
);

router.post(
  "/social/briefs",
  requireAuth,
  requirePermission("social.manage"),
  async (req, res) => {
    const parsed = briefBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "SOCIAL_BRIEF_INVALID",
        issues: parsed.error.flatten(),
      });
      return;
    }
    try {
      const row = await withSocialOperationsContext(
        req.user!.id,
        "manage",
        async (client, context) => {
          const replay = await findSocialOperationReplay(
            client,
            context,
            parsed.data.requestKey,
            parsed.data,
          );
          if (replay) return replay;
          const uniqueAssetIds = parsed.data.mediaAssetIds;
          const assets = uniqueAssetIds.length
            ? await client.query<{
                id: string;
                media_kind: "image" | "video";
                object_path: string;
              }>(
                `SELECT id,media_kind,object_path
                 FROM social_media_assets
                 WHERE tenant_id=$1 AND organization_id=$2 AND id=ANY($3::uuid[])`,
                [context.tenantId, context.organizationId, uniqueAssetIds],
              )
            : { rows: [], rowCount: 0 };
          if (assets.rowCount !== uniqueAssetIds.length)
            throw new Error("SOCIAL_MEDIA_ASSET_NOT_FOUND");
          const assetById = new Map(
            assets.rows.map((asset) => [asset.id, asset]),
          );
          const mediaRefs = uniqueAssetIds.map((assetId) => {
            const asset = assetById.get(assetId)!;
            return { kind: asset.media_kind, ref: asset.object_path };
          });
          assertSocialContentMedia(parsed.data.contentKind, mediaRefs);
          const id = nextSocialId();
          const trackingKey = socialTrackingKey(id);
          const created = (
            await client.query(
              `
      INSERT INTO social_content_briefs (id,tenant_id,organization_id,title,objective,audience,content_kind,locales,channels,campaign_key,caption,media_refs,utm,tracking_key,scheduled_for,created_by_legacy_user_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15,$16)
      RETURNING *
    `,
              [
                id,
                context.tenantId,
                context.organizationId,
                parsed.data.title,
                parsed.data.objective,
                parsed.data.audience,
                parsed.data.contentKind,
                parsed.data.locales,
                parsed.data.channels,
                parsed.data.campaignKey ?? null,
                parsed.data.caption ?? null,
                JSON.stringify(mediaRefs),
                JSON.stringify(parsed.data.utm ?? {}),
                trackingKey,
                parsed.data.scheduledFor
                  ? new Date(parsed.data.scheduledFor)
                  : null,
                context.legacyUserId,
              ],
            )
          ).rows[0];
          await appendSocialOperationReceipt(client, context, {
            operation: "CREATE_SOCIAL_BRIEF",
            entityType: "social_content_brief",
            entityId: id,
            requestKey: parsed.data.requestKey,
            payload: parsed.data,
            result: created,
          });
          return created;
        },
      );
      await bestEffortAudit(
        req.user!.id,
        "create_social_content_brief",
        "social_content_brief",
        undefined,
        { socialBriefId: row.id, channels: parsed.data.channels },
        req.ip,
      );
      res.status(201).json(row);
    } catch (error) {
      sendFailure(res, error);
    }
  },
);

router.post(
  "/social/briefs/:id/submit",
  requireAuth,
  requirePermission("social.manage"),
  async (req, res) => {
    const id = uuidSchema.safeParse(req.params.id);
    const body = submitBodySchema.safeParse(req.body);
    if (!id.success || !body.success) {
      res.status(400).json({ error: "SOCIAL_BRIEF_SUBMIT_INVALID" });
      return;
    }
    try {
      const row = await withSocialOperationsContext(
        req.user!.id,
        "manage",
        async (client, context) => {
          const payload = { briefId: id.data };
          const replay = await findSocialOperationReplay(
            client,
            context,
            body.data.requestKey,
            payload,
          );
          if (replay) return replay;
          const current = await client.query<{
            content_kind: string;
            media_refs: Array<{ kind: "image" | "video"; ref: string }>;
          }>(
            `SELECT content_kind,media_refs FROM social_content_briefs
             WHERE tenant_id=$1 AND organization_id=$2 AND id=$3 AND status='DRAFT'
             FOR UPDATE`,
            [context.tenantId, context.organizationId, id.data],
          );
          if (current.rowCount !== 1)
            throw new Error("SOCIAL_BRIEF_NOT_FOUND_OR_CONFLICT");
          assertSocialContentMedia(
            current.rows[0].content_kind,
            current.rows[0].media_refs,
          );
          const result = await client.query(
            `UPDATE social_content_briefs SET status='IN_REVIEW',updated_at=now() WHERE tenant_id=$1 AND organization_id=$2 AND id=$3 AND status='DRAFT' RETURNING *`,
            [context.tenantId, context.organizationId, id.data],
          );
          if (result.rowCount !== 1)
            throw new Error("SOCIAL_BRIEF_NOT_FOUND_OR_CONFLICT");
          const row = result.rows[0];
          await appendSocialOperationReceipt(client, context, {
            operation: "SUBMIT_SOCIAL_BRIEF",
            entityType: "social_content_brief",
            entityId: id.data,
            requestKey: body.data.requestKey,
            payload,
            result: row,
          });
          return row;
        },
      );
      await bestEffortAudit(
        req.user!.id,
        "submit_social_content_brief",
        "social_content_brief",
        undefined,
        { socialBriefId: id.data },
        req.ip,
      );
      res.json(row);
    } catch (error) {
      sendFailure(res, error);
    }
  },
);

router.post(
  "/social/briefs/:id/review",
  requireAuth,
  requirePermission("social.approve"),
  async (req, res) => {
    const id = uuidSchema.safeParse(req.params.id);
    const body = reviewBodySchema.safeParse(req.body);
    if (!id.success || !body.success) {
      res.status(400).json({ error: "SOCIAL_REVIEW_INVALID" });
      return;
    }
    try {
      const result = await withSocialOperationsContext(
        req.user!.id,
        "manage",
        async (client, context) => {
          const brief = await client.query<{
            version: string;
            status: string;
            created_by_legacy_user_id: number;
          }>(
            `SELECT version,status,created_by_legacy_user_id FROM social_content_briefs WHERE tenant_id=$1 AND organization_id=$2 AND id=$3 FOR UPDATE`,
            [context.tenantId, context.organizationId, id.data],
          );
          if (brief.rowCount !== 1) throw new Error("SOCIAL_BRIEF_NOT_FOUND");
          const current = brief.rows[0];
          const evidence = socialHash({
            briefId: id.data,
            briefVersion: current.version,
            reviewerId: context.legacyUserId,
            ...body.data,
          });
          const replay = await client.query<{
            evidence_sha256: string;
            decision: string;
          }>(
            `SELECT evidence_sha256,decision FROM social_content_reviews WHERE tenant_id=$1 AND request_key=$2`,
            [context.tenantId, body.data.requestKey],
          );
          if (replay.rowCount === 1) {
            if (replay.rows[0].evidence_sha256 !== evidence)
              throw new Error("SOCIAL_REVIEW_IDEMPOTENCY_CONFLICT");
            return { replay: true, decision: replay.rows[0].decision };
          }
          if (current.status !== "IN_REVIEW")
            throw new Error("SOCIAL_REVIEW_STATE_CONFLICT");
          if (current.created_by_legacy_user_id === context.legacyUserId)
            throw new Error("SOCIAL_REVIEW_MAKER_CHECKER_REQUIRED");
          await client.query(
            `INSERT INTO social_content_reviews (id,tenant_id,organization_id,brief_id,brief_version,reviewer_legacy_user_id,decision,reason,request_key,evidence_sha256) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
              nextSocialId(),
              context.tenantId,
              context.organizationId,
              id.data,
              current.version,
              context.legacyUserId,
              body.data.decision,
              body.data.reason ?? null,
              body.data.requestKey,
              evidence,
            ],
          );
          await client.query(
            `UPDATE social_content_briefs SET status=$4,reviewed_by_legacy_user_id=$5,reviewed_at=now(),updated_at=now() WHERE tenant_id=$1 AND organization_id=$2 AND id=$3`,
            [
              context.tenantId,
              context.organizationId,
              id.data,
              body.data.decision === "APPROVE" ? "APPROVED" : "REJECTED",
              context.legacyUserId,
            ],
          );
          const result = { replay: false, decision: body.data.decision };
          await appendSocialOperationReceipt(client, context, {
            operation: "REVIEW_SOCIAL_BRIEF",
            entityType: "social_content_brief",
            entityId: id.data,
            requestKey: body.data.requestKey,
            payload: { briefId: id.data, ...body.data },
            result,
          });
          return result;
        },
      );
      await bestEffortAudit(
        req.user!.id,
        "review_social_content_brief",
        "social_content_brief",
        undefined,
        { socialBriefId: id.data, ...result },
        req.ip,
      );
      res.json(result);
    } catch (error: any) {
      if (error?.code === "23505") {
        res.status(409).json({ error: "SOCIAL_REVIEW_CONFLICT" });
        return;
      }
      sendFailure(res, error);
    }
  },
);

router.get(
  "/social/publications",
  requireAuth,
  requirePermission("social.view"),
  async (req, res) => {
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(50),
        status: z
          .enum([
            "DRAFT",
            "PENDING_APPROVAL",
            "APPROVED",
            "REJECTED",
            "QUEUED",
            "RUNNING",
            "PUBLISHED",
            "FAILED",
            "DEAD_LETTER",
            "CANCELED",
          ])
          .optional(),
      })
      .safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "SOCIAL_PUBLICATION_QUERY_INVALID" });
      return;
    }
    try {
      const rows = await withSocialOperationsContext(
        req.user!.id,
        "read",
        async (client, context) =>
          (
            await client.query(
              `SELECT intent.id,intent.brief_id,intent.account_id,intent.scheduled_for,
                      intent.status,intent.attempt_count,intent.max_attempts,intent.next_attempt_at,
                      intent.last_error_code,intent.published_at,intent.created_by_legacy_user_id,
                      intent.approved_by_legacy_user_id,intent.created_at,intent.updated_at,
                      brief.title,brief.content_kind,account.provider,account.display_name AS account_name
               FROM social_publication_intents intent
               JOIN social_content_briefs brief ON brief.tenant_id=intent.tenant_id AND brief.id=intent.brief_id
               JOIN social_accounts account ON account.tenant_id=intent.tenant_id AND account.id=intent.account_id
               WHERE intent.tenant_id=$1 AND intent.organization_id=$2
                 AND ($3::text IS NULL OR intent.status=$3)
               ORDER BY intent.created_at DESC,intent.id DESC LIMIT $4`,
              [
                context.tenantId,
                context.organizationId,
                query.data.status ?? null,
                query.data.limit,
              ],
            )
          ).rows,
      );
      res.setHeader("Cache-Control", "private, no-store");
      res.json({ data: rows, limit: query.data.limit });
    } catch (error) {
      sendFailure(res, error);
    }
  },
);

router.post(
  "/social/publications",
  requireAuth,
  requirePermission("social.manage"),
  async (req, res) => {
    const body = publicationBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({
        error: "SOCIAL_PUBLICATION_INVALID",
        issues: body.error.flatten(),
      });
      return;
    }
    try {
      const row = await withSocialOperationsContext(
        req.user!.id,
        "manage",
        async (client, context) => {
          const replay = await findSocialOperationReplay(
            client,
            context,
            body.data.requestKey,
            body.data,
          );
          if (replay) return replay;
          const source = await client.query<{
            brief_status: string;
            account_status: string;
            content_kind: string;
            media_refs: Array<{ kind: "image" | "video"; ref: string }>;
          }>(
            `SELECT brief.status AS brief_status,account.status AS account_status,
                    brief.content_kind,brief.media_refs
             FROM social_content_briefs brief
             JOIN social_accounts account ON account.tenant_id=brief.tenant_id
               AND account.organization_id=brief.organization_id AND account.id=$4
             WHERE brief.tenant_id=$1 AND brief.organization_id=$2 AND brief.id=$3
             FOR UPDATE OF brief,account`,
            [
              context.tenantId,
              context.organizationId,
              body.data.briefId,
              body.data.accountId,
            ],
          );
          if (source.rowCount !== 1)
            throw new Error("SOCIAL_PUBLICATION_SOURCE_NOT_FOUND");
          if (source.rows[0].brief_status !== "APPROVED")
            throw new Error("SOCIAL_PUBLICATION_BRIEF_NOT_APPROVED");
          if (source.rows[0].account_status !== "VERIFIED")
            throw new Error("SOCIAL_PUBLICATION_ACCOUNT_NOT_VERIFIED");
          assertSocialContentMedia(
            source.rows[0].content_kind,
            source.rows[0].media_refs,
          );
          const id = nextSocialId();
          const created = (
            await client.query(
              `INSERT INTO social_publication_intents
                 (id,tenant_id,organization_id,brief_id,account_id,scheduled_for,status,idempotency_key,max_attempts,created_by_legacy_user_id)
               VALUES ($1,$2,$3,$4,$5,$6,'DRAFT',$7,$8,$9)
               RETURNING *`,
              [
                id,
                context.tenantId,
                context.organizationId,
                body.data.briefId,
                body.data.accountId,
                new Date(body.data.scheduledFor),
                body.data.requestKey,
                body.data.maxAttempts,
                context.legacyUserId,
              ],
            )
          ).rows[0];
          await appendSocialOperationReceipt(client, context, {
            operation: "CREATE_SOCIAL_PUBLICATION",
            entityType: "social_publication_intent",
            entityId: id,
            requestKey: body.data.requestKey,
            payload: body.data,
            result: created,
          });
          return created;
        },
      );
      await bestEffortAudit(
        req.user!.id,
        "create_social_publication_intent",
        "social_publication_intent",
        undefined,
        { socialPublicationIntentId: row.id },
        req.ip,
      );
      res.status(201).json(row);
    } catch (error: any) {
      if (error?.code === "23505") {
        res.status(409).json({ error: "SOCIAL_PUBLICATION_CONFLICT" });
        return;
      }
      sendFailure(res, error);
    }
  },
);

router.post(
  "/social/publications/:id/submit",
  requireAuth,
  requirePermission("social.manage"),
  async (req, res) => {
    const id = uuidSchema.safeParse(req.params.id);
    const body = submitBodySchema.safeParse(req.body);
    if (!id.success || !body.success) {
      res.status(400).json({ error: "SOCIAL_PUBLICATION_SUBMIT_INVALID" });
      return;
    }
    try {
      const row = await withSocialOperationsContext(
        req.user!.id,
        "manage",
        async (client, context) => {
          const payload = { publicationId: id.data };
          const replay = await findSocialOperationReplay(
            client,
            context,
            body.data.requestKey,
            payload,
          );
          if (replay) return replay;
          const changed = await client.query(
            `UPDATE social_publication_intents SET status='PENDING_APPROVAL',updated_at=now()
             WHERE tenant_id=$1 AND organization_id=$2 AND id=$3 AND status='DRAFT'
             RETURNING *`,
            [context.tenantId, context.organizationId, id.data],
          );
          if (changed.rowCount !== 1)
            throw new Error("SOCIAL_PUBLICATION_NOT_FOUND_OR_CONFLICT");
          const result = changed.rows[0];
          await appendSocialOperationReceipt(client, context, {
            operation: "SUBMIT_SOCIAL_PUBLICATION",
            entityType: "social_publication_intent",
            entityId: id.data,
            requestKey: body.data.requestKey,
            payload,
            result,
          });
          return result;
        },
      );
      await bestEffortAudit(
        req.user!.id,
        "submit_social_publication_intent",
        "social_publication_intent",
        undefined,
        { socialPublicationIntentId: id.data },
        req.ip,
      );
      res.json(row);
    } catch (error) {
      sendFailure(res, error);
    }
  },
);

router.post(
  "/social/publications/:id/review",
  requireAuth,
  requirePermission("social.approve"),
  async (req, res) => {
    const id = uuidSchema.safeParse(req.params.id);
    const body = reviewBodySchema.safeParse(req.body);
    if (!id.success || !body.success) {
      res.status(400).json({ error: "SOCIAL_PUBLICATION_REVIEW_INVALID" });
      return;
    }
    try {
      const result = await withSocialOperationsContext(
        req.user!.id,
        "manage",
        async (client, context) => {
          const intent = await client.query<{
            status: string;
            created_by_legacy_user_id: number;
            scheduled_for: string;
          }>(
            `SELECT status,created_by_legacy_user_id,scheduled_for
             FROM social_publication_intents
             WHERE tenant_id=$1 AND organization_id=$2 AND id=$3 FOR UPDATE`,
            [context.tenantId, context.organizationId, id.data],
          );
          if (intent.rowCount !== 1)
            throw new Error("SOCIAL_PUBLICATION_NOT_FOUND");
          const current = intent.rows[0];
          const evidence = socialHash({
            publicationId: id.data,
            reviewerId: context.legacyUserId,
            ...body.data,
          });
          const replay = await client.query<{
            evidence_sha256: string;
            decision: string;
          }>(
            `SELECT evidence_sha256,decision FROM social_publication_reviews
             WHERE tenant_id=$1 AND request_key=$2`,
            [context.tenantId, body.data.requestKey],
          );
          if (replay.rowCount === 1) {
            if (replay.rows[0].evidence_sha256 !== evidence)
              throw new Error("SOCIAL_PUBLICATION_REVIEW_IDEMPOTENCY_CONFLICT");
            return { replay: true, decision: replay.rows[0].decision };
          }
          if (current.status !== "PENDING_APPROVAL")
            throw new Error("SOCIAL_PUBLICATION_REVIEW_STATE_CONFLICT");
          if (current.created_by_legacy_user_id === context.legacyUserId)
            throw new Error("SOCIAL_PUBLICATION_MAKER_CHECKER_REQUIRED");
          await client.query(
            `INSERT INTO social_publication_reviews
               (id,tenant_id,organization_id,publication_intent_id,reviewer_legacy_user_id,decision,reason,request_key,evidence_sha256)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [
              nextSocialId(),
              context.tenantId,
              context.organizationId,
              id.data,
              context.legacyUserId,
              body.data.decision,
              body.data.reason ?? null,
              body.data.requestKey,
              evidence,
            ],
          );
          if (body.data.decision === "APPROVE") {
            await client.query(
              `UPDATE social_publication_intents
               SET status='APPROVED',approved_by_legacy_user_id=$4,
                   next_attempt_at=GREATEST(scheduled_for,now()),updated_at=now()
               WHERE tenant_id=$1 AND organization_id=$2 AND id=$3`,
              [
                context.tenantId,
                context.organizationId,
                id.data,
                context.legacyUserId,
              ],
            );
          } else {
            await client.query(
              `UPDATE social_publication_intents
               SET status='REJECTED',approved_by_legacy_user_id=$4,updated_at=now()
               WHERE tenant_id=$1 AND organization_id=$2 AND id=$3`,
              [
                context.tenantId,
                context.organizationId,
                id.data,
                context.legacyUserId,
              ],
            );
          }
          const answer = { replay: false, decision: body.data.decision };
          await appendSocialOperationReceipt(client, context, {
            operation: "REVIEW_SOCIAL_PUBLICATION",
            entityType: "social_publication_intent",
            entityId: id.data,
            requestKey: body.data.requestKey,
            payload: { publicationId: id.data, ...body.data },
            result: answer,
          });
          return answer;
        },
      );
      await bestEffortAudit(
        req.user!.id,
        "review_social_publication_intent",
        "social_publication_intent",
        undefined,
        { socialPublicationIntentId: id.data, ...result },
        req.ip,
      );
      res.json(result);
    } catch (error: any) {
      if (error?.code === "23505") {
        res.status(409).json({ error: "SOCIAL_PUBLICATION_REVIEW_CONFLICT" });
        return;
      }
      sendFailure(res, error);
    }
  },
);

router.get(
  "/social/publications/:id/attempts",
  requireAuth,
  requirePermission("social.view"),
  async (req, res) => {
    const id = uuidSchema.safeParse(req.params.id);
    if (!id.success) {
      res.status(400).json({ error: "SOCIAL_PUBLICATION_ID_INVALID" });
      return;
    }
    try {
      const rows = await withSocialOperationsContext(
        req.user!.id,
        "read",
        async (client, context) =>
          (
            await client.query(
              `SELECT attempt_number,worker_id,runtime_release_id,outcome,error_code,
                      started_at,completed_at,created_at
               FROM social_publication_attempts
               WHERE tenant_id=$1 AND organization_id=$2 AND publication_intent_id=$3
               ORDER BY attempt_number DESC LIMIT 12`,
              [context.tenantId, context.organizationId, id.data],
            )
          ).rows,
      );
      res.setHeader("Cache-Control", "private, no-store");
      res.json({ data: rows });
    } catch (error) {
      sendFailure(res, error);
    }
  },
);

router.post(
  "/social/publications/:id/cancel",
  requireAuth,
  requirePermission("social.manage"),
  async (req, res) => {
    const id = uuidSchema.safeParse(req.params.id);
    const body = submitBodySchema.safeParse(req.body);
    if (!id.success || !body.success) {
      res.status(400).json({ error: "SOCIAL_PUBLICATION_CANCEL_INVALID" });
      return;
    }
    try {
      const row = await withSocialOperationsContext(
        req.user!.id,
        "manage",
        async (client, context) => {
          const payload = { publicationId: id.data, action: "CANCEL" };
          const replay = await findSocialOperationReplay(
            client,
            context,
            body.data.requestKey,
            payload,
          );
          if (replay) return replay;
          const changed = await client.query(
            `UPDATE social_publication_intents
             SET status='CANCELED',next_attempt_at=NULL,updated_at=now()
             WHERE tenant_id=$1 AND organization_id=$2 AND id=$3
               AND status IN ('DRAFT','PENDING_APPROVAL','APPROVED','QUEUED','FAILED')
             RETURNING *`,
            [context.tenantId, context.organizationId, id.data],
          );
          if (changed.rowCount !== 1)
            throw new Error("SOCIAL_PUBLICATION_NOT_FOUND_OR_CONFLICT");
          const result = changed.rows[0];
          await appendSocialOperationReceipt(client, context, {
            operation: "CANCEL_SOCIAL_PUBLICATION",
            entityType: "social_publication_intent",
            entityId: id.data,
            requestKey: body.data.requestKey,
            payload,
            result,
          });
          return result;
        },
      );
      await bestEffortAudit(
        req.user!.id,
        "cancel_social_publication_intent",
        "social_publication_intent",
        undefined,
        { socialPublicationIntentId: id.data },
        req.ip,
      );
      res.json(row);
    } catch (error) {
      sendFailure(res, error);
    }
  },
);

router.get(
  "/social/performance",
  requireAuth,
  requirePermission("social.view"),
  async (req, res) => {
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(100) })
      .safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "SOCIAL_PERFORMANCE_QUERY_INVALID" });
      return;
    }
    try {
      const rows = await withSocialOperationsContext(
        req.user!.id,
        "read",
        async (client, context) =>
          (
            await client.query(
              `WITH latest AS (
                 SELECT DISTINCT ON (snapshot.publication_intent_id)
                        snapshot.publication_intent_id,snapshot.metrics,snapshot.observed_at
                 FROM social_performance_snapshots snapshot
                 WHERE snapshot.tenant_id=$1 AND snapshot.organization_id=$2
                 ORDER BY snapshot.publication_intent_id,snapshot.observed_at DESC,snapshot.created_at DESC
               )
               SELECT intent.id AS publication_id,brief.title,account.provider,
                      account.display_name AS account_name,intent.published_at,
                      state.status AS sync_status,state.next_sync_at,state.last_success_at,
                      state.last_error_code,state.consecutive_failure_count,
                      latest.metrics,latest.observed_at
               FROM social_publication_intents intent
               JOIN social_content_briefs brief
                 ON brief.tenant_id=intent.tenant_id AND brief.id=intent.brief_id
               JOIN social_accounts account
                 ON account.tenant_id=intent.tenant_id AND account.id=intent.account_id
               LEFT JOIN social_performance_sync_state state
                 ON state.tenant_id=intent.tenant_id AND state.publication_intent_id=intent.id
               LEFT JOIN latest ON latest.publication_intent_id=intent.id
               WHERE intent.tenant_id=$1 AND intent.organization_id=$2
                 AND intent.status='PUBLISHED'
               ORDER BY COALESCE(latest.observed_at,intent.published_at) DESC,intent.id DESC
               LIMIT $3`,
              [context.tenantId, context.organizationId, query.data.limit],
            )
          ).rows,
      );
      res.setHeader("Cache-Control", "private, no-store");
      res.json({
        data: rows,
        providerConnectionGate: providerConnectionGate(),
        performanceGate: performanceGate(),
        performanceWorkerEnabled: performanceGate().workerEnabled,
      });
    } catch (error) {
      sendFailure(res, error);
    }
  },
);

router.post(
  "/social/performance/:id/sync",
  requireAuth,
  requirePermission("social.manage"),
  async (req, res) => {
    const id = uuidSchema.safeParse(req.params.id);
    const body = submitBodySchema.safeParse(req.body);
    if (!id.success || !body.success) {
      res.status(400).json({ error: "SOCIAL_PERFORMANCE_SYNC_INVALID" });
      return;
    }
    const payload = { publicationId: id.data, action: "REQUEST_SYNC" };
    try {
      const result = await withSocialOperationsContext(
        req.user!.id,
        "manage",
        async (client, context) => {
          const replay = await findSocialOperationReplay(
            client,
            context,
            body.data.requestKey,
            payload,
          );
          if (replay) return replay;
          const intent = await client.query(
            `SELECT id FROM social_publication_intents
             WHERE tenant_id=$1 AND organization_id=$2 AND id=$3
               AND status='PUBLISHED' FOR UPDATE`,
            [context.tenantId, context.organizationId, id.data],
          );
          if (intent.rowCount !== 1)
            throw new Error("SOCIAL_PERFORMANCE_PUBLICATION_NOT_FOUND");
          await client.query(
            `INSERT INTO social_performance_sync_state
               (tenant_id,organization_id,publication_intent_id,status,next_sync_at)
             VALUES ($1,$2,$3,'PENDING',now())
             ON CONFLICT (tenant_id,publication_intent_id) DO UPDATE
             SET status='ACTIVE',next_sync_at=now(),consecutive_failure_count=0,
                 last_error_code=NULL,last_error_at=NULL,updated_at=now()
             WHERE social_performance_sync_state.status <> 'RUNNING'`,
            [context.tenantId, context.organizationId, id.data],
          );
          const state = await client.query(
            `SELECT status,next_sync_at,last_success_at,last_error_code
             FROM social_performance_sync_state
             WHERE tenant_id=$1 AND organization_id=$2 AND publication_intent_id=$3`,
            [context.tenantId, context.organizationId, id.data],
          );
          if (state.rowCount !== 1 || state.rows[0].status === "RUNNING")
            throw new Error("SOCIAL_PERFORMANCE_SYNC_ALREADY_RUNNING");
          const answer = {
            publicationId: id.data,
            status: state.rows[0].status,
            nextSyncAt: state.rows[0].next_sync_at,
          };
          await appendSocialOperationReceipt(client, context, {
            operation: "REQUEST_SOCIAL_PERFORMANCE_SYNC",
            entityType: "social_publication_intent",
            entityId: id.data,
            requestKey: body.data.requestKey,
            payload,
            result: answer,
          });
          return answer;
        },
      );
      await bestEffortAudit(
        req.user!.id,
        "request_social_performance_sync",
        "social_publication_intent",
        undefined,
        { socialPublicationIntentId: id.data },
        req.ip,
      );
      res.json(result);
    } catch (error) {
      sendFailure(res, error);
    }
  },
);

export default router;
