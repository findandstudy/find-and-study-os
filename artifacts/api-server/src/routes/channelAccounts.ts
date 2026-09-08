/**
 * Multi-account-per-channel CRUD (Task #554).
 *
 * Admin-only management of the rows in `channel_accounts`. Each channel
 * (whatsapp / messenger / instagram) can have more than one connected account,
 * each independently toggleable, with exactly one default per channel. The
 * legacy single-config `integrations` row is left untouched so the
 * null-channelAccountId fallback (resolveOutboundConfig / resolveInboundAccount)
 * keeps working for existing conversations and fresh deploys.
 *
 * Credential storage mirrors the integrations surface: secrets are masked on
 * the way out (maskSecrets), merged on the way in (mergeConfig — a masked value
 * containing "•" is treated as unchanged), and stored AES-256-GCM encrypted via
 * serializeAccountConfig. Nothing here ever persists a masked placeholder.
 */
import { Router, type IRouter } from "express";
import { db, channelAccountsTable, conversationsTable } from "@workspace/db";
import { and, eq, ne, asc } from "drizzle-orm";
import { requireAuth, requireRole, logAudit } from "../lib/auth";
import { ADMIN_ROLES } from "../lib/roles";
import { isLiveIntegrationsEnabled } from "../lib/inbox/liveMode";
import { META_API_VERSION } from "../lib/inbox/channels/meta-shared";
import { simulatedIntegrationTestResult, unsupportedIntegrationTestResult } from "../lib/integrationTestResult";
import { maskSecrets, mergeConfig } from "../lib/configMasking";
import { parseAccountConfig, serializeAccountConfig } from "../lib/inbox/channelAccountConfig";
import { getZernioApiKey, resolveZernioProfileId } from "../lib/inbox/zernioSend";

const router: IRouter = Router();

const SUPPORTED_CHANNELS = new Set(["whatsapp", "messenger", "instagram"]);

/** Derive the channel-native external account id from a plain config object. */
function deriveExternalAccountId(channel: string, config: Record<string, any>): string | null {
  if (channel === "whatsapp") return config.phoneNumberId || null;
  if (channel === "messenger") return config.pageId || null;
  if (channel === "instagram") return config.igBusinessAccountId || config.pageId || null;
  return null;
}

