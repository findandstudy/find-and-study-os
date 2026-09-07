import { Router, type IRouter, type Response } from "express";
import { z } from "zod";
import { requireAuth, requirePermission, logAudit } from "../lib/auth";
import { checkAndIncrementRateLimit } from "../lib/pgRateLimiter";
import {
  assertSocialAdvertisingBudget,
  nextSocialId,
  normalizeSocialAdCountryCodes,
  normalizeSocialAdDestinationUrl,
  resolveSocialAdvertisingGate,
  socialHash,
} from "../lib/socialOperationsContract";
import {
  appendSocialOperationReceipt,
  findSocialOperationReplay,
  withSocialOperationsContext,
} from "../lib/socialOperationsStore";

const router: IRouter = Router();
const uuidSchema = z.string().uuid();
const requestKeySchema = z
  .string()
  .min(8)
  .max(160)
  .regex(/^[A-Za-z0-9._:-]+$/);
const campaignListQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(100).default(50) })
  .strict();
const campaignBodySchema = z
  .object({
    requestKey: requestKeySchema,
    accountId: uuidSchema,
    briefId: uuidSchema,
    name: z.string().trim().min(1).max(160),
    objective: z.enum([
      "AWARENESS",
      "TRAFFIC",
      "LEADS",
      "CONVERSIONS",
      "VIDEO_VIEWS",
    ]),
    destinationUrl: z.string().trim().min(10).max(2048),
    countryCodes: z.array(z.string().trim()).min(1).max(25),
    languageCodes: z
      .array(
        z
          .string()
          .trim()
          .regex(/^[a-z]{2}(?:-[A-Z]{2})?$/),
      )
      .max(20)
      .default([]),
    ageMin: z.number().int().min(18).max(65),
    ageMax: z.number().int().min(18).max(65),
    currencyCode: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/),
    dailyBudgetMinor: z.number().int().min(1).max(1_000_000_000_000),
    lifetimeBudgetMinor: z.number().int().min(1).max(1_000_000_000_000),
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }),
    maxAttempts: z.number().int().min(1).max(8).default(5),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.ageMax < value.ageMin)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ageMax"],
        message: "Maximum age must not be lower than minimum age",
      });
    if (new Set(value.languageCodes).size !== value.languageCodes.length)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["languageCodes"],
        message: "Duplicate language codes are not allowed",
      });
  });
const actionBodySchema = z
  .object({
    requestKey: requestKeySchema,
    action: z.enum(["PAUSE", "RESUME", "UPDATE_BUDGET", "END"]),
    dailyBudgetMinor: z.number().int().min(1).max(1_000_000_000_000).optional(),
    lifetimeBudgetMinor: z
      .number()
      .int()
      .min(1)
      .max(1_000_000_000_000)
      .optional(),
    maxAttempts: z.number().int().min(1).max(8).default(5),
  })
  .strict()
  .superRefine((value, context) => {
    const hasBudgets =
      value.dailyBudgetMinor !== undefined ||
      value.lifetimeBudgetMinor !== undefined;
    if (
      (value.action === "UPDATE_BUDGET" &&
        (value.dailyBudgetMinor === undefined ||
          value.lifetimeBudgetMinor === undefined)) ||
      (value.action !== "UPDATE_BUDGET" && hasBudgets)
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["action"],
        message: "Budget values are required only for UPDATE_BUDGET",
      });
  });
const reviewBodySchema = z
  .object({
    requestKey: requestKeySchema,
    decision: z.enum(["APPROVE", "REJECT"]),
    reason: z.string().trim().max(2000).optional(),
  })
  .strict();
const cancelBodySchema = z.object({ requestKey: requestKeySchema }).strict();

function advertisingGate() {
  return resolveSocialAdvertisingGate({
    workerEnabled: process.env.SOCIAL_AD_WORKER_ENABLED,
    connectivityEnabled: process.env.SOCIAL_PROVIDER_CONNECTIVITY_ENABLED,
    providerAdvertisingEnabled: process.env.SOCIAL_PROVIDER_ADVERTISING_ENABLED,
    allowLiveIntegrations: process.env.ALLOW_LIVE_INTEGRATIONS,
    providerAllowlist: process.env.SOCIAL_AD_PROVIDER_ALLOWLIST,
    maximumCampaignBudgetMinor: process.env.SOCIAL_AD_MAX_CAMPAIGN_BUDGET_MINOR,
  });
}

