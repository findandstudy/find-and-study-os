// DB-managed configuration for the inbox AI intake agent (FAZ 1).
//
// The config lives in the `integrations` table under key `ai_agent`, stored
// and read through the same encryptConfig/decryptConfig pipeline as the other
// integration configs (whatsapp, claude). It holds the global on/off switch,
// the "default-on for new chats" flag, the model + sampling temperature, the
// runaway-reply handoff threshold + handoff message, the supported languages,
// the multilingual escalation keyword sets, and the editable knowledge base
// (markdown system prompt). The admin panel (FAZ 2) edits this record; the
// auto-reply engine and lead automation (FAZ 3) read it.
import { aiBotsTable, db, integrationsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { decryptConfig, encryptConfig } from "../encryption";
import {
  DEFAULT_KNOWLEDGE_BASE,
  DEFAULT_ESCALATION_KEYWORDS,
  type BotLanguage,
  type EscalationTopic,
} from "./botBrain";

export const AI_AGENT_INTEGRATION_KEY = "ai_agent";
export const AI_AGENT_INTEGRATION_NAME = "AI Intake Agent";
export const AI_AGENT_INTEGRATION_CATEGORY = "ai";
export const DEFAULT_BOT_MODEL = "claude-haiku-4-5-20251001";

export interface AiAgentConfig {
  /** Global master switch. When false, NO auto-replies are sent on any
   *  conversation regardless of the per-conversation toggle. */
  enabled: boolean;
  /** Explicit approval gate for customer-facing channels. Older stored
   * configs omit this field and therefore fail closed to false. */
  externalAutoReplyEnabled: boolean;
  /** When true, newly created conversations start with the bot enabled. */
  defaultOnForNew: boolean;
  /** Anthropic model used for the intake reply. */
  model: string;
  /** Sampling temperature (0–2). Default 1 == the engine's prior behavior. */
  temperature: number;
  /** Max consecutive bot replies before handing off to a human. 0 = no limit. */
  maxConsecutiveReplies: number;
  /** Message sent once when the handoff threshold is crossed. */
  handoffMessage: string;
  /** Language-specific handoff messages. The legacy single message remains a
   * fallback for older stored configs and API clients. */
  handoffMessages: Record<BotLanguage, string>;
  /** Supported intake languages (informational + future routing). */
  languages: BotLanguage[];
  /** Multilingual escalation keyword sets, per topic. */
  escalationKeywords: Record<EscalationTopic, string[]>;
  /** The editable markdown knowledge base / system-prompt body. */
  knowledgeBase: string;
  /**
   * Faz 1 — country / university-type scope for the live searchPrograms tool.
   * When enabled=false the tool is disabled entirely (bot falls back to the
   * static knowledgeBase, as if no live program data existed). "all" means no
   * restriction on that axis. Mirrored onto the knowledge_sources
   * type='program_scope' row so both surfaces stay in sync (see
   * knowledgeSources.ts / routes/inbox.ts knowledge-sources endpoints).
   */
  programScope: ProgramScope;
  /**
   * Sohbet kalite puanlama (Faz 1) settings. Read by the nightly quality
   * scoring batch worker and the /api/quality routes.
   */
  quality: QualityScoringConfig;
  /**
   * Working-hours schedule. When scheduleEnabled=false (the backward-
   * compatible default) the bot runs 24/7 exactly as before. When true, the
   * bot only auto-replies inside the per-weekday windows below, interpreted
   * in `timezone` (IANA, DST-aware). Outside the window the bot is FULLY
   * silent — no reply, no greeting; messages still land in the inbox.
   */
  scheduleEnabled: boolean;
  /** IANA timezone the schedule times are interpreted in. */
  timezone: string;
  /** Per-weekday working windows. Overnight windows (end < start) spill into
   *  the next day and belong to the day they START on (see botSchedule.ts). */
  schedule: WeeklySchedule;
}

export type WeekDayKey = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export interface ScheduleDayConfig {
  /** false = the bot never runs on windows starting this day. */
  enabled: boolean;
  /** "HH:mm" local time in `timezone`. */
  start: string;
  /** "HH:mm" local time; end < start means the window runs past midnight. */
  end: string;
}

export type WeeklySchedule = Record<WeekDayKey, ScheduleDayConfig>;

export interface QualityScoringConfig {
  /** Master switch for the nightly quality-scoring batch. */
  enabled: boolean;
  /** Anthropic model used for scoring (defaults to the intake bot model). */
  model: string;
  /** Minimum staff (human outbound) messages a conversation must have. */
  minStaffMessages: number;
  /** Conversation must be idle at least this many hours before scoring. */
  idleHours: number;
  /** Max conversations scored per batch run. */
  batchSize: number;
  /** UTC hour of day when the nightly batch fires. */
  runHourUtc: number;
  /** When true, staff can see their OWN quality scores. Default OFF —
   *  only admin/manager roles see quality data. */
  selfVisible: boolean;
}

export interface ProgramScope {
  enabled: boolean;
  countries: string[] | "all";
  universityTypes: string[] | "all";
}

const SUPPORTED_LANGUAGES: BotLanguage[] = [
  "tr",
  "en",
  "ar",
  "fa",
  "fr",
  "es",
  "ru",
  "zh",
  "hi",
  "id",
  "ur",
  "tk",
  "ky",
  "kk",
  "uz",
  "tg",
  "bn",
  "pt",
  "ne",
  "vi",
  "ko",
  "uk",
  "it",
];

export const DEFAULT_PROGRAM_SCOPE: ProgramScope = {
  enabled: true,
  countries: "all",
  universityTypes: "all",
};

export const DEFAULT_QUALITY_CONFIG: QualityScoringConfig = {
  enabled: true,
  model: DEFAULT_BOT_MODEL,
  minStaffMessages: 3,
  idleHours: 24,
  batchSize: 30,
  runHourUtc: 2,
  selfVisible: false,
};

export const DEFAULT_TIMEZONE = "Europe/Istanbul";

const WEEK_DAYS: WeekDayKey[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

function defaultWeeklySchedule(): WeeklySchedule {
  const day = (): ScheduleDayConfig => ({ enabled: true, start: "09:00", end: "18:00" });
  return { mon: day(), tue: day(), wed: day(), thu: day(), fri: day(), sat: day(), sun: day() };
}

export const DEFAULT_AI_AGENT_CONFIG: AiAgentConfig = {
  // enabled defaults TRUE so existing #530 behavior (per-conversation toggle
  // decides) is preserved; an admin can flip the master switch off to silence
  // the whole bot.
  enabled: true,
  // Customer-facing AI delivery requires a deliberate Super Admin opt-in.
  // Keeping this separate from `enabled` makes older stored configs fail safe.
  externalAutoReplyEnabled: false,
  // defaultOnForNew defaults FALSE so new conversations stay bot-off until
  // staff opt in — nothing auto-enables.
  defaultOnForNew: false,
  model: DEFAULT_BOT_MODEL,
  temperature: 1,
  maxConsecutiveReplies: 5,
  handoffMessage:
    "Thanks for your patience — a member of our team will continue helping you shortly.",
  handoffMessages: {
    tr: "Bu konuda rezervasyon ekibimiz size yardımcı olacak — kısa süre içinde dönüş yapacaklar.",
    en: "Our reservation team will take this from here and will get back to you shortly.",
    ar: "سيتولى فريق الحجز لدينا هذا الطلب وسيتواصل معك قريبًا.",
    fa: "تیم رزرو ما این درخواست را پیگیری می‌کند و به‌زودی با شما تماس می‌گیرد.",
    ru: "Наша команда по бронированию возьмёт это на себя и свяжется с вами в ближайшее время.",
    fr: "Notre équipe de réservation prend le relais et vous recontactera très prochainement.",
    es: "Nuestro equipo de reservas se encargará de esto y se pondrá en contacto contigo en breve.",
    zh: "我们的预订团队将接手此请求，并会尽快与您联系。",
    hi: "हमारी आरक्षण टीम अब इस अनुरोध को संभालेगी और शीघ्र आपसे संपर्क करेगी।",
    id: "Tim reservasi kami akan menangani permintaan ini dan segera menghubungi Anda.",
    ur: "ہماری ریزرویشن ٹیم اب یہ درخواست سنبھالے گی اور جلد آپ سے رابطہ کرے گی۔",
    tk: "Rezervasiýa toparymyz bu haýyşy öz üstüne alar we tiz wagtda siziň bilen habarlaşar.",
    ky: "Биздин брондоо тобу бул өтүнүчтү өзүнө алып, жакында сиз менен байланышат.",
    kk: "Біздің брондау тобымыз бұл өтінішті өзіне алып, жақын арада сізбен байланысады.",
    uz: "Bron qilish jamoamiz bu soʻrovni qabul qiladi va tez orada siz bilan bogʻlanadi.",
    tg: "Дастаи фармоиши мо ин дархостро баррасӣ карда, ба зудӣ бо шумо тамос мегирад.",
    bn: "আমাদের রিজার্ভেশন টিম এখন থেকে বিষয়টি দেখবে এবং শিগগিরই আপনার সঙ্গে যোগাযোগ করবে।",
    pt: "A nossa equipa de reservas tratará deste pedido e entrará em contacto consigo em breve.",
    ne: "हाम्रो आरक्षण टोलीले अब यो अनुरोध सम्हाल्नेछ र छिट्टै तपाईंलाई सम्पर्क गर्नेछ।",
    vi: "Đội ngũ tư vấn của chúng tôi sẽ tiếp nhận yêu cầu này và sớm liên hệ với bạn.",
    ko: "예약 담당 팀이 이 요청을 이어받아 곧 연락드리겠습니다.",
    uk: "Наша команда з бронювання опрацює цей запит і незабаром зв’яжеться з вами.",
    it: "Il nostro team prenotazioni prenderà in carico la richiesta e ti contatterà a breve.",
  },
  languages: [...SUPPORTED_LANGUAGES],
  escalationKeywords: DEFAULT_ESCALATION_KEYWORDS,
  knowledgeBase: DEFAULT_KNOWLEDGE_BASE,
  programScope: DEFAULT_PROGRAM_SCOPE,
  quality: DEFAULT_QUALITY_CONFIG,
  // scheduleEnabled defaults FALSE — existing installs keep 24/7 behavior
  // until an admin explicitly turns the schedule on.
  scheduleEnabled: false,
  timezone: DEFAULT_TIMEZONE,
  schedule: defaultWeeklySchedule(),
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const escalationKeywordsSchema = z.object({
  contract: z.array(z.string()),
  payment: z.array(z.string()),
  commission: z.array(z.string()),
  partner: z.array(z.string()),
  human_request: z.array(z.string()),
  visa_documents: z.array(z.string()),
  supplier: z.array(z.string()),
});

const handoffMessagesSchema = z.object({
  tr: z.string().max(2000),
  en: z.string().max(2000),
  ar: z.string().max(2000),
  fa: z.string().max(2000),
  fr: z.string().max(2000),
  es: z.string().max(2000),
  ru: z.string().max(2000),
  zh: z.string().max(2000),
  hi: z.string().max(2000),
  id: z.string().max(2000),
  ur: z.string().max(2000),
  tk: z.string().max(2000),
  ky: z.string().max(2000),
  kk: z.string().max(2000),
  uz: z.string().max(2000),
  tg: z.string().max(2000),
  bn: z.string().max(2000),
  pt: z.string().max(2000),
  ne: z.string().max(2000),
  vi: z.string().max(2000),
  ko: z.string().max(2000),
  uk: z.string().max(2000),
  it: z.string().max(2000),
});

const qualityConfigSchema = z.object({
  enabled: z.boolean(),
  model: z.string().min(1).max(200),
  minStaffMessages: z.number().int().min(1).max(100),
  idleHours: z.number().int().min(0).max(720),
  batchSize: z.number().int().min(1).max(500),
  runHourUtc: z.number().int().min(0).max(23),
  selfVisible: z.boolean(),
});

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function isValidTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const scheduleDaySchema = z
  .object({
    enabled: z.boolean(),
    start: z.string().regex(TIME_RE, "Invalid time (HH:mm)"),
    end: z.string().regex(TIME_RE, "Invalid time (HH:mm)"),
  })
  .refine((d) => !d.enabled || d.start !== d.end, {
    message: "start and end must differ",
  });

const weeklyScheduleSchema = z.object({
  mon: scheduleDaySchema,
  tue: scheduleDaySchema,
  wed: scheduleDaySchema,
  thu: scheduleDaySchema,
  fri: scheduleDaySchema,
  sat: scheduleDaySchema,
  sun: scheduleDaySchema,
});

const timezoneSchema = z
  .string()
  .min(1)
  .max(100)
  .refine(isValidTz, { message: "Invalid IANA timezone" });

const programScopeSchema = z.object({
  enabled: z.boolean(),
  countries: z.union([z.array(z.string()), z.literal("all")]),
  universityTypes: z.union([z.array(z.string()), z.literal("all")]),
});

export const aiAgentConfigSchema = z.object({
  enabled: z.boolean(),
  externalAutoReplyEnabled: z.boolean(),
  defaultOnForNew: z.boolean(),
  model: z.string().min(1).max(200),
  temperature: z.number().min(0).max(2),
  maxConsecutiveReplies: z.number().int().min(0).max(100),
  handoffMessage: z.string().max(2000),
  handoffMessages: handoffMessagesSchema,
  languages: z.array(z.enum([
    "tr", "en", "ar", "fa", "fr", "es", "ru", "zh", "hi", "id",
    "ur", "tk", "ky", "kk", "uz", "tg", "bn", "pt", "ne", "vi",
    "ko", "uk", "it",
  ])).min(1),
  escalationKeywords: escalationKeywordsSchema,
  knowledgeBase: z.string().min(1).max(200000),
  programScope: programScopeSchema,
  quality: qualityConfigSchema,
  scheduleEnabled: z.boolean(),
  timezone: timezoneSchema,
  schedule: weeklyScheduleSchema,
});

export const aiAgentConfigPatchSchema = aiAgentConfigSchema.partial();
export type AiAgentConfigPatch = z.infer<typeof aiAgentConfigPatchSchema>;

// ---------------------------------------------------------------------------
// Defaults merge — tolerant of partial / older-shape stored configs.
// ---------------------------------------------------------------------------

function cloneKeywords(kw: Record<EscalationTopic, string[]>): Record<EscalationTopic, string[]> {
  return {
    contract: [...kw.contract],
    payment: [...kw.payment],
    commission: [...kw.commission],
    partner: [...kw.partner],
    human_request: [...kw.human_request],
    visa_documents: [...kw.visa_documents],
    supplier: [...kw.supplier],
  };
}

function mergeKeywords(raw: unknown): Record<EscalationTopic, string[]> {
  const d = DEFAULT_AI_AGENT_CONFIG.escalationKeywords;
  if (!raw || typeof raw !== "object") return cloneKeywords(d);
  const r = raw as Partial<Record<EscalationTopic, unknown>>;
  const pick = (topic: EscalationTopic): string[] => {
    const v = r[topic];
    return Array.isArray(v) ? v.map((s) => String(s)) : [...d[topic]];
  };
  return {
    contract: pick("contract"),
    payment: pick("payment"),
    commission: pick("commission"),
    partner: pick("partner"),
    human_request: pick("human_request"),
    visa_documents: pick("visa_documents"),
    supplier: pick("supplier"),
  };
}

function cloneHandoffMessages(messages: Record<BotLanguage, string>): Record<BotLanguage, string> {
  return { ...messages };
}

function mergeHandoffMessages(raw: unknown, legacyFallback: string): Record<BotLanguage, string> {
  const defaults = DEFAULT_AI_AGENT_CONFIG.handoffMessages;
  const input = raw && typeof raw === "object" ? raw as Partial<Record<BotLanguage, unknown>> : {};
  return Object.fromEntries(SUPPORTED_LANGUAGES.map((language) => {
    const configured = input[language];
    const value = typeof configured === "string" && configured.trim()
      ? configured
      : language === "en" && legacyFallback.trim()
        ? legacyFallback
        : defaults[language];
    return [language, value];
  })) as Record<BotLanguage, string>;
}

function cloneProgramScope(scope: ProgramScope): ProgramScope {
  return {
    enabled: scope.enabled,
    countries: scope.countries === "all" ? "all" : [...scope.countries],
    universityTypes: scope.universityTypes === "all" ? "all" : [...scope.universityTypes],
  };
}

function mergeProgramScope(raw: unknown): ProgramScope {
  const d = DEFAULT_AI_AGENT_CONFIG.programScope;
  if (!raw || typeof raw !== "object") return cloneProgramScope(d);
  const r = raw as Partial<ProgramScope>;
  const pickListOrAll = (v: unknown, fallback: string[] | "all"): string[] | "all" => {
    if (v === "all") return "all";
    if (Array.isArray(v)) return v.map((s) => String(s));
    return fallback;
  };
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : d.enabled,
    countries: pickListOrAll(r.countries, d.countries),
    universityTypes: pickListOrAll(r.universityTypes, d.universityTypes),
  };
}

function mergeQuality(raw: unknown): QualityScoringConfig {
  const d = DEFAULT_QUALITY_CONFIG;
  if (!raw || typeof raw !== "object") return { ...d };
  const r = raw as Partial<QualityScoringConfig>;
  const num = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : d.enabled,
    model: typeof r.model === "string" && r.model.trim() ? r.model : d.model,
    minStaffMessages: num(r.minStaffMessages, d.minStaffMessages),
    idleHours: num(r.idleHours, d.idleHours),
    batchSize: num(r.batchSize, d.batchSize),
    runHourUtc: num(r.runHourUtc, d.runHourUtc),
    selfVisible: typeof r.selfVisible === "boolean" ? r.selfVisible : d.selfVisible,
  };
}

function cloneSchedule(s: WeeklySchedule): WeeklySchedule {
  const out = {} as WeeklySchedule;
  for (const k of WEEK_DAYS) out[k] = { ...s[k] };
  return out;
}

function mergeSchedule(raw: unknown): WeeklySchedule {
  const d = defaultWeeklySchedule();
  if (!raw || typeof raw !== "object") return d;
  const r = raw as Partial<Record<WeekDayKey, Partial<ScheduleDayConfig>>>;
  const out = {} as WeeklySchedule;
  for (const k of WEEK_DAYS) {
    const v = r[k];
    out[k] = {
      enabled: typeof v?.enabled === "boolean" ? v.enabled : d[k].enabled,
      start: typeof v?.start === "string" && TIME_RE.test(v.start) ? v.start : d[k].start,
      end: typeof v?.end === "string" && TIME_RE.test(v.end) ? v.end : d[k].end,
    };
  }
  return out;
}

function mergeWithDefaults(raw: Record<string, unknown> | null | undefined): AiAgentConfig {
  const d = DEFAULT_AI_AGENT_CONFIG;
  if (!raw || typeof raw !== "object") {
    return {
      ...d,
      languages: [...d.languages],
      escalationKeywords: cloneKeywords(d.escalationKeywords),
      handoffMessages: cloneHandoffMessages(d.handoffMessages),
      programScope: cloneProgramScope(d.programScope),
      quality: { ...d.quality },
      schedule: cloneSchedule(d.schedule),
    };
  }
  const r = raw as Partial<AiAgentConfig>;
  const languages =
    Array.isArray(r.languages) && r.languages.length
      ? r.languages.filter((l): l is BotLanguage => SUPPORTED_LANGUAGES.includes(l as BotLanguage))
      : [...d.languages];
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : d.enabled,
    externalAutoReplyEnabled:
      typeof r.externalAutoReplyEnabled === "boolean"
        ? r.externalAutoReplyEnabled
        : d.externalAutoReplyEnabled,
    defaultOnForNew: typeof r.defaultOnForNew === "boolean" ? r.defaultOnForNew : d.defaultOnForNew,
    model: typeof r.model === "string" && r.model.trim() ? r.model : d.model,
    temperature: typeof r.temperature === "number" && Number.isFinite(r.temperature) ? r.temperature : d.temperature,
    maxConsecutiveReplies:
      typeof r.maxConsecutiveReplies === "number" && Number.isFinite(r.maxConsecutiveReplies)
        ? r.maxConsecutiveReplies
        : d.maxConsecutiveReplies,
    handoffMessage: typeof r.handoffMessage === "string" ? r.handoffMessage : d.handoffMessage,
    handoffMessages: mergeHandoffMessages(r.handoffMessages, typeof r.handoffMessage === "string" ? r.handoffMessage : d.handoffMessage),
    languages: languages.length ? languages : [...d.languages],
    escalationKeywords: mergeKeywords(r.escalationKeywords),
    knowledgeBase: typeof r.knowledgeBase === "string" && r.knowledgeBase.trim() ? r.knowledgeBase : d.knowledgeBase,
    programScope: mergeProgramScope(r.programScope),
    quality: mergeQuality(r.quality),
    scheduleEnabled: typeof r.scheduleEnabled === "boolean" ? r.scheduleEnabled : d.scheduleEnabled,
    timezone: typeof r.timezone === "string" && isValidTz(r.timezone) ? r.timezone : d.timezone,
    schedule: mergeSchedule(r.schedule),
  };
}