/** Serialize a channel_accounts row for the client (config secrets masked). */
function serializeRow(row: typeof channelAccountsTable.$inferSelect): Record<string, any> {
  const metadata = row.metadata && typeof row.metadata === "object"
    ? row.metadata as Record<string, unknown>
    : {};
  return {
    id: row.id,
    channel: row.channel,
    provider: row.provider,
    displayName: row.displayName,
    externalAccountId: row.externalAccountId,
    config: maskSecrets(parseAccountConfig(row.configEncrypted)),
    status: row.status,
    isActive: row.isActive,
    isDefault: row.isDefault,
    brandLabel: typeof metadata.brandLabel === "string" ? metadata.brandLabel : null,
    brandColor: typeof metadata.brandColor === "string" ? metadata.brandColor : null,
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** List accounts, optionally filtered by ?channel=. */
router.get("/channel-accounts", requireAuth, requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const channel = typeof req.query.channel === "string" ? req.query.channel : undefined;
  const rows = channel
    ? await db.select().from(channelAccountsTable)
        .where(eq(channelAccountsTable.channel, channel))
        .orderBy(asc(channelAccountsTable.channel), asc(channelAccountsTable.id))
    : await db.select().from(channelAccountsTable)
        .orderBy(asc(channelAccountsTable.channel), asc(channelAccountsTable.id));
  res.json({ accounts: rows.map(serializeRow) });
});

/** Create a new account on a channel. */
router.post("/channel-accounts", requireAuth, requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const { channel, displayName, config, isActive, isDefault, brandLabel, brandColor } = req.body ?? {};
  if (typeof channel !== "string" || !SUPPORTED_CHANNELS.has(channel)) {
    res.status(400).json({ error: "Unsupported or missing channel" });
    return;
  }
  if (typeof displayName !== "string" || displayName.trim().length === 0) {
    res.status(400).json({ error: "displayName is required" });
    return;
  }
  const plainConfig = (config && typeof config === "object") ? config as Record<string, any> : {};
  const externalAccountId = deriveExternalAccountId(channel, plainConfig);

  // First account on a channel becomes the default automatically.
  const existing = await db.select({ id: channelAccountsTable.id })
    .from(channelAccountsTable)
    .where(eq(channelAccountsTable.channel, channel));
  const makeDefault = isDefault === true || existing.length === 0;
  const active = isActive === false ? false : true;
  if (brandColor != null && (typeof brandColor !== "string" || !/^#[0-9a-f]{6}$/i.test(brandColor))) {
    res.status(400).json({ error: "brandColor must be a six-digit hex color" });
    return;
  }

  const result = await db.transaction(async (tx) => {
    if (makeDefault) {
      await tx.update(channelAccountsTable)
        .set({ isDefault: false })
        .where(eq(channelAccountsTable.channel, channel));
    }
    const [row] = await tx.insert(channelAccountsTable).values({
      channel,
      displayName: displayName.trim(),
      externalAccountId,
      configEncrypted: serializeAccountConfig(plainConfig),
      status: active ? "active" : "inactive",
      isActive: active,
      isDefault: makeDefault,
      metadata: {
        ...(typeof brandLabel === "string" && brandLabel.trim() ? { brandLabel: brandLabel.trim().slice(0, 80) } : {}),
        ...(typeof brandColor === "string" ? { brandColor: brandColor.toUpperCase() } : {}),
      },
    }).returning();
    return row;
  });

  await logAudit(req.user!.id, "create_channel_account", "channel_account", result.id, { channel, displayName: result.displayName }, req.ip);
  res.status(201).json(serializeRow(result));
});

/** Update an account (name + merged config). */
router.put("/channel-accounts/:id", requireAuth, requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [existing] = await db.select().from(channelAccountsTable).where(eq(channelAccountsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Account not found" });
    return;
  }
  const { displayName, config, brandLabel, brandColor } = req.body ?? {};
  if (brandColor != null && (typeof brandColor !== "string" || !/^#[0-9a-f]{6}$/i.test(brandColor))) {
    res.status(400).json({ error: "brandColor must be a six-digit hex color" });
    return;
  }
  const existingPlain = parseAccountConfig(existing.configEncrypted);
  const mergedConfig = (config && typeof config === "object")
    ? mergeConfig(existingPlain, config as Record<string, any>)
    : existingPlain;
  // Some provider-backed accounts (notably legacy Zernio WhatsApp lines) keep
  // their stable routing identity in externalAccountId rather than in the
  // direct Meta config fields. Editing only the display label or brand color
  // must not erase that identity when phoneNumberId/pageId is absent.
  const externalAccountId = existing.provider === "zernio"
    ? existing.externalAccountId
    : deriveExternalAccountId(existing.channel, mergedConfig) || existing.externalAccountId;
  const existingMetadata = existing.metadata && typeof existing.metadata === "object"
    ? existing.metadata as Record<string, unknown>
    : {};
  const metadata = {
    ...existingMetadata,
    ...(brandLabel !== undefined ? { brandLabel: typeof brandLabel === "string" ? brandLabel.trim().slice(0, 80) : "" } : {}),
    ...(brandColor !== undefined ? { brandColor: typeof brandColor === "string" ? brandColor.toUpperCase() : "" } : {}),
  };

  const [result] = await db.update(channelAccountsTable).set({
    displayName: typeof displayName === "string" && displayName.trim().length > 0 ? displayName.trim() : existing.displayName,
    configEncrypted: serializeAccountConfig(mergedConfig),
    externalAccountId,
    metadata,
  }).where(eq(channelAccountsTable.id, id)).returning();

  await logAudit(req.user!.id, "update_channel_account", "channel_account", id, { channel: existing.channel }, req.ip);
  res.json(serializeRow(result));
});

/** Toggle active/inactive. */
router.patch("/channel-accounts/:id/toggle-active", requireAuth, requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [existing] = await db.select().from(channelAccountsTable).where(eq(channelAccountsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Account not found" });
    return;
  }
  const willActivate = !existing.isActive;
  const [result] = await db.update(channelAccountsTable).set({
    isActive: willActivate,
    status: willActivate ? "active" : "inactive",
  }).where(eq(channelAccountsTable.id, id)).returning();

  await logAudit(req.user!.id, "toggle_channel_account", "channel_account", id, { channel: existing.channel, isActive: result.isActive }, req.ip);
  res.json(serializeRow(result));
});

/** Set this account as the channel default (clears the previous default). */
router.patch("/channel-accounts/:id/set-default", requireAuth, requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [existing] = await db.select().from(channelAccountsTable).where(eq(channelAccountsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Account not found" });
    return;
  }
  const result = await db.transaction(async (tx) => {
    await tx.update(channelAccountsTable)
      .set({ isDefault: false })
      .where(and(eq(channelAccountsTable.channel, existing.channel), ne(channelAccountsTable.id, id)));
    const [row] = await tx.update(channelAccountsTable)
      .set({ isDefault: true })
      .where(eq(channelAccountsTable.id, id))
      .returning();
    return row;
  });

  await logAudit(req.user!.id, "set_default_channel_account", "channel_account", id, { channel: existing.channel }, req.ip);
  res.json(serializeRow(result));
});

/** Delete an account. If it was the default, promote the oldest remaining one. */
router.delete("/channel-accounts/:id", requireAuth, requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [existing] = await db.select().from(channelAccountsTable).where(eq(channelAccountsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Account not found" });
    return;
  }
  const [linkedConversation] = await db
    .select({ id: conversationsTable.id })
    .from(conversationsTable)
    .where(eq(conversationsTable.channelAccountId, id))
    .limit(1);
  if (linkedConversation) {
    res.status(409).json({
      error: "account_has_conversations",
      message: "This account has linked conversations and cannot be deleted until they are reassigned.",
    });
    return;
  }
  await db.transaction(async (tx) => {
    await tx.delete(channelAccountsTable).where(eq(channelAccountsTable.id, id));
    if (existing.isDefault) {
      const [next] = await tx.select().from(channelAccountsTable)
        .where(eq(channelAccountsTable.channel, existing.channel))
        .orderBy(asc(channelAccountsTable.id));
      if (next) {
        await tx.update(channelAccountsTable)
          .set({ isDefault: true })
          .where(eq(channelAccountsTable.id, next.id));
      }
    }
  });

  await logAudit(req.user!.id, "delete_channel_account", "channel_account", id, { channel: existing.channel }, req.ip);
  res.json({ ok: true });
});

/** Test an account's live credentials (mirrors the integrations test logic). */
router.post("/channel-accounts/:id/test", requireAuth, requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [existing] = await db.select().from(channelAccountsTable).where(eq(channelAccountsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Account not found" });
    return;
  }
  const config = parseAccountConfig(existing.configEncrypted);

  if (!isLiveIntegrationsEnabled()) {
    res.json(simulatedIntegrationTestResult("Live credential check was skipped; simulated mode is not health evidence."));
    return;
  }

  if (existing.provider === "zernio") {
    const apiKey = await getZernioApiKey();
    if (!apiKey) {
      res.json({ success: false, message: "Zernio API key is not configured" });
      return;
    }
    if (!existing.externalAccountId) {
      res.json({ success: false, message: "Zernio account ID is missing" });
      return;
    }
    const resolved = await resolveZernioProfileId(apiKey, existing.externalAccountId);
    res.json(resolved.id
      ? { success: true, message: "Zernio WhatsApp account verified" }
      : { success: false, message: resolved.error || "Zernio WhatsApp account could not be verified" });
    return;
  }

  if (existing.channel === "whatsapp") {
    if (!config.phoneNumberId || !config.accessToken) {
      res.json({ success: false, message: "Phone Number ID and Access Token are required" });
      return;
    }
    try {
      const r = await fetch(
        `https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(config.phoneNumberId)}`,
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

  if (existing.channel === "messenger") {
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

  if (existing.channel === "instagram") {
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

  res.json(unsupportedIntegrationTestResult("No real connection verifier is implemented for this account type."));
});

export default router;
