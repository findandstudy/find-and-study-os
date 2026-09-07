import { Router, type IRouter } from "express";
import { db, settingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth, requireRole, logAudit } from "../lib/auth";
import { MANAGER_ROLES } from "../lib/roles";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { normalizeYears, invalidateSeasonCache } from "../lib/season";
import { invalidateSuppressAutomationCache } from "../lib/notificationDispatcher";

const router: IRouter = Router();

const SETTINGS_PATCH_FIELDS = [
  "defaultLanguage", "supportedLanguages", "companyName", "companyEmail",
  "companyPhone", "companyAddress", "companyWebsite", "smtpHost", "smtpPort", "smtpUser",
  "smtpPassword", "whatsappEnabled", "whatsappToken",
  "metaLeadEnabled", "n8nWebhookUrl", "googleSheetsId",
  "logoUrl", "logoDarkUrl", "faviconUrl", "themePrimary", "themeButton", "themeHover",
  "seoDefaultTitle", "seoDefaultDescription",
  "logoSquareUrl", "appleTouchIconUrl", "pwaIconUrl", "emailLogoUrl", "pdfLogoUrl",
  "themeSecondary", "themeAccent", "themeLinkColor", "themeSuccess", "themeWarning", "themeDanger",
  "legalCompanyName", "publicBrandName", "supportEmail", "salesEmail",
  "whatsappNumber", "companyCity", "companyCountry", "workingHours",
  "footerDescription", "footerCopyright", "contactCtaText",
  "socialInstagram", "socialFacebook", "socialLinkedin", "socialTwitter", "socialYoutube", "socialTiktok",
  "siteName", "siteTitleTemplate", "seoMetaTitle", "seoMetaDescription",
  "canonicalBaseUrl", "robotsIndex", "robotsFollow", "stagingNoindex",
  "ogTitle", "ogDescription", "ogImageUrl",
  "twitterTitle", "twitterDescription", "twitterImageUrl", "shareImageUrl",
  "seoKeywords", "googleSearchConsoleCode", "googleAnalyticsId", "metaPixelId", "tiktokPixelId",
  "orgSchemaName", "orgSchemaUrl", "orgSchemaLogoUrl", "orgSchemaSocials",
  "emailSenderName", "emailSenderEmail", "emailReplyTo",
  "emailFooterText", "emailSignatureBlock", "emailButtonColor", "emailDisclaimerText",
  "pdfHeaderText", "pdfFooterText", "pdfWatermarkText", "pdfSignatureLabel",
  "pdfSealImageUrl", "pdfPrimaryColor", "pdfAccentColor",
  "sitemapUrl", "robotsTxtContent", "customHeadScript", "customBodyEndScript",
  "linkedinInsightTag", "clarityId", "recaptchaSiteKey",
  "whatsappWidgetNumber", "liveChatScript", "featureFlags",
  "availableYears",
  "offerExpiryWarningDays",
  "contractExpiryReminderDays",
  "defaultSigningDeadlineDays",
  "autoConvertLeadEnabled",
  "autoConvertStudentStageKey",
  "directStudentEnrollmentBonusRate",
  "suppressAutomationAppNotifications",
  "autoAssignStuckConversationsEnabled",
  "stuckAssignConsiderWorkingHours",
  "stuckAssignConsiderCountryMatch",
  "stuckAssignOffHoursBehavior",
  "dateFormat",
];

const CREDENTIAL_FIELDS = ["smtpPassword", "whatsappToken", "n8nWebhookUrl"];
const SYSTEM_LANGUAGE_CODES = [
  "en", "tr", "ar", "fr", "ru", "fa", "zh", "hi", "es", "id",
  "ur", "tk", "ky", "kk", "uz", "tg",
] as const;
const SYSTEM_LANGUAGE_SET = new Set<string>(SYSTEM_LANGUAGE_CODES);

function normalizeSupportedLanguages(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const languages = Array.from(new Set(
    value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean),
  ));
  if (languages.length === 0 || languages.some((item) => !SYSTEM_LANGUAGE_SET.has(item))) return null;
  return languages.join(",");
}

