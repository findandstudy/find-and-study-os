import { Router, type IRouter } from "express";
import { db, integrationsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth, requireRole, logAudit } from "../lib/auth";
import { ADMIN_ROLES } from "../lib/roles";
import Anthropic from "@anthropic-ai/sdk";
import { clearConfigCache } from "@workspace/integrations-anthropic-ai";
import { createSmtpTransporter, invalidateSmtpCache } from "../lib/email";
import crypto from "crypto";
import { isLiveIntegrationsEnabled, liveModeReason } from "../lib/inbox/liveMode";
import { resolveZernioWhatsAppAccount, listZernioWhatsAppTemplates } from "../lib/inbox/zernioTemplates";
import { encryptConfig, decryptConfig } from "../lib/encryption";
import { maskSecrets, mergeConfig } from "../lib/configMasking";
import { META_API_VERSION } from "../lib/inbox/channels/meta-shared";
import { clearDocumentAiConnectionCache, isAnthropicConnectionKey } from "../lib/documentAiConnection";
import { simulatedIntegrationTestResult, unsupportedIntegrationTestResult } from "../lib/integrationTestResult";

const router: IRouter = Router();

const LIVE_GATED_KEYS = new Set(["whatsapp", "web_form", "facebook_messenger", "instagram", "zernio"]);

router.get("/integrations/live-mode", requireAuth, requireRole(...ADMIN_ROLES), async (_req, res): Promise<void> => {
  res.json({ live: isLiveIntegrationsEnabled(), reason: liveModeReason() });
});

router.get("/integrations", requireAuth, requireRole(...ADMIN_ROLES), async (_req, res): Promise<void> => {
  const integrations = await db
    .select()
    .from(integrationsTable)
    .orderBy(integrationsTable.category, integrationsTable.name);

  const masked = integrations.map((i) => ({
    ...i,
    config: maskSecrets(decryptConfig(i.config as Record<string, any>)),
  }));

  res.json({ data: masked });
});

router.get("/integrations/:key", requireAuth, requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const [integration] = await db
    .select()
    .from(integrationsTable)
    .where(eq(integrationsTable.key, String(req.params.key)));

  if (!integration) {
    res.status(404).json({ error: "Integration not found" });
    return;
  }

  res.json({
    ...integration,
    config: maskSecrets(decryptConfig(integration.config as Record<string, any>)),
  });
});

router.put("/integrations/:key", requireAuth, requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const key = String(req.params.key).trim().toLowerCase();
  const { name, category, isEnabled, config } = req.body;

  if (!name || !category) {
    res.status(400).json({ error: "Name and category are required" });
    return;
  }

  if ((key.startsWith("claude:") || key.startsWith("anthropic:")) && !isAnthropicConnectionKey(key)) {
    res.status(400).json({ error: "Invalid Anthropic connection key" });
    return;
  }
  if (isAnthropicConnectionKey(key) && category !== "ai") {
    res.status(400).json({ error: "Anthropic connections must use the ai category" });
    return;
  }

  if (LIVE_GATED_KEYS.has(key) && isEnabled === true && !isLiveIntegrationsEnabled()) {
    res.status(403).json({
      error: "live_integrations_disabled",
      message:
        "This integration can only be enabled in production. Set NODE_ENV=production or ALLOW_LIVE_INTEGRATIONS=true.",
    });
    return;
  }

  // WhatsApp cannot be enabled without an app secret — webhook signature
  // verification is mandatory and would reject every inbound otherwise.
  if (key === "whatsapp" && isEnabled === true) {
    const incomingCfg = (config || {}) as Record<string, any>;
    // We need the merged plaintext to validate; pull existing decrypted state.
    const existingForCheck = (await db.select().from(integrationsTable).where(eq(integrationsTable.key, key)))[0];
    const existingPlainCfg = existingForCheck ? decryptConfig(existingForCheck.config as Record<string, any>) : {};
    const merged = { ...existingPlainCfg, ...incomingCfg };
    if (!merged.appSecret || !merged.webhookVerifyToken) {
      res.status(400).json({
        error: "whatsapp_secrets_required",
        message: "WhatsApp cannot be enabled without both an App Secret and a Webhook Verify Token (required to authenticate inbound webhooks).",
      });
      return;
    }
  }

  const [existing] = await db
    .select()
    .from(integrationsTable)
    .where(eq(integrationsTable.key, key));

  let result;
  if (existing) {
    // Decrypt the stored config before merging so masked-incoming detection works on plaintext.
    const existingPlain = decryptConfig(existing.config as Record<string, any>);
    const mergedConfig = mergeConfig(existingPlain, config || {});
    if (key === "web_form" && !mergedConfig.formId) mergedConfig.formId = crypto.randomUUID();
    if (key === "web_form" && !mergedConfig.secret) mergedConfig.secret = crypto.randomBytes(24).toString("hex");
    const toStore = encryptConfig(mergedConfig);
    [result] = await db
      .update(integrationsTable)
      .set({
        name,
        category,
        isEnabled: isEnabled ?? existing.isEnabled,
        config: toStore,
      })
      .where(eq(integrationsTable.key, key))
      .returning();
  } else {
    const initialConfig: Record<string, any> = { ...(config || {}) };
    if (key === "web_form") {
      if (!initialConfig.formId) initialConfig.formId = crypto.randomUUID();
      if (!initialConfig.secret) initialConfig.secret = crypto.randomBytes(24).toString("hex");
    }
    const toStore = encryptConfig(initialConfig);
    [result] = await db
      .insert(integrationsTable)
      .values({ key, name, category, isEnabled: isEnabled ?? false, config: toStore })
      .returning();
  }

  if (isAnthropicConnectionKey(key)) {
    clearConfigCache();
    clearDocumentAiConnectionCache();
  }
  if (key === "smtp") invalidateSmtpCache();
  await logAudit(req.user!.id, "update_integration", "integration", result.id, { key, isEnabled: result.isEnabled }, req.ip);
  res.json({ ...result, config: maskSecrets(decryptConfig(result.config as Record<string, any>)) });
});

