export interface LocalizableNotification {
  type?: string | null;
  title?: string | null;
  body?: string | null;
  data?: Record<string, unknown> | null;
}

interface OfferExpiryCopy {
  offerLetter: string;
  title: (stage: string, days: number) => string;
  body: (subject: string, stage: string, date: string, days: number) => string;
}

const COPY: Record<string, OfferExpiryCopy> = {
  en: {
    offerLetter: "Offer Letter",
    title: (stage, days) => `${stage} expires in ${days} day${days === 1 ? "" : "s"}`,
    body: (subject, stage, date, days) => `${subject}: the ${stage} document is valid until ${date} (${days} day${days === 1 ? "" : "s"} left).`,
  },
  tr: {
    offerLetter: "Teklif Mektubu",
    title: (stage, days) => `${stage} ${days} gün içinde geçerliliğini yitiriyor`,
    body: (subject, stage, date, days) => `${subject}: ${stage} belgesinin son geçerlilik tarihi ${date} (${days} gün kaldı).`,
  },
  ar: {
    offerLetter: "خطاب القبول",
    title: (stage, days) => `تنتهي صلاحية ${stage} خلال ${days} يومًا`,
    body: (subject, stage, date, days) => `${subject}: وثيقة ${stage} صالحة حتى ${date} (متبقي ${days} يومًا).`,
  },
  fa: {
    offerLetter: "نامه پذیرش",
    title: (stage, days) => `اعتبار ${stage} تا ${days} روز دیگر پایان می‌یابد`,
    body: (subject, stage, date, days) => `${subject}: مدرک ${stage} تا ${date} معتبر است (${days} روز باقی مانده).`,
  },
  fr: {
    offerLetter: "Lettre d’admission",
    title: (stage, days) => `${stage} expire dans ${days} jour${days === 1 ? "" : "s"}`,
    body: (subject, stage, date, days) => `${subject} : le document ${stage} est valable jusqu’au ${date} (${days} jour${days === 1 ? "" : "s"} restant${days === 1 ? "" : "s"}).`,
  },
  es: {
    offerLetter: "Carta de admisión",
    title: (stage, days) => `${stage} vence en ${days} día${days === 1 ? "" : "s"}`,
    body: (subject, stage, date, days) => `${subject}: el documento ${stage} es válido hasta el ${date} (quedan ${days} día${days === 1 ? "" : "s"}).`,
  },
  ru: {
    offerLetter: "Письмо о зачислении",
    title: (stage, days) => `Срок действия «${stage}» истекает через ${days} дн.`,
    body: (subject, stage, date, days) => `${subject}: документ «${stage}» действителен до ${date} (осталось ${days} дн.).`,
  },
  zh: {
    offerLetter: "录取通知书",
    title: (stage, days) => `${stage}将在 ${days} 天后到期`,
    body: (subject, stage, date, days) => `${subject}：${stage}有效期至 ${date}（剩余 ${days} 天）。`,
  },
  hi: {
    offerLetter: "प्रवेश पत्र",
    title: (stage, days) => `${stage} की वैधता ${days} दिन में समाप्त होगी`,
    body: (subject, stage, date, days) => `${subject}: ${stage} दस्तावेज़ ${date} तक वैध है (${days} दिन शेष)।`,
  },
  id: {
    offerLetter: "Surat Penerimaan",
    title: (stage, days) => `${stage} akan kedaluwarsa dalam ${days} hari`,
    body: (subject, stage, date, days) => `${subject}: dokumen ${stage} berlaku hingga ${date} (${days} hari tersisa).`,
  },
  bn: {
    offerLetter: "ভর্তি পত্র",
    title: (stage, days) => `${stage}-এর মেয়াদ ${days} দিনের মধ্যে শেষ হবে`,
    body: (subject, stage, date, days) => `${subject}: ${stage} নথিটি ${date} পর্যন্ত বৈধ (${days} দিন বাকি)।`,
  },
  pt: {
    offerLetter: "Carta de admissão",
    title: (stage, days) => `${stage} expira em ${days} dia${days === 1 ? "" : "s"}`,
    body: (subject, stage, date, days) => `${subject}: o documento ${stage} é válido até ${date} (${days} dia${days === 1 ? "" : "s"} restante${days === 1 ? "" : "s"}).`,
  },
  ne: {
    offerLetter: "भर्ना पत्र",
    title: (stage, days) => `${stage} को म्याद ${days} दिनमा समाप्त हुन्छ`,
    body: (subject, stage, date, days) => `${subject}: ${stage} कागजात ${date} सम्म मान्य छ (${days} दिन बाँकी)।`,
  },
  vi: {
    offerLetter: "Thư nhập học",
    title: (stage, days) => `${stage} sẽ hết hạn sau ${days} ngày`,
    body: (subject, stage, date, days) => `${subject}: tài liệu ${stage} có hiệu lực đến ${date} (còn ${days} ngày).`,
  },
  ko: {
    offerLetter: "입학 허가서",
    title: (stage, days) => `${stage}의 유효 기간이 ${days}일 후 만료됩니다`,
    body: (subject, stage, date, days) => `${subject}: ${stage} 문서는 ${date}까지 유효합니다(${days}일 남음).`,
  },
  uk: {
    offerLetter: "Лист про зарахування",
    title: (stage, days) => `Термін дії «${stage}» закінчується через ${days} дн.`,
    body: (subject, stage, date, days) => `${subject}: документ «${stage}» дійсний до ${date} (залишилося ${days} дн.).`,
  },
  it: {
    offerLetter: "Lettera di ammissione",
    title: (stage, days) => `${stage} scade tra ${days} giorn${days === 1 ? "o" : "i"}`,
    body: (subject, stage, date, days) => `${subject}: il documento ${stage} è valido fino al ${date} (${days} giorn${days === 1 ? "o" : "i"} rimanent${days === 1 ? "e" : "i"}).`,
  },
};

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function formatLocalizedDate(value: unknown, lang: string): string {
  const date = new Date(asText(value));
  if (Number.isNaN(date.getTime())) return asText(value);
  return new Intl.DateTimeFormat(getLocale(isValidLanguage(lang) ? lang : "en"), {
    day: "2-digit",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function isOfferLetterStage(data: Record<string, unknown>): boolean {
  const stage = `${asText(data.stage)} ${asText(data.stageLabel)}`.toLocaleLowerCase("en-US");
  return stage.includes("offer") || stage.includes("acceptance") || stage.includes("admission");
}

export function localizeNotification(
  notification: LocalizableNotification,
  requestedLanguage: string,
): { title: string; body: string | null } {
  const fallback = {
    title: notification.title || "",
    body: notification.body || null,
  };
  if (notification.type !== "application.offer_letter_expiring") return fallback;

  const lang = COPY[requestedLanguage] ? requestedLanguage : "en";
  const copy = COPY[lang];
  const data = notification.data && typeof notification.data === "object" ? notification.data : {};
  const days = Number(data.daysLeft);
  const date = formatLocalizedDate(data.validUntil, lang);
  if (!Number.isFinite(days) || !date) return fallback;

  const storedStageLabel = asText(data.stageLabel);
  const stage = isOfferLetterStage(data) ? copy.offerLetter : (storedStageLabel || copy.offerLetter);
  const studentName = asText(data.studentName);
  const universityName = asText(data.universityName);
  const programName = asText(data.programName);
  const institution = [universityName, programName].filter(Boolean).join(" / ");
  const subject = [studentName, institution].filter(Boolean).join(" — ") || stage;

  return {
    title: copy.title(stage, days),
    body: copy.body(subject, stage, date, days),
  };
}
import { getLocale, isValidLanguage } from "@/lib/i18n";