async function audit(...args: Parameters<typeof logAudit>): Promise<void> {
  try {
    await logAudit(...args);
  } catch {
    console.error("[social-advertising-audit-projection] failed");
  }
}

function failureStatus(error: unknown): number {
  const code = error instanceof Error ? error.message : "SOCIAL_AD_FAILED";
  if (!/^SOCIAL_[A-Z0-9_]{2,96}$/.test(code)) return 500;
  if (code.includes("NOT_FOUND")) return 404;
  if (code.includes("READ_ONLY")) return 403;
  if (code.includes("BUDGET_LIMIT_INVALID")) return 503;
  if (
    code.includes("INVALID") ||
    code.includes("DESTINATION") ||
    code.includes("COUNTRY_CODES") ||
    code.includes("BUDGET_LIMIT_EXCEEDED")
  )
    return 400;
  if (
    code.includes("CONFLICT") ||
    code.includes("REQUIRED") ||
    code.includes("NOT_VERIFIED") ||
    code.includes("NOT_ENABLED") ||
    code.includes("LIMIT_REACHED")
  )
    return 409;
  if (code.includes("DISABLED") || code.includes("SCOPE_UNAVAILABLE"))
    return 503;
  return 500;
}

function sendFailure(res: Response, error: unknown): void {
  const code = error instanceof Error ? error.message : "SOCIAL_AD_FAILED";
  const status = failureStatus(error);
  if (status === 500) console.error("[social-advertising] request failed");
  const publicCode = status === 500 ? "SOCIAL_AD_FAILED" : code;
  res.status(status).json({ error: publicCode, code: publicCode });
}

async function allowSocialAdMutation(userId: number): Promise<boolean> {
  return checkAndIncrementRateLimit(
    `social-ad-mutation:${userId}`,
    120,
    60 * 60_000,
  );
}

function assertCampaignSchedule(startsAt: Date, endsAt: Date): void {
  const now = Date.now();
  if (
    !Number.isFinite(startsAt.getTime()) ||
    !Number.isFinite(endsAt.getTime()) ||
    startsAt.getTime() < now + 5 * 60_000 ||
    endsAt.getTime() <= startsAt.getTime() ||
    endsAt.getTime() > startsAt.getTime() + 180 * 86_400_000
  )
    throw new Error("SOCIAL_AD_SCHEDULE_INVALID");
}

function actionAllowed(action: string, status: string): boolean {
  return (
    (action === "PAUSE" && status === "ACTIVE") ||
    (action === "RESUME" && status === "PAUSED") ||
    (action === "UPDATE_BUDGET" && ["ACTIVE", "PAUSED"].includes(status)) ||
    (action === "END" && ["ACTIVE", "PAUSED"].includes(status))
  );
}

router.get(
  "/social/ad-campaigns",
  requireAuth,
  requirePermission("social.view"),
  async (req, res) => {
    const query = campaignListQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "SOCIAL_AD_QUERY_INVALID" });
      return;
    }
    try {
      const data = await withSocialOperationsContext(
        req.user!.id,
        "read",
        async (client, context) =>
          (
            await client.query(
              `SELECT campaign.id,campaign.account_id,campaign.brief_id,
                      account.display_name AS account_name,campaign.provider,
                      campaign.name,campaign.objective,campaign.destination_url,
                      campaign.country_codes,campaign.language_codes,campaign.age_min,
                      campaign.age_max,campaign.currency_code,
                      campaign.current_daily_budget_minor,
                      campaign.current_lifetime_budget_minor,
                      campaign.starts_at,campaign.ends_at,campaign.status,
                      campaign.last_error_code,campaign.created_by_legacy_user_id,
                      campaign.approved_by_legacy_user_id,campaign.approved_at,
                      campaign.created_at,campaign.updated_at,
                      latest.id AS latest_operation_id,
                      latest.operation_type AS latest_operation_type,
                      latest.status AS latest_operation_status,
                      latest.created_by_legacy_user_id AS latest_operation_creator
               FROM social_ad_campaigns campaign
               JOIN social_accounts account
                 ON account.tenant_id=campaign.tenant_id AND account.id=campaign.account_id
               LEFT JOIN LATERAL (
                 SELECT operation.id,operation.operation_type,operation.status,
                        operation.created_by_legacy_user_id
                 FROM social_ad_operations operation
                 WHERE operation.tenant_id=campaign.tenant_id
                   AND operation.organization_id=campaign.organization_id
                   AND operation.campaign_id=campaign.id
                 ORDER BY operation.created_at DESC,operation.id DESC LIMIT 1
               ) latest ON true
               WHERE campaign.tenant_id=$1 AND campaign.organization_id=$2
               ORDER BY campaign.created_at DESC,campaign.id DESC LIMIT $3`,
              [context.tenantId, context.organizationId, query.data.limit],
            )
          ).rows,
      );
      res.setHeader("Cache-Control", "private, no-store");
      res.json({ data, advertisingGate: advertisingGate() });
    } catch (error) {
      sendFailure(res, error);
    }
  },
);

