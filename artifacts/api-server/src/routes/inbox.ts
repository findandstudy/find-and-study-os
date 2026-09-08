import { Router, raw, type IRouter, type Request, type Response as ExpressResponse } from "express";
import {
  db,
  pool,
  conversationsTable,
  conversationParticipantsTable,
  messagesTable,
  messageReactionsTable,
  externalContactsTable,
  leadsTable,
  studentsTable,
  applicationsTable,
  agentsTable,
  usersTable,
  messageTemplatesTable,
  pipelineStagesTable,
  notesTable,
  followUpsTable,
  channelAccountsTable,
  integrationsTable,
  documentsTable,
  auditLogsTable,
} from "@workspace/db";
import type { ConversationAiSummary } from "@workspace/db";
import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import type { ExternalContact } from "@workspace/db";
import { z } from "zod";
import { RateLimiterPostgres } from "rate-limiter-flexible";
import { getAnthropicClient } from "@workspace/integrations-anthropic-ai";
import { documentAiScheduler } from "../lib/aiLaneScheduler";
import { getDocumentAiConnection } from "../lib/documentAiConnection";
import { validate, getValidated } from "../middlewares/validate";
import { requireAuth, requireRole, requireAgentStaffPermission, logAudit } from "../lib/auth";
import { toLatinUpper, normalizePhoneField, containsNonLatinLetter, NON_LATIN_NAME_CODE } from "../lib/textNormalize";
import { STAFF_ROLES, ADMIN_ROLES, isAgentRole } from "../lib/roles";
import { resolveIdentity } from "../lib/inbox/identityResolver";
import {
  sendWhatsAppText,
  sendWhatsAppTemplate,
  isWithin24hWindow,
  type WhatsAppConfig,
} from "../lib/inbox/channels/whatsapp";
import { sendMessengerText, type MessengerConfig } from "../lib/inbox/channels/messenger";
import { sendInstagramText, type InstagramConfig } from "../lib/inbox/channels/instagram";
import { isLiveIntegrationsEnabled } from "../lib/inbox/liveMode";
import { directOrigin } from "../lib/originHelper";
import { applyLeadAssignmentRules, cascadeLeadAssignment, cascadeStudentAssignment } from "../lib/leadAssignment";
import { userHasPermission } from "../lib/permissions";
import { dispatchNotification } from "../lib/notificationDispatcher";
import { sendEmail } from "../lib/email";
import { safeOutboundRequest } from "../lib/safeOutboundRequest";
import { resolveOutboundConfig } from "../lib/inbox/channelAccountConfig";
import { decryptConfig } from "../lib/encryption";
import { sendViaZernio, getZernioApiKey, resolveZernioAccount, sendZernioTemplate } from "../lib/inbox/zernioSend";
import { toE164 } from "../lib/inbox/phone";
import {
  backfillConversationAttachmentNames,
  parseContentDispositionFilename,
  persistAttachmentMeta,
} from "../lib/inbox/attachmentNames";
import { getChainOwner, syncConversationOwner, loadLink } from "../lib/inbox/assignmentSync";
import {
  findApprovedZernioTemplate,
  listZernioWhatsAppTemplates,
  createZernioWhatsAppTemplate,
  deleteZernioWhatsAppTemplate,
  decideWhatsAppTemplateDeletion,
  resolveApprovedZernioTemplate,
  resolveZernioWhatsAppAccount,
  countUnicodeCharacters,
  WHATSAPP_TEMPLATE_BODY_MAX_CHARACTERS,
} from "../lib/inbox/zernioTemplates";
import { sendZernioConversationMessage } from "../lib/inbox/outboundMessage";
import { resolveApplicationMessageTarget } from "../lib/inbox/quickContactTarget";
import {
  loadConversationTemplateVariableContext,
  loadEntityTemplateVariableContext,
  type MessageTemplateEntityType,
} from "../lib/inbox/templateVariableContext";
import {
  canonicalMessageTemplateVariable,
  extractNamedMessageTemplateVariables,
  resolveNamedMessageTemplateVariables,
  type MessageTemplateVariableContext,
} from "../lib/inbox/templateVariables";
import { inboxBus, type InboxBusEvent } from "../lib/inbox/eventBus";
import {
  aiAgentPatchRequiresSuperAdmin,
  getAiAgentConfig,
  stripAlreadyEnabledAiAgentControls,
  writeAiAgentConfig,
  aiAgentConfigPatchSchema,
} from "../lib/inbox/aiAgentConfig";
import { loadAnthropicModelOptions } from "../lib/inbox/aiAgentModels";
import {
  isAutoReplyChannelSupported,
  runBotReplyTest,
} from "../lib/inbox/botAutoReply";
import { readApplicationIntakeState } from "../lib/inbox/applicationIntakeOrchestrator";
import {
  executeApplicationIntakePendingActions,
  isApplicationIntakeActionsEnabled,
} from "../lib/inbox/applicationIntakeActions";
import {
  getProgramScopeSource,
  writeProgramScopeSource,
} from "../lib/inbox/knowledgeSources";
import {
  listRagSources,
  createRagSource,
  updateRagSource,
  deleteRagSource,
  reprocessRagSource,
} from "../lib/inbox/knowledgeSourcesAdmin";
import { requireAiBotId } from "../lib/inbox/aiBotRuntime";
import { ObjectStorageService } from "../lib/objectStorage";
import {
  WEB_CHAT_MEDIA_MAX_BYTES,
  WebChatMediaValidationError,
  readWebChatAttachments,
  validateWebChatMedia,
  webChatObjectPath,
  type WebChatAttachment,
} from "../lib/inbox/webChatMedia";
import {
  configuredInboxMediaHosts,
  isZernioMediaUrl,
  resolveLocalInboxStorageKey,
  zernioMediaFailureStatus,
} from "../lib/inbox/mediaSource";
import { validateStudentDocumentFile, validateStudentDocumentBuffer, sanitizeFileName } from "../lib/fileUploadValidation";
import { buildDocNameFromParts } from "../lib/docNaming";
import { normalizeInboxStudentExtraction } from "../lib/inboxStudentExtraction";
import { writeAudit } from "../lib/auditLog";
import { recomputeStudentPhoto } from "../lib/studentPhoto";
import { callerOwnsObject } from "../lib/objectAuthz";
import { loadDocCatalogKeySet } from "../lib/docCatalog";
import {
  contentDispositionWithFilename,
  ensureAttachmentFilenameExtension,
  normalizeJpegDownloadFilename,
  readNestedZernioAttachmentMetadata,
} from "../lib/inboxAttachmentMetadata";
import { META_API_VERSION } from "../lib/inbox/channels/meta-shared";
import { isAgentSourcedAndBlockedForStaff } from "../lib/rbac/agentSourceScope";
import {
  inboxAwaitingReplySql,
  inboxEffectiveAssignedToSql,
  inboxIsStarredSql,
  inboxIsSubscribedSql,
  inboxOuterConversationIdSql,
  inboxUnreadCountSql,
  manualUnreadLastReadAt,
} from "../lib/inboxConversationIndicators";

const router: IRouter = Router();

router.get(
  "/inbox/whatsapp-accounts",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  async (_req, res): Promise<void> => {
    const accounts = await db.select({
      id: channelAccountsTable.id,
      displayName: channelAccountsTable.displayName,
      externalAccountId: channelAccountsTable.externalAccountId,
      isDefault: channelAccountsTable.isDefault,
      metadata: channelAccountsTable.metadata,
    }).from(channelAccountsTable).where(and(
      eq(channelAccountsTable.channel, "whatsapp"),
      eq(channelAccountsTable.provider, "zernio"),
      eq(channelAccountsTable.isActive, true),
    )).orderBy(desc(channelAccountsTable.isDefault), asc(channelAccountsTable.displayName));
    res.json({ accounts });
  },
);
const inboxMediaStorage = new ObjectStorageService();
const webChatMediaBody = raw({ limit: WEB_CHAT_MEDIA_MAX_BYTES, type: () => true });

function requestedAiBotId(req: Request): number | null {
  const rawValue = req.body?.aiBotId ?? req.query.aiBotId;
  if (rawValue == null || rawValue === "") return null;
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < 1) throw new Error("INVALID_AI_BOT_ID");
  return value;
}

async function resolveAdminAiBotId(req: Request, res: ExpressResponse): Promise<number | null> {
  try {
    return await requireAiBotId(requestedAiBotId(req));
  } catch (error) {
    const invalid = error instanceof Error && error.message === "INVALID_AI_BOT_ID";
    res.status(invalid ? 400 : 404).json({ error: invalid ? "Invalid AI bot id" : "AI bot not found" });
    return null;
  }
}

interface EntityWhatsAppTarget {
  id: number;
  externalAccountId: string;
  displayName: string;
  isDefault: boolean;
  conversationId: number | null;
}

/**
 * Keep a linked contact on the WhatsApp line where the conversation arrived.
 * Only brand-new outbound contacts use the configured default line.
 */
async function resolveEntityWhatsAppTarget(
  contactCondition: SQL,
  channelAccountId?: number,
): Promise<EntityWhatsAppTarget | null> {
  if (channelAccountId) {
    const [selected] = await db.select({
      id: channelAccountsTable.id,
      externalAccountId: channelAccountsTable.externalAccountId,
      displayName: channelAccountsTable.displayName,
      isDefault: channelAccountsTable.isDefault,
    }).from(channelAccountsTable).where(and(
      eq(channelAccountsTable.id, channelAccountId),
      eq(channelAccountsTable.channel, "whatsapp"),
      eq(channelAccountsTable.provider, "zernio"),
      eq(channelAccountsTable.isActive, true),
    )).limit(1);
    if (!selected?.externalAccountId) return null;
    const contacts = await db.select({ id: externalContactsTable.id })
      .from(externalContactsTable)
      .where(and(eq(externalContactsTable.channel, "whatsapp"), contactCondition));
    const contactIds = contacts.map((contact) => contact.id);
    const [conversation] = contactIds.length > 0
      ? await db.select({ id: conversationsTable.id })
          .from(conversationsTable)
          .where(and(
            inArray(conversationsTable.externalContactId, contactIds),
            eq(conversationsTable.channel, "whatsapp"),
            eq(conversationsTable.channelAccountId, selected.id),
            isNotNull(conversationsTable.externalThreadId),
          ))
          .orderBy(desc(conversationsTable.lastMessageAt))
          .limit(1)
      : [];
    return { ...selected, externalAccountId: selected.externalAccountId, conversationId: conversation?.id ?? null };
  }
  const contacts = await db
    .select({ id: externalContactsTable.id })
    .from(externalContactsTable)
    .where(and(eq(externalContactsTable.channel, "whatsapp"), contactCondition));
  const contactIds = contacts.map((contact) => contact.id);

  if (contactIds.length > 0) {
    const [existing] = await db
      .select({
        conversationId: conversationsTable.id,
        id: channelAccountsTable.id,
        externalAccountId: channelAccountsTable.externalAccountId,
        displayName: channelAccountsTable.displayName,
        isDefault: channelAccountsTable.isDefault,
      })
      .from(conversationsTable)
      .innerJoin(channelAccountsTable, eq(conversationsTable.channelAccountId, channelAccountsTable.id))
      .where(and(
        inArray(conversationsTable.externalContactId, contactIds),
        eq(conversationsTable.channel, "whatsapp"),
        eq(channelAccountsTable.provider, "zernio"),
        eq(channelAccountsTable.isActive, true),
        isNotNull(conversationsTable.externalThreadId),
      ))
      .orderBy(desc(conversationsTable.lastMessageAt))
      .limit(1);

    if (existing?.externalAccountId) {
      return {
        id: existing.id,
        externalAccountId: existing.externalAccountId,
        displayName: existing.displayName,
        isDefault: existing.isDefault,
        conversationId: existing.conversationId,
      };
    }
  }

  const account = await resolveZernioWhatsAppAccount();
  return account ? { ...account, conversationId: null } : null;
}

// Channels governed by Meta's 24h messaging window: free-form replies are only
// allowed within 24h of the last inbound message. WhatsApp, Messenger and
// Instagram all share this policy.
const CHANNELS_WITH_24H_WINDOW = new Set(["whatsapp", "messenger", "instagram"]);

async function renderConversationTemplateContent(
  conversationId: number,
  content: string,
) {
  const variables = extractNamedMessageTemplateVariables(content);
  if (variables.length === 0) {
    return { content, resolvedVariables: [], missingVariables: [] };
  }
  const context = await loadConversationTemplateVariableContext(conversationId);
  return resolveNamedMessageTemplateVariables(content, context);
}

// ---------------------------------------------------------------------------
// Inbox AI / notes / tasks helpers (Phase 2)
// ---------------------------------------------------------------------------

// Per-user rate limit for the AI summarize endpoint. Anthropic calls cost
// money and are slow, so each staff/admin user gets 10 summarize requests
// per minute. Shares the same `rate_limits` table as auth.ts; isolated by
// `keyPrefix`.
const summarizeRateLimiter = new RateLimiterPostgres({
  storeClient: pool,
  storeType: "pool",
  tableName: "rate_limits",
  tableCreated: true,
  keyPrefix: "inbox-summarize",
  points: 10,
  duration: 60,
});

function isAiSummary(value: unknown): value is ConversationAiSummary {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.content === "string" &&
    typeof v.generatedAt === "string" &&
    typeof v.messageCount === "number" &&
    typeof v.model === "string" &&
    typeof v.generatedByUserId === "number"
  );
}

function readAiSummary(metadata: unknown): ConversationAiSummary | null {
  if (!metadata || typeof metadata !== "object") return null;
  const md = metadata as Record<string, unknown>;
  return isAiSummary(md.aiSummary) ? md.aiSummary : null;
}

// Injection seam: the AI summarize endpoint calls `generateConversationSummary`,
// which by default goes to Anthropic via `defaultGenerateSummary`. Tests can
// override `__aiSummaryOverride` to assert cache behavior without spending
// tokens or needing a live API key.
export interface SummarizeInput {
  messages: Array<{ direction: string; content: string; createdAt: Date | string | null }>;
}
let __aiSummaryOverride:
  | ((input: SummarizeInput) => Promise<{ content: string; model: string }>)
  | null = null;
export function __setAiSummaryOverrideForTests(
  fn: ((input: SummarizeInput) => Promise<{ content: string; model: string }>) | null,
): void {
  __aiSummaryOverride = fn;
}

const SUMMARIZE_MODEL = "claude-haiku-4-5-20251001";

async function defaultGenerateSummary(input: SummarizeInput): Promise<{ content: string; model: string }> {
  const anthropic = await getAnthropicClient();
  const transcript = input.messages
    .map((m) => {
      const who = m.direction === "inbound" ? "Customer" : m.direction === "outbound" ? "Agent" : "Internal";
      return `[${who}] ${m.content}`;
    })
    .join("\n");
  const systemPrompt =
    "You are a CRM assistant. Summarize the following customer conversation for staff " +
    "in two concise versions. Cover: (1) the customer's core need, (2) progress so far, " +
    "(3) suggested next action. Always output both Turkish and English, regardless of the " +
    "customer's language. Use exactly these labels: TR: and EN:. Do not include the customer's " +
    "full phone, email, passport or payment details.";
  const message = await anthropic.messages.create({
    model: SUMMARIZE_MODEL,
    max_tokens: 500,
    system: systemPrompt,
    messages: [{ role: "user", content: transcript }],
  });
  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("AI returned no text content");
  }
  return { content: textBlock.text.trim(), model: SUMMARIZE_MODEL };
}

async function generateConversationSummary(input: SummarizeInput): Promise<{ content: string; model: string }> {
  return __aiSummaryOverride ? __aiSummaryOverride(input) : defaultGenerateSummary(input);
}

// Injection seam: the lead-suggestion endpoint calls `extractLeadFromTranscript`,
// which by default goes to Anthropic. Tests can override this to assert field
// extraction + lowConfidence flag behavior without spending tokens or needing a key.
export interface LeadExtractionInput {
  transcript: string;
}
export interface LeadExtractionResult {
  fullName: string | null;
  email: string | null;
  fullNameConfidence: "high" | "low";
  emailConfidence: "high" | "low";
}
let __aiLeadSuggestionOverride:
  | ((input: LeadExtractionInput) => Promise<LeadExtractionResult>)
  | null = null;
export function __setAiLeadSuggestionOverrideForTests(
  fn: ((input: LeadExtractionInput) => Promise<LeadExtractionResult>) | null,
): void {
  __aiLeadSuggestionOverride = fn;
}

const LEAD_EXTRACTION_SYSTEM =
  "You are a CRM data extractor. Extract contact information from the conversation. " +
  "Return ONLY valid JSON with this exact shape — no markdown, no explanation:\n" +
  '{ "fullName": string|null, "email": string|null, "fullNameConfidence": "high"|"low", "emailConfidence": "high"|"low" }\n' +
  '"high" = information is explicitly and clearly stated in the conversation.\n' +
  '"low" = inferred, ambiguous, or uncertain.';

async function extractLeadFromTranscript(input: LeadExtractionInput): Promise<LeadExtractionResult> {
  if (__aiLeadSuggestionOverride) return __aiLeadSuggestionOverride(input);
  const anthropic = await getAnthropicClient();
  const aiResponse = await anthropic.messages.create({
    model: LEAD_EXTRACTION_MODEL,
    max_tokens: 200,
    system: LEAD_EXTRACTION_SYSTEM,
    messages: [{ role: "user", content: `Conversation:\n${input.transcript}` }],
  });
  const textBlock = aiResponse.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") throw new Error("AI returned no text");
  const aiResultSchema = z.object({
    fullName: z.string().nullable(),
    email: z.string().nullable(),
    fullNameConfidence: z.enum(["high", "low"]),
    emailConfidence: z.enum(["high", "low"]),
  });
  return aiResultSchema.parse(JSON.parse(textBlock.text.trim()));
}

interface ConversationLink {
  conversationId: number;
  leadId: number | null;
  studentId: number | null;
}

async function loadConversationLink(id: number): Promise<ConversationLink | null> {
  const [conv] = await db
    .select({ id: conversationsTable.id, externalContactId: conversationsTable.externalContactId })
    .from(conversationsTable)
    .where(eq(conversationsTable.id, id));
  if (!conv) return null;
  if (!conv.externalContactId) {
    return { conversationId: id, leadId: null, studentId: null };
  }
  const [contact] = await db
    .select({ leadId: externalContactsTable.leadId, studentId: externalContactsTable.studentId })
    .from(externalContactsTable)
    .where(eq(externalContactsTable.id, conv.externalContactId));

  // Re-resolve the lead/student against their live (non-soft-deleted) state
  // so summarize/notes/tasks treat a soft-deleted entity as "no link" — same
  // 400 they already return for an unmatched conversation. This keeps deleted
  // personal data from being re-attached to new notes/tasks.
  let liveLeadId: number | null = null;
  let leadConvertedStudentId: number | null = null;
  if (contact?.leadId != null) {
    const [row] = await db
      .select({ id: leadsTable.id, convertedStudentId: leadsTable.convertedStudentId })
      .from(leadsTable)
      .where(and(eq(leadsTable.id, contact.leadId), isNull(leadsTable.deletedAt)));
    if (row) {
      liveLeadId = row.id;
      leadConvertedStudentId = row.convertedStudentId ?? null;
    }
  }
  let liveStudentId: number | null = null;
  if (contact?.studentId != null) {
    const [row] = await db
      .select({ id: studentsTable.id })
      .from(studentsTable)
      .where(and(eq(studentsTable.id, contact.studentId), isNull(studentsTable.deletedAt)));
    if (row) liveStudentId = row.id;
  }
  // If the external_contact points only to a lead that has already been
  // converted to a student, surface the student so that the STUDENT /
  // APPLICATION / DOCUMENTS panels display the real profile instead of
  // showing "No student linked / Analyze documents first".
  if (liveStudentId == null && leadConvertedStudentId != null) {
    const [row] = await db
      .select({ id: studentsTable.id })
      .from(studentsTable)
      .where(and(eq(studentsTable.id, leadConvertedStudentId), isNull(studentsTable.deletedAt)));
    if (row) liveStudentId = row.id;
  }
  return {
    conversationId: id,
    leadId: liveLeadId,
    studentId: liveStudentId,
  };
}

async function isConversationEntityBlocked(
  actor: Parameters<typeof isAgentSourcedAndBlockedForStaff>[0],
  conversationId: number,
): Promise<boolean> {
  const link = await loadConversationLink(conversationId);
  if (!link) return true;
  if (link.studentId != null) {
    const [student] = await db
      .select({ agentId: studentsTable.agentId })
      .from(studentsTable)
      .where(eq(studentsTable.id, link.studentId));
    return Boolean(student && isAgentSourcedAndBlockedForStaff(actor, student.agentId));
  }
  if (link.leadId != null) {
    const [lead] = await db
      .select({ agentId: leadsTable.agentId })
      .from(leadsTable)
      .where(eq(leadsTable.id, link.leadId));
    return Boolean(lead && isAgentSourcedAndBlockedForStaff(actor, lead.agentId));
  }
  return false;
}

router.get("/inbox/live-mode", requireAuth, async (_req, res): Promise<void> => {
  res.json({ live: isLiveIntegrationsEnabled() });
});

/**
 * Media proxy for inbound Zernio attachments.
 *
 * Zernio media URLs (zernio.com/api/v1/.../media/...) require a Bearer apiKey,
 * so a plain <img src> in the browser renders as a broken image. This endpoint
 * fetches the media server-side with the key and streams it back with the
 * correct Content-Type. The key never reaches the browser.
 *
 * Index addresses the SAME combined list the UI renders:
 * [metadata.attachment (if any), ...metadata.attachments].
 * Only zernio.com URLs are proxied (SSRF guard) — everything else 404s
 * because the client can already load those URLs directly.
 */
router.get(
  "/inbox/media/:messageId/:index",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const messageId = Number(req.params.messageId);
    const index = Number(req.params.index);
    if (!Number.isInteger(messageId) || !Number.isInteger(index) || index < 0 || index > 50) {
      res.status(400).json({ error: "Invalid message or attachment index" });
      return;
    }

    const [msg] = await db
      .select({ metadata: messagesTable.metadata })
      .from(messagesTable)
      .where(eq(messagesTable.id, messageId));
    if (!msg) {
      res.status(404).json({ error: "Message not found" });
      return;
    }

    const meta = (msg.metadata ?? {}) as {
      attachment?: { url?: string; fileUrl?: string };
      attachments?: Array<{ url?: string; fileUrl?: string }>;
    };
    const allAtts = [
      ...(meta.attachment ? [meta.attachment] : []),
      ...(meta.attachments ?? []),
    ];
    const att = allAtts[index];
    const rawUrl = att?.url ?? att?.fileUrl ?? "";

    // Outbound composer uploads stay in our own object storage. Historical
    // rows contain a double-prefixed public URL; new rows use the authenticated
    // object route. Resolve both through this message-authorized proxy so every
    // staff member who can read the conversation can preview/download it.
    const localKey = resolveLocalInboxStorageKey(
      rawUrl,
      configuredInboxMediaHosts([req.hostname]),
    );
    if (localKey) {
      try {
        const file = await inboxMediaStorage
          .getObjectEntityFile(`/objects/${localKey}`)
          .catch(() => inboxMediaStorage.searchPublicObject(localKey));
        if (!file) {
          res.status(404).json({ error: "File not found" });
          return;
        }
        res.setHeader("X-Content-Type-Options", "nosniff");
        await inboxMediaStorage.streamObjectToResponse(req, res, file, { cacheTtlSec: 300 });
      } catch (err: any) {
        console.error(
          `[INBOX] local media proxy error for message ${messageId}[${index}]:`,
          err?.message || err,
        );
        res.status(500).json({ error: "Failed to serve media" });
      }
      return;
    }

    // SSRF guard: external proxying is limited to the exact Zernio host.
    if (!isZernioMediaUrl(rawUrl)) {
      res.status(404).json({ error: "Attachment not proxied" });
      return;
    }
    const parsed = new URL(rawUrl);

    const apiKey = await getZernioApiKey();
    if (!apiKey) {
      res.status(502).json({ error: "Zernio API key not configured" });
      return;
    }

    try {
      const upstream = await safeOutboundRequest(parsed.toString(), {
        headers: { Authorization: `Bearer ${apiKey}` },
        allowedProtocols: ["https:"],
        allowedHostnames: ["zernio.com"],
        timeoutMs: 15_000,
        maxBytes: 50 * 1024 * 1024,
        maxRedirects: 3,
      });
      if (!upstream.ok) {
        const body = upstream.body.toString("utf8");
        console.error(`[ZERNIO] media proxy upstream ${upstream.status} for message ${messageId}[${index}]:`, body.slice(0, 300));
        const clientStatus = zernioMediaFailureStatus(upstream.status, body);
        res.status(clientStatus).json({
          error: clientStatus === 410 ? "Media is no longer available" : "Failed to fetch media",
        });
        return;
      }
      const upstreamContentType = upstream.headers["content-type"] || "application/octet-stream";
      const dispo = upstream.headers["content-disposition"] || null;
      const upstreamFilename = parseContentDispositionFilename(dispo);
      const downloadFilename = normalizeJpegDownloadFilename(upstreamFilename);
      const normalizedJpegName = Boolean(
        upstreamFilename && downloadFilename && upstreamFilename !== downloadFilename,
      );

      res.status(200);
      res.setHeader("Content-Type", normalizedJpegName ? "image/jpeg" : upstreamContentType);
      const len = upstream.headers["content-length"] || String(upstream.body.length);
      if (len) res.setHeader("Content-Length", len);
      res.setHeader("Cache-Control", "private, max-age=300");
      // Forward the upstream filename (RFC 5987 aware) so browser downloads
      // get the real name, and persist name+size onto message.metadata so the
      // UI stops showing generic labels. Both steps are best-effort and can
      // never break the proxy stream.
      try {
        if (dispo) {
          res.setHeader(
            "Content-Disposition",
            normalizedJpegName && downloadFilename
              ? contentDispositionWithFilename(dispo, downloadFilename)
              : dispo,
          );
        }
        const sizeNum = Number(len);
        void persistAttachmentMeta(messageId, index, {
          name: downloadFilename,
          size: Number.isFinite(sizeNum) && sizeNum > 0 ? sizeNum : null,
        });
      } catch { /* best-effort only */ }
      res.end(upstream.body);
    } catch (err: any) {
      console.error(`[ZERNIO] media proxy error for message ${messageId}[${index}]:`, err?.message || err);
      res.status(502).json({ error: "Failed to fetch media" });
    }
  },
);