router.patch("/integrations/:key/toggle", requireAuth, requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const integrationKey = String(req.params.key).trim().toLowerCase();
  const [existing] = await db
    .select()
    .from(integrationsTable)
    .where(eq(integrationsTable.key, integrationKey));

  if (!existing) {
    res.status(404).json({ error: "Integration not found" });
    return;
  }

  const willEnable = !existing.isEnabled;
  if (LIVE_GATED_KEYS.has(String(req.params.key)) && willEnable && !isLiveIntegrationsEnabled()) {
    res.status(403).json({
      error: "live_integrations_disabled",
      message:
        "This integration can only be enabled in production. Set NODE_ENV=production or ALLOW_LIVE_INTEGRATIONS=true.",
    });
    return;
  }

  // Same WA secrets check as PUT — toggling must not bypass mandatory creds.
  if (String(req.params.key) === "whatsapp" && willEnable) {
    const plain = decryptConfig(existing.config as Record<string, any>);
    if (!plain.appSecret || !plain.webhookVerifyToken) {
      res.status(400).json({
        error: "whatsapp_secrets_required",
        message: "WhatsApp cannot be enabled without both an App Secret and a Webhook Verify Token (required to authenticate inbound webhooks).",
      });
      return;
    }
  }

  const [result] = await db
    .update(integrationsTable)
    .set({ isEnabled: willEnable })
    .where(eq(integrationsTable.key, integrationKey))
    .returning();

  if (isAnthropicConnectionKey(integrationKey)) {
    clearConfigCache();
    clearDocumentAiConnectionCache();
  }
  if (integrationKey === "smtp") invalidateSmtpCache();
  await logAudit(req.user!.id, "toggle_integration", "integration", result.id, { key: integrationKey, isEnabled: result.isEnabled }, req.ip);
  res.json({ ...result, config: maskSecrets(decryptConfig(result.config as Record<string, any>)) });
});

