import { Router, type IRouter, type Response } from "express";
import { z } from "zod";
import { requireAuth, requirePermission, logAudit } from "../lib/auth";
import {
  appendSocialOperationReceipt,
  findSocialOperationReplay,
  nextSocialId,
  socialHash,
  socialOperationsConfiguration,
  withSocialOperationsContext,
} from "../lib/socialOperationsStore";
import {
  resolveSocialProviderConnectionGate,
  resolveSocialPublicationGate,
} from "../lib/socialOperationsContract";
import { verifySocialAccount } from "../lib/socialPublisherAdapter";

const router: IRouter = Router();
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
    scheduledFor: z.string().datetime({ offset: true }).optional(),
    utm: z
      .object({
        source: z.string().trim().max(128).optional(),
        medium: z.string().trim().max(128).optional(),
        campaign: z.string().trim().max(128).optional(),
        term: z.string().trim().max(128).optional(),
        content: z.string().trim().max(128).optional(),
      })
      .strict()
      .optional(),
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
    integrationKey: z
      .string()
      .trim()
      .max(96)
      .regex(/^[a-z][a-z0-9._:-]+$/)
      .optional(),
    externalAccountRef: z.string().trim().min(1).max(512).optional(),
  })
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
  if (code.includes("NOT_FOUND")) return 404;
  if (
    code.includes("CONFLICT") ||
    code.includes("MAKER_CHECKER") ||
    code.includes("NOT_APPROVED") ||
    code.includes("NOT_VERIFIED") ||
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
          const [briefs, accounts, intents, recent] = await Promise.all([
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
              `SELECT id,title,content_kind,channels,locales,status,scheduled_for,created_by_legacy_user_id,reviewed_by_legacy_user_id,created_at,updated_at FROM social_content_briefs WHERE tenant_id=$1 AND organization_id=$2 ORDER BY scheduled_for ASC NULLS LAST, created_at DESC LIMIT 100`,
              [context.tenantId, context.organizationId],
            ),
          ]);
          return {
            briefCounts: briefs.rows,
            accountCounts: accounts.rows,
            publicationCounts: intents.rows,
            briefs: recent.rows,
            publishingEnabled: publicationGate().enabled,
            publicationGate: publicationGate(),
            providerConnectionGate: providerConnectionGate(),
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
      SELECT id,provider,account_key,display_name,integration_key,status,
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
          const id = nextSocialId();
          const created = (
            await client.query(
              `
      INSERT INTO social_accounts (id,tenant_id,organization_id,provider,account_key,display_name,integration_key,external_account_ref_hash,status,created_by_legacy_user_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'CONNECTED_UNVERIFIED',$9)
      RETURNING id,provider,account_key,display_name,integration_key,status,created_at,updated_at
    `,
              [
                id,
                context.tenantId,
                context.organizationId,
                parsed.data.provider,
                parsed.data.accountKey,
                parsed.data.displayName,
                parsed.data.integrationKey ?? null,
                parsed.data.externalAccountRef
                  ? socialHash(parsed.data.externalAccountRef)
                  : null,
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
          const id = nextSocialId();
          const created = (
            await client.query(
              `
      INSERT INTO social_content_briefs (id,tenant_id,organization_id,title,objective,audience,content_kind,locales,channels,campaign_key,caption,utm,scheduled_for,created_by_legacy_user_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14)
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
                JSON.stringify(parsed.data.utm ?? {}),
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
          }>(
            `SELECT brief.status AS brief_status,account.status AS account_status
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
        performanceWorkerEnabled:
          process.env.SOCIAL_PERFORMANCE_WORKER_ENABLED?.trim().toLowerCase() ===
          "true",
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