/**
 * WhatsApp-Web-style PDF preview: renders page 1 of a PDF attachment to a
 * JPEG thumbnail on the server and caches it on disk. The client shows the
 * <img> instantly and only falls back to client-side pdfjs rendering when
 * this endpoint 404s. Same SSRF guard as the media proxy (zernio.com only).
 * Page count (best-effort via pdfinfo) is exposed as X-Pdf-Page-Count.
 */
router.get(
  "/inbox/media/:messageId/:index/pdf-thumb",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const messageId = Number(req.params.messageId);
    const index = Number(req.params.index);
    if (!Number.isInteger(messageId) || !Number.isInteger(index) || index < 0 || index > 50) {
      res.status(400).json({ error: "Invalid message or attachment index" });
      return;
    }

    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs/promises");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    const cacheDir = path.join(os.tmpdir(), "edcons-pdf-thumbs");
    const thumbPath = path.join(cacheDir, `${messageId}-${index}.jpg`);
    const metaPath = path.join(cacheDir, `${messageId}-${index}.json`);

    const sendThumb = async (): Promise<boolean> => {
      try {
        const buf = await fs.readFile(thumbPath);
        let pages: number | null = null;
        try {
          const metaRaw = await fs.readFile(metaPath, "utf8");
          pages = (JSON.parse(metaRaw) as { pages?: number }).pages ?? null;
        } catch { /* meta is best-effort */ }
        res.status(200);
        res.setHeader("Content-Type", "image/jpeg");
        res.setHeader("Cache-Control", "private, max-age=86400");
        if (pages && Number.isFinite(pages)) res.setHeader("X-Pdf-Page-Count", String(pages));
        res.end(buf);
        return true;
      } catch {
        return false;
      }
    };
    if (await sendThumb()) return;

    const [msg] = await db
      .select({ metadata: messagesTable.metadata })
      .from(messagesTable)
      .where(eq(messagesTable.id, messageId));
    if (!msg) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    const meta = (msg.metadata ?? {}) as {
      attachment?: { url?: string; fileUrl?: string };
      attachments?: Array<{ url?: string; fileUrl?: string }>;
    };
    const allAtts = [
      ...(meta.attachment ? [meta.attachment] : []),
      ...(meta.attachments ?? []),
    ];
    const rawUrl = allAtts[index]?.url ?? allAtts[index]?.fileUrl ?? "";

    let tmpPdf: string | null = null;
    let tmpOutBase: string | null = null;
    try {
      let buf: Buffer;
      const localKey = resolveLocalInboxStorageKey(
        rawUrl,
        configuredInboxMediaHosts([req.hostname]),
      );
      if (localKey) {
        const file = await inboxMediaStorage.searchPublicObject(localKey);
        if (!file) {
          res.status(404).json({ error: "File not found" });
          return;
        }
        const [metadata] = await file.getMetadata();
        const storedSize = Number(metadata.size);
        if (Number.isFinite(storedSize) && storedSize > 25 * 1024 * 1024) {
          res.status(404).json({ error: "PDF is too large to preview" });
          return;
        }
        [buf] = await file.download();
      } else {
        let parsed: URL;
        try {
          parsed = new URL(rawUrl);
        } catch {
          res.status(404).json({ error: "Attachment not found" });
          return;
        }
        if (parsed.protocol !== "https:" || parsed.hostname !== "zernio.com") {
          res.status(404).json({ error: "Attachment not proxied" });
          return;
        }
        const apiKey = await getZernioApiKey();
        if (!apiKey) {
          res.status(502).json({ error: "Zernio API key not configured" });
          return;
        }

        const upstream = await safeOutboundRequest(parsed.toString(), {
          headers: { Authorization: `Bearer ${apiKey}` },
          allowedProtocols: ["https:"],
          allowedHostnames: ["zernio.com"],
          timeoutMs: 15_000,
          maxBytes: 25 * 1024 * 1024,
          maxRedirects: 3,
        });
        if (!upstream || !upstream.ok) {
          res.status(404).json({ error: "Failed to fetch media" });
          return;
        }
        buf = upstream.body;
      }
      // Only render actual PDFs (magic check) and cap at 25 MB.
      if (buf.length > 25 * 1024 * 1024 || !buf.subarray(0, 5).toString("latin1").startsWith("%PDF")) {
        res.status(404).json({ error: "Not a renderable PDF" });
        return;
      }

      await fs.mkdir(cacheDir, { recursive: true });
      tmpPdf = path.join(cacheDir, `src-${messageId}-${index}-${Date.now()}.pdf`);
      tmpOutBase = path.join(cacheDir, `out-${messageId}-${index}-${Date.now()}`);
      await fs.writeFile(tmpPdf, buf);

      let rendered = false;
      try {
        await execFileAsync("pdftoppm", ["-jpeg", "-f", "1", "-l", "1", "-scale-to", "480", "-singlefile", tmpPdf, tmpOutBase], { timeout: 20000 });
        await fs.rename(`${tmpOutBase}.jpg`, thumbPath);
        rendered = true;
      } catch {
        // Fallback: ghostscript
        try {
          await execFileAsync("gs", ["-dSAFER", "-dBATCH", "-dNOPAUSE", "-dFirstPage=1", "-dLastPage=1", "-sDEVICE=jpeg", "-r72", `-sOutputFile=${tmpOutBase}.jpg`, tmpPdf], { timeout: 20000 });
          await fs.rename(`${tmpOutBase}.jpg`, thumbPath);
          rendered = true;
        } catch { /* both renderers failed */ }
      }
      if (!rendered) {
        res.status(404).json({ error: "Thumbnail render failed" });
        return;
      }

      // Best-effort page count for the "N pages" label.
      try {
        const { stdout } = await execFileAsync("pdfinfo", [tmpPdf], { timeout: 10000 });
        const m = /^Pages:\s+(\d+)/m.exec(stdout);
        if (m) await fs.writeFile(metaPath, JSON.stringify({ pages: Number(m[1]) }));
      } catch { /* label is optional */ }

      if (!(await sendThumb())) {
        res.status(404).json({ error: "Thumbnail render failed" });
      }
    } catch (err: any) {
      console.error(`[INBOX] pdf-thumb error for message ${messageId}[${index}]:`, err?.message || err);
      res.status(404).json({ error: "Thumbnail render failed" });
    } finally {
      if (tmpPdf) void fs.unlink(tmpPdf).catch(() => {});
      if (tmpOutBase) void fs.unlink(`${tmpOutBase}.jpg`).catch(() => {});
    }
  },
);

/**
 * Live inbox stream (Server-Sent Events). Pushes `inbox_message` and
 * `inbox_assigned` frames to the client so the UI can refresh without
 * polling. Payloads carry just enough context for the client to decide
 * what to refetch (the conversation list and, if open, the conversation
 * detail). The connection emits a named `heartbeat` event every 25s so the
 * client can both defeat idle proxies AND surface a "last update" timestamp
 * — staff see the indicator turn amber if no heartbeat arrives for > 60s,
 * catching "looks live but isn't" failures where the socket stays open but
 * the push pipeline silently stops emitting.
 */
router.get(
  "/inbox/events",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  (req, res): void => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof (res as { flushHeaders?: () => void }).flushHeaders === "function") {
      (res as { flushHeaders: () => void }).flushHeaders();
    }

    res.write(`retry: 5000\n\n`);

    const writeHeartbeat = () => {
      try {
        res.write(`event: heartbeat\n`);
        res.write(`data: ${JSON.stringify({ ts: Date.now() })}\n\n`);
      } catch {
        // ignored — close handler will tear down.
      }
    };

    // Send an initial heartbeat immediately so the client's "last update"
    // timestamp is populated before the first real event arrives.
    writeHeartbeat();

    const handler = (event: InboxBusEvent) => {
      const eventName = event.type === "message"
        ? "inbox_message"
        : event.type === "assigned"
          ? "inbox_assigned"
          : "inbox_read_state";
      try {
        res.write(`event: ${eventName}\n`);
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        // socket may have closed mid-write; cleanup happens via 'close'.
      }
    };

    const unsubscribe = inboxBus.subscribe(handler);

    const ping = setInterval(writeHeartbeat, 25000);

    const cleanup = () => {
      clearInterval(ping);
      unsubscribe();
      try { res.end(); } catch {}
    };

    req.on("close", cleanup);
    req.on("error", cleanup);
  },
);

router.get(
  "/inbox/conversations",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const userId = req.user!.id;
    const tab = String(req.query.tab || "mine"); // mine | unassigned | unmatched | all | archived
    const channel = req.query.channel ? String(req.query.channel) : null;
    const order = String(req.query.order || "desc") === "asc" ? "asc" : "desc";
    const showTests = String(req.query.showTests || "") === "true";
    const search = String(req.query.search || "").trim().slice(0, 120);
    const assignedToRaw = req.query.assignedToId == null ? "" : String(req.query.assignedToId).trim();
    const assignedToId = assignedToRaw ? Number(assignedToRaw) : null;

    if (assignedToRaw && (!Number.isInteger(assignedToId) || (assignedToId ?? 0) <= 0)) {
      res.status(400).json({ error: "Invalid assignedToId" });
      return;
    }

    const where: SQL[] = [
      tab === "archived"
        ? eq(conversationsTable.isArchived, true)
        : eq(conversationsTable.isArchived, false),
    ];
    const effectiveAssignedTo = inboxEffectiveAssignedToSql();

    // Test/junk conversations are hidden by default: e2e-suite artifacts and
    // quick-contact WhatsApp stubs that never left the queue. Toggle with
    // showTests=true (used by the cleanup UI).
    if (!showTests) {
      where.push(sql`NOT (
        COALESCE(${conversationsTable.title}, '') ILIKE 'Playwright Inbox%'
        OR COALESCE(${conversationsTable.title}, '') ILIKE 'automated e2e webhook%'
        OR (COALESCE(${conversationsTable.title}, '') ILIKE 'WhatsApp to %' AND ${conversationsTable.status} = 'queued')
      )`);
    }

    // Channel filter has full parity, including the value 'internal'. When NO
    // channel is requested, default the inbox scope to external channels only
    // so user-DMs (internal conversations) don't pollute the staff inbox feed
    // — internal conversations remain reachable by passing channel=internal.
    if (channel) {
      where.push(eq(conversationsTable.channel, channel));
    } else {
      where.push(sql`${conversationsTable.channel} != 'internal'`);
    }

    if (assignedToId !== null) {
      where.push(sql`${effectiveAssignedTo} = ${assignedToId}`);
    }

    if (search) {
      const pattern = `%${search}%`;
      const searchCondition = or(
        ilike(conversationsTable.title, pattern),
        ilike(conversationsTable.lastMessagePreview, pattern),
        sql`EXISTS (
          SELECT 1
          FROM ${externalContactsTable}
          WHERE ${externalContactsTable.id} = ${conversationsTable.externalContactId}
          AND (
            COALESCE(${externalContactsTable.displayName}, '') ILIKE ${pattern}
            OR COALESCE(${externalContactsTable.phone}, '') ILIKE ${pattern}
            OR COALESCE(${externalContactsTable.email}, '') ILIKE ${pattern}
          )
        )`,
      );
      if (searchCondition) where.push(searchCondition);
    }

    if (tab === "mine") where.push(sql`${effectiveAssignedTo} = ${userId}`);
    else if (tab === "unassigned") where.push(sql`${effectiveAssignedTo} IS NULL`);
    else if (tab === "unmatched") where.push(eq(conversationsTable.unmatched, true));
    else if (tab === "unanswered") {
      where.push(eq(conversationsTable.status, "open"));
      where.push(isNotNull(conversationsTable.lastInboundAt));
      where.push(sql`NOT EXISTS (
        SELECT 1 FROM messages m
        WHERE m.conversation_id = ${inboxOuterConversationIdSql}
        AND m.direction IN ('outbound', 'internal')
        AND m.created_at > ${conversationsTable.lastInboundAt}
      )`);
    } else if (tab === "subscribed") {
      where.push(sql`EXISTS (
        SELECT 1 FROM conversation_participants cp
        WHERE cp.conversation_id = ${inboxOuterConversationIdSql} AND cp.user_id = ${userId}
      )`);
    } else if (tab === "starred") {
      where.push(sql`EXISTS (
        SELECT 1 FROM conversation_participants cp
        WHERE cp.conversation_id = ${inboxOuterConversationIdSql}
        AND cp.user_id = ${userId} AND cp.is_starred = true
      )`);
    } else if (tab === "unread") {
      // Conversations with at least one inbound message the current user
      // hasn't seen (after their participant last_read_at, or ever if none).
      where.push(sql`EXISTS (
        SELECT 1 FROM messages m
        WHERE m.conversation_id = ${inboxOuterConversationIdSql}
        AND m.direction = 'inbound'
        AND m.created_at > COALESCE((
          SELECT cp.last_read_at FROM conversation_participants cp
          WHERE cp.conversation_id = ${inboxOuterConversationIdSql} AND cp.user_id = ${userId}
        ), 'epoch'::timestamptz)
      )`);
    } else if (tab === "awaiting") {
      // Last message is inbound → the contact is waiting on a staff reply.
      where.push(isNotNull(conversationsTable.lastInboundAt));
      where.push(sql`NOT EXISTS (
        SELECT 1 FROM messages m
        WHERE m.conversation_id = ${inboxOuterConversationIdSql}
        AND m.direction IN ('outbound', 'internal')
        AND m.created_at > ${conversationsTable.lastInboundAt}
      )`);
    }
    // tab === "open" or "all": no extra filter beyond isArchived=false

    const rows = await db
      .select({
        id: conversationsTable.id,
        type: conversationsTable.type,
        title: conversationsTable.title,
        channel: conversationsTable.channel,
        channelAccountId: conversationsTable.channelAccountId,
        externalContactId: conversationsTable.externalContactId,
        externalThreadId: conversationsTable.externalThreadId,
        unmatched: conversationsTable.unmatched,
        status: conversationsTable.status,
        assignedToId: effectiveAssignedTo,
        lastMessageAt: conversationsTable.lastMessageAt,
        lastMessagePreview: conversationsTable.lastMessagePreview,
        lastInboundAt: conversationsTable.lastInboundAt,
        createdAt: conversationsTable.createdAt,
        isStarred: inboxIsStarredSql(userId),
        isSubscribed: inboxIsSubscribedSql(userId),
        // Per-user unread inbound count (WhatsApp-style badge). Correlated
        // subquery inside the SAME select — no N+1 round trips.
        unreadCount: inboxUnreadCountSql(userId),
        // Persistent "awaiting reply" flag derived from the LAST message's
        // direction (not lastInboundAt, which can drift out of sync with the
        // messages table — e.g. backfilled/imported rows). Orange dot shows
        // iff the newest message in the conversation is inbound.
        awaitingReply: inboxAwaitingReplySql(),
      })
      .from(conversationsTable)
      .where(and(...where))
      .orderBy(
        order === "asc"
          ? asc(conversationsTable.lastMessageAt)
          : desc(conversationsTable.lastMessageAt),
      )
      .limit(200);

    const externalIds = [...new Set(rows.map((r) => r.externalContactId).filter((x): x is number => !!x))];
    const assignedIds = [...new Set(rows.map((r) => r.assignedToId).filter((x): x is number => !!x))];
    const channelAccountIds = [...new Set(rows.map((r) => r.channelAccountId).filter((x): x is number => !!x))];

    type AssignedUserSummary = {
      id: number;
      firstName: string | null;
      lastName: string | null;
      email: string | null;
    };
    type ChannelAccountSummary = {
      id: number;
      displayName: string;
      externalAccountId: string | null;
      isDefault: boolean;
      provider: string;
      metadata: unknown;
    };

    // These three enrichment reads are independent. Running them in parallel
    // removes two avoidable database round trips from the inbox critical path.
    const [contacts, users, accounts] = await Promise.all([
      externalIds.length > 0
        ? db
        .select()
        .from(externalContactsTable)
        .where(inArray(externalContactsTable.id, externalIds))
        : Promise.resolve([] as ExternalContact[]),
      assignedIds.length > 0
        ? db
        .select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, email: usersTable.email })
        .from(usersTable)
        .where(inArray(usersTable.id, assignedIds))
        : Promise.resolve([] as AssignedUserSummary[]),
      channelAccountIds.length > 0
        ? db
        .select({
          id: channelAccountsTable.id,
          displayName: channelAccountsTable.displayName,
          externalAccountId: channelAccountsTable.externalAccountId,
          isDefault: channelAccountsTable.isDefault,
          provider: channelAccountsTable.provider,
          metadata: channelAccountsTable.metadata,
        })
        .from(channelAccountsTable)
        .where(inArray(channelAccountsTable.id, channelAccountIds))
        : Promise.resolve([] as ChannelAccountSummary[]),
    ]);

    const contactsMap = new Map<number, ExternalContact>();
    for (const c of contacts) contactsMap.set(c.id, c);
    const usersMap = new Map<number, AssignedUserSummary>();
    for (const u of users) usersMap.set(u.id, u);
    const channelAccountsMap = new Map<number, ChannelAccountSummary>();
    for (const account of accounts) channelAccountsMap.set(account.id, account);

    const data = rows.map((r) => ({
      ...r,
      externalContact: r.externalContactId ? contactsMap.get(r.externalContactId) : null,
      assignedTo: r.assignedToId ? usersMap.get(r.assignedToId) : null,
      channelAccount: r.channelAccountId ? channelAccountsMap.get(r.channelAccountId) ?? null : null,
    }));

    res.json({ data });
  },
);

router.get(
  "/inbox/conversations/:id",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const id = parseInt(String(req.params.id), 10);
    if (!id) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [conv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, id));
    if (!conv) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const rawLimit = parseInt(String(req.query.limit ?? ""), 10);
    const msgLimit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50;
    const beforeId = parseInt(String(req.query.before ?? ""), 10);
    const msgWhere: SQL[] = [eq(messagesTable.conversationId, id)];
    if (Number.isFinite(beforeId) && beforeId > 0) {
      msgWhere.push(sql`${messagesTable.id} < ${beforeId}`);
    }

    // Contact/account lookup, owner consistency, per-user read state and the
    // message window do not depend on each other. Overlap their I/O instead of
    // serially waiting for five database round trips.
    const [
      externalContactRows,
      channelAccountRows,
      syncedOwner,
      _readState,
      newestFirst,
    ] = await Promise.all([
      conv.externalContactId
        ? db.select().from(externalContactsTable).where(eq(externalContactsTable.id, conv.externalContactId))
        : Promise.resolve([]),
      conv.channelAccountId
        ? db
          .select({
            id: channelAccountsTable.id,
            displayName: channelAccountsTable.displayName,
            externalAccountId: channelAccountsTable.externalAccountId,
            isDefault: channelAccountsTable.isDefault,
            provider: channelAccountsTable.provider,
            metadata: channelAccountsTable.metadata,
          })
          .from(channelAccountsTable)
          .where(eq(channelAccountsTable.id, conv.channelAccountId))
        : Promise.resolve([]),
      conv.externalContactId
        ? syncConversationOwner(id, req.user!.id, req.ip)
        : Promise.resolve(conv.assignedToId ?? null),
      db.execute(sql`
        INSERT INTO conversation_participants (conversation_id, user_id, last_read_at)
        VALUES (${id}, ${req.user!.id}, now())
        ON CONFLICT (conversation_id, user_id)
        DO UPDATE SET last_read_at = EXCLUDED.last_read_at
      `),
      db
        .select()
        .from(messagesTable)
        .where(and(...msgWhere))
        .orderBy(desc(messagesTable.id))
        .limit(msgLimit + 1),
    ]);
    const externalContact = externalContactRows[0] ?? null;
    const channelAccount = channelAccountRows[0] ?? null;
    if (syncedOwner !== (conv.assignedToId ?? null)) {
      conv.assignedToId = syncedOwner;
    }

    // Old Zernio attachments were stored without name/size — opportunistically
    // backfill them for this conversation in the background (rate-limited).
    void backfillConversationAttachmentNames(id);
    const [assignedTo] = conv.assignedToId
      ? await db
          .select({
            id: usersTable.id,
            firstName: usersTable.firstName,
            lastName: usersTable.lastName,
            avatarUrl: usersTable.avatarUrl,
          })
          .from(usersTable)
          .where(eq(usersTable.id, conv.assignedToId))
      : [null];
    // Windowed message fetch: newest `limit` messages by default; `before=<id>`
    // pages older history (WhatsApp-style load-older). Rows are returned in
    // ascending order for rendering.
    const hasMoreMessages = newestFirst.length > msgLimit;
    const rawMessages = newestFirst.slice(0, msgLimit).reverse();

    // Enrich messages: reactions grouped by emoji + repliedMessage snippets.
    let messages: Array<typeof rawMessages[number] & {
      reactions: Array<{ emoji: string; count: number; userIds: number[] }>;
      repliedMessage: { id: number; snippet: string; senderName: string } | null;
    }>;
    if (rawMessages.length > 0) {
      const msgIds = rawMessages.map((m) => m.id);

      // Reactions: batch-fetch all for this message window.
      const replyToIds = [...new Set(rawMessages.map((m) => m.replyToId).filter(Boolean) as number[])];
      const [reactRows, repliedRows] = await Promise.all([
        pool.query<{ message_id: number; emoji: string; user_id: number }>(
          `SELECT message_id, emoji, user_id FROM message_reactions WHERE message_id = ANY($1)`,
          [msgIds],
        ),
        replyToIds.length > 0
          ? pool.query<{ id: number; content: string; first_name: string | null; last_name: string | null }>(
            `SELECT m.id, m.content, u.first_name, u.last_name
             FROM messages m LEFT JOIN users u ON u.id = m.sender_id
             WHERE m.id = ANY($1)`,
            [replyToIds],
          )
          : Promise.resolve({ rows: [] as Array<{ id: number; content: string; first_name: string | null; last_name: string | null }> }),
      ]);
      const reactMap: Record<number, Record<string, { emoji: string; count: number; userIds: number[] }>> = {};
      for (const r of reactRows.rows) {
        if (!reactMap[r.message_id]) reactMap[r.message_id] = {};
        if (!reactMap[r.message_id][r.emoji]) reactMap[r.message_id][r.emoji] = { emoji: r.emoji, count: 0, userIds: [] };
        reactMap[r.message_id][r.emoji].count++;
        reactMap[r.message_id][r.emoji].userIds.push(r.user_id);
      }

      // repliedMessage: fetch snippet for each unique replyToId.
      const repliedMap: Record<number, { id: number; snippet: string; senderName: string }> = {};
      for (const r of repliedRows.rows) {
        repliedMap[r.id] = {
          id: r.id,
          snippet: r.content.slice(0, 120),
          senderName: [r.first_name, r.last_name].filter(Boolean).join(" ") || "Unknown",
        };
      }

      messages = rawMessages.map((m) => ({
        ...m,
        reactions: Object.values(reactMap[m.id] ?? {}),
        repliedMessage: m.replyToId ? (repliedMap[m.replyToId] ?? null) : null,
      }));
    } else {
      messages = rawMessages.map((m) => ({ ...m, reactions: [], repliedMessage: null }));
    }

    const leadId = externalContact?.leadId ?? null;
    const studentId = externalContact?.studentId ?? null;
    const agentId = externalContact?.agentId ?? null;

    // Older lead -> student conversions cleared external_contacts.lead_id. Recover
    // that relationship through converted_student_id so lead preferences (country,
    // university, program and level) remain available in the inbox after conversion.
    let resolvedLeadId = leadId;
    if (!resolvedLeadId && studentId) {
      const [convertedLeadRef] = await db
        .select({ id: leadsTable.id })
        .from(leadsTable)
        .where(
          and(
            eq(leadsTable.convertedStudentId, studentId),
            isNull(leadsTable.deletedAt),
          ),
        )
        .orderBy(desc(leadsTable.createdAt), desc(leadsTable.id))
        .limit(1);
      resolvedLeadId = convertedLeadRef?.id ?? null;
    }

    const [lead] = resolvedLeadId
      ? await db
          .select({
            id: leadsTable.id,
            firstName: leadsTable.firstName,
            lastName: leadsTable.lastName,
            email: leadsTable.email,
            phone: leadsTable.phone,
            motherName: leadsTable.motherName,
            fatherName: leadsTable.fatherName,
            status: leadsTable.status,
            interestedProgram: leadsTable.interestedProgram,
            interestedUniversity: leadsTable.interestedUniversity,
            interestedCountry: leadsTable.interestedCountry,
            interestedLevel: leadsTable.interestedLevel,
            estimatedValue: leadsTable.estimatedValue,
            source: leadsTable.source,
            originType: leadsTable.originType,
            originDisplayName: leadsTable.originDisplayName,
            agentId: leadsTable.agentId,
            assignedToId: leadsTable.assignedToId,
            createdAt: leadsTable.createdAt,
            convertedStudentId: leadsTable.convertedStudentId,
          })
          .from(leadsTable)
          .where(
            and(eq(leadsTable.id, resolvedLeadId), isNull(leadsTable.deletedAt)),
          )
      : [null];

    // A converted lead is authoritative even when an older/existing
    // external_contact has not yet had student_id backfilled. Without this
    // fallback the UI kept offering "Create Student", while POST /students
    // correctly rejected the duplicate conversion with HTTP 409.
    const resolvedStudentId = studentId ?? lead?.convertedStudentId ?? null;
    const [student] = resolvedStudentId
      ? await db
          .select({
            id: studentsTable.id,
            firstName: studentsTable.firstName,
            lastName: studentsTable.lastName,
            email: studentsTable.email,
            phone: studentsTable.phone,
            motherName: studentsTable.motherName,
            fatherName: studentsTable.fatherName,
            status: studentsTable.status,
            agentId: studentsTable.agentId,
            assignedToId: studentsTable.assignedToId,
            interestedLevel: studentsTable.interestedLevel,
            originType: studentsTable.originType,
            originDisplayName: studentsTable.originDisplayName,
            createdAt: studentsTable.createdAt,
          })
          .from(studentsTable)
          .where(and(eq(studentsTable.id, resolvedStudentId), isNull(studentsTable.deletedAt)))
      : [null];

    const [agent] = agentId
      ? await db
          .select({
            id: agentsTable.id,
            firstName: agentsTable.firstName,
            lastName: agentsTable.lastName,
            companyName: agentsTable.companyName,
            email: agentsTable.email,
            phone: agentsTable.phone,
            status: agentsTable.status,
            entityType: agentsTable.entityType,
          })
          .from(agentsTable)
          .where(and(eq(agentsTable.id, agentId), isNull(agentsTable.deletedAt)))
      : [null];

    let stage: {
      key: string;
      label: string;
      color: string | null;
      variant: string | null;
      icon: string | null;
    } | null = null;
    const stageEntity: "lead" | "student" | null = student ? "student" : lead ? "lead" : null;
    const stageKey = student?.status ?? lead?.status ?? null;
    if (stageEntity && stageKey) {
      const [row] = await db
        .select({
          key: pipelineStagesTable.key,
          label: pipelineStagesTable.label,
          color: pipelineStagesTable.color,
          variant: pipelineStagesTable.variant,
          icon: pipelineStagesTable.icon,
        })
        .from(pipelineStagesTable)
        .where(and(
          eq(pipelineStagesTable.entityType, stageEntity),
          eq(pipelineStagesTable.key, stageKey),
        ));
      stage = row ?? null;
    }

    const aiSummary = readAiSummary(conv.metadata);

    res.json({
      conversation: {
        ...conv,
        assignedTo: assignedTo ?? null,
        channelAccount: channelAccount ?? null,
      },
      externalContact,
      messages,
      hasMoreMessages,
      withinWindow: CHANNELS_WITH_24H_WINDOW.has(conv.channel) ? isWithin24hWindow(conv.lastInboundAt) : true,
      lead: lead ?? null,
      student: student ?? null,
      agent: agent ?? null,
      stage,
      aiSummary,
    });
  },
);