router.post("/integrations/:key/test", requireAuth, requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const [integration] = await db
    .select()
    .from(integrationsTable)
    .where(eq(integrationsTable.key, String(req.params.key)));

  if (!integration) {
    res.status(404).json({ error: "Integration not found" });
    return;
  }

  const config = decryptConfig(integration.config as Record<string, any>);

  if (isAnthropicConnectionKey(String(req.params.key).trim().toLowerCase())) {
    if (!config.apiKey) {
      res.json({ success: false, message: "API key is not configured" });
      return;
    }
    try {
      const client = new Anthropic({ apiKey: config.apiKey, timeout: 15_000, maxRetries: 0 });
      await client.messages.create({
        model: config.model || "claude-sonnet-4-6",
        max_tokens: 5,
        messages: [{ role: "user", content: "Hi" }],
      });
      res.json({ success: true, message: "Connection test passed — Anthropic API key is valid" });
    } catch (err: any) {
      const msg = err?.status === 401
        ? "Invalid API key"
        : err?.status === 429
          ? "Rate limited — but API key is valid"
          : `Connection failed: ${err?.message || "Unknown error"}`;
      const success = err?.status === 429;
      res.json({ success, message: msg });
    }
    return;
  }

  if (String(req.params.key) === "smtp") {
    if (!config.host || !config.username || !config.password) {
      res.json({ success: false, message: "SMTP host, username, and password are required" });
      return;
    }
    try {
      const transporter = await createSmtpTransporter({
        host: config.host,
        port: parseInt(config.port, 10) || 587,
        username: config.username,
        password: config.password,
      });
      await transporter.verify();
      res.json({ success: true, message: "SMTP connection verified successfully" });
    } catch (err: any) {
      res.json({ success: false, message: `SMTP connection failed: ${err?.message || "Unknown error"}` });
    }
    return;
  }

  if (String(req.params.key) === "whatsapp") {
    if (!isLiveIntegrationsEnabled()) {
      res.json(simulatedIntegrationTestResult("Live credential check was skipped; simulated mode is not health evidence."));
      return;
    }
    if (!config.phoneNumberId || !config.accessToken) {
      res.json({ success: false, message: "Phone Number ID and Access Token are required" });
      return;
    }
    try {
      const r = await fetch(
        `https://graph.facebook.com/v20.0/${encodeURIComponent(config.phoneNumberId)}`,
        { headers: { Authorization: `Bearer ${config.accessToken}` } },
      );
      if (r.ok) {
        res.json({ success: true, message: "WhatsApp Cloud API credentials verified" });
      } else {
        const body = await r.text();
        res.json({ success: false, message: `WhatsApp test failed (${r.status}): ${body.slice(0, 200)}` });
      }
    } catch (err: any) {
      res.json({ success: false, message: `WhatsApp test failed: ${err?.message || "Unknown error"}` });
    }
    return;
  }

  if (String(req.params.key) === "facebook_messenger") {
    if (!isLiveIntegrationsEnabled()) {
      res.json(simulatedIntegrationTestResult("Live credential check was skipped; simulated mode is not health evidence."));
      return;
    }
    if (!config.pageId || !config.pageAccessToken) {
      res.json({ success: false, message: "Page ID and Page Access Token are required" });
      return;
    }
    try {
      const r = await fetch(
        `https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(config.pageId)}?fields=name`,
        { headers: { Authorization: `Bearer ${config.pageAccessToken}` } },
      );
      const data: unknown = await r.json().catch(() => ({}));
      if (r.ok) {
        const name = typeof (data as { name?: unknown }).name === "string" ? (data as { name: string }).name : undefined;
        res.json({ success: true, message: name ? `Messenger connected — Page: ${name}` : "Messenger credentials verified" });
      } else {
        const errMsg = (data as { error?: { message?: string } })?.error?.message || `HTTP ${r.status}`;
        res.json({ success: false, message: `Messenger test failed (${r.status}): ${errMsg}` });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      res.json({ success: false, message: `Messenger test failed: ${msg}` });
    }
    return;
  }

  if (String(req.params.key) === "instagram") {
    if (!isLiveIntegrationsEnabled()) {
      res.json(simulatedIntegrationTestResult("Live credential check was skipped; simulated mode is not health evidence."));
      return;
    }
    if (!config.igBusinessAccountId || !config.pageAccessToken) {
      res.json({ success: false, message: "Instagram Business Account ID and Page Access Token are required" });
      return;
    }
    try {
      const r = await fetch(
        `https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(config.igBusinessAccountId)}?fields=username`,
        { headers: { Authorization: `Bearer ${config.pageAccessToken}` } },
      );
      const data: unknown = await r.json().catch(() => ({}));
      if (r.ok) {
        const username = typeof (data as { username?: unknown }).username === "string" ? (data as { username: string }).username : undefined;
        res.json({ success: true, message: username ? `Instagram connected — @${username}` : "Instagram credentials verified" });
      } else {
        const errMsg = (data as { error?: { message?: string } })?.error?.message || `HTTP ${r.status}`;
        res.json({ success: false, message: `Instagram test failed (${r.status}): ${errMsg}` });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      res.json({ success: false, message: `Instagram test failed: ${msg}` });
    }
    return;
  }

  if (String(req.params.key) === "web_form") {
    if (!config.formId || !config.secret) {
      res.json({ success: false, message: "Web form has no formId/secret yet — save first to generate" });
      return;
    }
    if (!isLiveIntegrationsEnabled()) {
      res.json(simulatedIntegrationTestResult("Web form configuration exists, but live submission was not verified."));
      return;
    }
    res.json({ success: true, verified: true, simulated: false, status: "verified", message: "Web form is live — submissions will be accepted." });
    return;
  }

  if (String(req.params.key) === "zernio") {
    if (!config.apiKey || !config.webhookSecret) {
      res.json({ success: false, message: "API Key and Webhook Secret are required" });
      return;
    }
    if (!isLiveIntegrationsEnabled()) {
      res.json(simulatedIntegrationTestResult("Live credential check was skipped; simulated mode is not health evidence."));
      return;
    }
    try {
      const acct = await resolveZernioWhatsAppAccount();
      if (!acct) {
        res.json({ success: false, message: "Zernio accountId çözülemedi — önce WhatsApp channel account'ı kaydet/bağla." });
        return;
      }
      const outcome = await listZernioWhatsAppTemplates(acct.externalAccountId);
      if (outcome.ok) {
        res.json({ success: true, message: "Zernio API key doğrulandı (WhatsApp templates erişilebilir)." });
      } else {
        const clean = String(outcome.error || "").trim().startsWith("<")
          ? `HTTP hata (HTML yanıt)`
          : (outcome.error || "unknown").slice(0, 200);
        res.json({ success: false, message: `Zernio test failed: ${clean}` });
      }
    } catch (err: any) {
      res.json({ success: false, message: `Zernio test failed: ${err?.message || "Unknown error"}` });
    }
    return;
  }

  res.json(unsupportedIntegrationTestResult("No real connection verifier is implemented for this integration."));
});

export default router;
