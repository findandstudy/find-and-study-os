export const SUPPORTED_LANGUAGES = [
  "en", "tr", "ar", "fr", "ru", "fa", "zh", "hi", "es", "id",
  "ur", "tk", "ky", "kk", "uz", "tg",
] as const;

export type Language = (typeof SUPPORTED_LANGUAGES)[number];

export const DEFAULT_LANGUAGE: Language = "en";

export const RTL_LANGUAGES: Language[] = ["ar", "fa", "ur"];

export interface LanguageMeta {
  code: Language;
  name: string;
  nativeName: string;
  dir: "ltr" | "rtl";
  flag: string;
}

export const LANGUAGE_META: Record<Language, LanguageMeta> = {
  en: { code: "en", name: "English", nativeName: "English", dir: "ltr", flag: "🇬🇧" },
  tr: { code: "tr", name: "Turkish", nativeName: "Türkçe", dir: "ltr", flag: "🇹🇷" },
  ar: { code: "ar", name: "Arabic", nativeName: "العربية", dir: "rtl", flag: "🇸🇦" },
  fr: { code: "fr", name: "French", nativeName: "Français", dir: "ltr", flag: "🇫🇷" },
  ru: { code: "ru", name: "Russian", nativeName: "Русский", dir: "ltr", flag: "🇷🇺" },
  fa: { code: "fa", name: "Persian", nativeName: "فارسی", dir: "rtl", flag: "🇮🇷" },
  zh: { code: "zh", name: "Chinese", nativeName: "中文", dir: "ltr", flag: "🇨🇳" },
  hi: { code: "hi", name: "Hindi", nativeName: "हिन्दी", dir: "ltr", flag: "🇮🇳" },
  es: { code: "es", name: "Spanish", nativeName: "Español", dir: "ltr", flag: "🇪🇸" },
  id: { code: "id", name: "Indonesian", nativeName: "Bahasa Indonesia", dir: "ltr", flag: "🇮🇩" },
  ur: { code: "ur", name: "Urdu", nativeName: "اردو", dir: "rtl", flag: "🇵🇰" },
  tk: { code: "tk", name: "Turkmen", nativeName: "Türkmençe", dir: "ltr", flag: "🇹🇲" },
  ky: { code: "ky", name: "Kyrgyz", nativeName: "Кыргызча", dir: "ltr", flag: "🇰🇬" },
  kk: { code: "kk", name: "Kazakh", nativeName: "Қазақша", dir: "ltr", flag: "🇰🇿" },
  uz: { code: "uz", name: "Uzbek", nativeName: "Oʻzbekcha", dir: "ltr", flag: "🇺🇿" },
  tg: { code: "tg", name: "Tajik", nativeName: "Тоҷикӣ", dir: "ltr", flag: "🇹🇯" },
};

export const LANGUAGE_COUNTRY_CODES: Record<Language, string> = {
  en: "GB", tr: "TR", ar: "SA", fr: "FR", ru: "RU", fa: "IR",
  zh: "CN", hi: "IN", es: "ES", id: "ID", ur: "PK", tk: "TM",
  ky: "KG", kk: "KZ", uz: "UZ", tg: "TJ",
};

/** Canonical options for every system-language selector. */
export const SYSTEM_LANGUAGE_OPTIONS = SUPPORTED_LANGUAGES.map((code) => ({
  code,
  label: LANGUAGE_META[code].nativeName,
  country: LANGUAGE_COUNTRY_CODES[code],
}));

export const SYSTEM_LANGUAGE_LABELS: Record<string, string> = Object.fromEntries(
  SYSTEM_LANGUAGE_OPTIONS.map(({ code, label }) => [code, label]),
);

type TranslationMap = Record<string, unknown>;

// ─── Lazy translation loading ────────────────────────────────────────────────
//
// The language JSONs are large enough that importing them statically would embed
// ALL of them into the main bundle (the 2.9MB index chunk regression). Each
// language is now a dynamic import → its own Vite chunk, and only the active
// language (plus English as the fallback dictionary) is fetched at runtime.
//
// `getTranslation()` stays SYNCHRONOUS — same signature, same call sites.
// I18nProvider awaits `loadLanguage(activeLang)` before the first render, so
// by the time any component calls t(), the active dictionary is in the cache.

const translationLoaders: Record<Language, () => Promise<{ default: TranslationMap }>> = {
  en: () => import("./translations/en.json"),
  tr: () => import("./translations/tr.json"),
  ar: () => import("./translations/ar.json"),
  fr: () => import("./translations/fr.json"),
  ru: () => import("./translations/ru.json"),
  fa: () => import("./translations/fa.json"),
  zh: () => import("./translations/zh.json"),
  hi: () => import("./translations/hi.json"),
  es: () => import("./translations/es.json"),
  id: () => import("./translations/id.json"),
  ur: () => import("./translations/ur.json"),
  tk: () => import("./translations/tk.json"),
  ky: () => import("./translations/ky.json"),
  kk: () => import("./translations/kk.json"),
  uz: () => import("./translations/uz.json"),
  tg: () => import("./translations/tg.json"),
};

function flattenObject(obj: Record<string, unknown>, prefix = ""): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of Object.keys(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const val = obj[key];
    if (typeof val === "object" && val !== null) {
      Object.assign(result, flattenObject(val as Record<string, unknown>, fullKey));
    } else {
      result[fullKey] = String(val);
    }
  }
  return result;
}

const flatTranslations: Partial<Record<Language, Record<string, string>>> = {};
const inFlight: Partial<Record<Language, Promise<boolean>>> = {};