router.post(
  "/inbox/conversations/:id/read-state",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const id = parseInt(String(req.params.id), 10);
    const parsed = z.object({ unread: z.boolean() }).safeParse(req.body);
    if (!id || !parsed.success) {
      res.status(400).json({ error: "Invalid read state request" });
      return;
    }

    const [conversation] = await db
      .select({ id: conversationsTable.id })
      .from(conversationsTable)
      .where(eq(conversationsTable.id, id));
    if (!conversation) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }

    let lastReadAt = new Date();
    if (parsed.data.unread) {
      const [latestInbound] = await db
        .select({ createdAt: messagesTable.createdAt })
        .from(messagesTable)
        .where(and(
          eq(messagesTable.conversationId, id),
          eq(messagesTable.direction, "inbound"),
        ))
        .orderBy(desc(messagesTable.createdAt), desc(messagesTable.id))
        .limit(1);
      if (!latestInbound?.createdAt) {
        res.status(409).json({ error: "Conversation has no inbound message to mark unread" });
        return;
      }
      lastReadAt = manualUnreadLastReadAt(latestInbound.createdAt);
    }

    await db.execute(sql`
      INSERT INTO conversation_participants (conversation_id, user_id, last_read_at)
      VALUES (${id}, ${req.user!.id}, ${lastReadAt})
      ON CONFLICT (conversation_id, user_id)
      DO UPDATE SET last_read_at = EXCLUDED.last_read_at
    `);

    const unreadResult = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM messages
       WHERE conversation_id = $1
         AND direction = 'inbound'
         AND created_at > $2`,
      [id, lastReadAt],
    );
    const unreadCount = Number(unreadResult.rows[0]?.count ?? 0);

    await logAudit(
      req.user!.id,
      parsed.data.unread ? "mark_conversation_unread" : "mark_conversation_read",
      "conversation",
      id,
      { unreadCount },
      req.ip,
    );
    inboxBus.publish({
      type: "read_state",
      conversationId: id,
      actorUserId: req.user!.id,
      unread: parsed.data.unread,
      unreadCount,
    });

    res.json({ unread: parsed.data.unread, unreadCount });
  },
);

router.patch(
  "/inbox/conversations/:id/assign",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const id = parseInt(String(req.params.id), 10);
    const { userId } = req.body as { userId: number | null };
    if (!id) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const assignedToId = userId === null ? null : (typeof userId === "number" ? userId : req.user!.id);
    const [previous] = await db
      .select({ assignedToId: conversationsTable.assignedToId })
      .from(conversationsTable)
      .where(eq(conversationsTable.id, id));
    // Single-owner rule: when the linked CRM chain (lead/student) already has
    // an owner, only users with the cascade permission (admins/managers) may
    // change the assignment — everyone else gets a 403 with the owner id so
    // the UI can explain who owns the record.
    const chainLink = await loadConversationLink(id);
    const chainOwnerId = chainLink ? await getChainOwner(chainLink) : null;
    const actorIsAdmin = req.user!.role === "admin" || req.user!.role === "super_admin";
    const actorCanCascade = actorIsAdmin || await userHasPermission(
      { id: req.user!.id, role: req.user!.role },
      "records.cascade_assignment",
    );
    // Single-owner lock: only admins may override an existing chain owner
    // (matches the UI, where only admin/super_admin get the staff dropdown).
    if (chainOwnerId != null && assignedToId !== chainOwnerId && !actorIsAdmin) {
      res.status(403).json({ error: "ASSIGNMENT_LOCKED", ownerId: chainOwnerId });
      return;
    }
    // Cascade to linked lead / student (and their sibling applications).
    // Awaited BEFORE responding: the conversation-detail route runs a
    // chain-wins owner sync, so if the chain still held the old owner when
    // the client refetched, the reassignment would be silently reverted.
    const chainHasEntity = Boolean(chainLink && (chainLink.studentId != null || chainLink.leadId != null));
    // Also repair a previously interrupted assignment where the conversation
    // row already has the requested owner but its authoritative CRM chain does
    // not. Treating that retry as a no-op made the old owner return on refresh.
    const assignmentNeedsCascade = assignedToId !== (previous?.assignedToId ?? null)
      || (chainHasEntity && assignedToId !== chainOwnerId);
    let updated: typeof conversationsTable.$inferSelect | null = null;
    try {
      updated = await db.transaction(async (tx) => {
        const [updatedConversation] = await tx
          .update(conversationsTable)
          .set({ assignedToId, status: "open" })
          .where(eq(conversationsTable.id, id))
          .returning();
        if (!updatedConversation) return null;

        if (assignmentNeedsCascade) {
        const link = chainLink ?? await loadConversationLink(id);
        if (link) {
          const actor = req.user!;
          const canCascade = actorCanCascade;
          // A linked student is the authoritative owner in getChainOwner(), so
          // update that source row first. cascadeStudentAssignment deliberately
          // updates only the student's lead/app siblings (its normal callers
          // have already patched the student). Skipping this source update made
          // the next detail refresh restore the old student owner and silently
          // undo an admin's conversation reassignment.
          if (link.studentId != null && (canCascade || assignedToId !== null)) {
            const [student] = await tx
              .select({ id: studentsTable.id, assignedToId: studentsTable.assignedToId })
              .from(studentsTable)
              .where(and(eq(studentsTable.id, link.studentId), isNull(studentsTable.deletedAt)));
            const shouldUpdateStudent = student
              && student.assignedToId !== assignedToId
              && (canCascade || student.assignedToId === null);
            if (shouldUpdateStudent) {
              await tx
                .update(studentsTable)
                .set({ assignedToId })
                .where(eq(studentsTable.id, student.id));
              await logAudit(actor.id, canCascade ? "assignment.cascade" : "assignment.null_fill_cascade", "student", student.id, {
                from: student.assignedToId ?? null,
                to: assignedToId,
                source: "conversation",
                sourceId: id,
              }, req.ip);
            }
            await cascadeStudentAssignment({
              studentId: link.studentId,
              newAssignedToId: assignedToId,
              actorUserId: actor.id,
              ipAddress: req.ip,
              nullFillOnly: !canCascade,
              throwOnError: true,
              executor: tx,
            });
          } else if (link.leadId != null) {
            const [lead] = await tx
              .select({
                id: leadsTable.id,
                assignedToId: leadsTable.assignedToId,
                convertedStudentId: leadsTable.convertedStudentId,
              })
              .from(leadsTable)
              .where(and(eq(leadsTable.id, link.leadId), isNull(leadsTable.deletedAt)));
            if (lead && (canCascade || assignedToId !== null)) {
              // A lead-only conversation resolves its owner from this row.
              // Updating only the converted student/applications left the lead
              // on the old owner, so the next detail refresh reverted the UI.
              const shouldUpdateLead = lead.assignedToId !== assignedToId
                && (canCascade || lead.assignedToId === null);
              if (shouldUpdateLead) {
                await tx
                  .update(leadsTable)
                  .set({ assignedToId })
                  .where(eq(leadsTable.id, lead.id));
                await logAudit(actor.id, canCascade ? "assignment.cascade" : "assignment.null_fill_cascade", "lead", lead.id, {
                  from: lead.assignedToId ?? null,
                  to: assignedToId,
                  source: "conversation",
                  sourceId: id,
                }, req.ip);
              }
              await cascadeLeadAssignment({
                leadId: lead.id,
                convertedStudentId: lead.convertedStudentId ?? null,
                newAssignedToId: assignedToId,
                actorUserId: actor.id,
                ipAddress: req.ip,
                nullFillOnly: !canCascade,
                throwOnError: true,
                executor: tx,
              });
            }
          }
        }
        }
        return updatedConversation;
      });
    } catch (err: any) {
      console.error("[inbox assign cascade]", err?.message || err);
      const effectiveOwnerId = await syncConversationOwner(id, req.user!.id, req.ip);
      res.status(409).json({ error: "ASSIGNMENT_SYNC_FAILED", ownerId: effectiveOwnerId });
      return;
    }
    if (!updated) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    await logAudit(req.user!.id, "assign_conversation", "conversation", id, { assignedToId }, req.ip);
    if (chainHasEntity) {
      const verifiedOwnerId = chainLink ? await getChainOwner(chainLink) : null;
      if (verifiedOwnerId !== assignedToId) {
        const effectiveOwnerId = await syncConversationOwner(id, req.user!.id, req.ip);
        res.status(409).json({ error: "ASSIGNMENT_SYNC_FAILED", ownerId: effectiveOwnerId });
        return;
      }
    }

    inboxBus.publish({
      type: "assigned",
      conversationId: id,
      assignedToId: updated.assignedToId ?? null,
      previousAssignedToId: previous?.assignedToId ?? null,
      actorUserId: req.user!.id,
    });
    if (assignedToId && assignedToId !== req.user!.id) {
      try {
        await dispatchNotification({
          event: "inbox.assigned",
          title: "Conversation assigned to you",
          body: updated.title || `${updated.channel} conversation`,
          actionUrl: `/staff/messages?conversation=${id}`,
          icon: "user",
          recipientUserIds: [assignedToId],
          actorUserId: req.user!.id,
          data: { conversationId: id },
        });
      } catch {}
    }
    res.json({ data: updated });
  },
);

router.patch(
  "/inbox/conversations/:id/bot",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const id = parseInt(String(req.params.id), 10);
    const { enabled } = req.body as { enabled: boolean };
    if (!id || typeof enabled !== "boolean") {
      res.status(400).json({ error: "enabled (boolean) is required" });
      return;
    }
    const [conversation] = await db
      .select({
        id: conversationsTable.id,
        channel: conversationsTable.channel,
        channelAccountId: conversationsTable.channelAccountId,
      })
      .from(conversationsTable)
      .where(eq(conversationsTable.id, id))
      .limit(1);
    if (!conversation) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    if (enabled && conversation.channel !== "internal") {
      const [contact] = await db
        .select({ isBlocked: externalContactsTable.isBlocked })
        .from(externalContactsTable)
        .innerJoin(conversationsTable, eq(conversationsTable.externalContactId, externalContactsTable.id))
        .where(eq(conversationsTable.id, id))
        .limit(1);
      if (contact?.isBlocked) {
        res.status(409).json({ error: "contact_blocked" });
        return;
      }
    }

    // Internal conversations can include students, agents and staff. Merely
    // knowing a conversation id must never grant control of its AI assistant.
    if (conversation.channel === "internal") {
      const [membership] = await db
        .select({ id: conversationParticipantsTable.id })
        .from(conversationParticipantsTable)
        .where(and(
          eq(conversationParticipantsTable.conversationId, id),
          eq(conversationParticipantsTable.userId, req.user!.id),
        ))
        .limit(1);
      if (!membership) {
        res.status(403).json({ error: "Not a participant" });
        return;
      }
    }

    let provider: string | null = null;
    if (conversation.channelAccountId) {
      const [account] = await db
        .select({ provider: channelAccountsTable.provider })
        .from(channelAccountsTable)
        .where(eq(channelAccountsTable.id, conversation.channelAccountId))
        .limit(1);
      provider = account?.provider ?? null;
    }
    if (enabled && !isAutoReplyChannelSupported(conversation.channel, provider)) {
      res.status(409).json({
        error: "AI auto-reply is unavailable because this channel has no configured reply transport",
      });
      return;
    }

    // Re-enabling the bot clears the needs-human flag: staff have acknowledged
    // any escalation and are handing the conversation back to the assistant.
    // Re-enabling resets the consecutive-reply counter so the handoff threshold
    // starts fresh for the next bot-led stretch.
    const [updated] = await db
      .update(conversationsTable)
      .set(enabled ? { botEnabled: true, needsHuman: false, botReplyCount: 0 } : { botEnabled: false })
      .where(eq(conversationsTable.id, id))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    await logAudit(req.user!.id, "toggle_conversation_bot", "conversation", id, { enabled }, req.ip);
    res.json({ data: { id: updated.id, botEnabled: updated.botEnabled, needsHuman: updated.needsHuman } });
  },
);

// Persisted admissions-intake state makes the bot's next expected fact,
// document and CRM action auditable. Mutations are disabled by default and
// require an explicit environment feature flag.
router.get(
  "/inbox/conversations/:id/application-intake",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const conversationId = Number(req.params.id);
    if (!Number.isInteger(conversationId) || conversationId < 1) {
      res.status(400).json({ error: "Invalid conversation id" });
      return;
    }
    const [conversation] = await db.select({ metadata: conversationsTable.metadata })
      .from(conversationsTable)
      .where(eq(conversationsTable.id, conversationId));
    if (!conversation) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    res.json({
      enabled: isApplicationIntakeActionsEnabled(),
      state: readApplicationIntakeState(conversation.metadata),
    });
  },
);

router.post(
  "/inbox/conversations/:id/application-intake/execute",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const conversationId = Number(req.params.id);
    if (!Number.isInteger(conversationId) || conversationId < 1) {
      res.status(400).json({ error: "Invalid conversation id" });
      return;
    }
    if (!isApplicationIntakeActionsEnabled()) {
      res.status(409).json({
        code: "AI_APPLICATION_INTAKE_ACTIONS_DISABLED",
        error: "AI application intake actions are disabled",
      });
      return;
    }
    const [latestInbound] = await db.select({ id: messagesTable.id })
      .from(messagesTable)
      .where(and(
        eq(messagesTable.conversationId, conversationId),
        eq(messagesTable.direction, "inbound"),
      ))
      .orderBy(desc(messagesTable.id))
      .limit(1);
    if (!latestInbound) {
      res.status(409).json({ error: "Conversation has no inbound message" });
      return;
    }
    try {
      const result = await executeApplicationIntakePendingActions({
        conversationId,
        inboundMessageId: latestInbound.id,
      });
      await writeAudit({
        userId: req.user!.id,
        action: "inbox_ai_application_intake_execute",
        resource: "conversation",
        resourceId: conversationId,
        changes: {
          createdStudentId: result.createdStudentId,
          createdApplicationId: result.createdApplicationId,
          finalPhase: result.state.phase,
        },
        ipAddress: req.ip,
      });
      res.json(result);
    } catch (error) {
      console.error(`[INBOX] application intake execution failed for conversation #${conversationId}:`, error);
      res.status(409).json({
        error: error instanceof Error ? error.message : "Application intake action failed",
      });
    }
  },
);

router.patch(
  "/inbox/conversations/:id/block",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const id = parseInt(String(req.params.id), 10);
    const { blocked } = req.body as { blocked?: boolean };
    if (!id || typeof blocked !== "boolean") {
      res.status(400).json({ error: "blocked (boolean) is required" });
      return;
    }
    if (await isConversationEntityBlocked(req.user!, id)) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    const [conversation] = await db
      .select({ externalContactId: conversationsTable.externalContactId, channel: conversationsTable.channel })
      .from(conversationsTable)
      .where(eq(conversationsTable.id, id))
      .limit(1);
    if (!conversation?.externalContactId || conversation.channel === "internal") {
      res.status(404).json({ error: "Conversation has no external contact" });
      return;
    }
    const [contact] = await db
      .update(externalContactsTable)
      .set({ isBlocked: blocked, blockedAt: blocked ? new Date() : null })
      .where(eq(externalContactsTable.id, conversation.externalContactId))
      .returning({ id: externalContactsTable.id, isBlocked: externalContactsTable.isBlocked, blockedAt: externalContactsTable.blockedAt });
    if (!contact) {
      res.status(404).json({ error: "External contact not found" });
      return;
    }
    if (blocked) {
      await db
        .update(conversationsTable)
        .set({ botEnabled: false, botReplyCount: 0 })
        .where(eq(conversationsTable.externalContactId, conversation.externalContactId));
    }
    await logAudit(req.user!.id, blocked ? "block_external_contact" : "unblock_external_contact", "external_contact", contact.id, { conversationId: id }, req.ip);
    res.json({ data: contact });
  },
);

router.post(
  "/inbox/conversations/:id/match",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const id = parseInt(String(req.params.id), 10);
    const { type, entityId } = req.body as { type: "lead" | "student" | "agent"; entityId: number };
    if (!id || !type || !entityId) {
      res.status(400).json({ error: "type and entityId are required" });
      return;
    }
    const [conv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, id));
    if (!conv || !conv.externalContactId) {
      res.status(404).json({ error: "Conversation has no external contact" });
      return;
    }
    const updates: { leadId: number | null; studentId: number | null; agentId: number | null } = {
      leadId: null,
      studentId: null,
      agentId: null,
    };
    if (type === "lead") updates.leadId = entityId;
    if (type === "student") updates.studentId = entityId;
    if (type === "agent") updates.agentId = entityId;

    // When re-matching a lead-linked conversation to a student, retain the lead
    // relationship and adopt its staged documents. The lead keeps the original
    // university/program intent while the student becomes the active entity.
    if (type === "student") {
      const [contact] = await db
        .select({ leadId: externalContactsTable.leadId })
        .from(externalContactsTable)
        .where(eq(externalContactsTable.id, conv.externalContactId));
      if (contact?.leadId != null) {
        updates.leadId = contact.leadId;
        await db
          .update(documentsTable)
          .set({ studentId: entityId })
          .where(and(
            eq(documentsTable.leadId, contact.leadId),
            isNull(documentsTable.studentId),
            isNull(documentsTable.deletedAt),
          ));
        // Record the lead→student relationship (fill-only) so future doc
        // adoption and cross-entity lookups can traverse it.
        await db
          .update(leadsTable)
          .set({ convertedStudentId: entityId })
          .where(and(eq(leadsTable.id, contact.leadId), isNull(leadsTable.convertedStudentId)));
        await recomputeStudentPhoto(entityId);
      }
    }

    await db.update(externalContactsTable).set(updates).where(eq(externalContactsTable.id, conv.externalContactId));
    await db.update(conversationsTable).set({ unmatched: false }).where(eq(conversationsTable.id, id));
    // Single-owner rule: adopt the chain owner onto the conversation (or
    // null-fill the chain from the conversation owner) right after linking.
    await syncConversationOwner(id, req.user!.id, req.ip);
    await logAudit(req.user!.id, "match_conversation", "conversation", id, { type, entityId }, req.ip);
    res.json({ ok: true });
  },
);

router.get(
  "/inbox/conversations/:id/match-suggestions",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const id = parseInt(String(req.params.id), 10);
    const [conv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, id));
    if (!conv || !conv.externalContactId) {
      res.json({ outcome: "none", candidates: [] });
      return;
    }
    const [contact] = await db.select().from(externalContactsTable).where(eq(externalContactsTable.id, conv.externalContactId));
    if (!contact) {
      res.json({ outcome: "none", candidates: [] });
      return;
    }
    const result = await resolveIdentity({ phone: contact.phone, email: contact.email });
    res.json(result);
  },
);

// ---------------------------------------------------------------------------
// Shared param schema (used by Faz 1 routes below and Phase 2 routes further below)
// ---------------------------------------------------------------------------

const conversationIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

// ---------------------------------------------------------------------------
// Faz 1 — Smart lead creation from conversation (AI pre-fill + duplicate guard)
// ---------------------------------------------------------------------------

const LEAD_EXTRACTION_MODEL = "claude-haiku-4-5-20251001";

router.get(
  "/inbox/conversations/:id/lead-suggestion",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  requireAgentStaffPermission("leads"),
  validate({ params: conversationIdParamSchema }),
  async (req, res): Promise<void> => {
    const { params } = getValidated<{ params: typeof conversationIdParamSchema }>(req);
    const id = params.id;

    const [conv] = await db
      .select({ id: conversationsTable.id, externalContactId: conversationsTable.externalContactId })
      .from(conversationsTable)
      .where(eq(conversationsTable.id, id));
    if (!conv) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const suggestion: Record<string, unknown> = {};

    if (conv.externalContactId) {
      const [contact] = await db
        .select()
        .from(externalContactsTable)
        .where(eq(externalContactsTable.id, conv.externalContactId));
      if (contact) {
        if (contact.phoneE164 || contact.phone) {
          suggestion.phone = contact.phoneE164 || contact.phone;
        }
        if (contact.displayName) {
          suggestion.displayName = contact.displayName;
        }
      }
    }

    // AI extraction from transcript — never throws (errors silently fold to empty suggestion)
    try {
      const transcript = await db
        .select({ direction: messagesTable.direction, content: messagesTable.content })
        .from(messagesTable)
        .where(eq(messagesTable.conversationId, id))
        .orderBy(asc(messagesTable.createdAt))
        .limit(30);

      if (transcript.length > 0) {
        const text = transcript
          .map((m) => `[${m.direction === "inbound" ? "Customer" : "Agent"}] ${m.content}`)
          .join("\n");

        const extracted = await extractLeadFromTranscript({ transcript: text });
        if (extracted.fullName) {
          suggestion.fullName = extracted.fullName;
          if (extracted.fullNameConfidence === "low") suggestion.fullNameLowConfidence = true;
        }
        if (extracted.email) {
          suggestion.email = extracted.email;
          if (extracted.emailConfidence === "low") suggestion.emailLowConfidence = true;
        }
      }
    } catch {
      // Swallow all AI / parse errors — return partial suggestion
    }

    res.json({ suggestion });
  },
);

const createLeadFromConversationBodySchema = z.object({
  fullName: z.string().min(1).max(200),
  email: z.string().email().nullable().optional(),
  phone: z.string().max(50).nullable().optional(),
});

router.post(
  "/inbox/conversations/:id/create-lead",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  requireAgentStaffPermission("leads"),
  validate({ params: conversationIdParamSchema, body: createLeadFromConversationBodySchema }),
  async (req, res): Promise<void> => {
    const { params, body } = getValidated<{
      params: typeof conversationIdParamSchema;
      body: typeof createLeadFromConversationBodySchema;
    }>(req);
    const id = params.id;

    const [conv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, id));
    if (!conv || !conv.externalContactId) {
      res.status(404).json({ error: "Conversation not found or has no external contact" });
      return;
    }
    const [contact] = await db
      .select()
      .from(externalContactsTable)
      .where(eq(externalContactsTable.id, conv.externalContactId));
    if (!contact) {
      res.status(404).json({ error: "External contact not found" });
      return;
    }

    // Parse fullName into first/last
    const trimmedName = body.fullName.trim();
    // Latin-only name enforcement — reject non-Latin (Arabic/Cyrillic/CJK)
    // names before any record is created (mirrors embed/students/leads).
    if (containsNonLatinLetter(trimmedName)) {
      res.status(400).json({ error: `${NON_LATIN_NAME_CODE}:fullName: This field must contain only Latin letters.` });
      return;
    }
    const parts = trimmedName.split(/\s+/).filter(Boolean);
    const firstName = parts[0] || trimmedName;
    const lastName = parts.slice(1).join(" ") || "Contact";

    const email = body.email?.trim().toLowerCase() || contact.email || null;
    const phoneForCheck = body.phone?.trim() || contact.phone || null;

    // Duplicate lead guard — uses resolveIdentity to avoid re-implementing phone/email normalisation
    const resolution = await resolveIdentity({ phone: phoneForCheck, email });
    const existingLead = resolution.candidates.find((c) => c.type === "lead");
    if (existingLead) {
      const [candidate] = await db
        .select({
          id: leadsTable.id,
          firstName: leadsTable.firstName,
          lastName: leadsTable.lastName,
          email: leadsTable.email,
          phone: leadsTable.phone,
          status: leadsTable.status,
        })
        .from(leadsTable)
        .where(and(eq(leadsTable.id, existingLead.id), isNull(leadsTable.deletedAt)));
      if (candidate) {
        res.status(409).json({ error: "LEAD_EXISTS", candidate });
        return;
      }
    }

    // Single TX: insert lead + link external_contact + mark conversation matched
    const lead = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(leadsTable)
        .values({
          firstName: toLatinUpper(firstName).slice(0, 100),
          lastName: toLatinUpper(lastName).slice(0, 100),
          email: email || null,
          phone: phoneForCheck ? normalizePhoneField(phoneForCheck) : null,
          phoneE164: contact.phoneE164 || null,
          source: conv.channel,
          status: "new",
          ...directOrigin(),
        })
        .returning();

      await tx
        .update(externalContactsTable)
        .set({ leadId: inserted.id })
        .where(eq(externalContactsTable.id, contact.id));

      await tx
        .update(conversationsTable)
        .set({ unmatched: false })
        .where(eq(conversationsTable.id, id));

      return inserted;
    });

    await applyLeadAssignmentRules({ ...lead, channelAccountId: conv.channelAccountId }, req.ip);
    // Single-owner rule: sync conversation ⇄ freshly created lead ownership.
    await syncConversationOwner(id, req.user!.id, req.ip);
    logAudit(
      req.user!.id,
      "create_lead_from_inbox_smart",
      "lead",
      lead.id,
      { conversationId: id, method: "ai_prefill" },
      req.ip,
    );

    res.status(201).json({ ok: true, leadId: lead.id });
  },
);