router.post(
  "/social/ad-campaigns",
  requireAuth,
  requirePermission("social.manage"),
  async (req, res) => {
    const body = campaignBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({
        error: "SOCIAL_AD_CAMPAIGN_INVALID",
        issues: body.error.flatten(),
      });
      return;
    }
    const allowed = await checkAndIncrementRateLimit(
      `social-ad-campaign-create:${req.user!.id}`,
      30,
      60 * 60_000,
    );
    if (!allowed) {
      res.status(429).json({ error: "SOCIAL_AD_RATE_LIMITED" });
      return;
    }
    try {
      const gate = advertisingGate();
      if (gate.maximumCampaignBudgetMinor === null)
        throw new Error("SOCIAL_AD_BUDGET_LIMIT_INVALID");
      assertSocialAdvertisingBudget({
        dailyBudgetMinor: body.data.dailyBudgetMinor,
        lifetimeBudgetMinor: body.data.lifetimeBudgetMinor,
        maximumCampaignBudgetMinor: gate.maximumCampaignBudgetMinor,
      });
      const startsAt = new Date(body.data.startsAt);
      const endsAt = new Date(body.data.endsAt);
      assertCampaignSchedule(startsAt, endsAt);
      const destinationUrl = normalizeSocialAdDestinationUrl(
        body.data.destinationUrl,
      );
      const countryCodes = normalizeSocialAdCountryCodes(
        body.data.countryCodes,
      );
      const result = await withSocialOperationsContext(
        req.user!.id,
        "manage",
        async (client, context) => {
          const payload = {
            ...body.data,
            destinationUrl,
            countryCodes,
          };
          const replay = await findSocialOperationReplay(
            client,
            context,
            body.data.requestKey,
            payload,
          );
          if (replay) return replay;
          const account = await client.query<{
            provider: string;
            status: string;
            account_kind: string;
            currency_code: string | null;
            integration_key: string | null;
          }>(
            `SELECT provider,status,account_kind,currency_code,integration_key
             FROM social_accounts
             WHERE tenant_id=$1 AND organization_id=$2 AND id=$3 FOR SHARE`,
            [context.tenantId, context.organizationId, body.data.accountId],
          );
          if (account.rowCount !== 1)
            throw new Error("SOCIAL_AD_ACCOUNT_NOT_FOUND");
          const selectedAccount = account.rows[0];
          if (
            selectedAccount.status !== "VERIFIED" ||
            selectedAccount.account_kind !== "AD_ACCOUNT"
          )
            throw new Error("SOCIAL_AD_ACCOUNT_NOT_VERIFIED");
          if (!selectedAccount.integration_key)
            throw new Error("SOCIAL_AD_INTEGRATION_NOT_ENABLED");
          if (selectedAccount.currency_code !== body.data.currencyCode)
            throw new Error("SOCIAL_AD_CURRENCY_CONFLICT");
          const integration = await client.query(
            `SELECT 1 FROM integrations
             WHERE key=$1 AND is_enabled=true AND lower(category) IN ('social','social_media')`,
            [selectedAccount.integration_key],
          );
          if (integration.rowCount !== 1)
            throw new Error("SOCIAL_AD_INTEGRATION_NOT_ENABLED");
          const brief = await client.query<{
            status: string;
            content_kind: string;
          }>(
            `SELECT status,content_kind FROM social_content_briefs
             WHERE tenant_id=$1 AND organization_id=$2 AND id=$3 FOR SHARE`,
            [context.tenantId, context.organizationId, body.data.briefId],
          );
          if (brief.rowCount !== 1)
            throw new Error("SOCIAL_AD_BRIEF_NOT_FOUND");
          if (
            brief.rows[0].status !== "APPROVED" ||
            brief.rows[0].content_kind !== "AD_CREATIVE"
          )
            throw new Error("SOCIAL_AD_BRIEF_NOT_APPROVED");
          const openCount = await client.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM social_ad_campaigns
             WHERE tenant_id=$1 AND organization_id=$2
               AND status NOT IN ('COMPLETED','REJECTED','FAILED','CANCELED')`,
            [context.tenantId, context.organizationId],
          );
          if ((openCount.rows[0]?.count ?? 0) >= 500)
            throw new Error("SOCIAL_AD_OPEN_CAMPAIGN_LIMIT_REACHED");
          const campaignId = nextSocialId();
          const operationId = nextSocialId();
          const definition = {
            accountId: body.data.accountId,
            briefId: body.data.briefId,
            provider: selectedAccount.provider,
            name: body.data.name,
            objective: body.data.objective,
            destinationUrl,
            countryCodes,
            languageCodes: body.data.languageCodes,
            ageMin: body.data.ageMin,
            ageMax: body.data.ageMax,
            currencyCode: body.data.currencyCode,
            dailyBudgetMinor: body.data.dailyBudgetMinor,
            lifetimeBudgetMinor: body.data.lifetimeBudgetMinor,
            startsAt: body.data.startsAt,
            endsAt: body.data.endsAt,
          };
          const created = (
            await client.query(
              `INSERT INTO social_ad_campaigns
                 (id,tenant_id,organization_id,account_id,brief_id,provider,name,
                  objective,destination_url,country_codes,language_codes,age_min,age_max,
                  currency_code,requested_daily_budget_minor,
                  requested_lifetime_budget_minor,current_daily_budget_minor,
                  current_lifetime_budget_minor,starts_at,ends_at,status,
                  definition_sha256,created_by_legacy_user_id)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
                       $15,$16,$17,$18,'PENDING_APPROVAL',$19,$20)
               RETURNING id,account_id,brief_id,provider,name,objective,destination_url,
                         country_codes,language_codes,age_min,age_max,currency_code,
                         current_daily_budget_minor,current_lifetime_budget_minor,
                         starts_at,ends_at,status,created_by_legacy_user_id,created_at,updated_at`,
              [
                campaignId,
                context.tenantId,
                context.organizationId,
                body.data.accountId,
                body.data.briefId,
                selectedAccount.provider,
                body.data.name,
                body.data.objective,
                destinationUrl,
                countryCodes,
                body.data.languageCodes,
                body.data.ageMin,
                body.data.ageMax,
                body.data.currencyCode,
                body.data.dailyBudgetMinor,
                body.data.lifetimeBudgetMinor,
                startsAt,
                endsAt,
                socialHash(definition),
                context.legacyUserId,
              ],
            )
          ).rows[0];
          await client.query(
            `INSERT INTO social_ad_operations
               (id,tenant_id,organization_id,campaign_id,operation_type,
                requested_daily_budget_minor,requested_lifetime_budget_minor,
                status,request_key,payload_sha256,max_attempts,
                created_by_legacy_user_id)
             VALUES ($1,$2,$3,$4,'CREATE',$5,$6,'PENDING_APPROVAL',$7,$8,$9,$10)`,
            [
              operationId,
              context.tenantId,
              context.organizationId,
              campaignId,
              body.data.dailyBudgetMinor,
              body.data.lifetimeBudgetMinor,
              body.data.requestKey,
              socialHash(payload),
              body.data.maxAttempts,
              context.legacyUserId,
            ],
          );
          const answer = {
            ...created,
            latest_operation_id: operationId,
            latest_operation_type: "CREATE",
            latest_operation_status: "PENDING_APPROVAL",
            replay: false,
          };
          await appendSocialOperationReceipt(client, context, {
            operation: "CREATE_SOCIAL_AD_CAMPAIGN",
            entityType: "social_ad_campaign",
            entityId: campaignId,
            requestKey: body.data.requestKey,
            payload,
            result: answer,
          });
          return answer;
        },
      );
      await audit(
        req.user!.id,
        "create_social_ad_campaign",
        "social_ad_campaign",
        undefined,
        { socialAdCampaignId: result.id, provider: result.provider },
        req.ip,
      );
      res.status(201).json(result);
    } catch (error: any) {
      if (error?.code === "23505") {
        res.status(409).json({ error: "SOCIAL_AD_CAMPAIGN_CONFLICT" });
        return;
      }
      sendFailure(res, error);
    }
  },
);

router.post(
  "/social/ad-campaigns/:id/actions",
  requireAuth,
  requirePermission("social.manage"),
  async (req, res) => {
    const id = uuidSchema.safeParse(req.params.id);
    const body = actionBodySchema.safeParse(req.body);
    if (!id.success || !body.success) {
      res.status(400).json({ error: "SOCIAL_AD_ACTION_INVALID" });
      return;
    }
    if (!(await allowSocialAdMutation(req.user!.id))) {
      res.status(429).json({ error: "SOCIAL_AD_RATE_LIMITED" });
      return;
    }
    try {
      const gate = advertisingGate();
      if (body.data.action === "UPDATE_BUDGET")
        assertSocialAdvertisingBudget({
          dailyBudgetMinor: body.data.dailyBudgetMinor!,
          lifetimeBudgetMinor: body.data.lifetimeBudgetMinor!,
          maximumCampaignBudgetMinor: gate.maximumCampaignBudgetMinor,
        });
      const result = await withSocialOperationsContext(
        req.user!.id,
        "manage",
        async (client, context) => {
          const payload = { campaignId: id.data, ...body.data };
          const replay = await findSocialOperationReplay(
            client,
            context,
            body.data.requestKey,
            payload,
          );
          if (replay) return replay;
          const campaign = await client.query<{ status: string }>(
            `SELECT status FROM social_ad_campaigns
             WHERE tenant_id=$1 AND organization_id=$2 AND id=$3 FOR UPDATE`,
            [context.tenantId, context.organizationId, id.data],
          );
          if (campaign.rowCount !== 1)
            throw new Error("SOCIAL_AD_CAMPAIGN_NOT_FOUND");
          if (!actionAllowed(body.data.action, campaign.rows[0].status))
            throw new Error("SOCIAL_AD_CAMPAIGN_STATE_CONFLICT");
          const operationId = nextSocialId();
          const created = (
            await client.query(
              `INSERT INTO social_ad_operations
                 (id,tenant_id,organization_id,campaign_id,operation_type,
                  requested_daily_budget_minor,requested_lifetime_budget_minor,
                  status,request_key,payload_sha256,max_attempts,
                  created_by_legacy_user_id)
               VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING_APPROVAL',$8,$9,$10,$11)
               RETURNING id,campaign_id,operation_type,requested_daily_budget_minor,
                         requested_lifetime_budget_minor,status,attempt_count,
                         max_attempts,created_by_legacy_user_id,created_at,updated_at`,
              [
                operationId,
                context.tenantId,
                context.organizationId,
                id.data,
                body.data.action,
                body.data.dailyBudgetMinor ?? null,
                body.data.lifetimeBudgetMinor ?? null,
                body.data.requestKey,
                socialHash(payload),
                body.data.maxAttempts,
                context.legacyUserId,
              ],
            )
          ).rows[0];
          const answer = { ...created, replay: false };
          await appendSocialOperationReceipt(client, context, {
            operation: "CREATE_SOCIAL_AD_ACTION",
            entityType: "social_ad_operation",
            entityId: operationId,
            requestKey: body.data.requestKey,
            payload,
            result: answer,
          });
          return answer;
        },
      );
      await audit(
        req.user!.id,
        "create_social_ad_action",
        "social_ad_operation",
        undefined,
        { socialAdOperationId: result.id, action: result.operation_type },
        req.ip,
      );
      res.status(201).json(result);
    } catch (error: any) {
      if (error?.code === "23505") {
        res.status(409).json({ error: "SOCIAL_AD_OPERATION_IN_FLIGHT" });
        return;
      }
      sendFailure(res, error);
    }
  },
);

router.post(
  "/social/ad-operations/:id/review",
  requireAuth,
  requirePermission("social.approve"),
  async (req, res) => {
    const id = uuidSchema.safeParse(req.params.id);
    const body = reviewBodySchema.safeParse(req.body);
    if (!id.success || !body.success) {
      res.status(400).json({ error: "SOCIAL_AD_REVIEW_INVALID" });
      return;
    }
    if (body.data.decision === "REJECT" && !body.data.reason) {
      res.status(400).json({ error: "SOCIAL_AD_REJECTION_REASON_REQUIRED" });
      return;
    }
    if (!(await allowSocialAdMutation(req.user!.id))) {
      res.status(429).json({ error: "SOCIAL_AD_RATE_LIMITED" });
      return;
    }
    try {
      const result = await withSocialOperationsContext(
        req.user!.id,
        "manage",
        async (client, context) => {
          const payload = { operationId: id.data, ...body.data };
          const replay = await findSocialOperationReplay(
            client,
            context,
            body.data.requestKey,
            payload,
          );
          if (replay) return replay;
          const operation = await client.query<{
            campaign_id: string;
            operation_type: string;
            status: string;
            created_by_legacy_user_id: number;
            campaign_status: string;
          }>(
            `SELECT operation.campaign_id,operation.operation_type,operation.status,
                    operation.created_by_legacy_user_id,
                    campaign.status AS campaign_status
             FROM social_ad_operations operation
             JOIN social_ad_campaigns campaign
               ON campaign.tenant_id=operation.tenant_id AND campaign.id=operation.campaign_id
             WHERE operation.tenant_id=$1 AND operation.organization_id=$2
               AND operation.id=$3 FOR UPDATE OF operation,campaign`,
            [context.tenantId, context.organizationId, id.data],
          );
          if (operation.rowCount !== 1)
            throw new Error("SOCIAL_AD_OPERATION_NOT_FOUND");
          const current = operation.rows[0];
          if (current.status !== "PENDING_APPROVAL")
            throw new Error("SOCIAL_AD_REVIEW_STATE_CONFLICT");
          if (current.created_by_legacy_user_id === context.legacyUserId)
            throw new Error("SOCIAL_AD_MAKER_CHECKER_REQUIRED");
          if (
            current.operation_type === "CREATE"
              ? current.campaign_status !== "PENDING_APPROVAL"
              : !actionAllowed(current.operation_type, current.campaign_status)
          )
            throw new Error("SOCIAL_AD_CAMPAIGN_STATE_CONFLICT");
          const nextStatus =
            body.data.decision === "APPROVE" ? "APPROVED" : "REJECTED";
          await client.query(
            `INSERT INTO social_ad_operation_reviews
               (id,tenant_id,organization_id,operation_id,reviewer_legacy_user_id,
                decision,reason,request_key,evidence_sha256)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [
              nextSocialId(),
              context.tenantId,
              context.organizationId,
              id.data,
              context.legacyUserId,
              body.data.decision,
              body.data.decision === "REJECT" ? body.data.reason : null,
              body.data.requestKey,
              socialHash(payload),
            ],
          );
          await client.query(
            `UPDATE social_ad_operations
             SET status=$4,approved_by_legacy_user_id=$5,approved_at=now(),
                 rejection_reason=$6,next_attempt_at=$7,updated_at=now()
             WHERE tenant_id=$1 AND organization_id=$2 AND id=$3`,
            [
              context.tenantId,
              context.organizationId,
              id.data,
              nextStatus,
              context.legacyUserId,
              body.data.decision === "REJECT" ? body.data.reason : null,
              body.data.decision === "APPROVE" ? new Date() : null,
            ],
          );
          if (current.operation_type === "CREATE") {
            await client.query(
              `UPDATE social_ad_campaigns
               SET status=$4,approved_by_legacy_user_id=$5,approved_at=now(),updated_at=now()
               WHERE tenant_id=$1 AND organization_id=$2 AND id=$3`,
              [
                context.tenantId,
                context.organizationId,
                current.campaign_id,
                nextStatus,
                context.legacyUserId,
              ],
            );
          }
          const answer = {
            id: id.data,
            campaignId: current.campaign_id,
            operationType: current.operation_type,
            status: nextStatus,
            replay: false,
          };
          await appendSocialOperationReceipt(client, context, {
            operation: "REVIEW_SOCIAL_AD_OPERATION",
            entityType: "social_ad_operation",
            entityId: id.data,
            requestKey: body.data.requestKey,
            payload,
            result: answer,
          });
          return answer;
        },
      );
      await audit(
        req.user!.id,
        "review_social_ad_operation",
        "social_ad_operation",
        undefined,
        { socialAdOperationId: id.data, status: result.status },
        req.ip,
      );
      res.json(result);
    } catch (error: any) {
      if (error?.code === "23505") {
        res.status(409).json({ error: "SOCIAL_AD_REVIEW_CONFLICT" });
        return;
      }
      sendFailure(res, error);
    }
  },
);

