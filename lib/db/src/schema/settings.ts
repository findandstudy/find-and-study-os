import { pgTable, text, serial, timestamp, integer, boolean, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const settingsTable = pgTable("settings", {
  id: serial("id").primaryKey(),
  companyName: text("company_name"),
  companyEmail: text("company_email"),
  companyPhone: text("company_phone"),
  companyAddress: text("company_address"),
  companyWebsite: text("company_website"),
  defaultLanguage: text("default_language").notNull().default("en"),
  supportedLanguages: text("supported_languages").notNull().default("en,tr,ar,fr,ru,fa,zh,hi,es,id,ur,tk,ky,kk,uz,tg,bn,pt,ne,vi,ko,uk,it"),
  smtpHost: text("smtp_host"),
  smtpPort: integer("smtp_port"),
  smtpUser: text("smtp_user"),
  smtpPassword: text("smtp_password"),
  smtpFromEmail: text("smtp_from_email"),
  whatsappEnabled: boolean("whatsapp_enabled").notNull().default(false),
  whatsappToken: text("whatsapp_token"),
  n8nWebhookUrl: text("n8n_webhook_url"),
  googleSheetsId: text("google_sheets_id"),
  metaLeadEnabled: boolean("meta_lead_enabled").notNull().default(false),
  logoUrl: text("logo_url"),
  logoDarkUrl: text("logo_dark_url"),
  faviconUrl: text("favicon_url"),
  themePrimary: text("theme_primary"),
  themeButton: text("theme_button"),
  themeHover: text("theme_hover"),
  seoDefaultTitle: text("seo_default_title"),
  seoDefaultDescription: text("seo_default_description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),

  // Branding extended
  logoSquareUrl: text("logo_square_url"),
  appleTouchIconUrl: text("apple_touch_icon_url"),
  pwaIconUrl: text("pwa_icon_url"),
  emailLogoUrl: text("email_logo_url"),
  pdfLogoUrl: text("pdf_logo_url"),
  themeSecondary: text("theme_secondary"),
  themeAccent: text("theme_accent"),
  themeLinkColor: text("theme_link_color"),
  themeSuccess: text("theme_success"),
  themeWarning: text("theme_warning"),
  themeDanger: text("theme_danger"),

  // Company / Contact
  legalCompanyName: text("legal_company_name"),
  publicBrandName: text("public_brand_name"),
  supportEmail: text("support_email"),
  salesEmail: text("sales_email"),
  whatsappNumber: text("whatsapp_number"),
  companyCity: text("company_city"),
  companyCountry: text("company_country"),
  workingHours: text("working_hours"),
  footerDescription: text("footer_description"),
  footerCopyright: text("footer_copyright"),
  contactCtaText: text("contact_cta_text"),
  socialInstagram: text("social_instagram"),
  socialFacebook: text("social_facebook"),
  socialLinkedin: text("social_linkedin"),
  socialTwitter: text("social_twitter"),
  socialYoutube: text("social_youtube"),
  socialTiktok: text("social_tiktok"),

  // SEO
  siteName: text("site_name"),
  siteTitleTemplate: text("site_title_template"),
  seoMetaTitle: text("seo_meta_title"),
  seoMetaDescription: text("seo_meta_description"),
  canonicalBaseUrl: text("canonical_base_url"),
  robotsIndex: boolean("robots_index").notNull().default(true),
  robotsFollow: boolean("robots_follow").notNull().default(true),
  stagingNoindex: boolean("staging_noindex").notNull().default(false),
  ogTitle: text("og_title"),
  ogDescription: text("og_description"),
  ogImageUrl: text("og_image_url"),
  twitterTitle: text("twitter_title"),
  twitterDescription: text("twitter_description"),
  twitterImageUrl: text("twitter_image_url"),
  shareImageUrl: text("share_image_url"),
  seoKeywords: text("seo_keywords"),
  googleSearchConsoleCode: text("google_search_console_code"),
  googleAnalyticsId: text("google_analytics_id"),
  metaPixelId: text("meta_pixel_id"),
  tiktokPixelId: text("tiktok_pixel_id"),
  orgSchemaName: text("org_schema_name"),
  orgSchemaUrl: text("org_schema_url"),
  orgSchemaLogoUrl: text("org_schema_logo_url"),
  orgSchemaSocials: text("org_schema_socials"),

  // Email Branding
  emailSenderName: text("email_sender_name"),
  emailSenderEmail: text("email_sender_email"),
  emailReplyTo: text("email_reply_to"),
  emailFooterText: text("email_footer_text"),
  emailSignatureBlock: text("email_signature_block"),
  emailButtonColor: text("email_button_color"),
  emailDisclaimerText: text("email_disclaimer_text"),

  // PDF / Document Branding
  pdfHeaderText: text("pdf_header_text"),
  pdfFooterText: text("pdf_footer_text"),
  pdfWatermarkText: text("pdf_watermark_text"),
  pdfSignatureLabel: text("pdf_signature_label"),
  pdfSealImageUrl: text("pdf_seal_image_url"),
  pdfPrimaryColor: text("pdf_primary_color"),
  pdfAccentColor: text("pdf_accent_color"),

  // Season Years — supports legacy `number[]` and new detailed `{ year, startDate, endDate }[]`
  availableYears: jsonb("available_years").$type<Array<number | { year: number; startDate: string; endDate: string }>>(),

  // Advanced
  sitemapUrl: text("sitemap_url"),
  robotsTxtContent: text("robots_txt_content"),
  customHeadScript: text("custom_head_script"),
  customBodyEndScript: text("custom_body_end_script"),
  linkedinInsightTag: text("linkedin_insight_tag"),
  clarityId: text("clarity_id"),
  recaptchaSiteKey: text("recaptcha_site_key"),
  whatsappWidgetNumber: text("whatsapp_widget_number"),
  liveChatScript: text("live_chat_script"),
  featureFlags: jsonb("feature_flags").default({}),

  // Offer letter expiry notification thresholds (CSV days, e.g. "30,14,7,1")
  offerExpiryWarningDays: text("offer_expiry_warning_days").default("30,14,7,1"),

  // Agent contract expiry notification thresholds (CSV days, e.g. "30,14,7,1")
  contractExpiryReminderDays: text("contract_expiry_reminder_days").default("30,14,7,1"),

  // Default deadline (in days) for newly-issued agent onboarding signing sessions.
  // Configurable 1-365. After this deadline, the session is "expired" and the
  // agent is locked out until an admin resends the link.
  defaultSigningDeadlineDays: integer("default_signing_deadline_days").notNull().default(14),

  // Auto-convert lead → student on /public/apply + /public/embed full submit
  autoConvertLeadEnabled: boolean("auto_convert_lead_enabled").notNull().default(true),
  autoConvertStudentStageKey: text("auto_convert_student_stage_key").notNull().default("active"),

  // Agent stage-change permissions (system-wide toggles)
  agentCanChangeLeadStage: boolean("agent_can_change_lead_stage").notNull().default(true),
  agentCanChangeStudentAppStage: boolean("agent_can_change_student_app_stage").notNull().default(false),

  // Flat bonus amount per direct enrolled student assigned to staff member
  directStudentEnrollmentBonusRate: text("direct_student_enrollment_bonus_rate").notNull().default("0"),

  // Suppress in-app + email notifications for automation-created applications (created_source='automation').
  // Default true = otomasyon başvuruları bildirim göndermez (mail seli önlenir).
  suppressAutomationAppNotifications: boolean("suppress_automation_app_notifications").notNull().default(true),

  // Date display format — org-wide setting for how dates are shown everywhere.
  // Allowed values: "DD.MM.YYYY" | "DD/MM/YYYY" | "MM/DD/YYYY" | "YYYY-MM-DD"
  dateFormat: text("date_format").notNull().default("DD.MM.YYYY"),

  // Public website catalogue visibility. An empty country list means all
  // countries; university types are the default for countries without an
  // explicit rule. A country-rule value of [] hides that country completely.
  publicCatalogAllowedCountries: jsonb("public_catalog_allowed_countries").notNull().default([]).$type<string[]>(),
  publicCatalogAllowedUniversityTypes: jsonb("public_catalog_allowed_university_types").notNull().default(["Private"]).$type<string[]>(),
  publicCatalogCountryRules: jsonb("public_catalog_country_rules").notNull().default({}).$type<Record<string, string[]>>(),

  // Auto-assign stuck (needsHuman=true, unassigned, open) inbox conversations to eligible staff via
  // the periodic assignStuckConversation sweep. Default false = feature is opt-in.
  autoAssignStuckConversationsEnabled: boolean("auto_assign_stuck_conversations_enabled").notNull().default(false),

  // Sub-toggles for the stuck-conversation auto-assign engine (only relevant when the
  // master toggle above is enabled). Priority order (working hours -> country -> balanced
  // round-robin) is fixed; these only turn individual criteria on/off.
  stuckAssignConsiderWorkingHours: boolean("stuck_assign_consider_working_hours").notNull().default(true),
  stuckAssignConsiderCountryMatch: boolean("stuck_assign_consider_country_match").notNull().default(true),
  // 'assign_anyway' = fall back to the full active pool when nobody is in working hours;
  // 'leave_unassigned' = skip assignment and leave the conversation queued until someone is.
  stuckAssignOffHoursBehavior: text("stuck_assign_off_hours_behavior").notNull().default("assign_anyway"),
});

export const insertSettingsSchema = createInsertSchema(settingsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertSettings = z.infer<typeof insertSettingsSchema>;
export type Settings = typeof settingsTable.$inferSelect;