router.post(
  "/inbox/conversations/:id/match/new-lead",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const id = parseInt(String(req.params.id), 10);
    const [conv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, id));
    if (!conv || !conv.externalContactId) {
      res.status(404).json({ error: "Conversation has no external contact" });
      return;
    }
    const [contact] = await db.select().from(externalContactsTable).where(eq(externalContactsTable.id, conv.externalContactId));
    if (!contact) {
      res.status(404).json({ error: "External contact not found" });
      return;
    }
    const displayName = contact.displayName || "Unknown";
    // Latin-only name enforcement — a non-Latin WhatsApp/chat display name must
    // not create a lead; staff can use the smart-new-lead flow to type a Latin name.
    if (containsNonLatinLetter(displayName)) {
      res.status(400).json({ error: `${NON_LATIN_NAME_CODE}:fullName: This field must contain only Latin letters.` });
      return;
    }
    const [firstName, ...rest] = displayName.split(/\s+/);
    const lastName = rest.join(" ") || "Contact";
    const [lead] = await db
      .insert(leadsTable)
      .values({
        firstName: toLatinUpper(firstName).slice(0, 100),
        lastName: toLatinUpper(lastName).slice(0, 100),
        email: contact.email || null,
        phone: contact.phone ? normalizePhoneField(contact.phone) : null,
        phoneE164: contact.phoneE164 || null,
        source: conv.channel,
        status: "new",
        ...directOrigin(),
      })
      .returning();
    await db.update(externalContactsTable).set({ leadId: lead.id }).where(eq(externalContactsTable.id, contact.id));
    await db.update(conversationsTable).set({ unmatched: false }).where(eq(conversationsTable.id, id));
    await applyLeadAssignmentRules({ ...lead, channelAccountId: conv.channelAccountId }, req.ip);
    // Single-owner rule: sync conversation ⇄ freshly created lead ownership.
    await syncConversationOwner(id, req.user!.id, req.ip);
    await logAudit(req.user!.id, "create_lead_from_inbox", "lead", lead.id, { conversationId: id }, req.ip);
    res.status(201).json({ ok: true, leadId: lead.id });
  },
);

/**
 * Forward an existing message (content + attachments) to other conversations.
 * Body: { conversationIds: number[] } — max 10 targets per call.
 * Only Zernio-routed target conversations are supported (the shared transport
 * can deliver both text and re-hosted attachments); others fail per-target
 * with `unsupported_channel`. Meta-windowed channels enforce the 24h rule.
 */
router.post(
  "/inbox/messages/:messageId/forward",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const messageId = Number(req.params.messageId);
    const conversationIds = (req.body as { conversationIds?: unknown })?.conversationIds;
    if (
      !Number.isInteger(messageId) ||
      !Array.isArray(conversationIds) ||
      conversationIds.length === 0 ||
      conversationIds.length > 10 ||
      !conversationIds.every((v) => Number.isInteger(v) && v > 0)
    ) {
      res.status(400).json({ error: "conversationIds must be 1-10 conversation ids" });
      return;
    }

    const [src] = await db.select().from(messagesTable).where(eq(messagesTable.id, messageId));
    if (!src) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    const srcMeta = (src.metadata ?? {}) as {
      attachment?: { url?: string; fileUrl?: string; type?: string; fileType?: string; name?: string; fileName?: string };
      attachments?: Array<{ url?: string; fileUrl?: string; type?: string; fileType?: string; name?: string; fileName?: string }>;
    };
    const attachments = [
      ...(srcMeta.attachment ? [srcMeta.attachment] : []),
      ...(srcMeta.attachments ?? []),
    ]
      .map((a) => ({
        url: a.url ?? a.fileUrl ?? "",
        type: a.type ?? a.fileType,
        name: a.name ?? a.fileName,
      }))
      .filter((a) => a.url);
    const content = src.content && src.content !== "[attachment]" ? src.content : undefined;
    if (!content && attachments.length === 0) {
      res.status(400).json({ error: "Message has no forwardable content" });
      return;
    }

    const results: Array<{ conversationId: number; ok: boolean; error?: string }> = [];
    for (const targetId of conversationIds as number[]) {
      const [conv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, targetId));
      if (!conv) {
        results.push({ conversationId: targetId, ok: false, error: "not_found" });
        continue;
      }

      let zernioAcct: typeof channelAccountsTable.$inferSelect | undefined;
      if (conv.channelAccountId != null) {
        [zernioAcct] = await db
          .select()
          .from(channelAccountsTable)
          .where(
            and(
              eq(channelAccountsTable.id, conv.channelAccountId),
              eq(channelAccountsTable.provider, "zernio"),
            ),
          );
      }
      if (!zernioAcct) {
        results.push({ conversationId: targetId, ok: false, error: "unsupported_channel" });
        continue;
      }
      if (CHANNELS_WITH_24H_WINDOW.has(conv.channel) && !isWithin24hWindow(conv.lastInboundAt)) {
        results.push({ conversationId: targetId, ok: false, error: "outside_24h_window" });
        continue;
      }

      const result = await sendZernioConversationMessage({
        conv: {
          id: conv.id,
          channel: conv.channel,
          externalThreadId: conv.externalThreadId,
          assignedToId: conv.assignedToId ?? null,
          unmatched: conv.unmatched,
        },
        externalAccountId: zernioAcct.externalAccountId!,
        senderId: req.user!.id,
        content,
        attachments: attachments.length > 0 ? attachments : undefined,
      });

      if (result.ok && result.message?.id) {
        // Mark the new row as forwarded so the UI can show the label.
        await pool.query(
          `UPDATE messages SET metadata = coalesce(metadata, '{}'::jsonb) || $1::jsonb WHERE id = $2`,
          [JSON.stringify({ forwarded: true, forwardedFromMessageId: messageId }), result.message.id],
        );
        results.push({ conversationId: targetId, ok: true });
      } else {
        results.push({ conversationId: targetId, ok: false, error: result.precondition ?? result.error ?? "send_failed" });
      }
    }

    await logAudit(req.user!.id, "forward_inbox_message", "message", messageId, { targets: conversationIds }, req.ip);
    res.status(200).json({ results });
  },
);

/**
 * Resolve named CRM placeholders before inserting a local quick reply into the
 * composer. The send endpoint repeats this check so clients cannot bypass it.
 */
router.post(
  "/inbox/conversations/:id/template-preview",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const id = parseInt(String(req.params.id), 10);
    const content = typeof req.body?.content === "string" ? req.body.content : "";
    if (!id || !content.trim()) {
      res.status(400).json({ error: "content is required" });
      return;
    }
    const [conv] = await db
      .select({ id: conversationsTable.id })
      .from(conversationsTable)
      .where(eq(conversationsTable.id, id))
      .limit(1);
    if (!conv) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (await isConversationEntityBlocked(req.user!, id)) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const rendered = await renderConversationTemplateContent(id, content);
    if (rendered.missingVariables.length > 0) {
      res.status(422).json({
        error: "template_variables_missing",
        missingVariables: rendered.missingVariables,
        message: `Template information is missing: ${rendered.missingVariables.join(", ")}`,
      });
      return;
    }
    res.json(rendered);
  },
);

/**
 * Upload a staff-originated web-chat attachment through the API so the actual
 * bytes can be checked before they enter private storage. Signed direct uploads
 * cannot provide this guarantee because the application never sees their
 * content. The returned descriptor is accepted only by the matching
 * conversation's send endpoint.
 */
router.post(
  "/inbox/conversations/:id/web-chat-media",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  webChatMediaBody,
  async (req, res): Promise<void> => {
    const id = parseInt(String(req.params.id), 10);
    if (!id) {
      res.status(400).json({ error: "Invalid conversation" });
      return;
    }
    const [conv] = await db
      .select({ id: conversationsTable.id, channel: conversationsTable.channel })
      .from(conversationsTable)
      .where(eq(conversationsTable.id, id))
      .limit(1);
    if (!conv || conv.channel !== "web_chat" || await isConversationEntityBlocked(req.user!, id)) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    let filename = "";
    try {
      filename = decodeURIComponent(String(req.headers["x-file-name"] || "").slice(0, 540)).slice(0, 180);
    } catch {
      res.status(400).json({ error: "Invalid filename" });
      return;
    }
    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    try {
      const validated = await validateWebChatMedia(
        buffer,
        filename,
        String(req.headers["content-type"] || ""),
      );
      const objectPath = await inboxMediaStorage.uploadBuffer({
        subdir: `inbox/web-chat/${id}`,
        filename: validated.filename,
        buffer,
        contentType: validated.mimeType,
      });
      const key = objectPath.replace(/^\/objects\//, "");
      const attachment: WebChatAttachment = {
        url: `/api/storage/objects/${key}`,
        type: validated.kind,
        name: validated.filename,
        mimeType: validated.mimeType,
        fileType: validated.mimeType,
        fileSize: validated.size,
        ...(String(req.headers["x-voice-note"] || "") === "1" && validated.kind === "audio"
          ? { voiceNote: true }
          : {}),
      };
      res.status(201).json({ attachment });
    } catch (error) {
      if (error instanceof WebChatMediaValidationError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      console.error(`[INBOX] web-chat media upload failed for conversation ${id}:`, error);
      res.status(500).json({ error: "File upload failed" });
    }
  },
);

/**
 * Send an outbound message on a non-internal channel conversation.
 * Body: { content?: string, attachments?: Attachment[] }
 */
router.post(
  "/inbox/conversations/:id/messages",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const id = parseInt(String(req.params.id), 10);
    const { content: rawContent, attachments: bodyAttachments, replyToMessageId } = req.body as {
      content?: string;
      attachments?: Array<{
        url: string;
        type?: string;
        name?: string;
        mimeType?: string;
        fileType?: string;
        fileSize?: number;
        voiceNote?: boolean;
      }>;
      replyToMessageId?: number;
    };
    const replyToId: number | null = (typeof replyToMessageId === "number" && replyToMessageId > 0) ? replyToMessageId : null;
    let content = rawContent ?? "";
    const hasContent = Boolean(content.trim());
    const hasAttachments = Array.isArray(bodyAttachments) && bodyAttachments.length > 0;
    if (!id || (!hasContent && !hasAttachments)) {
      res.status(400).json({ error: "content or attachments is required" });
      return;
    }
    const [conv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, id));
    if (!conv) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (conv.externalContactId) {
      const [contact] = await db
        .select({ isBlocked: externalContactsTable.isBlocked })
        .from(externalContactsTable)
        .where(eq(externalContactsTable.id, conv.externalContactId))
        .limit(1);
      if (contact?.isBlocked) {
        res.status(409).json({ error: "contact_blocked" });
        return;
      }
    }

    if (hasContent) {
      const rendered = await renderConversationTemplateContent(id, content);
      if (rendered.missingVariables.length > 0) {
        res.status(422).json({
          error: "template_variables_missing",
          missingVariables: rendered.missingVariables,
          message: `Template information is missing: ${rendered.missingVariables.join(", ")}`,
        });
        return;
      }
      content = rendered.content;
    }

    // Human takeover: a staff member manually replying disables the intake bot
    // for this conversation so the human and the bot never talk over each other.
    if (conv.botEnabled) {
      await db
        .update(conversationsTable)
        .set({ botEnabled: false, botReplyCount: 0 })
        .where(eq(conversationsTable.id, id));
    }

    // ── Zernio-routed conversations (provider='zernio') ──────────────────────
    // Check before channel-specific direct-API branches: same channel name
    // (whatsapp/instagram/facebook/telegram) but the account is Zernio-hosted.
    if (conv.channelAccountId != null) {
      const [zernioAcct] = await db
        .select()
        .from(channelAccountsTable)
        .where(
          and(
            eq(channelAccountsTable.id, conv.channelAccountId),
            eq(channelAccountsTable.provider, "zernio"),
          ),
        );

      if (zernioAcct) {
        // Meta-windowed channels enforce the 24h free-text rule regardless of
        // whether the account is Zernio-hosted or direct (same policy as the
        // direct-API branches below and the quick-contact route).
        if (
          (conv.channel === "whatsapp" || conv.channel === "messenger" || conv.channel === "instagram") &&
          !isWithin24hWindow(conv.lastInboundAt)
        ) {
          res.status(409).json({
            error: "outside_24h_window",
            message: "Free-form replies are only allowed within 24h of the last inbound message. Use a template.",
          });
          return;
        }

        // Single source of truth for Zernio outbound — shared with quick-contact
        // (routes/messages.ts) and, at the transport level, the AI bot.
        const result = await sendZernioConversationMessage({
          conv: {
            id,
            channel: conv.channel,
            externalThreadId: conv.externalThreadId,
            assignedToId: conv.assignedToId ?? null,
            unmatched: conv.unmatched,
          },
          externalAccountId: zernioAcct.externalAccountId!,
          senderId: req.user!.id,
          content: hasContent ? content : undefined,
          attachments: hasAttachments ? bodyAttachments : undefined,
        });

        if (result.precondition === "zernio_api_key_not_configured") {
          res.status(502).json({ error: "Zernio API key not configured" });
          return;
        }
        if (result.precondition === "zernio_no_external_thread") {
          res.status(400).json({ error: "Conversation has no external thread ID" });
          return;
        }

        // CRM-only reply context: store replyToId on the message row if provided.
        if (replyToId && result.message?.id) {
          await pool.query(`UPDATE messages SET reply_to_id = $1 WHERE id = $2`, [replyToId, result.message.id]);
        }
        res.status(result.ok ? 201 : 502).json({ message: result.message, error: result.error });
        return;
      }
    }

    if (conv.channel === "whatsapp") {
      if (!isWithin24hWindow(conv.lastInboundAt)) {
        res.status(409).json({
          error: "outside_24h_window",
          message: "Free-form replies are only allowed within 24h of the last inbound message. Use a template.",
        });
        return;
      }
      if (!conv.externalContactId) {
        res.status(400).json({ error: "Conversation has no external contact" });
        return;
      }
      const [contact] = await db.select().from(externalContactsTable).where(eq(externalContactsTable.id, conv.externalContactId));
      if (!contact?.phoneE164) {
        res.status(400).json({ error: "Contact has no E.164 phone" });
        return;
      }
      const cfg: WhatsAppConfig = (await resolveOutboundConfig<WhatsAppConfig>("whatsapp", conv.channelAccountId, conv.communicationPipelineId)) || {};

      // Persist a 'pending' row first so the client can observe lifecycle.
      const [pending] = await db
        .insert(messagesTable)
        .values({
          conversationId: id,
          senderId: req.user!.id,
          content,
          channel: "whatsapp",
          direction: "outbound",
          status: "pending",
          metadata: {},
          ...(replyToId ? { replyToId } : {}),
        })
        .returning();

      const result = await sendWhatsAppText({ config: cfg, toPhoneE164: contact.phoneE164, text: content });

      const [msg] = await db
        .update(messagesTable)
        .set({
          status: result.ok ? "sent" : "failed",
          externalMessageId: result.externalMessageId || null,
          failedReason: result.ok ? null : result.error || "send_failed",
          sentAt: result.ok ? new Date() : null,
          metadata: { simulated: result.simulated, ...(result.ok ? {} : { error: result.error }) },
        })
        .where(eq(messagesTable.id, pending.id))
        .returning();

      if (result.ok) {
        await db
          .update(conversationsTable)
          .set({ lastMessageAt: new Date(), lastMessagePreview: content.slice(0, 200) })
          .where(eq(conversationsTable.id, id));
        inboxBus.publish({
          type: "message",
          conversationId: id,
          channel: "whatsapp",
          assignedToId: conv.assignedToId ?? null,
          unmatched: conv.unmatched,
          direction: "outbound",
        });
      } else {
        // Notify staff of send failure (in_app + email per default rule).
        try {
          await dispatchNotification({
            event: "inbox.send_failed",
            title: `WhatsApp send failed for conversation #${id}`,
            body: result.error || "Send failed",
            actionUrl: `/staff/messages?conversation=${id}`,
            icon: "alert",
            data: { conversationId: id, channel: "whatsapp", error: result.error },
          });
        } catch (err) {
          console.error("[INBOX] send_failed dispatch error:", err);
        }
      }
      res.status(result.ok ? 201 : 502).json({ message: msg, simulated: result.simulated, error: result.error });
      return;
    }

    if (conv.channel === "messenger" || conv.channel === "instagram") {
      if (!isWithin24hWindow(conv.lastInboundAt)) {
        res.status(409).json({
          error: "outside_24h_window",
          message: "Free-form replies are only allowed within 24h of the last inbound message.",
        });
        return;
      }
      if (!conv.externalContactId) {
        res.status(400).json({ error: "Conversation has no external contact" });
        return;
      }
      const [contact] = await db.select().from(externalContactsTable).where(eq(externalContactsTable.id, conv.externalContactId));
      // The recipient is the user's page-/IG-scoped id, stored as externalId.
      const recipientId = contact?.externalId || conv.externalThreadId || "";
      if (!recipientId) {
        res.status(400).json({ error: "Conversation has no recipient id" });
        return;
      }
      const metaCfg = (await resolveOutboundConfig<MessengerConfig & InstagramConfig>(conv.channel, conv.channelAccountId, conv.communicationPipelineId)) || {};

      // Persist a 'pending' row first so the client can observe lifecycle.
      const [pending] = await db
        .insert(messagesTable)
        .values({
          conversationId: id,
          senderId: req.user!.id,
          content,
          channel: conv.channel,
          direction: "outbound",
          status: "pending",
          metadata: {},
          ...(replyToId ? { replyToId } : {}),
        })
        .returning();

      const result =
        conv.channel === "messenger"
          ? await sendMessengerText({
              config: metaCfg as MessengerConfig,
              recipientId,
              text: content,
            })
          : await sendInstagramText({
              config: metaCfg as InstagramConfig,
              recipientId,
              text: content,
            });

      const [msg] = await db
        .update(messagesTable)
        .set({
          status: result.ok ? "sent" : "failed",
          externalMessageId: result.externalMessageId || null,
          failedReason: result.ok ? null : result.error || "send_failed",
          sentAt: result.ok ? new Date() : null,
          metadata: { simulated: result.simulated, ...(result.ok ? {} : { error: result.error }) },
        })
        .where(eq(messagesTable.id, pending.id))
        .returning();

      if (result.ok) {
        await db
          .update(conversationsTable)
          .set({ lastMessageAt: new Date(), lastMessagePreview: content.slice(0, 200) })
          .where(eq(conversationsTable.id, id));
        inboxBus.publish({
          type: "message",
          conversationId: id,
          channel: conv.channel,
          assignedToId: conv.assignedToId ?? null,
          unmatched: conv.unmatched,
          direction: "outbound",
        });
      } else {
        try {
          await dispatchNotification({
            event: "inbox.send_failed",
            title: `${conv.channel} send failed for conversation #${id}`,
            body: result.error || "Send failed",
            actionUrl: `/staff/messages?conversation=${id}`,
            icon: "alert",
            data: { conversationId: id, channel: conv.channel, error: result.error },
          });
        } catch (err) {
          console.error("[INBOX] send_failed dispatch error:", err);
        }
      }
      res.status(result.ok ? 201 : 502).json({ message: msg, simulated: result.simulated, error: result.error });
      return;
    }

    if (conv.channel === "web_chat") {
      const attachments = hasAttachments
        ? readWebChatAttachments({ attachments: bodyAttachments })
        : [];
      if (
        attachments.length !== (bodyAttachments?.length ?? 0) ||
        attachments.some((attachment) => !webChatObjectPath(attachment.url, id))
      ) {
        res.status(400).json({ error: "Invalid web chat attachment" });
        return;
      }
      const storedContent = content.trim() || (attachments.length > 0 ? "[attachment]" : "");
      const [msg] = await db
        .insert(messagesTable)
        .values({
          conversationId: id,
          senderId: req.user!.id,
          content: storedContent,
          channel: "web_chat",
          direction: "outbound",
          status: "sent",
          sentAt: new Date(),
          metadata: {
            humanSent: true,
            ...(attachments.length > 0 ? { attachments } : {}),
          },
          ...(replyToId ? { replyToId } : {}),
        })
        .returning();
      await db
        .update(conversationsTable)
        .set({
          lastMessageAt: new Date(),
          lastMessagePreview: storedContent.slice(0, 200),
          botEnabled: false,
          botReplyCount: 0,
          needsHuman: false,
        })
        .where(eq(conversationsTable.id, id));
      inboxBus.publish({
        type: "message",
        conversationId: id,
        channel: "web_chat",
        assignedToId: conv.assignedToId ?? null,
        unmatched: conv.unmatched,
        direction: "outbound",
      });
      res.status(201).json({ message: msg });
      return;
    }

    if (conv.channel === "web_form") {
      const [msg] = await db
        .insert(messagesTable)
        .values({
          conversationId: id,
          senderId: req.user!.id,
          content,
          channel: "web_form",
          direction: "outbound",
          status: "sent",
          sentAt: new Date(),
          ...(replyToId ? { replyToId } : {}),
        })
        .returning();
      await db
        .update(conversationsTable)
        .set({ lastMessageAt: new Date(), lastMessagePreview: content.slice(0, 200) })
        .where(eq(conversationsTable.id, id));
      inboxBus.publish({
        type: "message",
        conversationId: id,
        channel: "web_form",
        assignedToId: conv.assignedToId ?? null,
        unmatched: conv.unmatched,
        direction: "outbound",
      });

      // Auto-email the original submitter when an email is on file.
      let emailSent = false;
      let emailError: string | undefined;
      try {
        const [contact] = conv.externalContactId
          ? await db.select().from(externalContactsTable).where(eq(externalContactsTable.id, conv.externalContactId))
          : [null];
        if (contact?.email) {
          const subject = "Reply from our team";
          const text = content;
          const html = `<p>${content.replace(/\n/g, "<br/>")}</p>`;
          await sendEmail(contact.email, { subject, html, text });
          emailSent = true;
          await db
            .update(messagesTable)
            .set({ metadata: { emailedTo: contact.email } })
            .where(eq(messagesTable.id, msg.id));
        }
      } catch (err) {
        emailError = err instanceof Error ? err.message : String(err);
        console.error("[INBOX] web_form email auto-reply failed:", err);
        try {
          await dispatchNotification({
            event: "inbox.send_failed",
            title: `Web form reply email failed for conversation #${id}`,
            body: emailError,
            actionUrl: `/staff/messages?conversation=${id}`,
            icon: "alert",
            data: { conversationId: id, channel: "web_form", error: emailError },
          });
        } catch {}
      }
      res.status(201).json({
        message: msg,
        emailSent,
        ...(emailError ? { emailError } : {}),
        note: emailSent
          ? "Reply emailed to submitter."
          : "Recorded; submitter has no email on file.",
      });
      return;
    }

    res.status(400).json({ error: `Channel '${conv.channel}' is not supported by this endpoint` });
  },
);