/** True once a language's dictionary is in the in-memory cache. */
export function isLanguageLoaded(lang: Language): boolean {
  return flatTranslations[lang] !== undefined;
}

/**
 * Load (and flatten) a language's translation JSON into the cache.
 * Idempotent and de-duplicated: concurrent calls share one fetch.
 * Never rejects — on network failure it logs, leaves the cache empty and
 * resolves `false` so callers can decide not to commit a language switch.
 */
export function loadLanguage(lang: Language): Promise<boolean> {
  if (flatTranslations[lang]) return Promise.resolve(true);
  const pending = inFlight[lang];
  if (pending) return pending;
  const p = translationLoaders[lang]()
    .then((mod) => {
      flatTranslations[lang] = flattenObject(mod.default);
      return true;
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[i18n] Failed to load translations for "${lang}"`, err);
      return false;
    })
    .finally(() => {
      delete inFlight[lang];
    });
  inFlight[lang] = p;
  return p;
}

const _warnedMissing = new Set<string>();
export function getTranslation(lang: Language, key: string, params?: Record<string, string | number>): string {
  const direct = flatTranslations[lang]?.[key];
  const fallback = flatTranslations[DEFAULT_LANGUAGE]?.[key];
  if (import.meta.env?.DEV && !direct && !fallback && !_warnedMissing.has(key)) {
    _warnedMissing.add(key);
    // eslint-disable-next-line no-console
    console.warn(`[i18n] Missing translation key: "${key}" (lang=${lang})`);
  }
  let value = direct || fallback || key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      value = value.replace(`{${k}}`, String(v));
    }
  }
  return value;
}

/**
 * Format a relative "time ago" string using i18n keys.
 * Looks up: common.justNow, common.minutesAgo, common.hoursAgo, common.daysAgo (each may use {n}).
 */
export function formatTimeAgo(lang: Language, dateStr: string | Date): string {
  const date = typeof dateStr === "string" ? new Date(dateStr) : dateStr;
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return getTranslation(lang, "common.justNow");
  if (mins < 60) return getTranslation(lang, "common.minutesAgo", { n: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return getTranslation(lang, "common.hoursAgo", { n: hours });
  const days = Math.floor(hours / 24);
  return getTranslation(lang, "common.daysAgo", { n: days });
}

/**
 * Map our short language code to the BCP47 locale string used by
 * Intl.DateTimeFormat / Number.toLocaleString. Falls back to "en-US".
 */
const LOCALE_MAP: Record<Language, string> = {
  en: "en-US",
  tr: "tr-TR",
  ar: "ar-SA",
  fr: "fr-FR",
  ru: "ru-RU",
  fa: "fa-IR",
  zh: "zh-CN",
  hi: "hi-IN",
  es: "es-ES",
  id: "id-ID",
  ur: "ur-PK",
  tk: "tk-TM",
  ky: "ky-KG",
  kk: "kk-KZ",
  uz: "uz-UZ",
  tg: "tg-TJ",
};

export function getLocale(lang: Language): string {
  return LOCALE_MAP[lang] || "en-US";
}

/** Format a date respecting the org dateFormat setting (DD.MM.YYYY default). */
export function formatDate(
  lang: Language,
  date: string | number | Date,
  options?: Intl.DateTimeFormatOptions,
  dateFormat?: string | null,
): string {
  if (date == null) return "";
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return "";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = String(d.getFullYear());
  switch (dateFormat) {
    case "DD/MM/YYYY": return `${dd}/${mm}/${yyyy}`;
    case "MM/DD/YYYY": return `${mm}/${dd}/${yyyy}`;
    case "YYYY-MM-DD": return `${yyyy}-${mm}-${dd}`;
    default:           return `${dd}.${mm}.${yyyy}`;
  }
}

/** Format a time with the given language's locale. */
export function formatTime(
  lang: Language,
  date: string | number | Date,
  options?: Intl.DateTimeFormatOptions,
): string {
  if (date == null) return "";
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return "";
  try {
    return d.toLocaleTimeString(getLocale(lang), options);
  } catch {
    return d.toLocaleTimeString("en-US", options);
  }
}

/** Format a date+time as dd.mm.yyyy HH:MM 24h (e.g. 15.07.2026 14:30). Locale-independent. */
export function formatDateTime(
  lang: Language,
  date: string | number | Date,
  options?: Intl.DateTimeFormatOptions,
): string {
  if (date == null) return "";
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return "";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${dd}.${mm}.${yyyy} ${hh}:${mi}`;
}

export function isValidLanguage(lang: string): lang is Language {
  return SUPPORTED_LANGUAGES.includes(lang as Language);
}

export function detectBrowserLanguage(): Language {
  if (typeof navigator === "undefined") return DEFAULT_LANGUAGE;
  const browserLangs = navigator.languages || [navigator.language];
  for (const bl of browserLangs) {
    const code = bl.split("-")[0].toLowerCase();
    if (isValidLanguage(code)) return code;
  }
  return DEFAULT_LANGUAGE;
}

export function getLanguageFromPath(pathname: string): Language | null {
  const match = pathname.match(/^\/([a-z]{2})(\/|$)/);
  if (match && isValidLanguage(match[1])) return match[1];
  return null;
}

export function buildLocalizedPath(path: string, lang: Language): string {
  const cleanPath = path.replace(/^\/[a-z]{2}(\/|$)/, "/");
  const normalizedPath = cleanPath === "" ? "/" : cleanPath;
  return `/${lang}${normalizedPath === "/" ? "" : normalizedPath}`;
}

export function stripLanguagePrefix(pathname: string): string {
  return pathname.replace(/^\/[a-z]{2}(\/|$)/, "/") || "/";
}