/** Enabling customer-facing automation is a privileged change. Admins may
 * always turn these controls off; only Super Admin may turn them on. */
export function aiAgentPatchRequiresSuperAdmin(
  current: AiAgentConfig,
  patch: AiAgentConfigPatch,
): boolean {
  return (
    (patch.enabled === true && !current.enabled) ||
    (patch.externalAutoReplyEnabled === true && !current.externalAutoReplyEnabled) ||
    (patch.defaultOnForNew === true && !current.defaultOnForNew)
  );
}

/** Remove privileged true-valued no-ops before a non-Super Admin write. This
 * prevents a stale admin form from re-enabling a control that a Super Admin
 * disabled between the policy read and the eventual encrypted-config write. */
export function stripAlreadyEnabledAiAgentControls(
  current: AiAgentConfig,
  patch: AiAgentConfigPatch,
): AiAgentConfigPatch {
  const safePatch = { ...patch };
  if (safePatch.enabled === true && current.enabled) delete safePatch.enabled;
  if (safePatch.externalAutoReplyEnabled === true && current.externalAutoReplyEnabled) {
    delete safePatch.externalAutoReplyEnabled;
  }
  if (safePatch.defaultOnForNew === true && current.defaultOnForNew) {
    delete safePatch.defaultOnForNew;
  }
  return safePatch;
}