// Toggle an emoji reaction on a message. POST with { emoji } adds if absent,
// removes if the same user already reacted with that emoji (toggle semantics).
router.post(
  "/inbox/conversations/:id/messages/:msgId/react",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const msgId = parseInt(String(req.params.msgId), 10);
    const { emoji } = req.body as { emoji?: string };
    if (!msgId || !emoji || typeof emoji !== "string" || emoji.length > 12) {
      res.status(400).json({ error: "invalid params" });
      return;
    }
    const userId = req.user!.id;
    const existing = await pool.query<{ id: number }>(
      `SELECT id FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3`,
      [msgId, userId, emoji],
    );
    if (existing.rows.length > 0) {
      await pool.query(
        `DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3`,
        [msgId, userId, emoji],
      );
      res.json({ toggled: false, emoji });
    } else {
      await pool.query(
        `INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [msgId, userId, emoji],
      );
      res.json({ toggled: true, emoji });
    }
  },
);

// Retry a failed outbound message through the same send paths as the manual
// composer (Zernio-hosted → Zernio API; otherwise direct channel senders).
router.post(
  "/inbox/messages/:id/retry",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const msgId = parseInt(String(req.params.id), 10);
    if (!msgId) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [msg] = await db.select().from(messagesTable).where(eq(messagesTable.id, msgId));
    if (!msg) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (msg.direction !== "outbound" || msg.status !== "failed") {
      res.status(409).json({ error: "only_failed_outbound_retryable" });
      return;
    }
    const [conv] = await db
      .select()
      .from(conversationsTable)
      .where(eq(conversationsTable.id, msg.conversationId));
    if (!conv) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }

    const meta = (msg.metadata ?? {}) as Record<string, any>;
    const attachments = Array.isArray(meta.attachments) ? meta.attachments : undefined;
    const text = msg.content && msg.content !== "[attachment]" ? msg.content : undefined;

    let ok = false;
    let error: string | undefined;
    let externalMessageId: string | undefined;
    let handled = false;

    const zernioAcct = await resolveZernioAccount(conv.channelAccountId);
    if (zernioAcct && conv.externalThreadId) {
      handled = true;
      const outcome = await sendViaZernio({
        externalThreadId: conv.externalThreadId,
        externalAccountId: zernioAcct.externalAccountId,
        text,
        attachments,
      });
      ok = outcome.ok;
      error = outcome.error;
      externalMessageId = outcome.externalMessageId;
    } else if (conv.channel === "whatsapp") {
      handled = true;
      if (!isWithin24hWindow(conv.lastInboundAt)) {
        res.status(409).json({ error: "outside_24h_window" });
        return;
      }
      const [contact] = conv.externalContactId
        ? await db.select().from(externalContactsTable).where(eq(externalContactsTable.id, conv.externalContactId))
        : [null];
      if (!contact?.phoneE164) {
        res.status(400).json({ error: "Contact has no E.164 phone" });
        return;
      }
      const cfg: WhatsAppConfig =
        (await resolveOutboundConfig<WhatsAppConfig>("whatsapp", conv.channelAccountId, conv.communicationPipelineId)) || {};
      const result = await sendWhatsAppText({ config: cfg, toPhoneE164: contact.phoneE164, text: text || "" });
      ok = result.ok;
      error = result.error;
      externalMessageId = result.externalMessageId;
    } else if (conv.channel === "messenger" || conv.channel === "instagram") {
      handled = true;
      if (!isWithin24hWindow(conv.lastInboundAt)) {
        res.status(409).json({ error: "outside_24h_window" });
        return;
      }
      const [contact] = conv.externalContactId
        ? await db.select().from(externalContactsTable).where(eq(externalContactsTable.id, conv.externalContactId))
        : [null];
      const recipientId = contact?.externalId || conv.externalThreadId || "";
      if (!recipientId) {
        res.status(400).json({ error: "Conversation has no recipient id" });
        return;
      }
      const metaCfg =
        (await resolveOutboundConfig<MessengerConfig & InstagramConfig>(conv.channel, conv.channelAccountId, conv.communicationPipelineId)) || {};
      const result =
        conv.channel === "messenger"
          ? await sendMessengerText({ config: metaCfg as MessengerConfig, recipientId, text: text || "" })
          : await sendInstagramText({ config: metaCfg as InstagramConfig, recipientId, text: text || "" });
      ok = result.ok;
      error = result.error;
      externalMessageId = result.externalMessageId;
    }

    if (!handled) {
      res.status(400).json({ error: `Channel '${conv.channel}' does not support retry` });
      return;
    }

    const [updated] = await db
      .update(messagesTable)
      .set({
        status: ok ? "sent" : "failed",
        externalMessageId: externalMessageId || msg.externalMessageId,
        failedReason: ok ? null : error || "send_failed",
        sentAt: ok ? new Date() : null,
        metadata: { ...meta, retriedAt: new Date().toISOString(), ...(ok ? {} : { error }) },
      })
      .where(eq(messagesTable.id, msgId))
      .returning();

    if (ok) {
      inboxBus.publish({
        type: "message",
        conversationId: conv.id,
        channel: conv.channel,
        assignedToId: conv.assignedToId ?? null,
        unmatched: conv.unmatched,
        direction: "outbound",
      });
    }
    res.status(ok ? 200 : 502).json({ message: updated, error });
  },
);

// ─── Bulk conversation management ─────────────────────────────────────────
const bulkIdsSchema = z.object({ ids: z.array(z.number().int().positive()).min(1).max(500) });
const bulkDeleteSchema = z
  .object({
    ids: z.array(z.number().int().positive()).min(1).max(100),
    confirm: z.literal("DELETE_CONVERSATIONS"),
  })
  .strict()
  .refine((body) => new Set(body.ids).size === body.ids.length, {
    message: "Duplicate conversation ids are not allowed",
    path: ["ids"],
  });

/** Internal (user-DM) conversations require participant membership for non-admins. */
async function filterBulkAccessibleIds(userId: number, isAdmin: boolean, ids: number[]): Promise<number[]> {
  const rows = await db
    .select({ id: conversationsTable.id, channel: conversationsTable.channel })
    .from(conversationsTable)
    .where(inArray(conversationsTable.id, ids));
  const internalIds = rows.filter((r) => r.channel === "internal").map((r) => r.id);
  let allowedInternal = new Set<number>(internalIds);
  if (!isAdmin && internalIds.length > 0) {
    const parts = await db
      .select({ conversationId: conversationParticipantsTable.conversationId })
      .from(conversationParticipantsTable)
      .where(
        and(
          inArray(conversationParticipantsTable.conversationId, internalIds),
          eq(conversationParticipantsTable.userId, userId),
        ),
      );
    allowedInternal = new Set(parts.map((p) => p.conversationId));
  }
  return rows
    .filter((r) => r.channel !== "internal" || allowedInternal.has(r.id))
    .map((r) => r.id);
}

router.post(
  "/inbox/conversations/bulk-archive",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const parsed = bulkIdsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "ids array required" });
      return;
    }
    const isAdmin = (ADMIN_ROLES as readonly string[]).includes(req.user!.role);
    const ids = await filterBulkAccessibleIds(req.user!.id, isAdmin, parsed.data.ids);
    if (ids.length === 0) {
      res.json({ archived: 0 });
      return;
    }
    const updated = await db
      .update(conversationsTable)
      .set({ isArchived: true })
      .where(inArray(conversationsTable.id, ids))
      .returning({ id: conversationsTable.id });
    res.json({ archived: updated.length });
  },
);

router.post(
  "/inbox/conversations/bulk-unarchive",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const parsed = bulkIdsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "ids array required" });
      return;
    }
    const isAdmin = (ADMIN_ROLES as readonly string[]).includes(req.user!.role);
    const ids = await filterBulkAccessibleIds(req.user!.id, isAdmin, parsed.data.ids);
    if (ids.length === 0) {
      res.json({ restored: 0 });
      return;
    }
    const updated = await db
      .update(conversationsTable)
      .set({ isArchived: false })
      .where(inArray(conversationsTable.id, ids))
      .returning({ id: conversationsTable.id });
    res.json({ restored: updated.length });
  },
);

router.post(
  "/inbox/conversations/bulk-delete",
  requireAuth,
  requireRole("super_admin", "admin"),
  async (req, res): Promise<void> => {
    const parsed = bulkDeleteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Explicit delete confirmation and a unique ids array are required" });
      return;
    }

    const requestedIds = [...parsed.data.ids].sort((a, b) => a - b);
    const outcome = await db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: conversationsTable.id })
        .from(conversationsTable)
        .where(inArray(conversationsTable.id, requestedIds))
        .for("update");
      const existingIds = existing.map((row) => row.id).sort((a, b) => a - b);

      if (
        existingIds.length !== requestedIds.length ||
        existingIds.some((id, index) => id !== requestedIds[index])
      ) {
        return { conflict: true as const };
      }

      const [messageStats] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(messagesTable)
        .where(inArray(messagesTable.conversationId, requestedIds));

      // Documents copied from inbox attachments are business records and must
      // survive conversation deletion. Only their now-dangling source pointers
      // are cleared; stored files are deliberately not deleted here.
      await tx
        .update(documentsTable)
        .set({
          sourceConversationId: null,
          sourceMessageId: null,
          sourceAttachmentId: null,
        })
        .where(inArray(documentsTable.sourceConversationId, requestedIds));

      const deleted = await tx
        .delete(conversationsTable)
        .where(inArray(conversationsTable.id, requestedIds))
        .returning({ id: conversationsTable.id });

      await tx.insert(auditLogsTable).values({
        userId: req.user!.id,
        action: "delete_inbox_conversations",
        resource: "conversation",
        changes: JSON.stringify({
          conversationIds: deleted.map((row) => row.id).sort((a, b) => a - b),
          conversationCount: deleted.length,
          messageCount: Number(messageStats?.count ?? 0),
        }),
        ipAddress: req.ip || null,
      });

      return {
        conflict: false as const,
        deleted: deleted.length,
        deletedIds: deleted.map((row) => row.id),
      };
    });

    if (outcome.conflict) {
      res.status(409).json({ error: "Conversation selection changed; refresh and select again" });
      return;
    }

    res.json({ deleted: outcome.deleted, deletedIds: outcome.deletedIds });
  },
);

/**
 * Account-aware template picker source. A global DB row is only a cache; the
 * provider-side approved template list of the target WhatsApp line is the
 * authority. This endpoint is read-only and never syncs/mutates the cache.
 */
router.get(
  "/inbox/whatsapp-templates/available",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const conversationId = req.query.conversationId
      ? parseInt(String(req.query.conversationId), 10)
      : 0;
    const entityType = String(req.query.entityType || "");
    const entityId = req.query.entityId ? parseInt(String(req.query.entityId), 10) : 0;

    let account: EntityWhatsAppTarget | null = null;
    let templateContext: MessageTemplateVariableContext = {};

    if (conversationId) {
      const [conv] = await db
        .select({ channel: conversationsTable.channel, channelAccountId: conversationsTable.channelAccountId })
        .from(conversationsTable)
        .where(eq(conversationsTable.id, conversationId));
      if (!conv || conv.channel !== "whatsapp") {
        res.status(404).json({ error: "whatsapp_conversation_not_found" });
        return;
      }
      if (await isConversationEntityBlocked(req.user!, conversationId)) {
        res.status(404).json({ error: "whatsapp_conversation_not_found" });
        return;
      }
      const resolved = await resolveZernioWhatsAppAccount(conv.channelAccountId);
      account = resolved ? { ...resolved, conversationId } : null;
      templateContext = await loadConversationTemplateVariableContext(conversationId);
    } else if ((entityType === "lead" || entityType === "student" || entityType === "application") && entityId) {
      let entityAgentId: number | null | undefined;
      let contactCondition: SQL;
      if (entityType === "lead") {
        const [lead] = await db
          .select({ agentId: leadsTable.agentId })
          .from(leadsTable)
          .where(eq(leadsTable.id, entityId));
        if (!lead) { res.status(404).json({ error: "entity_not_found" }); return; }
        entityAgentId = lead.agentId;
        contactCondition = eq(externalContactsTable.leadId, entityId);
      } else if (entityType === "student") {
        const [student] = await db
          .select({ agentId: studentsTable.agentId })
          .from(studentsTable)
          .where(eq(studentsTable.id, entityId));
        if (!student) { res.status(404).json({ error: "entity_not_found" }); return; }
        entityAgentId = student.agentId;
        contactCondition = eq(externalContactsTable.studentId, entityId);
      } else {
        const [application] = await db
          .select({ studentId: applicationsTable.studentId, agentId: applicationsTable.agentId })
          .from(applicationsTable)
          .where(eq(applicationsTable.id, entityId));
        if (!application?.studentId) { res.status(404).json({ error: "entity_not_found" }); return; }
        const [student] = await db
          .select({
            agentId: studentsTable.agentId,
            phoneE164: studentsTable.phoneE164,
            phone: studentsTable.phone,
            firstName: studentsTable.firstName,
            lastName: studentsTable.lastName,
          })
          .from(studentsTable)
          .where(eq(studentsTable.id, application.studentId));
        const target = resolveApplicationMessageTarget(application, student);
        if (!target) { res.status(404).json({ error: "entity_not_found" }); return; }
        entityAgentId = target.agentId;
        contactCondition = eq(externalContactsTable.studentId, target.studentId);
      }
      if (entityAgentId !== undefined && isAgentSourcedAndBlockedForStaff(req.user!, entityAgentId)) {
        res.status(404).json({ error: "entity_not_found" });
        return;
      }
      account = await resolveEntityWhatsAppTarget(contactCondition);
      templateContext = await loadEntityTemplateVariableContext(
        entityType as MessageTemplateEntityType,
        entityId,
      );
    } else {
      res.status(400).json({ error: "conversationId or entityType/entityId is required" });
      return;
    }

    if (!account) {
      res.status(409).json({ error: "no_zernio_account", detail: "No active WhatsApp line is available for this recipient." });
      return;
    }

    const provider = await listZernioWhatsAppTemplates(account.externalAccountId);
    if (!provider.ok) {
      res.status(502).json({
        error: "template_availability_check_failed",
        detail: `Approved templates for WhatsApp line “${account.displayName}” could not be verified.`,
      });
      return;
    }

    const localTemplates = await db
      .select()
      .from(messageTemplatesTable)
      .where(and(
        eq(messageTemplatesTable.isActive, true),
        or(eq(messageTemplatesTable.channel, "whatsapp"), eq(messageTemplatesTable.channel, "all")),
        isNotNull(messageTemplatesTable.externalTemplateName),
      ))
      .orderBy(messageTemplatesTable.category, messageTemplatesTable.name);

    const data = localTemplates.flatMap((template) => {
      const remote = findApprovedZernioTemplate(
        provider.templates,
        template.externalTemplateName || "",
        template.language,
      );
      if (!remote) return [];
      const variableMappings = preservedTemplateMappings(template.variables, remote.variableCount);
      const preview = resolveTemplateMappingPreview(variableMappings, templateContext);
      return [{
        ...template,
        content: remote.bodyText || template.content,
        language: remote.language,
        approvalStatus: "approved",
        variables: variableMappings,
        resolvedParameters: preview.resolvedParameters,
        missingVariables: preview.missingVariables,
      }];
    });

    res.json({
      data,
      channelAccount: {
        id: account.id,
        displayName: account.displayName,
        isDefault: account.isDefault,
      },
    });
  },
);

router.post(
  "/inbox/conversations/:id/templates",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const id = parseInt(String(req.params.id), 10);
    const { templateId, parameters } = req.body as { templateId: number; parameters?: string[] };
    if (!id || !templateId) {
      res.status(400).json({ error: "templateId is required" });
      return;
    }
    const [conv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, id));
    if (!conv || conv.channel !== "whatsapp") {
      res.status(400).json({ error: "Templates are only supported on WhatsApp conversations" });
      return;
    }
    if (await isConversationEntityBlocked(req.user!, id)) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    if (!conv.externalContactId) {
      res.status(400).json({ error: "Conversation has no external contact" });
      return;
    }
    const [contact] = await db.select().from(externalContactsTable).where(eq(externalContactsTable.id, conv.externalContactId));
    if (contact?.isBlocked) {
      res.status(409).json({ error: "contact_blocked" });
      return;
    }
    if (!contact?.phoneE164) {
      res.status(400).json({ error: "Contact has no E.164 phone" });
      return;
    }
    const [tpl] = await db.select().from(messageTemplatesTable).where(eq(messageTemplatesTable.id, templateId));
    if (!tpl || !tpl.externalTemplateName) {
      res.status(400).json({ error: "Template missing externalTemplateName" });
      return;
    }

    // Pre-send guard: the number of provided parameters MUST exactly match
    // the template body's placeholder count ({{1}}, {{2}}, …) — otherwise
    // Meta rejects the send with the opaque error 132000. Fail early with a
    // human-readable message instead.
    const placeholderMatches = (tpl.content || "").match(/\{\{\s*\d+\s*\}\}/g);
    const placeholderCount = placeholderMatches ? new Set(placeholderMatches.map((m) => m.replace(/\D/g, ""))).size : 0;
    let providedParams = parameters?.map((value) => String(value || "").trim());
    if (providedParams == null) {
      const mappings = preservedTemplateMappings(tpl.variables, placeholderCount);
      const context = await loadConversationTemplateVariableContext(id);
      const preview = resolveTemplateMappingPreview(mappings, context);
      if (preview.missingVariables.length > 0) {
        res.status(422).json({
          error: "template_variables_missing",
          detail: `Missing template data: ${preview.missingVariables.join(", ")}`,
        });
        return;
      }
      providedParams = preview.resolvedParameters;
    }
    if (providedParams.length !== placeholderCount) {
      res.status(400).json({
        error: `Template gönderilemedi: şablonda ${placeholderCount} değişken var, ${providedParams.length} değer girildi. Lütfen tüm değişkenleri doldurun.`,
      });
      return;
    }

    // Route through Zernio for Zernio-hosted numbers; fall back to Meta Cloud
    // only when the account is not Zernio (which currently never applies — we
    // have no direct Meta Cloud credentials).
    const zernioAcctForTpl = await resolveZernioAccount(conv.channelAccountId);
    let result: { ok: boolean; externalMessageId?: string; error?: string; simulated: boolean; broadcastId?: string };
    if (zernioAcctForTpl) {
      // Zernio has no per-conversation template endpoint — templates go out
      // through the 3-step broadcast flow keyed by the recipient's phone.
      const phoneE164 = toE164(contact.phoneE164) || (contact.phoneE164.startsWith("+") ? contact.phoneE164 : null);
      if (!phoneE164) {
        res.status(400).json({ error: "Template gönderilemedi: alıcının telefon numarası E.164 formatına çevrilemedi." });
        return;
      }
      const availability = await resolveApprovedZernioTemplate({
        externalAccountId: zernioAcctForTpl.externalAccountId,
        templateName: tpl.externalTemplateName,
        preferredLanguage: tpl.language,
      });
      if (!availability.ok) {
        if (availability.reason === "provider_unavailable") {
          res.status(502).json({
            error: "template_availability_check_failed",
            detail: "The approved-template list for this WhatsApp line could not be verified. Nothing was sent.",
          });
        } else {
          res.status(409).json({
            error: "template_not_approved_for_whatsapp_account",
            detail: `Template “${tpl.externalTemplateName}” is not approved for the WhatsApp line used by this conversation.`,
          });
        }
        return;
      }
      const zr = await sendZernioTemplate({
        externalAccountId: zernioAcctForTpl.externalAccountId,
        templateName: tpl.externalTemplateName,
        language: availability.template.language,
        toPhoneE164: phoneE164,
        parameters: providedParams,
        recipientLabel: contact.displayName || phoneE164,
      });
      result = { ok: zr.ok, externalMessageId: zr.externalMessageId, error: zr.error, broadcastId: zr.broadcastId, simulated: false };
    } else {
      const cfg: WhatsAppConfig = (await resolveOutboundConfig<WhatsAppConfig>("whatsapp", conv.channelAccountId, conv.communicationPipelineId)) || {};
      result = await sendWhatsAppTemplate({
        config: cfg,
        toPhoneE164: contact.phoneE164,
        templateName: tpl.externalTemplateName,
        language: tpl.language || "en",
        parameters: providedParams,
      });
    }

    const renderedContent = providedParams.reduce<string>(
      (acc, val, idx) => acc.replace(new RegExp(`\\{\\{${idx + 1}\\}\\}`, "g"), val),
      tpl.content,
    );

    const [msg] = await db
      .insert(messagesTable)
      .values({
        conversationId: id,
        senderId: req.user!.id,
        content: renderedContent,
        channel: "whatsapp",
        direction: "outbound",
        status: result.ok ? "sent" : "failed",
        externalMessageId: result.externalMessageId || null,
        failedReason: result.ok ? null : result.error || "send_failed",
        sentAt: result.ok ? new Date() : null,
        metadata: {
          simulated: result.simulated,
          template: tpl.externalTemplateName,
          // Broadcast is asynchronous — the delivery/read webhook is matched
          // back to this message via the Zernio broadcast id.
          ...(result.broadcastId ? { broadcastId: result.broadcastId } : {}),
        },
      })
      .returning();
    if (result.ok) {
      await db
        .update(conversationsTable)
        .set({ lastMessageAt: new Date(), lastMessagePreview: renderedContent.slice(0, 200) })
        .where(eq(conversationsTable.id, id));
      inboxBus.publish({
        type: "message",
        conversationId: id,
        channel: "whatsapp",
        assignedToId: conv.assignedToId ?? null,
        unmatched: conv.unmatched,
        direction: "outbound",
      });
    }
    res.status(result.ok ? 201 : 502).json({ message: msg, simulated: result.simulated, error: result.error });
  },
);

/**
 * Layer A — WhatsApp Cloud API template management, proxied through Zernio
 * (the account is hosted on Zernio, same reasoning as zernioSend.ts). Listing
 * also syncs the results into `message_templates` (matched by
 * externalTemplateName+language) so the existing send flow
 * (POST /inbox/conversations/:id/templates) keeps working unchanged and the
 * Templates management page can show both "our" canned responses and the
 * Meta-approved templates in one place.
 */
function numericTemplatePlaceholderIndexes(text: string): number[] {
  const indexes = Array.from(
    new Set(
      Array.from(text.matchAll(/\{\{\s*(\d+)\s*\}\}/g), (match) => Number(match[1])),
    ),
  );
  return indexes.filter(Number.isInteger).sort((a, b) => a - b);
}

function defaultNumericTemplateMappings(variableCount: number): string[] {
  return Array.from({ length: variableCount }, (_, index) => `{{${index + 1}}}`);
}

function preservedTemplateMappings(variables: unknown, variableCount: number): string[] {
  if (!Array.isArray(variables) || variables.length !== variableCount) {
    return defaultNumericTemplateMappings(variableCount);
  }
  const mappings = variables.map((value) => canonicalMessageTemplateVariable(String(value || "")));
  return mappings.every(Boolean)
    ? mappings as string[]
    : defaultNumericTemplateMappings(variableCount);
}

function resolveTemplateMappingPreview(
  mappings: string[],
  context: MessageTemplateVariableContext,
): { resolvedParameters: string[]; missingVariables: string[] } {
  const missingVariables: string[] = [];
  const resolvedParameters = mappings.map((mapping) => {
    const canonical = canonicalMessageTemplateVariable(mapping);
    const value = canonical ? String(context[canonical] || "").trim() : "";
    if (!value) missingVariables.push(canonical || mapping);
    return value;
  });
  return { resolvedParameters, missingVariables };
}

router.get(
  "/inbox/whatsapp-templates",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const channelAccountId = req.query.channelAccountId ? parseInt(String(req.query.channelAccountId), 10) : undefined;
    const account = await resolveZernioWhatsAppAccount(channelAccountId);
    if (!account) {
      res.status(400).json({ error: "No Zernio-hosted WhatsApp channel account configured" });
      return;
    }
    const outcome = await listZernioWhatsAppTemplates(account.externalAccountId);
    if (!outcome.ok) {
      res.status(502).json({ error: outcome.error || "Failed to load WhatsApp templates from Zernio" });
      return;
    }

    // Upsert each approved/pending template into message_templates so it's
    // immediately selectable in the existing "send template" flow.
    for (const tpl of outcome.templates) {
      if (!tpl.name) continue;
      const [existing] = await db
        .select()
        .from(messageTemplatesTable)
        .where(and(eq(messageTemplatesTable.externalTemplateName, tpl.name), eq(messageTemplatesTable.language, tpl.language)));
      if (existing) {
        await db
          .update(messageTemplatesTable)
          .set({
            content: tpl.bodyText || existing.content,
            category: tpl.category || existing.category,
            approvalStatus: tpl.status,
            variables: preservedTemplateMappings(existing.variables, tpl.variableCount),
          })
          .where(eq(messageTemplatesTable.id, existing.id));
      } else {
        await db.insert(messageTemplatesTable).values({
          name: tpl.name,
          category: tpl.category || "utility",
          content: tpl.bodyText || "",
          channel: "whatsapp",
          language: tpl.language,
          externalTemplateName: tpl.name,
          approvalStatus: tpl.status,
          variables: defaultNumericTemplateMappings(tpl.variableCount),
          createdById: req.user!.id,
        });
      }
    }

    const templates = await db
      .select()
      .from(messageTemplatesTable)
      .where(isNotNull(messageTemplatesTable.externalTemplateName))
      .orderBy(messageTemplatesTable.name);
    res.json({ data: templates });
  },
);

router.post(
  "/inbox/whatsapp-templates",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const {
      mode,
      name,
      language,
      category,
      bodyText,
      footerText,
      bodyExamples,
      variableMappings,
      quickReplyButtons,
      libraryTemplateName,
      channelAccountId,
    } = req.body as {
      mode: "custom" | "library";
      name: string;
      language: string;
      category?: string;
      bodyText?: string;
      footerText?: string;
      bodyExamples?: string[];
      variableMappings?: string[];
      quickReplyButtons?: Array<{ text?: string }>;
      libraryTemplateName?: string;
      channelAccountId?: number;
    };
    const normalizedBodyText = bodyText?.trim() || "";
    const normalizedFooterText = footerText?.trim() || undefined;
    const normalizedLibraryTemplateName = libraryTemplateName?.trim() || "";
    if (!mode || !name || !language) {
      res.status(400).json({ error: "mode, name and language are required" });
      return;
    }
    if (mode === "custom" && !normalizedBodyText) {
      res.status(400).json({ error: "bodyText is required for custom templates" });
      return;
    }
    if (
      mode === "custom" &&
      countUnicodeCharacters(normalizedBodyText) > WHATSAPP_TEMPLATE_BODY_MAX_CHARACTERS
    ) {
      res.status(400).json({
        error: `WhatsApp template body cannot exceed ${WHATSAPP_TEMPLATE_BODY_MAX_CHARACTERS.toLocaleString("en-US")} characters.`,
      });
      return;
    }
    if (mode === "library" && !normalizedLibraryTemplateName) {
      res.status(400).json({ error: "libraryTemplateName is required for library templates" });
      return;
    }

    const placeholderIndexes = mode === "custom"
      ? numericTemplatePlaceholderIndexes(normalizedBodyText)
      : [];
    const expectedIndexes = placeholderIndexes.map((_, index) => index + 1);
    if (placeholderIndexes.some((value, index) => value !== expectedIndexes[index])) {
      res.status(400).json({
        error: "Template variables must be sequential and start at {{1}} (for example {{1}}, {{2}}, {{3}}).",
      });
      return;
    }

    const normalizedMappings = (variableMappings || []).map((value) =>
      canonicalMessageTemplateVariable(String(value || "")),
    );
    const normalizedExamples = (bodyExamples || []).map((value) => String(value || "").trim());
    if (mode === "custom" && placeholderIndexes.length > 0) {
      if (
        normalizedMappings.length !== placeholderIndexes.length ||
        normalizedMappings.some((value) => !value)
      ) {
        res.status(400).json({
          error: `Every template variable must be mapped to CRM data (${placeholderIndexes.length} required).`,
        });
        return;
      }
      if (
        normalizedExamples.length !== placeholderIndexes.length ||
        normalizedExamples.some((value) => !value)
      ) {
        res.status(400).json({
          error: `Every template variable needs a non-empty Meta review example (${placeholderIndexes.length} required).`,
        });
        return;
      }
    }

    const normalizedQuickReplies = (quickReplyButtons || [])
      .map((button) => ({ text: String(button?.text || "").trim() }))
      .filter((button) => button.text.length > 0);
    if (normalizedQuickReplies.length > 3) {
      res.status(400).json({ error: "A maximum of 3 quick reply buttons is supported." });
      return;
    }
    if (normalizedQuickReplies.some((button) => button.text.length > 25)) {
      res.status(400).json({ error: "Quick reply button labels must be 25 characters or fewer." });
      return;
    }
    if (new Set(normalizedQuickReplies.map((button) => button.text.toLocaleLowerCase())).size !== normalizedQuickReplies.length) {
      res.status(400).json({ error: "Quick reply button labels must be unique." });
      return;
    }

    const account = await resolveZernioWhatsAppAccount(channelAccountId);
    if (!account) {
      res.status(400).json({ error: "No Zernio-hosted WhatsApp channel account configured" });
      return;
    }

    const outcome = await createZernioWhatsAppTemplate({
      externalAccountId: account.externalAccountId,
      mode,
      name,
      language,
      category,
      bodyText: normalizedBodyText,
      footerText: normalizedFooterText,
      bodyExamples: normalizedExamples,
      quickReplyButtons: normalizedQuickReplies,
      libraryTemplateName: normalizedLibraryTemplateName,
    });
    if (!outcome.ok) {
      const responseStatus =
        outcome.httpStatus && outcome.httpStatus >= 400 && outcome.httpStatus < 500 ? 400 : 502;
      res.status(responseStatus).json({
        error: outcome.error || "Failed to create WhatsApp template",
      });
      return;
    }

    const [template] = await db
      .insert(messageTemplatesTable)
      .values({
        name,
        category: category || "utility",
        content:
          mode === "custom"
            ? normalizedBodyText
            : `[library: ${normalizedLibraryTemplateName}]`,
        channel: "whatsapp",
        language,
        externalTemplateName: name,
        approvalStatus: outcome.status || "pending",
        variables: mode === "custom"
          ? normalizedMappings.filter((value): value is NonNullable<typeof value> => Boolean(value))
          : [],
        createdById: req.user!.id,
      })
      .returning();

    await logAudit(req.user!.id, "create_whatsapp_template", "message_template", template.id, {
      name,
      mode,
      language,
      variableMappings: normalizedMappings,
      quickReplyCount: normalizedQuickReplies.length,
    }, req.ip);
    res.status(201).json({ data: template });
  },
);

router.delete(
  "/inbox/whatsapp-templates/:templateName",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const templateName = String(req.params.templateName || "").trim();
    const channelAccountId = req.query.channelAccountId ? parseInt(String(req.query.channelAccountId), 10) : undefined;
    const localTemplateId = req.query.localTemplateId ? parseInt(String(req.query.localTemplateId), 10) : undefined;
    if (!templateName) {
      res.status(400).json({ error: "templateName is required" });
      return;
    }

    // Resolve the exact local row before contacting Zernio. This is the only
    // proof accepted for a local-only cleanup when the provider status is
    // "unknown"; callers cannot use a name alone to hide an approved template.
    const [exactLocalTemplate] = Number.isInteger(localTemplateId) && (localTemplateId as number) > 0
      ? await db
          .select({
            id: messageTemplatesTable.id,
            approvalStatus: messageTemplatesTable.approvalStatus,
          })
          .from(messageTemplatesTable)
          .where(and(
            eq(messageTemplatesTable.id, localTemplateId as number),
            eq(messageTemplatesTable.externalTemplateName, templateName),
          ))
          .limit(1)
      : [];

    const account = await resolveZernioWhatsAppAccount(channelAccountId);
    const outcome = account
      ? await deleteZernioWhatsAppTemplate(account.externalAccountId, templateName)
      : {
          ok: false,
          error: "No Zernio-hosted WhatsApp channel account configured",
        };
    const decision = decideWhatsAppTemplateDeletion({
      localApprovalStatus: exactLocalTemplate?.approvalStatus,
      hasExactLocalTemplate: Boolean(exactLocalTemplate),
      remoteOutcome: outcome,
    });
    if (!decision.ok) {
      res.status(account ? 502 : 400).json({
        error: decision.error || "Failed to delete WhatsApp template from Zernio",
      });
      return;
    }

    // Also remove the exact local cache record. A Zernio 404 is treated as a
    // successful stale-cache cleanup. When the exact row itself has Unknown
    // status, a provider failure is allowed to remove only that local cache
    // row; all authoritative statuses remain fail-closed.
    if (Number.isInteger(localTemplateId) && (localTemplateId as number) > 0) {
      await db
        .delete(messageTemplatesTable)
        .where(and(
          eq(messageTemplatesTable.id, localTemplateId as number),
          eq(messageTemplatesTable.externalTemplateName, templateName),
        ));
    } else {
      await db
        .delete(messageTemplatesTable)
        .where(eq(messageTemplatesTable.externalTemplateName, templateName));
    }
    await logAudit(
      req.user!.id,
      "delete_whatsapp_template",
      "message_template",
      Number.isInteger(localTemplateId) ? localTemplateId : undefined,
      {
        name: templateName,
        remoteNotFound: decision.remoteNotFound === true,
        localOnly: decision.localOnly === true,
      },
      req.ip,
    );
    res.json({
      ok: true,
      remoteNotFound: decision.remoteNotFound === true,
      localOnly: decision.localOnly === true,
    });
  },
);

router.get(
  "/inbox/external-history",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const type = String(req.query.type || ""); // lead | student | agent
    const id = parseInt(String(req.query.id || ""), 10);
    if (!type || !id) {
      res.status(400).json({ error: "type and id required" });
      return;
    }
    if (type !== "lead" && type !== "student" && type !== "agent") {
      res.status(400).json({ error: "Invalid type" });
      return;
    }

    // 1) External conversations linked via external_contacts (WA + web_form).
    const extWhere =
      type === "lead"
        ? eq(externalContactsTable.leadId, id)
        : type === "student"
        ? eq(externalContactsTable.studentId, id)
        : eq(externalContactsTable.agentId, id);
    const contacts = await db.select().from(externalContactsTable).where(extWhere);
    const contactIds = contacts.map((c) => c.id);

    // 2) Internal conversations linked to the entity's user account, if any.
    //    Students and agents have a userId on their row; leads do not (they are
    //    pre-account prospects), so the internal union is a no-op for leads.
    let entityUserId: number | null = null;
    if (type === "student") {
      const [s] = await db
        .select({ userId: studentsTable.userId })
        .from(studentsTable)
        .where(eq(studentsTable.id, id))
        .limit(1);
      entityUserId = s?.userId ?? null;
    } else if (type === "agent") {
      const [a] = await db
        .select({ userId: agentsTable.userId })
        .from(agentsTable)
        .where(eq(agentsTable.id, id))
        .limit(1);
      entityUserId = a?.userId ?? null;
    }

    let internalConvIds: number[] = [];
    if (entityUserId) {
      const parts = await db
        .select({ conversationId: conversationParticipantsTable.conversationId })
        .from(conversationParticipantsTable)
        .where(eq(conversationParticipantsTable.userId, entityUserId));
      internalConvIds = parts.map((p) => p.conversationId);
    }

    if (contactIds.length === 0 && internalConvIds.length === 0) {
      res.json({ conversations: [], messages: [], externalContacts: contacts });
      return;
    }

    // Union: external_contact-linked OR internal-participant-linked.
    const whereClauses = [];
    if (contactIds.length > 0) whereClauses.push(inArray(conversationsTable.externalContactId, contactIds));
    if (internalConvIds.length > 0) whereClauses.push(inArray(conversationsTable.id, internalConvIds));
    const conversations = await db
      .select()
      .from(conversationsTable)
      .where(whereClauses.length === 1 ? whereClauses[0] : or(...whereClauses))
      .orderBy(desc(conversationsTable.lastMessageAt));
    const convIds = conversations.map((c) => c.id);
    const messages = convIds.length
      ? await db
          .select()
          .from(messagesTable)
          .where(inArray(messagesTable.conversationId, convIds))
          .orderBy(desc(messagesTable.createdAt))
          .limit(500)
      : [];
    res.json({ conversations, messages, externalContacts: contacts });
  },
);

// ---------------------------------------------------------------------------
// Phase 2 — AI summarize + inline notes + inline follow-up tasks
// ---------------------------------------------------------------------------

router.post(
  "/inbox/conversations/:id/summarize",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  validate({ params: conversationIdParamSchema }),
  async (req, res): Promise<void> => {
    const { params } = getValidated<{ params: typeof conversationIdParamSchema }>(req);
    const conversationId = params.id;
    const userId = req.user!.id;

    // First, count messages — needed both to short-circuit empty conversations
    // and to key the cache. Then probe the cache *before* consuming any rate-
    // limit quota or acquiring a lock so repeated reads of a stable summary
    // stay cheap.
    const [conv] = await db
      .select({ id: conversationsTable.id, metadata: conversationsTable.metadata })
      .from(conversationsTable)
      .where(eq(conversationsTable.id, conversationId));
    if (!conv) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }

    const [{ count: rawCount } = { count: 0 }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(messagesTable)
      .where(eq(messagesTable.conversationId, conversationId));
    const messageCount = Number(rawCount) || 0;
    if (messageCount === 0) {
      res.status(400).json({ error: "No messages to summarize" });
      return;
    }

    const cached = readAiSummary(conv.metadata);
    if (cached && cached.messageCount === messageCount) {
      logAudit(userId, "conversation_summarize", "conversation", conversationId, {
        messageCount,
        fromCache: true,
      }, req.ip);
      res.json({ data: cached, fromCache: true });
      return;
    }

    // Cache miss — now charge a token against the per-user rate limit so the
    // expensive path is the only one that costs quota.
    try {
      await summarizeRateLimiter.consume(String(userId));
    } catch (rlErr) {
      const ms = (rlErr as { msBeforeNext?: number })?.msBeforeNext ?? 60000;
      res.setHeader("Retry-After", String(Math.ceil(ms / 1000)));
      res.status(429).json({ error: "Too many summarize requests. Please wait a moment." });
      return;
    }

    // Per-conversation advisory lock so two concurrent summarize requests for
    // the same conversation don't both call Anthropic. We use the
    // `pg_advisory_xact_lock` variant inside a transaction — it's released
    // automatically on COMMIT/ROLLBACK and survives if the request errors
    // out. After acquiring the lock we re-read metadata and re-check the
    // cache; the second caller will then hit the freshly-written summary.
    let summary: ConversationAiSummary;
    let fromCache = false;
    try {
      summary = await db.transaction(async (tx) => {
        // First key is a fixed namespace constant for "inbox.summarize"
        // (chosen arbitrarily — picked from task #216) so this lock cannot
        // collide with other advisory locks the app might add later.
        await tx.execute(sql`select pg_advisory_xact_lock(7216, ${conversationId})`);

        const [fresh] = await tx
          .select({ metadata: conversationsTable.metadata })
          .from(conversationsTable)
          .where(eq(conversationsTable.id, conversationId));
        const reCached = readAiSummary(fresh?.metadata);
        if (reCached && reCached.messageCount === messageCount) {
          fromCache = true;
          return reCached;
        }

        const transcript = await tx
          .select({
            direction: messagesTable.direction,
            content: messagesTable.content,
            createdAt: messagesTable.createdAt,
          })
          .from(messagesTable)
          .where(eq(messagesTable.conversationId, conversationId))
          .orderBy(asc(messagesTable.createdAt))
          .limit(50);

        const { content, model } = await generateConversationSummary({ messages: transcript });
        const next: ConversationAiSummary = {
          content,
          generatedAt: new Date().toISOString(),
          messageCount,
          model,
          generatedByUserId: userId,
        };

        // Atomic JSONB merge done in-database so a parallel writer that
        // updates a different metadata key (e.g. channel state) is preserved
        // instead of being clobbered by a stale read-modify-write.
        await tx
          .update(conversationsTable)
          .set({
            metadata: sql`coalesce(${conversationsTable.metadata}, '{}'::jsonb) || jsonb_build_object('aiSummary', ${JSON.stringify(next)}::jsonb)`,
          })
          .where(eq(conversationsTable.id, conversationId));

        return next;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "AI service not configured";
      const isConfigError = /not configured|API key/i.test(message);
      res
        .status(502)
        .json({ error: isConfigError ? "AI service not configured" : `AI request failed: ${message}` });
      return;
    }

    logAudit(userId, "conversation_summarize", "conversation", conversationId, {
      messageCount,
      fromCache,
      model: summary.model,
    }, req.ip);

    res.json({ data: summary, fromCache });
  },
);

const conversationNoteBodySchema = z.object({
  content: z.string().min(1).max(2000),
});

router.post(
  "/inbox/conversations/:id/notes",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  validate({ params: conversationIdParamSchema, body: conversationNoteBodySchema }),
  async (req, res): Promise<void> => {
    const { params, body } = getValidated<{
      params: typeof conversationIdParamSchema;
      body: typeof conversationNoteBodySchema;
    }>(req);
    const conversationId = params.id;
    const userId = req.user!.id;

    const link = await loadConversationLink(conversationId);
    if (!link) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    if (!link.leadId && !link.studentId) {
      res.status(400).json({ error: "This conversation is not linked to a lead or student" });
      return;
    }

    // Student takes priority: a converted lead has both leadId and studentId set;
    // notes should attach to the student (canonical post-conversion anchor).
    const primaryResourceType: "lead" | "student" = link.studentId ? "student" : "lead";
    const primaryResourceId = (link.studentId ?? link.leadId) as number;

    // Both inserts share a transaction so a failed cross-link does not leave
    // the primary note orphaned (or vice versa).
    const primaryNote = await db.transaction(async (tx) => {
      const [primary] = await tx
        .insert(notesTable)
        .values({
          content: body.content,
          authorId: userId,
          resourceType: primaryResourceType,
          resourceId: primaryResourceId,
          isInternal: true,
        })
        .returning();

      // Cross-link copy so a future inbox-side notes view can list notes by
      // conversation id without joining through external_contacts.
      await tx.insert(notesTable).values({
        content: body.content,
        authorId: userId,
        resourceType: "conversation",
        resourceId: conversationId,
        isInternal: true,
      });

      return primary;
    });

    logAudit(userId, "conversation_note_create", "conversation", conversationId, {
      noteId: primaryNote.id,
      resourceType: primaryResourceType,
      resourceId: primaryResourceId,
    }, req.ip);

    res.status(201).json({
      data: {
        id: primaryNote.id,
        content: primaryNote.content,
        createdAt: primaryNote.createdAt,
        resourceType: primaryResourceType,
        resourceId: primaryResourceId,
      },
    });
  },
);

const conversationTaskBodySchema = z.object({
  title: z.string().min(1).max(500),
  scheduledAt: z.string().refine((s) => !Number.isNaN(Date.parse(s)), {
    message: "scheduledAt must be a valid ISO datetime",
  }),
  assignedToId: z.number().int().positive().optional(),
  notes: z.string().max(2000).optional(),
});

router.post(
  "/inbox/conversations/:id/tasks",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  validate({ params: conversationIdParamSchema, body: conversationTaskBodySchema }),
  async (req, res): Promise<void> => {
    const { params, body } = getValidated<{
      params: typeof conversationIdParamSchema;
      body: typeof conversationTaskBodySchema;
    }>(req);
    const conversationId = params.id;
    const userId = req.user!.id;

    const link = await loadConversationLink(conversationId);
    if (!link) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    if (!link.leadId && !link.studentId) {
      res.status(400).json({ error: "This conversation is not linked to a lead or student" });
      return;
    }

    // Student takes priority: a converted lead has both leadId and studentId set;
    // follow-ups should attach to the student (canonical post-conversion anchor).
    const resourceType: "lead" | "student" = link.studentId ? "student" : "lead";
    const [task] = await db
      .insert(followUpsTable)
      .values({
        leadId: link.leadId,
        studentId: link.studentId,
        resourceType,
        title: body.title,
        scheduledAt: new Date(body.scheduledAt),
        assignedToId: body.assignedToId ?? userId,
        notes: body.notes ?? null,
        createdById: userId,
      })
      .returning();

    logAudit(userId, "conversation_task_create", "conversation", conversationId, {
      taskId: task.id,
      resourceType,
      leadId: link.leadId,
      studentId: link.studentId,
    }, req.ip);

    res.status(201).json({ data: task });
  },
);

// ---------------------------------------------------------------------------
// AI Agent admin panel (FAZ 2) — manage the DB-managed ai_agent config and run
// the Test Console. Admin-only on every endpoint. The config is the same FAZ 1
// single source of truth read by the auto-reply engine.
// ---------------------------------------------------------------------------

// GET /inbox/ai-agent/config — read the live AI agent config (merged over
// safe defaults).
router.get(
  "/inbox/ai-agent/config",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const aiBotId = await resolveAdminAiBotId(req, res);
    if (aiBotId == null) return;
    const config = await getAiAgentConfig(aiBotId);
    res.json({ config });
  },
);

// GET /inbox/ai-agent/models — list models available to the configured
// Anthropic account. Provider failures are fail-soft for this read-only admin
// control: the saved model remains selectable and the live config is untouched.
router.get(
  "/inbox/ai-agent/models",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const aiBotId = await resolveAdminAiBotId(req, res);
    if (aiBotId == null) return;
    const config = await getAiAgentConfig(aiBotId);
    try {
      const anthropic = await getAnthropicClient();
      const models = await loadAnthropicModelOptions(anthropic, config.model);
      res.json({
        provider: "anthropic",
        source: "provider",
        models,
      });
    } catch (err) {
      console.warn(
        "[ai-agent-models] provider model list unavailable:",
        err instanceof Error ? err.message : "unknown error",
      );
      res.json({
        provider: "anthropic",
        source: "current_config",
        models: [
          {
            id: config.model,
            displayName: config.model,
            current: true,
          },
        ],
        warning: "Provider model list is temporarily unavailable.",
      });
    }
  },
);

// GET /inbox/ai-agent/metrics — operational visibility for hand-offs, prompt
// cache usage and deterministic output-validation retries. Read-only/admin.
router.get(
  "/inbox/ai-agent/metrics",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const aiBotId = await resolveAdminAiBotId(req, res);
    if (aiBotId == null) return;
    const parsedDays = Number(req.query.days ?? 30);
    const days = Number.isInteger(parsedDays) ? Math.min(90, Math.max(1, parsedDays)) : 30;
    const rows = await db
      .select({
        createdAt: messagesTable.createdAt,
        metadata: messagesTable.metadata,
      })
      .from(messagesTable)
      .innerJoin(conversationsTable, eq(conversationsTable.id, messagesTable.conversationId))
      .where(and(
        eq(conversationsTable.aiBotId, aiBotId),
        sql`${messagesTable.createdAt} >= now() - (${days} * interval '1 day')`,
      ));

    const handoffByReason: Record<string, number> = {};
    const handoffByDay: Record<string, number> = {};
    let handoffTotal = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheCreationInputTokens = 0;
    let cacheReadInputTokens = 0;
    let validationRetries = 0;
    for (const row of rows) {
      const metadata = row.metadata && typeof row.metadata === "object"
        ? row.metadata as Record<string, unknown>
        : {};
      if (metadata.botHandoffNote === true) {
        const reason = typeof metadata.topic === "string" && metadata.topic ? metadata.topic : "unknown";
        const day = row.createdAt.toISOString().slice(0, 10);
        handoffByReason[reason] = (handoffByReason[reason] ?? 0) + 1;
        handoffByDay[day] = (handoffByDay[day] ?? 0) + 1;
        handoffTotal += 1;
      }
      if (metadata.outputValidationRetried === true) validationRetries += 1;
      const usageEntries = Array.isArray(metadata.anthropicUsage) ? metadata.anthropicUsage : [];
      for (const entry of usageEntries) {
        if (!entry || typeof entry !== "object") continue;
        const usage = entry as Record<string, unknown>;
        inputTokens += Number(usage.inputTokens ?? 0) || 0;
        outputTokens += Number(usage.outputTokens ?? 0) || 0;
        cacheCreationInputTokens += Number(usage.cacheCreationInputTokens ?? 0) || 0;
        cacheReadInputTokens += Number(usage.cacheReadInputTokens ?? 0) || 0;
      }
    }
    const cacheDenominator = inputTokens + cacheCreationInputTokens + cacheReadInputTokens;
    res.json({
      metrics: {
        days,
        handoffs: { total: handoffTotal, byReason: handoffByReason, byDay: handoffByDay },
        promptCache: {
          inputTokens,
          outputTokens,
          cacheCreationInputTokens,
          cacheReadInputTokens,
          hitRate: cacheDenominator > 0 ? cacheReadInputTokens / cacheDenominator : 0,
        },
        outputValidation: { retries: validationRetries },
      },
    });
  },
);

// PUT /inbox/ai-agent/config — validate and persist a (partial) config patch.
// Returns the merged, validated config.
router.put(
  "/inbox/ai-agent/config",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const aiBotId = await resolveAdminAiBotId(req, res);
    if (aiBotId == null) return;
    const parsed = aiAgentConfigPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid config", details: parsed.error.flatten() });
      return;
    }
    try {
      const current = await getAiAgentConfig(aiBotId);
      let patch = parsed.data;
      const isSuperAdmin = req.user!.role === "super_admin";
      if (
        !isSuperAdmin &&
        aiAgentPatchRequiresSuperAdmin(current, patch)
      ) {
        res.status(403).json({ error: "Super Admin approval is required to enable AI automation" });
        return;
      }
      if (!isSuperAdmin) {
        patch = stripAlreadyEnabledAiAgentControls(current, patch);
      }
      const config = await writeAiAgentConfig(patch, aiBotId);
      logAudit(req.user!.id, "update_ai_agent_config", "integration", undefined, {
        aiBotId,
        enabled: config.enabled,
        externalAutoReplyEnabled: config.externalAutoReplyEnabled,
        defaultOnForNew: config.defaultOnForNew,
        model: config.model,
      }, req.ip);
      res.json({ config });
    } catch (err) {
      // writeAiAgentConfig re-validates the merged result; a merge that produces
      // an invalid config (e.g. an empty knowledge base) surfaces here.
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: "Invalid config", details: err.flatten() });
        return;
      }
      throw err;
    }
  },
);

// POST /inbox/ai-agent/test — run the bot brain against a sample message and
// (optional) history, returning the would-be reply, detected language, and
// escalation result. Sends NOTHING.
const aiAgentTestSchema = z.object({
  aiBotId: z.number().int().positive().optional(),
  message: z.string().min(1).max(4000),
  language: z.enum([
    "en", "tr", "ar", "fr", "ru", "fa", "zh", "hi", "es", "id",
    "ur", "tk", "ky", "kk", "uz", "tg", "bn", "pt", "ne", "vi",
    "ko", "uk", "it",
  ]).optional(),
  history: z
    .array(
      z.object({
        direction: z.enum(["inbound", "outbound"]),
        content: z.string().min(1).max(4000),
      }),
    )
    .max(40)
    .optional(),
});

router.post(
  "/inbox/ai-agent/test",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const parsed = aiAgentTestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }
    const aiBotId = await resolveAdminAiBotId(req, res);
    if (aiBotId == null) return;
    try {
      const result = await runBotReplyTest({
        aiBotId,
        message: parsed.data.message,
        language: parsed.data.language,
        history: parsed.data.history,
      });
      res.json({ result });
    } catch (err) {
      console.error("[ai-agent-test]", err);
      res.status(502).json({ error: "Test run failed" });
    }
  },
);

// ---------------------------------------------------------------------------
// Knowledge Sources (FAZ 1 scaffold) — admin-only management of the
// program_scope source. This mirrors onto AiAgentConfig.programScope so the
// live searchPrograms tool and this admin surface can never drift apart (see
// writeProgramScopeSource in lib/inbox/knowledgeSources.ts).
// ---------------------------------------------------------------------------

const programScopeSchema = z.object({
  enabled: z.boolean(),
  countries: z.union([z.array(z.string()), z.literal("all")]),
  universityTypes: z.union([z.array(z.string()), z.literal("all")]),
});
const knowledgeSourceProgramScopeSchema = z.object({
  isActive: z.boolean(),
  scope: programScopeSchema,
});

// GET /inbox/knowledge-sources/program-scope — read the program_scope source
// (falls back to the AiAgentConfig default when the row hasn't been seeded
// yet, e.g. a brand-new environment before its first boot cycle).
router.get(
  "/inbox/knowledge-sources/program-scope",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const aiBotId = await resolveAdminAiBotId(req, res);
    if (aiBotId == null) return;
    const source = await getProgramScopeSource(aiBotId);
    if (source) {
      res.json({ source: { isActive: source.isActive, scope: source.scope, lastSyncedAt: source.lastSyncedAt } });
      return;
    }
    const config = await getAiAgentConfig(aiBotId);
    res.json({ source: { isActive: true, scope: config.programScope, lastSyncedAt: null } });
  },
);

// PUT /inbox/knowledge-sources/program-scope — validate and persist the
// program_scope source + mirror onto AiAgentConfig.programScope.
router.put(
  "/inbox/knowledge-sources/program-scope",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const aiBotId = await resolveAdminAiBotId(req, res);
    if (aiBotId == null) return;
    const parsed = knowledgeSourceProgramScopeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }
    const source = await writeProgramScopeSource(parsed.data, aiBotId);
    logAudit(req.user!.id, "update_knowledge_source_program_scope", "integration", undefined, {
      aiBotId,
      isActive: source.isActive,
      enabled: source.scope.enabled,
    }, req.ip);
    res.json({ source: { isActive: source.isActive, scope: source.scope, lastSyncedAt: source.lastSyncedAt } });
  },
);

// ---------------------------------------------------------------------------
// AI Agent Faz 2 — external knowledge sources (file/url/text) RAG CRUD
// ---------------------------------------------------------------------------

const createRagSourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("file"),
    name: z.string().min(1).max(200),
    objectPath: z.string().min(1),
    fileName: z.string().min(1),
    mimeType: z.string().min(1),
  }),
  z.object({
    type: z.literal("url"),
    name: z.string().min(1).max(200),
    url: z.string().url(),
  }),
  z.object({
    type: z.literal("text"),
    name: z.string().min(1).max(200),
    rawText: z.string().min(1).max(400_000),
  }),
  z.object({
    type: z.literal("dormbooking"),
    name: z.string().min(1).max(200),
  }),
]);
const updateRagSourceSchema = z.object({
  isActive: z.boolean().optional(),
  name: z.string().min(1).max(200).optional(),
});

function ragSourceConfigFromInput(input: z.infer<typeof createRagSourceSchema>): Record<string, unknown> {
  if (input.type === "file") return { objectPath: input.objectPath, fileName: input.fileName, mimeType: input.mimeType };
  if (input.type === "url") return { url: input.url };
  if (input.type === "text") return { rawText: input.rawText };
  return {
    sourceUrl: "https://dormbooking.com/wp-json/dormbooking/v1/ai-catalog",
    studentSafeOnly: true,
    syncIntervalHours: 1,
  };
}

// GET /inbox/knowledge-sources/rag — list all admin-managed file/url/text
// knowledge sources with their processing status and chunk counts.
router.get(
  "/inbox/knowledge-sources/rag",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const aiBotId = await resolveAdminAiBotId(req, res);
    if (aiBotId == null) return;
    const sources = await listRagSources(aiBotId);
    res.json({ sources });
  },
);

// POST /inbox/knowledge-sources/rag — register a new file/url/text source and
// kick off (async) extraction + chunking + embedding.
router.post(
  "/inbox/knowledge-sources/rag",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const aiBotId = await resolveAdminAiBotId(req, res);
    if (aiBotId == null) return;
    const parsed = createRagSourceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }
    const source = await createRagSource({
      aiBotId,
      type: parsed.data.type,
      name: parsed.data.name,
      config: ragSourceConfigFromInput(parsed.data),
    });
    logAudit(req.user!.id, "create_knowledge_source_rag", "integration", source.id, { type: source.type, name: source.name }, req.ip);
    res.status(201).json({ source });
  },
);

// PATCH /inbox/knowledge-sources/rag/:id — toggle active state or rename.
router.patch(
  "/inbox/knowledge-sources/rag/:id",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const aiBotId = await resolveAdminAiBotId(req, res);
    if (aiBotId == null) return;
    const id = parseInt(String(req.params.id), 10);
    if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
    const parsed = updateRagSourceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }
    const source = await updateRagSource(id, aiBotId, parsed.data);
    if (!source) { res.status(404).json({ error: "Not found" }); return; }
    logAudit(req.user!.id, "update_knowledge_source_rag", "integration", id, parsed.data, req.ip);
    res.json({ source });
  },
);

// POST /inbox/knowledge-sources/rag/:id/reprocess — re-run extraction+embedding.
router.post(
  "/inbox/knowledge-sources/rag/:id/reprocess",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const aiBotId = await resolveAdminAiBotId(req, res);
    if (aiBotId == null) return;
    const id = parseInt(String(req.params.id), 10);
    if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
    const ok = await reprocessRagSource(id, aiBotId);
    if (!ok) { res.status(404).json({ error: "Not found" }); return; }
    logAudit(req.user!.id, "reprocess_knowledge_source_rag", "integration", id, {}, req.ip);
    res.json({ success: true });
  },
);

// DELETE /inbox/knowledge-sources/rag/:id — remove a source and its chunks.
router.delete(
  "/inbox/knowledge-sources/rag/:id",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const aiBotId = await resolveAdminAiBotId(req, res);
    if (aiBotId == null) return;
    const id = parseInt(String(req.params.id), 10);
    if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
    const ok = await deleteRagSource(id, aiBotId);
    if (!ok) { res.status(404).json({ error: "Not found" }); return; }
    logAudit(req.user!.id, "delete_knowledge_source_rag", "integration", id, {}, req.ip);
    res.json({ success: true });
  },
);

// ── Per-conversation star toggle (per-user) ──────────────────────────────────
router.post(
  "/inbox/conversations/:id/star",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const id = parseInt(String(req.params.id), 10);
    const userId = req.user!.id;
    if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

    const [existing] = await db
      .select()
      .from(conversationParticipantsTable)
      .where(and(eq(conversationParticipantsTable.conversationId, id), eq(conversationParticipantsTable.userId, userId)))
      .limit(1);

    if (existing) {
      await db
        .update(conversationParticipantsTable)
        .set({ isStarred: !existing.isStarred })
        .where(eq(conversationParticipantsTable.id, existing.id));
      res.json({ starred: !existing.isStarred });
    } else {
      await db.insert(conversationParticipantsTable).values({ conversationId: id, userId, isStarred: true });
      res.json({ starred: true });
    }
  },
);

// ── "Add as Document" — save an inbound attachment as a Lead/Student document ─
//
// Resolves the attachment from the stored message metadata (Zernio: url field;
// WhatsApp Cloud API: media ID in metadata.raw → fetches download URL via WA API).
// Validates file type (PDF/JPG/PNG), checks for duplicate (same attachment + owner)
// and type conflict (same doc type + owner), then uploads to object storage and
// creates the document row with source-tracking columns.
//
// Body: { ownerType: "lead"|"student", ownerId: number, documentType: "diploma_certificate"|"diploma_transcript"|"passport"|"photo"|"cv"|"other_certificates_documents" }

function mimeToExt(mime: string): string {
  if (mime === "application/pdf") return "pdf";
  if (mime === "image/jpeg" || mime === "image/jpg") return "jpg";
  if (mime === "image/png") return "png";
  if (mime === "image/gif") return "gif";
  if (mime === "image/webp") return "webp";
  return "bin";
}

// Manual document uploads from the Documents side panel use the same signed
// upload flow as the rest of the application, then bind the verified object to
// the lead/student linked to this conversation. Multiple files of the same
// document type are intentionally allowed (for example, a diploma split across
// several screenshots/pages).
router.post(
  "/inbox/conversations/:id/manual-document",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const conversationId = parseInt(String(req.params.id), 10);
    const ownerType = req.body?.ownerType;
    const ownerId = Number(req.body?.ownerId);
    const documentType = typeof req.body?.documentType === "string"
      ? req.body.documentType.trim()
      : "";
    const fileKey = typeof req.body?.fileKey === "string" ? req.body.fileKey.trim() : "";
    const mimeType = typeof req.body?.mimeType === "string" ? req.body.mimeType.trim() : "";
    const originalFileName = sanitizeFileName(
      typeof req.body?.originalFileName === "string" ? req.body.originalFileName : "document",
    );
    const sizeBytes = Number(req.body?.sizeBytes);
    const setAsPhoto = req.body?.setAsPhoto !== false;

    if (!conversationId || !Number.isInteger(ownerId) || ownerId <= 0) {
      res.status(400).json({ error: "Invalid conversation or owner" });
      return;
    }
    if (ownerType !== "lead" && ownerType !== "student") {
      res.status(400).json({ error: "ownerType must be 'lead' or 'student'" });
      return;
    }
    if (!documentType || !fileKey || !mimeType || !Number.isFinite(sizeBytes)) {
      res.status(400).json({ error: "documentType, fileKey, mimeType and sizeBytes are required" });
      return;
    }
    if (!fileKey.startsWith("/objects/student-documents/")) {
      res.status(400).json({ error: "Invalid manual document storage path" });
      return;
    }

    const link = await loadConversationLink(conversationId);
    if (!link) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    const linkedOwnerId = ownerType === "student" ? link.studentId : link.leadId;
    if (linkedOwnerId !== ownerId) {
      res.status(403).json({ error: "The selected owner is not linked to this conversation" });
      return;
    }

    const activeDocumentTypes = await loadDocCatalogKeySet();
    const legacyAliases = new Set(["diploma", "transcript", "photograph"]);
    if (!activeDocumentTypes.has(documentType) && !legacyAliases.has(documentType)) {
      res.status(400).json({ error: `documentType is not active in the document catalog: ${documentType}` });
      return;
    }

    // Even staff may only register the object created by their own signed
    // upload request. This prevents an arbitrary private object key from being
    // attached through this convenience endpoint.
    if (!(await callerOwnsObject(req.user!.id, fileKey))) {
      res.status(403).json({ error: "You can only attach files that you have uploaded" });
      return;
    }

    const validationError = validateStudentDocumentFile(
      documentType,
      originalFileName,
      mimeType,
      sizeBytes,
    );
    if (validationError) {
      res.status(validationError.type === "size_exceeded" ? 413 : 400).json({ error: validationError.message });
      return;
    }

    let bytes: Buffer;
    try {
      const file = await inboxMediaStorage.getObjectEntityFile(fileKey);
      [bytes] = await file.download();
    } catch (error) {
      console.error("[INBOX manual-document] uploaded object read failed:", error);
      res.status(400).json({ error: "Uploaded file could not be located in object storage" });
      return;
    }
    if (bytes.length !== sizeBytes) {
      res.status(400).json({ error: "Uploaded file size does not match the declared size" });
      return;
    }
    const bufferError = await validateStudentDocumentBuffer(
      documentType,
      originalFileName,
      mimeType,
      bytes,
    );
    if (bufferError) {
      res.status(bufferError.type === "size_exceeded" ? 413 : 400).json({ error: bufferError.message });
      return;
    }

    const ownerCondition = ownerType === "student"
      ? eq(documentsTable.studentId, ownerId)
      : eq(documentsTable.leadId, ownerId);
    const [duplicate] = await db
      .select({ id: documentsTable.id })
      .from(documentsTable)
      .where(and(
        ownerCondition,
        eq(documentsTable.fileKey, fileKey),
        isNull(documentsTable.deletedAt),
      ))
      .limit(1);
    if (duplicate) {
      res.status(409).json({ error: "This uploaded file is already saved", existingDocumentId: duplicate.id });
      return;
    }

    let ownerFirstName: string | null = null;
    let ownerLastName: string | null = null;
    if (ownerType === "student") {
      const [owner] = await db
        .select({ firstName: studentsTable.firstName, lastName: studentsTable.lastName })
        .from(studentsTable)
        .where(and(eq(studentsTable.id, ownerId), isNull(studentsTable.deletedAt)));
      ownerFirstName = owner?.firstName ?? null;
      ownerLastName = owner?.lastName ?? null;
    } else {
      const [owner] = await db
        .select({ firstName: leadsTable.firstName, lastName: leadsTable.lastName })
        .from(leadsTable)
        .where(and(eq(leadsTable.id, ownerId), isNull(leadsTable.deletedAt)));
      ownerFirstName = owner?.firstName ?? null;
      ownerLastName = owner?.lastName ?? null;
    }
    if (!ownerFirstName && !ownerLastName) {
      res.status(404).json({ error: "Linked owner not found" });
      return;
    }

    const [document] = await db.insert(documentsTable).values({
      name: buildDocNameFromParts(ownerFirstName, ownerLastName, documentType, mimeType),
      type: documentType,
      status: "pending",
      studentId: ownerType === "student" ? ownerId : null,
      leadId: ownerType === "lead" ? ownerId : null,
      applicationId: null,
      fileKey,
      mimeType,
      sizeBytes,
      source: "inbox_manual",
      sourceConversationId: conversationId,
      sourceMessageId: null,
      sourceAttachmentId: null,
    }).returning();

    if (
      ownerType === "student" &&
      (documentType === "photo" || documentType === "photograph") &&
      setAsPhoto
    ) {
      await recomputeStudentPhoto(ownerId);
    }

    await writeAudit({
      userId: req.user!.id,
      action: "inbox_manual_document_upload",
      resource: "document",
      resourceId: document.id,
      changes: { conversationId, ownerType, ownerId, documentType },
      ipAddress: req.ip,
    });

    res.status(201).json(document);
  },
);


router.post(
  "/inbox/conversations/:id/messages/:msgId/attachments/:attachId/save-as-document",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const conversationId = parseInt(String(req.params.id), 10);
    const msgId = parseInt(String(req.params.msgId), 10);
    const attachIndex = parseInt(String(req.params.attachId), 10);

    if (!conversationId || !msgId || isNaN(attachIndex) || attachIndex < 0) {
      res.status(400).json({ error: "Invalid parameters" });
      return;
    }

    const {
      ownerType,
      ownerId: ownerIdRaw,
      documentType: documentTypeRaw,
      force,
      setAsPhoto = true,
    } = req.body;
    const ownerId = Number(ownerIdRaw);
    const documentType =
      typeof documentTypeRaw === "string" ? documentTypeRaw.trim() : "";
    if (!documentType) {
      res.status(400).json({ error: "documentType is required" });
      return;
    }

    // The Add modal is driven by the admin-managed document catalog, so this
    // write endpoint must validate against that same source of truth. The old
    // six-item hardcoded list rendered valid Master/PhD choices but rejected
    // them on click (bachelors_certificate, lor, diploma_recognition, ...).
    const activeDocumentTypes = await loadDocCatalogKeySet();
    const legacyAliases = new Set(["diploma", "transcript", "photograph"]);
    if (!activeDocumentTypes.has(documentType) && !legacyAliases.has(documentType)) {
      res.status(400).json({
        error: `documentType is not active in the document catalog: ${documentType}`,
      });
      return;
    }
    if (ownerType !== "lead" && ownerType !== "student") {
      res.status(400).json({ error: "ownerType must be 'lead' or 'student'" });
      return;
    }
    if (!ownerId || isNaN(ownerId)) {
      res.status(400).json({ error: "ownerId is required" });
      return;
    }

    // Load conversation
    const [conv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, conversationId));
    if (!conv) { res.status(404).json({ error: "Conversation not found" }); return; }

    // Load message (must belong to this conversation)
    const [msg] = await db.select().from(messagesTable).where(
      and(eq(messagesTable.id, msgId), eq(messagesTable.conversationId, conversationId))
    );
    if (!msg) { res.status(404).json({ error: "Message not found" }); return; }

    // Extract attachment info from message metadata.
    // For Zernio: metadata.attachment or metadata.attachments[index].url
    // For WhatsApp: metadata.raw.{image|document|video|audio}.id
    const meta = (msg.metadata ?? {}) as Record<string, any>;
    const zernioAtts: Array<Record<string, any>> = [
      ...(meta.attachment && typeof meta.attachment === "object" ? [meta.attachment as Record<string, any>] : []),
      ...(Array.isArray(meta.attachments) ? (meta.attachments as Record<string, any>[]) : []),
    ];

    let attachUrl: string | null = null;
    let attachMimeType: string | null = null;
    let attachName: string | null = null;
    let waMediaId: string | null = null;

    if (attachIndex < zernioAtts.length) {
      const att = zernioAtts[attachIndex];
      const nested = readNestedZernioAttachmentMetadata(meta, attachIndex);
      attachUrl = String(att?.url ?? att?.fileUrl ?? "").trim() || null;
      attachMimeType =
        String(att?.mimeType ?? att?.mime_type ?? "").trim() ||
        nested.mimeType ||
        null;
      attachName =
        String(att?.name ?? att?.filename ?? "").trim() ||
        nested.fileName ||
        null;
    }

    // WhatsApp: media object lives in metadata.raw under the message type key
    if (!attachUrl && meta.raw && typeof meta.raw === "object" && attachIndex === 0) {
      const raw = meta.raw as Record<string, any>;
      const mediaType = String(raw.type ?? "");
      const mediaObj = mediaType ? (raw[mediaType] as Record<string, any> | undefined) : undefined;
      if (mediaObj?.id) {
        waMediaId = String(mediaObj.id);
        attachMimeType = attachMimeType || String(mediaObj.mime_type ?? "").trim() || null;
        attachName = attachName || String(mediaObj.filename ?? mediaObj.file_name ?? "").trim() || null;
      }
    }

    if (!attachUrl && !waMediaId) {
      res.status(404).json({ error: "Attachment not found at this index" });
      return;
    }

    const sourceAttachmentId = `${msgId}:${attachIndex}`;

    // Duplicate guard: same source_attachment_id + same owner already saved
    const ownerCondition = ownerType === "student"
      ? eq(documentsTable.studentId, ownerId)
      : eq(documentsTable.leadId, ownerId);

    const [dupDoc] = await db.select({ id: documentsTable.id })
      .from(documentsTable)
      .where(and(
        eq(documentsTable.sourceAttachmentId, sourceAttachmentId),
        ownerCondition,
        isNull(documentsTable.deletedAt)
      ));
    if (dupDoc) {
      // Not an error from the caller's perspective — the attachment already
      // lives on this owner (e.g. it was saved to the lead and then adopted
      // onto the student by the match flow). Report it as already saved.
      res.status(409).json({
        error: "This attachment has already been saved as a document for this owner",
        alreadySaved: true,
        existingDocumentId: dupDoc.id,
      });
      return;
    }

    // Conflict check: same doc type + same owner already exists (profile-level).
    // Skipped when `force: true` is passed (user chose "Add as New Version").
    if (!force) {
      const [conflictDoc] = await db.select({ id: documentsTable.id })
        .from(documentsTable)
        .where(and(
          eq(documentsTable.type, documentType),
          ownerCondition,
          isNull(documentsTable.applicationId),
          isNull(documentsTable.deletedAt)
        ));
      if (conflictDoc) {
        // Return 200 with conflict flag so frontend can prompt the user to decide
        res.json({ conflict: true, existingDocumentId: conflictDoc.id });
        return;
      }
    }

    // ── Reuse already-stored bytes when available ───────────────────────────
    // If this exact attachment was previously saved as a document for ANY
    // owner (e.g. staged on the lead before the student existed), reuse its
    // stored fileKey instead of re-downloading — WhatsApp media URLs expire,
    // which used to make every re-save fail with a download error.
    const [storedTwin] = await db.select({
      fileKey: documentsTable.fileKey,
      mimeType: documentsTable.mimeType,
      sizeBytes: documentsTable.sizeBytes,
      name: documentsTable.name,
    })
      .from(documentsTable)
      .where(and(
        eq(documentsTable.sourceAttachmentId, sourceAttachmentId),
        eq(documentsTable.sourceMessageId, msgId),
        isNotNull(documentsTable.fileKey),
        isNull(documentsTable.deletedAt),
      ))
      .limit(1);

    // ── Download media bytes ────────────────────────────────────────────────
    let fileBuffer: Buffer | null = null;
    let resolvedMimeType: string;
    let resolvedFilename: string;
    let reusedFileKey: string | null = null;
    let reusedSizeBytes: number | null = null;

    if (storedTwin?.fileKey) {
      reusedFileKey = storedTwin.fileKey;
      reusedSizeBytes = storedTwin.sizeBytes ?? null;
      resolvedMimeType = storedTwin.mimeType || attachMimeType || "application/octet-stream";
      resolvedFilename = sanitizeFileName(attachName || `attachment.${mimeToExt(resolvedMimeType)}`);
    } else try {
      if (waMediaId) {
        // WhatsApp Cloud API: resolve download URL then download with Bearer token
        const waConfig = await resolveOutboundConfig<WhatsAppConfig>("whatsapp", conv.channelAccountId, conv.communicationPipelineId);
        const accessToken = (waConfig?.accessToken ?? process.env.WA_ACCESS_TOKEN ?? "").trim();
        if (!accessToken) {
          res.status(502).json({ error: "WhatsApp access token not configured" });
          return;
        }

        // Step 1: get media info (URL + mime_type) from Graph API
        const infoRes = await fetch(
          `https://graph.facebook.com/${META_API_VERSION}/${waMediaId}`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (!infoRes.ok) {
          console.error(`[INBOX save-as-doc] WA media info failed ${infoRes.status} for ${waMediaId}`);
          res.status(502).json({ error: "Failed to retrieve WhatsApp media info" });
          return;
        }
        const mediaInfo = await infoRes.json() as { url?: string; mime_type?: string; file_size?: number };
        if (!mediaInfo.url) {
          res.status(502).json({ error: "WhatsApp media URL not returned" });
          return;
        }
        resolvedMimeType = attachMimeType || mediaInfo.mime_type || "application/octet-stream";

        // Step 2: download the media bytes with the same Bearer token
        const mediaRes = await safeOutboundRequest(mediaInfo.url, {
          headers: { Authorization: `Bearer ${accessToken}` },
          allowedProtocols: ["https:"],
          timeoutMs: 15_000,
          maxBytes: 25 * 1024 * 1024,
          maxRedirects: 2,
        });
        if (!mediaRes.ok) {
          console.error(`[INBOX save-as-doc] WA media download failed ${mediaRes.status}`);
          res.status(502).json({ error: "Failed to download WhatsApp media" });
          return;
        }
        fileBuffer = mediaRes.body;
        resolvedFilename = ensureAttachmentFilenameExtension(
          attachName || `attachment.${mimeToExt(resolvedMimeType)}`,
          resolvedMimeType,
        );
      } else {
        const localKey = resolveLocalInboxStorageKey(
          attachUrl!,
          configuredInboxMediaHosts([req.hostname]),
        );
        if (localKey) {
          // Web-chat and outbound composer uploads are private objects. Reading
          // them through fetch() either rejects a relative URL or loses the
          // authenticated request context; resolve the conversation-owned key
          // directly through the canonical storage helper instead.
          const file = await inboxMediaStorage.getObjectEntityFile(`/objects/${localKey}`);
          const [metadata] = await file.getMetadata();
          const [bytes] = await file.download();
          fileBuffer = bytes;
          resolvedMimeType = attachMimeType || metadata.contentType || "application/octet-stream";
        } else {
          // Zernio or direct URL — add Bearer auth only for zernio.com hosts.
          const fetchHeaders: Record<string, string> = {};
          try {
            const parsed = new URL(attachUrl!);
            if (parsed.hostname === "zernio.com") {
              const apiKey = await getZernioApiKey();
              if (apiKey) fetchHeaders["Authorization"] = `Bearer ${apiKey}`;
            }
          } catch { /* non-parseable URL — will fail on fetch below */ }

          const mediaRes = await safeOutboundRequest(attachUrl!, {
            headers: fetchHeaders,
            allowedProtocols: ["https:"],
            timeoutMs: 15_000,
            maxBytes: 25 * 1024 * 1024,
            maxRedirects: 2,
          });
          if (!mediaRes.ok) {
            console.error(`[INBOX save-as-doc] Attachment download failed (${mediaRes.status})`);
            res.status(502).json({ error: "Failed to download attachment" });
            return;
          }
          const contentType = mediaRes.headers["content-type"] || "application/octet-stream";
          fileBuffer = mediaRes.body;
          resolvedMimeType = attachMimeType || contentType.split(";")[0].trim();
        }
        resolvedFilename = ensureAttachmentFilenameExtension(
          attachName || `attachment.${mimeToExt(resolvedMimeType)}`,
          resolvedMimeType,
        );
      }
    } catch (err: any) {
      console.error("[INBOX save-as-doc] media fetch error:", err?.message ?? err);
      res.status(502).json({ error: "Failed to fetch attachment" });
      return;
    }

    // ── Validate file type and size (skipped for reused, already-validated bytes)
    let fileKey: string;
    let finalSizeBytes: number;
    if (reusedFileKey) {
      const validationError = validateStudentDocumentFile(
        documentType,
        resolvedFilename,
        resolvedMimeType,
        reusedSizeBytes ?? 0,
      );
      if (validationError) {
        res.status(validationError.type === "size_exceeded" ? 413 : 400).json({ error: validationError.message });
        return;
      }
      fileKey = reusedFileKey;
      finalSizeBytes = reusedSizeBytes ?? 0;
    } else {
      const buf = fileBuffer!;
      const validationError = validateStudentDocumentFile(documentType, resolvedFilename, resolvedMimeType, buf.length);
      if (validationError) {
        res.status(validationError.type === "size_exceeded" ? 413 : 400).json({ error: validationError.message });
        return;
      }
      const bufferError = await validateStudentDocumentBuffer(documentType, resolvedFilename, resolvedMimeType, buf);
      if (bufferError) {
        res.status(bufferError.type === "size_exceeded" ? 413 : 400).json({ error: bufferError.message });
        return;
      }

      // ── Upload to object storage ──────────────────────────────────────────
      const storage = new ObjectStorageService();
      fileKey = await storage.uploadBuffer({
        subdir: "inbox-docs",
        filename: resolvedFilename,
        buffer: buf,
        contentType: resolvedMimeType,
      });
      finalSizeBytes = buf.length;
    }

    // ── Resolve owner name for descriptive document name ────────────────────
    let ownerFirstName: string | null = null;
    let ownerLastName: string | null = null;
    if (ownerType === "student") {
      const [s] = await db.select({ firstName: studentsTable.firstName, lastName: studentsTable.lastName })
        .from(studentsTable).where(eq(studentsTable.id, ownerId));
      ownerFirstName = s?.firstName ?? null;
      ownerLastName = s?.lastName ?? null;
    } else {
      const [l] = await db.select({ firstName: leadsTable.firstName, lastName: leadsTable.lastName })
        .from(leadsTable).where(eq(leadsTable.id, ownerId));
      ownerFirstName = l?.firstName ?? null;
      ownerLastName = l?.lastName ?? null;
    }
    const docName = buildDocNameFromParts(ownerFirstName, ownerLastName, documentType, resolvedMimeType);

    // ── Create document record ──────────────────────────────────────────────
    const [doc] = await db.insert(documentsTable).values({
      name: docName,
      type: documentType,
      status: "pending",
      studentId: ownerType === "student" ? ownerId : null,
      leadId: ownerType === "lead" ? ownerId : null,
      applicationId: null,
      fileKey,
      mimeType: resolvedMimeType,
      sizeBytes: finalSizeBytes,
      source: "inbox",
      sourceConversationId: conversationId,
      sourceMessageId: msgId,
      sourceAttachmentId,
    }).returning();

    // Sync has_photo flag when a photo document is saved for a student.
    // Skipped when setAsPhoto === false (user chose "Add as Document Only" without
    // setting it as the profile photo).
    if (ownerType === "student" && (documentType === "photo" || documentType === "photograph") && setAsPhoto !== false) {
      await recomputeStudentPhoto(ownerId);
    }

    // ── Audit log ───────────────────────────────────────────────────────────
    await writeAudit({
      userId: req.user!.id,
      action: "inbox_save_as_document",
      resource: "document",
      resourceId: doc.id,
      changes: {
        sourceConversationId: conversationId,
        sourceMessageId: msgId,
        sourceAttachmentId,
        documentType,
        ownerType,
        ownerId,
      },
      ipAddress: req.ip,
    });

    res.status(201).json(doc);
  }
);

