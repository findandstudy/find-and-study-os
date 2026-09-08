import express, { Router, type IRouter, json } from "express";
import crypto from "crypto";
import { parse as parseJavaScript } from "acorn";
import {
  db,
  embedWidgetsTable,
  embedSubmissionsTable,
  leadsTable,
  programsTable,
  universitiesTable,
  documentsTable,
  studentsTable,
  applicationsTable,
  usersTable,
  programDocumentRequirementsTable,
  settingsTable,
  countriesTable,
  externalContactsTable,
  conversationsTable,
  messagesTable,
  integrationsTable,
  aiExtractorsTable,
  aiBotsTable,
  communicationPipelinesTable,
  agentsTable,
  canonicalCountry,
} from "@workspace/db";
import { eq, ilike, sql, and, or, asc, desc, inArray, isNotNull, isNull } from "drizzle-orm";
import { requireAuth, requireRole, logAudit } from "../lib/auth";
import { ADMIN_ROLES, STAFF_ROLES } from "../lib/roles";
import rateLimit from "express-rate-limit";
import {
  APPLICATION_DOCUMENT_HELP_TEXT,
  APPLICATION_DOCUMENT_MAX_SIZE,
  APPLICATION_DOCUMENT_MAX_SIZE_MB,
  sanitizeFileName,
  isAllowedMimeType,
  isPdf,
  validateApplicationDocumentFile,
  validateStudentDocumentFile,
  validateStudentDocumentBuffer,
  validateUploadedFile,
  validateUploadedFileBuffer,
} from "../lib/fileUploadValidation";
import { processUpload, UploadTooLargeError } from "../lib/uploads/processUpload";
import { buildDocNameFromParts } from "../lib/docNaming";
import { recomputeStudentPhoto } from "../lib/studentPhoto";
import { PgRateLimitStore } from "../lib/pgRateLimiter";
import { getRateLimitIp } from "../lib/clientIp";
import { createApplicationForStudent } from "./public-apply";
import { checkMandatoryDocs, checkMandatoryDocsForStudent, parkApplicationInMissingDocsStage } from "../lib/mandatoryDocs.js";
import { dispatchNotification } from "../lib/notificationDispatcher.js";
import { enqueueOnStageChange, maybeEnqueuePortalSubmission } from "../lib/portalAutoTrigger.js";
import { maybeTriggerAutoEducationExtractForStudent } from "../lib/educationAutoExtract";
import { getDocEquivalenceGroup, getRelevantGroupsForLevel, type DocEquivalenceGroupId } from "@workspace/doc-equivalence";
import { generateSecureToken } from "../lib/email";
import { applyLeadAssignmentRules } from "../lib/leadAssignment";
import { findOrUpsertEmbedLead } from "../lib/embedLeadDedup";
import { toE164 } from "../lib/inbox/phone";
import { resolveIdentity } from "../lib/inbox/identityResolver";
import { maybeAutoReply } from "../lib/inbox/botAutoReply";
import { inboxBus } from "../lib/inbox/eventBus";
import { processInboundMessage } from "../lib/inbox/processInbound";
import { ObjectNotFoundError, ObjectStorageService } from "../lib/objectStorage";
import {
  WEB_CHAT_MEDIA_MAX_BYTES,
  WebChatMediaValidationError,
  readWebChatAttachments,
  validateWebChatMedia,
  webChatMediaAcceptAttribute,
  webChatObjectPath,
  type WebChatAttachment,
} from "../lib/inbox/webChatMedia";
import {
  createEmbedChatSessionToken,
  verifyEmbedChatSessionToken,
} from "../lib/embedChatSession";
import {
  createEmbedLeadDocumentSessionToken,
  verifyEmbedLeadDocumentSessionToken,
} from "../lib/embedLeadDocumentSession";
import {
  EMBED_DOCUMENT_MANIFEST_LIMIT,
  normalizeEmbedDocumentManifest,
} from "../lib/embedDocumentManifest";
import { isAnthropicConnectionKey } from "../lib/documentAiConnection";
import { getEmbedSigningSecret } from "../lib/embedSigningSecret";
import { rejectInvalidPhone } from "../lib/phoneValidation";
import { containsNonLatinLetter, NON_LATIN_NAME_CODE } from "../lib/textNormalize";
import { sanitizeGa4AnalyticsContext } from "../lib/ga4LeadTracking";
import { runFtcNewLeadAutomation } from "../lib/ftcLeadAutomation";
import {
  isValidEmbedUniversityScope,
  resolveEmbedPresetScopeFilters,
  resolveEmbedUniversityScope,
} from "../lib/embedUniversityScope";
import {
  emptySummary,
  tallyResult,
  nextAvailableSlug,
  isValidConflictStrategy,
  ImportValidationError,
  type ConflictStrategy,
} from "../lib/exportImport";
import {
  buildWorkbookBuffer,
  parseWorkbookBuffer,
  XLSX_CONTENT_TYPE,
  embedWidgetColumns,
  buildEmbedFilterReferenceSheets,
  toEmbedInsertValues,
  EMBED_KIND,
  EMBED_FILTER_KEYS as EMBED_FILTER_KEYS_FROM_LIB,
  type EmbedFilterCatalog,
} from "../lib/exportImportExcel";
import { resolveResidenceAddress } from "../lib/studentAddressDefaults";
import {
  getEmbedChatCopy,
  localeFromPublicUrl,
  resolveEmbedChatLocale,
  type EmbedChatLocale,
} from "../lib/embedChatI18n";
import { getEmbedLeadFormCopy } from "../lib/embedLeadFormI18n";
import { validatePassportNumber } from "@workspace/portal-adapters/identity-validation";
import { resolveProgramInterestedLevel } from "../lib/programInterestedLevel";
import { requireAiBotId } from "../lib/inbox/aiBotRuntime";

const TR_MAP: Record<string, string> = { "ç":"C","Ç":"C","ğ":"G","Ğ":"G","ı":"I","İ":"I","ö":"O","Ö":"O","ş":"S","Ş":"S","ü":"U","Ü":"U" };
function tlu(v: any, max: number): string | null {
  if (v === undefined || v === null) return null;
  const str = String(v).replace(/[çÇğĞıİöÖşŞüÜ]/g, (c) => TR_MAP[c] || c).toUpperCase().trim();
  if (!str) return null;
  return str.slice(0, max);
}
/**
 * Returns the first name field that contains a non-Latin-script letter, or null
 * if all provided names are Latin-only. Used to hard-reject Arabic/Cyrillic/etc.
 * names on public embed intake (mirrors normalizeAndValidateNames server-side).
 */
function firstNonLatinNameField(pairs: Array<[string, unknown]>): string | null {
  for (const [field, value] of pairs) {
    if (typeof value === "string" && value.trim() !== "" && containsNonLatinLetter(value.trim())) {
      return field;
    }
  }
  return null;
}
function pn(raw: any, cc: any, max: number): string | null {
  let phoneRaw = raw ? String(raw) : "";
  if (!phoneRaw) return null;
  const ccRaw = cc ? String(cc) : "";
  // When an international dial code (e.g. "+44") is provided, strip any
  // leading national trunk prefix "0" from the subscriber number so the
  // combined result is valid E.164 (e.g. "07700900000" + "+44" →
  // "+447700900000" not "+4407700900000"). In E.164 the trunk digit is
  // always omitted; keeping it produces an invalid number that is rejected
  // by libphonenumber-js even though the subscriber number itself is correct.
  if (ccRaw.startsWith("+") && phoneRaw.startsWith("0")) {
    phoneRaw = phoneRaw.replace(/^0+/, "");
    if (!phoneRaw) return null;
  }
  const combined = (ccRaw + phoneRaw).trim();
  const hasPlus = combined.startsWith("+");
  const digits = combined.replace(/\D/g, "");
  if (!digits) return null;
  return (hasPlus ? "+" + digits : digits).slice(0, max);
}
function pnOnly(raw: any, max: number): string | null {
  if (!raw) return null;
  const str = String(raw).trim();
  const hasPlus = str.startsWith("+");
  const digits = str.replace(/\D/g, "");
  if (!digits) return null;
  return (hasPlus ? "+" + digits : digits).slice(0, max);
}

const router: IRouter = Router();

// Current widgets persist documents before the final /apply and only send a
// signed document-session reference on submit. Keep the larger parser on
// /apply for backwards compatibility with cached/legacy widgets that still
// carry base64 files in the final request. Routes are gated by step-specific
// submit limiters (applied before the parser so rejected requests never pay
// the parse cost) and per-widget allowed-domains validation.
const embedApplyJson = json({ limit: "30mb" });
const embedLeadJson = json({ limit: "256kb" });
const embedChatJson = json({ limit: "64kb" });
const embedChatMediaBody = express.raw({
  limit: WEB_CHAT_MEDIA_MAX_BYTES,
  type: () => true,
});
const embedChatMediaStorage = new ObjectStorageService();

const EMBED_WINDOW_MS = 15 * 60 * 1000;
function createEmbedSubmitLimiter(prefix: string, max: number) {
  return rateLimit({
    windowMs: EMBED_WINDOW_MS,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many submissions. Please try again later." },
    store: new PgRateLimitStore(EMBED_WINDOW_MS, prefix),
    // Keep unrelated partner widgets and unrelated steps from consuming one
    // shared IP bucket. The IP component still prevents anonymous abuse while
    // the slug component avoids cross-partner interference.
    keyGenerator: (req) => `${getRateLimitIp(req)}:${String(req.params.slug || "unknown")}`,
  });
}

const embedLeadSubmitLimiter = createEmbedSubmitLimiter("embed-lead", 30);
const embedDocumentSubmitLimiter = createEmbedSubmitLimiter("embed-document", 80);
const embedApplicationSubmitLimiter = createEmbedSubmitLimiter("embed-application", 30);

const EMBED_CHAT_WINDOW_MS = 60 * 1000;
const embedChatLimiter = rateLimit({
  windowMs: EMBED_CHAT_WINDOW_MS,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many chat requests. Please wait a moment." },
  store: new PgRateLimitStore(EMBED_CHAT_WINDOW_MS, "embed-chat"),
  keyGenerator: (req) => getRateLimitIp(req),
});

const EMBED_CHAT_UPLOAD_WINDOW_MS = 15 * 60 * 1000;
const embedChatUploadLimiter = rateLimit({
  windowMs: EMBED_CHAT_UPLOAD_WINDOW_MS,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many file uploads. Please try again later." },
  store: new PgRateLimitStore(EMBED_CHAT_UPLOAD_WINDOW_MS, "embed-chat-upload"),
  keyGenerator: (req) => getRateLimitIp(req),
});

// ─── Embed HMAC security helpers ─────────────────────────────────────────────
// Two-layer security model (no Origin/Referer headers trusted at auth gates):
//
// 1. Widget API key (per-widget, randomly generated, stored in DB):
//    A 256-bit random hex key stored in embed_widgets.embed_api_key.
//    It is NEVER placed in HTML or the embed code snippet.  Admin gives this
//    key to the partner's backend team out-of-band (e.g., dashboard copy
//    button).  The partner's backend server calls
//      GET /api/public/embed/:slug/token
//    with the key in the X-Widget-Api-Key request header (server-to-server)
//    to obtain a short-lived session token.  The partner's frontend code calls
//    their own backend endpoint to get the session token — no secret ever
//    touches the browser.
//
//    Defense-in-depth: if a browser does reach /token with an Origin header
//    that is NOT in allowedDomains, the request is still rejected (even with
//    a valid key).
//
//    Key rotation: POST /api/embed/widgets/:id/rotate-key (admin-authenticated).
//
// 2. Short-lived session token (1-hour, per-request):
//    After the widget API key is validated, /token issues a slug-bound HMAC
//    session token.  The partner's backend returns this to the browser, which
//    passes it as ?t=<token> to all JSON data endpoints.  Open widgets (empty
//    allowedDomains) get a free session token — no API key required.
//
// Fail-closed: getEmbedSigningSecret() throws if SESSION_SECRET is absent.
// Restricted operations propagate this as HTTP 500 — no known-literal fallback.
//
// Session token format: base64url(JSON{slug,exp,jti}) + "." + base64url(HMAC)

const EMBED_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour — session token lifetime

/**
 * Generates a fresh random widget API key (64 hex chars / 256 bits).
 * This is called server-side only; the key is stored in the DB and given to
 * the partner's backend team out-of-band.  It is NEVER placed in HTML or
 * the public embed code.
 */
function generateWidgetApiKey(): string {
  return crypto.randomBytes(32).toString("hex");
}

function createEmbedToken(slug: string): string {
  const exp = Date.now() + EMBED_TOKEN_TTL_MS;
  const jti = crypto.randomBytes(8).toString("hex");
  const payload = Buffer.from(JSON.stringify({ slug, exp, jti })).toString("base64url");
  const sig = crypto.createHmac("sha256", getEmbedSigningSecret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifyEmbedToken(token: string | undefined, slug: string): boolean {
  if (!token || typeof token !== "string") return false;
  try {
    const dot = token.indexOf(".");
    if (dot < 1) return false;
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    if (!sig) return false;
    const expectedSig = crypto.createHmac("sha256", getEmbedSigningSecret()).update(payload).digest("base64url");
    const sigBuf = Buffer.from(sig, "base64url");
    const expBuf = Buffer.from(expectedSig, "base64url");
    // Constant-time comparison prevents timing-oracle attacks.
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return false;
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (parsed.slug !== slug) return false;
    if (typeof parsed.exp !== "number" || Date.now() > parsed.exp) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * checkEmbedAccess() is the authorization gate for the widget JSON endpoints.
 *
 * - Open widgets (empty allowedDomains): always pass — no restriction needed.
 * - Restricted widgets: require a valid, non-expired, slug-bound HMAC token
 *   supplied as the `t` query parameter.  Origin/Referer are NOT trusted for
 *   these endpoints because they reflect the iframe's same-origin API server
 *   URL, not the partner site.
 */
function checkEmbedAccess(widget: any, token: string | undefined): boolean {
  const domains = widget.allowedDomains as string[];
  if (!domains || domains.length === 0) return true;
  return verifyEmbedToken(token, String(widget.slug));
}

type PreparedEmbedDocument = {
  label: string;
  data: string;
  mediaType: string;
  sizeBytes?: number | null;
};

async function prepareEmbedDocuments(rawDocuments: unknown): Promise<{
  validDocs: PreparedEmbedDocument[];
  warnings: string[];
  inputCount: number;
}> {
  const rawDocs = Array.isArray(rawDocuments)
    ? rawDocuments.slice(0, EMBED_DOCUMENT_MANIFEST_LIMIT)
    : [];
  const docArray = rawDocs
    .filter((d: any) => d && typeof d === "object" && d.label && d.data && typeof d.data === "string")
    .map((d: any) => ({ ...d }));

  for (const doc of docArray) {
    const rawData = String(doc.data || "");
    if (/^data:/i.test(rawData) && rawData.includes(",")) {
      const commaIdx = rawData.indexOf(",");
      doc.data = rawData.slice(commaIdx + 1);
      if (!doc.mediaType) {
        const match = /^data:([^;,]+)/i.exec(rawData.slice(0, commaIdx));
        if (match?.[1]) doc.mediaType = match[1].trim().toLowerCase();
      }
    }
    doc.data = String(doc.data || "").replace(/\s/g, "");
  }

  const validDocs: PreparedEmbedDocument[] = [];
  const warnings: string[] = [];
  for (const doc of docArray) {
    const mime = String(doc.mediaType || "");
    const label = String(doc.label || "document");
    if (!mime || !isAllowedMimeType(mime)) {
      warnings.push(`${label}: Sadece PDF, JPG, JPEG ve PNG dosyaları yükleyebilirsiniz.`);
      continue;
    }
    const syntheticExt = isPdf(mime) ? ".pdf" : mime === "image/png" ? ".png" : ".jpg";
    const syntheticFileName = `document${syntheticExt}`;
    let buffer: Buffer;
    try {
      buffer = Buffer.from(doc.data || "", "base64");
    } catch {
      warnings.push(`${label}: Invalid base64 file data`);
      continue;
    }
    const intakeValidationError = validateStudentDocumentFile(label, syntheticFileName, mime, buffer.length);
    if (intakeValidationError) {
      warnings.push(`${label}: ${intakeValidationError.message}`);
      continue;
    }
    const validationError = await validateStudentDocumentBuffer(label, syntheticFileName, mime, buffer);
    if (validationError) {
      warnings.push(`${label}: ${validationError.message}`);
      continue;
    }
    try {
      const processed = await processUpload(buffer, syntheticFileName, mime);
      if (processed.meta.compressed) {
        doc.data = processed.buffer.toString("base64");
        doc.mediaType = processed.mime;
        doc.sizeBytes = processed.buffer.length;
      } else if (!doc.sizeBytes) {
        doc.sizeBytes = buffer.length;
      }
    } catch (err) {
      if (err instanceof UploadTooLargeError) {
        warnings.push(`${label}: ${err.message}`);
        continue;
      }
      console.error("[EMBED-APPLY] processUpload failed, keeping original:", err);
      if (!doc.sizeBytes) doc.sizeBytes = buffer.length;
    }
    validDocs.push({
      label,
      data: doc.data,
      mediaType: doc.mediaType,
      sizeBytes: Number(doc.sizeBytes) || buffer.length,
    });
  }

  const totalDocSize = validDocs.reduce((sum, doc) => sum + (doc.sizeBytes || 0), 0);
  if (totalDocSize > APPLICATION_DOCUMENT_MAX_SIZE * 4) {
    warnings.push("Documents too large. Maximum total size is 20 MB.");
    validDocs.length = 0;
  }

  return { validDocs, warnings, inputCount: docArray.length };
}

async function persistEmbedLeadDocuments(params: {
  leadId: number;
  firstName: string;
  lastName: string;
  documents: PreparedEmbedDocument[];
}): Promise<number> {
  let saved = 0;
  for (const doc of params.documents) {
    const docType = String(doc.label || "other").toLowerCase();
    const docName = buildDocNameFromParts(params.firstName, params.lastName, docType, doc.mediaType);
    const existing = await db.select({ id: documentsTable.id })
      .from(documentsTable)
      .where(and(
        eq(documentsTable.leadId, params.leadId),
        eq(documentsTable.type, docType),
        isNull(documentsTable.studentId),
        isNull(documentsTable.applicationId),
        isNull(documentsTable.deletedAt),
      ))
      .orderBy(desc(documentsTable.createdAt), desc(documentsTable.id));

    if (existing[0]) {
      await db.update(documentsTable).set({
        name: docName,
        status: "pending",
        fileKey: null,
        fileUrl: null,
        fileData: doc.data,
        mimeType: doc.mediaType || null,
        sizeBytes: doc.sizeBytes ? Number(doc.sizeBytes) : null,
        updatedAt: new Date(),
      }).where(eq(documentsTable.id, existing[0].id));
      if (existing.length > 1) {
        await db.update(documentsTable)
          .set({ deletedAt: new Date() })
          .where(inArray(documentsTable.id, existing.slice(1).map((row) => row.id)));
      }
    } else {
      await db.insert(documentsTable).values({
        leadId: params.leadId,
        name: docName,
        type: docType,
        status: "pending",
        fileData: doc.data,
        mimeType: doc.mediaType || null,
        sizeBytes: doc.sizeBytes ? Number(doc.sizeBytes) : null,
      });
    }
    saved += 1;
  }
  return saved;
}

async function readEmbedLeadDraftDocuments(params: {
  leadId: number;
  slug: string;
  email: string;
  requestedLabels: unknown;
}): Promise<PreparedEmbedDocument[] | null> {
  const normalizedEmail = params.email.toLowerCase().trim();
  const [lead] = await db.select({ id: leadsTable.id })
    .from(leadsTable)
    .where(and(
      eq(leadsTable.id, params.leadId),
      eq(leadsTable.source, `embed:${params.slug}`),
      sql`lower(trim(${leadsTable.email})) = ${normalizedEmail}`,
      isNull(leadsTable.deletedAt),
    ))
    .limit(1);
  if (!lead) return null;

  // The label manifest is deliberately small and contains no file bytes. It
  // ensures a file removed in the UI is not revived from an older draft row.
  const requestedTypes = normalizeEmbedDocumentManifest(params.requestedLabels);
  if (requestedTypes.length === 0) return [];

  const rows = await db.select({
    label: documentsTable.type,
    data: documentsTable.fileData,
    mediaType: documentsTable.mimeType,
    sizeBytes: documentsTable.sizeBytes,
  })
    .from(documentsTable)
    .where(and(
      eq(documentsTable.leadId, lead.id),
      inArray(documentsTable.type, requestedTypes),
      isNull(documentsTable.studentId),
      isNull(documentsTable.applicationId),
      isNull(documentsTable.deletedAt),
    ))
    .orderBy(desc(documentsTable.updatedAt), desc(documentsTable.id));

  const byType = new Map<string, PreparedEmbedDocument>();
  for (const row of rows) {
    const label = String(row.label || "").toLowerCase();
    const data = String(row.data || "").replace(/\s/g, "");
    const mediaType = String(row.mediaType || "").toLowerCase();
    if (!label || !requestedTypes.includes(label) || !data || !isAllowedMimeType(mediaType) || byType.has(label)) {
      continue;
    }
    byType.set(label, {
      label,
      data,
      mediaType,
      sizeBytes: row.sizeBytes ? Number(row.sizeBytes) : null,
    });
  }
  return requestedTypes
    .map((type) => byType.get(type))
    .filter((doc): doc is PreparedEmbedDocument => Boolean(doc));
}

const EMBED_TOKEN_WINDOW_MS = 15 * 60 * 1000;
const embedTokenLimiter = rateLimit({
  windowMs: EMBED_TOKEN_WINDOW_MS,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
  store: new PgRateLimitStore(EMBED_TOKEN_WINDOW_MS, "embed-token"),
  keyGenerator: (req) => getRateLimitIp(req),
});

/**
 * Set CORS headers for embed public routes.  CORS is defense-in-depth for
 * browser clients; the primary auth gate is the widget-key → HMAC token chain.
 *
 * When allowedDomains is empty the widget is unrestricted → wildcard CORS.
 * When non-empty we echo back the requesting Origin only if it matches an
 * allowed domain; unmatched origins get no CORS header (browser blocks them).
 * We always set Vary: Origin so CDN/proxy caches store per-origin responses.
 */
function setEmbedCors(res: any, widget: any, origin: string | undefined): void {
  const domains = widget.allowedDomains as string[];
  res.setHeader("Vary", "Origin");
  // The app-level public CORS middleware may already have reflected Origin.
  // Clear it before applying the widget-specific allow-list so a mismatch
  // cannot inherit a permissive header from an earlier middleware.
  res.removeHeader("Access-Control-Allow-Origin");
  if (!domains || domains.length === 0) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    return;
  }
  if (!origin) return;
  if (originMatchesAllowedDomains(origin, domains)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  // No match → no ACAO header → browser enforces CORS block.
}

function originMatchesAllowedDomains(origin: string | undefined, domains: string[]): boolean {
  if (!origin || !Array.isArray(domains) || domains.length === 0) return false;
  try {
    const originUrl = new URL(origin);
    const originHostname = originUrl.hostname.toLowerCase();
    const originHost = originUrl.host.toLowerCase();
    return domains.some((rawDomain) => {
      const value = String(rawDomain || "").trim().toLowerCase();
      if (!value) return false;
      let allowedHost = value;
      try {
        allowedHost = new URL(value.includes("://") ? value : `https://${value}`).host.toLowerCase();
      } catch {
        return false;
      }
      const hasPort = allowedHost.includes(":");
      const allowedHostname = hasPort ? allowedHost.slice(0, allowedHost.lastIndexOf(":")) : allowedHost;
      if (hasPort) return originHost === allowedHost;
      return originHostname === allowedHostname || originHostname.endsWith(`.${allowedHostname}`);
    });
  } catch {
    return false;
  }
}

function getBaseUrl(req: any): string {
  const proto = req.get("x-forwarded-proto") || req.protocol || "https";
  const host = req.get("x-forwarded-host") || req.get("host") || "";
  return `${proto}://${host}`;
}

const VALID_COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
const VALID_RADIUS_RE = /^\d{1,3}(px|rem|em|%)$/;
const VALID_FONT_RE = /^[a-zA-Z0-9\s,\-'"]+$/;
const CHAT_TEXT_MAX = 500;

function sanitizeChatText(value: unknown, max = CHAT_TEXT_MAX): string {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max)
    : "";
}

function sanitizePublicUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 1000) return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function publicUniversityLogoPath(universityId: unknown, storedLogo: unknown): string {
  const id = Number(universityId);
  if (!Number.isInteger(id) || id <= 0) return "";
  if (typeof storedLogo !== "string" || !storedLogo.trim()) return "";
  // Never expose stored data: URLs or arbitrary logo URLs in public embed
  // JSON. The dedicated logo endpoint validates/decodes the stored value and
  // serves it with nosniff + restrictive CSP headers.
  return `/api/universities/${id}/logo`;
}

function sanitizeTheme(theme: any): Record<string, string> {
  if (!theme || typeof theme !== "object") return {};
  const safe: Record<string, string> = {};
  if (theme.primaryColor && VALID_COLOR_RE.test(theme.primaryColor)) safe.primaryColor = theme.primaryColor;
  if (theme.secondaryColor && VALID_COLOR_RE.test(theme.secondaryColor)) safe.secondaryColor = theme.secondaryColor;
  if (theme.buttonColor && VALID_COLOR_RE.test(theme.buttonColor)) safe.buttonColor = theme.buttonColor;
  if (theme.borderRadius && VALID_RADIUS_RE.test(theme.borderRadius)) safe.borderRadius = theme.borderRadius;
  if (theme.fontFamily && VALID_FONT_RE.test(theme.fontFamily)) safe.fontFamily = theme.fontFamily;
  const logoUrl = sanitizePublicUrl(theme.logoUrl);
  if (logoUrl) safe.logoUrl = logoUrl;
  const welcomeMessage = sanitizeChatText(theme.welcomeMessage, 400);
  if (welcomeMessage) safe.welcomeMessage = welcomeMessage;
  const assistantName = sanitizeChatText(theme.assistantName, 160);
  if (assistantName) safe.assistantName = assistantName;
  return safe;
}

const VALID_MODES = ["combined", "course_finder", "application_only", "lead_form", "ai_chatbot"];

function sanitizeWidget(widget: Record<string, any>, userRole: string): Record<string, any> {
  if (ADMIN_ROLES.includes(userRole)) return widget;
  const { embedApiKey: _stripped, ...rest } = widget;
  return rest;
}

function normalizeAiConnectionKey(value: unknown): string | null {
  const key = String(value || "claude").trim().toLowerCase();
  return isAnthropicConnectionKey(key) ? key : null;
}

function normalizeAiExtractorId(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

class EmbedAutomationSelectionError extends Error {}

function normalizeOptionalPositiveId(value: unknown, field: string): number | null {
  if (value === null || value === "") return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new EmbedAutomationSelectionError(`Invalid ${field}`);
  }
  return id;
}

async function resolveEmbedAutomationSelection(
  rawAiBotId: unknown,
  rawCommunicationPipelineId: unknown,
  fallback: { aiBotId: number | null; communicationPipelineId: number | null },
): Promise<{ aiBotId: number | null; communicationPipelineId: number | null }> {
  const hasAiBotId = rawAiBotId !== undefined;
  const hasPipelineId = rawCommunicationPipelineId !== undefined;
  let aiBotId = hasAiBotId
    ? normalizeOptionalPositiveId(rawAiBotId, "AI bot")
    : fallback.aiBotId;
  const communicationPipelineId = hasPipelineId
    ? normalizeOptionalPositiveId(rawCommunicationPipelineId, "communication pipeline")
    : fallback.communicationPipelineId;

  let pipeline: { id: number; aiBotId: number | null } | undefined;
  if (communicationPipelineId != null) {
    [pipeline] = await db
      .select({
        id: communicationPipelinesTable.id,
        aiBotId: communicationPipelinesTable.aiBotId,
      })
      .from(communicationPipelinesTable)
      .where(and(
        eq(communicationPipelinesTable.id, communicationPipelineId),
        eq(communicationPipelinesTable.isActive, true),
      ))
      .limit(1);
    if (!pipeline) {
      throw new EmbedAutomationSelectionError("Active communication pipeline not found");
    }
    if (pipeline.aiBotId == null) {
      throw new EmbedAutomationSelectionError("Communication pipeline has no AI bot");
    }
    if (aiBotId == null) aiBotId = pipeline.aiBotId;
  }

  let resolvedAiBotId: number | null = null;
  if (aiBotId != null) {
    try {
      resolvedAiBotId = await requireAiBotId(aiBotId, { activeOnly: true });
    } catch {
      throw new EmbedAutomationSelectionError("Active AI bot not found");
    }
  }
  if (pipeline && pipeline.aiBotId !== resolvedAiBotId) {
    throw new EmbedAutomationSelectionError("Communication pipeline belongs to a different AI bot");
  }

  if (resolvedAiBotId != null) {
    const [activeBot] = await db
      .select({ id: aiBotsTable.id })
      .from(aiBotsTable)
      .where(and(eq(aiBotsTable.id, resolvedAiBotId), eq(aiBotsTable.isActive, true)))
      .limit(1);
    if (!activeBot) throw new EmbedAutomationSelectionError("Active AI bot not found");
  }

  return { aiBotId: resolvedAiBotId, communicationPipelineId };
}

async function resolveEmbedAgentId(rawAgentId: unknown, fallback: number | null): Promise<number | null> {
  const agentId = rawAgentId === undefined
    ? fallback
    : normalizeOptionalPositiveId(rawAgentId, "partner agent");
  if (agentId == null) return null;
  const [agent] = await db.select({ id: agentsTable.id }).from(agentsTable).where(and(
    eq(agentsTable.id, agentId),
    eq(agentsTable.status, "active"),
    isNull(agentsTable.deletedAt),
  )).limit(1);
  if (!agent) throw new EmbedAutomationSelectionError("Active partner agent not found");
  return agent.id;
}

async function widgetPartnerExtras(agentId: number | null | undefined) {
  if (!agentId) return undefined;
  const [agent] = await db.select({
    id: agentsTable.id,
    parentAgentId: agentsTable.parentAgentId,
    firstName: agentsTable.firstName,
    lastName: agentsTable.lastName,
    companyName: agentsTable.companyName,
  }).from(agentsTable).where(and(eq(agentsTable.id, agentId), isNull(agentsTable.deletedAt))).limit(1);
  if (!agent) return undefined;
  const originType = agent.parentAgentId ? "sub_agent" : "agent";
  return {
    agentId: agent.id,
    originType,
    originEntityType: originType,
    originEntityId: agent.id,
    originDisplayName: agent.companyName || `${agent.firstName} ${agent.lastName}`.trim(),
  };
}

router.get("/embed/widgets", requireAuth, requireRole(...STAFF_ROLES), async (req, res): Promise<void> => {
  const {
    page = "1",
    limit = "20",
    search = "",
    mode = "all",
    status = "all",
    sortBy = "createdAt",
    sortDir = "desc",
  } = req.query as Record<string, string>;
  const pageNum = Math.max(1, parseInt(page, 10));
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
  const offset = (pageNum - 1) * limitNum;
  const conditions: any[] = [];

  const cleanSearch = search.trim().slice(0, 120);
  if (cleanSearch) {
    const pattern = `%${cleanSearch}%`;
    conditions.push(or(
      ilike(embedWidgetsTable.name, pattern),
      ilike(embedWidgetsTable.slug, pattern),
      sql`${embedWidgetsTable.allowedDomains}::text ILIKE ${pattern}`,
    ));
  }
  if (mode !== "all" && VALID_MODES.includes(mode)) {
    conditions.push(eq(embedWidgetsTable.mode, mode));
  }
  if (status === "active") conditions.push(eq(embedWidgetsTable.isActive, true));
  if (status === "inactive") conditions.push(eq(embedWidgetsTable.isActive, false));

  const whereClause = conditions.length ? and(...conditions) : undefined;
  const sortColumn = sortBy === "name" ? embedWidgetsTable.name : embedWidgetsTable.createdAt;
  const orderBy = sortDir === "asc" ? asc(sortColumn) : desc(sortColumn);

  const [{ count }] = await db.select({ count: sql<number>`count(*)` })
    .from(embedWidgetsTable)
    .where(whereClause);
  const rows = await db.select()
    .from(embedWidgetsTable)
    .where(whereClause)
    .orderBy(orderBy)
    .limit(limitNum)
    .offset(offset);
  const role = req.user!.role;
  res.json({ data: rows.map(w => sanitizeWidget(w, role)), meta: { total: Number(count), page: pageNum, limit: limitNum, totalPages: Math.ceil(Number(count) / limitNum) } });
});

// Secret-free choices for the widget editor. API keys remain inside the
// integrations table and are never serialized to the browser.
router.get("/embed/widgets/ai-options", requireAuth, requireRole(...ADMIN_ROLES), async (_req, res): Promise<void> => {
  const [integrations, extractors] = await Promise.all([
    db.select({
      key: integrationsTable.key,
      name: integrationsTable.name,
      isEnabled: integrationsTable.isEnabled,
    }).from(integrationsTable),
    db.select({
      id: aiExtractorsTable.id,
      name: aiExtractorsTable.name,
      scopes: aiExtractorsTable.scopes,
      isActive: aiExtractorsTable.isActive,
    }).from(aiExtractorsTable),
  ]);
  const connections = integrations
    .filter((row) => row.isEnabled && (row.key === "claude" || row.key.startsWith("claude:") || row.key.startsWith("anthropic:")))
    .map(({ key, name }) => ({ key, name }));
  if (!connections.some((row) => row.key === "claude")) {
    connections.unshift({ key: "claude", name: "Default Claude connection" });
  }
  res.json({
    connections,
    extractors: extractors
      .filter((row) => row.isActive && Array.isArray(row.scopes) && (row.scopes as string[]).includes("embed"))
      .map(({ id, name }) => ({ id, name })),
  });
});

// Non-numeric ids fall through to sibling string paths like
// `/embed/widgets/template` and `/embed/widgets/export` instead of
// failing with a misleading "Invalid ID" 400.
router.get("/embed/widgets/:id", requireAuth, requireRole(...STAFF_ROLES), async (req, res, next): Promise<void> => {
  if (!/^\d+$/.test(String(req.params.id))) { next(); return; }
  const id = parseInt(String(req.params.id), 10);
  const [widget] = await db.select().from(embedWidgetsTable).where(eq(embedWidgetsTable.id, id));
  if (!widget) { res.status(404).json({ error: "Widget not found" }); return; }
  res.json(sanitizeWidget(widget, req.user!.role));
});

router.get("/embed/widgets/partner-options", requireAuth, requireRole(...ADMIN_ROLES), async (_req, res): Promise<void> => {
  const rows = await db.select({
    id: agentsTable.id,
    parentAgentId: agentsTable.parentAgentId,
    firstName: agentsTable.firstName,
    lastName: agentsTable.lastName,
    companyName: agentsTable.companyName,
    businessName: agentsTable.businessName,
  }).from(agentsTable).where(and(
    eq(agentsTable.status, "active"),
    isNull(agentsTable.deletedAt),
  )).orderBy(asc(agentsTable.parentAgentId), asc(agentsTable.companyName), asc(agentsTable.firstName));
  const names = new Map(rows.map(row => [
    row.id,
    row.companyName || row.businessName || `${row.firstName} ${row.lastName}`.trim(),
  ]));
  res.json({
    agents: rows.map(row => ({
      id: row.id,
      parentAgentId: row.parentAgentId,
      name: names.get(row.id),
      parentName: row.parentAgentId ? names.get(row.parentAgentId) || null : null,
      type: row.parentAgentId ? "sub_agent" : "agent",
    })),
  });
});

router.post("/embed/widgets", requireAuth, requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const { name, slug, mode, presetFilters, lockedFilters, hiddenFilters, visibleFilters, theme, allowedDomains, aiConnectionKey, aiExtractorId, aiBotId, communicationPipelineId, agentId } = req.body;
  if (!name || !slug) { res.status(400).json({ error: "name and slug are required" }); return; }
  const validMode = VALID_MODES.includes(mode) ? mode : "combined";
  if (!isValidEmbedUniversityScope(presetFilters)) {
    res.status(400).json({ error: "Selected university scope requires at least one university." });
    return;
  }
  const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
  const cleanAiConnectionKey = normalizeAiConnectionKey(aiConnectionKey);
  if (!cleanAiConnectionKey) { res.status(400).json({ error: "Invalid AI connection key" }); return; }
  const cleanAiExtractorId = normalizeAiExtractorId(aiExtractorId);
  if (aiExtractorId != null && aiExtractorId !== "" && !cleanAiExtractorId) {
    res.status(400).json({ error: "Invalid AI extractor" });
    return;
  }
  try {
    const automationSelection = await resolveEmbedAutomationSelection(
      aiBotId,
      communicationPipelineId,
      { aiBotId: null, communicationPipelineId: null },
    );
    const resolvedAgentId = await resolveEmbedAgentId(agentId, null);
    const isRestricted = Array.isArray(allowedDomains) && allowedDomains.length > 0;
    const [widget] = await db.insert(embedWidgetsTable).values({
      name,
      slug: cleanSlug,
      mode: validMode,
      presetFilters: presetFilters || {},
      lockedFilters: lockedFilters || [],
      hiddenFilters: hiddenFilters || [],
      visibleFilters: visibleFilters || [],
      theme: validMode === "ai_chatbot" ? sanitizeTheme(theme) : (theme || {}),
      allowedDomains: allowedDomains || [],
      aiConnectionKey: cleanAiConnectionKey,
      aiExtractorId: cleanAiExtractorId,
      aiBotId: automationSelection.aiBotId,
      communicationPipelineId: automationSelection.communicationPipelineId,
      agentId: resolvedAgentId,
      // Auto-generate an API key for restricted widgets so it's ready immediately.
      // Open widgets (no allowedDomains) don't need one.
      embedApiKey: isRestricted ? generateWidgetApiKey() : null,
    }).returning();
    await logAudit(req.user!.id, "create_embed_widget", "embed_widget", widget.id, { name, slug: cleanSlug }, req.ip);
    res.status(201).json(sanitizeWidget(widget, req.user!.role));
  } catch (err: any) {
    // Postgres unique-violation SQLSTATE is 23505. We previously matched on
    // `err.message.includes("duplicate")`, which only worked under the
    // English locale postgres uses in dev — production server returned a
    // localized/wrapped message and the check missed, surfacing as 500.
    // Match by SQLSTATE for a locale-independent detection.
    if (err instanceof EmbedAutomationSelectionError) {
      res.status(400).json({ error: err.message });
    } else if (err?.code === "23505" || err?.cause?.code === "23505" || err?.message?.includes("duplicate") || err?.message?.includes("unique")) {
      res.status(409).json({ error: "A widget with this slug already exists" });
    } else {
      throw err;
    }
  }
});

router.patch("/embed/widgets/:id", requireAuth, requireRole(...ADMIN_ROLES), async (req, res, next): Promise<void> => {
  if (!/^\d+$/.test(String(req.params.id))) { next(); return; }
  const id = parseInt(String(req.params.id), 10);
  const { name, slug, mode, presetFilters, lockedFilters, hiddenFilters, visibleFilters, theme, allowedDomains, isActive, aiConnectionKey, aiExtractorId, aiBotId, communicationPipelineId, agentId } = req.body;
  const [current] = await db
    .select()
    .from(embedWidgetsTable)
    .where(eq(embedWidgetsTable.id, id))
    .limit(1);
  if (!current) { res.status(404).json({ error: "Widget not found" }); return; }
  const effectiveMode = mode !== undefined
    ? (VALID_MODES.includes(mode) ? mode : "combined")
    : current.mode;
  const effectivePresetFilters = presetFilters !== undefined
    ? presetFilters
    : current.presetFilters;
  if (!isValidEmbedUniversityScope(effectivePresetFilters)) {
    res.status(400).json({ error: "Selected university scope requires at least one university." });
    return;
  }
  const updates: any = {};
  if (name !== undefined) updates.name = name;
  if (slug !== undefined) updates.slug = slug.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
  if (mode !== undefined) updates.mode = effectiveMode;
  if (presetFilters !== undefined) updates.presetFilters = presetFilters;
  if (lockedFilters !== undefined) updates.lockedFilters = lockedFilters;
  if (hiddenFilters !== undefined) updates.hiddenFilters = hiddenFilters;
  if (visibleFilters !== undefined) updates.visibleFilters = visibleFilters;
  if (theme !== undefined) updates.theme = effectiveMode === "ai_chatbot" ? sanitizeTheme(theme) : theme;
  if (allowedDomains !== undefined) updates.allowedDomains = allowedDomains;
  if (isActive !== undefined) updates.isActive = isActive;
  if (aiConnectionKey !== undefined) {
    const cleanAiConnectionKey = normalizeAiConnectionKey(aiConnectionKey);
    if (!cleanAiConnectionKey) { res.status(400).json({ error: "Invalid AI connection key" }); return; }
    updates.aiConnectionKey = cleanAiConnectionKey;
  }
  if (aiExtractorId !== undefined) {
    const cleanAiExtractorId = normalizeAiExtractorId(aiExtractorId);
    if (aiExtractorId !== null && aiExtractorId !== "" && !cleanAiExtractorId) {
      res.status(400).json({ error: "Invalid AI extractor" });
      return;
    }
    updates.aiExtractorId = cleanAiExtractorId;
  }

  // If the widget is being made restricted and doesn't yet have an API key,
  // generate one automatically.
  if (allowedDomains !== undefined && Array.isArray(allowedDomains) && allowedDomains.length > 0) {
    if (!current.embedApiKey) {
      updates.embedApiKey = generateWidgetApiKey();
    }
  }

  try {
    if (aiBotId !== undefined || communicationPipelineId !== undefined) {
      const automationSelection = await resolveEmbedAutomationSelection(
        aiBotId,
        communicationPipelineId,
        {
          aiBotId: current.aiBotId,
          communicationPipelineId: current.communicationPipelineId,
        },
      );
      updates.aiBotId = automationSelection.aiBotId;
      updates.communicationPipelineId = automationSelection.communicationPipelineId;
    }
    if (agentId !== undefined) {
      updates.agentId = await resolveEmbedAgentId(agentId, current.agentId);
    }
    const [widget] = await db.update(embedWidgetsTable).set(updates).where(eq(embedWidgetsTable.id, id)).returning();
    if (!widget) { res.status(404).json({ error: "Widget not found" }); return; }
    await logAudit(req.user!.id, "update_embed_widget", "embed_widget", id, updates, req.ip);
    res.json(sanitizeWidget(widget, req.user!.role));
  } catch (err: any) {
    if (err instanceof EmbedAutomationSelectionError) {
      res.status(400).json({ error: err.message });
    } else if (err?.code === "23505" || err?.cause?.code === "23505" || err?.message?.includes("duplicate") || err?.message?.includes("unique")) {
      res.status(409).json({ error: "A widget with this slug already exists" });
    } else {
      throw err;
    }
  }
});

// --- Export / Import (Task #202) ---------------------------------------
// Lossless Excel (.xlsx) round-trip for embed widget configurations.
// Admin-only. Volatile fields (id, createdAt, updatedAt) and runtime
// relationships (submissions) are stripped on export; slugs are preserved
// as the cross-installation identifier. A separate /template endpoint
// hands back an empty workbook with dropdowns pre-filled from the current
// system state so admins never have to guess the allowed strings.

function normalizeEmbedSlug(slug: string): string {
  return String(slug).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

// Admin-only: export/import are configuration-mutating operations and must
// not be exposed to consultant/editor/accountant staff. Matches the
// `adminOnly` gate used in src/routes/website.ts.
const EMBED_ADMIN_ROLES = ["super_admin", "admin"] as const;

function embedExportRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.map((r) => ({
    name: r.name, slug: r.slug, mode: r.mode, isActive: r.isActive,
    theme: r.theme, presetFilters: r.presetFilters,
    lockedFilters: r.lockedFilters, hiddenFilters: r.hiddenFilters,
    visibleFilters: r.visibleFilters, allowedDomains: r.allowedDomains,
    aiConnectionKey: r.aiConnectionKey, aiExtractorId: r.aiExtractorId,
  }));
}

// Snapshot of valid filter values pulled from the live DB. Every value
// reflects current state (universities, programs) so adding a new
// country/level/language anywhere in the system shows up on the next
// downloaded template without any code change.
async function loadEmbedFilterCatalog(): Promise<EmbedFilterCatalog> {
  const [countriesRows, citiesRows, typesRows, levelsRows, languagesRows, sampleUnis] = await Promise.all([
    db.selectDistinct({ v: universitiesTable.country })
      .from(universitiesTable)
      .where(and(eq(universitiesTable.isActive, true), isNotNull(universitiesTable.country)))
      .orderBy(universitiesTable.country),
    db.selectDistinct({ v: universitiesTable.city })
      .from(universitiesTable)
      .where(and(eq(universitiesTable.isActive, true), isNotNull(universitiesTable.city)))
      .orderBy(universitiesTable.city),
    db.selectDistinct({ v: universitiesTable.universityType })
      .from(universitiesTable)
      .where(and(eq(universitiesTable.isActive, true), isNotNull(universitiesTable.universityType)))
      .orderBy(universitiesTable.universityType),
    db.selectDistinct({ v: programsTable.degree })
      .from(programsTable)
      .where(and(eq(programsTable.isActive, true), isNotNull(programsTable.degree)))
      .orderBy(programsTable.degree),
    db.selectDistinct({ v: programsTable.language })
      .from(programsTable)
      .where(and(eq(programsTable.isActive, true), isNotNull(programsTable.language)))
      .orderBy(programsTable.language),
    db.select({
        id: universitiesTable.id,
        name: universitiesTable.name,
        country: universitiesTable.country,
        city: universitiesTable.city,
        type: universitiesTable.universityType,
      })
      .from(universitiesTable)
      .where(eq(universitiesTable.isActive, true))
      .orderBy(universitiesTable.name),
  ]);
  const clean = (rows: Array<{ v: string | null }>): string[] =>
    Array.from(new Set(rows.map((r) => (r.v ?? "").trim()).filter(Boolean))).sort();
  return {
    countries: clean(countriesRows),
    cities: clean(citiesRows),
    universityTypes: clean(typesRows),
    levels: clean(levelsRows),
    languages: clean(languagesRows),
    universities: sampleUnis,
  };
}

router.post("/embed/widgets/export", requireAuth, requireRole(...EMBED_ADMIN_ROLES), json({ limit: "64kb" }), async (req, res): Promise<void> => {
  const { ids } = (req.body || {}) as { ids?: unknown };
  let rows;
  if (Array.isArray(ids) && ids.length > 0) {
    const numericIds = ids.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0);
    if (numericIds.length === 0) { res.status(400).json({ error: "ids must be a non-empty array of positive integers" }); return; }
    rows = await db.select().from(embedWidgetsTable).where(inArray(embedWidgetsTable.id, numericIds)).orderBy(embedWidgetsTable.name);
  } else {
    rows = await db.select().from(embedWidgetsTable).orderBy(embedWidgetsTable.name);
  }
  const catalog = await loadEmbedFilterCatalog();
  const columns = embedWidgetColumns(VALID_MODES, catalog);
  const buf = await buildWorkbookBuffer({
    sheets: [
      { name: "Widgets", columns, rows: embedExportRows(rows as Array<Record<string, unknown>>) },
      ...buildEmbedFilterReferenceSheets(catalog),
    ],
    meta: { kind: EMBED_KIND, version: "1", exportedAt: new Date().toISOString() },
  });
  await logAudit(req.user!.id, "export_embed_widgets", "embed_widget", undefined, { count: rows.length }, req.ip);
  res.setHeader("Content-Type", XLSX_CONTENT_TYPE);
  res.setHeader("Content-Disposition", `attachment; filename="embed-widgets-${new Date().toISOString().slice(0,10)}.xlsx"`);
  res.send(buf);
});

router.get("/embed/widgets/template", requireAuth, requireRole(...EMBED_ADMIN_ROLES), async (req, res): Promise<void> => {
  const catalog = await loadEmbedFilterCatalog();
  const columns = embedWidgetColumns(VALID_MODES, catalog);
  // Several diverse example rows pre-filled from the LIVE catalog so admins
  // immediately see the shape of each filter combination. Every row is
  // plainly marked "EXAMPLE …" — admins delete or edit them before import.
  const slugSuffix = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const pick = <T,>(arr: readonly T[], i: number): T | undefined => arr[i] ?? arr[0];

  type ExampleSpec = {
    suffix: string;
    label: string;
    mode: string;
    theme: Record<string, unknown>;
    presetFilters: Record<string, unknown>;
    lockedFilters: string[];
    hiddenFilters: string[];
    visibleFilters: string[];
    allowedDomains: string[];
  };

  const specs: ExampleSpec[] = [
    {
      suffix: "combined",
      label: "Combined widget — all modes, country preset",
      mode: "combined",
      theme: { primary: "#0ea5e9", radius: "8px" },
      presetFilters: {
        ...(pick(catalog.countries, 0) ? { country: pick(catalog.countries, 0) } : {}),
      },
      lockedFilters: pick(catalog.countries, 0) ? ["country"] : [],
      hiddenFilters: [],
      visibleFilters: ["country", "city", "universityType", "level", "language"],
      allowedDomains: ["example.com"],
    },
    {
      suffix: "course-finder",
      label: "Course finder — level + language preset",
      mode: "course_finder",
      theme: { primary: "#10b981", radius: "12px" },
      presetFilters: {
        ...(pick(catalog.levels, 0) ? { level: pick(catalog.levels, 0) } : {}),
        ...(pick(catalog.languages, 0) ? { language: pick(catalog.languages, 0) } : {}),
      },
      lockedFilters: [],
      hiddenFilters: ["universityType"],
      visibleFilters: ["country", "city", "level", "language"],
      allowedDomains: ["example.com", "partner.example.com"],
    },
    {
      suffix: "application-only",
      label: "Application only — pinned to one university",
      mode: "application_only",
      theme: { primary: "#f59e0b", radius: "6px" },
      presetFilters: {
        ...(catalog.universities[0] ? { universityId: catalog.universities[0].id } : {}),
      },
      lockedFilters: catalog.universities[0] ? ["universityId"] : [],
      hiddenFilters: ["country", "city", "universityType", "level", "language"],
      visibleFilters: [],
      allowedDomains: [catalog.universities[0]?.name ? "your-university.com" : "example.com"],
    },
    {
      suffix: "lead-form",
      label: "Lead form — city + university type preset",
      mode: "lead_form",
      theme: { primary: "#8b5cf6", radius: "10px" },
      presetFilters: {
        ...(pick(catalog.cities, 0) ? { city: pick(catalog.cities, 0) } : {}),
        ...(pick(catalog.universityTypes, 0) ? { universityType: pick(catalog.universityTypes, 0) } : {}),
      },
      lockedFilters: [],
      hiddenFilters: [],
      visibleFilters: ["country", "city", "universityType", "level"],
      allowedDomains: ["example.com"],
    },
  ];

  const exampleRows = specs
    .filter((s) => VALID_MODES.includes(s.mode))
    .map((s) => ({
      name: `EXAMPLE — ${s.label} (delete or edit me)`,
      slug: `example-${s.suffix}-${slugSuffix}`,
      mode: s.mode,
      isActive: false,
      theme: s.theme,
      presetFilters: s.presetFilters,
      lockedFilters: s.lockedFilters,
      hiddenFilters: s.hiddenFilters,
      visibleFilters: s.visibleFilters,
      allowedDomains: s.allowedDomains,
    }));

  const buf = await buildWorkbookBuffer({
    sheets: [
      { name: "Widgets", columns, rows: exampleRows as Array<Record<string, unknown>> },
      ...buildEmbedFilterReferenceSheets(catalog),
    ],
    meta: { kind: EMBED_KIND, version: "1", exportedAt: new Date().toISOString() },
  });
  res.setHeader("Content-Type", XLSX_CONTENT_TYPE);
  res.setHeader("Content-Disposition", `attachment; filename="embed-widgets-template.xlsx"`);
  res.send(buf);
});

router.post(
  "/embed/widgets/import",
  requireAuth,
  requireRole(...EMBED_ADMIN_ROLES),
  express.raw({ type: XLSX_CONTENT_TYPE, limit: "2mb" }),
  async (req, res): Promise<void> => {
    const conflict: ConflictStrategy = isValidConflictStrategy(req.query.conflict) ? req.query.conflict : "skip";
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: "Upload an .xlsx file with Content-Type " + XLSX_CONTENT_TYPE });
      return;
    }
    const columns = embedWidgetColumns(VALID_MODES);
    let parsed;
    try {
      parsed = await parseWorkbookBuffer(req.body, { expectedKind: EMBED_KIND }, { Widgets: columns });
    } catch (err) {
      const e = err as ImportValidationError;
      res.status(e.status || 400).json({ error: e.message });
      return;
    }
    const rawItems = parsed.sheets.get("Widgets")?.rows ?? [];
    const summary = emptySummary(rawItems.length);

    for (let i = 0; i < rawItems.length; i++) {
      const item = rawItems[i];
      try {
        if (!item.name || typeof item.name !== "string") throw new Error("Name is required");
        if (!item.slug || typeof item.slug !== "string") throw new Error("Slug is required");
        const slug = normalizeEmbedSlug(item.slug);
        if (!slug) throw new Error("Slug is invalid");
        const insertValues = { ...toEmbedInsertValues(item, VALID_MODES), slug };

        const [existing] = await db.select().from(embedWidgetsTable).where(eq(embedWidgetsTable.slug, slug));
        if (existing) {
          if (conflict === "skip") {
            tallyResult(summary, { index: i, slug, status: "skipped" });
            continue;
          }
          if (conflict === "overwrite") {
            const [updated] = await db.update(embedWidgetsTable).set(insertValues).where(eq(embedWidgetsTable.id, existing.id)).returning();
            tallyResult(summary, { index: i, slug: updated.slug, status: "updated" });
            continue;
          }
          const newSlug = await nextAvailableSlug(slug, async (cand) => {
            const [hit] = await db.select({ id: embedWidgetsTable.id }).from(embedWidgetsTable).where(eq(embedWidgetsTable.slug, cand));
            return !!hit;
          });
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const [created] = await db.insert(embedWidgetsTable).values({ ...insertValues, slug: newSlug } as any).returning();
          tallyResult(summary, { index: i, slug, status: "renamed", finalSlug: created.slug });
          continue;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const [created] = await db.insert(embedWidgetsTable).values(insertValues as any).returning();
        tallyResult(summary, { index: i, slug: created.slug, status: "created" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        tallyResult(summary, { index: i, slug: typeof item.slug === "string" ? item.slug : null, status: "error", error: msg });
      }
    }

    await logAudit(req.user!.id, "import_embed_widgets", "embed_widget", undefined, {
      total: summary.total, created: summary.created, updated: summary.updated,
      renamed: summary.renamed, skipped: summary.skipped, errors: summary.errors, conflict,
    }, req.ip);
    res.json(summary);
  },
);

router.delete("/embed/widgets/:id", requireAuth, requireRole(...ADMIN_ROLES), async (req, res, next): Promise<void> => {
  if (!/^\d+$/.test(String(req.params.id))) { next(); return; }
  const id = parseInt(String(req.params.id), 10);
  await db.delete(embedWidgetsTable).where(eq(embedWidgetsTable.id, id));
  await logAudit(req.user!.id, "delete_embed_widget", "embed_widget", id, {}, req.ip);
  res.sendStatus(204);
});

// ─── Widget API key rotation (admin-authenticated) ────────────────────────────
// Partners hold the embedApiKey on their backend server — it is NEVER placed
// in HTML.  Use this endpoint to issue a new key when a key may be compromised.
// The old key is immediately invalidated.
router.post("/embed/widgets/:id/rotate-key", requireAuth, requireRole(...ADMIN_ROLES), async (req, res, next): Promise<void> => {
  if (!/^\d+$/.test(String(req.params.id))) { next(); return; }
  const id = parseInt(String(req.params.id), 10);
  const [widget] = await db.select().from(embedWidgetsTable).where(eq(embedWidgetsTable.id, id));
  if (!widget) { res.status(404).json({ error: "Widget not found" }); return; }

  const domains = widget.allowedDomains as string[];
  if (!Array.isArray(domains) || domains.length === 0) {
    res.status(400).json({ error: "Widget is not restricted — only restricted widgets (those with allowedDomains set) use API keys" });
    return;
  }

  const newKey = generateWidgetApiKey();
  const [updated] = await db.update(embedWidgetsTable)
    .set({ embedApiKey: newKey })
    .where(eq(embedWidgetsTable.id, id))
    .returning();
  await logAudit(req.user!.id, "rotate_embed_widget_api_key", "embed_widget", id, {}, req.ip);
  res.json({ embedApiKey: updated.embedApiKey });
});

router.get("/embed/widgets/:id/submissions", requireAuth, requireRole(...STAFF_ROLES), async (req, res, next): Promise<void> => {
  if (!/^\d+$/.test(String(req.params.id))) { next(); return; }
  const widgetId = parseInt(String(req.params.id), 10);
  const { page = "1", limit = "20" } = req.query as Record<string, string>;
  const pageNum = Math.max(1, parseInt(page, 10));
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
  const offset = (pageNum - 1) * limitNum;

  const conditions = [eq(embedSubmissionsTable.widgetId, widgetId)];
  const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(embedSubmissionsTable).where(and(...conditions));
  const rows = await db.select().from(embedSubmissionsTable).where(and(...conditions)).orderBy(desc(embedSubmissionsTable.createdAt)).limit(limitNum).offset(offset);

  res.json({ data: rows, meta: { total: Number(count), page: pageNum, limit: limitNum, totalPages: Math.ceil(Number(count) / limitNum) } });
});

router.get("/embed/submissions", requireAuth, requireRole(...STAFF_ROLES), async (req, res): Promise<void> => {
  const { page = "1", limit = "20", widgetId } = req.query as Record<string, string>;
  const pageNum = Math.max(1, parseInt(page, 10));
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
  const offset = (pageNum - 1) * limitNum;

  const conditions: any[] = [];
  if (widgetId) conditions.push(eq(embedSubmissionsTable.widgetId, parseInt(widgetId, 10)));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(embedSubmissionsTable).where(where);
  const rows = await db.select().from(embedSubmissionsTable).where(where).orderBy(desc(embedSubmissionsTable.createdAt)).limit(limitNum).offset(offset);

  res.json({ data: rows, meta: { total: Number(count), page: pageNum, limit: limitNum, totalPages: Math.ceil(Number(count) / limitNum) } });
});

// ─── Session token issuance endpoint ─────────────────────────────────────────
// Issues short-lived HMAC session tokens that gate all restricted widget JSON
// endpoints.  Security model:
//
// - Open widgets (empty allowedDomains): issue freely — no key required.
//
// - Restricted widgets: require X-Widget-Api-Key header matching the widget's
//   stored embedApiKey.  This call is made by the PARTNER'S BACKEND server
//   (server-to-server) — the secret never appears in browser HTML or embed code.
//   Partners expose their own endpoint that calls here and returns the session
//   token; the embed loader reads that URL from data-edcons-token-url.
//
//   Defense-in-depth: if req.headers.origin is present AND not in allowedDomains,
//   the request is rejected even with a valid key, blocking browsers that somehow
//   reach /token directly from an unauthorized domain.
//
// CORS: open-to-all on /token (the API key is the auth gate, not CORS).
router.get("/public/embed/:slug/token", embedTokenLimiter, async (req, res): Promise<void> => {
  const slug = String(req.params.slug);
  const [widget] = await db.select().from(embedWidgetsTable).where(and(eq(embedWidgetsTable.slug, slug), eq(embedWidgetsTable.isActive, true)));
  if (!widget) { res.status(404).json({ error: "Widget not found" }); return; }

  const domains = widget.allowedDomains as string[];
  const isRestricted = Array.isArray(domains) && domains.length > 0;

  if (isRestricted) {
    const providedKey = req.headers["x-widget-api-key"] as string | undefined;
    const storedKey = widget.embedApiKey;
    if (!providedKey || !storedKey) {
      res.status(403).json({ error: "X-Widget-Api-Key header required for restricted widgets" });
      return;
    }
    let keyMatch = false;
    try {
      const provided = Buffer.from(providedKey);
      const stored = Buffer.from(storedKey);
      keyMatch = provided.length === stored.length && crypto.timingSafeEqual(provided, stored);
    } catch { keyMatch = false; }
    if (!keyMatch) {
      res.status(403).json({ error: "Invalid widget API key" });
      return;
    }
    // Defense-in-depth: if Origin header is present it must be in allowedDomains.
    // Legitimate server-to-server calls from partner backends do not send Origin.
    const requestOrigin = req.headers.origin as string | undefined;
    if (requestOrigin && !originMatchesAllowedDomains(requestOrigin, domains)) {
      res.status(403).json({ error: "Origin not in widget's allowedDomains" });
      return;
    }
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  let token: string;
  try {
    token = createEmbedToken(String(widget.slug));
  } catch (err: any) {
    console.error("[EMBED] Token issuance failed — SESSION_SECRET not configured:", err.message);
    res.status(500).json({ error: "Embed security not configured on this server" });
    return;
  }
  res.json({ token, expiresIn: Math.floor(EMBED_TOKEN_TTL_MS / 1000) });
});

// Self-service agency widgets use a browser-origin exchange so the copied
// snippet works without asking an agency to build a backend token relay. This
// endpoint is deliberately limited to widgets owned by an agent. Restricted
// widgets only receive a token when the browser Origin matches allowedDomains;
// unrestricted agency widgets remain open, matching the standard embed model.
router.get("/public/embed/:slug/agent-token", embedTokenLimiter, async (req, res): Promise<void> => {
  const slug = String(req.params.slug);
  const [widget] = await db.select().from(embedWidgetsTable).where(and(
    eq(embedWidgetsTable.slug, slug),
    eq(embedWidgetsTable.isActive, true),
  ));
  if (!widget || !widget.agentId) {
    res.status(404).json({ error: "Agency widget not found" });
    return;
  }

  const domains = widget.allowedDomains as string[];
  const origin = req.headers.origin as string | undefined;
  if (Array.isArray(domains) && domains.length > 0 && !originMatchesAllowedDomains(origin, domains)) {
    res.status(403).json({ error: "Origin not in widget's allowedDomains" });
    return;
  }
  setEmbedCors(res, widget, origin);

  try {
    const token = createEmbedToken(String(widget.slug));
    res.json({ token, expiresIn: Math.floor(EMBED_TOKEN_TTL_MS / 1000) });
  } catch (err: any) {
    console.error("[AGENT EMBED] Token issuance failed:", err.message);
    res.status(500).json({ error: "Embed security not configured on this server" });
  }
});

router.get("/public/embed/:slug/config", async (req, res): Promise<void> => {
  const slug = String(req.params.slug);
  const [widget] = await db.select().from(embedWidgetsTable).where(and(eq(embedWidgetsTable.slug, slug), eq(embedWidgetsTable.isActive, true)));
  if (!widget) { res.status(404).json({ error: "Widget not found" }); return; }

  const origin = req.headers.origin as string | undefined;
  if (!checkEmbedAccess(widget, req.query.t as string | undefined)) {
    res.status(403).json({ error: "Invalid or expired embed token" });
    return;
  }
  setEmbedCors(res, widget, origin);

  res.json({
    id: widget.id,
    name: widget.name,
    slug: widget.slug,
    mode: widget.mode,
    presetFilters: widget.presetFilters,
    lockedFilters: widget.lockedFilters,
    hiddenFilters: widget.hiddenFilters,
    visibleFilters: widget.visibleFilters,
    theme: widget.theme,
  });
});

router.get("/public/embed/:slug/programs", async (req, res): Promise<void> => {
  const slug = String(req.params.slug);
  const [widget] = await db.select().from(embedWidgetsTable).where(and(eq(embedWidgetsTable.slug, slug), eq(embedWidgetsTable.isActive, true)));
  if (!widget) { res.status(404).json({ error: "Widget not found" }); return; }

  const origin = req.headers.origin as string | undefined;
  if (!checkEmbedAccess(widget, req.query.t as string | undefined)) {
    res.status(403).json({ error: "Invalid or expired embed token" });
    return;
  }
  setEmbedCors(res, widget, origin);

  const presetFilters = (widget.presetFilters || {}) as Record<string, any>;
  const lockedFilters = (widget.lockedFilters || []) as string[];
  const { country, city, universityType, universityId, level, language, field, search, feeMin, feeMax, page = "1", limit = "24" } = req.query as Record<string, string>;

  const pageNum = Math.max(1, parseInt(page, 10));
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
  const offset = (pageNum - 1) * limitNum;

  const conditions = [eq(programsTable.isActive, true)];
  const universityScope = resolveEmbedUniversityScope(presetFilters);

  function applyFilter(filterKey: string, userValue: string | undefined, applyFn: (val: string) => void) {
    const preset = presetFilters[filterKey];
    if (preset) {
      applyFn(String(preset));
    } else if (userValue && !lockedFilters.includes(filterKey)) {
      applyFn(userValue);
    }
  }

  applyFilter("country", country, v => conditions.push(eq(universitiesTable.country, v)));
  applyFilter("city", city, v => conditions.push(eq(universitiesTable.city, v)));
  applyFilter("universityType", universityType, v => conditions.push(eq(universitiesTable.universityType, v)));
  if (universityScope.mode === "selected") {
    if (universityScope.universityIds.length === 1) {
      conditions.push(eq(programsTable.universityId, universityScope.universityIds[0]));
    } else {
      conditions.push(inArray(programsTable.universityId, universityScope.universityIds));
    }
  } else if (universityId && !lockedFilters.includes("universityId")) {
    const universityIds = universityId
      .split(",")
      .map(value => parseInt(value.trim(), 10))
      .filter(value => Number.isInteger(value) && value > 0);
    if (universityIds.length === 1) conditions.push(eq(programsTable.universityId, universityIds[0]));
    else if (universityIds.length > 1) conditions.push(inArray(programsTable.universityId, universityIds));
  }
  applyFilter("level", level, v => conditions.push(ilike(programsTable.degree, `%${v}%`)));
  applyFilter("language", language, v => conditions.push(ilike(programsTable.language, v)));
  // Field of study supports comma-separated multi-values (e.g. "Engineering,Medicine").
  applyFilter("field", field, v => {
    const vals = v.split(",").map(s => s.trim()).filter(Boolean);
    if (vals.length === 1) conditions.push(ilike(programsTable.field, vals[0]));
    else if (vals.length > 1) conditions.push(or(...vals.map(fv => ilike(programsTable.field, fv)))!);
  });

  if (feeMin) conditions.push(sql`COALESCE(${programsTable.discountedFee}, ${programsTable.tuitionFee}) >= ${parseInt(feeMin, 10)}`);
  if (feeMax) conditions.push(sql`COALESCE(${programsTable.discountedFee}, ${programsTable.tuitionFee}) <= ${parseInt(feeMax, 10)}`);
  if (search) {
    conditions.push(sql`(${ilike(programsTable.name, `%${search}%`)} OR ${ilike(universitiesTable.name, `%${search}%`)})`);
  }

  const where = and(...conditions);

  const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(programsTable).innerJoin(universitiesTable, eq(programsTable.universityId, universitiesTable.id)).where(where);

  const rows = await db.select({
    id: programsTable.id,
    name: programsTable.name,
    degree: programsTable.degree,
    field: programsTable.field,
    language: programsTable.language,
    duration: programsTable.duration,
    tuitionFee: programsTable.tuitionFee,
    currency: programsTable.currency,
    scholarship: programsTable.scholarship,
    intakes: programsTable.intakes,
    discountedFee: programsTable.discountedFee,
    feeType: programsTable.feeType,
    applicationFee: programsTable.applicationFee,
    depositFee: programsTable.depositFee,
    advancedFee: programsTable.advancedFee,
    languageFee: programsTable.languageFee,
    requirements: programsTable.requirements,
    universityId: programsTable.universityId,
    universityName: universitiesTable.name,
    universityLogoUrl: universitiesTable.logoUrl,
    universityCountry: universitiesTable.country,
    universityCity: universitiesTable.city,
    universityType: universitiesTable.universityType,
    universityWebsite: universitiesTable.website,
    universityDescription: universitiesTable.description,
    universityRanking: universitiesTable.ranking,
    universityQsRanking: universitiesTable.qsRanking,
    universityTimesRanking: universitiesTable.timesRanking,
    universityShanghaiRanking: universitiesTable.shanghaiRanking,
    universityCwtsLeidenRanking: universitiesTable.cwtsLeidenRanking,
  }).from(programsTable)
    .innerJoin(universitiesTable, eq(programsTable.universityId, universitiesTable.id))
    .where(where)
    .orderBy(universitiesTable.name, programsTable.name)
    .limit(limitNum)
    .offset(offset);

  const safeRows = rows.map((row) => ({
    ...row,
    universityLogoUrl: publicUniversityLogoPath(row.universityId, row.universityLogoUrl),
    universityWebsite: sanitizePublicUrl(row.universityWebsite),
  }));
  res.json({ data: safeRows, meta: { total: Number(count), page: pageNum, limit: limitNum, totalPages: Math.ceil(Number(count) / limitNum) } });
});

/**
 * Cascading widget facets. Always applies admin-defined presetFilters.
 * Additionally applies the visitor's current selections (passed as query
 * params) to all OTHER facets — selecting Country=Turkey narrows City,
 * University, etc. but leaves the Country dropdown intact so the user
 * can switch.
 */
router.get("/public/embed/:slug/filters", async (req, res): Promise<void> => {
  try {
    const slug = String(req.params.slug);
    const [widget] = await db.select().from(embedWidgetsTable).where(and(eq(embedWidgetsTable.slug, slug), eq(embedWidgetsTable.isActive, true)));
    if (!widget) { res.status(404).json({ error: "Widget not found" }); return; }

    // SECURITY: apply the same HMAC token gate that lead/apply/config/programs
    // enforce. Without this check /filters was reachable from any origin.
    const origin = req.headers.origin as string | undefined;
    if (!checkEmbedAccess(widget, req.query.t as string | undefined)) {
      res.status(403).json({ error: "Invalid or expired embed token" });
      return;
    }
    setEmbedCors(res, widget, origin);

    const presetFilters = (widget.presetFilters || {}) as Record<string, any>;
    const universityScope = resolveEmbedUniversityScope(presetFilters);
    const userParams = req.query as Record<string, string | undefined>;
    const join = eq(programsTable.universityId, universitiesTable.id);

    type FacetKey = "country" | "city" | "universityType" | "universityId" | "level" | "language" | "field" | "fee";
    function buildWhere(excludeKey?: FacetKey) {
      const c = [eq(programsTable.isActive, true)];

      // Preset filters always apply (even on their own facet) — admin
      // pinned them and the visitor cannot override.
      if (presetFilters.country) c.push(eq(universitiesTable.country, String(presetFilters.country)));
      if (presetFilters.city) c.push(eq(universitiesTable.city, String(presetFilters.city)));
      if (presetFilters.universityType) c.push(eq(universitiesTable.universityType, String(presetFilters.universityType)));
      if (universityScope.mode === "selected") {
        if (universityScope.universityIds.length === 1) c.push(eq(programsTable.universityId, universityScope.universityIds[0]));
        else c.push(inArray(programsTable.universityId, universityScope.universityIds));
      }
      if (presetFilters.level) c.push(ilike(programsTable.degree, `%${presetFilters.level}%`));
      if (presetFilters.language) c.push(ilike(programsTable.language, String(presetFilters.language)));
      if (presetFilters.field) c.push(ilike(programsTable.field, String(presetFilters.field)));

      // Visitor selections — exclude the facet's own key so its dropdown
      // still shows every choice.
      if (excludeKey !== "country" && !presetFilters.country && userParams.country) {
        const vals = userParams.country.split(",").map(s => s.trim()).filter(Boolean);
        if (vals.length === 1) c.push(eq(universitiesTable.country, vals[0]));
        else if (vals.length > 1) c.push(inArray(universitiesTable.country, vals));
      }
      if (excludeKey !== "city" && !presetFilters.city && userParams.city) {
        const vals = userParams.city.split(",").map(s => s.trim()).filter(Boolean);
        if (vals.length === 1) c.push(eq(universitiesTable.city, vals[0]));
        else if (vals.length > 1) c.push(inArray(universitiesTable.city, vals));
      }
      if (excludeKey !== "universityType" && !presetFilters.universityType && userParams.universityType) {
        const vals = userParams.universityType.split(",").map(s => s.trim()).filter(Boolean);
        if (vals.length === 1) c.push(eq(universitiesTable.universityType, vals[0]));
        else if (vals.length > 1) c.push(inArray(universitiesTable.universityType, vals));
      }
      if (excludeKey !== "universityId" && universityScope.mode === "all" && userParams.universityId) {
        const vals = userParams.universityId.split(",").map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
        if (vals.length === 1) c.push(eq(programsTable.universityId, vals[0]));
        else if (vals.length > 1) c.push(inArray(programsTable.universityId, vals));
      }
      if (excludeKey !== "level" && !presetFilters.level && userParams.level) {
        const vals = userParams.level.split(",").map(s => s.trim()).filter(Boolean);
        if (vals.length === 1) c.push(ilike(programsTable.degree, `%${vals[0]}%`));
      }
      if (excludeKey !== "language" && !presetFilters.language && userParams.language) {
        const vals = userParams.language.split(",").map(s => s.trim()).filter(Boolean);
        if (vals.length === 1) c.push(ilike(programsTable.language, vals[0]));
      }
      if (excludeKey !== "field" && !presetFilters.field && userParams.field) {
        const vals = userParams.field.split(",").map(s => s.trim()).filter(Boolean);
        if (vals.length === 1) c.push(ilike(programsTable.field, vals[0]));
        else if (vals.length > 1) c.push(or(...vals.map(fv => ilike(programsTable.field, fv)))!);
      }
      if (excludeKey !== "fee") {
        const feeMin = userParams.feeMin ? parseInt(userParams.feeMin, 10) : NaN;
        if (Number.isFinite(feeMin) && feeMin >= 0) c.push(sql`COALESCE(${programsTable.discountedFee}, ${programsTable.tuitionFee}) >= ${feeMin}`);
        const feeMax = userParams.feeMax ? parseInt(userParams.feeMax, 10) : NaN;
        if (Number.isFinite(feeMax) && feeMax >= 0) c.push(sql`COALESCE(${programsTable.discountedFee}, ${programsTable.tuitionFee}) <= ${feeMax}`);
      }
      return and(...c);
    }

    const [countries, cities, universityTypes, universities, degrees, languages, fields, feeRange] = await Promise.all([
      db.selectDistinct({ country: universitiesTable.country }).from(universitiesTable).innerJoin(programsTable, join).where(and(buildWhere("country"), sql`${universitiesTable.country} IS NOT NULL`)).orderBy(universitiesTable.country),
      db.selectDistinct({ city: universitiesTable.city }).from(universitiesTable).innerJoin(programsTable, join).where(and(buildWhere("city"), sql`${universitiesTable.city} IS NOT NULL`)).orderBy(universitiesTable.city),
      db.selectDistinct({ type: universitiesTable.universityType }).from(universitiesTable).innerJoin(programsTable, join).where(and(buildWhere("universityType"), sql`${universitiesTable.universityType} IS NOT NULL`)).orderBy(universitiesTable.universityType),
      db.selectDistinct({ id: universitiesTable.id, name: universitiesTable.name }).from(universitiesTable).innerJoin(programsTable, join).where(buildWhere("universityId")).orderBy(universitiesTable.name),
      db.selectDistinct({ degree: programsTable.degree }).from(programsTable).innerJoin(universitiesTable, join).where(and(buildWhere("level"), sql`${programsTable.degree} IS NOT NULL`)).orderBy(programsTable.degree),
      db.selectDistinct({ language: programsTable.language }).from(programsTable).innerJoin(universitiesTable, join).where(and(buildWhere("language"), sql`${programsTable.language} IS NOT NULL`)).orderBy(programsTable.language),
      db.selectDistinct({ field: programsTable.field }).from(programsTable).innerJoin(universitiesTable, join).where(and(buildWhere("field"), sql`${programsTable.field} IS NOT NULL AND ${programsTable.field} != ''`)).orderBy(programsTable.field),
      db.select({ min: sql<number>`MIN(COALESCE(${programsTable.discountedFee}, ${programsTable.tuitionFee}))`, max: sql<number>`MAX(COALESCE(${programsTable.discountedFee}, ${programsTable.tuitionFee}))` }).from(programsTable).innerJoin(universitiesTable, join).where(and(buildWhere("fee"), sql`COALESCE(${programsTable.discountedFee}, ${programsTable.tuitionFee}) IS NOT NULL`)),
    ]);

    res.json({
      countries: countries.map(r => r.country).filter(Boolean),
      cities: cities.map(r => r.city).filter(Boolean),
      universityTypes: universityTypes.map(r => r.type).filter(Boolean),
      universities: universities.map(r => ({ id: r.id, name: r.name })),
      degrees: degrees.map(r => r.degree).filter(Boolean),
      languages: languages.map(r => r.language).filter(Boolean),
      fields: fields.map(r => r.field).filter(Boolean),
      feeRange: { min: feeRange[0]?.min ?? 0, max: feeRange[0]?.max ?? 100000 },
    });
  } catch (err: any) {
    console.error("[embed/filters] failed:", err?.message || err);
    res.status(500).json({ error: "Failed to load filters" });
  }
});

// Step-1 lead capture for the embed widget. Mirrors /public/lead but is
// slug-aware so the lead is tagged with `embed:<slug>` and validated against
// the widget's allowed-domains list. Called by the widget JS when the user
// clicks "Continue" on the Personal Info step so the lead lands in the
// "new" column even if the user abandons the form before submitting docs.
router.post("/public/embed/:slug/lead", embedLeadSubmitLimiter, embedLeadJson, async (req, res): Promise<void> => {
  const slug = String(req.params.slug);
  const [widget] = await db.select().from(embedWidgetsTable).where(and(eq(embedWidgetsTable.slug, slug), eq(embedWidgetsTable.isActive, true)));
  if (!widget) { res.status(404).json({ error: "Widget not found" }); return; }

  const origin = req.headers.origin as string | undefined;
  if (!checkEmbedAccess(widget, req.query.t as string | undefined)) {
    res.status(403).json({ error: "Invalid or expired embed token" });
    return;
  }
  setEmbedCors(res, widget, origin);

  const { firstName, lastName, email, phone, countryCode, programName, universityName, sourcePageUrl, utmSource, utmMedium, utmCampaign, utmTerm, utmContent, gaClientId, gaSessionId, gaCapturedAt, _hp } = req.body;
  if (_hp) { res.json({ success: true, leadId: null, created: false }); return; }

  if (!firstName || !lastName || !email) {
    res.status(400).json({ error: "firstName, lastName, and email are required" });
    return;
  }
  {
    const badField = firstNonLatinNameField([["firstName", firstName], ["lastName", lastName]]);
    if (badField) {
      res.status(400).json({ error: `${NON_LATIN_NAME_CODE}:${badField}: This field must contain only Latin letters.` });
      return;
    }
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    res.status(400).json({ error: "Invalid email format" });
    return;
  }

  const s = (v: any, max: number) => v ? String(v).slice(0, max) : null;

  try {
    const partnerExtras = await widgetPartnerExtras(widget.agentId);
    // Dedup-aware insert: if the same email already submitted to this
    // widget within the dedup window, the existing lead row is reused
    // and refreshed with the latest payload. Prevents duplicates when
    // the visitor clicks Continue twice, refreshes, or reopens the
    // widget in another tab.
    const { lead, created } = await findOrUpsertEmbedLead({
      slug: widget.slug,
      ip: req.ip,
      fields: {
        firstName: tlu(firstName, 100)!,
        lastName: tlu(lastName, 100)!,
        email: s(email, 255)!,
        phone: pn(phone, countryCode, 50),
        phoneE164: toE164(pn(phone, countryCode, 50)),
        interestedProgram: s(programName, 255),
        interestedUniversity: s(universityName, 255),
        sourcePageUrl: s(sourcePageUrl, 500),
        utmSource: s(utmSource, 100),
        utmMedium: s(utmMedium, 100),
        utmCampaign: s(utmCampaign, 100),
        utmTerm: s(utmTerm, 100),
        utmContent: s(utmContent, 100),
      },
      extras: partnerExtras,
    });
    const ga4Context = sanitizeGa4AnalyticsContext({ gaClientId, gaSessionId, gaCapturedAt });
    if (ga4Context) {
      await db.update(leadsTable).set({
        educationData: sql`
          COALESCE(${leadsTable.educationData}, '{}'::jsonb)
          || jsonb_build_object(
            'analytics',
            COALESCE(${leadsTable.educationData}->'analytics', '{}'::jsonb)
            || jsonb_build_object('ga4', ${JSON.stringify(ga4Context)}::jsonb)
          )
        `,
      }).where(eq(leadsTable.id, lead.id));
    }
    // SECURITY (Public Intake): only disclose the numeric lead ID for a
    // freshly created lead, never for a deduped existing one. The opaque,
    // signed document session can be returned for both paths because it is
    // accepted only by the slug-bound draft-document endpoint.
    let documentSessionToken: string | null = null;
    try {
      documentSessionToken = createEmbedLeadDocumentSessionToken(
        getEmbedSigningSecret(),
        widget.slug,
        lead.id,
      );
    } catch (tokenError) {
      // Preserve the original lead-capture behaviour in a misconfigured local
      // environment. Draft persistence stays disabled until a signing secret
      // is configured; final /apply still saves the documents server-side.
      console.error("[embed/lead] document session could not be issued:", tokenError);
    }
    res.status(201).json({
      success: true,
      leadId: created ? lead.id : null,
      created,
      documentSessionToken,
    });
    if (created) {
      void runFtcNewLeadAutomation(lead.id).catch((automationError) => {
        console.error("[embed/lead] FTC automation failed:", automationError);
      });
    }
  } catch (err: any) {
    console.error("[embed/lead] failed:", err?.message || err);
    res.status(500).json({ error: "Failed to save lead" });
  }
});

// Persist documents as soon as the visitor leaves the Upload Documents step.
// The session token is opaque, short-lived, slug-bound and HMAC-signed; the
// endpoint never accepts a public numeric lead id. Final /apply promotes these
// draft rows to the resulting student/application instead of inserting copies.
router.post("/public/embed/:slug/lead-documents", embedDocumentSubmitLimiter, embedApplyJson, async (req, res): Promise<void> => {
  const slug = String(req.params.slug);
  const [widget] = await db.select().from(embedWidgetsTable).where(and(
    eq(embedWidgetsTable.slug, slug),
    eq(embedWidgetsTable.isActive, true),
  ));
  if (!widget) { res.status(404).json({ error: "Widget not found" }); return; }

  const origin = req.headers.origin as string | undefined;
  if (!checkEmbedAccess(widget, req.query.t as string | undefined)) {
    res.status(403).json({ error: "Invalid or expired embed token" });
    return;
  }
  setEmbedCors(res, widget, origin);

  const session = verifyEmbedLeadDocumentSessionToken(
    getEmbedSigningSecret(),
    req.body?.documentSessionToken,
    slug,
  );
  if (!session) {
    res.status(403).json({ error: "Invalid or expired document session" });
    return;
  }

  const [lead] = await db.select({
    id: leadsTable.id,
    firstName: leadsTable.firstName,
    lastName: leadsTable.lastName,
    source: leadsTable.source,
    convertedStudentId: leadsTable.convertedStudentId,
  }).from(leadsTable).where(and(
    eq(leadsTable.id, session.leadId),
    isNull(leadsTable.deletedAt),
  ));
  if (!lead || lead.source !== `embed:${slug}`) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }
  if (lead.convertedStudentId) {
    res.status(409).json({ error: "This lead has already been converted" });
    return;
  }

  const prepared = await prepareEmbedDocuments(req.body?.documents);
  if (prepared.validDocs.length === 0) {
    res.status(400).json({
      error: "No valid documents provided",
      documentWarnings: prepared.warnings,
    });
    return;
  }

  const saved = await persistEmbedLeadDocuments({
    leadId: lead.id,
    firstName: lead.firstName,
    lastName: lead.lastName,
    documents: prepared.validDocs,
  });
  res.json({ saved, documentWarnings: prepared.warnings });
});

router.post("/public/embed/:slug/apply", embedApplicationSubmitLimiter, embedApplyJson, async (req, res): Promise<void> => {
  const slug = String(req.params.slug);
  const [widget] = await db.select().from(embedWidgetsTable).where(and(eq(embedWidgetsTable.slug, slug), eq(embedWidgetsTable.isActive, true)));
  if (!widget) { res.status(404).json({ error: "Widget not found" }); return; }

  const origin = req.headers.origin as string | undefined;
  if (!checkEmbedAccess(widget, req.query.t as string | undefined)) {
    res.status(403).json({ error: "Invalid or expired embed token" });
    return;
  }
  setEmbedCors(res, widget, origin);

  const { firstName, lastName, email, phone, countryCode, nationality, desiredLevel, desiredProgram, preferredUniversity, message, programId, programName, universityName, sourcePageUrl, utmSource, utmMedium, utmCampaign, utmTerm, utmContent, _hp, documents, documentSessionToken, documentLabels, aiExtractedData, motherName, fatherName, gender, dateOfBirth, passportNumber, passportIssueDate, passportExpiry, address, addressCity, postalCode, highSchool, graduationYear, gpa, languageScore } = req.body;

  if (_hp) { res.json({ success: true }); return; }

  if (!firstName || !lastName || !email) {
    res.status(400).json({ error: "firstName, lastName, and email are required" });
    return;
  }
  const normalizedPassportNumber = passportNumber == null
    ? ""
    : String(passportNumber).trim();
  if (
    normalizedPassportNumber &&
    validatePassportNumber(normalizedPassportNumber)
  ) {
    res.status(422).json({
      error: "Passport number is not valid. Enter only the number printed on the passport; quotation marks are not allowed.",
      code: "PASSPORT_NUMBER_INVALID",
    });
    return;
  }
  {
    const badField = firstNonLatinNameField([
      ["firstName", firstName], ["lastName", lastName],
      ["motherName", motherName], ["fatherName", fatherName],
      ["address", address], ["highSchool", highSchool],
    ]);
    if (badField) {
      res.status(400).json({ error: `${NON_LATIN_NAME_CODE}:${badField}: This field must contain only Latin letters.` });
      return;
    }
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    res.status(400).json({ error: "Invalid email format" });
    return;
  }

  // Final submit must carry a country-valid phone. The step-1 early-fire
  // /lead endpoint stays lenient (never lose a captured contact), but the
  // completed application is rejected with 422 + phone.invalid so the
  // widget can surface an inline error.
  if (rejectInvalidPhone(res, pn(phone, countryCode, 50))) return;

  let sourceWebsite: string | null = null;
  try { sourceWebsite = origin || (req.headers.referer ? new URL(req.headers.referer as string).origin : null) || null; } catch {}

  const s = (v: any, max: number) => v ? String(v).slice(0, max) : null;
  const resolvedInterestedLevel = await resolveProgramInterestedLevel(programId, desiredLevel);
  const residence = resolveResidenceAddress({
    address,
    addressCity: addressCity || aiExtractedData?.addressCity,
    postalCode: postalCode || aiExtractedData?.postalCode,
    nationality,
  });

  let documentSessionLeadId: number | null = null;
  let preparedDocuments: Awaited<ReturnType<typeof prepareEmbedDocuments>>;
  if (documentSessionToken) {
    const session = verifyEmbedLeadDocumentSessionToken(
      getEmbedSigningSecret(),
      documentSessionToken,
      slug,
    );
    if (!session) {
      res.status(403).json({
        error: "Your secure document session expired. Please return to the first step and try again.",
        code: "EMBED_DOCUMENT_SESSION_INVALID",
      });
      return;
    }
    const draftDocuments = await readEmbedLeadDraftDocuments({
      leadId: session.leadId,
      slug,
      email: String(email),
      requestedLabels: documentLabels,
    });
    if (draftDocuments === null) {
      res.status(403).json({
        error: "The document session does not match this application.",
        code: "EMBED_DOCUMENT_SESSION_MISMATCH",
      });
      return;
    }
    documentSessionLeadId = session.leadId;
    preparedDocuments = {
      validDocs: draftDocuments,
      warnings: [],
      inputCount: draftDocuments.length,
    };
  } else {
    // Compatibility path for cached/legacy iframes that still send the base64
    // documents in the final request.
    preparedDocuments = await prepareEmbedDocuments(documents);
  }
  const validDocs = preparedDocuments.validDocs;
  const documentWarnings = preparedDocuments.warnings;

  if (documentWarnings.length > 0) {
    console.warn(`[EMBED-APPLY] Dropped ${preparedDocuments.inputCount - validDocs.length} invalid document(s) (slug=${widget.slug}):`, documentWarnings.join(" | "));
  }

  // SECURITY (Public Intake / IDOR): the embed apply NEVER trusts a
  // client-supplied leadId. A numeric lead ID is enumerable and the email is
  // not a secret, so honoring a client-passed ID — even with a source+email
  // match — is a broken-object-binding primitive that let an off-domain
  // caller overwrite or convert an arbitrary lead row. Instead we always
  // re-derive the lead deterministically on the server from
  // (lower(email), source="embed:<slug>") via the dedup helper. This binds
  // the write to THIS widget's own lead for this email, prevents a second
  // row when Step-1 already created one, and preserves the lead-first ->
  // auto-convert UX. Any client-supplied leadId is intentionally ignored.
  const partnerExtras = await widgetPartnerExtras(widget.agentId);
  let result: { leadId: number; submissionId: number };
  try {
    result = await db.transaction(async (tx) => {
      const upsertResult = await findOrUpsertEmbedLead({
        slug: widget.slug,
        ip: req.ip,
        tx,
        fields: {
          firstName: tlu(firstName, 100)!,
          lastName: tlu(lastName, 100)!,
          email: s(email, 255)!,
          phone: pn(phone, countryCode, 50),
          phoneE164: toE164(pn(phone, countryCode, 50)),
          nationality: s(nationality, 100),
          interestedProgram: s(programName || desiredProgram, 255),
          interestedUniversity: s(universityName || preferredUniversity, 255),
          notes: s(message, 2000),
        },
        extras: partnerExtras,
      });
      const lead = upsertResult.lead;
      if (documentSessionLeadId !== null && lead.id !== documentSessionLeadId) {
        throw new Error("EMBED_DOCUMENT_SESSION_LEAD_MISMATCH");
      }

      const [submission] = await tx.insert(embedSubmissionsTable).values({
      widgetId: widget.id,
      firstName: tlu(firstName, 100)!,
      lastName: tlu(lastName, 100)!,
      email: s(email, 255)!,
      phone: pnOnly(phone, 50),
      countryCode: s(countryCode, 10),
      nationality: s(nationality, 100),
      desiredLevel: s(desiredLevel, 100),
      desiredProgram: s(desiredProgram, 255),
      preferredUniversity: s(universityName || preferredUniversity, 255),
      message: s(message, 2000),
      programId: programId ? parseInt(String(programId), 10) : null,
      programName: s(programName, 255),
      universityName: s(universityName, 255),
      sourceWebsite,
      sourcePageUrl: s(sourcePageUrl, 500),
      utmSource: s(utmSource, 100),
      utmMedium: s(utmMedium, 100),
      utmCampaign: s(utmCampaign, 100),
      utmTerm: s(utmTerm, 100),
      utmContent: s(utmContent, 100),
      leadId: lead.id,
      aiExtractedData: aiExtractedData || null,
      documentCount: validDocs.length,
      status: "new",
      }).returning();

      return { leadId: lead.id, submissionId: submission.id };
    });
  } catch (error) {
    if (error instanceof Error && error.message === "EMBED_DOCUMENT_SESSION_LEAD_MISMATCH") {
      res.status(403).json({
        error: "The document session does not match this application.",
        code: "EMBED_DOCUMENT_SESSION_MISMATCH",
      });
      return;
    }
    throw error;
  }

  // Step 1 may have created this lead before nationality/full phone details
  // existed. Re-evaluate only while it is still unassigned; the helper never
  // overwrites an explicit owner and now checks both phone and phoneE164.
  let [enrichedLead] = await db.select().from(leadsTable)
    .where(eq(leadsTable.id, result.leadId)).limit(1);
  if (enrichedLead?.assignedToId == null) {
    await applyLeadAssignmentRules(enrichedLead, req.ip);
    [enrichedLead] = await db.select().from(leadsTable)
      .where(eq(leadsTable.id, result.leadId)).limit(1);
  }

  // Legacy clients still send file bytes only on the final request, so persist
  // those before any mandatory-document rejection. Session-based clients have
  // already persisted every file one at a time in /lead-documents; rewriting
  // the whole set here would add avoidable DB load and could reintroduce an
  // aggregate-size failure for programs with many document slots.
  if (validDocs.length > 0 && documentSessionLeadId === null) {
    await persistEmbedLeadDocuments({
      leadId: result.leadId,
      firstName: tlu(firstName, 100)!,
      lastName: tlu(lastName, 100)!,
      documents: validDocs,
    });
  }

  // ─── Server-side mandatory-document enforcement ──────────────────────────
  // The widget blocks submit client-side when required documents are missing,
  // but a stale cached widget, a disabled-JS client, or a direct API call
  // could bypass that gate (this is exactly how application #2141 came in with
  // only 2 of 4 mandatory docs). Enforce the gate on the server too: when the
  // selected program has mandatory documents that this submission does not
  // satisfy, refuse to create/convert the student + application. The lead +
  // submission row committed above is intentionally KEPT, so no contact is
  // ever lost — staff still see the lead and can follow up — we only decline
  // to accept an application that is missing its mandatory documents.
  {
    const programIdNum = programId ? parseInt(String(programId), 10) : NaN;
    if (Number.isFinite(programIdNum) && programIdNum > 0) {
      const uploadedDocTypes = validDocs
        .map((d: any) => String(d.label || "").toLowerCase())
        .filter(Boolean);
      const { missing } = await checkMandatoryDocs(programIdNum, uploadedDocTypes);
      if (missing.length > 0) {
        // The lead + submission committed above are intentionally KEPT — this
        // response only declines the application, never the contact.
        res.status(422).json({
          error: "Please upload all required documents before submitting your application.",
          missingDocuments: missing,
          leadId: result.leadId,
          ...(documentWarnings.length > 0 ? { documentWarnings } : {}),
        });
        return;
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // After the lead+submission row is saved, create a student account and
  // application so the embed submission shows up in the same Students /
  // Applications views as a public-apply submission. Mirrors the
  // public-apply flow but is more permissive about missing fields (the
  // embed widget collects fewer data points than the full Programs.tsx
  // dialog). On any failure we still return success for the lead — the
  // staff can finish the conversion manually from the lead row.
  // ─────────────────────────────────────────────────────────────────────
  let resultStudentId: number | null = null;
  let resultAppId: number | null = null;
  let embedMissingDocTypes: string[] = [];
  try {
    const normalizedEmail = String(email).toLowerCase().trim();
    const [existingUser] = await db.select().from(usersTable).where(eq(usersTable.email, normalizedEmail));
    const [archivedStudent] = await db.select({ id: studentsTable.id }).from(studentsTable).where(and(
      sql`lower(trim(${studentsTable.email})) = ${normalizedEmail}`,
      isNotNull(studentsTable.deletedAt),
    ));

    // SECURITY (Public Intake — account takeover via email): do NOT write
    // applications or documents to an existing verified student account
    // without authentication. An unauthenticated caller who knows the victim's
    // email and a widget slug could otherwise attach attacker-controlled data
    // to that student's CRM records. The lead/submission row (captured above
    // in the transaction) is still created — it is safe, low-sensitivity, and
    // lets staff handle the conversion manually. Only brand-new accounts (no
    // existing user row) get the automatic student+application creation path.
    //
    // `existingStudentBlocked` prevents the fallthrough new-account path from
    // running (and failing on the unique-email constraint) when we skip here.
    let existingStudentBlocked = false;
    if (archivedStudent) {
      console.warn(`[EMBED-APPLY] Archived student #${archivedStudent.id} requires an administrator restore (slug=${widget.slug})`);
      existingStudentBlocked = true;
    }
    if (existingUser && existingUser.role === "student") {
      const [existingStudent] = await db.select().from(studentsTable)
        .where(and(eq(studentsTable.userId, existingUser.id), isNull(studentsTable.deletedAt)));
      if (existingStudent) {
        console.warn(`[EMBED-APPLY] Blocked unauthenticated attempt to create application on existing student #${existingStudent.id} (slug=${widget.slug})`);
        existingStudentBlocked = true;
        // resultStudentId and resultAppId stay null — auto-convert won't fire.
        // Fall through to the response at the bottom.
      }
    }

    if (!existingStudentBlocked && !resultStudentId && (!existingUser || existingUser.role === "student")) {
      // Create a placeholder user + student record. Account starts inactive
      // and unverified; staff can invite the student later when they want
      // to give them portal access.
      let userId: number;
      if (existingUser) {
        userId = existingUser.id;
      } else {
        const passwordToken = generateSecureToken();
        const [newUser] = await db.insert(usersTable).values({
          email: normalizedEmail,
          firstName: tlu(firstName, 100)!,
          lastName: tlu(lastName, 100)!,
          phone: pn(phone, countryCode, 50),
          phoneE164: toE164(pn(phone, countryCode, 50)),
          role: "student",
          isActive: false,
          emailVerified: false,
          language: "en",
          passwordResetToken: crypto.createHash("sha256").update(passwordToken).digest("hex"),
          passwordResetExpires: new Date(Date.now() + 48 * 60 * 60 * 1000),
          createdFromSource: `embed:${widget.slug}`,
        }).returning();
        userId = newUser.id;
      }

      let newStudent: typeof studentsTable.$inferSelect;
      const normalizedGender = gender ? String(gender).toLowerCase() : null;
      const safeGender = (normalizedGender === "female" || normalizedGender === "male") ? normalizedGender : null;
      [newStudent] = await db.insert(studentsTable).values({
          userId,
          firstName: tlu(firstName, 100)!,
          lastName: tlu(lastName, 100)!,
          email: normalizedEmail,
          phone: pn(phone, countryCode, 50),
          phoneE164: toE164(pn(phone, countryCode, 50)),
          nationality: s(nationality, 100),
          dateOfBirth: s(dateOfBirth, 20),
          gender: safeGender,
          motherName: tlu(motherName, 100),
          fatherName: tlu(fatherName, 100),
          passportNumber: s(normalizedPassportNumber, 50),
          passportIssueDate: s(passportIssueDate, 20),
          passportExpiry: s(passportExpiry, 20),
          address: s(address, 300),
          addressCity: residence.addressCity,
          postalCode: residence.postalCode,
          highSchool: s(highSchool, 200),
          interestedLevel: resolvedInterestedLevel,
          graduationYear: graduationYear ? parseInt(String(graduationYear), 10) || null : null,
          gpa: s(gpa, 20),
          languageScore: s(languageScore, 20),
          agentId: enrichedLead?.agentId ?? null,
          assignedToId: enrichedLead?.assignedToId ?? null,
          agencyAssignedToId: enrichedLead?.agencyAssignedToId ?? null,
          branchId: enrichedLead?.branchId ?? null,
          originType: enrichedLead?.originType || "direct",
          originEntityType: enrichedLead?.originEntityType ?? null,
          originEntityId: enrichedLead?.originEntityId ?? null,
          originDisplayName: enrichedLead?.originDisplayName ?? null,
          originLeadId: result.leadId,
        }).returning();
      resultStudentId = newStudent.id;
      const newAppResult = await createApplicationForStudent(
        newStudent.id,
        programId ? parseInt(String(programId), 10) : null,
        s(programName, 255),
        s(universityName, 255),
        s(gpa, 20),
        s(languageScore, 20),
        result.leadId,
      );
      resultAppId = newAppResult.appId;
    }

    // Attach the uploaded documents to the student (and application when one
    // exists) so they surface in the student/application detail view, not just
    // on the lead row. When app creation was blocked (eligibility/quota),
    // resultAppId is null but the docs must still ride with the student so they
    // are not orphaned on a lead that is about to be converted away.
    if (validDocs.length > 0 && resultStudentId) {
      for (const doc of validDocs) {
        if (!doc.label || !doc.data) continue;
        const docType = String(doc.label || "other").toLowerCase();
        const docName = buildDocNameFromParts(firstName, lastName, docType, doc.mediaType);
        const [draftDoc] = await db.select({ id: documentsTable.id })
          .from(documentsTable)
          .where(and(
            eq(documentsTable.leadId, result.leadId),
            eq(documentsTable.type, docType),
            isNull(documentsTable.studentId),
            isNull(documentsTable.applicationId),
            isNull(documentsTable.deletedAt),
          ))
          .orderBy(desc(documentsTable.createdAt), desc(documentsTable.id));
        if (draftDoc) {
          await db.update(documentsTable).set({
            studentId: resultStudentId,
            applicationId: resultAppId,
            name: docName,
            fileData: doc.data,
            mimeType: doc.mediaType || null,
            sizeBytes: doc.sizeBytes || null,
            updatedAt: new Date(),
          }).where(eq(documentsTable.id, draftDoc.id));
        } else {
          await db.insert(documentsTable).values({
            studentId: resultStudentId,
            applicationId: resultAppId,
            leadId: result.leadId,
            name: docName,
            type: docType,
            status: "pending",
            fileData: doc.data,
            mimeType: doc.mediaType || null,
            sizeBytes: doc.sizeBytes || null,
          });
        }
        // Mirror to the student's own (profile-level) documents when the doc was
        // attached to an application AND the student has no active profile-level
        // doc of that type yet. Mirrors the staff upload rule (documents.ts): an
        // application upload fills the student's reusable document library only
        // when it is empty for that type, and never overwrites a doc already on
        // file. When resultAppId is null the doc above is already profile-level,
        // so no mirror is needed.
        if (resultAppId) {
          const [existingProfileDoc] = await db
            .select({ id: documentsTable.id })
            .from(documentsTable)
            .where(and(
              eq(documentsTable.studentId, resultStudentId),
              eq(documentsTable.type, docType),
              isNull(documentsTable.applicationId),
              isNull(documentsTable.deletedAt),
            ));
          if (!existingProfileDoc) {
            await db.insert(documentsTable).values({
              studentId: resultStudentId,
              applicationId: null,
              leadId: null,
              name: docName,
              type: docType,
              status: "pending",
              fileData: doc.data,
              mimeType: doc.mediaType || null,
              sizeBytes: doc.sizeBytes || null,
            });
          }
        }
      }
    }

    // Sync has_photo + photo_url from the just-inserted (fileData-only) docs so a
    // photograph uploaded through the embed widget shows on every avatar surface.
    if (resultStudentId) {
      await recomputeStudentPhoto(resultStudentId);
      // Fire-and-forget: run AI education extraction on any education-trigger
      // docs that were just inserted for this student (transcript/diploma/degree).
      // Public widget submission: actorUserId is null (no logged-in user).
      maybeTriggerAutoEducationExtractForStudent({
        studentId: resultStudentId,
        actorUserId: null,
        ip: req.ip,
      });
    }

    // Auto-convert the lead → "converted" + flip student → "active" on
    // every successful full submit. Spec: hitting Submit at the end of
    // the widget IS the funnel-closing event for this lead, regardless
    // of whether every required document group was uploaded OR whether an
    // application could be created (eligibility/quota may block the app) —
    // staff handle missing docs and ineligible applications from the
    // student detail view, not from the leads kanban "new" column.
    if (resultStudentId) {
      try {
        const [settingsRow] = await db.select({
          autoConvertLeadEnabled: settingsTable.autoConvertLeadEnabled,
          autoConvertStudentStageKey: settingsTable.autoConvertStudentStageKey,
        }).from(settingsTable);
        const autoConvertEnabled = settingsRow?.autoConvertLeadEnabled !== false;
        const studentStageKey = settingsRow?.autoConvertStudentStageKey || "active";

        if (autoConvertEnabled) {
          await db.update(studentsTable)
            .set({ status: studentStageKey })
            .where(eq(studentsTable.id, resultStudentId));
          await db.update(leadsTable)
            .set({ status: "converted", convertedStudentId: resultStudentId })
            .where(eq(leadsTable.id, result.leadId));
          console.log(`[EMBED-APPLY] Auto-converted lead #${result.leadId} → student #${resultStudentId} (slug=${widget.slug}, stage=${studentStageKey})`);
          // Event-driven portal enqueue: student just entered the configured
          // auto-convert stage. actorUserId is null (public endpoint — no
          // logged-in user); enqueueOnStageChange handles this gracefully.
          void enqueueOnStageChange({
            studentId:  resultStudentId,
            newStage:   studentStageKey,
            actorUserId: null,
            ...(resultAppId !== null ? { applicationId: resultAppId } : {}),
          });
        } else {
          console.log(`[EMBED-APPLY] Auto-convert disabled by settings; lead #${result.leadId} left untouched (slug=${widget.slug})`);
        }
      } catch (convertErr) {
        console.error("[EMBED-APPLY] Failed to auto-convert lead/student:", convertErr);
      }
    }

    // ─── Mandatory document gate ─────────────────────────────────────────
    // Check whether the program requires documents not yet in the student's
    // library. Park the application in "missing_docs" when any are absent.
    if (resultStudentId && resultAppId && programId) {
      const programIdNum = parseInt(String(programId), 10);
      if (Number.isFinite(programIdNum) && programIdNum > 0) {
        try {
          const { missing } = await checkMandatoryDocsForStudent(programIdNum, resultStudentId);
          if (missing.length > 0) {
            await parkApplicationInMissingDocsStage(resultAppId);
            embedMissingDocTypes = missing;
            const missingStr = missing.join(", ");
            const appIdForNotif = resultAppId;
            const studentIdForNotif = resultStudentId;
            void (async () => {
              try {
                const [appRow] = await db.select({ assignedToId: applicationsTable.assignedToId })
                  .from(applicationsTable).where(eq(applicationsTable.id, appIdForNotif));
                if (appRow?.assignedToId) {
                  await dispatchNotification({
                    event: "mandatory_docs_missing",
                    title: "Eksik Belgeler",
                    body: `Başvuru eksik belgeler nedeniyle park edildi: ${missingStr}`,
                    recipientUserIds: [appRow.assignedToId],
                    data: { applicationId: appIdForNotif, missing },
                  });
                }
                const [studentRow] = await db.select({ userId: studentsTable.userId })
                  .from(studentsTable).where(eq(studentsTable.id, studentIdForNotif));
                if (studentRow?.userId) {
                  await dispatchNotification({
                    event: "mandatory_docs_missing_student",
                    title: "Eksik Belgeler",
                    body: `Başvurunuz için gerekli belgeler eksik: ${missingStr}`,
                    recipientUserIds: [studentRow.userId],
                    data: { applicationId: appIdForNotif, missing },
                  });
                }
              } catch (notifErr) {
                console.error("[EMBED-APPLY] Mandatory docs notification error:", notifErr);
              }
            })();
          }
        } catch (gateErr) {
          console.error("[EMBED-APPLY] Mandatory doc gate error:", gateErr);
        }
      }
    }

    if (resultStudentId && resultAppId && embedMissingDocTypes.length === 0) {
      const [appForPortal] = await db
        .select({
          stage: applicationsTable.stage,
          universityName: applicationsTable.universityName,
          universityId: applicationsTable.universityId,
        })
        .from(applicationsTable)
        .where(eq(applicationsTable.id, resultAppId))
        .limit(1);
      if (appForPortal) {
        void maybeEnqueuePortalSubmission({
          applicationId: resultAppId,
          studentId: resultStudentId,
          newStage: String(appForPortal.stage),
          universityName: appForPortal.universityName ?? null,
          universityId: appForPortal.universityId ?? null,
          actorUserId: null,
        });
      }
    }
  } catch (postErr) {
    console.error("[EMBED-APPLY] Post-processing (student/app/auto-convert) failed:", postErr);
  }

  res.status(201).json({
    success: true,
    submissionId: result.submissionId,
    leadId: result.leadId,
    studentId: resultStudentId,
    applicationId: resultAppId,
    ...(documentWarnings.length > 0 ? { documentWarnings } : {}),
    ...(embedMissingDocTypes.length > 0
      ? { status: "missing_documents", missing: embedMissingDocTypes }
      : { status: "inquiry" }),
  });
});

type ChatScopeMetadata = {
  widgetId: number;
  widgetSlug: string;
  universityScope: "all" | "selected";
  universityIds: number[];
  universityNames: string[];
  universityId: number | null;
  universityName: string | null;
  universityCountry?: string | null;
  universityCountryCode?: string | null;
  presetCountry?: string | null;
  presetCity?: string | null;
  presetUniversityType?: string | null;
  presetLevel?: string | null;
  presetLanguage?: string | null;
  presetField?: string | null;
  sourcePageUrl: string | null;
  sourceWebsite: string | null;
  assistantName: string;
  language: EmbedChatLocale;
};

function readChatScope(metadata: unknown): ChatScopeMetadata | null {
  if (!metadata || typeof metadata !== "object") return null;
  const scope = (metadata as Record<string, unknown>).chatbotScope;
  if (!scope || typeof scope !== "object") return null;
  const row = scope as Record<string, unknown>;
  if (!Number.isInteger(row.widgetId) || typeof row.widgetSlug !== "string") return null;
  const universityIds = Array.isArray(row.universityIds)
    ? [...new Set(row.universityIds
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0))]
    : [];
  const legacyUniversityId = Number(row.universityId);
  if (universityIds.length === 0 && Number.isInteger(legacyUniversityId) && legacyUniversityId > 0) {
    universityIds.push(legacyUniversityId);
  }
  const universityNames = Array.isArray(row.universityNames)
    ? [...new Set(row.universityNames
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean))]
    : [];
  const legacyUniversityName = typeof row.universityName === "string"
    ? row.universityName.trim()
    : "";
  if (universityNames.length === 0 && legacyUniversityName) universityNames.push(legacyUniversityName);
  const universityScope = row.universityScope === "all"
    ? "all"
    : universityIds.length > 0
      ? "selected"
      : null;
  if (!universityScope || (universityScope === "selected" && universityIds.length === 0)) return null;
  const scopeText = (key: string) => {
    const value = row[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  };
  return {
    ...(scope as Omit<ChatScopeMetadata, "language" | "universityScope" | "universityIds" | "universityNames" | "universityId" | "universityName">),
    universityScope,
    universityIds,
    universityNames,
    universityId: universityIds.length === 1 ? universityIds[0] : null,
    universityName: universityNames.length === 1 ? universityNames[0] : null,
    universityCountry: scopeText("universityCountry"),
    universityCountryCode: scopeText("universityCountryCode"),
    presetCountry: scopeText("presetCountry"),
    presetCity: scopeText("presetCity"),
    presetUniversityType: scopeText("presetUniversityType"),
    presetLevel: scopeText("presetLevel"),
    presetLanguage: scopeText("presetLanguage"),
    presetField: scopeText("presetField"),
    language: resolveEmbedChatLocale(row.language),
  };
}

async function loadChatSessionConversation(slug: string, sessionToken: string | undefined) {
  const parsed = verifyEmbedChatSessionToken(getEmbedSigningSecret(), sessionToken, slug);
  if (!parsed) return null;
  const [conversation] = await db
    .select()
    .from(conversationsTable)
    .where(and(
      eq(conversationsTable.id, parsed.conversationId),
      eq(conversationsTable.channel, "web_chat"),
      eq(conversationsTable.externalThreadId, `chat:${slug}:${parsed.sessionId}`),
    ))
    .limit(1);
  if (!conversation) return null;
  const scope = readChatScope(conversation.metadata);
  if (!scope || scope.widgetSlug !== slug) return null;
  const [activeWidget] = await db
    .select({ id: embedWidgetsTable.id })
    .from(embedWidgetsTable)
    .where(and(
      eq(embedWidgetsTable.id, scope.widgetId),
      eq(embedWidgetsTable.slug, slug),
      eq(embedWidgetsTable.mode, "ai_chatbot"),
      eq(embedWidgetsTable.isActive, true),
    ))
    .limit(1);
  if (!activeWidget) return null;
  return { parsed, conversation, scope };
}

function publicChatMessage(row: {
  id: number;
  content: string;
  direction: string;
  status: string;
  createdAt: Date;
  metadata?: unknown;
}) {
  const attachments = readWebChatAttachments(row.metadata).map(({ url: _url, ...attachment }) => attachment);
  return {
    id: row.id,
    content: row.content,
    direction: row.direction,
    status: row.status,
    createdAt: row.createdAt,
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

function decodeChatHeader(value: unknown, maxLength: number): string {
  const raw = typeof value === "string" ? value.slice(0, maxLength * 3) : "";
  if (!raw) return "";
  try {
    return decodeURIComponent(raw).slice(0, maxLength);
  } catch {
    return "";
  }
}

function privateWebChatAttachmentUrl(objectPath: string): string {
  const key = objectPath.replace(/^\/objects\//, "");
  return `/api/storage/objects/${key}`;
}

router.post(
  "/public/embed/:slug/chat/session",
  embedChatLimiter,
  embedChatJson,
  async (req, res): Promise<void> => {
    const slug = String(req.params.slug);
    const [widget] = await db
      .select()
      .from(embedWidgetsTable)
      .where(and(eq(embedWidgetsTable.slug, slug), eq(embedWidgetsTable.isActive, true)));
    if (!widget || widget.mode !== "ai_chatbot") {
      res.status(404).json({ error: "Chat widget not found" });
      return;
    }
    if (!checkEmbedAccess(widget, req.query.t as string | undefined)) {
      res.status(403).json({ error: "Invalid or expired embed token" });
      return;
    }
    setEmbedCors(res, widget, req.headers.origin as string | undefined);

    const {
      firstName,
      lastName,
      email,
      phone,
      countryCode,
      sourcePageUrl,
      sourceWebsite,
      language,
      _hp,
    } = req.body as Record<string, unknown>;
    if (_hp) {
      res.status(201).json({ success: true });
      return;
    }
    const cleanFirstName = sanitizeChatText(firstName, 100);
    const cleanLastName = sanitizeChatText(lastName, 100);
    const cleanEmail = sanitizeChatText(email, 255).toLowerCase();
    const cleanPhone = sanitizeChatText(phone, 50);
    const cleanCountryCode = sanitizeChatText(countryCode, 8);
    if (!cleanFirstName || !cleanLastName || !cleanEmail || !cleanPhone) {
      res.status(400).json({ error: "firstName, lastName, email and phone are required" });
      return;
    }
    const badField = firstNonLatinNameField([
      ["firstName", cleanFirstName],
      ["lastName", cleanLastName],
    ]);
    if (badField) {
      res.status(400).json({ error: `${NON_LATIN_NAME_CODE}:${badField}: Please use Latin letters.` });
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      res.status(400).json({ error: "Invalid email format" });
      return;
    }
    if (cleanCountryCode && !/^\+\d{1,4}$/.test(cleanCountryCode)) {
      res.status(400).json({ error: "Invalid country calling code." });
      return;
    }
    // New widgets submit the calling code and national number separately.
    // Keep accepting a complete international number from an already-open
    // pre-deploy widget, but never assume a default country.
    const combinedPhone = cleanCountryCode
      ? pn(cleanPhone, cleanCountryCode, 50)
      : pnOnly(cleanPhone, 50);
    const phoneE164 = toE164(combinedPhone);
    if (!phoneE164) {
      res.status(400).json({ error: "Invalid phone number. Include the country code." });
      return;
    }

    const universityScope = resolveEmbedUniversityScope(widget.presetFilters);
    const presetScopeFilters = resolveEmbedPresetScopeFilters(widget.presetFilters);
    if (!isValidEmbedUniversityScope(widget.presetFilters)) {
      res.status(409).json({ error: "Selected university scope requires at least one university." });
      return;
    }
    const scopedUniversities = universityScope.mode === "selected"
      ? await db
          .select({
            id: universitiesTable.id,
            name: universitiesTable.name,
            logoUrl: universitiesTable.logoUrl,
            country: universitiesTable.country,
            countryCode: countriesTable.code,
          })
          .from(universitiesTable)
          .leftJoin(
            countriesTable,
            sql`lower(${countriesTable.name}) = lower(${universitiesTable.country})`,
          )
          .where(and(
            inArray(universitiesTable.id, universityScope.universityIds),
            eq(universitiesTable.isActive, true),
          ))
      : [];
    if (
      universityScope.mode === "selected" &&
      scopedUniversities.length !== universityScope.universityIds.length
    ) {
      res.status(409).json({ error: "One or more selected universities are unavailable." });
      return;
    }
    const selectedUniversityNames = scopedUniversities.map((university) => university.name);
    const primaryUniversity = scopedUniversities.length === 1 ? scopedUniversities[0] : null;
    const firstCountry = scopedUniversities[0]?.country?.trim() ?? "";
    const commonSelectedCountry = firstCountry && scopedUniversities.every(
      (university) => university.country?.trim().toLowerCase() === firstCountry.toLowerCase(),
    )
      ? firstCountry
      : "";
    const scopeCountry = presetScopeFilters.country || commonSelectedCountry;
    const firstCountryCode = scopedUniversities[0]?.countryCode?.trim().toUpperCase() ?? "";
    let universityCountryCode = firstCountryCode && scopedUniversities.every(
      (university) => university.countryCode?.trim().toUpperCase() === firstCountryCode,
    )
      ? firstCountryCode
      : "";
    if (presetScopeFilters.country || (!universityCountryCode && scopeCountry)) {
      const canonicalName = canonicalCountry(scopeCountry) ?? scopeCountry;
      const [catalogCountry] = await db
        .select({ code: countriesTable.code })
        .from(countriesTable)
        .where(sql`lower(${countriesTable.name}) = lower(${canonicalName})`)
        .limit(1);
      universityCountryCode = catalogCountry?.code?.trim().toUpperCase() ?? "";
    }

    const pageUrl = sanitizePublicUrl(sourcePageUrl) || null;
    const website = sanitizeChatText(sourceWebsite, 255) || (
      pageUrl ? (() => { try { return new URL(pageUrl).hostname; } catch { return null; } })() : null
    );
    const theme = sanitizeTheme(widget.theme);
    const chatLocale = resolveEmbedChatLocale(language);
    const chatCopy = getEmbedChatCopy(chatLocale);
    const scopeDisplayName = primaryUniversity?.name || theme.assistantName || widget.name || "Find & Study";
    const assistantName =
      theme.assistantName || chatCopy.assistantName(scopeDisplayName);
    const displayName = `${cleanFirstName} ${cleanLastName}`.trim();

    try {
      const identity = await resolveIdentity({ phone: phoneE164, email: cleanEmail });
      let strong = identity.outcome === "strong"
        ? identity.candidates.find((candidate) => candidate.type === "student" || candidate.type === "lead")
        : null;
      // A globally unique email/phone may already belong to another agency or
      // to Find & Study directly. Never attach an agency widget chat to that
      // other tenant's CRM record. Only accept the identity candidate when its
      // persisted owner is this widget's agency; otherwise create/reuse the
      // widget-scoped lead below.
      if (strong && widget.agentId) {
        if (strong.type === "lead") {
          const [ownedLead] = await db.select({ id: leadsTable.id }).from(leadsTable).where(and(
            eq(leadsTable.id, strong.id),
            eq(leadsTable.agentId, widget.agentId),
            isNull(leadsTable.deletedAt),
          )).limit(1);
          if (!ownedLead) strong = null;
        } else {
          const [ownedStudent] = await db.select({ id: studentsTable.id }).from(studentsTable).where(and(
            eq(studentsTable.id, strong.id),
            eq(studentsTable.agentId, widget.agentId),
            isNull(studentsTable.deletedAt),
          )).limit(1);
          if (!ownedStudent) strong = null;
        }
      }
      let leadId: number | null = strong?.type === "lead" ? strong.id : null;
      const studentId: number | null = strong?.type === "student" ? strong.id : null;
      if (!leadId && !studentId) {
        const partnerExtras = await widgetPartnerExtras(widget.agentId);
        const upsert = await findOrUpsertEmbedLead({
          slug,
          ip: req.ip,
          fields: {
            firstName: tlu(cleanFirstName, 100)!,
            lastName: tlu(cleanLastName, 100)!,
            email: cleanEmail,
            phone: phoneE164,
            phoneE164,
            interestedUniversity: selectedUniversityNames.length
              ? selectedUniversityNames.join(", ")
              : undefined,
            sourcePageUrl: pageUrl,
            notes: `AI chatbot source: ${website || pageUrl || slug}`,
          },
          extras: partnerExtras,
        });
        leadId = upsert.lead.id;
      }

      const sessionId = crypto.randomUUID();
      const externalId = `embed-chat:${slug}:${sessionId}`;
      const [contact] = await db
        .insert(externalContactsTable)
        .values({
          channel: "web_chat",
          externalId,
          displayName,
          phone: phoneE164,
          phoneE164,
          email: cleanEmail,
          leadId,
          studentId,
          metadata: {
            widgetId: widget.id,
            widgetSlug: slug,
            sourcePageUrl: pageUrl,
            sourceWebsite: website,
            language: chatLocale,
          },
        })
        .returning();

      const scope: ChatScopeMetadata = {
        widgetId: widget.id,
        widgetSlug: slug,
        universityScope: universityScope.mode,
        universityIds: scopedUniversities.map((university) => university.id),
        universityNames: selectedUniversityNames,
        universityId: primaryUniversity?.id ?? null,
        universityName: primaryUniversity?.name ?? null,
        universityCountry: scopeCountry || null,
        universityCountryCode: universityCountryCode || null,
        presetCountry: presetScopeFilters.country || null,
        presetCity: presetScopeFilters.city || null,
        presetUniversityType: presetScopeFilters.universityType || null,
        presetLevel: presetScopeFilters.level || null,
        presetLanguage: presetScopeFilters.language || null,
        presetField: presetScopeFilters.field || null,
        sourcePageUrl: pageUrl,
        sourceWebsite: website,
        assistantName,
        language: chatLocale,
      };
      const externalThreadId = `chat:${slug}:${sessionId}`;
      const [conversation] = await db
        .insert(conversationsTable)
        .values({
          type: "external",
          title: displayName,
          channel: "web_chat",
          aiBotId: widget.aiBotId,
          communicationPipelineId: widget.communicationPipelineId,
          externalContactId: contact.id,
          externalThreadId,
          unmatched: false,
          status: "open",
          botEnabled: widget.aiBotId != null,
          metadata: {
            source: "web_chat",
            chatbotScope: scope,
          },
        })
        .returning();

      const greeting =
        theme.welcomeMessage ||
        chatCopy.greeting(cleanFirstName, scopeDisplayName);
      const [greetingMessage] = await db
        .insert(messagesTable)
        .values({
          conversationId: conversation.id,
          senderId: null,
          content: greeting,
          channel: "web_chat",
          direction: "outbound",
          status: "sent",
          sentAt: new Date(),
          metadata: widget.aiBotId != null
            ? { botSent: true, botGreeting: true }
            : { systemGreeting: true },
        })
        .returning();
      await db
        .update(conversationsTable)
        .set({ lastMessageAt: new Date(), lastMessagePreview: greeting.slice(0, 200) })
        .where(eq(conversationsTable.id, conversation.id));
      inboxBus.publish({
        type: "message",
        conversationId: conversation.id,
        channel: "web_chat",
        assignedToId: null,
        unmatched: false,
        direction: "outbound",
      });

      res.status(201).json({
        success: true,
        sessionToken: createEmbedChatSessionToken(
          getEmbedSigningSecret(),
          slug,
          sessionId,
          conversation.id,
        ),
        assistantName,
        universityName: scopeDisplayName,
        logoUrl: theme.logoUrl || primaryUniversity?.logoUrl || null,
        greeting: {
          id: greetingMessage.id,
          content: greetingMessage.content,
          direction: greetingMessage.direction,
          createdAt: greetingMessage.createdAt,
        },
      });
    } catch (err) {
      console.error("[EMBED CHAT] session creation failed:", err);
      res.status(500).json({ error: "Could not start the chat." });
    }
  },
);

router.get(
  "/public/embed/:slug/chat/messages",
  embedChatLimiter,
  async (req, res): Promise<void> => {
    const slug = String(req.params.slug);
    const session = await loadChatSessionConversation(slug, req.query.s as string | undefined);
    if (!session) {
      res.status(403).json({ error: "Invalid or expired chat session" });
      return;
    }
    const afterId = Math.max(0, Number(req.query.after || 0) || 0);
    const rows = await db
      .select({
        id: messagesTable.id,
        content: messagesTable.content,
        direction: messagesTable.direction,
        status: messagesTable.status,
        createdAt: messagesTable.createdAt,
        metadata: messagesTable.metadata,
      })
      .from(messagesTable)
      .where(and(
        eq(messagesTable.conversationId, session.conversation.id),
        sql`${messagesTable.id} > ${afterId}`,
      ))
      .orderBy(asc(messagesTable.id))
      .limit(100);
    res.json({
      data: rows.map(publicChatMessage),
      botEnabled: session.conversation.botEnabled,
      needsHuman: session.conversation.needsHuman,
    });
  },
);

router.post(
  "/public/embed/:slug/chat/messages",
  embedChatLimiter,
  embedChatJson,
  async (req, res): Promise<void> => {
    const slug = String(req.params.slug);
    const session = await loadChatSessionConversation(slug, req.query.s as string | undefined);
    if (!session) {
      res.status(403).json({ error: "Invalid or expired chat session" });
      return;
    }
    const content = sanitizeChatText(req.body?.content, 2000);
    if (!content) {
      res.status(400).json({ error: "Message is required" });
      return;
    }
    const [contact] = session.conversation.externalContactId
      ? await db
          .select()
          .from(externalContactsTable)
          .where(eq(externalContactsTable.id, session.conversation.externalContactId))
      : [null];
    if (!contact) {
      res.status(409).json({ error: "Chat contact no longer exists" });
      return;
    }
    try {
      const externalMessageId = `webchat:${crypto.randomUUID()}`;
      const inbound = await processInboundMessage({
        channel: "web_chat",
        channelAccountId: null,
        contact: {
          externalId: contact.externalId,
          displayName: contact.displayName,
          phone: contact.phoneE164 || contact.phone,
          email: contact.email,
        },
        message: {
          externalMessageId,
          externalThreadId: session.conversation.externalThreadId,
          text: content,
          receivedAt: new Date(),
          metadata: {
            widgetId: session.scope.widgetId,
            widgetSlug: slug,
            sourcePageUrl: session.scope.sourcePageUrl,
            sourceWebsite: session.scope.sourceWebsite,
          },
        },
      });
      const outcome = session.conversation.aiBotId != null
        ? await maybeAutoReply({
            conversationId: inbound.conversationId,
            inboundMessageId: inbound.messageId,
          })
        : { status: "disabled" as const };
      const rows = await db
        .select({
          id: messagesTable.id,
          content: messagesTable.content,
          direction: messagesTable.direction,
          status: messagesTable.status,
          createdAt: messagesTable.createdAt,
          metadata: messagesTable.metadata,
        })
        .from(messagesTable)
        .where(and(
          eq(messagesTable.conversationId, session.conversation.id),
          sql`${messagesTable.id} >= ${inbound.messageId}`,
        ))
        .orderBy(asc(messagesTable.id))
        .limit(20);
      res.status(201).json({ data: rows.map(publicChatMessage), outcome });
    } catch (err) {
      console.error("[EMBED CHAT] message failed:", err);
      res.status(500).json({ error: "Message could not be sent." });
    }
  },
);

router.post(
  "/public/embed/:slug/chat/media",
  embedChatUploadLimiter,
  embedChatMediaBody,
  async (req, res): Promise<void> => {
    const slug = String(req.params.slug);
    const session = await loadChatSessionConversation(slug, req.query.s as string | undefined);
    if (!session) {
      res.status(403).json({ error: "Invalid or expired chat session" });
      return;
    }
    const [contact] = session.conversation.externalContactId
      ? await db
          .select()
          .from(externalContactsTable)
          .where(eq(externalContactsTable.id, session.conversation.externalContactId))
      : [null];
    if (!contact) {
      res.status(409).json({ error: "Chat contact no longer exists" });
      return;
    }

    const filename = decodeChatHeader(req.headers["x-file-name"], 180);
    const caption = sanitizeChatText(decodeChatHeader(req.headers["x-caption"], 2000), 2000);
    const voiceNote = String(req.headers["x-voice-note"] || "") === "1";
    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    let storedPath: string | null = null;
    try {
      const validated = await validateWebChatMedia(
        buffer,
        filename,
        String(req.headers["content-type"] || ""),
      );
      storedPath = await embedChatMediaStorage.uploadBuffer({
        subdir: `inbox/web-chat/${session.conversation.id}`,
        filename: validated.filename,
        buffer,
        contentType: validated.mimeType,
      });
      const attachment: WebChatAttachment = {
        url: privateWebChatAttachmentUrl(storedPath),
        type: validated.kind,
        name: validated.filename,
        mimeType: validated.mimeType,
        fileType: validated.mimeType,
        fileSize: validated.size,
        ...(voiceNote && validated.kind === "audio" ? { voiceNote: true } : {}),
      };
      const inbound = await processInboundMessage({
        channel: "web_chat",
        channelAccountId: null,
        contact: {
          externalId: contact.externalId,
          displayName: contact.displayName,
          phone: contact.phoneE164 || contact.phone,
          email: contact.email,
        },
        message: {
          externalMessageId: `webchat:${crypto.randomUUID()}`,
          externalThreadId: session.conversation.externalThreadId,
          text: caption || "[attachment]",
          receivedAt: new Date(),
          metadata: {
            widgetId: session.scope.widgetId,
            widgetSlug: slug,
            sourcePageUrl: session.scope.sourcePageUrl,
            sourceWebsite: session.scope.sourceWebsite,
            attachments: [attachment],
          },
        },
      });
      const outcome = caption
        ? await maybeAutoReply({
            conversationId: inbound.conversationId,
            inboundMessageId: inbound.messageId,
          })
        : null;
      const rows = await db
        .select({
          id: messagesTable.id,
          content: messagesTable.content,
          direction: messagesTable.direction,
          status: messagesTable.status,
          createdAt: messagesTable.createdAt,
          metadata: messagesTable.metadata,
        })
        .from(messagesTable)
        .where(and(
          eq(messagesTable.conversationId, session.conversation.id),
          sql`${messagesTable.id} >= ${inbound.messageId}`,
        ))
        .orderBy(asc(messagesTable.id))
        .limit(20);
      res.status(201).json({ data: rows.map(publicChatMessage), outcome });
    } catch (error) {
      if (storedPath) {
        try {
          const file = await embedChatMediaStorage.getObjectEntityFile(storedPath);
          await file.delete({ ignoreNotFound: true });
        } catch {
          // Best-effort orphan cleanup. The original error remains authoritative.
        }
      }
      if (error instanceof WebChatMediaValidationError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      console.error("[EMBED CHAT] media message failed:", error);
      res.status(500).json({ error: "The file could not be sent." });
    }
  },
);

router.get(
  "/public/embed/:slug/chat/media/:messageId/:index",
  embedChatLimiter,
  async (req, res): Promise<void> => {
    const slug = String(req.params.slug);
    const session = await loadChatSessionConversation(slug, req.query.s as string | undefined);
    if (!session) {
      res.status(403).json({ error: "Invalid or expired chat session" });
      return;
    }
    const messageId = Number(req.params.messageId);
    const index = Number(req.params.index);
    if (!Number.isInteger(messageId) || !Number.isInteger(index) || index < 0 || index > 20) {
      res.status(400).json({ error: "Invalid media request" });
      return;
    }
    const [message] = await db
      .select({ metadata: messagesTable.metadata })
      .from(messagesTable)
      .where(and(
        eq(messagesTable.id, messageId),
        eq(messagesTable.conversationId, session.conversation.id),
      ))
      .limit(1);
    const attachment = message ? readWebChatAttachments(message.metadata)[index] : null;
    const objectPath = attachment
      ? webChatObjectPath(attachment.url, session.conversation.id)
      : null;
    if (!attachment || !objectPath) {
      res.status(404).json({ error: "Media not found" });
      return;
    }
    try {
      const file = await embedChatMediaStorage.getObjectEntityFile(objectPath);
      const disposition = attachment.type === "file" && attachment.mimeType !== "application/pdf"
        ? "attachment"
        : "inline";
      res.setHeader("Content-Disposition", `${disposition}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`);
      res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("X-Content-Type-Options", "nosniff");
      await embedChatMediaStorage.streamObjectToResponse(req, res, file, {
        contentType: attachment.mimeType,
        cacheControl: "private, max-age=300",
      });
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        res.status(404).json({ error: "Media not found" });
        return;
      }
      console.error(`[EMBED CHAT] media read failed for ${messageId}[${index}]:`, error);
      if (!res.headersSent) res.status(500).json({ error: "Media could not be loaded" });
    }
  },
);

router.post(
  "/public/embed/:slug/chat/handoff",
  embedChatLimiter,
  embedChatJson,
  async (req, res): Promise<void> => {
    const slug = String(req.params.slug);
    const session = await loadChatSessionConversation(slug, req.query.s as string | undefined);
    if (!session) {
      res.status(403).json({ error: "Invalid or expired chat session" });
      return;
    }
    await db
      .update(conversationsTable)
      .set({ botEnabled: false, needsHuman: true, status: "open" })
      .where(eq(conversationsTable.id, session.conversation.id));
    const [message] = await db
      .insert(messagesTable)
      .values({
        conversationId: session.conversation.id,
        senderId: null,
        content: getEmbedChatCopy(session.scope.language || "en").handoffStaffEvent,
        channel: "web_chat",
        direction: "inbound",
        status: "received",
        sentAt: new Date(),
        metadata: { handoffRequested: true, systemEvent: true },
      })
      .returning();
    await db
      .update(conversationsTable)
      .set({
        lastMessageAt: new Date(),
        lastMessagePreview: message.content,
        lastInboundAt: new Date(),
      })
      .where(eq(conversationsTable.id, session.conversation.id));
    inboxBus.publish({
      type: "message",
      conversationId: session.conversation.id,
      channel: "web_chat",
      assignedToId: session.conversation.assignedToId ?? null,
      unmatched: session.conversation.unmatched,
      direction: "inbound",
    });
    res.json({ success: true });
  },
);

router.get("/public/embed/:slug/widget", async (req, res): Promise<void> => {
  const slug = String(req.params.slug);
  const [widget] = await db.select().from(embedWidgetsTable).where(and(eq(embedWidgetsTable.slug, slug), eq(embedWidgetsTable.isActive, true)));
  if (!widget) { res.status(404).send("Widget not found"); return; }

  // The widget HTML shell is served openly so the iframe renders the widget's
  // own "Unable to load widget" state when the token is missing or invalid,
  // rather than a bare browser 403 page.  All actual data (config, programs,
  // apply) is gated by checkEmbedAccess() on the respective JSON endpoints
  // and requires a valid HMAC session token (obtained via /token with the widget
  // API key header — see the backend-mediated token issuance endpoint).
  const baseUrl = getBaseUrl(req);
  // Source phone dial codes from the active country catalog so the AI chatbot
  // and the application widgets use one centrally managed picker.
  const dialRows = await db
    .select({ code: countriesTable.code, name: countriesTable.name, dialCode: countriesTable.dialCode })
    .from(countriesTable)
    .where(and(eq(countriesTable.isActive, true), isNotNull(countriesTable.dialCode)))
    .orderBy(countriesTable.name);
  const dialCodes: [string, string, string][] = dialRows
    .filter((row) => row.dialCode)
    .map((row) => [row.dialCode as string, row.code, row.name]);
  if (widget.mode === "ai_chatbot") {
    const universityScope = resolveEmbedUniversityScope(widget.presetFilters);
    if (!isValidEmbedUniversityScope(widget.presetFilters)) {
      res.status(409).send("Selected university scope requires at least one university");
      return;
    }
    const scopedUniversities = universityScope.mode === "selected"
      ? await db
          .select({ id: universitiesTable.id, name: universitiesTable.name, logoUrl: universitiesTable.logoUrl })
          .from(universitiesTable)
          .where(and(
            inArray(universitiesTable.id, universityScope.universityIds),
            eq(universitiesTable.isActive, true),
          ))
      : [];
    if (
      universityScope.mode === "selected" &&
      scopedUniversities.length !== universityScope.universityIds.length
    ) {
      res.status(409).send("One or more selected universities are unavailable");
      return;
    }
    const primaryUniversity = scopedUniversities.length === 1 ? scopedUniversities[0] : null;
    const chatTheme = sanitizeTheme(widget.theme);
    const university = primaryUniversity || {
      id: 0,
      name: chatTheme.assistantName || widget.name || "Find & Study",
      logoUrl: null,
    };
    const chatLocale = resolveEmbedChatLocale(
      req.query.lang,
      localeFromPublicUrl(req.headers.referer),
      req.headers["accept-language"],
    );
    let chatHtml = generateChatbotWidgetHTML(
      slug,
      baseUrl,
      widget,
      university,
      chatLocale,
      dialCodes,
    );
    chatHtml = chatHtml.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
    try {
      const script = chatHtml.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1];
      if (script) {
        parseJavaScript(script, { ecmaVersion: "latest", sourceType: "script" });
      }
    } catch (err) {
      console.error("[EMBED CHAT] inline script invalid:", err);
      res.status(500).send("Chat widget is temporarily unavailable");
      return;
    }
    res.setHeader("Content-Type", "text/html");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.send(chatHtml);
    return;
  }
  const docMeta = await loadDocCatalogForEmbed();
  const widgetLocale = resolveEmbedChatLocale(
    req.query.lang,
    localeFromPublicUrl(req.headers.referer),
    req.headers["accept-language"],
  );
  let html = generateWidgetHTML(slug, baseUrl, widget, docMeta, dialCodes, widgetLocale);
    // SAFETY GUARD (widget fragility): strip control chars the HTML parser rewrites, which
    // can corrupt the inline widget <script> - a stray NUL (U+0000) becomes U+FFFD and yields
    // a "Range out of order in character class" SyntaxError that blanks the whole widget.
    html = html.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
    try {
      const _m = html.match(/<script[^>]*>([\s\S]*?)<\/script>/);
      if (_m) {
        parseJavaScript(_m[1], { ecmaVersion: "latest", sourceType: "script" });
      }
    } catch (_e) {
      console.error("[EMBED WIDGET] inline script INVALID JS after generation - widget would render blank:", (_e as Error).message);
    }
  res.setHeader("Content-Type", "text/html");
  // No-cache so widget fixes propagate instantly (no stale/broken version served
  // from browser or CDN cache for up to an hour).
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.send(html);
});

// Doc-catalog loader/invalidator now lives in `src/lib/docCatalog.ts` so
// both the embed widget (this file) and the bulk-program Excel importer
// (`catalog.ts`) share a single cache, key-whitelist and invalidation hook
// — see Task #179.
import { loadDocCatalog as loadDocCatalogForEmbed, invalidateDocCatalog as invalidateDocCatalogCache, type DocCatalogEntry } from "../lib/docCatalog";
export { invalidateDocCatalogCache };
export type { DocCatalogEntry };

router.get("/public/embed/embed.js", async (_req, res): Promise<void> => {
  const baseUrl = getBaseUrl(_req);
  const js = generateEmbedScript(baseUrl);
  res.setHeader("Content-Type", "application/javascript");
  // No-cache so embed loader fixes propagate instantly.
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.send(js);
});

function generateEmbedScript(baseUrl: string): string {
  return `(function(){
  var containers = document.querySelectorAll('[data-edcons-widget]');
  containers.forEach(function(el) {
    var slug = el.getAttribute('data-edcons-widget');
    if (!slug) return;
    // data-edcons-token-url is the URL of the partner's backend endpoint that
    // returns {"token":"<session-token>"}.  The partner's server holds the
    // long-lived widget API key and exchanges it server-to-server for a session
    // token using the X-Widget-Api-Key header — the secret never appears here.
    // For open widgets (no allowedDomains), this attribute is optional; the
    // loader falls back to calling /token directly (no key needed).
    var tokenUrl = el.getAttribute('data-edcons-token-url') || '';
    var iframe = document.createElement('iframe');
    iframe.style.width = '100%';
    iframe.style.border = 'none';
    iframe.style.background = 'transparent';
    iframe.style.boxShadow = 'none';
    iframe.style.filter = 'none';
    iframe.style.display = 'block';
    iframe.setAttribute('allowtransparency', 'true');
    // The collapsed chatbot iframe is intentionally larger than the circular
    // launcher so its focus/click target remains accessible. Keep that host
    // canvas transparent instead of showing a square tile behind the button.
    el.style.background = 'transparent';
    el.style.boxShadow = 'none';
    // No artificial minimum: the iframe must size itself to the widget's
    // actual content. The widget's own resizeParent() reports a height that
    // already includes any open modal or dropdown overlays, so a fixed
    // 780px floor here only produced empty space below the form.
    iframe.style.minHeight = '0';
    iframe.setAttribute('loading', 'lazy');
    iframe.setAttribute('allowfullscreen', 'true');
    // Camera and microphone access must be explicitly delegated to a
    // cross-origin widget iframe. Native file/camera capture remains available
    // as a fallback when a browser declines MediaRecorder support.
    iframe.setAttribute('allow', 'camera; microphone; fullscreen');
    var supportedLanguages=['en','tr','ar','fa','fr','es','ru','zh','hi','id','ur','tk','ky','kk','uz','tg'];
    function normalizePageLanguage(raw) {
      if (!raw || typeof raw !== 'string') return '';
      var first=raw.trim().toLowerCase().replace(/_/g,'-').split(',')[0].split(';')[0];
      var base=(first||'').split('-')[0];
      return supportedLanguages.indexOf(base)>=0?base:'';
    }
    function detectPageLanguage() {
      var pathLanguage='';
      try { pathLanguage=location.pathname.split('/').filter(Boolean)[0]||''; } catch(e) {}
      return normalizePageLanguage(el.getAttribute('data-edcons-lang')) ||
        normalizePageLanguage(pathLanguage) ||
        normalizePageLanguage(document.documentElement.lang) ||
        normalizePageLanguage(navigator.language) ||
        'en';
    }
    var pageLanguage=detectPageLanguage();
    // Fetch a short-lived HMAC session token for this widget.  For restricted
    // widgets the token is obtained via the partner's own backend endpoint
    // (data-edcons-token-url), which holds the long-lived API key and exchanges
    // it server-to-server.  Open (unrestricted) widgets call /token directly.
    // The session token is passed into the iframe URL and validated server-side
    // on all data endpoints.
    function mountIframe(token) {
      var src = '${baseUrl}/api/public/embed/' + slug + '/widget';
      var query=['lang='+encodeURIComponent(pageLanguage)];
      if (token) query.push('t='+encodeURIComponent(token));
      iframe.src = src+'?'+query.join('&');
      iframe.lang = pageLanguage;
      el.appendChild(iframe);
    }
    try {
      var resolvedTokenUrl = tokenUrl || '${baseUrl}/api/public/embed/' + slug + '/token';
      fetch(resolvedTokenUrl, {credentials:'omit'})
        .then(function(r){ return r.ok ? r.json() : null; })
        .then(function(d){ mountIframe(d && d.token ? d.token : ''); })
        .catch(function(){ mountIframe(''); });
    } catch(e) { mountIframe(''); }
    var savedScroll = null;
    var savedBodyStyle = null;
    var rafScheduled = false;
    var scrollGuardActive = false;
    function scrollGuardLoop(){
      if (!scrollGuardActive) return;
      if (savedScroll !== null && Math.abs(window.pageYOffset - savedScroll) > 1) {
        window.scrollTo(0, savedScroll);
      }
      var raf = window.requestAnimationFrame || function(cb){return setTimeout(cb,16);};
      raf(scrollGuardLoop);
    }
    function getIframeTop(){
      try{
        var rect = iframe.getBoundingClientRect();
        var sy = window.pageYOffset || document.documentElement.scrollTop || 0;
        if (savedScroll !== null) return rect.top + savedScroll;
        return rect.top + sy;
      }catch(e){return 0;}
    }
    function sendViewport(){
      try{
        if (!iframe.contentWindow) return;
        var rect = iframe.getBoundingClientRect();
        var scrollY = savedScroll !== null ? savedScroll : (window.pageYOffset || document.documentElement.scrollTop || 0);
        iframe.contentWindow.postMessage({
          type: 'edcons-viewport',
          slug: slug,
          parentScrollY: scrollY,
          parentViewportHeight: window.innerHeight || document.documentElement.clientHeight || 0,
          iframeTop: getIframeTop(),
          iframeHeight: rect.height
        }, '*');
      }catch(e){}
    }
    function scheduleSendViewport(){
      if (rafScheduled) return;
      rafScheduled = true;
      var raf = window.requestAnimationFrame || function(cb){return setTimeout(cb,16);};
      raf(function(){ rafScheduled = false; sendViewport(); });
    }
    function lockScroll(){
      if (savedBodyStyle !== null) return;
      var html = document.documentElement;
      var b = document.body;
      savedScroll = window.pageYOffset || html.scrollTop || 0;
      savedBodyStyle = {
        position: b.style.position,
        top: b.style.top,
        left: b.style.left,
        right: b.style.right,
        width: b.style.width,
        overflow: b.style.overflow,
        htmlOverflow: html.style.overflow,
        touchAction: b.style.touchAction
      };
      b.style.position = 'fixed';
      b.style.top = '-' + savedScroll + 'px';
      b.style.left = '0';
      b.style.right = '0';
      b.style.width = '100%';
      b.style.overflow = 'hidden';
      html.style.overflow = 'hidden';
      b.style.touchAction = 'none';
      if (!scrollGuardActive) {
        scrollGuardActive = true;
        var raf = window.requestAnimationFrame || function(cb){return setTimeout(cb,16);};
        raf(scrollGuardLoop);
      }
    }
    function unlockScroll(){
      if (savedBodyStyle === null) return;
      var html = document.documentElement;
      var b = document.body;
      b.style.position = savedBodyStyle.position;
      b.style.top = savedBodyStyle.top;
      b.style.left = savedBodyStyle.left;
      b.style.right = savedBodyStyle.right;
      b.style.width = savedBodyStyle.width;
      b.style.overflow = savedBodyStyle.overflow;
      html.style.overflow = savedBodyStyle.htmlOverflow;
      b.style.touchAction = savedBodyStyle.touchAction;
      savedBodyStyle = null;
      var s = savedScroll;
      function snap(){ if (s !== null) window.scrollTo(0, s); }
      snap();
      var raf = window.requestAnimationFrame || function(cb){return setTimeout(cb,16);};
      raf(snap);
      setTimeout(snap, 50);
      setTimeout(snap, 200);
      setTimeout(snap, 500);
      setTimeout(function(){
        scrollGuardActive = false;
        savedScroll = null;
      }, 1500);
    }
    window.addEventListener('message', function(e) {
      if (e.source !== iframe.contentWindow) return;
      var d = e.data;
      if (!d || d.slug !== slug) return;
      if (d.type === 'edcons-resize') {
        iframe.style.height = d.height + 'px';
      } else if (d.type === 'edcons-chatbot-ready' || d.type === 'edcons-chatbot-layout') {
        var open = !!d.open;
        iframe.style.position = 'fixed';
        iframe.style.right = open ? '10px' : '12px';
        iframe.style.bottom = open ? '10px' : '12px';
        iframe.style.zIndex = '2147483000';
        iframe.style.background = 'transparent';
        iframe.style.boxShadow = 'none';
        iframe.style.filter = 'none';
        iframe.style.width = open ? 'min(410px, 100vw)' : '84px';
        iframe.style.height = open ? 'min(640px, 100vh)' : '84px';
        iframe.style.maxWidth = '100vw';
        iframe.style.maxHeight = '100vh';
        iframe.style.colorScheme = 'light';
        iframe.setAttribute('title', 'University application chat assistant');
      } else if (d.type === 'edcons-modal-open') {
        try{
          // Always scroll the iframe top to the top of the host viewport
          // when the modal opens. With dynamic resize the iframe can be
          // 1500-3000px tall while the viewport is only ~800px, so even
          // when the iframe bottom is partially visible the modal (which
          // anchors itself near the visible top of the iframe) ends up
          // above or far below the user's actual viewport. Snapping the
          // iframe top to the viewport top guarantees the modal lands in
          // the visible area on every device, then lockScroll keeps the
          // host page from drifting while the modal is open.
          iframe.scrollIntoView({block: 'start'});
        }catch(err){}
        lockScroll();
        sendViewport();
        setTimeout(sendViewport, 120);
        setTimeout(sendViewport, 400);
      } else if (d.type === 'edcons-modal-close') {
        unlockScroll();
      } else if (d.type === 'edcons-viewport-request') {
        sendViewport();
      }
    });
    window.addEventListener('scroll', scheduleSendViewport, {passive:true});
    window.addEventListener('resize', scheduleSendViewport);
    window.addEventListener('orientationchange', scheduleSendViewport);
    iframe.addEventListener('load', function(){
      sendViewport();
      setTimeout(sendViewport, 200);
    });
  });
})();`;
}

function htmlEscape(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function generateChatbotWidgetHTML(
  slug: string,
  baseUrl: string,
  widget: any,
  university: { id: number; name: string; logoUrl: string | null },
  locale: EmbedChatLocale = "en",
  dialCodes: [string, string, string][] = [],
): string {
  const theme = sanitizeTheme(widget.theme);
  const copy = getEmbedChatCopy(locale);
  const primaryColor = theme.primaryColor || "#123f9c";
  const buttonColor = theme.buttonColor || primaryColor;
  const radius = theme.borderRadius || "18px";
  const logoUrl = theme.logoUrl || publicUniversityLogoPath(university.id, university.logoUrl);
  const assistantName =
    theme.assistantName || copy.assistantName(university.name);
  const safeConfig = JSON.stringify({
    slug,
    baseUrl,
    universityName: university.name,
    assistantName,
    logoUrl,
    locale,
    dir: copy.dir,
    dialCodes,
    mediaAccept: webChatMediaAcceptAttribute(),
    mediaMaxBytes: WEB_CHAT_MEDIA_MAX_BYTES,
    copy: {
      genericError: copy.genericError,
      startError: copy.startError,
      countryCode: copy.countryCode,
      countrySearch: copy.countrySearch,
      countryNoMatches: copy.countryNoMatches,
      phoneInvalid: copy.phoneInvalid,
      sendError: copy.sendError,
      enterContactFirst: copy.enterContactFirst,
      humanNotified: copy.humanNotified,
      sentToTeam: copy.sentToTeam,
      handoffSent: copy.handoffSent,
      handoffError: copy.handoffError,
    },
  }).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="${locale}" dir="${copy.dir}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
  <title>${htmlEscape(assistantName)}</title>
  <style>
    :root{--primary:${primaryColor};--button:${buttonColor};--radius:${radius};--ink:#101828;--muted:#667085;--line:#e4e7ec;--soft:#f6f8fc}
    *{box-sizing:border-box}
    html,body{margin:0;background:transparent;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink)}
    body{min-height:76px}
    button,input,textarea{font:inherit}
    #root{position:fixed;right:8px;bottom:8px;width:min(390px,calc(100vw - 16px));z-index:10}
    .launcher{margin-left:auto;width:62px;height:62px;border:0;border-radius:50%;background:var(--button);color:#fff;display:grid;place-items:center;cursor:pointer;box-shadow:none;filter:none}
    .launcher svg{width:28px;height:28px}
    .panel{display:none;height:min(620px,calc(100vh - 18px));background:#fff;border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;box-shadow:0 22px 60px rgba(16,24,40,.24);grid-template-rows:auto 1fr auto}
    .panel.open{display:grid}
    .header{background:linear-gradient(135deg,var(--primary),var(--button));padding:14px 14px 13px;color:#fff;display:grid;grid-template-columns:44px 1fr auto;gap:10px;align-items:center}
    .brand-logo{width:44px;height:44px;border-radius:12px;background:#fff;object-fit:contain;padding:4px}
    .brand-fallback{width:44px;height:44px;border-radius:12px;background:rgba(255,255,255,.2);display:grid;place-items:center;font-weight:800;font-size:19px}
    .header-title{font-weight:750;font-size:14px;line-height:1.25}
    .header-sub{font-size:11px;opacity:.86;margin-top:3px}
    .header-actions{display:flex;gap:4px}
    .icon-btn{border:0;background:rgba(255,255,255,.16);color:#fff;width:34px;height:34px;border-radius:10px;cursor:pointer;display:grid;place-items:center}
    .content{min-height:0;overflow-y:auto;background:var(--soft);padding:14px}
    .intro{background:#fff;border:1px solid var(--line);border-radius:14px;padding:14px;margin-bottom:12px}
    .intro h3{font-size:15px;margin:0 0 5px}
    .intro p{font-size:12px;color:var(--muted);margin:0;line-height:1.5}
    .form{display:grid;gap:9px}
    .form-row{display:grid;grid-template-columns:1fr 1fr;gap:8px}
    label{font-size:11px;font-weight:700;color:#344054}
    input{width:100%;border:1px solid #d0d5dd;border-radius:10px;padding:10px 11px;margin-top:4px;outline:none;background:#fff}
    input:focus,textarea:focus{border-color:var(--primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--primary) 14%,transparent)}
    .phone-label{display:block;font-size:11px;font-weight:700;color:#344054}
    .phone-group{display:grid;grid-template-columns:minmax(116px,132px) 1fr;gap:8px;margin-top:4px}
    .phone-group>input{margin-top:0;min-width:0}
    .dial-picker{position:relative;min-width:0}
    .dial-trigger{width:100%;height:39px;border:1px solid #d0d5dd;border-radius:10px;background:#fff;color:#344054;padding:0 9px;display:flex;align-items:center;gap:6px;cursor:pointer;text-align:start}
    .dial-trigger:focus{outline:none;border-color:var(--primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--primary) 14%,transparent)}
    .dial-flag{width:20px;height:15px;border-radius:2px;object-fit:cover;box-shadow:0 0 0 1px rgba(16,24,40,.08);flex:0 0 auto}
    .dial-current{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:650}
    .dial-chevron{margin-inline-start:auto;color:#667085;font-size:10px}
    .dial-menu{display:none;position:absolute;z-index:30;inset-inline-start:0;top:44px;width:min(290px,calc(100vw - 48px));background:#fff;border:1px solid var(--line);border-radius:12px;box-shadow:0 14px 32px rgba(16,24,40,.18);padding:8px}
    .dial-menu.open{display:block}
    .dial-search{margin:0 0 7px;padding:9px 10px}
    .dial-options{max-height:190px;overflow:auto;display:grid;gap:2px}
    .dial-option{border:0;background:#fff;border-radius:8px;padding:8px;display:grid;grid-template-columns:22px 1fr auto;gap:7px;align-items:center;cursor:pointer;color:#344054;text-align:start}
    .dial-option:hover,.dial-option:focus{outline:none;background:#f2f4f7}
    .dial-name{font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .dial-code{font-size:11px;font-weight:750;color:var(--primary)}
    .dial-empty{display:none;padding:10px;text-align:center;color:var(--muted);font-size:11px}
    .field-error{display:none;color:#b42318;font-size:10px;margin-top:5px}
    .primary-btn{border:0;border-radius:11px;background:var(--button);color:#fff;font-weight:750;padding:11px 15px;cursor:pointer}
    .primary-btn:disabled{opacity:.55;cursor:wait}
    #messages{display:none;flex-direction:column;gap:8px}
    .message{max-width:84%;border-radius:14px;padding:10px 12px;font-size:13px;line-height:1.45;white-space:pre-wrap;word-break:break-word}
    .message.inbound{align-self:flex-end;background:var(--primary);color:#fff;border-bottom-right-radius:4px}
    .message.outbound{align-self:flex-start;background:#fff;border:1px solid var(--line);border-bottom-left-radius:4px}
    .message-media{display:grid;gap:6px;margin-top:6px;white-space:normal}
    .message-media:first-child{margin-top:0}
    .message-media img,.message-media video{display:block;max-width:100%;max-height:230px;border-radius:10px;background:#0b1220;object-fit:contain}
    .message-media audio{display:block;width:240px;max-width:100%;height:36px}
    .file-card{display:flex;align-items:center;gap:8px;min-width:190px;padding:8px;border-radius:10px;background:rgba(255,255,255,.13);color:inherit;text-decoration:none;border:1px solid rgba(127,127,127,.22)}
    .outbound .file-card{background:var(--soft);color:var(--ink)}
    .file-icon{width:34px;height:34px;border-radius:8px;background:rgba(255,255,255,.18);display:grid;place-items:center;font-weight:800;font-size:10px;flex:0 0 auto}
    .file-meta{min-width:0}.file-name{font-size:11px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.file-size{font-size:9px;opacity:.7;margin-top:2px}
    .message-time{font-size:9px;opacity:.65;margin-top:4px;text-align:right}
    .typing{display:none;align-self:flex-start;background:#fff;border:1px solid var(--line);border-radius:14px;padding:9px 12px;font-size:11px;color:var(--muted)}
    .composer{display:none;background:#fff;border-top:1px solid var(--line);padding:8px 10px 10px;grid-template-columns:1fr;gap:7px}
    .composer-row{display:grid;grid-template-columns:auto auto auto minmax(0,1fr) auto;gap:5px;align-items:end}
    .compose-tool{width:36px;height:42px;border:0;border-radius:10px;background:var(--soft);color:var(--ink);cursor:pointer;display:grid;place-items:center;font-size:17px}
    .compose-tool.recording{background:#fee4e2;color:#b42318;animation:pulse 1.2s infinite}
    @keyframes pulse{50%{opacity:.55}}
    .pending-media{display:none;gap:6px;overflow-x:auto;padding-bottom:1px}
    .pending-item{display:flex;align-items:center;gap:5px;max-width:220px;border:1px solid var(--line);background:var(--soft);border-radius:9px;padding:5px 7px;font-size:10px}
    .pending-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.pending-remove{border:0;background:none;color:#b42318;cursor:pointer;padding:0 2px}
    .upload-state{display:none;align-items:center;gap:7px;font-size:10px;color:var(--muted)}
    .upload-track{height:5px;background:var(--line);border-radius:99px;overflow:hidden;flex:1}.upload-bar{height:100%;width:0;background:var(--primary);transition:width .15s}
    .upload-cancel{border:0;background:none;color:#b42318;cursor:pointer;font-size:10px}
    textarea{resize:none;min-height:42px;max-height:94px;border:1px solid #d0d5dd;border-radius:12px;padding:10px 11px;outline:none}
    .send{width:42px;height:42px;border:0;border-radius:12px;background:var(--button);color:#fff;cursor:pointer;font-size:18px}
    .status{font-size:11px;color:var(--muted);text-align:center;padding:5px}
    .error{font-size:11px;color:#b42318;background:#fef3f2;border-radius:8px;padding:8px;display:none}
    @media(max-width:520px){#root{right:0;bottom:0;width:100vw}.panel{height:100dvh;border-radius:0;border:0}.launcher{margin-right:12px;margin-bottom:12px}.phone-group{grid-template-columns:116px 1fr}}
  </style>
</head>
<body>
  <div id="root">
    <button id="launcher" class="launcher" aria-label="${htmlEscape(copy.launcherLabel)}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/></svg>
    </button>
    <section id="panel" class="panel" aria-label="${htmlEscape(assistantName)}">
      <header class="header">
        ${logoUrl
          ? `<img class="brand-logo" src="${htmlEscape(logoUrl)}" alt="${htmlEscape(university.name)}">`
          : `<div class="brand-fallback">${htmlEscape(university.name.slice(0, 1).toUpperCase())}</div>`}
        <div><div class="header-title">${htmlEscape(assistantName)}</div><div class="header-sub">${htmlEscape(copy.headerSub)}</div></div>
        <div class="header-actions">
          <button id="handoff" class="icon-btn" title="${htmlEscape(copy.handoffLabel)}" aria-label="${htmlEscape(copy.handoffLabel)}">♙</button>
          <button id="close" class="icon-btn" title="${htmlEscape(copy.closeLabel)}" aria-label="${htmlEscape(copy.closeLabel)}">×</button>
        </div>
      </header>
      <main id="content" class="content">
        <div id="lead">
          <div class="intro"><h3>${htmlEscape(copy.hello)}</h3><p>${htmlEscape(copy.intro)}</p></div>
          <form id="leadForm" class="form">
            <div class="form-row">
              <label>${htmlEscape(copy.firstName)}<input name="firstName" required maxlength="100" autocomplete="given-name"></label>
              <label>${htmlEscape(copy.lastName)}<input name="lastName" required maxlength="100" autocomplete="family-name"></label>
            </div>
            <label>${htmlEscape(copy.email)}<input name="email" type="email" required maxlength="255" autocomplete="email"></label>
            <div class="phone-label"><span>${htmlEscape(copy.phone)}</span>
              <div class="phone-group">
                <div class="dial-picker">
                  <input id="countryCode" name="countryCode" type="hidden">
                  <button id="dialTrigger" class="dial-trigger" type="button" aria-haspopup="listbox" aria-expanded="false">
                    <span id="dialCurrent" class="dial-current">${htmlEscape(copy.countryCode)}</span>
                    <span class="dial-chevron">⌄</span>
                  </button>
                  <div id="dialMenu" class="dial-menu">
                    <input id="dialSearch" class="dial-search" type="search" placeholder="${htmlEscape(copy.countrySearch)}" autocomplete="off">
                    <div id="dialOptions" class="dial-options" role="listbox"></div>
                    <div id="dialEmpty" class="dial-empty">${htmlEscape(copy.countryNoMatches)}</div>
                  </div>
                </div>
                <input id="phone" name="phone" type="tel" required maxlength="18" placeholder="${htmlEscape(copy.phonePlaceholder)}" aria-label="${htmlEscape(copy.phonePlaceholder)}" autocomplete="tel-national" inputmode="tel">
              </div>
              <span id="phoneError" class="field-error">${htmlEscape(copy.phoneInvalid)}</span>
            </div>
            <input name="_hp" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true">
            <div id="formError" class="error"></div>
            <button class="primary-btn" type="submit">${htmlEscape(copy.startChat)}</button>
          </form>
        </div>
        <div id="messages"></div>
        <div id="typing" class="typing">${htmlEscape(copy.typing)}</div>
        <div id="status" class="status"></div>
      </main>
      <footer id="composer" class="composer">
        <div id="pendingMedia" class="pending-media"></div>
        <div id="uploadState" class="upload-state"><span id="uploadLabel">Uploading…</span><div class="upload-track"><div id="uploadBar" class="upload-bar"></div></div><button id="uploadCancel" class="upload-cancel" type="button">Cancel</button></div>
        <div class="composer-row">
          <input id="mediaInput" type="file" multiple hidden accept="${htmlEscape(webChatMediaAcceptAttribute())}">
          <input id="cameraInput" type="file" hidden accept="image/jpeg,image/png,image/webp" capture="environment">
          <button id="attach" class="compose-tool" type="button" aria-label="Attach file" title="Attach file (max 5 MB)">📎</button>
          <button id="camera" class="compose-tool" type="button" aria-label="Camera" title="Camera">📷</button>
          <button id="microphone" class="compose-tool" type="button" aria-label="Record voice message" title="Record voice message">🎤</button>
          <textarea id="messageInput" maxlength="2000" rows="1" placeholder="${htmlEscape(copy.messagePlaceholder)}"></textarea>
          <button id="send" class="send" aria-label="${htmlEscape(copy.send)}">➤</button>
        </div>
      </footer>
    </section>
  </div>
  <script>
  (function(){
    'use strict';
    var cfg=${safeConfig};
    var accessToken=new URLSearchParams(location.search).get('t')||'';
    var storageKey='edcons-chat-session:'+cfg.slug;
    var sessionToken=sessionStorage.getItem(storageKey)||'';
    var panel=document.getElementById('panel');
    var launcher=document.getElementById('launcher');
    var lead=document.getElementById('lead');
    var messages=document.getElementById('messages');
    var composer=document.getElementById('composer');
    var content=document.getElementById('content');
    var typing=document.getElementById('typing');
    var status=document.getElementById('status');
    var seen={};
    var lastId=0;
    var polling=false;
    var countryCode=document.getElementById('countryCode');
    var dialTrigger=document.getElementById('dialTrigger');
    var dialCurrent=document.getElementById('dialCurrent');
    var dialMenu=document.getElementById('dialMenu');
    var dialSearch=document.getElementById('dialSearch');
    var dialOptions=document.getElementById('dialOptions');
    var dialEmpty=document.getElementById('dialEmpty');
    var phoneInput=document.getElementById('phone');
    var phoneError=document.getElementById('phoneError');
    var pendingFiles=[];
    var uploadXhr=null;
    var sending=false;
    var recorder=null;
    var recorderStream=null;
    var recorderChunks=[];
    var recorderTimer=null;
    var discardRecording=false;
    var phoneCodes=(cfg.dialCodes||[]).map(function(row){
      return{code:String(row[0]||''),iso:String(row[1]||'').toUpperCase(),name:String(row[2]||'')};
    }).filter(function(row){return /^\\+\\d{1,4}$/.test(row.code)&&/^[A-Z]{2}$/.test(row.iso)});
    function fold(value){
      try{return String(value||'').normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').toLowerCase()}
      catch(e){return String(value||'').toLowerCase()}
    }
    function flagUrl(iso){return 'https://flagcdn.com/24x18/'+encodeURIComponent(iso.toLowerCase())+'.png'}
    function selectDial(row){
      countryCode.value=row.code;
      dialCurrent.textContent='';
      var img=document.createElement('img');img.className='dial-flag';img.src=flagUrl(row.iso);img.alt=row.iso;dialCurrent.appendChild(img);
      dialCurrent.appendChild(document.createTextNode(' '+row.code));
      dialMenu.classList.remove('open');dialTrigger.setAttribute('aria-expanded','false');
      phoneError.style.display='none';phoneInput.focus();
    }
    function renderDialOptions(query){
      var q=fold(query);dialOptions.textContent='';
      var rows=phoneCodes.filter(function(row){
        return !q||fold(row.name+' '+row.iso+' '+row.code).indexOf(q)>=0;
      });
      rows.forEach(function(row){
        var button=document.createElement('button');button.type='button';button.className='dial-option';button.setAttribute('role','option');
        var img=document.createElement('img');img.className='dial-flag';img.src=flagUrl(row.iso);img.alt=row.iso;
        var name=document.createElement('span');name.className='dial-name';name.textContent=row.name;
        var code=document.createElement('span');code.className='dial-code';code.textContent=row.code;
        button.appendChild(img);button.appendChild(name);button.appendChild(code);
        button.onclick=function(){selectDial(row)};dialOptions.appendChild(button);
      });
      dialEmpty.style.display=rows.length?'none':'block';
    }
    dialTrigger.onclick=function(){
      var open=!dialMenu.classList.contains('open');dialMenu.classList.toggle('open',open);dialTrigger.setAttribute('aria-expanded',String(open));
      if(open){dialSearch.value='';renderDialOptions('');setTimeout(function(){dialSearch.focus()},0)}
    };
    dialSearch.oninput=function(){renderDialOptions(dialSearch.value)};
    document.addEventListener('click',function(event){
      if(!dialMenu.contains(event.target)&&!dialTrigger.contains(event.target)){dialMenu.classList.remove('open');dialTrigger.setAttribute('aria-expanded','false')}
    });
    document.addEventListener('keydown',function(event){
      if(event.key==='Escape'){dialMenu.classList.remove('open');dialTrigger.setAttribute('aria-expanded','false')}
    });
    phoneInput.oninput=function(){
      var raw=phoneInput.value;
      if(raw.trim().charAt(0)==='+'){
        var internationalDigits=raw.replace(/\\D/g,'');
        var match=phoneCodes.slice().sort(function(a,b){return b.code.length-a.code.length}).find(function(row){
          return internationalDigits.indexOf(row.code.replace(/\\D/g,''))===0;
        });
        if(match){selectDial(match);raw=internationalDigits.slice(match.code.replace(/\\D/g,'').length)}
      }
      phoneInput.value=raw.replace(/\\D/g,'').slice(0,15);
      phoneError.style.display='none';
    };
    renderDialOptions('');
    function parentMessage(type,extra){
      try{parent.postMessage(Object.assign({type:type,slug:cfg.slug},extra||{}),'*')}catch(e){}
    }
    parentMessage('edcons-chatbot-ready',{open:false});
    function setOpen(open){
      panel.classList.toggle('open',open);
      launcher.style.display=open?'none':'grid';
      parentMessage('edcons-chatbot-layout',{open:open});
      if(!open&&recorder&&recorder.state==='recording'){discardRecording=true;recorder.stop()}
      if(open&&sessionToken) poll();
    }
    launcher.onclick=function(){setOpen(true)};
    document.getElementById('close').onclick=function(){setOpen(false)};
    function appendMessage(row){
      if(!row||seen[row.id])return;
      seen[row.id]=true;lastId=Math.max(lastId,Number(row.id)||0);
      var el=document.createElement('div');
      el.className='message '+(row.direction==='inbound'?'inbound':'outbound');
      if(row.content&&row.content!=='[attachment]'){
        var text=document.createElement('div');text.textContent=row.content;el.appendChild(text);
      }
      var atts=Array.isArray(row.attachments)?row.attachments:[];
      if(atts.length){
        var media=document.createElement('div');media.className='message-media';
        atts.forEach(function(att,index){
          var url=cfg.baseUrl+'/api/public/embed/'+encodeURIComponent(cfg.slug)+'/chat/media/'+encodeURIComponent(row.id)+'/'+index+'?s='+encodeURIComponent(sessionToken);
          if(att.type==='image'){
            var img=document.createElement('img');img.src=url;img.alt=att.name||'Image';img.loading='lazy';media.appendChild(img);return;
          }
          if(att.type==='video'){
            var video=document.createElement('video');video.src=url;video.controls=true;video.preload='metadata';media.appendChild(video);return;
          }
          if(att.type==='audio'){
            var audio=document.createElement('audio');audio.src=url;audio.controls=true;audio.preload='metadata';media.appendChild(audio);return;
          }
          var link=document.createElement('a');link.className='file-card';link.href=url;link.target='_blank';link.rel='noopener noreferrer';link.download=att.name||'document';
          var icon=document.createElement('span');icon.className='file-icon';icon.textContent=(String(att.name||'').split('.').pop()||'FILE').slice(0,5).toUpperCase();
          var meta=document.createElement('span');meta.className='file-meta';
          var name=document.createElement('span');name.className='file-name';name.textContent=att.name||'Document';
          var size=document.createElement('span');size.className='file-size';size.textContent=formatBytes(Number(att.fileSize)||0);
          meta.appendChild(name);meta.appendChild(size);link.appendChild(icon);link.appendChild(meta);media.appendChild(link);
        });
        el.appendChild(media);
      }
      var tm=document.createElement('div');tm.className='message-time';
      try{tm.textContent=new Date(row.createdAt).toLocaleTimeString(cfg.locale,{hour:'2-digit',minute:'2-digit'})}catch(e){}
      el.appendChild(tm);messages.appendChild(el);content.scrollTop=content.scrollHeight;
    }
    function formatBytes(bytes){
      if(!bytes)return'';if(bytes<1024)return bytes+' B';if(bytes<1048576)return(bytes/1024).toFixed(1)+' KB';return(bytes/1048576).toFixed(1)+' MB';
    }
    function renderPending(){
      var wrap=document.getElementById('pendingMedia');wrap.textContent='';wrap.style.display=pendingFiles.length?'flex':'none';
      pendingFiles.forEach(function(file,index){
        var item=document.createElement('div');item.className='pending-item';
        var name=document.createElement('span');name.className='pending-name';name.textContent=file.name+' · '+formatBytes(file.size);
        var remove=document.createElement('button');remove.type='button';remove.className='pending-remove';remove.textContent='×';remove.setAttribute('aria-label','Remove '+file.name);
        remove.onclick=function(){if(sending)return;pendingFiles.splice(index,1);renderPending()};
        item.appendChild(name);item.appendChild(remove);wrap.appendChild(item);
      });
    }
    function addFiles(list){
      Array.prototype.slice.call(list||[]).forEach(function(file){
        if(!file||file.size<=0){status.textContent='The selected file is empty.';return}
        if(file.size>cfg.mediaMaxBytes){status.textContent=file.name+': maximum file size is 5 MB.';return}
        pendingFiles.push(file);
      });
      pendingFiles=pendingFiles.slice(0,10);renderPending();
    }
    function setUploadState(active,percent,label){
      var state=document.getElementById('uploadState');state.style.display=active?'flex':'none';
      document.getElementById('uploadBar').style.width=Math.max(0,Math.min(100,percent||0))+'%';
      document.getElementById('uploadLabel').textContent=label||'Uploading…';
    }
    function uploadMedia(file,caption){
      return new Promise(function(resolve,reject){
        var xhr=new XMLHttpRequest();uploadXhr=xhr;
        xhr.open('POST',cfg.baseUrl+'/api/public/embed/'+encodeURIComponent(cfg.slug)+'/chat/media?s='+encodeURIComponent(sessionToken));
        xhr.responseType='json';xhr.setRequestHeader('Content-Type',file.type||'application/octet-stream');
        xhr.setRequestHeader('X-File-Name',encodeURIComponent(file.name));
        if(caption)xhr.setRequestHeader('X-Caption',encodeURIComponent(caption));
        if(file.name.indexOf('voice-note-')===0)xhr.setRequestHeader('X-Voice-Note','1');
        xhr.upload.onprogress=function(event){if(event.lengthComputable)setUploadState(true,(event.loaded/event.total)*100,'Uploading '+file.name)};
        xhr.onload=function(){uploadXhr=null;var data=xhr.response||{};if(xhr.status>=200&&xhr.status<300)resolve(data);else reject(new Error(data.error||cfg.copy.sendError))};
        xhr.onerror=function(){uploadXhr=null;reject(new Error(cfg.copy.sendError))};
        xhr.onabort=function(){uploadXhr=null;reject(new Error('Upload cancelled.'))};
        xhr.send(file);
      });
    }
    function showChat(){
      lead.style.display='none';messages.style.display='flex';composer.style.display='grid';
    }
    async function request(path,options){
      var response=await fetch(cfg.baseUrl+path,options||{});
      var data=await response.json().catch(function(){return{}});
      if(!response.ok)throw new Error(data.error||cfg.copy.genericError);
      return data;
    }
    document.getElementById('leadForm').onsubmit=async function(e){
      e.preventDefault();
      var form=e.currentTarget;var button=form.querySelector('button[type=submit]');
      var error=document.getElementById('formError');error.style.display='none';button.disabled=true;
      try{
        var fd=new FormData(form);var ref=document.referrer||'';
        if(!fd.get('countryCode')||String(fd.get('phone')||'').replace(/\\D/g,'').length<4){
          phoneError.style.display='block';button.disabled=false;return;
        }
        var payload={
          firstName:fd.get('firstName'),lastName:fd.get('lastName'),email:fd.get('email'),phone:fd.get('phone'),countryCode:fd.get('countryCode'),_hp:fd.get('_hp'),
          sourcePageUrl:ref,sourceWebsite:(function(){try{return new URL(ref).hostname}catch(e){return''}})(),
          language:cfg.locale
        };
        var data=await request('/api/public/embed/'+encodeURIComponent(cfg.slug)+'/chat/session?t='+encodeURIComponent(accessToken),{
          method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)
        });
        sessionToken=data.sessionToken;sessionStorage.setItem(storageKey,sessionToken);showChat();
        if(data.greeting)appendMessage(data.greeting);
        poll();
      }catch(err){
        if(/phone|calling code/i.test(String(err&&err.message||''))){phoneError.style.display='block'}
        else{error.textContent=cfg.copy.startError;error.style.display='block'}
      }
      finally{button.disabled=false}
    };
    async function poll(){
      if(!sessionToken||polling)return;polling=true;
      try{
        var data=await request('/api/public/embed/'+encodeURIComponent(cfg.slug)+'/chat/messages?s='+encodeURIComponent(sessionToken)+'&after='+lastId);
        (data.data||[]).forEach(appendMessage);
        if(data.needsHuman){status.textContent=cfg.copy.humanNotified}
      }catch(err){
        if(/expired|Invalid/.test(err.message)){sessionStorage.removeItem(storageKey);sessionToken='';location.reload()}
      }finally{polling=false}
    }
    async function send(){
      var input=document.getElementById('messageInput');var text=input.value.trim();if((!text&&!pendingFiles.length)||!sessionToken||sending)return;
      sending=true;document.getElementById('send').disabled=true;typing.style.display='block';content.scrollTop=content.scrollHeight;
      try{
        if(pendingFiles.length){
          var files=pendingFiles.slice();
          for(var i=0;i<files.length;i++){
            var mediaData=await uploadMedia(files[i],i===0?text:'');
            (mediaData.data||[]).forEach(appendMessage);
            if(mediaData.outcome&&['globally_disabled','outside_working_hours','handoff','escalated'].indexOf(mediaData.outcome.reason)>=0)status.textContent=cfg.copy.sentToTeam;
            pendingFiles=pendingFiles.filter(function(file){return file!==files[i]});renderPending();
            if(i===0&&text){input.value='';text=''}
          }
        }else{
          var data=await request('/api/public/embed/'+encodeURIComponent(cfg.slug)+'/chat/messages?s='+encodeURIComponent(sessionToken),{
            method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:text})
          });
          (data.data||[]).forEach(appendMessage);
          if(data.outcome&&['globally_disabled','outside_working_hours','handoff','escalated'].indexOf(data.outcome.reason)>=0)status.textContent=cfg.copy.sentToTeam;
        }
        input.value='';
      }catch(err){status.textContent=err&&err.message?err.message:cfg.copy.sendError}
      finally{sending=false;document.getElementById('send').disabled=false;setUploadState(false,0);typing.style.display='none';poll()}
    }
    document.getElementById('send').onclick=send;
    document.getElementById('messageInput').onkeydown=function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}};
    document.getElementById('attach').onclick=function(){document.getElementById('mediaInput').click()};
    document.getElementById('camera').onclick=function(){document.getElementById('cameraInput').click()};
    document.getElementById('mediaInput').onchange=function(e){addFiles(e.target.files);e.target.value=''};
    document.getElementById('cameraInput').onchange=function(e){addFiles(e.target.files);e.target.value=''};
    document.getElementById('uploadCancel').onclick=function(){if(uploadXhr)uploadXhr.abort()};
    document.getElementById('microphone').onclick=async function(){
      var button=this;
      if(recorder&&recorder.state==='recording'){recorder.stop();return}
      if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia||typeof MediaRecorder==='undefined'){
        status.textContent='Voice recording is not supported on this device.';return;
      }
      try{
        recorderStream=await navigator.mediaDevices.getUserMedia({audio:true});
        var candidates=['audio/webm;codecs=opus','audio/mp4','audio/ogg;codecs=opus'];
        var mime=candidates.find(function(value){return MediaRecorder.isTypeSupported(value)})||'';
        recorder=mime?new MediaRecorder(recorderStream,{mimeType:mime}):new MediaRecorder(recorderStream);
        recorderChunks=[];
        recorder.ondataavailable=function(event){if(event.data&&event.data.size)recorderChunks.push(event.data)};
        recorder.onstop=function(){
          clearTimeout(recorderTimer);button.classList.remove('recording');
          var actual=String(recorder.mimeType||mime||'audio/webm').split(';')[0];
          var ext=actual==='audio/mp4'?'m4a':actual==='audio/ogg'?'ogg':'webm';
          var blob=new Blob(recorderChunks,{type:actual});
          if(!discardRecording&&blob.size>0){addFiles([new File([blob],'voice-note-'+Date.now()+'.'+ext,{type:actual})]);status.textContent='Voice message ready to send.'}
          discardRecording=false;
          if(recorderStream)recorderStream.getTracks().forEach(function(track){track.stop()});recorderStream=null;recorder=null;
        };
        recorder.start(250);button.classList.add('recording');status.textContent='Recording… Tap the microphone again to stop.';
        recorderTimer=setTimeout(function(){if(recorder&&recorder.state==='recording')recorder.stop()},90000);
      }catch(err){
        if(recorderStream)recorderStream.getTracks().forEach(function(track){track.stop()});recorderStream=null;recorder=null;button.classList.remove('recording');
        status.textContent='Microphone access was not granted.';
      }
    };
    document.getElementById('handoff').onclick=async function(){
      if(!sessionToken){status.textContent=cfg.copy.enterContactFirst;return}
      try{
        await request('/api/public/embed/'+encodeURIComponent(cfg.slug)+'/chat/handoff?s='+encodeURIComponent(sessionToken),{
          method:'POST',headers:{'Content-Type':'application/json'},body:'{}'
        });
        status.textContent=cfg.copy.handoffSent;
      }catch(err){status.textContent=cfg.copy.handoffError}
    };
    if(sessionToken){showChat();poll()}
    setInterval(function(){if(panel.classList.contains('open')&&sessionToken)poll()},3000);
  })();
  </script>
</body>
</html>`;
}

function generateWidgetHTML(slug: string, baseUrl: string, widget: any, docMeta: Record<string, DocCatalogEntry>, dialCodes: [string, string, string][] = [], locale: EmbedChatLocale = "en"): string {
  const theme = sanitizeTheme(widget.theme);
  const primaryColor = theme.primaryColor || "#2563eb";
  const secondaryColor = theme.secondaryColor || "#1e40af";
  const buttonColor = theme.buttonColor || "#2563eb";
  const borderRadius = theme.borderRadius || "8px";
  const fontFamily = theme.fontFamily || "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  const safeMode = VALID_MODES.includes(widget.mode) ? widget.mode : "combined";
  const leadCopy = getEmbedLeadFormCopy(locale);

  const NATIONALITIES = ["Afghanistan","Albania","Algeria","Andorra","Angola","Antigua and Barbuda","Argentina","Armenia","Australia","Austria","Azerbaijan","Bahamas","Bahrain","Bangladesh","Barbados","Belarus","Belgium","Belize","Benin","Bhutan","Bolivia","Bosnia and Herzegovina","Botswana","Brazil","Brunei","Bulgaria","Burkina Faso","Burundi","Cabo Verde","Cambodia","Cameroon","Canada","Central African Republic","Chad","Chile","China","Colombia","Comoros","Congo","Costa Rica","Croatia","Cuba","Cyprus","Czech Republic","Denmark","Djibouti","Dominican Republic","East Timor","Ecuador","Egypt","El Salvador","Equatorial Guinea","Eritrea","Estonia","Eswatini","Ethiopia","Fiji","Finland","France","Gabon","Gambia","Georgia","Germany","Ghana","Greece","Grenada","Guatemala","Guinea","Guyana","Haiti","Honduras","Hungary","Iceland","India","Indonesia","Iran","Iraq","Ireland","Israel","Italy","Ivory Coast","Jamaica","Japan","Jordan","Kazakhstan","Kenya","Kiribati","Kosovo","Kuwait","Kyrgyzstan","Laos","Latvia","Lebanon","Liberia","Libya","Liechtenstein","Lithuania","Luxembourg","Madagascar","Malawi","Malaysia","Maldives","Mali","Malta","Marshall Islands","Mauritania","Mauritius","Mexico","Micronesia","Moldova","Monaco","Mongolia","Montenegro","Morocco","Mozambique","Myanmar","Namibia","Nauru","Nepal","Netherlands","New Zealand","Nicaragua","Niger","Nigeria","North Korea","North Macedonia","Norway","Oman","Pakistan","Palau","Palestine","Panama","Papua New Guinea","Paraguay","Peru","Philippines","Poland","Portugal","Qatar","Romania","Russia","Rwanda","Saint Kitts and Nevis","Saint Lucia","Samoa","San Marino","São Tomé and Príncipe","Saudi Arabia","Senegal","Serbia","Seychelles","Sierra Leone","Singapore","Slovakia","Slovenia","Solomon Islands","Somalia","South Africa","South Korea","South Sudan","Spain","Sri Lanka","Sudan","Suriname","Sweden","Switzerland","Syria","Tajikistan","Tanzania","Thailand","Togo","Tonga","Trinidad and Tobago","Tunisia","Turkey","Turkmenistan","Tuvalu","Uganda","Ukraine","United Arab Emirates","United Kingdom","United States","Uruguay","Uzbekistan","Vanuatu","Venezuela","Vietnam","Yemen","Zambia","Zimbabwe"];

  return `<!DOCTYPE html>
<html lang="${locale}" dir="${leadCopy.dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:${fontFamily};background:transparent;color:#1f2937;line-height:1.5}
.ew-root{max-width:1200px;margin:0 auto;padding:16px}
.ew-header{margin-bottom:20px}
.ew-header h2{font-size:1.5rem;font-weight:700;color:${primaryColor}}
.ew-filters{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:20px;padding:16px;background:#f8fafc;border-radius:${borderRadius};border:1px solid #e2e8f0}
.ew-filter-group{flex:1;min-width:140px}
.ew-filter-group label{display:block;font-size:0.75rem;font-weight:600;color:#64748b;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.5px}
.ew-filter-group select,.ew-filter-group input{width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:0.875rem;background:#fff;color:#1f2937;outline:none}
.ew-filter-group select:focus,.ew-filter-group input:focus{border-color:${primaryColor};box-shadow:0 0 0 3px ${primaryColor}22}
.ew-results-info{font-size:0.875rem;color:#64748b;margin-bottom:12px}
.ew-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:20px;margin-bottom:20px}
.ew-card{border:1px solid rgba(226,232,240,.7);border-radius:16px;background:#fff;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 1px 3px rgba(0,0,0,.04);transition:box-shadow .25s,transform .25s,border-color .25s}
.ew-card:hover{box-shadow:0 12px 28px rgba(37,99,235,.10);transform:translateY(-4px);border-color:rgba(37,99,235,.25)}
.ew-card-banner{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid rgba(226,232,240,.6);background:#fff}
.ew-card-banner-g0{background:linear-gradient(to right,rgba(59,130,246,.15),rgba(99,102,241,.10) 60%,rgba(168,85,247,.05))}
.ew-card-banner-g1{background:linear-gradient(to right,rgba(16,185,129,.15),rgba(20,184,166,.10) 60%,rgba(6,182,212,.05))}
.ew-card-banner-g2{background:linear-gradient(to right,rgba(249,115,22,.15),rgba(244,63,94,.10) 60%,rgba(236,72,153,.05))}
.ew-card-banner-g3{background:linear-gradient(to right,rgba(139,92,246,.15),rgba(168,85,247,.10) 60%,rgba(99,102,241,.05))}
.ew-card-banner-g4{background:linear-gradient(to right,rgba(6,182,212,.15),rgba(14,165,233,.10) 60%,rgba(59,130,246,.05))}
.ew-card-logo-wrap{width:44px;height:44px;border-radius:12px;background:rgba(255,255,255,.92);box-shadow:0 4px 10px rgba(0,0,0,.08);display:flex;align-items:center;justify-content:center;flex-shrink:0;position:relative;z-index:1;overflow:hidden;border:2px solid rgba(255,255,255,.5)}
.ew-card-logo-wrap img{width:32px;height:32px;object-fit:contain}
.ew-card-logo-fallback{width:20px;height:20px;color:${primaryColor}}
.ew-card-uni-name{font-size:.75rem;font-weight:600;color:rgba(31,41,55,.78);flex:1;min-width:0;overflow:hidden;position:relative;z-index:1;display:flex;flex-direction:column;gap:2px}.ew-card-uni-name-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ew-card-uni-loc{display:flex;align-items:center;gap:3px;font-size:9px;color:rgba(100,116,139,.8);font-weight:400}.ew-card-uni-loc svg{width:9px;height:9px;flex-shrink:0;color:rgba(37,99,235,.45)}
.ew-card-pills{display:flex;gap:6px;flex-shrink:0;position:relative;z-index:1}
.ew-pill-soft{font-size:10px;font-weight:500;padding:3px 8px;border-radius:6px;background:rgba(255,255,255,.75);backdrop-filter:blur(4px);color:#475569;white-space:nowrap;box-shadow:0 1px 2px rgba(0,0,0,.04)}
.ew-pill-primary{font-size:10px;font-weight:500;padding:3px 8px;border-radius:6px;background:${primaryColor};color:#fff;white-space:nowrap;box-shadow:0 1px 2px rgba(0,0,0,.08)}
.ew-card-body{padding:18px;flex:1;display:flex;flex-direction:column}
.ew-card-title{font-size:15px;font-weight:700;color:#1f2937;line-height:1.35;margin-bottom:10px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:break-word;word-break:break-word;transition:color .2s}
.ew-card:hover .ew-card-title{color:${primaryColor}}
.ew-card-loc{display:flex;align-items:center;gap:6px;font-size:13px;color:#64748b;margin-bottom:14px}
.ew-card-loc svg{width:14px;height:14px;color:rgba(37,99,235,.5);flex-shrink:0}
.ew-card-loc span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ew-card-meta{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;background:rgba(241,245,249,.6);border-radius:10px;padding:12px;margin-bottom:14px}
.ew-meta-cell{display:flex;flex-direction:column;gap:3px;min-width:0}
.ew-meta-label{display:flex;align-items:center;gap:3px;font-size:9px;color:#94a3b8;font-weight:500}
.ew-meta-label svg{width:10px;height:10px;flex-shrink:0}
.ew-meta-val{font-size:11px;font-weight:700;color:#1e293b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ew-meta-item{display:flex;align-items:center;gap:6px;font-size:12px;color:#475569;font-weight:500;min-width:0}
.ew-meta-item svg{width:14px;height:14px;flex-shrink:0}
.ew-meta-item .ew-meta-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ew-meta-icon-blue{color:#3b82f6}
.ew-meta-icon-green{color:#22c55e}
.ew-meta-icon-orange{color:#f97316}
.ew-meta-icon-emerald{color:#10b981}
.ew-fee-row{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;min-width:0}
.ew-fee-orig{text-decoration:line-through;color:rgba(148,163,184,.7);font-size:10px;font-weight:400}
.ew-fee-disc{color:#059669;font-weight:700}
.ew-fee-pct{font-size:9px;font-weight:700;color:#fff;background:#10b981;border-radius:3px;padding:1px 4px;line-height:1.2}
.ew-scholarship{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:500;padding:3px 9px;border-radius:9999px;border:1px solid rgba(16,185,129,.3);color:#059669;background:rgba(236,253,245,.6);margin-bottom:12px;align-self:flex-start}
.ew-scholarship svg{width:12px;height:12px}
.ew-scholarship-box{border:1px solid rgba(16,185,129,.25);background:rgba(236,253,245,.8);border-radius:10px;padding:8px 10px;text-align:center;flex-shrink:0;min-width:72px}
.ew-scholarship-box svg{color:#059669;width:14px;height:14px;display:block;margin:0 auto 2px}
.ew-scholarship-box-lbl{font-size:9px;color:#94a3b8;font-weight:500;margin-bottom:2px}
.ew-scholarship-box-amt{font-size:13px;font-weight:800;color:#059669}
.ew-fee-section{margin-bottom:12px}
.ew-fee-section-label{display:block;font-size:9px;color:#94a3b8;font-weight:600;letter-spacing:.15px;white-space:nowrap;margin-bottom:5px}
.ew-fee-section-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:12px}
.ew-fee-values{flex:1;min-width:0}
.ew-fee-main{font-size:20px;font-weight:800;color:#1f2937;line-height:1;white-space:nowrap}
.ew-fee-disc-big{color:#059669!important;font-size:20px;font-weight:800;line-height:1}
.ew-scholarship-right{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:500;padding:4px 10px;border-radius:9999px;border:1px solid rgba(16,185,129,.3);color:#059669;background:rgba(236,253,245,.7);white-space:nowrap}
.ew-scholarship-right svg{width:12px;height:12px}
.ew-deposit-strip{display:flex;align-items:center;gap:6px;padding:8px 10px;border-radius:8px;background:rgba(238,242,255,.8);border:1px solid rgba(199,210,254,.6);color:#4338ca;font-size:11px;font-weight:500;margin-bottom:12px}
.ew-deposit-strip svg{width:12px;height:12px;flex-shrink:0}
.ew-card-actions{margin-top:auto;display:flex;gap:8px}
.ew-btn-info{width:40px;height:40px;border-radius:50%;border:2px solid rgba(226,232,240,.8);background:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;color:#64748b;flex-shrink:0;transition:all .2s}
.ew-btn-info:hover{border-color:rgba(37,99,235,.4);background:rgba(239,246,255,.5);color:${primaryColor}}
.ew-btn-info svg{width:16px;height:16px}
.ew-badge{font-size:.7rem;padding:3px 8px;border-radius:20px;background:#f1f5f9;color:#475569;font-weight:500;white-space:nowrap}
.ew-badge-primary{background:${primaryColor}15;color:${primaryColor}}
.ew-btn{display:inline-flex;align-items:center;justify-content:center;padding:10px 20px;background:${buttonColor};color:#fff;border:none;border-radius:10px;font-size:.875rem;font-weight:600;cursor:pointer;transition:box-shadow .25s,opacity .2s;flex:1;text-align:center;box-shadow:0 4px 10px rgba(37,99,235,.15)}
.ew-btn:hover{opacity:.95;box-shadow:0 6px 14px rgba(37,99,235,.25)}
.ew-btn-outline{background:transparent;color:${buttonColor};border:1.5px solid ${buttonColor};box-shadow:none}
.ew-btn-outline:hover{background:${buttonColor}08;box-shadow:none}
.ew-pagination{display:flex;justify-content:center;gap:8px;margin-top:20px}
.ew-pagination button{padding:8px 14px;border:1px solid #d1d5db;border-radius:6px;background:#fff;cursor:pointer;font-size:0.875rem;color:#374151}
.ew-pagination button:disabled{opacity:.4;cursor:default}
.ew-pagination button.active{background:${primaryColor};color:#fff;border-color:${primaryColor}}
.ew-modal-overlay{position:absolute;top:0;left:0;width:100%;min-height:100%;background:rgba(0,0,0,.5);z-index:9999;padding:0}
.ew-modal{position:absolute;left:50%;transform:translateX(-50%);top:24px;background:#fff;border-radius:${borderRadius};max-width:540px;width:calc(100% - 32px);max-height:600px;overflow-y:auto;padding:28px;box-shadow:0 20px 60px rgba(0,0,0,.15)}
.ew-modal h3{font-size:1.25rem;font-weight:700;margin-bottom:4px;color:#1f2937}
.ew-modal .ew-modal-subtitle{font-size:0.85rem;color:#64748b;margin-bottom:20px}
.ew-form-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.ew-form-group{margin-bottom:0}
.ew-form-group.full{grid-column:1/-1}
.ew-form-group label{display:block;font-size:0.8rem;font-weight:500;color:#374151;margin-bottom:4px}
.ew-form-group input,.ew-form-group select,.ew-form-group textarea{width:100%;padding:9px 12px;border:1px solid #d1d5db;border-radius:6px;font-size:0.875rem;background:#fff;color:#1f2937;outline:none}
.ew-form-group textarea{resize:vertical;min-height:80px}
.ew-form-group input:focus,.ew-form-group select:focus,.ew-form-group textarea:focus{border-color:${primaryColor};box-shadow:0 0 0 3px ${primaryColor}22}
.ew-form-actions{display:flex;gap:10px;margin-top:16px}
.ew-close-btn{position:absolute;top:16px;right:16px;background:none;border:none;font-size:1.5rem;cursor:pointer;color:#9ca3af;line-height:1}
.ew-close-btn:hover{color:#374151}
.ew-success{text-align:center;padding:40px 20px}
.ew-success svg{width:64px;height:64px;color:#22c55e;margin-bottom:16px}
.ew-success h3{font-size:1.3rem;color:#1f2937;margin-bottom:8px}
.ew-success p{color:#64748b}
.ew-empty{text-align:center;padding:60px 20px;color:#9ca3af}
.ew-empty svg{width:48px;height:48px;margin-bottom:12px;opacity:.5}
.ew-loading{display:flex;justify-content:center;padding:60px}
.ew-spinner{width:40px;height:40px;border:3px solid #e2e8f0;border-top-color:${primaryColor};border-radius:50%;animation:spin 0.8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.ew-skeleton{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px}
.ew-skeleton-card{height:240px;border-radius:${borderRadius};background:linear-gradient(90deg,#f1f5f9 25%,#e2e8f0 50%,#f1f5f9 75%);background-size:200% 100%;animation:shimmer 1.5s infinite}
@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
.ew-phone-group{display:flex;gap:6px}
.ew-field-err{color:#dc2626;font-size:12px;margin-top:4px}
.ew-phone-group select{width:100px;flex-shrink:0}
.ew-phone-group input{flex:1}
.ew-cc{position:relative;width:120px;flex-shrink:0}
.ew-cc-trigger{width:100%;height:38px;padding:0 8px;border:1px solid #d1d5db;border-radius:6px;background:#fff;color:#1f2937;font-size:0.875rem;display:flex;align-items:center;gap:6px;cursor:pointer;outline:none}
.ew-cc-trigger:focus{border-color:${primaryColor};box-shadow:0 0 0 3px ${primaryColor}22}
.ew-cc-trigger img{width:18px;height:13px;object-fit:cover;border-radius:2px;flex-shrink:0;display:block}
.ew-cc-trigger .ew-cc-code{flex:1;text-align:left;font-weight:500}
.ew-cc-trigger .ew-cc-caret{margin-left:auto;font-size:0.7rem;opacity:.6}
.ew-cc-list{position:absolute;top:calc(100% + 4px);left:0;right:0;min-width:260px;max-height:300px;overflow-y:auto;background:#fff;border:1px solid #e5e7eb;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.12);z-index:1000;padding:4px;display:none}
.ew-cc-search{position:sticky;top:0;display:block;width:calc(100% - 4px);margin:0 2px 4px;padding:7px 10px;border:1px solid #d1d5db;border-radius:6px;background:#fff;color:#1f2937;font-size:0.85rem;outline:none;box-sizing:border-box;z-index:2}
.ew-cc-search:focus{border-color:${primaryColor};box-shadow:0 0 0 3px ${primaryColor}22}
.ew-cc-item.ew-cc-hidden{display:none}
.ew-cc-empty{display:none;padding:10px;text-align:center;color:#94a3b8;font-size:0.8rem}
.ew-cc-empty.ew-cc-empty-show{display:block}
.ew-cc-list.open{display:block}
.ew-cc-list.ew-cc-list-up{top:auto;bottom:calc(100% + 4px)}
.ew-cc-item{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:6px;cursor:pointer;font-size:0.85rem;color:#1f2937}
.ew-cc-item:hover,.ew-cc-item.active{background:${primaryColor}15}
.ew-cc-item img{width:18px;height:13px;object-fit:cover;border-radius:2px;flex-shrink:0}
.ew-cc-item .ew-cc-item-code{font-weight:600;min-width:42px}
.ew-cc-item .ew-cc-item-name{color:#64748b;font-size:0.78rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ew-hp{position:absolute;left:-9999px;opacity:0;height:0}
.ew-steps{display:flex;align-items:center;gap:0;margin-bottom:24px;padding:0 4px}
.ew-step{display:flex;align-items:center;gap:8px;flex:1}
.ew-step-num{width:28px;height:28px;border-radius:50%;background:#e2e8f0;color:#64748b;display:flex;align-items:center;justify-content:center;font-size:0.75rem;font-weight:700;flex-shrink:0;transition:all .3s}
.ew-step.active .ew-step-num{background:${primaryColor};color:#fff}
.ew-step.done .ew-step-num{background:#22c55e;color:#fff}
.ew-step-label{font-size:0.75rem;color:#94a3b8;font-weight:500;white-space:nowrap}
.ew-step.active .ew-step-label{color:${primaryColor};font-weight:600}
.ew-step.done .ew-step-label{color:#22c55e}
.ew-step-line{flex:1;height:2px;background:#e2e8f0;margin:0 4px}
.ew-step.done+.ew-step-line,.ew-step.done .ew-step-line{background:#22c55e}
.ew-doc-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px}
.ew-doc-slot{border:2px dashed #d1d5db;border-radius:8px;padding:14px;text-align:center;cursor:pointer;transition:all .2s;position:relative;min-height:90px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px}
.ew-doc-slot:hover{border-color:${primaryColor};background:${primaryColor}08}
.ew-doc-slot.uploaded{border-color:#22c55e;border-style:solid;background:#f0fdf4}
.ew-doc-slot input[data-doc-input]{position:absolute;inset:0;opacity:0;cursor:pointer;z-index:1}
.ew-doc-camera-input{display:none}
.ew-doc-scan-btn{position:absolute;bottom:4px;right:4px;z-index:2;background:#fff;border:1px solid ${primaryColor}40;color:${primaryColor};border-radius:6px;padding:3px 6px;font-size:0.65rem;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:3px}
.ew-doc-scan-btn:hover{background:${primaryColor}10}
.ew-scan-overlay{position:fixed;inset:0;background:#000;z-index:10000;display:flex;flex-direction:column}
.ew-scan-header{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;color:#fff;background:rgba(0,0,0,.6)}
.ew-scan-header h4{margin:0;font-size:1rem;font-weight:600}
.ew-scan-header button{background:transparent;border:none;color:#fff;cursor:pointer;font-size:1.4rem;line-height:1;padding:4px 8px}
.ew-scan-stage{flex:1;position:relative;overflow:hidden;display:flex;align-items:center;justify-content:center;background:#000}
.ew-scan-stage video,.ew-scan-stage canvas{max-width:100%;max-height:100%;display:block}
.ew-scan-stage canvas.ew-scan-overlay-cv{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;object-fit:contain}
.ew-scan-hint{position:absolute;top:12px;left:50%;transform:translateX(-50%);color:#fff;background:rgba(0,0,0,.55);padding:6px 12px;border-radius:999px;font-size:0.8rem}
.ew-scan-bar{display:flex;gap:8px;padding:12px;background:rgba(0,0,0,.7);justify-content:center;flex-wrap:wrap}
.ew-scan-bar button{padding:10px 16px;border-radius:8px;border:none;cursor:pointer;font-weight:600;font-size:0.85rem;background:#fff;color:#000}
.ew-scan-bar button.primary{background:${primaryColor};color:#fff}
.ew-scan-bar button:disabled{opacity:.5;cursor:not-allowed}
.ew-scan-pages{display:flex;gap:6px;padding:8px 12px;background:rgba(0,0,0,.7);overflow-x:auto}
.ew-scan-pages img{height:60px;border-radius:4px;border:1px solid #fff3}
.ew-scan-loading{color:#fff;text-align:center;padding:24px}
.ew-scan-loading-hint{color:#aaa;font-size:0.75rem;margin-top:8px}
.ew-doc-icon{font-size:1.5rem}
.ew-doc-label{font-size:0.8rem;font-weight:600;color:#374151}
.ew-doc-hint{font-size:0.65rem;color:#94a3b8}
.ew-doc-status{font-size:0.7rem;color:#22c55e;font-weight:600}
.ew-doc-required{color:#ef4444;font-size:0.65rem}
.ew-btn:disabled,.ew-btn-outline:disabled{opacity:.5;cursor:not-allowed;box-shadow:none}
.ew-doc-guidance{display:flex;align-items:center;justify-content:space-between;gap:10px;background:#fef3c7;border:1px solid #fcd34d;color:#92400e;border-radius:10px;padding:10px 12px;margin-top:14px;font-size:0.78rem;line-height:1.4}
.ew-doc-guidance.size-only{justify-content:flex-end;background:#f8fafc;border-color:#e2e8f0;color:#475569}
.ew-doc-size-badge{display:inline-flex;align-items:center;justify-content:center;white-space:nowrap;border-radius:999px;background:#fff;border:1px solid #f59e0b;color:#92400e;padding:4px 9px;font-size:0.68rem;font-weight:800;letter-spacing:.02em}
.ew-doc-header{display:flex;align-items:center;gap:8px;margin-bottom:4px}
.ew-doc-header span:first-child{font-size:0.9rem;font-weight:600;color:#1f2937}
.ew-doc-header span:last-child{font-size:0.75rem;color:#64748b}
.ew-analyzing{text-align:center;padding:40px 20px}
.ew-analyzing-spinner{width:56px;height:56px;border:4px solid #e2e8f0;border-top-color:${primaryColor};border-radius:50%;animation:ew-spin 1s linear infinite;margin:0 auto 20px}
@keyframes ew-spin{to{transform:rotate(360deg)}}
.ew-analyzing h4{font-size:1.1rem;font-weight:600;color:#1f2937;margin-bottom:6px}
.ew-analyzing p{font-size:0.85rem;color:#64748b}
.ew-ai-badge{display:inline-flex;align-items:center;gap:4px;background:linear-gradient(135deg,#8b5cf6,#6366f1);color:#fff;font-size:0.7rem;font-weight:600;padding:3px 10px;border-radius:20px;margin-bottom:12px}
.ew-extracted-info{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:14px;margin-top:12px;margin-bottom:12px}
.ew-extracted-info h5{font-size:0.8rem;font-weight:600;color:#166534;margin-bottom:8px;display:flex;align-items:center;gap:6px}
.ew-extracted-grid{display:grid;grid-template-columns:1fr 1fr;gap:4px 12px}
.ew-extracted-item{font-size:0.75rem;color:#374151}
.ew-extracted-item span{color:#64748b}
.ew-btn-back{background:transparent;color:#64748b;border:1.5px solid #d1d5db;cursor:pointer;padding:10px 20px;border-radius:6px;font-size:0.875rem;font-weight:500;transition:all .2s}
.ew-btn-back:hover{background:#f8fafc;color:#374151}
.ew-detail-head{display:flex;align-items:center;gap:12px;margin-bottom:14px}
.ew-detail-logo{width:48px;height:48px;border-radius:12px;background:${primaryColor}15;display:flex;align-items:center;justify-content:center;flex-shrink:0;overflow:hidden;border:2px solid ${primaryColor}33}
.ew-detail-logo img{width:36px;height:36px;object-fit:contain}
.ew-detail-logo svg{width:24px;height:24px;color:${primaryColor}}
.ew-detail-title{font-size:1.05rem;font-weight:700;color:#1f2937;line-height:1.3}
.ew-detail-uni{font-size:0.8rem;color:#64748b;margin-top:2px}
.ew-detail-loc{display:flex;align-items:center;gap:6px;font-size:0.85rem;color:#64748b;margin-bottom:14px}
.ew-detail-loc svg{width:14px;height:14px;color:${primaryColor}99}
.ew-detail-feebox{background:linear-gradient(to right,${primaryColor}0d,rgba(16,185,129,.05));border:1px solid ${primaryColor}1a;border-radius:12px;padding:14px;margin-bottom:14px}
.ew-detail-feeline{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:6px}
.ew-detail-feeline .big{font-size:1.4rem;font-weight:700;color:#1f2937}
.ew-detail-feeline .orig{font-size:0.85rem;text-decoration:line-through;color:#9ca3af}
.ew-detail-feeline .pct{font-size:10px;font-weight:700;color:#fff;background:#10b981;border-radius:4px;padding:2px 6px;line-height:1.3}
.ew-detail-schol{display:flex;align-items:center;gap:6px;font-size:0.85rem;color:#059669;font-weight:500}
.ew-detail-schol svg{width:14px;height:14px}
.ew-detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px}
.ew-detail-row{display:flex;align-items:center;gap:10px;background:rgba(241,245,249,.6);border-radius:9px;padding:9px 12px;min-width:0}
.ew-detail-row svg{width:16px;height:16px;flex-shrink:0}
.ew-detail-row-text{min-width:0;flex:1}
.ew-detail-row-label{font-size:9px;text-transform:uppercase;letter-spacing:.05em;color:#94a3b8;font-weight:600;line-height:1.2}
.ew-detail-row-value{font-size:13px;font-weight:500;color:#1f2937;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.3;margin-top:2px}
.ew-detail-section{margin-bottom:14px}
.ew-detail-section-label{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#94a3b8;font-weight:600;margin-bottom:6px}
.ew-detail-section-text{font-size:13px;color:#374151;line-height:1.55;white-space:pre-line}
.ew-detail-rankings{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px}
.ew-detail-rank-pill{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:#475569;border:1px solid #e2e8f0;border-radius:9999px;padding:3px 10px;font-weight:500;background:#fff}
.ew-detail-rank-pill svg{width:11px;height:11px;color:#f59e0b}
.ew-detail-link{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:${primaryColor};font-weight:600;text-decoration:none}
.ew-detail-link:hover{opacity:.8}
.ew-detail-link svg{width:13px;height:13px}
@media(max-width:640px){
  .ew-grid{grid-template-columns:1fr}
  .ew-filters{flex-direction:column}
  .ew-form-grid{grid-template-columns:1fr}
  .ew-modal{padding:20px}
  .ew-form-actions{flex-direction:column}
  .ew-doc-grid{grid-template-columns:1fr}
  .ew-doc-guidance{align-items:flex-start;flex-direction:column}
  .ew-steps{gap:0}
  .ew-step-label{display:none}
}
</style>
</head>
<body>
<div class="ew-root" id="ew-app"></div>
<script>
(function(){
var API='${baseUrl}/api/public/embed/${slug}';
var SLUG='${slug}';
var MODE='${safeMode}';
var LC=${JSON.stringify(leadCopy).replace(/<\//g, "<\\/").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")};
// Read the HMAC token the loader script placed in the iframe URL (?t=...).
// The token is required by restricted widgets; for open widgets it is ignored.
var TOKEN=(typeof URLSearchParams!=='undefined'?(new URLSearchParams(window.location.search)).get('t')||'':'');
// Append token to API call URLs so the server can verify access without relying
// on Origin/Referer headers (which reflect the iframe's own api-server origin).
function addToken(u){if(!TOKEN)return u;var sep=u.indexOf('?')>=0?'&':'?';return u+sep+'t='+encodeURIComponent(TOKEN);}
var config=null, filters=null, programs=[], meta={}, currentPage=1;
var formOpen=false, formProgram=null, formSubmitted=false, formLoading=false;
var programDocs=null;
var programDocsLoadError=false;
// Tracks which program ID the current programDocs cache belongs to.
// loadProgramDocs skips the fetch when the same pid is requested again
// (e.g. the user closes and re-opens the same program's apply modal).
var programDocsPid=null;
// Document-type metadata is injected server-side from the admin-managed
// catalog_options table (category='documents'). Adding/editing a document
// type in the staff panel (Catalog > Options > Documents) shows up in this
// widget after the server's 5-minute cache refresh.
var DOC_META=${JSON.stringify(docMeta).replace(/<\/script/gi, "<\\/script").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")};
function humanizeDocKey(k){
  return String(k||'').replace(/([A-Z])/g,' $1').replace(/[_-]+/g,' ').replace(/\\s+/g,' ').trim().replace(/^./,function(c){return c.toUpperCase();});
}
function loadProgramDocs(pid,cb){
  // Return cached result immediately when the same program is requested again
  // (e.g. close → re-open the same apply modal). This prevents a redundant
  // /document-requirements fetch and avoids the retry doubling the request
  // count on the same pid within a single page session.
  if(pid&&pid===programDocsPid&&Array.isArray(programDocs)){if(cb)cb();return;}
  programDocs=null;
  programDocsLoadError=false;
  programDocsPid=pid||null;
  if(!pid){programDocs=[];if(cb)cb();return;}
  var apiBase=API.replace('/public/embed/'+SLUG,'');
  var url=apiBase+'/public/programs/'+pid+'/document-requirements';
  function applyRows(rows){
    if(Array.isArray(rows)){
      programDocs=rows.slice().sort(function(a,b){return (a.sortOrder||0)-(b.sortOrder||0);}).map(function(r){
        var rawKey=String(r.documentType||'other');
        // Whitelist key shape and reject reserved property names so a
        // malicious documentType can't break out of HTML attributes
        // downstream or pollute object prototypes. esc() at sinks is a
        // second line of defence.
        var lowerKey=rawKey.toLowerCase();
        var key=(/^[a-z0-9_\\-]{1,64}$/i.test(rawKey)&&lowerKey!=='__proto__'&&lowerKey!=='prototype'&&lowerKey!=='constructor')?rawKey:'other';
        var meta=DOC_META[key]||{label:humanizeDocKey(key),icon:'\\ud83d\\udcce',accept:'.pdf,.jpg,.jpeg,.png'};
        return {key:key,label:meta.label,icon:meta.icon,accept:isPhotoDocumentKey(key)?'.pdf,.jpg,.jpeg,.png':(meta.accept||'.pdf,.jpg,.jpeg,.png'),required:!!r.mandatory};
      });
    }
  }
  // Retry once on transient failure. Persistent failure is fail-closed:
  // unknown requirements must never be replaced by a weaker invented list.
  function attempt(retriesLeft){
    fetch(url).then(function(r){
      if(!r.ok)throw new Error('http '+r.status);
      return r.json();
    }).then(function(rows){
      applyRows(rows);
      if(cb)cb();
    }).catch(function(){
      if(retriesLeft>0){setTimeout(function(){attempt(retriesLeft-1);},600);return;}
      programDocsLoadError=true;
      if(cb)cb();
    });
  }
  attempt(1);
}
var detailProgram=null, detailOpen=false;
var formStep='personal';
var phoneError=false;
var uploadedDocs={};
var documentMergeInFlight={};
// Message shown when the applicant tries to advance past the Documents step
// without uploading every document marked Required. {docs} is replaced with
// the comma-separated list of missing required document labels.
var REQUIRED_DOCS_MSG='Please upload all required documents to continue: {docs}';
// The document-type list shown in the Documents step is returned by the
// server's effective program+degree requirements endpoint. An intentionally
// empty configured list stays empty; it is never replaced by invented rules.
function getDocTypes(){
  return Array.isArray(programDocs)?programDocs:[];
}
// Required documents not yet uploaded. Returns an array of doc-type objects.
function missingRequiredDocs(){
  var types=getDocTypes(),miss=[];
  for(var i=0;i<types.length;i++){var d=types[i];if(d&&d.required&&!uploadedDocs[d.key])miss.push(d);}
  return miss;
}
// Defense-in-depth gate: refuse to advance/submit and bounce back to the
// Documents step when any required document is missing. Returns true when OK.
function enforceDocGate(){
  if(programDocsLoadError||!Array.isArray(programDocs)){
    alert('Document requirements could not be loaded. Please retry before submitting.');
    formStep='documents';
    render();
    return false;
  }
  var miss=missingRequiredDocs();
  if(miss.length>0){
    alert(REQUIRED_DOCS_MSG.replace('{docs}',miss.map(function(d){return d.label;}).join(', ')));
    formStep='documents';
    if(formOpen)showModal();else render(false);
    return false;
  }
  return true;
}
var aiResult=null;
var extractedFields={};
var NATIONALITIES=${JSON.stringify(NATIONALITIES)};
// Comprehensive ITU-T E.164 country dialing codes for the custom flag dropdown.
// Sorted alphabetically by display name; the dropdown's search input handles
// selection. Tuples are [code, isoAlpha2, displayName]. Flags rendered via
// flagcdn PNG images instead of unicode regional-indicator emoji so they
// render consistently on Windows (which otherwise shows letter pairs).
// Catalog-sourced codes (admin-managed) take precedence; the hardcoded list
// below is a fallback for when the catalog has no dial-coded countries.
var PHONE_CODES_CATALOG=${JSON.stringify(dialCodes).replace(/<\/script/gi, "<\\/script").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")};
var PHONE_CODES=(PHONE_CODES_CATALOG&&PHONE_CODES_CATALOG.length)?PHONE_CODES_CATALOG:[
  ['+93','AF','Afghanistan'],['+355','AL','Albania'],['+213','DZ','Algeria'],
  ['+376','AD','Andorra'],['+244','AO','Angola'],['+54','AR','Argentina'],
  ['+374','AM','Armenia'],['+61','AU','Australia'],['+43','AT','Austria'],
  ['+994','AZ','Azerbaijan'],['+973','BH','Bahrain'],['+880','BD','Bangladesh'],
  ['+375','BY','Belarus'],['+32','BE','Belgium'],['+501','BZ','Belize'],
  ['+229','BJ','Benin'],['+591','BO','Bolivia'],['+387','BA','Bosnia and Herzegovina'],
  ['+267','BW','Botswana'],['+55','BR','Brazil'],['+673','BN','Brunei'],
  ['+359','BG','Bulgaria'],['+226','BF','Burkina Faso'],['+257','BI','Burundi'],
  ['+855','KH','Cambodia'],['+237','CM','Cameroon'],['+1','CA','Canada'],
  ['+238','CV','Cape Verde'],['+236','CF','Central African Republic'],['+235','TD','Chad'],
  ['+56','CL','Chile'],['+86','CN','China'],['+57','CO','Colombia'],
  ['+269','KM','Comoros'],['+243','CD','Congo (DRC)'],['+242','CG','Congo (Republic)'],
  ['+506','CR','Costa Rica'],['+225','CI',"Côte d'Ivoire"],['+385','HR','Croatia'],
  ['+53','CU','Cuba'],['+357','CY','Cyprus'],['+420','CZ','Czechia'],
  ['+45','DK','Denmark'],['+253','DJ','Djibouti'],['+1','DO','Dominican Republic'],
  ['+593','EC','Ecuador'],['+20','EG','Egypt'],['+503','SV','El Salvador'],
  ['+240','GQ','Equatorial Guinea'],['+291','ER','Eritrea'],['+372','EE','Estonia'],
  ['+251','ET','Ethiopia'],['+679','FJ','Fiji'],['+358','FI','Finland'],
  ['+33','FR','France'],['+241','GA','Gabon'],['+220','GM','Gambia'],
  ['+995','GE','Georgia'],['+49','DE','Germany'],['+233','GH','Ghana'],
  ['+30','GR','Greece'],['+502','GT','Guatemala'],['+224','GN','Guinea'],
  ['+245','GW','Guinea-Bissau'],['+592','GY','Guyana'],['+509','HT','Haiti'],
  ['+504','HN','Honduras'],['+852','HK','Hong Kong'],['+36','HU','Hungary'],
  ['+354','IS','Iceland'],['+91','IN','India'],['+62','ID','Indonesia'],
  ['+98','IR','Iran'],['+964','IQ','Iraq'],['+353','IE','Ireland'],
  ['+972','IL','Israel'],['+39','IT','Italy'],['+1','JM','Jamaica'],
  ['+81','JP','Japan'],['+962','JO','Jordan'],['+7','KZ','Kazakhstan'],
  ['+254','KE','Kenya'],['+965','KW','Kuwait'],['+996','KG','Kyrgyzstan'],
  ['+856','LA','Laos'],['+371','LV','Latvia'],['+961','LB','Lebanon'],
  ['+266','LS','Lesotho'],['+231','LR','Liberia'],['+218','LY','Libya'],
  ['+423','LI','Liechtenstein'],['+370','LT','Lithuania'],['+352','LU','Luxembourg'],
  ['+853','MO','Macau'],['+261','MG','Madagascar'],['+265','MW','Malawi'],
  ['+60','MY','Malaysia'],['+960','MV','Maldives'],['+223','ML','Mali'],
  ['+356','MT','Malta'],['+222','MR','Mauritania'],['+230','MU','Mauritius'],
  ['+52','MX','Mexico'],['+373','MD','Moldova'],['+377','MC','Monaco'],
  ['+976','MN','Mongolia'],['+382','ME','Montenegro'],['+212','MA','Morocco'],
  ['+258','MZ','Mozambique'],['+95','MM','Myanmar'],['+264','NA','Namibia'],
  ['+977','NP','Nepal'],['+31','NL','Netherlands'],['+64','NZ','New Zealand'],
  ['+505','NI','Nicaragua'],['+227','NE','Niger'],['+234','NG','Nigeria'],
  ['+850','KP','North Korea'],['+389','MK','North Macedonia'],['+47','NO','Norway'],
  ['+968','OM','Oman'],['+92','PK','Pakistan'],['+970','PS','Palestine'],
  ['+507','PA','Panama'],['+675','PG','Papua New Guinea'],['+595','PY','Paraguay'],
  ['+51','PE','Peru'],['+63','PH','Philippines'],['+48','PL','Poland'],
  ['+351','PT','Portugal'],['+1','PR','Puerto Rico'],['+974','QA','Qatar'],
  ['+40','RO','Romania'],['+7','RU','Russia'],['+250','RW','Rwanda'],
  ['+966','SA','Saudi Arabia'],['+221','SN','Senegal'],['+381','RS','Serbia'],
  ['+248','SC','Seychelles'],['+232','SL','Sierra Leone'],['+65','SG','Singapore'],
  ['+421','SK','Slovakia'],['+386','SI','Slovenia'],['+252','SO','Somalia'],
  ['+27','ZA','South Africa'],['+82','KR','South Korea'],['+211','SS','South Sudan'],
  ['+34','ES','Spain'],['+94','LK','Sri Lanka'],['+249','SD','Sudan'],
  ['+597','SR','Suriname'],['+268','SZ','Eswatini'],['+46','SE','Sweden'],
  ['+41','CH','Switzerland'],['+963','SY','Syria'],['+886','TW','Taiwan'],
  ['+992','TJ','Tajikistan'],['+255','TZ','Tanzania'],['+66','TH','Thailand'],
  ['+670','TL','Timor-Leste'],['+228','TG','Togo'],['+1','TT','Trinidad and Tobago'],
  ['+216','TN','Tunisia'],['+90','TR','Turkey'],['+993','TM','Turkmenistan'],
  ['+256','UG','Uganda'],['+380','UA','Ukraine'],['+971','AE','UAE'],
  ['+44','GB','United Kingdom'],['+1','US','United States'],['+598','UY','Uruguay'],
  ['+998','UZ','Uzbekistan'],['+58','VE','Venezuela'],['+84','VN','Vietnam'],
  ['+967','YE','Yemen'],['+260','ZM','Zambia'],['+263','ZW','Zimbabwe']
];
var searchDebounce=null;
var userFilters={};
var parentViewport=null;
var parentOrigin=(function(){try{return document.referrer?new URL(document.referrer).origin:''}catch(e){return''}})();
var analyticsContext=null;
var sourceContext=null;
var modalElements=null;
var modalNotified=false;

var ALLOWED_MIMES=['application/pdf','image/jpeg','image/png'];
var ALLOWED_EXTS=['.pdf','.jpg','.jpeg','.png'];
var APPLICATION_DOC_MAX=${APPLICATION_DOCUMENT_MAX_SIZE};
var APPLICATION_DOC_MAX_MB=${APPLICATION_DOCUMENT_MAX_SIZE_MB};

function validateFileUpload(file){
  var ext=(file.name||'').toLowerCase().replace(/.*\\./,'.');
  if(ext.indexOf('.')<0)ext='';
  if(ALLOWED_MIMES.indexOf(file.type)<0||ALLOWED_EXTS.indexOf(ext)<0){
    return 'Sadece PDF, JPG, JPEG ve PNG dosyalar\\u0131 y\\u00fckleyebilirsiniz.';
  }
  if(file.size>APPLICATION_DOC_MAX){
    return 'Each file may be a maximum of '+APPLICATION_DOC_MAX_MB+' MB.';
  }
  return null;
}
function isPhotoDocumentKey(key){
  var normalized=String(key||'').trim().toLowerCase().replace(/[\s-]+/g,'_');
  return normalized==='photo'||normalized==='photograph'||normalized==='passport_photo';
}

var LEVEL_DOCS={
  pathway:[
    {key:'passport',label:'Passport',icon:'\\ud83d\\udec2',accept:'.pdf,.jpg,.jpeg,.png',required:true},
    {key:'hs_diploma',label:'HS Diploma',icon:'\\ud83c\\udf93',accept:'.pdf,.jpg,.jpeg,.png',required:false},
    {key:'hs_transcript',label:'HS Transcript',icon:'\\ud83d\\udccb',accept:'.pdf,.jpg,.jpeg,.png',required:false},
    {key:'photo',label:'Photograph',icon:'\\ud83d\\udcf7',accept:'.pdf,.jpg,.jpeg,.png',required:false}
  ],
  undergraduate:[
    {key:'hs_diploma',label:'HS Diploma',icon:'\\ud83c\\udf93',accept:'.pdf,.jpg,.jpeg,.png',required:true},
    {key:'hs_transcript',label:'HS Transcript',icon:'\\ud83d\\udccb',accept:'.pdf,.jpg,.jpeg,.png',required:true},
    {key:'passport',label:'Passport',icon:'\\ud83d\\udec2',accept:'.pdf,.jpg,.jpeg,.png',required:true},
    {key:'photo',label:'Photograph',icon:'\\ud83d\\udcf7',accept:'.pdf,.jpg,.jpeg,.png',required:true}
  ],
  graduate:[
    {key:'bachelor_diploma',label:'Bachelor Diploma',icon:'\\ud83c\\udf93',accept:'.pdf,.jpg,.jpeg,.png',required:true},
    {key:'bachelor_transcript',label:'Bachelor Transcript',icon:'\\ud83d\\udccb',accept:'.pdf,.jpg,.jpeg,.png',required:true},
    {key:'passport',label:'Passport',icon:'\\ud83d\\udec2',accept:'.pdf,.jpg,.jpeg,.png',required:true},
    {key:'photo',label:'Photograph',icon:'\\ud83d\\udcf7',accept:'.pdf,.jpg,.jpeg,.png',required:true},
    {key:'equivalency',label:'Equivalency Letter',icon:'\\ud83d\\udcdc',accept:'.pdf,.jpg,.jpeg,.png',required:true}
  ],
  doctorate:[
    {key:'master_diploma',label:'Master Diploma',icon:'\\ud83c\\udf93',accept:'.pdf,.jpg,.jpeg,.png',required:true},
    {key:'master_transcript',label:'Master Transcript',icon:'\\ud83d\\udccb',accept:'.pdf,.jpg,.jpeg,.png',required:true},
    {key:'bachelor_diploma',label:'Bachelor Diploma',icon:'\\ud83c\\udf93',accept:'.pdf,.jpg,.jpeg,.png',required:true},
    {key:'passport',label:'Passport',icon:'\\ud83d\\udec2',accept:'.pdf,.jpg,.jpeg,.png',required:true},
    {key:'photo',label:'Photograph',icon:'\\ud83d\\udcf7',accept:'.pdf,.jpg,.jpeg,.png',required:true}
  ]
};

function degreeToLevel(degree){
  if(!degree)return 'undergraduate';
  var d=degree.toLowerCase();
  if(d.indexOf('phd')>=0||d.indexOf('doctor')>=0)return 'doctorate';
  if(d.indexOf('master')>=0||d.indexOf('graduate')>=0||d.indexOf('msc')>=0||d.indexOf('mba')>=0)return 'graduate';
  if(d.indexOf('pathway')>=0||d.indexOf('prep')>=0||d.indexOf('language')>=0||d.indexOf('foundation')>=0)return 'pathway';
  return 'undergraduate';
}

var __scanLibsPromise=null;
function loadScanLibs(){
  if(__scanLibsPromise)return __scanLibsPromise;
  __scanLibsPromise=new Promise(function(resolve,reject){
    function addScript(src){
      return new Promise(function(res,rej){
        var s=document.createElement('script');
        s.src=src;s.async=true;
        s.onload=function(){res();};
        s.onerror=function(){rej(new Error('load fail: '+src));};
        document.head.appendChild(s);
      });
    }
    function waitForCv(){
      return new Promise(function(res,rej){
        var start=Date.now();
        (function poll(){
          if(window.cv&&window.cv.Mat)return res();
          if(window.cv&&typeof window.cv.then==='function'){
            window.cv.then(function(){res();}).catch(rej);
            return;
          }
          if(Date.now()-start>30000)return rej(new Error('cv timeout'));
          setTimeout(poll,150);
        })();
      });
    }
    var cvP=window.cv&&window.cv.Mat?Promise.resolve():addScript('https://docs.opencv.org/4.10.0/opencv.js').then(waitForCv);
    var jsP=window.jscanify?Promise.resolve():addScript('https://cdn.jsdelivr.net/npm/jscanify@1.3.0/src/jscanify.min.js');
    var pdfP=window.jspdf?Promise.resolve():addScript('https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js');
    Promise.all([cvP,jsP,pdfP]).then(function(){resolve();}).catch(function(err){__scanLibsPromise=null;reject(err);});
  });
  return __scanLibsPromise;
}

function enhanceContrast(canvas){
  try{
    var ctx=canvas.getContext('2d');
    var img=ctx.getImageData(0,0,canvas.width,canvas.height);
    var d=img.data;
    var min=255,max=0;
    for(var i=0;i<d.length;i+=4){
      var l=(d[i]*0.299+d[i+1]*0.587+d[i+2]*0.114)|0;
      if(l<min)min=l;if(l>max)max=l;
    }
    var range=Math.max(1,max-min);
    var scale=255/range;
    for(var j=0;j<d.length;j+=4){
      d[j]=Math.min(255,Math.max(0,(d[j]-min)*scale));
      d[j+1]=Math.min(255,Math.max(0,(d[j+1]-min)*scale));
      d[j+2]=Math.min(255,Math.max(0,(d[j+2]-min)*scale));
    }
    ctx.putImageData(img,0,0);
  }catch(e){}
}

function canvasToBlob(canvas,type,quality){
  return new Promise(function(res){
    if(canvas.toBlob)canvas.toBlob(function(b){res(b);},type||'image/jpeg',quality||0.92);
    else{
      var d=canvas.toDataURL(type||'image/jpeg',quality||0.92);
      var bin=atob(d.split(',')[1]);var arr=new Uint8Array(bin.length);
      for(var i=0;i<bin.length;i++)arr[i]=bin.charCodeAt(i);
      res(new Blob([arr],{type:type||'image/jpeg'}));
    }
  });
}

function prefersNativeCameraCapture(){
  var ua=navigator.userAgent||'';
  var mobileUa=/Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  var coarse=false;
  try{coarse=!!(window.matchMedia&&window.matchMedia('(pointer: coarse)').matches);}catch(e){}
  return mobileUa||coarse;
}

function findNativeCameraInput(key){
  var inputs=$$('[data-doc-camera]');
  for(var i=0;i<inputs.length;i++){
    if(inputs[i].getAttribute('data-doc-camera')===key)return inputs[i];
  }
  return null;
}

function openScanner(baseName,onCapture,onFallback){
  var ov=document.createElement('div');
  ov.className='ew-scan-overlay';
  ov.innerHTML='<div class="ew-scan-header"><h4>Document Scanner</h4><button type="button" class="ew-scan-close">\\u00d7</button></div>'+
    '<div class="ew-scan-stage"><div class="ew-scan-loading">Loading scanner\\u2026<div class="ew-scan-loading-hint">First load downloads the scanner engine (~8 MB).</div></div></div>'+
    '<div class="ew-scan-pages" style="display:none"></div>'+
    '<div class="ew-scan-bar" style="display:none"></div>';
  document.body.appendChild(ov);
  var stage=ov.querySelector('.ew-scan-stage');
  var bar=ov.querySelector('.ew-scan-bar');
  var pagesEl=ov.querySelector('.ew-scan-pages');
  var stream=null;var rafId=null;var pages=[];var video=null;var overlayCv=null;var scanner=null;
  function stop(){
    if(rafId)cancelAnimationFrame(rafId);rafId=null;
    if(stream){stream.getTracks().forEach(function(t){t.stop();});stream=null;}
  }
  function destroy(){stop();if(ov.parentNode)ov.parentNode.removeChild(ov);}
  ov.querySelector('.ew-scan-close').addEventListener('click',destroy);
  function showErr(msg){
    stop();
    stage.innerHTML='<div class="ew-scan-loading" style="color:#fca5a5">'+esc(msg)+'</div>';
    bar.style.display='flex';bar.innerHTML='';
    if(onFallback){
      var fallback=document.createElement('button');fallback.className='primary';fallback.textContent='Use device camera / choose image';
      fallback.addEventListener('click',function(){destroy();onFallback();});
      bar.appendChild(fallback);
    }
    var close=document.createElement('button');close.textContent='Close';close.addEventListener('click',destroy);bar.appendChild(close);
  }
  function startLive(){
    stage.innerHTML='';
    video=document.createElement('video');
    video.setAttribute('playsinline','');video.muted=true;video.autoplay=true;
    overlayCv=document.createElement('canvas');
    overlayCv.className='ew-scan-overlay-cv';
    var hint=document.createElement('div');hint.className='ew-scan-hint';hint.textContent='Position the document inside the frame';
    stage.appendChild(video);stage.appendChild(overlayCv);stage.appendChild(hint);
    if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){showErr('Camera not supported in this browser.');return;}
    if(location.protocol!=='https:'&&location.hostname!=='localhost'){showErr('Camera scanner requires HTTPS.');return;}
    navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080}},audio:false})
      .then(function(s){
        stream=s;video.srcObject=s;
        video.onloadedmetadata=function(){
          video.play().catch(function(){showErr('Camera preview could not be started.');});
          try{scanner=new window.jscanify();}catch(e){showErr('Scanner engine could not be initialized.');return;}
          function loop(){
            if(!video||video.readyState<2){rafId=requestAnimationFrame(loop);return;}
            overlayCv.width=video.videoWidth;overlayCv.height=video.videoHeight;
            try{
              var hl=scanner.highlightPaper(video);
              var octx=overlayCv.getContext('2d');
              octx.clearRect(0,0,overlayCv.width,overlayCv.height);
              octx.drawImage(hl,0,0,overlayCv.width,overlayCv.height);
            }catch(e){}
            rafId=requestAnimationFrame(loop);
          }
          loop();
          renderBar();
        };
      })
      .catch(function(err){
        var m='Could not access the camera.';
        if(err&&(err.name==='NotAllowedError'||err.name==='PermissionDeniedError'))m='Camera permission denied. Allow camera access and retry.';
        else if(err&&(err.name==='NotFoundError'||err.name==='OverconstrainedError'))m='No camera detected on this device.';
        showErr(m);
      });
  }
  function renderBar(){
    bar.style.display='flex';
    bar.innerHTML='';
    var cap=document.createElement('button');cap.className='primary';cap.textContent='Capture';
    cap.addEventListener('click',capture);
    bar.appendChild(cap);
    if(pages.length>0){
      var done=document.createElement('button');done.className='primary';done.textContent='Finish ('+pages.length+' page'+(pages.length>1?'s':'')+')';
      done.addEventListener('click',finishMulti);
      bar.appendChild(done);
    }
  }
  function renderPages(){
    if(pages.length===0){pagesEl.style.display='none';pagesEl.innerHTML='';return;}
    pagesEl.style.display='flex';pagesEl.innerHTML='';
    pages.forEach(function(p){
      var img=document.createElement('img');img.src=p.dataUrl;pagesEl.appendChild(img);
    });
  }
  function capture(){
    if(!video||video.readyState<2)return;
    try{
      var tmp=document.createElement('canvas');
      tmp.width=video.videoWidth;tmp.height=video.videoHeight;
      tmp.getContext('2d').drawImage(video,0,0);
      var extracted=tmp;
      if(scanner){
        try{extracted=scanner.extractPaper(tmp,Math.min(1240,tmp.width),Math.min(1754,tmp.height));}catch(e){extracted=tmp;}
      }
      enhanceContrast(extracted);
      showReview(extracted);
    }catch(e){showErr('Capture failed. Use the device camera or choose an image instead.');}
  }
  function showReview(canvas){
    stop();
    stage.innerHTML='';
    var img=document.createElement('img');
    img.src=canvas.toDataURL('image/jpeg',0.92);
    img.style.maxWidth='100%';img.style.maxHeight='100%';
    stage.appendChild(img);
    bar.innerHTML='';
    var retake=document.createElement('button');retake.textContent='Retake';retake.addEventListener('click',function(){startLive();});
    var add=document.createElement('button');add.textContent='Add page';add.addEventListener('click',function(){
      canvasToBlob(canvas,'image/jpeg',0.92).then(function(b){
        pages.push({blob:b,dataUrl:img.src,width:canvas.width,height:canvas.height});
        renderPages();startLive();
      });
    });
    var useBtn=document.createElement('button');useBtn.className='primary';useBtn.textContent=pages.length>0?'Finish ('+(pages.length+1)+' pages)':'Use this scan';
    useBtn.addEventListener('click',function(){
      canvasToBlob(canvas,'image/jpeg',0.92).then(function(b){
        if(pages.length===0){
          var f=new File([b],(baseName||'scan')+'.jpg',{type:'image/jpeg'});
          destroy();onCapture(f);
        }else{
          pages.push({blob:b,dataUrl:img.src,width:canvas.width,height:canvas.height});
          finishMulti();
        }
      });
    });
    bar.appendChild(retake);bar.appendChild(add);bar.appendChild(useBtn);
  }
  function finishMulti(){
    try{
      var jsPDF=window.jspdf.jsPDF;
      var pdf=new jsPDF({unit:'pt',format:'a4'});
      var pw=pdf.internal.pageSize.getWidth(),ph=pdf.internal.pageSize.getHeight();
      pages.forEach(function(p,i){
        if(i>0)pdf.addPage();
        var r=Math.min(pw/p.width,ph/p.height);
        var w=p.width*r,h=p.height*r;
        pdf.addImage(p.dataUrl,'JPEG',(pw-w)/2,(ph-h)/2,w,h);
      });
      var blob=pdf.output('blob');
      var f=new File([blob],(baseName||'scan')+'.pdf',{type:'application/pdf'});
      destroy();onCapture(f);
    }catch(e){alert('PDF build failed: '+e.message);}
  }
  loadScanLibs().then(startLive).catch(function(){showErr('Could not load the scanner. Check connection and retry.');});
}

function handleScanForKey(key){
  var nativeInput=findNativeCameraInput(key);
  function openNative(){if(nativeInput)nativeInput.click();}
  if(prefersNativeCameraCapture()&&nativeInput){openNative();return;}
  openScanner(key,function(file){
    var vErr=validateFileUpload(file);
    if(vErr){alert(vErr);return;}
    handleDocumentFiles(key,[file]);
  },openNative);
}

function fileToBase64(file){
  return new Promise(function(resolve,reject){
    var reader=new FileReader();
    reader.onload=function(){
      var result=reader.result;
      var base64=result.split(',')[1]||result;
      resolve({base64:base64,mediaType:file.type,size:file.size,isImage:file.type.startsWith('image/'),fileName:file.name||'document'});
    };
    reader.onerror=reject;
    reader.readAsDataURL(file);
  });
}

function handleDocumentFiles(key,files){
  files=Array.prototype.slice.call(files||[]);
  if(files.length===0)return Promise.resolve();
  if(documentMergeInFlight[key])return documentMergeInFlight[key];
  for(var i=0;i<files.length;i++){
    var validationError=validateFileUpload(files[i]);
    if(validationError){alert(validationError);return Promise.resolve(null);}
  }
  if(isPhotoDocumentKey(key)&&files.length>1){
    var photoError='Photograph accepts only one PDF, JPG, JPEG or PNG file.';
    alert(photoError);return Promise.resolve(null);
  }
  var existing=uploadedDocs[key]||null;
  var currentPartCount=existing?(existing.partCount||1):0;
  if(!isPhotoDocumentKey(key)&&currentPartCount+files.length>6){
    var countError='You can combine up to 6 parts in one document box.';
    alert(countError);return Promise.resolve(null);
  }
  documentMergeInFlight[key]=Promise.all(files.map(fileToBase64)).then(function(results){
    if(isPhotoDocumentKey(key)){
      var photo=results[results.length-1];
      uploadedDocs[key]={label:key,base64:photo.base64,mediaType:photo.mediaType,sizeBytes:photo.size,isImage:photo.isImage,fileName:photo.fileName,partCount:1};
      return uploadedDocs[key];
    }
    if(!existing&&results.length===1){
      var single=results[0];
      uploadedDocs[key]={label:key,base64:single.base64,mediaType:single.mediaType,sizeBytes:single.size,isImage:single.isImage,fileName:single.fileName,partCount:1};
      return uploadedDocs[key];
    }
    var pending=results.slice();
    var current=existing||pending.shift();
    var apiBase=API.replace('/public/embed/'+SLUG,'');
    function mergeNext(){
      if(pending.length===0)return Promise.resolve(current);
      var next=pending.shift();
      var pair=[
        {data:current.base64,mediaType:current.mediaType,fileName:current.fileName||key+'.pdf'},
        {data:next.base64,mediaType:next.mediaType,fileName:next.fileName||key+'-part'}
      ];
      return fetch(apiBase+'/public/documents/merge-parts',{
        method:'POST',
        headers:{'Content-Type':'application/json','X-Application-Session':leadDocumentSessionToken||applicationSessionId},
        body:JSON.stringify({documentType:key,label:key,parts:pair})
      }).then(function(response){
        return response.json().catch(function(){return {}}).then(function(payload){
          if(!response.ok)throw new Error(payload.error||'Document parts could not be combined.');
          current={base64:payload.data,mediaType:payload.mediaType,sizeBytes:payload.sizeBytes,isImage:false,fileName:payload.fileName,pageCount:payload.pageCount};
          return mergeNext();
        });
      });
    }
    return mergeNext().then(function(finalDocument){
      uploadedDocs[key]={label:key,base64:finalDocument.base64,mediaType:finalDocument.mediaType,sizeBytes:finalDocument.sizeBytes||finalDocument.size,isImage:false,fileName:finalDocument.fileName,partCount:currentPartCount+results.length,pageCount:finalDocument.pageCount};
      return uploadedDocs[key];
    });
  }).then(function(result){
    if(formOpen)showModal();else render(false);
    return result;
  }).catch(function(error){
    alert(error&&error.message?error.message:'Document parts could not be combined.');
    return null;
  }).finally(function(){delete documentMergeInFlight[key];});
  return documentMergeInFlight[key];
}

function $(s,p){return (p||document).querySelector(s)}
function $$(s,p){return (p||document).querySelectorAll(s)}
function el(tag,cls,html){var e=document.createElement(tag);if(cls)e.className=cls;if(html)e.innerHTML=html;return e}

function fetchJSON(url){
  return fetch(addToken(url)).then(function(r){
    if(!r.ok)throw new Error(r.statusText);
    return r.json();
  });
}

function init(){
  fetchJSON(API+'/config').then(function(c){
    config=c;
    var pf=c.presetFilters||{};
    var defaultUniversityId=pf.universityScope==='all'?parseInt(pf.defaultUniversityId,10):NaN;
    if(Number.isInteger(defaultUniversityId)&&defaultUniversityId>0){
      userFilters.universityId=String(defaultUniversityId);
    }
    // loadPrograms also loads filters in parallel (cascading-aware).
    loadPrograms();
  }).catch(function(e){
    $('#ew-app').innerHTML='<div class="ew-empty"><p>Unable to load widget</p></div>';
  });
}

function buildUserFilterParams(){
  var params=new URLSearchParams();
  var pf=config.presetFilters||{};
  Object.keys(userFilters).forEach(function(k){
    if(!pf[k]&&userFilters[k]) params.set(k,userFilters[k]);
  });
  return params;
}

// Cascading: re-fetch facet options each time a selection changes so
// dropdowns only show choices compatible with the user's other picks.
function loadFilters(){
  return fetchJSON(API+'/filters?'+buildUserFilterParams().toString()).then(function(res){
    filters=res;
    return pruneStaleSelections();
  }).catch(function(){return false;});
}

function pruneStaleSelections(){
  if(!filters)return false;
  var pf=config.presetFilters||{};
  var changed=false;
  var checks=[
    ['country',(filters.countries||[]).reduce(function(s,v){s[v]=1;return s;},{})],
    ['universityType',(filters.universityTypes||[]).reduce(function(s,v){s[v]=1;return s;},{})],
    ['universityId',(filters.universities||[]).reduce(function(s,u){s[String(u.id)]=1;return s;},{})],
    ['level',(filters.degrees||[]).reduce(function(s,v){s[v]=1;return s;},{})],
    ['language',(filters.languages||[]).reduce(function(s,v){s[v]=1;return s;},{})],
    ['field',(filters.fields||[]).reduce(function(s,v){s[v]=1;return s;},{})]
  ];
  checks.forEach(function(pair){
    var k=pair[0],valid=pair[1];
    if(pf[k])return;
    if(userFilters[k]&&!valid[String(userFilters[k])]){userFilters[k]='';changed=true;}
  });
  return changed;
}

function loadPrograms(){
  var params=buildUserFilterParams();
  params.set('page',currentPage);
  params.set('limit','12');

  render(true);
  Promise.all([
    fetchJSON(API+'/programs?'+params.toString()).then(function(res){programs=res.data;meta=res.meta;}).catch(function(){}),
    loadFilters()
  ]).then(function(results){
    if(!results[1])return;
    // A configured default can become stale when a university is disabled or
    // no longer matches the other preset filters. Fall back to the valid
    // unfiltered result set instead of leaving an empty, misleading widget.
    var retryParams=buildUserFilterParams();
    retryParams.set('page',currentPage);
    retryParams.set('limit','12');
    return fetchJSON(API+'/programs?'+retryParams.toString()).then(function(res){programs=res.data;meta=res.meta;}).catch(function(){});
  }).then(function(){
    render(false);
  });
}

function render(loading){
  var app=$('#ew-app');
  var html='';

  if(MODE!=='application_only'&&MODE!=='lead_form'){
    html+=renderFilters();
    if(loading){
      html+='<div class="ew-skeleton">';
      for(var i=0;i<6;i++)html+='<div class="ew-skeleton-card"></div>';
      html+='</div>';
    } else {
      html+='<div class="ew-results-info">'+meta.total+' program'+(meta.total!==1?'s':'')+' found</div>';
      if(programs.length===0){
        html+='<div class="ew-empty"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"/></svg><p>No programs match your search criteria</p></div>';
      } else {
        html+='<div class="ew-grid">';
        programs.forEach(function(p){html+=renderCard(p)});
        html+='</div>';
        html+=renderPagination();
      }
    }
  }

  if(MODE==='application_only'||MODE==='lead_form'){
    html+=renderFormInline();
  }

  app.innerHTML=html;
  bindEvents();
  if(formOpen) showModal();
  resizeParent();
}

function renderFilters(){
  if(!filters||!config)return '';
  var pf=config.presetFilters||{};
  var locked=config.lockedFilters||[];
  var hidden=config.hiddenFilters||[];
  var h='<div class="ew-filters">';

  h+='<div class="ew-filter-group" style="min-width:200px"><label>Search</label><input type="text" id="ew-search" placeholder="Search programs..." value="'+esc(userFilters.search||'')+'"></div>';

  if(!hidden.includes('country')&&!pf.country){
    h+='<div class="ew-filter-group"><label>Country</label><select id="ew-f-country"'+(locked.includes('country')?' disabled':'')+'><option value="">All Countries</option>';
    (filters.countries||[]).forEach(function(c){h+='<option value="'+esc(c)+'"'+(userFilters.country===c?' selected':'')+'>'+esc(c)+'</option>'});
    h+='</select></div>';
  }
  if(!hidden.includes('universityType')&&!pf.universityType){
    h+='<div class="ew-filter-group"><label>Type</label><select id="ew-f-universityType"'+(locked.includes('universityType')?' disabled':'')+'><option value="">All Types</option>';
    (filters.universityTypes||[]).forEach(function(t){h+='<option value="'+esc(t)+'"'+(userFilters.universityType===t?' selected':'')+'>'+esc(t)+'</option>'});
    h+='</select></div>';
  }
  var hasUniversityScope=pf.universityScope==='selected'||(Array.isArray(pf.universityIds)&&pf.universityIds.length>0)||!!pf.universityId;
  if(!hidden.includes('universityId')&&!hasUniversityScope){
    h+='<div class="ew-filter-group"><label>University</label><select id="ew-f-universityId"'+(locked.includes('universityId')?' disabled':'')+'><option value="">All Universities</option>';
    (filters.universities||[]).forEach(function(u){h+='<option value="'+esc(String(u.id))+'"'+(userFilters.universityId==u.id?' selected':'')+'>'+esc(u.name)+'</option>'});
    h+='</select></div>';
  }
  if(!hidden.includes('level')&&!pf.level){
    h+='<div class="ew-filter-group"><label>Level</label><select id="ew-f-level"'+(locked.includes('level')?' disabled':'')+'><option value="">All Levels</option>';
    (filters.degrees||[]).forEach(function(d){h+='<option value="'+esc(d)+'"'+(userFilters.level===d?' selected':'')+'>'+esc(d)+'</option>'});
    h+='</select></div>';
  }
  if(!hidden.includes('language')&&!pf.language){
    h+='<div class="ew-filter-group"><label>Language</label><select id="ew-f-language"'+(locked.includes('language')?' disabled':'')+'><option value="">All Languages</option>';
    (filters.languages||[]).forEach(function(l){h+='<option value="'+esc(l)+'"'+(userFilters.language===l?' selected':'')+'>'+esc(l)+'</option>'});
    h+='</select></div>';
  }
  if(!hidden.includes('field')&&!pf.field){
    h+='<div class="ew-filter-group"><label>Field of study</label><select id="ew-f-field"'+(locked.includes('field')?' disabled':'')+'><option value="">All Fields</option>';
    (filters.fields||[]).forEach(function(f){h+='<option value="'+esc(f)+'"'+(userFilters.field===f?' selected':'')+'>'+esc(f)+'</option>'});
    h+='</select></div>';
  }

  h+='</div>';
  return h;
}

var ICON_MAPPIN='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 7-8 13-8 13s-8-6-8-13a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>';
var ICON_LANG='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></svg>';
var ICON_CLOCK='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
var ICON_BOOK='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/></svg>';
var ICON_DOLLAR='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>';
var ICON_AWARD='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="6"/><path d="M15.477 12.89 17 22l-5-3-5 3 1.523-9.11"/></svg>';
var ICON_INFO='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';
var ICON_GRAD='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/></svg>';
var ICON_SHIELD='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>';

function fmtFee(amount,cur){
  if(amount==null||isNaN(amount))return '';
  return (cur||'USD')+' '+Number(amount).toLocaleString();
}

function renderCard(p){
  var loc=[p.universityCity,p.universityCountry].filter(Boolean).map(esc).join(', ');
  var hasDiscount=p.discountedFee&&p.tuitionFee&&p.discountedFee<p.tuitionFee;
  var effFee=p.discountedFee||p.tuitionFee;
  var pct=hasDiscount?Math.round(((p.tuitionFee-p.discountedFee)/p.tuitionFee)*100):0;
  var logoInner=p.universityLogoUrl?'<img src="'+esc(p.universityLogoUrl)+'" alt="" onerror="this.style.display=\\'none\\';this.nextElementSibling&&(this.nextElementSibling.style.display=\\'block\\')">'+'<span style="display:none" class="ew-card-logo-fallback">'+ICON_GRAD+'</span>':'<span class="ew-card-logo-fallback">'+ICON_GRAD+'</span>';

  var h='<div class="ew-card">';

  /* ── Banner (white) ── */
  h+='<div class="ew-card-banner">';
  h+='<div class="ew-card-logo-wrap">'+logoInner+'</div>';
  h+='<div class="ew-card-uni-name"><div class="ew-card-uni-name-text">'+esc(p.universityName||'')+'</div>';
  if(loc)h+='<div class="ew-card-uni-loc">'+ICON_MAPPIN+'<span>'+loc+'</span></div>';
  h+='</div>';
  h+='<div class="ew-card-pills">';
  if(p.universityType)h+='<span class="ew-pill-soft">'+esc(p.universityType)+'</span>';
  if(p.degree)h+='<span class="ew-pill-primary">'+esc(p.degree)+'</span>';
  h+='</div></div>';

  /* ── Body ── */
  h+='<div class="ew-card-body">';
  h+='<div class="ew-card-title">'+esc(p.name)+'</div>';

  /* Fee + Scholarship */
  if(effFee){
    h+='<div class="ew-fee-section">';
    h+='<div class="ew-fee-section-row">';
    h+='<div class="ew-fee-values">';
    h+='<span class="ew-fee-section-label">Tuition Fee'+(p.feeType?' ('+esc(p.feeType)+')':'')+'</span>';
    h+='<div class="ew-fee-row">';
    h+='<span class="ew-fee-main">'+esc(fmtFee(effFee,p.currency))+'</span>';
    if(hasDiscount)h+=' <span class="ew-fee-orig">'+esc(fmtFee(p.tuitionFee,p.currency))+'</span>';
    if(hasDiscount)h+=' <span class="ew-fee-pct">'+pct+'% OFF</span>';
    h+='</div></div>';
    if(p.scholarship&&p.scholarship>0){
      h+='<div class="ew-scholarship-box">'+ICON_AWARD+'<div class="ew-scholarship-box-lbl">Scholarship:</div><div class="ew-scholarship-box-amt">'+esc(fmtFee(p.scholarship,p.currency))+'</div></div>';
    }
    h+='</div></div>';
  } else if(p.scholarship&&p.scholarship>0){
    h+='<div class="ew-scholarship-box" style="margin-bottom:12px;display:inline-block">'+ICON_AWARD+'<div class="ew-scholarship-box-lbl">Scholarship:</div><div class="ew-scholarship-box-amt">'+esc(fmtFee(p.scholarship,p.currency))+'</div></div>';
  }

  /* Deposit strip */
  if(p.depositFee&&p.depositFee>0){
    h+='<div class="ew-deposit-strip">'+ICON_SHIELD+'<span>Secure your place with a '+esc(fmtFee(p.depositFee,p.currency))+' deposit</span></div>';
  }

  /* Metadata 3-col grid */
  h+='<div class="ew-card-meta">';
  if(p.degree)h+='<div class="ew-meta-cell"><div class="ew-meta-label"><span style="color:#7c3aed">'+ICON_GRAD+'</span>Degree</div><div class="ew-meta-val">'+esc(p.degree)+'</div></div>';
  if(p.field)h+='<div class="ew-meta-cell"><div class="ew-meta-label"><span style="color:#f97316">'+ICON_BOOK+'</span>Field</div><div class="ew-meta-val">'+esc(p.field)+'</div></div>';
  if(p.language)h+='<div class="ew-meta-cell"><div class="ew-meta-label"><span style="color:#3b82f6">'+ICON_LANG+'</span>Language</div><div class="ew-meta-val">'+esc(p.language)+'</div></div>';
  if(p.duration)h+='<div class="ew-meta-cell"><div class="ew-meta-label"><span style="color:#22c55e">'+ICON_CLOCK+'</span>Duration</div><div class="ew-meta-val">'+esc(p.duration)+'</div></div>';
  if(p.intakes)h+='<div class="ew-meta-cell"><div class="ew-meta-label"><span style="color:#6366f1">'+ICON_BOOK+'</span>Intake</div><div class="ew-meta-val">'+esc(p.intakes)+'</div></div>';
  if(p.languageFee&&p.languageFee>0)h+='<div class="ew-meta-cell"><div class="ew-meta-label"><span style="color:#ec4899">'+ICON_DOLLAR+'</span>Language Fee</div><div class="ew-meta-val">'+esc(fmtFee(p.languageFee,p.currency))+'</div></div>';
  h+='</div>';

  /* Actions */
  h+='<div class="ew-card-actions">';
  h+='<button type="button" class="ew-btn-info" aria-label="Details" data-info="'+p.id+'">'+ICON_INFO+'</button>';
  h+='<button type="button" class="ew-btn" data-apply="'+p.id+'">Apply Now \u2192</button>';
  h+='</div>';

  h+='</div></div>';
  return h;
}

function renderPagination(){
  if(!meta||meta.totalPages<=1)return '';
  var h='<div class="ew-pagination">';
  h+='<button data-page="'+(currentPage-1)+'"'+(currentPage<=1?' disabled':'')+'>← Prev</button>';
  var start=Math.max(1,currentPage-2),end=Math.min(meta.totalPages,currentPage+2);
  for(var i=start;i<=end;i++){
    h+='<button data-page="'+i+'"'+(i===currentPage?' class="active"':'')+'>'+i+'</button>';
  }
  h+='<button data-page="'+(currentPage+1)+'"'+(currentPage>=meta.totalPages?' disabled':'')+'>Next →</button>';
  h+='</div>';
  return h;
}

function renderFormInline(){
  if(formSubmitted) return renderSuccess();
  return '<div style="max-width:580px;margin:0 auto">'+renderFormContent(null)+'</div>';
}

function renderSteps(){
  // Lead-form mode is single-step (contact only) — skip the stepper strip.
  if(MODE==='lead_form')return '';
  // Mirror the homepage non-login ApplyDialog ordering:
  // 1) Personal Info  2) Documents  3) Review & Submit
  var steps=['Personal Info','Documents','Review & Submit'];
  var stepKeys=['personal','documents','review'];
  var currentIdx=stepKeys.indexOf(formStep);
  // 'analyzing' is a transient sub-state of the documents step.
  if(formStep==='analyzing')currentIdx=1;
  var h='<div class="ew-steps">';
  for(var i=0;i<steps.length;i++){
    var cls='ew-step';
    if(i<currentIdx)cls+=' done';
    else if(i===currentIdx)cls+=' active';
    h+='<div class="'+cls+'"><div class="ew-step-num">'+(i<currentIdx?'\\u2713':(i+1))+'</div><div class="ew-step-label">'+steps[i]+'</div></div>';
    if(i<steps.length-1)h+='<div class="ew-step-line" style="background:'+(i<currentIdx?'#22c55e':'#e2e8f0')+'"></div>';
  }
  h+='</div>';
  return h;
}

function getFormLevel(){
  if(formProgram&&formProgram.degree)return degreeToLevel(formProgram.degree);
  var v=savedFormData.desiredLevel||'';
  if(v){
    v=v.toLowerCase();
    if(v.indexOf('phd')>=0||v.indexOf('doctor')>=0)return 'doctorate';
    if(v.indexOf('master')>=0)return 'graduate';
    if(v.indexOf('foundation')>=0||v.indexOf('pathway')>=0)return 'pathway';
  }
  return 'undergraduate';
}

function renderFormContent(prog){
  var h=renderSteps();
  // Shared helper: render a single form field, optionally tagged as
  // AI-extracted (green border + "AI" badge), used by both the personal
  // step and the review step. Declared in this scope so it can append to
  // the local h accumulator.
  function aiField(name,label,type,required,isHalf){
    var val=savedFormData[name]||'';
    var isAi=!!extractedFields[name];
    var cls='ew-form-group'+(isHalf?'':' full');
    var style=isAi?'border-color:#22c55e;background:#f0fdf4':'';
    h+='<div class="'+cls+'"><label>'+label+(required?' *':'')+(isAi?' <span style="color:#22c55e;font-size:0.65rem;font-weight:700;margin-left:4px">AI</span>':'')+'</label><input name="'+name+'" type="'+(type||'text')+'" value="'+esc(val)+'" style="'+style+'"'+(required?' required':'')+'></div>';
  }
  // Cross-platform country-code dropdown that uses flagcdn PNG images
  // instead of unicode flag emoji (which render as letter pairs on Windows).
  // Hidden input named "countryCode" so FormData/snapshotForm picks it up.
  function buildCcDropdown(sel){
    var ops=PHONE_CODES;
    var cur=null;
    for(var pi=0;pi<ops.length;pi++){if(ops[pi][0]===sel){cur=ops[pi];break;}}
    var trigInner=cur
      ?'<img src="https://flagcdn.com/24x18/'+cur[1].toLowerCase()+'.png" srcset="https://flagcdn.com/48x36/'+cur[1].toLowerCase()+'.png 2x" alt=""><span class="ew-cc-code">'+cur[0]+'</span><span class="ew-cc-caret">\\u25BC</span>'
      :'<span class="ew-cc-code" style="color:#9ca3af">'+esc(LC.countryCode)+'</span><span class="ew-cc-caret">\\u25BC</span>';
    var listHtml='';
    for(var pj=0;pj<ops.length;pj++){
      var o=ops[pj];
      var lc=o[1].toLowerCase();
      var act=o[0]===sel?' active':'';
      listHtml+='<div class="ew-cc-item'+act+'" role="option" tabindex="-1" aria-selected="'+(o[0]===sel?'true':'false')+'" data-cc="'+o[0]+'" data-iso="'+o[1]+'" data-name="'+esc(String(o[2]||'').toLowerCase())+'">'+
        '<img src="https://flagcdn.com/24x18/'+lc+'.png" srcset="https://flagcdn.com/48x36/'+lc+'.png 2x" alt="">'+
        '<span class="ew-cc-item-code">'+o[0]+'</span>'+
        '<span class="ew-cc-item-name">'+o[2]+'</span>'+
      '</div>';
    }
    return '<div class="ew-cc"><input type="hidden" name="countryCode" value="'+esc(sel)+'">'+
      '<button type="button" class="ew-cc-trigger" aria-haspopup="listbox" aria-expanded="false">'+trigInner+'</button>'+
      '<div class="ew-cc-list" role="listbox">'+
        '<input type="text" class="ew-cc-search" placeholder="'+esc(LC.countrySearch)+'" autocomplete="off">'+
        listHtml+
        '<div class="ew-cc-empty">'+esc(LC.countryNoMatches)+'</div>'+
      '</div>'+
    '</div>';
  }
  if(formStep==='personal'){
    // Step 1 — Personal Info: collect ONLY the same basic contact fields
    // shown on the homepage non-login ApplyDialog (first/last name, email,
    // phone) plus an "Applying for" summary pill. Nationality / desired
    // level / preferred uni or program are deliberately deferred to the
    // Review step to keep the first screen short and welcoming.
    h+='<h3>'+esc(MODE==='lead_form'?LC.apply:'Apply')+(prog?' \\u2014 '+esc(prog.name):'')+'</h3>';
    if(prog)h+='<div class="ew-modal-subtitle">'+esc(prog.universityName||'')+'</div>';
    else h+='<div class="ew-modal-subtitle">'+esc(MODE==='lead_form'?LC.intro:'Tell us about yourself to get started.')+'</div>';
    // Lightly tinted info card matching the portal's primary/5 callout.
    h+='<div style="background:${primaryColor}10;border:1px solid ${primaryColor}30;border-radius:12px;padding:14px;margin:14px 0">';
    h+='<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px"><span style="font-size:0.95rem">\\ud83d\\udc65</span><strong style="font-size:0.88rem;color:${primaryColor}">'+esc(MODE==='lead_form'?LC.personalInfo:'Personal Information')+'</strong></div>';
    h+='<p style="font-size:0.78rem;color:#64748b;margin:0;line-height:1.45">'+esc(MODE==='lead_form'?LC.personalInfoHelp:'Please provide your contact details. You will be able to review and update them before submitting.')+'</p>';
    h+='</div>';
    h+='<form id="ew-personal-form" onsubmit="return false">';
    h+='<input type="text" name="_hp" class="ew-hp" tabindex="-1" autocomplete="off">';
    h+='<div class="ew-form-grid">';
    aiField('firstName',MODE==='lead_form'?LC.firstName:'First Name','text',true,true);
    aiField('lastName',MODE==='lead_form'?LC.lastName:'Last Name','text',true,true);
    aiField('email',MODE==='lead_form'?LC.email:'Email','email',true,false);
    var fv=savedFormData;
    // Phone with a flag-prefixed country code picker (matches the portal's
    // PhoneCodePicker visual). Spans the full row.
    var sel=fv.countryCode||'';
    h+='<div class="ew-form-group full"><label>'+esc(MODE==='lead_form'?LC.phone:'Phone')+' *</label><div class="ew-phone-group">'+buildCcDropdown(sel)+'<input name="phone" placeholder="'+esc(MODE==='lead_form'?LC.phonePlaceholder:'Phone number')+'" value="'+esc(fv.phone||'')+'" required></div>'+(phoneError?'<div class="ew-field-err">'+esc(MODE==='lead_form'?LC.phoneInvalid:'Please enter a valid phone number for the selected country.')+'</div>':'')+'</div>';
    h+='</div>';
    if(prog){
      // "Applying for" summary pill (mirrors portal's bg-secondary/50 card).
      h+='<div style="background:#f1f5f9;border-radius:12px;padding:12px 14px;margin:14px 0;font-size:0.85rem">';
      h+='<div style="font-weight:600;color:#0f172a;margin-bottom:2px">Applying for:</div>';
      h+='<div style="color:#64748b">'+esc(prog.name)+(prog.universityName?' \\u2014 '+esc(prog.universityName):'')+'</div>';
      h+='</div>';
    }
    h+='<div class="ew-form-actions" style="margin-top:14px">';
    var nextLabel=(MODE==='lead_form')?(formLoading?LC.submitting:LC.submit):'Next \\u2192';
    h+='<button type="button" class="ew-btn" id="ew-next-personal"'+(formLoading?' disabled':'')+' style="background:linear-gradient(135deg,${primaryColor},${secondaryColor})">'+esc(nextLabel)+'</button>';
    if(formOpen)h+='<button type="button" class="ew-btn ew-btn-outline" id="ew-cancel">'+esc(MODE==='lead_form'?LC.cancel:'Cancel')+'</button>';
    h+='</div></form>';
  } else if(formStep==='documents'){
    // Step 2 — Documents: upload + AI extract option.
    h+='<div class="ew-ai-badge">\\u2728 AI-Powered Document Analysis</div>';
    h+='<h3>Apply'+(prog?' \\u2014 '+esc(prog.name):'')+'</h3>';
    if(prog)h+='<div class="ew-modal-subtitle">'+esc(prog.universityName||'')+'</div>';
    h+='<div style="background:${primaryColor}08;border:1px solid ${primaryColor}25;border-radius:10px;padding:14px;margin:12px 0">';
    h+='<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><span style="font-size:1rem">\\u2728</span><strong style="font-size:0.85rem">AI-Powered Document Analysis</strong></div>';
    h+='<p style="font-size:0.78rem;color:#64748b;margin:0">Upload your documents and our AI will automatically extract your information. You can review and edit before submitting.</p>';
    h+='</div>';
    var docTypes=getDocTypes();
    h+='<div class="ew-doc-grid">';
    for(var i=0;i<docTypes.length;i++){
      var d=docTypes[i];
      var isUploaded=!!uploadedDocs[d.key];
      h+='<div class="ew-doc-slot'+(isUploaded?' uploaded':'')+'" data-doc-key="'+esc(d.key)+'">';
      h+='<input type="file" accept="'+esc(safeAccept(d.accept))+'"'+(isPhotoDocumentKey(d.key)?'':' multiple')+' data-doc-input="'+esc(d.key)+'">';
      h+='<input type="file" accept="image/*" capture="environment" class="ew-doc-camera-input" data-doc-camera="'+esc(d.key)+'" tabindex="-1">';
      h+='<div class="ew-doc-icon">'+esc(d.icon)+'</div>';
      h+='<div class="ew-doc-label">'+esc(d.label)+'</div>';
      if(isUploaded){
        var partCount=uploadedDocs[d.key].partCount||1;
        h+='<div class="ew-doc-status">\\u2713 Uploaded'+(partCount>1?' \\u00b7 '+partCount+' parts':'')+'</div>';
        if(!isPhotoDocumentKey(d.key))h+='<div class="ew-doc-hint">Click to add another part</div>';
      } else {
        h+='<div class="ew-doc-hint">Click to upload</div>';
        if(d.required)h+='<div class="ew-doc-required">Required</div>';
      }
      h+='<button type="button" class="ew-doc-scan-btn" data-doc-scan="'+esc(d.key)+'" title="Scan with camera">\\ud83d\\udcf7 Scan</button>';
      h+='</div>';
    }
    h+='</div>';
    var _missReq=missingRequiredDocs();
    var _gate=_missReq.length>0;
    h+='<div class="ew-doc-guidance'+(_gate?'':' size-only')+'">';
    if(_gate)h+='<span>'+esc(REQUIRED_DOCS_MSG.replace('{docs}',_missReq.map(function(d){return d.label;}).join(', ')))+'</span>';
    h+='<span class="ew-doc-size-badge">'+esc(${JSON.stringify(APPLICATION_DOCUMENT_HELP_TEXT)})+'</span>';
    h+='</div>';
    h+='<div class="ew-form-actions" style="margin-top:16px">';
    h+='<button type="button" class="ew-btn" id="ew-analyze-btn"'+(_gate?' disabled':'')+' style="background:linear-gradient(135deg,${primaryColor},${secondaryColor})">\\u2728 Analyze with AI & Continue</button>';
    h+='<button type="button" class="ew-btn ew-btn-outline" id="ew-skip-btn"'+(_gate?' disabled':'')+'>Skip & Continue</button>';
    h+='<button type="button" class="ew-btn-back" id="ew-back-personal">\\u2190 Back</button>';
    if(formOpen)h+='<button type="button" class="ew-btn ew-btn-outline" id="ew-cancel">Cancel</button>';
    h+='</div>';
  } else if(formStep==='analyzing'){
    h+='<div class="ew-analyzing">';
    h+='<div class="ew-analyzing-spinner"></div>';
    h+='<h4>\\u2728 AI is analyzing your documents...</h4>';
    h+='<p>This usually takes a few seconds</p>';
    h+='</div>';
  } else if(formStep==='review'){
    // Step 3 — Review & Submit: show every field editable, AI-extracted
    // ones tagged with the green AI badge. Submit happens here.
    h+='<h3>Review & Submit</h3>';
    if(prog)h+='<div class="ew-modal-subtitle">'+esc(prog.name)+' \\u2014 '+esc(prog.universityName||'')+'</div>';
    else h+='<div class="ew-modal-subtitle">Review your details and submit your application</div>';
    var eKeys=Object.keys(extractedFields);
    if(eKeys.length>0){
      h+='<div class="ew-extracted-info" style="margin-bottom:16px">';
      h+='<h5>\\u2713 AI extracted '+eKeys.length+' field'+(eKeys.length!==1?'s':'')+'. Please review and complete the form.</h5>';
      h+='</div>';
    }
    h+='<form id="ew-form">';
    h+='<input type="text" name="_hp" class="ew-hp" tabindex="-1" autocomplete="off">';
    h+='<div class="ew-form-grid">';
    var fv2=savedFormData;
    aiField('firstName','First Name','text',true,true);
    aiField('lastName','Last Name','text',true,true);
    aiField('email','Email','email',true,true);
    var sel2=fv2.countryCode||'';
    h+='<div class="ew-form-group"><label>Phone *</label><div class="ew-phone-group">'+buildCcDropdown(sel2)+'<input name="phone" placeholder="Phone number" value="'+esc(fv2.phone||'')+'" required></div>'+(phoneError?'<div class="ew-field-err">Please enter a valid phone number for the selected country.</div>':'')+'</div>';
    var natVal=savedFormData.nationality||'';
    var natIsAi=!!extractedFields.nationality;
    var natStyle=natIsAi?'border-color:#22c55e;background:#f0fdf4':'';
    var natOpts='<option value="">Select nationality...</option>';
    for(var ni=0;ni<NATIONALITIES.length;ni++){var nc=NATIONALITIES[ni];natOpts+='<option value="'+esc(nc)+'"'+(natVal===nc?' selected':'')+'>'+esc(nc)+'</option>';}
    h+='<div class="ew-form-group"><label>Nationality *'+(natIsAi?' <span style="color:#22c55e;font-size:0.65rem;font-weight:700;margin-left:4px">AI</span>':'')+'</label><select name="nationality" style="'+natStyle+'" required>'+natOpts+'</select></div>';
    h+='<div class="ew-form-group"><label>Desired Level</label><select name="desiredLevel"><option value="">Select...</option><option value="Foundation"'+(fv2.desiredLevel==='Foundation'?' selected':'')+'>Foundation</option><option value="Associate"'+(fv2.desiredLevel==='Associate'?' selected':'')+'>Associate</option><option value="Bachelor"'+(fv2.desiredLevel==='Bachelor'?' selected':'')+'>Bachelor</option><option value="Master"'+(fv2.desiredLevel==='Master'?' selected':'')+'>Master</option><option value="PhD"'+(fv2.desiredLevel==='PhD'?' selected':'')+'>PhD</option></select></div>';
    if(!prog){
      h+='<div class="ew-form-group"><label>Preferred University</label><input name="preferredUniversity" value="'+esc(fv2.preferredUniversity||'')+'"></div>';
      h+='<div class="ew-form-group"><label>Desired Program</label><input name="desiredProgram" value="'+esc(fv2.desiredProgram||'')+'"></div>';
    }
    // Personal details (most often AI-extracted from passport / transcripts).
    // These are required for application processing on the staff side, so they
    // are marked with "*" even though the AI usually fills them automatically.
    aiField('dateOfBirth','Date of Birth','date',true,true);
    // Gender — render as a select since aiField only supports input types.
    var gVal=savedFormData.gender||'';
    var gIsAi=!!extractedFields.gender;
    var gStyle=gIsAi?'border-color:#22c55e;background:#f0fdf4':'';
    var gLow=String(gVal).toLowerCase();
    h+='<div class="ew-form-group"><label>Gender *'+(gIsAi?' <span style="color:#22c55e;font-size:0.65rem;font-weight:700;margin-left:4px">AI</span>':'')+'</label><select name="gender" style="'+gStyle+'" required><option value="">Select...</option><option value="female"'+(gLow==='female'?' selected':'')+'>Female</option><option value="male"'+(gLow==='male'?' selected':'')+'>Male</option></select></div>';
    aiField('motherName','Mother Name','text',true,true);
    aiField('fatherName','Father Name','text',true,true);
    // Passport details.
    aiField('passportNumber','Passport Number','text',true,true);
    aiField('passportIssueDate','Passport Issue Date','date',false,true);
    aiField('passportExpiry','Passport Expiry','date',true,true);
    // Address — textarea (longer free-form), rendered inline.
    var adVal=savedFormData.address||'';
    var adIsAi=!!extractedFields.address;
    var adStyle=adIsAi?'border-color:#22c55e;background:#f0fdf4':'';
    h+='<div class="ew-form-group full"><label>Address *'+(adIsAi?' <span style="color:#22c55e;font-size:0.65rem;font-weight:700;margin-left:4px">AI</span>':'')+'</label><textarea name="address" rows="2" style="'+adStyle+'" required>'+esc(adVal)+'</textarea></div>';
    // Education.
    aiField('highSchool','High School','text',false,true);
    aiField('graduationYear','Graduation Year','number',false,true);
    aiField('gpa','GPA','text',false,true);
    aiField('languageScore','Language Score','text',false,true);
    h+='<div class="ew-form-group full"><label>Message</label><textarea name="message" rows="3">'+esc(fv2.message||'')+'</textarea></div>';
    h+='</div>';
    var docCount=Object.keys(uploadedDocs).length;
    if(docCount>0){
      h+='<div style="font-size:0.8rem;color:#64748b;margin-bottom:8px">\\ud83d\\udcc4 '+docCount+' document'+(docCount!==1?'s':'')+' will be submitted with your application</div>';
    }
    h+='<div class="ew-form-actions">';
    h+='<button type="submit" class="ew-btn"'+(formLoading?' disabled':'')+'>'+(formLoading?'Submitting...':'Submit Application')+'</button>';
    h+='<button type="button" class="ew-btn-back" id="ew-back-upload">\\u2190 Back to Documents</button>';
    if(formOpen)h+='<button type="button" class="ew-btn ew-btn-outline" id="ew-cancel">Cancel</button>';
    h+='</div></form>';
  }
  return h;
}

function renderSuccess(){
  if(MODE==='lead_form')return '<div class="ew-success"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg><h3>'+esc(LC.successTitle)+'</h3><p>'+esc(LC.successText)+'</p></div>';
  var docCount=Object.keys(uploadedDocs).length;
  var docMsg=docCount>0?' with '+docCount+' document'+(docCount!==1?'s':''):'';
  return '<div class="ew-success"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg><h3>Application Submitted!</h3><p>Thank you! Your application'+docMsg+' has been received. We will review it and get back to you shortly.</p></div>';
}

function computeModalPosition(modalHeight){
  var ROOT=document.querySelector('.ew-root');
  var rootHeight=ROOT?ROOT.offsetHeight:document.body.scrollHeight;
  if(!parentViewport){
    // Until the parent reports its actual viewport, cap the modal at 600px
    // (sensible single-screen size). Using window.innerHeight here would
    // return the iframe's tall internal height (we set iframe height to
    // root.scrollHeight so the host page scrolls naturally), which would
    // render the modal far taller than the visible host viewport.
    return {top:24,maxHeight:Math.max(300,Math.min(rootHeight-32,600))};
  }
  var pv=parentViewport;
  var visibleTopInIframe=Math.max(0,pv.parentScrollY-pv.iframeTop);
  var visibleBottomInIframe=Math.min(pv.iframeHeight||rootHeight,(pv.parentScrollY+pv.parentViewportHeight)-pv.iframeTop);
  var visibleHeight=Math.max(0,visibleBottomInIframe-visibleTopInIframe);
  // Hard-cap at 90% of the parent viewport AND no taller than 720px so the
  // modal fits comfortably on common laptop screens even when the parent
  // viewport is unusually tall.
  var maxHeight=Math.max(240,Math.min(pv.parentViewportHeight-32,720));
  if(visibleHeight<120){
    return {top:visibleTopInIframe+16,maxHeight:maxHeight};
  }
  var mh=modalHeight||0;
  var top;
  if(mh>0&&mh<visibleHeight){
    top=visibleTopInIframe+Math.max(8,(visibleHeight-mh)/2);
  } else {
    top=visibleTopInIframe+16;
  }
  return {top:top,maxHeight:maxHeight};
}

function repositionModal(){
  if(!modalElements)return;
  var modal=modalElements.modal;
  var pos=computeModalPosition(0);
  modal.style.maxHeight=pos.maxHeight+'px';
  var measured=modal.offsetHeight;
  var posFinal=computeModalPosition(measured);
  modal.style.top=posFinal.top+'px';
  modal.style.maxHeight=posFinal.maxHeight+'px';
}

function notifyParentModalOpen(){
  try{window.parent.postMessage({type:'edcons-modal-open',slug:SLUG},'*');}catch(e){}
  try{window.parent.postMessage({type:'edcons-viewport-request',slug:SLUG},'*');}catch(e){}
}

function notifyParentModalClose(){
  try{window.parent.postMessage({type:'edcons-modal-close',slug:SLUG},'*');}catch(e){}
}

function closeModal(){
  formOpen=false;
  if(modalElements){
    modalElements.overlay.remove();
    modalElements=null;
  }
  if(modalNotified){
    modalNotified=false;
    notifyParentModalClose();
  }
  // Modal overlay lives on document.body and is absolutely positioned, so
  // its removal does not change .ew-root scrollHeight. Trigger a manual
  // resize so the iframe shrinks back to the launcher card height.
  if(typeof resizeParent==='function')resizeParent();
}

function showModal(){
  var existing=$('.ew-modal-overlay');
  if(existing)existing.remove();
  var overlay=el('div','ew-modal-overlay');
  var modal=el('div','ew-modal');
  modal.innerHTML='<button class="ew-close-btn" id="ew-modal-close">&times;</button>'+(formSubmitted?renderSuccess():renderFormContent(formProgram));
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  modalElements={overlay:overlay,modal:modal};
  overlay.addEventListener('click',function(e){if(e.target===overlay){closeModal();}});
  bindModalEvents(modal,overlay);
  if(!modalNotified){
    modalNotified=true;
    notifyParentModalOpen();
  }
  repositionModal();
  setTimeout(repositionModal,60);
  // The modal is absolute-positioned on document.body, so the root-level
  // ResizeObserver won't see it. Push a fresh height to the host so the
  // iframe grows to contain the modal (and avoid the host clipping it).
  if(typeof resizeParent==='function'){resizeParent();setTimeout(resizeParent,80);}
}

function closeDetailModal(){
  detailOpen=false;detailProgram=null;
  if(modalElements){modalElements.overlay.remove();modalElements=null;}
  if(modalNotified){modalNotified=false;notifyParentModalClose();}
  if(typeof resizeParent==='function')resizeParent();
}

function showDetailModal(){
  var existing=$('.ew-modal-overlay');
  if(existing)existing.remove();
  var overlay=el('div','ew-modal-overlay');
  var modal=el('div','ew-modal');
  modal.innerHTML='<button class="ew-close-btn" id="ew-detail-close">&times;</button>'+renderDetailContent(detailProgram);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  modalElements={overlay:overlay,modal:modal};
  overlay.addEventListener('click',function(e){if(e.target===overlay){closeDetailModal();}});
  var closeBtn=$('#ew-detail-close',modal);
  if(closeBtn)closeBtn.addEventListener('click',function(){closeDetailModal();});
  var closeBtn2=$('#ew-detail-close-btn',modal);
  if(closeBtn2)closeBtn2.addEventListener('click',function(){closeDetailModal();});
  var applyBtn=$('#ew-detail-apply',modal);
  if(applyBtn)applyBtn.addEventListener('click',function(){
    var pid=parseInt(applyBtn.getAttribute('data-apply'));
    closeDetailModal();
    formProgram=programs.find(function(p){return p.id===pid})||null;
    formOpen=true;formSubmitted=false;formStep='personal';phoneError=false;uploadedDocs={};persistedDocumentFingerprints={};aiResult=null;extractedFields={};savedFormData={};leadId=null;leadDocumentSessionToken=null;leadCreating=false;handleNextPersonalInFlight=false;
    showModal();
    loadProgramDocs(pid,function(){if(formOpen)showModal();});
  });
  if(!modalNotified){modalNotified=true;notifyParentModalOpen();}
  repositionModal();
  setTimeout(repositionModal,60);
  if(typeof resizeParent==='function'){resizeParent();setTimeout(resizeParent,80);}
}

function renderDetailContent(p){
  if(!p)return '';
  var hasDiscount=p.discountedFee&&p.tuitionFee&&p.discountedFee<p.tuitionFee;
  var effFee=p.discountedFee||p.tuitionFee;
  var pct=hasDiscount?Math.round(((p.tuitionFee-p.discountedFee)/p.tuitionFee)*100):0;
  var loc=[p.universityCity,p.universityCountry].filter(Boolean).map(esc).join(', ');
  var logoInner=p.universityLogoUrl?'<img src="'+esc(p.universityLogoUrl)+'" alt="" onerror="this.style.display=\\'none\\';this.nextElementSibling&&(this.nextElementSibling.style.display=\\'block\\')">'+'<span style="display:none">'+ICON_GRAD+'</span>':ICON_GRAD;

  var h='<div class="ew-detail-head">';
  h+='<div class="ew-detail-logo">'+logoInner+'</div>';
  h+='<div style="min-width:0;flex:1"><div class="ew-detail-title">'+esc(p.name)+'</div><div class="ew-detail-uni">'+esc(p.universityName||'')+'</div></div>';
  h+='</div>';

  if(loc)h+='<div class="ew-detail-loc">'+ICON_MAPPIN+'<span>'+loc+'</span></div>';

  if(effFee||p.scholarship){
    h+='<div class="ew-detail-feebox">';
    if(effFee){
      h+='<div class="ew-detail-feeline"><span class="big">'+esc(fmtFee(effFee,p.currency))+'</span>';
      if(hasDiscount)h+='<span class="orig">'+esc(fmtFee(p.tuitionFee,p.currency))+'</span><span class="pct">-'+pct+'%</span>';
      h+='</div>';
    }
    if(p.scholarship&&p.scholarship>0){
      h+='<div class="ew-detail-schol">'+ICON_AWARD+'<span>Scholarship: '+esc(fmtFee(p.scholarship,p.currency))+'</span></div>';
    }
    h+='</div>';
  }

  var rows=[];
  if(p.degree)rows.push({i:ICON_GRAD,c:'#3b82f6',l:'Degree',v:p.degree});
  if(p.field)rows.push({i:ICON_AWARD,c:'#8b5cf6',l:'Field',v:p.field});
  if(p.language)rows.push({i:ICON_LANG,c:'#3b82f6',l:'Language',v:p.language});
  if(p.duration)rows.push({i:ICON_CLOCK,c:'#22c55e',l:'Duration',v:p.duration});
  if(p.intakes)rows.push({i:ICON_BOOK,c:'#f97316',l:'Intakes',v:p.intakes});
  if(p.feeType)rows.push({i:ICON_DOLLAR,c:'#10b981',l:'Fee Type',v:p.feeType});
  if(p.applicationFee)rows.push({i:ICON_DOLLAR,c:'#f59e0b',l:'Application Fee',v:fmtFee(p.applicationFee,p.currency)});
  if(p.depositFee)rows.push({i:ICON_DOLLAR,c:'#06b6d4',l:'Deposit Fee',v:fmtFee(p.depositFee,p.currency)});
  if(p.advancedFee)rows.push({i:ICON_DOLLAR,c:'#0ea5e9',l:'Advanced Fee',v:fmtFee(p.advancedFee,p.currency)});
  if(p.languageFee)rows.push({i:ICON_LANG,c:'#6366f1',l:'Language Fee',v:fmtFee(p.languageFee,p.currency)});

  if(rows.length){
    h+='<div class="ew-detail-grid">';
    rows.forEach(function(r){
      h+='<div class="ew-detail-row"><span style="color:'+r.c+'">'+r.i+'</span><div class="ew-detail-row-text"><div class="ew-detail-row-label">'+esc(r.l)+'</div><div class="ew-detail-row-value">'+esc(String(r.v))+'</div></div></div>';
    });
    h+='</div>';
  }

  if(p.requirements){
    h+='<div class="ew-detail-section"><div class="ew-detail-section-label">Requirements</div><div class="ew-detail-section-text">'+esc(p.requirements)+'</div></div>';
  }
  if(p.universityDescription){
    h+='<div class="ew-detail-section" style="border-top:1px solid #e2e8f0;padding-top:12px"><div class="ew-detail-section-label">About the University</div><div class="ew-detail-section-text">'+esc(p.universityDescription)+'</div></div>';
  }

  var hasRank=p.universityRanking||p.universityQsRanking||p.universityTimesRanking||p.universityShanghaiRanking||p.universityCwtsLeidenRanking;
  if(hasRank){
    h+='<div class="ew-detail-rankings">';
    if(p.universityRanking)h+='<span class="ew-detail-rank-pill">'+ICON_AWARD+'World #'+esc(String(p.universityRanking))+'</span>';
    if(p.universityQsRanking)h+='<span class="ew-detail-rank-pill">QS #'+esc(String(p.universityQsRanking))+'</span>';
    if(p.universityTimesRanking)h+='<span class="ew-detail-rank-pill">THE #'+esc(String(p.universityTimesRanking))+'</span>';
    if(p.universityShanghaiRanking)h+='<span class="ew-detail-rank-pill">ARWU #'+esc(String(p.universityShanghaiRanking))+'</span>';
    if(p.universityCwtsLeidenRanking)h+='<span class="ew-detail-rank-pill">Leiden #'+esc(String(p.universityCwtsLeidenRanking))+'</span>';
    h+='</div>';
  }

  if(p.universityWebsite){
    h+='<a class="ew-detail-link" href="'+esc(p.universityWebsite)+'" target="_blank" rel="noopener noreferrer">'+ICON_INFO+'Visit university website</a>';
  }

  h+='<div style="margin-top:18px;display:flex;gap:8px"><button type="button" class="ew-btn-back" id="ew-detail-close-btn">Close</button><button type="button" class="ew-btn" id="ew-detail-apply" data-apply="'+p.id+'">Apply Now</button></div>';

  return h;
}

var EW_TR_MAP={'ç':'C','Ç':'C','ğ':'G','Ğ':'G','ı':'I','İ':'I','ö':'O','Ö':'O','ş':'S','Ş':'S','ü':'U','Ü':'U','â':'A','Â':'A','î':'I','Î':'I','û':'U','Û':'U','ə':'E','Ə':'E','ø':'O','Ø':'O','ß':'SS','æ':'AE','Æ':'AE','œ':'OE','Œ':'OE','ð':'D','Ð':'D','þ':'TH','Þ':'TH','đ':'D','Đ':'D','ł':'L','Ł':'L'};
function ewToLatinUpper(v){var s=String(v==null?'':v).replace(/[çÇğĞıİöÖşŞüÜâÂîÎûÛəƏøØßæÆœŒðÐþÞđĐłŁ]/g,function(c){return EW_TR_MAP[c]||c;});if(typeof s.normalize==='function'){s=s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\u0020-\u007E]/g,'');}return s.toUpperCase();}
function ewHasNonLatin(v){var s=String(v==null?'':v);for(var ci=0;ci<s.length;ci++){var ch=s[ci];if(/\\p{L}/u.test(ch)&&!/\\p{Script=Latin}/u.test(ch))return true;}return false;}
function ewFirstNonLatinName(){var NLF=['firstName','lastName','motherName','fatherName','highSchool','address'];for(var i=0;i<NLF.length;i++){var val=savedFormData[NLF[i]];if(val&&ewHasNonLatin(val))return NLF[i];}return null;}
function wireNameAndPhoneNormalizers(scope){
  var root=scope||document;
  var NAMES=['firstName','lastName','motherName','fatherName','highSchool','address'];
  for(var i=0;i<NAMES.length;i++){
    var nodes=root.querySelectorAll?root.querySelectorAll('[name="'+NAMES[i]+'"]'):[];
    for(var j=0;j<nodes.length;j++){(function(el){
      if(el.__ewNameBound)return; el.__ewNameBound=true;
      if(el.value)el.value=ewToLatinUpper(el.value);
      el.addEventListener('input',function(){
        var pos=null; try{pos=el.selectionStart;}catch(e){}
        var v=el.value; var nv=ewToLatinUpper(v);
        if(v!==nv){el.value=nv; if(pos!=null){try{el.setSelectionRange(pos,pos);}catch(e){}}}
      });
    })(nodes[j]);}
  }
  var phones=root.querySelectorAll?root.querySelectorAll('input[name="phone"]'):[];
  for(var k=0;k<phones.length;k++){(function(el){
    if(el.__ewPhoneBound)return; el.__ewPhoneBound=true;
    el.setAttribute('inputmode','tel');
    el.setAttribute('pattern','[0-9]*');
    if(el.value)el.value=el.value.replace(/\\D/g,'');
    // beforeinput: yazılan/yapıştırılan metinden rakam dışı her şeyi at, yine de
    // izin verilen rakamları manuel yerleştir. silme/ok tuşları etkilenmez.
    el.addEventListener('beforeinput',function(e){
      var data=e.data; if(data==null)return;
      if(/[^\\d]/.test(data)){
        e.preventDefault();
        var cleaned=String(data).replace(/\\D/g,'');
        var start=el.selectionStart||0, end=el.selectionEnd||0;
        el.value=el.value.slice(0,start)+cleaned+el.value.slice(end);
        var np=start+cleaned.length;
        try{el.setSelectionRange(np,np);}catch(_){}
        el.__ewInputProcessing=true;
        try{el.dispatchEvent(new Event('input',{bubbles:true}));}catch(_){}
        el.__ewInputProcessing=false;
      }
    });
    el.addEventListener('paste',function(e){
      try{
        var cd=e.clipboardData||(window.clipboardData);
        if(!cd)return;
        var txt=cd.getData('text');
        if(txt==null)return;
        e.preventDefault();
        var cleaned=String(txt).replace(/\\D/g,'');
        var start=el.selectionStart||0, end=el.selectionEnd||0;
        el.value=el.value.slice(0,start)+cleaned+el.value.slice(end);
        var np=start+cleaned.length;
        try{el.setSelectionRange(np,np);}catch(_){}
      }catch(_){}
    });
    el.addEventListener('input',function(){
      if(el.__ewInputProcessing)return;
      var pos=null; try{pos=el.selectionStart;}catch(e){}
      var v=el.value; var nv=v.replace(/\\D/g,'');
      if(v!==nv){el.value=nv; var delta=v.length-nv.length; if(pos!=null){var np=Math.max(0,pos-delta);try{el.setSelectionRange(np,np);}catch(e){}}}
    });
    el.addEventListener('blur',function(){
      var v=el.value; var nv=v.replace(/\\D/g,'');
      if(v!==nv)el.value=nv;
    });
  })(phones[k]);}
}
function bindModalEvents(modal,overlay){
  wireNameAndPhoneNormalizers(modal);
  var closeBtn=$('#ew-modal-close',modal);
  if(closeBtn)closeBtn.addEventListener('click',function(){closeModal();});
  var cancelBtn=$('#ew-cancel',modal);
  if(cancelBtn)cancelBtn.addEventListener('click',function(){closeModal();});
  var form=$('#ew-form',modal);
  if(form)form.addEventListener('submit',handleFormSubmit);
  $$('[data-doc-input]',modal).forEach(function(input){
    input.addEventListener('change',function(e){
      var key=input.getAttribute('data-doc-input');
      handleDocumentFiles(key,e.target.files);
      input.value='';
    });
  });
  $$('[data-doc-camera]',modal).forEach(function(input){
    input.addEventListener('change',function(e){
      var key=input.getAttribute('data-doc-camera');
      var file=e.target.files[0];
      if(!file)return;
      handleDocumentFiles(key,[file]);
      input.value='';
    });
  });
  $$('[data-doc-scan]',modal).forEach(function(btn){
    btn.addEventListener('click',function(e){
      e.preventDefault();e.stopPropagation();
      handleScanForKey(btn.getAttribute('data-doc-scan'));
    });
  });
  var analyzeBtn=$('#ew-analyze-btn',modal);
  if(analyzeBtn)analyzeBtn.addEventListener('click',handleAnalyze);
  var skipBtn=$('#ew-skip-btn',modal);
  // Skip the AI extract and go straight to the review step.
  if(skipBtn)skipBtn.addEventListener('click',function(){
    if(!enforceDocGate())return;
    var payload=ewBuildDocumentPayload();
    formStep='analyzing';if(formOpen)showModal();else render(false);
    ewPersistLeadDocuments(payload).then(function(){
      formStep='review';if(formOpen)showModal();else render(false);
    }).catch(function(err){
      formStep='documents';if(formOpen)showModal();else render(false);
      alert(err.message||'Documents could not be saved. Please try again.');
    });
  });
  var backUploadBtn=$('#ew-back-upload',modal);
  // From review step → back to documents. Snapshot any review-form edits
  // first so they survive the round-trip.
  if(backUploadBtn)backUploadBtn.addEventListener('click',function(){snapshotForm(modal);formStep='documents';if(formOpen)showModal();else render(false)});
  var backPersonalBtn=$('#ew-back-personal',modal);
  // From documents step → back to personal info.
  if(backPersonalBtn)backPersonalBtn.addEventListener('click',function(){formStep='personal';if(formOpen)showModal();else render(false)});
  var nextPersonalBtn=$('#ew-next-personal',modal);
  if(nextPersonalBtn)nextPersonalBtn.addEventListener('click',function(){handleNextPersonal(modal);});
  wireCcDropdown(modal);
}

var savedFormData={};
// Lead id issued by POST /public/embed/<slug>/lead during Step 1. Sent
// back on the final /apply call so the server reuses (instead of
// duplicating) the existing "new" lead and can flip it to "converted".
var leadId=null;
var leadWasCreated=false;
// Opaque, signed token issued with the Step-1 lead capture. It allows the
// Documents step to persist draft files without exposing or trusting a numeric
// lead id, including when the backend deduplicates onto an existing lead.
var leadDocumentSessionToken=null;
// Fingerprint of each exact document already persisted for this session.
// Final submit calls the persistence helper defensively, but unchanged files
// must not cross the network a second time.
var persistedDocumentFingerprints={};
// Per-form identifier used by the public AI rate limiter. It prevents visitors
// behind the same school/office NAT from consuming one shared five-request
// bucket while remaining independent from any database identifier.
var applicationSessionId=(window.crypto&&window.crypto.randomUUID)?window.crypto.randomUUID():('app-'+Date.now()+'-'+Math.random().toString(36).slice(2));
var leadCreating=false;
// True while handleNextPersonal is executing to prevent concurrent/double-click
// invocations from firing multiple lead creates or racing showModal calls.
var handleNextPersonalInFlight=false;
// True when the early basics-only lead fired without a phone number; the
// next fully-valid Continue re-fires once so the deduped row gains the phone.
var leadPhonePending=false;
// Optional override for where handleAnalyze() should land after the AI
// extract finishes. Set inside .then() (e.g. expired-passport branch)
// before returning so the trailing .finally() honors the chosen step
// instead of unconditionally jumping to 'review'.
var analyzeNextStep=null;

// Helper: snapshot any currently rendered form fields into savedFormData
// so back-navigation does not lose user edits. Called before transitions
// triggered by buttons that live alongside an editable form.
// Wire up custom country-code dropdowns (.ew-cc) inside the given scope.
// Click trigger to toggle list, click item to select, click outside to close.
// Updates hidden input + trigger inner so FormData/snapshotForm reads the value.
// Keyboard: ArrowUp/Down to move highlight, Enter/Space to select, Escape to close.
// Uses a single delegated document listener (window.__ewCcInit guard) to avoid
// listener accumulation across re-renders.
function wireCcDropdown(scope){
  var root=scope||document;
  // One-time global outside-click closer — works across all current/future ew-cc.
  if(!window.__ewCcInit){
    window.__ewCcInit=true;
    document.addEventListener('click',function(e){
      var opened=document.querySelectorAll('.ew-cc-list.open');
      var changed=false;
      for(var k=0;k<opened.length;k++){
        var cc=opened[k].closest?opened[k].closest('.ew-cc'):opened[k].parentNode;
        if(cc&&!cc.contains(e.target)){
          opened[k].classList.remove('open');
          opened[k].classList.remove('ew-cc-list-up');
          opened[k].style.top='';opened[k].style.bottom='';
          var t=cc.querySelector('.ew-cc-trigger');
          if(t)t.setAttribute('aria-expanded','false');
          changed=true;
        }
      }
      // Outside-click closed at least one dropdown — let the iframe shrink
      // back. The instance close() handler isn't reachable here (private
      // closure per ew-cc), so we replicate the resizeParent trigger.
      if(changed&&typeof resizeParent==='function')resizeParent();
    });
  }
  var ccs=root.querySelectorAll?root.querySelectorAll('.ew-cc'):[];
  for(var i=0;i<ccs.length;i++){(function(cc){
    if(cc.__ewWired)return; cc.__ewWired=true;
    var trig=cc.querySelector('.ew-cc-trigger');
    var list=cc.querySelector('.ew-cc-list');
    var hidden=cc.querySelector('input[type="hidden"]');
    var search=cc.querySelector('.ew-cc-search');
    var empty=cc.querySelector('.ew-cc-empty');
    if(!trig||!list||!hidden)return;
    function items(){return list.querySelectorAll('.ew-cc-item');}
    function visibleItems(){return list.querySelectorAll('.ew-cc-item:not(.ew-cc-hidden)');}
    function applyFilter(){
      if(!search)return;
      var q=(search.value||'').toLowerCase().trim();
      var its=items(); var shown=0;
      for(var k=0;k<its.length;k++){
        var nm=its[k].getAttribute('data-name')||'';
        var cd=(its[k].getAttribute('data-cc')||'').toLowerCase();
        var iso=(its[k].getAttribute('data-iso')||'').toLowerCase();
        var match=!q||nm.indexOf(q)>=0||cd.indexOf(q)>=0||iso.indexOf(q)>=0;
        its[k].classList.toggle('ew-cc-hidden',!match);
        if(match)shown++;
      }
      if(empty)empty.classList.toggle('ew-cc-empty-show',shown===0);
    }
    function close(){
      list.classList.remove('open');list.classList.remove('ew-cc-list-up');
      list.style.top='';list.style.bottom='';
      trig.setAttribute('aria-expanded','false');
      if(search){search.value='';applyFilter();}
      // Let the iframe shrink back to its idle height once the dropdown
      // is gone — its open state was contributing to the reported height.
      if(typeof resizeParent==='function')resizeParent();
    }
    function open(){
      var others=document.querySelectorAll('.ew-cc-list.open');
      for(var k=0;k<others.length;k++)if(others[k]!==list)others[k].classList.remove('open');
      list.classList.add('open');trig.setAttribute('aria-expanded','true');
      // Decide whether to drop down or up. The widget lives in a cross-
      // origin iframe, so the only viewport we control is the iframe
      // itself. If opening downward would push past the iframe's bottom
      // and there's more room above, anchor the list to the trigger's
      // top edge instead. Otherwise grow the iframe (resizeParent below)
      // so the full list is reachable without an inner scrollbar.
      list.classList.remove('ew-cc-list-up');
      list.style.top='';list.style.bottom='';
      try{
        var trRect=trig.getBoundingClientRect();
        var listH=Math.min(260, list.scrollHeight||260);
        var spaceBelow=(window.innerHeight||document.documentElement.clientHeight)-trRect.bottom;
        var spaceAbove=trRect.top;
        if(spaceBelow<listH+8 && spaceAbove>spaceBelow){
          list.classList.add('ew-cc-list-up');
        }
      }catch(_){}
      // Ensure the iframe is tall enough to show the full dropdown without
      // clipping at its boundary (cross-origin iframes can't escape).
      if(typeof resizeParent==='function')resizeParent();
      if(search){
        try{search.focus({preventScroll:false});}catch(_){try{search.focus();}catch(__){}}
      } else {
        var act=list.querySelector('.ew-cc-item.active')||items()[0];
        if(act){act.focus({preventScroll:false});if(act.scrollIntoView)act.scrollIntoView({block:'nearest'});}
      }
    }
    function commit(item){
      if(!item)return;
      var code=item.getAttribute('data-cc');
      var iso=item.getAttribute('data-iso');
      if(!code||!iso)return;
      hidden.value=code;
      var lc=iso.toLowerCase();
      trig.innerHTML='<img src="https://flagcdn.com/24x18/'+lc+'.png" srcset="https://flagcdn.com/48x36/'+lc+'.png 2x" alt=""><span class="ew-cc-code">'+code+'</span><span class="ew-cc-caret">\\u25BC</span>';
      var its=items();
      for(var k=0;k<its.length;k++){its[k].classList.remove('active');its[k].setAttribute('aria-selected','false');}
      item.classList.add('active');item.setAttribute('aria-selected','true');
      savedFormData.countryCode=code;
      close();trig.focus();
    }
    trig.addEventListener('click',function(e){
      e.preventDefault();e.stopPropagation();
      if(list.classList.contains('open'))close();else open();
    });
    trig.addEventListener('keydown',function(e){
      if(e.key==='ArrowDown'||e.key==='ArrowUp'||e.key==='Enter'||e.key===' '){
        e.preventDefault();open();
      }
    });
    list.addEventListener('click',function(e){
      var item=e.target.closest?e.target.closest('.ew-cc-item'):null;
      commit(item);
    });
    if(search){
      search.addEventListener('click',function(e){e.stopPropagation();});
      search.addEventListener('input',function(){applyFilter();});
      search.addEventListener('keydown',function(e){
        if(e.key==='ArrowDown'){
          e.preventDefault();
          var v=visibleItems(); if(v.length){v[0].focus();v[0].scrollIntoView({block:'nearest'});}
        } else if(e.key==='Enter'){
          e.preventDefault();
          var v2=visibleItems(); if(v2.length)commit(v2[0]);
        } else if(e.key==='Escape'){
          e.preventDefault();close();trig.focus();
        }
      });
    }
    list.addEventListener('keydown',function(e){
      var its=visibleItems();if(!its.length)return;
      var cur=document.activeElement&&document.activeElement.classList&&document.activeElement.classList.contains('ew-cc-item')?document.activeElement:null;
      var idx=-1;for(var k=0;k<its.length;k++)if(its[k]===cur){idx=k;break;}
      if(e.key==='ArrowDown'){e.preventDefault();var n=its[Math.min(its.length-1,idx+1)]||its[0];n.focus();n.scrollIntoView({block:'nearest'});}
      else if(e.key==='ArrowUp'){e.preventDefault();var p=its[Math.max(0,idx-1)]||its[0];p.focus();p.scrollIntoView({block:'nearest'});}
      else if(e.key==='Home'){e.preventDefault();its[0].focus();its[0].scrollIntoView({block:'nearest'});}
      else if(e.key==='End'){e.preventDefault();its[its.length-1].focus();its[its.length-1].scrollIntoView({block:'nearest'});}
      else if(e.key==='Enter'||e.key===' '){e.preventDefault();commit(cur||its[0]);}
      else if(e.key==='Escape'){e.preventDefault();close();trig.focus();}
    });
  })(ccs[i]);}
}

function sanitizeSavedFormData(){
  // Belt-and-suspenders: telefonu her zaman digits-only, name benzerlerini TR→Latin UPPER yap.
  if(savedFormData.phone){savedFormData.phone=String(savedFormData.phone).replace(/\\D/g,'');}
  var NLF=['firstName','lastName','motherName','fatherName','highSchool','address'];
  for(var ni=0;ni<NLF.length;ni++){
    var key=NLF[ni];
    if(savedFormData[key]){savedFormData[key]=ewToLatinUpper(savedFormData[key]);}
  }
}
function snapshotForm(scope){
  var ids=['ew-personal-form','ew-form'];
  for(var i=0;i<ids.length;i++){
    var f=scope?$('#'+ids[i],scope):$('#'+ids[i]);
    if(f){new FormData(f).forEach(function(v,k){savedFormData[k]=v});}
  }
  sanitizeSavedFormData();
}

// Build the Step-1 early-lead payload from savedFormData plus page URL and
// UTM attribution. Shared by the full-form path and the basics-only
// best-effort path below.
function ewBuildLeadPayload(){
  var p={
    firstName:savedFormData.firstName,
    lastName:savedFormData.lastName,
    email:savedFormData.email,
    phone:savedFormData.phone||null,
    countryCode:savedFormData.countryCode||null,
    programName:formProgram?formProgram.name:null,
    universityName:formProgram?formProgram.universityName:null
  };
  // The trusted host page provides its real URL and campaign parameters via
  // postMessage. Cross-origin iframe rules prevent direct parent.location reads.
  if(sourceContext){
    p.sourcePageUrl=sourceContext.sourcePageUrl;
    ['utmSource','utmMedium','utmCampaign','utmTerm','utmContent'].forEach(function(k){if(sourceContext[k])p[k]=sourceContext[k]});
  }else{
    p.sourcePageUrl=window.location.href;
  }
  if(analyticsContext){
    p.gaClientId=analyticsContext.clientId;
    if(analyticsContext.sessionId)p.gaSessionId=analyticsContext.sessionId;
    p.gaCapturedAt=analyticsContext.capturedAt;
  }
  return p;
}
function ewNotifyLeadSubmitted(){
  try{
    window.parent.postMessage({type:'edcons-lead-submitted',slug:SLUG,leadId:leadId,created:leadWasCreated},parentOrigin||'*');
  }catch(e){}
}
// Fire-and-forget early lead capture. Never blocks or navigates; the
// backend dedups by email+source, so re-fires refresh the same row.
function ewFireEarlyLead(){
  leadCreating=true;
  fetch(addToken(API+'/lead'),{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify(ewBuildLeadPayload())
  }).then(function(r){
    return r.json();
  }).then(function(d){
    leadCreating=false;
    if(d&&d.leadId)leadId=d.leadId;
    if(d&&typeof d.created==='boolean')leadWasCreated=d.created;
    if(d&&d.documentSessionToken)leadDocumentSessionToken=d.documentSessionToken;
  }).catch(function(){leadCreating=false});
}
// Capture the personal-info form values into savedFormData and advance to
// the documents step. Validates the small set of required basics. Used by
// the "Continue" button on step 1 in both the modal and the inline view.
function handleNextPersonal(scope){
  // Idempotency guard: a double-click or rapid re-entry must not fire
  // multiple lead-create fetches or race showModal/render calls.
  if(handleNextPersonalInFlight)return;
  handleNextPersonalInFlight=true;
  var form=scope?$('#ew-personal-form',scope):$('#ew-personal-form');
  if(form){
    new FormData(form).forEach(function(v,k){savedFormData[k]=v});
  }
  sanitizeSavedFormData();
  if(!savedFormData.firstName||!savedFormData.lastName||!savedFormData.email||!savedFormData.phone||!savedFormData.countryCode){
    // Best-effort early lead: name+email basics are enough for the CRM
    // row, so capture the lead even though the missing phone/country
    // code still blocks navigation to the next step. Skipped for
    // lead_form widgets — there the Step-1 form IS the whole submission
    // and marking leadId now would drop the phone entirely.
    if(MODE!=='lead_form'&&savedFormData.firstName&&savedFormData.lastName&&savedFormData.email&&!ewFirstNonLatinName()&&!leadId&&!leadCreating){
      leadPhonePending=true;
      ewFireEarlyLead();
    }
    handleNextPersonalInFlight=false;
    alert(MODE==='lead_form'?LC.requiredAlert:'Please fill in all required fields, including the phone country code.');
    return;
  }
  if(ewFirstNonLatinName()){
    handleNextPersonalInFlight=false;
    alert(MODE==='lead_form'?LC.latinNameAlert:'Names must use Latin letters only. Please remove non-Latin characters (e.g. Arabic, Cyrillic).');
    return;
  }
  // If a lead was already issued during this session (user clicked Next,
  // came back, edited, clicked Next again) skip the create call and just
  // advance — the final /apply will update that same row.
  if(leadId||leadDocumentSessionToken||leadCreating){
    // If the early basics-only capture ran without a phone, re-fire once
    // now that the phone is filled — the backend dedups by email+source
    // and refreshes the same row, so this adds the phone, not a new lead.
    if(leadPhonePending&&!leadCreating&&savedFormData.phone&&savedFormData.countryCode){
      leadPhonePending=false;
      ewFireEarlyLead();
    }
    if(MODE==='lead_form'){
      formSubmitted=true;formLoading=false;
      if(formOpen)showModal();else render(false);
      ewNotifyLeadSubmitted();
    } else {
      formStep='documents';
      if(formOpen)showModal();else render(false);
    }
    handleNextPersonalInFlight=false;
    return;
  }
  leadCreating=true;
  if(MODE==='lead_form'){formLoading=true;if(formOpen)showModal();else render(false);}
  leadPhonePending=false;
  fetch(addToken(API+'/lead'),{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify(ewBuildLeadPayload())
  }).then(function(r){
    return r.json().then(function(d){return {ok:r.ok,data:d}});
  }).then(function(res){
    leadCreating=false;
    handleNextPersonalInFlight=false;
    if(res.ok&&res.data&&res.data.leadId)leadId=res.data.leadId;
    if(res.ok&&res.data&&typeof res.data.created==='boolean')leadWasCreated=res.data.created;
    if(res.ok&&res.data&&res.data.documentSessionToken)leadDocumentSessionToken=res.data.documentSessionToken;
    if(MODE==='lead_form'){
      // Lead-form widgets only collect contact info — show success now.
      if(!res.ok){
        formLoading=false;
        alert(MODE==='lead_form'?LC.submissionFailed:'Submission failed. Please try again.');
        if(formOpen)showModal();else render(false);
        return;
      }
      formSubmitted=true;formLoading=false;
      if(formOpen)showModal();else render(false);
      ewNotifyLeadSubmitted();
      return;
    }
    // Always advance — failing to create the lead should not block the
    // user from completing the form. The final /apply will create it.
    formStep='documents';
    if(formOpen)showModal();else render(false);
  }).catch(function(){
    leadCreating=false;
    handleNextPersonalInFlight=false;
    if(MODE==='lead_form'){
      formLoading=false;
      alert(MODE==='lead_form'?LC.submissionFailed:'Submission failed. Please try again.');
      if(formOpen)showModal();else render(false);
      return;
    }
    formStep='documents';
    if(formOpen)showModal();else render(false);
  });
}

function ewBuildDocumentPayload(){
  return Object.keys(uploadedDocs).map(function(k){
    var d=uploadedDocs[k];
    return {type:d.isImage?'image':'pdf',data:d.base64,mediaType:d.mediaType,label:d.label,sizeBytes:d.sizeBytes};
  });
}
function ewDocumentFingerprint(docPayload){
  return (docPayload||[]).map(function(d){
    var data=String(d.data||'');
    return [d.label||'',d.mediaType||'',d.sizeBytes||data.length,data.length,data.slice(0,32),data.slice(-32)].join('|');
  }).join('||');
}
function ewPersistLeadDocuments(docPayload){
  if(!leadDocumentSessionToken||!docPayload||docPayload.length===0)return Promise.resolve();
  var pending=docPayload.map(function(doc){
    return {doc:doc,fingerprint:ewDocumentFingerprint([doc])};
  }).filter(function(item){
    return !item.fingerprint||persistedDocumentFingerprints[item.doc.label]!==item.fingerprint;
  });
  // Upload one validated document at a time. A four-file application no
  // longer depends on one fragile 20–27 MB base64 request, and each upsert is
  // safe to retry once after a transient network/5xx failure.
  return pending.reduce(function(chain,item){
    return chain.then(function(){
      function sendOne(attempt){
        return fetch(addToken(API+'/lead-documents'),{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({documentSessionToken:leadDocumentSessionToken,documents:[item.doc]})
        }).then(function(r){
          if(r.ok){
            persistedDocumentFingerprints[item.doc.label]=item.fingerprint;
            return r.json();
          }
          if(attempt===0&&r.status>=500){
            return new Promise(function(resolve){setTimeout(resolve,500)}).then(function(){return sendOne(1)});
          }
          return r.json().catch(function(){return {}}).then(function(d){
            var err=new Error(d.error||'Documents could not be saved');
            err.isDocumentSaveError=true;
            throw err;
          });
        }).catch(function(err){
          if(attempt===0&&!err.isDocumentSaveError){
            return new Promise(function(resolve){setTimeout(resolve,500)}).then(function(){return sendOne(1)});
          }
          err.isDocumentSaveError=true;
          throw err;
        });
      }
      return sendOne(0);
    });
  },Promise.resolve());
}
function handleAnalyze(){
  if(!enforceDocGate())return;
  var docPayload=ewBuildDocumentPayload();
  if(docPayload.length===0){formStep='review';if(formOpen)showModal();else render(false);return;}
  var analyzeController=typeof AbortController!=='undefined'?new AbortController():null;
  var analyzeTimer=analyzeController?setTimeout(function(){analyzeController.abort();},60000):null;
  formStep='analyzing';
  if(formOpen)showModal();else render(false);
  var apiBase=API.replace('/public/embed/'+SLUG,'');
  ewPersistLeadDocuments(docPayload).then(function(){
    return fetch(apiBase+'/public/ai/extract-document',{
      method:'POST',
      headers:{'Content-Type':'application/json','X-Application-Session':leadDocumentSessionToken||applicationSessionId},
      body:JSON.stringify({documents:docPayload,scope:'embed',widgetSlug:SLUG}),
      signal:analyzeController?analyzeController.signal:undefined
    });
  }).then(function(r){
    if(r.ok)return r.json();
    throw new Error('AI analysis failed');
  }).then(function(data){
    aiResult=data.extracted||null;
    if(aiResult){
      if(aiResult.passportExpired===true){
        alert('Warning: This passport has expired ('+aiResult.passportExpiry+'). Expired passports cannot be used for applications. Please upload a valid passport.');
        aiResult=null;
        // Send the user back to the documents step to re-upload. Mark the
        // transition so the .finally() below does not override us with
        // 'review'.
        analyzeNextStep='documents';
        return;
      }
      extractedFields={};
      var mapping={firstName:'firstName',lastName:'lastName',email:'email',phone:'phone',nationality:'nationality',dateOfBirth:'dateOfBirth',gender:'gender',motherName:'motherName',fatherName:'fatherName',passportNumber:'passportNumber',passportIssueDate:'passportIssueDate',passportExpiry:'passportExpiry',address:'address',highSchool:'highSchool',graduationYear:'graduationYear',gpa:'gpa',languageScore:'languageScore'};
      var mKeys=Object.keys(mapping);
      for(var i=0;i<mKeys.length;i++){
        var ek=mKeys[i];
        var fk=mapping[ek];
        var val=aiResult[ek];
        if(val&&val!=='null'&&val!=='N/A'&&val!==''){
          var sval=String(val);
          // Normalize gender variants (Female/F/M/MALE -> female|male) so the
          // <select name="gender"> in the review step actually shows the
          // option as selected. Anything else is dropped to avoid a stale,
          // non-matching value lurking in savedFormData.
          if(fk==='gender'){
            var gl=sval.trim().toLowerCase();
            if(gl==='f'||gl==='female')sval='female';
            else if(gl==='m'||gl==='male')sval='male';
            else continue;
          }
          // Clean punctuation from name-like text fields. Some passport/ID
          // OCR results come back as "AHMET, " or "Ali." — strip surrounding
          // whitespace, leading/trailing punctuation, and collapse internal
          // commas/periods that aren't meaningful for proper names.
          var nameLike={firstName:1,lastName:1,motherName:1,fatherName:1,highSchool:1};
          if(nameLike[fk]){
            sval=sval.replace(/^[\\s.,;:!?"'\\u2013\\u2014\\-]+|[\\s.,;:!?"'\\u2013\\u2014\\-]+$/g,'');
            sval=sval.replace(/[.,;:!?]+/g,' ').replace(/\\s{2,}/g,' ').trim();
          }
          if(!sval)continue;
          savedFormData[fk]=sval;
          extractedFields[fk]=true;
        }
      }
    }
  }).catch(function(err){
    aiResult=null;
    if(err&&err.isDocumentSaveError){
      analyzeNextStep='documents';
      alert(err.message||'Documents could not be saved. Please try again.');
    }
  }).finally(function(){
    if(analyzeTimer)clearTimeout(analyzeTimer);
    formStep=analyzeNextStep||'review';
    analyzeNextStep=null;
    if(formOpen)showModal();else render(false);
  });
}

function handleFormSubmit(e){
  e.preventDefault();
  var form=e.target;
  new FormData(form).forEach(function(v,k){savedFormData[k]=v});
  if(!savedFormData.firstName||!savedFormData.lastName||!savedFormData.email){
    alert(MODE==='lead_form'?LC.requiredAlert:'Please fill in all required fields.');
    return;
  }
  if(savedFormData.phone&&!savedFormData.countryCode){
    alert(MODE==='lead_form'?LC.countryCodeAlert:'Please select the phone country code.');
    return;
  }
  if(!enforceDocGate())return;
  if(formLoading)return;
  phoneError=false;
  formLoading=true;
  if(formOpen)showModal();else render(false);
  var data=Object.assign({},savedFormData);
  if(formProgram){
    data.programId=formProgram.id;
    data.programName=formProgram.name;
    data.universityName=formProgram.universityName;
  }
  try{data.sourcePageUrl=window.parent.location.href}catch(ex){data.sourcePageUrl=window.location.href}
  var utmMap={utm_source:'utmSource',utm_medium:'utmMedium',utm_campaign:'utmCampaign',utm_term:'utmTerm',utm_content:'utmContent'};
  try{
    var search=window.location.search;
    try{search=window.parent.location.search}catch(ex){}
    var params=new URLSearchParams(search);
    Object.keys(utmMap).forEach(function(k){var v=params.get(k);if(v)data[utmMap[k]]=v});
  }catch(ex){}
  var docPayload=ewBuildDocumentPayload();
  if(aiResult)data.aiExtractedData=aiResult;
  if(leadId)data.leadId=leadId;
  // Documents were already validated and persisted at the document step. On
  // final submit send only the signed session + a tiny label manifest. This
  // avoids retransmitting up to ~27 MB of base64 through the partner iframe.
  ewPersistLeadDocuments(docPayload).then(function(){
    if(leadDocumentSessionToken){
      data.documentSessionToken=leadDocumentSessionToken;
      data.documentLabels=docPayload.map(function(d){return d.label});
    }else if(docPayload.length>0){
      // Legacy/local fallback when the signing secret is unavailable.
      data.documents=docPayload;
    }
    return fetch(addToken(API+'/apply'),{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(data)
    });
  }).then(function(r){
    formLoading=false;
    if(!r.ok)return r.json().then(function(d){
      // Invalid phone (422 phone.invalid): bounce back to the personal step
      // and show an inline error next to the phone field instead of an alert.
      if(r.status===422&&d&&d.code==='phone.invalid'){
        phoneError=true;
        formStep='personal';
        if(formOpen)showModal();else render(false);
        return;
      }
      // Server rejected because mandatory documents are missing (defense in
      // depth behind the client gate). Bounce the user back to the Documents
      // step so they can upload what's missing instead of being stuck.
      if(d&&d.missingDocuments&&d.missingDocuments.length)formStep='documents';
      throw new Error(d.error||'Submission failed')
    });
    formSubmitted=true;
    if(formOpen)showModal();
    else render(false);
  }).catch(function(err){
    formLoading=false;
    if(formOpen)showModal();else render(false);
    var message=err&&err.message;
    if(!message||/failed to fetch|networkerror|load failed/i.test(message)){
      message=MODE==='lead_form'?LC.genericFailed:'The connection was interrupted while submitting. Please check your internet connection and press Submit again.';
    }
    alert(message);
  });
}

function bindEvents(){
  var searchInput=$('#ew-search');
  if(searchInput){
    searchInput.addEventListener('input',function(e){
      clearTimeout(searchDebounce);
      searchDebounce=setTimeout(function(){
        userFilters.search=e.target.value;currentPage=1;loadPrograms();
      },400);
    });
  }
  ['country','universityType','universityId','level','language','field'].forEach(function(f){
    var sel=$('#ew-f-'+f);
    if(sel)sel.addEventListener('change',function(e){
      userFilters[f]=e.target.value;currentPage=1;loadPrograms();
    });
  });
  $$('[data-apply]').forEach(function(btn){
    btn.addEventListener('click',function(){
      var pid=parseInt(btn.getAttribute('data-apply'));
      formProgram=programs.find(function(p){return p.id===pid})||null;
      applicationSessionId=(window.crypto&&window.crypto.randomUUID)?window.crypto.randomUUID():('app-'+Date.now()+'-'+Math.random().toString(36).slice(2));
      formOpen=true;formSubmitted=false;formStep='personal';phoneError=false;uploadedDocs={};persistedDocumentFingerprints={};aiResult=null;extractedFields={};savedFormData={};leadId=null;leadDocumentSessionToken=null;leadCreating=false;handleNextPersonalInFlight=false;
      loadProgramDocs(pid,function(){if(formOpen)showModal();else render(false);});
      showModal();
    });
  });
  $$('[data-info]').forEach(function(btn){
    btn.addEventListener('click',function(){
      var pid=parseInt(btn.getAttribute('data-info'));
      detailProgram=programs.find(function(p){return p.id===pid})||null;
      if(detailProgram){detailOpen=true;showDetailModal();}
    });
  });
  $$('[data-page]').forEach(function(btn){
    btn.addEventListener('click',function(){
      var p=parseInt(btn.getAttribute('data-page'));
      if(p>=1&&p<=meta.totalPages){currentPage=p;loadPrograms();}
    });
  });
  var inlineForm=$('#ew-form');
  if(inlineForm&&!formOpen)inlineForm.addEventListener('submit',handleFormSubmit);
  var inlineAnalyzeBtn=$('#ew-analyze-btn');
  if(inlineAnalyzeBtn&&!formOpen)inlineAnalyzeBtn.addEventListener('click',handleAnalyze);
  var inlineSkipBtn=$('#ew-skip-btn');
  if(inlineSkipBtn&&!formOpen)inlineSkipBtn.addEventListener('click',function(){
    if(!enforceDocGate())return;
    var payload=ewBuildDocumentPayload();
    formStep='analyzing';render(false);
    ewPersistLeadDocuments(payload).then(function(){formStep='review';render(false);}).catch(function(err){
      formStep='documents';render(false);alert(err.message||'Documents could not be saved. Please try again.');
    });
  });
  var inlineBackUploadBtn=$('#ew-back-upload');
  if(inlineBackUploadBtn&&!formOpen)inlineBackUploadBtn.addEventListener('click',function(){snapshotForm(null);formStep='documents';render(false)});
  var inlineBackPersonalBtn=$('#ew-back-personal');
  if(inlineBackPersonalBtn&&!formOpen)inlineBackPersonalBtn.addEventListener('click',function(){formStep='personal';render(false)});
  var inlineNextPersonalBtn=$('#ew-next-personal');
  if(inlineNextPersonalBtn&&!formOpen)inlineNextPersonalBtn.addEventListener('click',function(){handleNextPersonal(null);});
  if(!formOpen)wireCcDropdown(null);
  if(!formOpen)wireNameAndPhoneNormalizers(null);
  $$('[data-doc-input]').forEach(function(input){
    if(formOpen)return;
    input.addEventListener('change',function(e){
      var key=input.getAttribute('data-doc-input');
      handleDocumentFiles(key,e.target.files);
      input.value='';
    });
  });
  $$('[data-doc-camera]').forEach(function(input){
    if(formOpen)return;
    input.addEventListener('change',function(e){
      var key=input.getAttribute('data-doc-camera');
      var file=e.target.files[0];
      if(!file)return;
      handleDocumentFiles(key,[file]);
      input.value='';
    });
  });
  $$('[data-doc-scan]').forEach(function(btn){
    if(formOpen)return;
    btn.addEventListener('click',function(e){
      e.preventDefault();e.stopPropagation();
      handleScanForKey(btn.getAttribute('data-doc-scan'));
    });
  });
}

function esc(s){if(s===undefined||s===null)return '';var d=document.createElement('div');d.textContent=String(s);return d.innerHTML}
function safeAccept(s){var v=String(s||'').trim();return /^(\\.[a-z0-9]{1,8})(,\\.[a-z0-9]{1,8})*$/i.test(v)?v:'.pdf,.jpg,.jpeg,.png';}

function resizeParent(){
  try{
    var root=document.querySelector('.ew-root');
    // Use the larger of root.scrollHeight (full content) and document
    // scrollHeight so internal overflow containers don't truncate the
    // reported height and force an inner scrollbar on the host page.
    var rootH=root?Math.max(root.scrollHeight,root.offsetHeight):0;
    var docH=Math.max(document.body.scrollHeight,document.documentElement.scrollHeight);
    var h=Math.max(rootH,docH);
    // Absolutely-positioned overlays (the apply modal and any open country
    // code dropdown) do not contribute to scrollHeight, so query their
    // bounding rects explicitly and grow the iframe just enough to contain
    // them. This both prevents the modal/dropdown from being clipped at
    // the iframe boundary AND lets the iframe shrink back to the launcher
    // card height once they close.
    var extras=document.querySelectorAll('.ew-modal, .ew-cc-list.open');
    for(var i=0;i<extras.length;i++){
      var r=extras[i].getBoundingClientRect();
      var bottom=r.bottom+(window.pageYOffset||document.documentElement.scrollTop||0);
      if(bottom>h)h=bottom;
    }
    h=Math.ceil(h)+16;
    window.parent.postMessage({type:'edcons-resize',slug:SLUG,height:h},'*');
  }catch(e){}
}

var ro=typeof ResizeObserver!=='undefined'?new ResizeObserver(resizeParent):null;
if(ro){
  var rootEl=document.querySelector('.ew-root');
  // Observe BOTH the widget root AND document.body. The modal overlay and
  // any open country code dropdown are appended to document.body (or
  // float above .ew-root via position:absolute), so root-only observation
  // misses size changes from those overlays.
  if(rootEl)ro.observe(rootEl);
  ro.observe(document.body);
}

window.addEventListener('message',function(e){
  var d=e.data;
  if(e.source!==window.parent||!d||d.slug!==SLUG)return;
  if(parentOrigin&&e.origin!==parentOrigin)return;
  if(d.type==='edcons-viewport'){
    parentViewport={
      parentScrollY:d.parentScrollY||0,
      parentViewportHeight:d.parentViewportHeight||0,
      iframeTop:d.iframeTop||0,
      iframeHeight:d.iframeHeight||0
    };
    if(modalElements)repositionModal();
  }else if(d.type==='edcons-analytics-context'){
    var cid=String(d.clientId||'').trim();
    var sid=String(d.sessionId||'').trim();
    var captured=String(d.capturedAt||'').trim();
    if(/^[A-Za-z0-9._-]{1,128}$/.test(cid)){
      analyticsContext={clientId:cid,capturedAt:captured||new Date().toISOString()};
      if(/^\\d{1,32}$/.test(sid))analyticsContext.sessionId=sid;
    }
  }else if(d.type==='edcons-source-context'){
    var page=String(d.sourcePageUrl||'').trim();
    try{
      var parsed=new URL(page);
      if(parsed.origin===parentOrigin){
        sourceContext={sourcePageUrl:page.slice(0,500)};
        ['utmSource','utmMedium','utmCampaign','utmTerm','utmContent'].forEach(function(k){
          var value=String(d[k]||'').trim();
          if(value)sourceContext[k]=value.slice(0,100);
        });
      }
    }catch(ex){}
  }
});

try{window.parent.postMessage({type:'edcons-analytics-request',slug:SLUG},parentOrigin||'*');}catch(e){}
init();
})();
</script>
</body>
</html>`;
}

export default router;