/** Infrastructure-level incident override. The database-backed Super Admin
 * gate remains the normal control; this environment flag can only stop sends. */
export function isExternalAutoReplyEmergencyStopped(): boolean {
  const value = (process.env.AI_EXTERNAL_AUTO_REPLY_KILL_SWITCH ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function getExternalAiDeliveryBlockReason(
  externalDeliveryApproved: boolean,
): "external_ai_delivery_not_approved" | "external_ai_delivery_killed" | null {
  if (!externalDeliveryApproved) return "external_ai_delivery_not_approved";
  if (isExternalAutoReplyEmergencyStopped()) return "external_ai_delivery_killed";
  return null;
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

// Test seam: the engine reads config via getAiAgentConfig. Tests override it to
// exercise gating / handoff / escalation without a DB row or a live key.
let __configOverride: AiAgentConfig | null = null;
export function __setAiAgentConfigOverrideForTests(patch: Partial<AiAgentConfig> | null): void {
  __configOverride = patch ? mergeWithDefaults(patch as Record<string, unknown>) : null;
}

function parseBotConfig(configEncrypted: string | null | undefined): AiAgentConfig | null {
  if (!configEncrypted) return null;
  try {
    const encrypted = JSON.parse(configEncrypted) as Record<string, any>;
    return mergeWithDefaults(decryptConfig(encrypted));
  } catch {
    return null;
  }
}

async function readRawConfig(aiBotId?: number | null): Promise<AiAgentConfig> {
  try {
    if (aiBotId != null) {
      const [bot] = await db
        .select({ configEncrypted: aiBotsTable.configEncrypted })
        .from(aiBotsTable)
        .where(eq(aiBotsTable.id, aiBotId));
      const scoped = parseBotConfig(bot?.configEncrypted);
      // A named bot is an isolation boundary. Never fall through to the
      // legacy global integration when its configuration is empty or the id
      // no longer exists; doing so would make two bots silently share state.
      return scoped ?? mergeWithDefaults(null);
    }
    const [row] = await db
      .select()
      .from(integrationsTable)
      .where(eq(integrationsTable.key, AI_AGENT_INTEGRATION_KEY));
    if (row?.config) {
      const decrypted = decryptConfig(row.config as Record<string, any>);
      return mergeWithDefaults(decrypted);
    }
  } catch {
    // DB unavailable — fall back to safe defaults.
  }
  return mergeWithDefaults(null);
}

/** Load the live AI agent config, merged over safe defaults. */
export async function getAiAgentConfig(aiBotId?: number | null): Promise<AiAgentConfig> {
  if (__configOverride) return __configOverride;
  return readRawConfig(aiBotId);
}

/**
 * Validate + persist a (partial) config patch over the current stored config,
 * encrypted like the other integration configs. Returns the merged, validated
 * config. Used by the seed and the FAZ 2 admin panel.
 */
export async function writeAiAgentConfig(
  patch: AiAgentConfigPatch | AiAgentConfig,
  aiBotId?: number | null,
): Promise<AiAgentConfig> {
  const current = await readRawConfig(aiBotId);
  const merged = mergeWithDefaults({
    ...current,
    ...patch,
    escalationKeywords: {
      ...current.escalationKeywords,
      ...(patch.escalationKeywords ?? {}),
    },
    quality: {
      ...current.quality,
      ...(patch.quality ?? {}),
    },
    schedule: {
      ...cloneSchedule(current.schedule),
      ...(patch.schedule ?? {}),
    },
  });
  const validated = aiAgentConfigSchema.parse(merged);
  const encrypted = encryptConfig(validated as Record<string, any>);
  if (aiBotId != null) {
    const updated = await db
      .update(aiBotsTable)
      .set({
        configEncrypted: JSON.stringify(encrypted),
        updatedAt: new Date(),
      })
      .where(eq(aiBotsTable.id, aiBotId))
      .returning({ id: aiBotsTable.id });
    if (updated.length === 0) throw new Error(`AI bot ${aiBotId} not found`);
    return validated;
  }
  await db
    .insert(integrationsTable)
    .values({
      key: AI_AGENT_INTEGRATION_KEY,
      name: AI_AGENT_INTEGRATION_NAME,
      category: AI_AGENT_INTEGRATION_CATEGORY,
      isEnabled: validated.enabled,
      config: encrypted,
    })
    .onConflictDoUpdate({
      target: integrationsTable.key,
      set: {
        name: AI_AGENT_INTEGRATION_NAME,
        category: AI_AGENT_INTEGRATION_CATEGORY,
        isEnabled: validated.enabled,
        config: encrypted,
      },
    });
  return validated;
}

/**
 * Idempotently seed the default ai_agent config (real intake brain) if the row
 * does not yet exist. Runs on api-server boot, like seedClaudeIntegration.
 */
export async function seedAiAgentConfig(): Promise<void> {
  try {
    const [existing] = await db
      .select({ id: integrationsTable.id })
      .from(integrationsTable)
      .where(eq(integrationsTable.key, AI_AGENT_INTEGRATION_KEY));
    if (existing) return;
    const validated = aiAgentConfigSchema.parse(DEFAULT_AI_AGENT_CONFIG);
    const encrypted = encryptConfig(validated as Record<string, any>);
    await db
      .insert(integrationsTable)
      .values({
        key: AI_AGENT_INTEGRATION_KEY,
        name: AI_AGENT_INTEGRATION_NAME,
        category: AI_AGENT_INTEGRATION_CATEGORY,
        isEnabled: validated.enabled,
        config: encrypted,
      })
      .onConflictDoNothing({ target: integrationsTable.key });
    console.log("[seed] ai_agent config seeded with default intake brain");
  } catch (err) {
    console.error("[seed] seedAiAgentConfig error:", err);
  }
}