// ── Server-side AI extraction for unmatched student creation ──────────────────
//
// Downloads the attachment server-side (so auth tokens for WA/Zernio are
// always available) and calls the AI extraction endpoint logic. Returns the
// same { extracted } shape as POST /api/ai/extract-document. When the media
// cannot be fetched, returns { extracted: {} } — never an error — so the
// CreateStudentAndAddDocumentModal still advances to the form step with the
// contact-name/phone prefill applied.
const EXTRACT_FOR_STUDENT_ALLOWED_TYPES = ["diploma", "transcript", "passport", "photograph"] as const;
const EXTRACT_FOR_STUDENT_PROMPT = `You are an expert document analysis system for an education consultancy.
Analyze the provided document image(s) and extract student information.

Extract ALL of the following fields if visible in the document. Return a JSON object with these exact keys:
{
  "firstName": "string or null - EXACTLY as printed on the document, preserving original spelling and capitalization",
  "lastName": "string or null - EXACTLY as printed on the document, preserving original spelling and capitalization",
  "dateOfBirth": "YYYY-MM-DD format or null",
  "gender": "male|female or null",
  "nationality": "country name string (e.g. 'Afghanistan' not 'Afghan', 'Turkey' not 'Turkish', 'Iran' not 'Iranian', 'Pakistan' not 'Pakistani', 'Uzbekistan' not 'Uzbek', 'India' not 'Indian') or null",
  "passportNumber": "string or null",
  "passportIssueDate": "YYYY-MM-DD format or null",
  "passportExpiry": "YYYY-MM-DD format or null",
  "motherName": "string or null - EXACTLY as printed on the document",
  "fatherName": "string or null - EXACTLY as printed on the document",
  "email": "string or null",
  "phone": "string or null",
  "address": "string or null - full residence address exactly as printed",
  "addressCity": "string or null - residence city only, never the country",
  "postalCode": "string or null - postal/ZIP code only",
  "highSchool": "string or null - secondary school only; null for a university degree document",
  "institutionName": "string or null - full awarding school or university name",
  "fieldOfStudy": "string or null - department, major or programme printed on the document",
  "educationCountry": "country name string or null - country of the awarding institution",
  "graduationYear": "number or null - year the final secondary-school/degree examination was completed",
  "gpa": "string or null - overall marks exactly as numerator/denominator printed, e.g. '955/1200'; use a percentage only if the document itself prints a percentage",
  "documentType": "passport|diploma|transcript|photo|other",
  "confidence": "high|medium|low"
}
Rules:
- Extract names EXACTLY as they appear on the document. Do NOT modify, translate, or reformat names.
- Always normalize dates to YYYY-MM-DD format
- For nationality: always return the full country name (e.g. "Turkey" not "Turkish")
- For a passport, read Sex/Gender and Date of Issue explicitly. Convert M to male and F to female.
- For a passport number, use letters and digits only. Never output apostrophes, quotation marks, backticks or OCR punctuation. If any character is ambiguous, return null instead of guessing or deleting it.
- For a final diploma/certificate/transcript, graduationYear is the final examination or completion year. Do not use an attestation/legalization date.
- For marks/GPA, read BOTH "Marks obtained" and "Total marks"/"out of". Never return a numerator such as "955" without its printed denominator. Do not invent a 4-point scale.
- If multiple totals are visible, use the overall/final grand total, not one subject or one part.
- Return ONLY the JSON object, no other text
- Set null for fields you cannot find`;