router.get("/settings/branding", async (req, res): Promise<void> => {
  const [settings] = await db.select({
    logoUrl: settingsTable.logoUrl,
    logoDarkUrl: settingsTable.logoDarkUrl,
    logoSquareUrl: settingsTable.logoSquareUrl,
    faviconUrl: settingsTable.faviconUrl,
    appleTouchIconUrl: settingsTable.appleTouchIconUrl,
    themePrimary: settingsTable.themePrimary,
    themeSecondary: settingsTable.themeSecondary,
    themeAccent: settingsTable.themeAccent,
    themeButton: settingsTable.themeButton,
    themeHover: settingsTable.themeHover,
    companyName: settingsTable.companyName,
    publicBrandName: settingsTable.publicBrandName,
    companyEmail: settingsTable.companyEmail,
    companyPhone: settingsTable.companyPhone,
    companyAddress: settingsTable.companyAddress,
    companyCity: settingsTable.companyCity,
    companyCountry: settingsTable.companyCountry,
    companyWebsite: settingsTable.companyWebsite,
    whatsappNumber: settingsTable.whatsappNumber,
    workingHours: settingsTable.workingHours,
    supportEmail: settingsTable.supportEmail,
    salesEmail: settingsTable.salesEmail,
    footerDescription: settingsTable.footerDescription,
    footerCopyright: settingsTable.footerCopyright,
    contactCtaText: settingsTable.contactCtaText,
    socialInstagram: settingsTable.socialInstagram,
    socialFacebook: settingsTable.socialFacebook,
    socialLinkedin: settingsTable.socialLinkedin,
    socialTwitter: settingsTable.socialTwitter,
    socialYoutube: settingsTable.socialYoutube,
    socialTiktok: settingsTable.socialTiktok,
    dateFormat: settingsTable.dateFormat,
  }).from(settingsTable);
  res.json(settings || {});
});

/**
 * Non-sensitive settings needed by authenticated application surfaces. Keep
 * this projection deliberately small: the full settings row contains internal
 * integration endpoints and identifiers that ordinary staff/agents must not
 * be able to enumerate.
 */
router.get("/settings/client", requireAuth, async (_req, res): Promise<void> => {
  const [settings] = await db.select({
    dateFormat: settingsTable.dateFormat,
    companyName: settingsTable.companyName,
    publicBrandName: settingsTable.publicBrandName,
    companyEmail: settingsTable.companyEmail,
    supportEmail: settingsTable.supportEmail,
    salesEmail: settingsTable.salesEmail,
    companyPhone: settingsTable.companyPhone,
    whatsappNumber: settingsTable.whatsappNumber,
    companyWebsite: settingsTable.companyWebsite,
    canonicalBaseUrl: settingsTable.canonicalBaseUrl,
    logoUrl: settingsTable.logoUrl,
    logoSquareUrl: settingsTable.logoSquareUrl,
    pdfLogoUrl: settingsTable.pdfLogoUrl,
    pdfPrimaryColor: settingsTable.pdfPrimaryColor,
    pdfAccentColor: settingsTable.pdfAccentColor,
    themePrimary: settingsTable.themePrimary,
    themeSecondary: settingsTable.themeSecondary,
    themeAccent: settingsTable.themeAccent,
    themeSuccess: settingsTable.themeSuccess,
  }).from(settingsTable);
  res.json(settings || {});
});

router.get("/settings", requireAuth, requireRole(...MANAGER_ROLES), async (_req, res): Promise<void> => {
  const [settings] = await db.select().from(settingsTable);
  if (!settings) {
    // Read paths must never bootstrap mutable platform configuration. The
    // first explicit Super Admin PATCH owns creation and its audit receipt.
    res.json({
      defaultLanguage: "en",
      supportedLanguages: "en,tr,ar,fr,ru,fa,zh,hi,es,id,ur,tk,ky,kk,uz,tg",
      whatsappEnabled: false,
      metaLeadEnabled: false,
      dateFormat: "DD.MM.YYYY",
    });
    return;
  }
  const safe: Record<string, any> = { ...settings };
  for (const f of CREDENTIAL_FIELDS) {
    delete safe[f];
  }
  res.json(safe);
});