router.post(
  "/social/ad-operations/:id/cancel",
  requireAuth,
  requirePermission("social.manage"),
  async (req, res) => {
    const id = uuidSchema.safeParse(req.params.id);
    const body = cancelBodySchema.safeParse(req.body);
    if (!id.success || !body.success) {
      res.status(400).json({ error: "SOCIAL_AD_CANCEL_INVALID" });
      return;
    }
    if (!(await allowSocialAdMutation(req.user!.id))) {
      res.status(429).json({ error: "SOCIAL_AD_RATE_LIMITED" });
      return;
    }
    try {
      const result = await withSocialOperationsContext(
        req.user!.id,
        "manage",
        async (client, context) => {
          const payload = { operationId: id.data };
          const replay = await findSocialOperationReplay(
            client,
            context,
            body.data.requestKey,
            payload,
          );
          if (replay) return replay;
          const current = await client.query<{
            campaign_id: string;
            operation_type: string;
            status: string;
          }>(
            `SELECT campaign_id,operation_type,status FROM social_ad_operations
             WHERE tenant_id=$1 AND organization_id=$2 AND id=$3 FOR UPDATE`,
            [context.tenantId, context.organizationId, id.data],
          );
          if (current.rowCount !== 1)
            throw new Error("SOCIAL_AD_OPERATION_NOT_FOUND");
          if (
            !["PENDING_APPROVAL", "APPROVED", "FAILED"].includes(
              current.rows[0].status,
            )
          )
            throw new Error("SOCIAL_AD_CANCEL_STATE_CONFLICT");
          await client.query(
            `UPDATE social_ad_operations
             SET status='CANCELED',next_attempt_at=NULL,updated_at=now()
             WHERE tenant_id=$1 AND organization_id=$2 AND id=$3`,
            [context.tenantId, context.organizationId, id.data],
          );
          if (current.rows[0].operation_type === "CREATE")
            await client.query(
              `UPDATE social_ad_campaigns SET status='CANCELED',updated_at=now()
               WHERE tenant_id=$1 AND organization_id=$2 AND id=$3
                 AND status IN ('PENDING_APPROVAL','APPROVED')`,
              [
                context.tenantId,
                context.organizationId,
                current.rows[0].campaign_id,
              ],
            );
          const answer = { id: id.data, status: "CANCELED", replay: false };
          await appendSocialOperationReceipt(client, context, {
            operation: "CANCEL_SOCIAL_AD_OPERATION",
            entityType: "social_ad_operation",
            entityId: id.data,
            requestKey: body.data.requestKey,
            payload,
            result: answer,
          });
          return answer;
        },
      );
      await audit(
        req.user!.id,
        "cancel_social_ad_operation",
        "social_ad_operation",
        undefined,
        { socialAdOperationId: id.data },
        req.ip,
      );
      res.json(result);
    } catch (error) {
      sendFailure(res, error);
    }
  },
);

router.get(
  "/social/ad-operations/:id/attempts",
  requireAuth,
  requirePermission("social.view"),
  async (req, res) => {
    const id = uuidSchema.safeParse(req.params.id);
    if (!id.success) {
      res.status(400).json({ error: "SOCIAL_AD_OPERATION_ID_INVALID" });
      return;
    }
    try {
      const data = await withSocialOperationsContext(
        req.user!.id,
        "read",
        async (client, context) =>
          (
            await client.query(
              `SELECT id,attempt_number,worker_id,runtime_release_id,outcome,
                      provider_state,error_code,started_at,completed_at,created_at
               FROM social_ad_operation_attempts
               WHERE tenant_id=$1 AND organization_id=$2 AND operation_id=$3
               ORDER BY attempt_number DESC LIMIT 50`,
              [context.tenantId, context.organizationId, id.data],
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

export default router;