router.post(
  "/inbox/conversations/:id/messages/:msgId/attachments/:idx/extract-for-student",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const conversationId = parseInt(String(req.params.id), 10);
    const msgId = parseInt(String(req.params.msgId), 10);
    const attachIndex = parseInt(String(req.params.idx), 10);

    if (!conversationId || !msgId || isNaN(attachIndex) || attachIndex < 0) {
      res.status(400).json({ error: "Invalid parameters" });
      return;
    }

    const { docType } = req.body as { docType?: string };

    const [conv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, conversationId));
    if (!conv) { res.status(404).json({ error: "Conversation not found" }); return; }

    const [msg] = await db.select().from(messagesTable).where(
      and(eq(messagesTable.id, msgId), eq(messagesTable.conversationId, conversationId))
    );
    if (!msg) { res.status(404).json({ error: "Message not found" }); return; }

    const meta = (msg.metadata ?? {}) as Record<string, any>;
    const zernioAtts: Array<Record<string, any>> = [
      ...(meta.attachment && typeof meta.attachment === "object" ? [meta.attachment as Record<string, any>] : []),
      ...(Array.isArray(meta.attachments) ? (meta.attachments as Record<string, any>[]) : []),
    ];

    let attachUrl: string | null = null;
    let attachMimeType: string | null = null;
    let waMediaId: string | null = null;

    if (attachIndex < zernioAtts.length) {
      const att = zernioAtts[attachIndex];
      attachUrl = String(att?.url ?? att?.fileUrl ?? "").trim() || null;
      attachMimeType = String(att?.mimeType ?? att?.mime_type ?? "").trim() || null;
    }

    if (!attachUrl && meta.raw && typeof meta.raw === "object" && attachIndex === 0) {
      const raw = meta.raw as Record<string, any>;
      const mediaType = String(raw.type ?? "");
      const mediaObj = mediaType ? (raw[mediaType] as Record<string, any> | undefined) : undefined;
      if (mediaObj?.id) {
        waMediaId = String(mediaObj.id);
        attachMimeType = attachMimeType || String(mediaObj.mime_type ?? "").trim() || null;
      }
    }

    if (!attachUrl && !waMediaId) {
      res.json({ extracted: {} });
      return;
    }

    // ── Download media bytes server-side ────────────────────────────────────
    let fileBuffer: Buffer;
    let resolvedMimeType: string;

    try {
      if (waMediaId) {
        const waConfig = await resolveOutboundConfig<WhatsAppConfig>("whatsapp", conv.channelAccountId, conv.communicationPipelineId);
        const accessToken = (waConfig?.accessToken ?? process.env.WA_ACCESS_TOKEN ?? "").trim();
        if (!accessToken) {
          res.json({ extracted: {} });
          return;
        }
        const infoRes = await fetch(
          `https://graph.facebook.com/${META_API_VERSION}/${waMediaId}`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (!infoRes.ok) {
          console.warn(`[INBOX extract-for-student] WA media info failed ${infoRes.status} for ${waMediaId}`);
          res.json({ extracted: {} });
          return;
        }
        const mediaInfo = await infoRes.json() as { url?: string; mime_type?: string };
        if (!mediaInfo.url) {
          res.json({ extracted: {} });
          return;
        }
        resolvedMimeType = attachMimeType || mediaInfo.mime_type || "application/octet-stream";
        const mediaRes = await safeOutboundRequest(mediaInfo.url, {
          headers: { Authorization: `Bearer ${accessToken}` },
          allowedProtocols: ["https:"],
          timeoutMs: 15_000,
          maxBytes: 25 * 1024 * 1024,
          maxRedirects: 2,
        });
        if (!mediaRes.ok) {
          console.warn(`[INBOX extract-for-student] WA media download failed ${mediaRes.status}`);
          res.json({ extracted: {} });
          return;
        }
        fileBuffer = mediaRes.body;
      } else {
        const localKey = resolveLocalInboxStorageKey(
          attachUrl!,
          configuredInboxMediaHosts([req.hostname]),
        );
        if (localKey) {
          const file = await inboxMediaStorage.getObjectEntityFile(`/objects/${localKey}`);
          const [metadata] = await file.getMetadata();
          const [bytes] = await file.download();
          fileBuffer = bytes;
          resolvedMimeType = attachMimeType || metadata.contentType || "application/octet-stream";
        } else {
          const fetchHeaders: Record<string, string> = {};
          try {
            const parsed = new URL(attachUrl!);
            if (parsed.hostname === "zernio.com") {
              const apiKey = await getZernioApiKey();
              if (apiKey) fetchHeaders["Authorization"] = `Bearer ${apiKey}`;
            }
          } catch { /* non-parseable URL */ }

          const mediaRes = await safeOutboundRequest(attachUrl!, {
            headers: fetchHeaders,
            allowedProtocols: ["https:"],
            timeoutMs: 15_000,
            maxBytes: 25 * 1024 * 1024,
            maxRedirects: 2,
          });
          if (!mediaRes.ok) {
            console.warn(`[INBOX extract-for-student] Attachment download failed (${mediaRes.status})`);
            res.json({ extracted: {} });
            return;
          }
          const contentType = mediaRes.headers["content-type"] || "application/octet-stream";
          fileBuffer = mediaRes.body;
          resolvedMimeType = attachMimeType || contentType.split(";")[0].trim();
        }
      }
    } catch (err: any) {
      console.warn("[INBOX extract-for-student] media fetch error:", err?.message ?? err);
      res.json({ extracted: {} });
      return;
    }

    // ── Run AI extraction ───────────────────────────────────────────────────
    try {
      const anthropic = (await getDocumentAiConnection("claude", { fallbackToDefault: false })).client;
      const isImage = resolvedMimeType.startsWith("image/");
      const base64 = fileBuffer.toString("base64");
      const label = docType && EXTRACT_FOR_STUDENT_ALLOWED_TYPES.includes(docType as any) ? docType : "document";

      const contentBlocks: any[] = [
        { type: "text", text: EXTRACT_FOR_STUDENT_PROMPT },
        { type: "text", text: `\n--- Document: ${label} ---` },
      ];

      if (isImage) {
        const validImageTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
        const mediaType = validImageTypes.includes(resolvedMimeType) ? resolvedMimeType : "image/jpeg";
        contentBlocks.push({
          type: "image",
          source: { type: "base64", media_type: mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp", data: base64 },
        });
      } else {
        contentBlocks.push({
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: base64 },
        });
      }

      const message = await documentAiScheduler.run(
        { laneKey: "inbox-document", connectionKey: "claude" },
        () => anthropic.messages.create({
          model: "claude-sonnet-4-6",
          max_tokens: 4096,
          messages: [{ role: "user", content: contentBlocks }],
        }),
      );

      const textBlock = message.content.find((b) => b.type === "text");
      if (!textBlock || textBlock.type !== "text") {
        res.json({ extracted: {} });
        return;
      }

      let extracted: Record<string, any> = {};
      try {
        const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
        if (jsonMatch) extracted = JSON.parse(jsonMatch[0]);
      } catch {
        res.json({ extracted: {} });
        return;
      }

      res.json({ extracted: normalizeInboxStudentExtraction(extracted) });
    } catch (err: any) {
      console.warn("[INBOX extract-for-student] AI extraction error:", err?.message ?? err);
      res.json({ extracted: {} });
    }
  }
);