router.patch("/settings", requireAuth, requireRole("super_admin"), async (req, res): Promise<void> => {
  const updates: Record<string, unknown> = {};
  for (const key of SETTINGS_PATCH_FIELDS) {
    if (req.body[key] !== undefined) {
      updates[key] = req.body[key];
    }
  }
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No valid fields to update" });
    return;
  }

  if (updates.availableYears !== undefined) {
    updates.availableYears = normalizeYears(updates.availableYears);
    invalidateSeasonCache();
  }
  if (updates.supportedLanguages !== undefined) {
    const normalized = normalizeSupportedLanguages(updates.supportedLanguages);
    if (!normalized) {
      res.status(400).json({ error: "supportedLanguages contains an unsupported language" });
      return;
    }
    updates.supportedLanguages = normalized;
  }
  if (updates.defaultLanguage !== undefined) {
    const normalizedDefault = String(updates.defaultLanguage).trim().toLowerCase();
    if (!SYSTEM_LANGUAGE_SET.has(normalizedDefault)) {
      res.status(400).json({ error: "defaultLanguage is unsupported" });
      return;
    }
    updates.defaultLanguage = normalizedDefault;
  }
  if (updates.defaultSigningDeadlineDays !== undefined) {
    const n = parseInt(String(updates.defaultSigningDeadlineDays), 10);
    if (!Number.isInteger(n) || n < 1 || n > 365) {
      res.status(400).json({ error: "defaultSigningDeadlineDays must be an integer between 1 and 365" });
      return;
    }
    updates.defaultSigningDeadlineDays = n;
  }
  if (updates.suppressAutomationAppNotifications !== undefined) {
    invalidateSuppressAutomationCache();
  }

  const [existing] = await db.select().from(settingsTable);
  const effectiveLanguages = String(
    updates.supportedLanguages ?? existing?.supportedLanguages ?? SYSTEM_LANGUAGE_CODES.join(","),
  ).split(",");
  const effectiveDefault = String(updates.defaultLanguage ?? existing?.defaultLanguage ?? "en");
  if (!effectiveLanguages.includes(effectiveDefault)) {
    res.status(400).json({ error: "defaultLanguage must be included in supportedLanguages" });
    return;
  }
  let updated;
  if (!existing) {
    const [created] = await db.insert(settingsTable).values({
      defaultLanguage: "en",
      supportedLanguages: "en,tr,ar,fr,ru,fa,zh,hi,es,id,ur,tk,ky,kk,uz,tg",
      whatsappEnabled: false,
      metaLeadEnabled: false,
      ...updates,
    }).returning();
    updated = created;
  } else {
    const [u] = await db.update(settingsTable).set(updates).where(eq(settingsTable.id, existing.id)).returning();
    updated = u;
  }
  await logAudit(req.user!.id, "platform_config.settings.update", "settings", updated.id, {
    changedFields: Object.keys(updates),
  }, req.ip);
  const safe: Record<string, any> = { ...updated };
  for (const f of CREDENTIAL_FIELDS) {
    delete safe[f];
  }
  res.json(safe);
});

router.get("/settings/available-years", requireAuth, async (req, res): Promise<void> => {
  const [settings] = await db.select({ availableYears: settingsTable.availableYears }).from(settingsTable);
  let details = normalizeYears(settings?.availableYears ?? null);
  if (details.length === 0) {
    const currentYear = new Date().getFullYear();
    details = Array.from({ length: 6 }, (_, i) => {
      const y = currentYear - 2 + i;
      return { year: y, startDate: `${y}-01-01`, endDate: `${y}-12-31` };
    });
  }
  res.json({
    years: details.map(d => d.year),
    details,
  });
});

const objectStorageService = new ObjectStorageService();

router.get("/settings/branding/logo", async (req, res): Promise<void> => {
  try {
    const variantKey = req.query.variant === "dark"
      ? "logoDarkUrl"
      : req.query.variant === "square"
        ? "logoSquareUrl"
        : req.query.variant === "email"
          ? "emailLogoUrl"
          : req.query.variant === "pdf"
            ? "pdfLogoUrl"
          : "logoUrl";
    const [settings] = await db.select({
      logoUrl: settingsTable.logoUrl,
      logoDarkUrl: settingsTable.logoDarkUrl,
      logoSquareUrl: settingsTable.logoSquareUrl,
      emailLogoUrl: settingsTable.emailLogoUrl,
      pdfLogoUrl: settingsTable.pdfLogoUrl,
    }).from(settingsTable);
    // email variant falls back through logoSquareUrl → logoUrl so emails always
    // show *something* even when no dedicated email logo has been uploaded yet.
    const url = variantKey === "emailLogoUrl"
      ? (settings?.emailLogoUrl || settings?.logoSquareUrl || settings?.logoUrl)
      : variantKey === "pdfLogoUrl"
        ? (settings?.pdfLogoUrl || settings?.logoSquareUrl || settings?.logoUrl)
      : (settings?.[variantKey as keyof typeof settings] || settings?.logoUrl);
    if (!url) { res.status(404).json({ error: "No logo configured" }); return; }

    const match = url.match(/\/api\/storage\/objects\/(.+)$/);
    if (!match) { res.status(404).json({ error: "Invalid logo path" }); return; }

    const objectPath = `/objects/${match[1]}`;
    const objectFile = await objectStorageService.getObjectEntityFile(objectPath);
    await objectStorageService.streamObjectToResponse(req, res, objectFile, {
      cacheControl: "public, max-age=3600",
    });
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "Logo not found" });
      return;
    }
    console.error("Error serving branding logo:", error);
    res.status(500).json({ error: "Failed to serve logo" });
  }
});

router.post("/settings/admin/wipe-crm", requireAuth, requireRole("super_admin"), async (req, res): Promise<void> => {
  const { confirm } = req.body || {};
  if (confirm !== "WIPE-CRM-DATA") {
    res.status(400).json({ error: "Missing confirmation. Send body: { \"confirm\": \"WIPE-CRM-DATA\" }" });
    return;
  }
  try {
    const result = await db.transaction(async (tx) => {
      const counts: Record<string, number> = {};
      const exec = async (label: string, sql: string) => {
        const r = await tx.execute(sql as any);
        counts[label] = (r as any).rowCount ?? 0;
      };
      await exec("application_stage_documents", `DELETE FROM application_stage_documents`);
      await exec("invoices", `DELETE FROM invoices`);
      await exec("notes_resource", `DELETE FROM notes WHERE resource_type IN ('student','application','lead')`);
      await exec("follow_ups", `DELETE FROM follow_ups WHERE student_id IS NOT NULL OR lead_id IS NOT NULL`);
      await exec("documents", `DELETE FROM documents WHERE student_id IS NOT NULL OR application_id IS NOT NULL OR lead_id IS NOT NULL`);
      await exec("commissions", `DELETE FROM commissions`);
      await exec("service_fees", `DELETE FROM service_fees`);
      await exec("financial_transactions", `DELETE FROM financial_transactions`);
      await exec("embed_submissions", `DELETE FROM embed_submissions`);
      await exec("applications", `DELETE FROM applications`);
      await exec("students", `DELETE FROM students`);
      await exec("leads", `DELETE FROM leads`);
      await exec("notes_authored", `DELETE FROM notes WHERE author_id IN (SELECT id FROM users WHERE role='student')`);
      await exec("messages_student", `DELETE FROM messages WHERE sender_id IN (SELECT id FROM users WHERE role='student')`);
      await exec("conversation_participants_student", `DELETE FROM conversation_participants WHERE user_id IN (SELECT id FROM users WHERE role='student')`);
      await exec("conversations_student", `DELETE FROM conversations WHERE created_by_id IN (SELECT id FROM users WHERE role='student') OR assigned_to_id IN (SELECT id FROM users WHERE role='student')`);
      await exec("broadcasts_student", `DELETE FROM broadcasts WHERE sent_by_id IN (SELECT id FROM users WHERE role='student')`);
      await exec("message_templates_student", `DELETE FROM message_templates WHERE created_by_id IN (SELECT id FROM users WHERE role='student')`);
      await exec("users_student", `DELETE FROM users WHERE role='student'`);
      return counts;
    });
    console.log("[ADMIN-WIPE] CRM data wiped by user", req.user!.id, result);
    res.json({ success: true, deleted: result });
  } catch (err: any) {
    console.error("[ADMIN-WIPE] Failed:", err);
    res.status(500).json({ error: "Wipe failed" });
  }
});

router.post("/settings/admin/backfill-assignments", requireAuth, requireRole("super_admin"), async (req, res): Promise<void> => {
  try {
    const { backfillNullAssignments } = await import("../lib/leadAssignment");
    const result = await backfillNullAssignments(req.user!.id, req.ip);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    console.error("[ADMIN-BACKFILL-ASSIGNMENTS] Failed:", err);
    res.status(500).json({ error: "Backfill failed" });
  }
});

export default router;