// ── Document summary for a conversation's linked lead/student ─────────────────
//
// Returns the presence of each required document type for the conversation's
// linked entity (lead or student). Student takes priority over lead when both
// are linked (i.e. a converted lead).
//
// Response: { diploma: {exists, documentId}, transcript: {...}, passport: {...}, photograph: {...} }

router.get(
  "/inbox/conversations/:id/document-summary",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const conversationId = parseInt(String(req.params.id), 10);
    if (!conversationId) { res.status(400).json({ error: "Invalid id" }); return; }

    const link = await loadConversationLink(conversationId);
    if (!link) { res.status(404).json({ error: "Conversation not found" }); return; }

    const DOC_TYPES = ["diploma", "transcript", "passport", "photograph"] as const;
    type SummaryDocType = typeof DOC_TYPES[number];

    const summary: Record<SummaryDocType, { exists: boolean; documentId: number | null }> = {
      diploma: { exists: false, documentId: null },
      transcript: { exists: false, documentId: null },
      passport: { exists: false, documentId: null },
      photograph: { exists: false, documentId: null },
    };

    if (!link.leadId && !link.studentId) {
      res.json(summary);
      return;
    }

    const ownerConditions: ReturnType<typeof eq>[] = [];
    if (link.studentId) ownerConditions.push(eq(documentsTable.studentId, link.studentId));
    if (link.leadId) ownerConditions.push(eq(documentsTable.leadId, link.leadId));

    const docs = await db
      .select({ id: documentsTable.id, type: documentsTable.type })
      .from(documentsTable)
      .where(and(
        or(...ownerConditions),
        inArray(documentsTable.type, [...DOC_TYPES]),
        isNull(documentsTable.deletedAt)
      ))
      .orderBy(desc(documentsTable.createdAt));

    for (const doc of docs) {
      const t = doc.type as SummaryDocType;
      if (DOC_TYPES.includes(t) && !summary[t].exists) {
        summary[t] = { exists: true, documentId: doc.id };
      }
    }

    res.json(summary);
  }
);

// ── Per-conversation subscribe toggle (per-user) ─────────────────────────────
router.post(
  "/inbox/conversations/:id/subscribe",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const id = parseInt(String(req.params.id), 10);
    const userId = req.user!.id;
    if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

    const [existing] = await db
      .select()
      .from(conversationParticipantsTable)
      .where(and(eq(conversationParticipantsTable.conversationId, id), eq(conversationParticipantsTable.userId, userId)))
      .limit(1);

    if (existing) {
      await db.delete(conversationParticipantsTable).where(eq(conversationParticipantsTable.id, existing.id));
      res.json({ subscribed: false });
    } else {
      await db.insert(conversationParticipantsTable).values({ conversationId: id, userId, isStarred: false });
      res.json({ subscribed: true });
    }
  },
);

/* ─── START OUTBOUND WHATSAPP CONVERSATION ───────────────────── */

/**
 * POST /api/inbox/conversations/start
 *
 * Idempotent: if the entity already has a WhatsApp conversation (with a real
 * externalThreadId) this returns that conversation instead of creating a new
 * one. If the conversation exists we also send the template through it so the
 * message appears in the existing thread.
 *
 * If no conversation exists we:
 *   1. Create an external_contact keyed by phone (externalId = "wa_out:<e164>")
 *   2. Create a conversation with externalThreadId = null (no Zernio thread yet)
 *   3. Send the template via the Zernio broadcast flow
 *   4. Record the outbound message (sent or failed)
 *   5. Sync the assignment cascade
 *
 * The conversation can be navigated to immediately. When the contact replies
 * Zernio will send an inbound webhook that creates the real thread — the inbox
 * will show a separate conversation for that (standard inbound path).
 */
router.post(
  "/inbox/conversations/start",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const userId = req.user!.id;
    const { entityType, entityId: rawId, templateId: rawTplId, parameters, channelAccountId: rawChannelAccountId } = req.body as {
      entityType: string;
      entityId: number | string;
      templateId: number | string;
      parameters?: string[];
      channelAccountId?: number | string;
    };

    const entityId = parseInt(String(rawId || ""), 10);
    const templateId = parseInt(String(rawTplId || ""), 10);
    const channelAccountId = rawChannelAccountId == null ? undefined : parseInt(String(rawChannelAccountId), 10);

    if (!entityType || !entityId || !templateId) {
      res.status(400).json({ error: "entityType, entityId and templateId are required" });
      return;
    }

    try {
      // ── 1. Entity lookup + IDOR guard ─────────────────────────────────────
      const contactConds: any[] = [];
      let entityAgentId: number | null | undefined;
      let entityPhoneE164: string | null = null;
      let entityDisplayName = "";
      let resolvedStudentId: number | null = null;

      if (entityType === "lead") {
        const [row] = await db
          .select({ agentId: leadsTable.agentId, phoneE164: leadsTable.phoneE164, phone: leadsTable.phone, firstName: leadsTable.firstName, lastName: leadsTable.lastName })
          .from(leadsTable)
          .where(eq(leadsTable.id, entityId));
        if (!row) { res.status(404).json({ error: "entity_not_found" }); return; }
        entityAgentId = row.agentId;
        entityPhoneE164 = row.phoneE164 || (row.phone ? toE164(String(row.phone)) : null);
        entityDisplayName = `${row.firstName || ""} ${row.lastName || ""}`.trim();
        contactConds.push(eq(externalContactsTable.leadId, entityId));
      } else if (entityType === "student") {
        const [row] = await db
          .select({ agentId: studentsTable.agentId, phoneE164: studentsTable.phoneE164, phone: studentsTable.phone, firstName: studentsTable.firstName, lastName: studentsTable.lastName })
          .from(studentsTable)
          .where(eq(studentsTable.id, entityId));
        if (!row) { res.status(404).json({ error: "entity_not_found" }); return; }
        entityAgentId = row.agentId;
        entityPhoneE164 = row.phoneE164 || (row.phone ? toE164(String(row.phone)) : null);
        entityDisplayName = `${row.firstName || ""} ${row.lastName || ""}`.trim();
        resolvedStudentId = entityId;
        contactConds.push(eq(externalContactsTable.studentId, entityId));
      } else if (entityType === "application") {
        const [application] = await db
          .select({ studentId: applicationsTable.studentId, agentId: applicationsTable.agentId })
          .from(applicationsTable)
          .where(eq(applicationsTable.id, entityId));
        if (!application?.studentId) { res.status(404).json({ error: "entity_not_found" }); return; }
        const [student] = await db
          .select({
            agentId: studentsTable.agentId,
            phoneE164: studentsTable.phoneE164,
            phone: studentsTable.phone,
            firstName: studentsTable.firstName,
            lastName: studentsTable.lastName,
          })
          .from(studentsTable)
          .where(eq(studentsTable.id, application.studentId));
        const target = resolveApplicationMessageTarget(application, student);
        if (!target) { res.status(404).json({ error: "entity_not_found" }); return; }
        entityAgentId = target.agentId;
        entityPhoneE164 = target.phoneE164;
        entityDisplayName = target.displayName;
        resolvedStudentId = target.studentId;
        contactConds.push(eq(externalContactsTable.studentId, target.studentId));
      } else {
        res.status(400).json({ error: "entityType must be lead, student or application" });
        return;
      }

      if (entityAgentId !== undefined && isAgentSourcedAndBlockedForStaff(req.user!, entityAgentId)) {
        res.status(404).json({ error: "entity_not_found" });
        return;
      }

      if (!entityPhoneE164) {
        res.status(422).json({ error: "no_phone", detail: "Entity has no E.164 phone number" });
        return;
      }
      const phoneE164 = toE164(entityPhoneE164) || entityPhoneE164;

      // ── 2. Template validation ─────────────────────────────────────────────
      const [tpl] = await db
        .select()
        .from(messageTemplatesTable)
        .where(eq(messageTemplatesTable.id, templateId));
      if (!tpl || !tpl.externalTemplateName) {
        res.status(400).json({ error: "Template not found or missing externalTemplateName" });
        return;
      }

      const placeholderMatches = (tpl.content || "").match(/\{\{\s*\d+\s*\}\}/g);
      const placeholderCount = placeholderMatches
        ? new Set(placeholderMatches.map((m) => m.replace(/\D/g, ""))).size
        : 0;
      const providedParams: string[] = parameters || [];
      if (providedParams.length !== placeholderCount) {
        res.status(400).json({
          error: `Template gönderilemedi: şablonda ${placeholderCount} değişken var, ${providedParams.length} değer girildi.`,
        });
        return;
      }

      // ── 3. Resolve recipient line + provider proof ─────────────────────────
      // Existing contacts stay on the line where they wrote to us. New contacts
      // use the configured default line. Never infer approval from the global
      // message_templates cache.
      const account = await resolveEntityWhatsAppTarget(contactConds[0], channelAccountId);
      if (!account) {
        res.status(409).json({ error: "no_zernio_account", detail: "No active WhatsApp line is available for this recipient." });
        return;
      }

      const availability = await resolveApprovedZernioTemplate({
        externalAccountId: account.externalAccountId,
        templateName: tpl.externalTemplateName,
        preferredLanguage: tpl.language,
      });
      if (!availability.ok) {
        if (availability.reason === "provider_unavailable") {
          res.status(502).json({
            error: "template_availability_check_failed",
            detail: `Approved templates for WhatsApp line “${account.displayName}” could not be verified. Nothing was sent.`,
          });
        } else {
          res.status(409).json({
            error: "template_not_approved_for_whatsapp_account",
            detail: `Template “${tpl.externalTemplateName}” is not approved for WhatsApp line “${account.displayName}”.`,
          });
        }
        return;
      }
      const providerLanguage = availability.template.language;

      // ── 4a. Existing conversation → send template on it, return ───────────
      if (account.conversationId) {
        const existingConvId = account.conversationId;
        const zr = await sendZernioTemplate({
          externalAccountId: account.externalAccountId,
          templateName: tpl.externalTemplateName,
          language: providerLanguage,
          toPhoneE164: phoneE164,
          parameters: providedParams,
          recipientLabel: entityDisplayName || phoneE164,
        });

        const renderedContent = providedParams.reduce<string>(
          (acc, val, idx) => acc.replace(new RegExp(`\\{\\{${idx + 1}\\}\\}`, "g"), val),
          tpl.content || "",
        );

        await db.insert(messagesTable).values({
          conversationId: existingConvId,
          senderId: userId,
          content: renderedContent,
          channel: "whatsapp",
          direction: "outbound",
          status: zr.ok ? "sent" : "failed",
          externalMessageId: zr.externalMessageId || null,
          failedReason: zr.ok ? null : zr.error || "send_failed",
          sentAt: zr.ok ? new Date() : null,
          metadata: {
            template: tpl.externalTemplateName,
            ...(zr.broadcastId ? { broadcastId: zr.broadcastId } : {}),
          },
        });

        if (zr.ok) {
          await db
            .update(conversationsTable)
            .set({ lastMessageAt: new Date(), lastMessagePreview: renderedContent.slice(0, 200) })
            .where(eq(conversationsTable.id, existingConvId));
          inboxBus.publish({
            type: "message",
            conversationId: existingConvId,
            channel: "whatsapp",
            assignedToId: null,
            unmatched: false,
            direction: "outbound",
          });
          await logAudit(userId, "inbox.start_conversation", entityType, entityId, { channel: "whatsapp", templateName: tpl.externalTemplateName, conversationId: existingConvId }, req.ip);
          res.status(201).json({ conversationId: existingConvId, alreadyExists: true });
        } else {
          res.status(502).json({ error: "template_send_failed", detail: zr.error || null, conversationId: existingConvId });
        }
        return;
      }

      // ── 4b. No existing conversation → create one + send template ─────────
      // Find or create external_contact by phone.
      // We use a stable externalId derived from the phone so that repeated calls
      // don't create duplicate contacts. When the contact replies, processInbound
      // will upsert its own row with the real Zernio contact ID.
      const outboundExternalId = `wa_out:${phoneE164.replace(/\+/, "")}`;

      let externalContactId: number;
      const [existingContact] = await db
        .select({ id: externalContactsTable.id })
        .from(externalContactsTable)
        .where(and(
          eq(externalContactsTable.channel, "whatsapp"),
          eq(externalContactsTable.externalId, outboundExternalId),
        ))
        .limit(1);

      if (existingContact) {
        externalContactId = existingContact.id;
        // Keep the entity link up-to-date.
        const updates: Record<string, number | null> = {};
        if (resolvedStudentId != null) updates.studentId = resolvedStudentId;
        else if (entityType === "lead") updates.leadId = entityId;
        if (Object.keys(updates).length > 0) {
          await db.update(externalContactsTable).set(updates).where(eq(externalContactsTable.id, externalContactId));
        }
      } else {
        const [newContact] = await db
          .insert(externalContactsTable)
          .values({
            channel: "whatsapp",
            externalId: outboundExternalId,
            phoneE164,
            displayName: entityDisplayName || phoneE164,
            leadId: entityType === "lead" ? entityId : null,
            studentId: resolvedStudentId,
          })
          .onConflictDoNothing({ target: [externalContactsTable.channel, externalContactsTable.externalId] })
          .returning({ id: externalContactsTable.id });
        if (!newContact) {
          // Concurrent insert — refetch.
          const [refetched] = await db.select({ id: externalContactsTable.id }).from(externalContactsTable)
            .where(and(eq(externalContactsTable.channel, "whatsapp"), eq(externalContactsTable.externalId, outboundExternalId)));
          if (!refetched) { res.status(500).json({ error: "Failed to create external contact" }); return; }
          externalContactId = refetched.id;
        } else {
          externalContactId = newContact.id;
        }
      }

      // Check if there's already an outbound-initiated conversation for this contact.
      const [existingOutboundConv] = await db
        .select({ id: conversationsTable.id })
        .from(conversationsTable)
        .where(and(
          eq(conversationsTable.externalContactId, externalContactId),
          eq(conversationsTable.channel, "whatsapp"),
          eq(conversationsTable.channelAccountId, account.id),
        ))
        .orderBy(desc(conversationsTable.lastMessageAt))
        .limit(1);

      let convId: number;
      if (existingOutboundConv) {
        convId = existingOutboundConv.id;
      } else {
        const [newConv] = await db
          .insert(conversationsTable)
          .values({
            type: "external",
            title: entityDisplayName || phoneE164,
            channel: "whatsapp",
            channelAccountId: account.id,
            externalContactId,
            externalThreadId: null,
            unmatched: false,
            status: "open",
            createdById: userId,
            lastMessageAt: new Date(),
            lastMessagePreview: "",
            metadata: { source: "outbound_start" },
          })
          .returning({ id: conversationsTable.id });
        convId = newConv.id;
      }

      // Send template via Zernio broadcast.
      const zr = await sendZernioTemplate({
        externalAccountId: account.externalAccountId,
        templateName: tpl.externalTemplateName,
        language: providerLanguage,
        toPhoneE164: phoneE164,
        parameters: providedParams,
        recipientLabel: entityDisplayName || phoneE164,
      });

      const renderedContent = providedParams.reduce<string>(
        (acc, val, idx) => acc.replace(new RegExp(`\\{\\{${idx + 1}\\}\\}`, "g"), val),
        tpl.content || "",
      );

      await db.insert(messagesTable).values({
        conversationId: convId,
        senderId: userId,
        content: renderedContent,
        channel: "whatsapp",
        direction: "outbound",
        status: zr.ok ? "sent" : "failed",
        externalMessageId: zr.externalMessageId || null,
        failedReason: zr.ok ? null : zr.error || "send_failed",
        sentAt: zr.ok ? new Date() : null,
        metadata: {
          template: tpl.externalTemplateName,
          ...(zr.broadcastId ? { broadcastId: zr.broadcastId } : {}),
        },
      });

      if (!zr.ok) {
        // Conversation exists but template send failed — be explicit.
        res.status(502).json({
          error: "template_send_failed",
          detail: zr.error || null,
          conversationId: convId,
        });
        return;
      }

      await db
        .update(conversationsTable)
        .set({ lastMessageAt: new Date(), lastMessagePreview: renderedContent.slice(0, 200) })
        .where(eq(conversationsTable.id, convId));

      await syncConversationOwner(convId, userId, req.ip);

      inboxBus.publish({
        type: "message",
        conversationId: convId,
        channel: "whatsapp",
        assignedToId: null,
        unmatched: false,
        direction: "outbound",
      });

      await logAudit(userId, "inbox.start_conversation", entityType, entityId, { channel: "whatsapp", templateName: tpl.externalTemplateName, conversationId: convId }, req.ip);

      res.status(201).json({ conversationId: convId, alreadyExists: false });
    } catch (err: any) {
      console.error("[inbox/conversations/start]", err);
      res.status(500).json({ error: "Failed to start conversation" });
    }
  },
);

export default router;
