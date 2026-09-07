import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useProgramDocRequirements, useResolveDocMeta } from "@/lib/programDocTypes";
import { toLatinUpper, digitsOnly } from "@/lib/textTransform";
import { Link, useLocation } from "wouter";
import { useI18n } from "@/hooks/use-i18n";
import { useSeo } from "@/hooks/use-seo";
import { useJsonLd, SITE_URL, SITE_NAME } from "@/hooks/use-json-ld";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MultiSelectFilter } from "@/components/ui/multi-select-filter";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { customFetch } from "@workspace/api-client-react";
import { findEquivalentDoc, getDocEquivalenceGroup } from "@workspace/doc-equivalence";
import { useAuth } from "@/hooks/use-auth";
import {
  APPLICATION_DOCUMENT_HELP_TEXT,
  sanitizeFileName,
  validateApplicationDocumentFileObj as validateFile,
} from "@/lib/fileUploadValidation";
import { PHONE_CODES, normalizeNationality, FALLBACK_COUNTRIES } from "@/lib/nationalities";
import { PhoneCodePicker } from "@/components/ui/phone-code-picker";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Search, MapPin, BookOpen, GraduationCap, Globe2, Clock, DollarSign, Users,
  Languages, ChevronLeft, ChevronRight, Upload, X, CheckCircle2, Loader2, Sparkles,
  SlidersHorizontal, Building2, Award, ChevronDown, ChevronUp, Info, ExternalLink,
  AlertTriangle, FileText, Camera, Calendar, Shield,
} from "lucide-react";
import { DocumentScanner } from "@/components/DocumentScanner";
import { motion, AnimatePresence } from "framer-motion";
import { useToast } from "@/hooks/use-toast";
import { MAX_DOCUMENT_PARTS, isSingleImageDocumentType, mergeDocumentParts } from "@/lib/documentPartMerge";

const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

function useDebounce(value: string, delay: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

interface Program {
  id: number;
  name: string;
  description: string | null;
  degree: string | null;
  field: string | null;
  language: string | null;
  duration: string | null;
  tuitionFee: number | null;
  currency: string | null;
  discountedFee: number | null;
  scholarship: number | null;
  intakes: string | null;
  requirements: string | null;
  applicationFee: number | null;
  advancedFee: number | null;
  depositFee: number | null;
  languageFee: number | null;
  feeType: string | null;
  universityName: string;
  universityCountry: string | null;
  universityType: string | null;
  universityCity: string | null;
  universityLogoUrl: string | null;
  universityWebsite: string | null;
  universityDescription: string | null;
  universityRanking: string | null;
  universityQsRanking: string | null;
  universityTimesRanking: string | null;
  universityAddress: string | null;
}

interface Filters {
  countries: string[];
  cities: string[];
  universityTypes: string[];
  universities: { id: number; name: string }[];
  degrees: string[];
  languages: string[];
  fields: string[];
  feeRange: { min: number; max: number } | null;
}

function formatFee(fee: number | null, currency: string | null): string {
  if (!fee) return "";
  const cur = currency || "USD";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: cur, maximumFractionDigits: 0 }).format(fee);
  } catch {
    return `${fee} ${cur}`;
  }
}

function fixStorageUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  let fixed = url.replace(/\/api\/storage\/objects\/objects\//, "/api/storage/objects/");
  if (!fixed.startsWith("http") && !fixed.startsWith(BASE_URL)) {
    fixed = `${BASE_URL}${fixed.startsWith("/") ? "" : "/"}${fixed}`;
  }
  return fixed;
}

type DocKey = string;

interface DocType { key: DocKey; labelKey: string; icon: string; accept: string; required: boolean; subtitleKey?: string; label?: string }

const DEGREE_DOC_MAP: Record<string, DocType[]> = {
  associate: [
    { key: "hs_diploma", labelKey: "apply.docLabel_hs_diploma", icon: "🎓", accept: ".pdf,.jpg,.jpeg,.png", required: true },
    { key: "hs_transcript", labelKey: "apply.docLabel_hs_transcript", icon: "📋", accept: ".pdf,.jpg,.jpeg,.png", required: true },
    { key: "passport", labelKey: "apply.docLabel_passport", icon: "🛂", accept: ".pdf,.jpg,.jpeg,.png", required: true },
    { key: "photo", labelKey: "apply.docLabel_photo", icon: "📷", accept: ".pdf,.jpg,.jpeg,.png", required: true },
    { key: "language_proof", labelKey: "apply.docLabel_language_proof", icon: "🌐", accept: ".pdf,.jpg,.jpeg,.png", required: false, subtitleKey: "apply.docSub_ifAvailable" },
  ],
  bachelors: [
    { key: "hs_diploma", labelKey: "apply.docLabel_hs_diploma", icon: "🎓", accept: ".pdf,.jpg,.jpeg,.png", required: true },
    { key: "hs_transcript", labelKey: "apply.docLabel_hs_transcript", icon: "📋", accept: ".pdf,.jpg,.jpeg,.png", required: true },
    { key: "passport", labelKey: "apply.docLabel_passport", icon: "🛂", accept: ".pdf,.jpg,.jpeg,.png", required: true },
    { key: "photo", labelKey: "apply.docLabel_photo", icon: "📷", accept: ".pdf,.jpg,.jpeg,.png", required: true },
    { key: "language_proof", labelKey: "apply.docLabel_language_proof", icon: "🌐", accept: ".pdf,.jpg,.jpeg,.png", required: false, subtitleKey: "apply.docSub_ifAvailable" },
  ],
  masters: [
    { key: "bachelor_diploma", labelKey: "apply.docLabel_bachelor_diploma", icon: "🎓", accept: ".pdf,.jpg,.jpeg,.png", required: true },
    { key: "bachelor_transcript", labelKey: "apply.docLabel_bachelor_transcript", icon: "📋", accept: ".pdf,.jpg,.jpeg,.png", required: true },
    { key: "passport", labelKey: "apply.docLabel_passport", icon: "🛂", accept: ".pdf,.jpg,.jpeg,.png", required: true },
    { key: "photo", labelKey: "apply.docLabel_photo", icon: "📷", accept: ".pdf,.jpg,.jpeg,.png", required: true },
    { key: "equivalency_letter", labelKey: "apply.docLabel_equivalency_letter", icon: "📜", accept: ".pdf,.jpg,.jpeg,.png", required: false, subtitleKey: "apply.docSub_recognition" },
    { key: "cv", labelKey: "apply.docLabel_cv", icon: "📄", accept: ".pdf,.jpg,.jpeg,.png", required: false, subtitleKey: "apply.docSub_ifRequired" },
    { key: "sop", labelKey: "apply.docLabel_sop", icon: "✍️", accept: ".pdf,.jpg,.jpeg,.png", required: false, subtitleKey: "apply.docSub_ifRequired" },
    { key: "language_proof", labelKey: "apply.docLabel_language_proof", icon: "🌐", accept: ".pdf,.jpg,.jpeg,.png", required: false, subtitleKey: "apply.docSub_ifAvailable" },
  ],
  doctorate: [
    { key: "bachelor_diploma", labelKey: "apply.docLabel_bachelor_diploma", icon: "🎓", accept: ".pdf,.jpg,.jpeg,.png", required: true },
    { key: "bachelor_transcript", labelKey: "apply.docLabel_bachelor_transcript", icon: "📋", accept: ".pdf,.jpg,.jpeg,.png", required: true },
    { key: "master_diploma", labelKey: "apply.docLabel_master_diploma", icon: "🎓", accept: ".pdf,.jpg,.jpeg,.png", required: true },
    { key: "master_transcript", labelKey: "apply.docLabel_master_transcript", icon: "📋", accept: ".pdf,.jpg,.jpeg,.png", required: true },
    { key: "passport", labelKey: "apply.docLabel_passport", icon: "🛂", accept: ".pdf,.jpg,.jpeg,.png", required: true },
    { key: "photo", labelKey: "apply.docLabel_photo", icon: "📷", accept: ".pdf,.jpg,.jpeg,.png", required: true },
    { key: "equivalency_letter", labelKey: "apply.docLabel_equivalency_letter", icon: "📜", accept: ".pdf,.jpg,.jpeg,.png", required: false, subtitleKey: "apply.docSub_recognition" },
    { key: "cv", labelKey: "apply.docLabel_cv", icon: "📄", accept: ".pdf,.jpg,.jpeg,.png", required: false, subtitleKey: "apply.docSub_ifRequired" },
    { key: "sop", labelKey: "apply.docLabel_sop", icon: "✍️", accept: ".pdf,.jpg,.jpeg,.png", required: false, subtitleKey: "apply.docSub_ifRequired" },
    { key: "language_proof", labelKey: "apply.docLabel_language_proof", icon: "🌐", accept: ".pdf,.jpg,.jpeg,.png", required: false, subtitleKey: "apply.docSub_ifAvailable" },
  ],
  language: [
    { key: "passport", labelKey: "apply.docLabel_passport", icon: "🛂", accept: ".pdf,.jpg,.jpeg,.png", required: true },
    { key: "hs_diploma", labelKey: "apply.docLabel_hs_diploma", icon: "🎓", accept: ".pdf,.jpg,.jpeg,.png", required: false },
    { key: "hs_transcript", labelKey: "apply.docLabel_hs_transcript", icon: "📋", accept: ".pdf,.jpg,.jpeg,.png", required: false },
    { key: "photo", labelKey: "apply.docLabel_photo", icon: "📷", accept: ".pdf,.jpg,.jpeg,.png", required: false },
  ],
  foundation: [
    { key: "passport", labelKey: "apply.docLabel_passport", icon: "🛂", accept: ".pdf,.jpg,.jpeg,.png", required: true },
    { key: "hs_diploma", labelKey: "apply.docLabel_hs_diploma", icon: "🎓", accept: ".pdf,.jpg,.jpeg,.png", required: false },
    { key: "hs_transcript", labelKey: "apply.docLabel_hs_transcript", icon: "📋", accept: ".pdf,.jpg,.jpeg,.png", required: false },
    { key: "photo", labelKey: "apply.docLabel_photo", icon: "📷", accept: ".pdf,.jpg,.jpeg,.png", required: false },
  ],
};

const DEFAULT_DOC_TYPES: DocType[] = [
  { key: "passport", labelKey: "apply.docLabel_passport", icon: "🛂", accept: ".pdf,.jpg,.jpeg,.png", required: true },
  { key: "hs_diploma", labelKey: "apply.docLabel_hs_diploma", icon: "🎓", accept: ".pdf,.jpg,.jpeg,.png", required: false },
  { key: "hs_transcript", labelKey: "apply.docLabel_hs_transcript", icon: "📋", accept: ".pdf,.jpg,.jpeg,.png", required: false },
  { key: "photo", labelKey: "apply.docLabel_photo", icon: "📷", accept: ".pdf,.jpg,.jpeg,.png", required: false },
];

function getDocTypesForDegree(degree: string | null | undefined): DocType[] {
  if (!degree) return DEFAULT_DOC_TYPES;
  const normalized = degree.toLowerCase().replace(/['''`\s.]/g, "");
  if (normalized.includes("associate")) return DEGREE_DOC_MAP.associate;
  if (normalized.includes("bachelor")) return DEGREE_DOC_MAP.bachelors;
  if (normalized.includes("master")) return DEGREE_DOC_MAP.masters;
  if (normalized.includes("doctor") || normalized.includes("phd") || normalized.includes("doctorate")) return DEGREE_DOC_MAP.doctorate;
  if (normalized.includes("language")) return DEGREE_DOC_MAP.language;
  if (normalized.includes("foundation")) return DEGREE_DOC_MAP.foundation;
  return DEFAULT_DOC_TYPES;
}

type UploadedDoc = { key: string; label: string; file: File; base64: string; mediaType: string; isImage: boolean; partCount?: number };

function compressImage(file: File, maxWidth = 1600, quality = 0.78): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        let { width, height } = img;
        if (width > maxWidth) { height = Math.round((height * maxWidth) / width); width = maxWidth; }
        canvas.width = width; canvas.height = height;
        canvas.getContext("2d")!.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality).split(",")[1]);
      };
      img.onerror = reject;
      img.src = e.target?.result as string;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function prepareDoc(file: File): Promise<{ base64: string; mediaType: string; isImage: boolean }> {
  if (file.type.startsWith("image/")) {
    return { base64: await compressImage(file), mediaType: "image/jpeg", isImage: true };
  }
  return { base64: await fileToBase64(file), mediaType: file.type || "application/pdf", isImage: false };
}

function DropZone({ docType, uploaded, onUpload, onRemove, applicationSession }: {
  docType: DocType;
  uploaded?: UploadedDoc;
  onUpload: (d: UploadedDoc) => void;
  onRemove: () => void;
  applicationSession: string;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [merging, setMerging] = useState(false);
  const { toast } = useToast();

  async function handleFiles(files: File[]) {
    if (files.length === 0) return;
    const labelText = docType.label ?? t(docType.labelKey);
    const currentPartCount = uploaded?.partCount || (uploaded ? 1 : 0);
    if (isSingleImageDocumentType(docType.key) && (uploaded || files.length > 1)) {
      toast({ title: "Photograph accepts one file", description: "Remove the current photograph before choosing another PDF or image.", variant: "destructive" });
      return;
    }
    if (currentPartCount + files.length > MAX_DOCUMENT_PARTS) {
      toast({ title: "Too many document parts", description: `You can combine up to ${MAX_DOCUMENT_PARTS} parts in one document box.`, variant: "destructive" });
      return;
    }

    const safeFiles: File[] = [];
    for (const file of files) {
      const validation = validateFile(file);
      if (!validation.valid) {
        toast({ title: t("apply.fileError"), description: validation.message, variant: "destructive" });
        return;
      }
      safeFiles.push(new File([file], sanitizeFileName(file.name), { type: file.type }));
    }

    setMerging(true);
    try {
      const prepared = await Promise.all(safeFiles.map(prepareDoc));
      if (!uploaded && prepared.length === 1) {
        onUpload({ key: docType.key, label: labelText, file: safeFiles[0], ...prepared[0], partCount: 1 });
        return;
      }
      const merged = await mergeDocumentParts({
        documentType: docType.key,
        label: labelText,
        publicSessionToken: applicationSession,
        parts: [
          ...(uploaded ? [{ file: uploaded.file, mediaType: uploaded.mediaType }] : []),
          ...safeFiles.map((file, index) => ({ file, mediaType: prepared[index].mediaType })),
        ],
      });
      onUpload({
        key: docType.key,
        label: labelText,
        file: merged.file,
        base64: merged.base64,
        mediaType: merged.mediaType,
        isImage: false,
        partCount: currentPartCount + files.length,
      });
    } catch (error) {
      toast({ title: "Documents could not be combined", description: error instanceof Error ? error.message : "Please try again.", variant: "destructive" });
    } finally {
      setMerging(false);
    }
  }

  async function handleFile(file: File) {
    await handleFiles([file]);
  }

  if (uploaded) {
    return (
      <div className="relative flex flex-col items-center gap-1.5 p-3 border-2 border-green-300 bg-green-50 dark:bg-green-950/30 rounded-2xl text-center min-h-[110px] justify-center">
        <button type="button" onClick={onRemove} className="absolute top-2 right-2 w-5 h-5 bg-destructive/10 hover:bg-destructive/20 text-destructive rounded-full flex items-center justify-center">
          <X className="w-3 h-3" />
        </button>
        <CheckCircle2 className="w-5 h-5 text-green-500" />
        <p className="text-xs font-semibold text-foreground truncate max-w-[90px]">{uploaded.file.name}</p>
        {(uploaded.partCount || 1) > 1 && <p className="text-[10px] font-medium text-green-700">{uploaded.partCount} parts combined</p>}
        <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full font-medium">{docType.label ?? t(docType.labelKey)}</span>
        {!isSingleImageDocumentType(docType.key) && (
          <div className="flex items-center gap-2">
            <button type="button" disabled={merging} onClick={() => inputRef.current?.click()} className="text-[10px] font-semibold text-primary hover:underline disabled:opacity-50">
              {merging ? "Combining..." : "+ Add part"}
            </button>
            <button type="button" disabled={merging} onClick={() => setScannerOpen(true)} className="text-[10px] font-semibold text-primary hover:underline disabled:opacity-50">Scan</button>
          </div>
        )}
        <input ref={inputRef} type="file" multiple={!isSingleImageDocumentType(docType.key)} accept={docType.accept} className="hidden"
          onChange={(e) => { void handleFiles(Array.from(e.target.files || [])); e.target.value = ""; }} />
        <DocumentScanner open={scannerOpen} onClose={() => setScannerOpen(false)} baseName={docType.key} onCapture={handleFile} />
      </div>
    );
  }

  return (
    <div
      className={`flex flex-col items-center gap-1.5 p-3 border-2 border-dashed rounded-2xl text-center cursor-pointer min-h-[110px] justify-center transition-all
        ${docType.required
          ? (dragging ? "border-primary bg-primary/10" : "border-rose-200 hover:border-primary/50 hover:bg-secondary/50")
          : (dragging ? "border-primary bg-primary/10" : "border-blue-200 border-dashed hover:border-primary/50 hover:bg-secondary/50")
        }`}
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); void handleFiles(Array.from(e.dataTransfer.files)); }}
    >
      <span className="text-2xl">{docType.icon}</span>
      <p className="text-xs font-semibold text-foreground">{docType.label ?? t(docType.labelKey)}</p>
      {docType.subtitleKey && <span className="text-[10px] text-muted-foreground">{t(docType.subtitleKey)}</span>}
      {docType.required
        ? <span className="text-[10px] bg-rose-100 text-rose-600 px-1.5 py-0.5 rounded-full font-semibold dark:bg-rose-900/40 dark:text-rose-300">{t("apply.required")}</span>
        : <span className="text-[10px] bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400 px-1.5 py-0.5 rounded-full font-medium">{t("apply.optional")}</span>
      }
      <input ref={inputRef} type="file" multiple={!isSingleImageDocumentType(docType.key)} accept={docType.accept} className="hidden"
        onChange={(e) => { void handleFiles(Array.from(e.target.files || [])); e.target.value = ""; }} />
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setScannerOpen(true); }}
        className="mt-1 inline-flex items-center gap-1 text-[10px] font-medium text-primary hover:underline"
      >
        <Camera className="w-3 h-3" />
        {t("scanner.scanWithCamera")}
      </button>
      <DocumentScanner open={scannerOpen} onClose={() => setScannerOpen(false)} baseName={docType.key} onCapture={handleFile} />
    </div>
  );
}

function AiBadge() {
  return <span className="ml-1.5 text-[10px] bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300 px-1.5 py-0.5 rounded-full font-semibold tracking-wide">AI</span>;
}

function MissingHint({ label }: { label: string }) {
  return (
    <span className="ml-1.5 inline-flex items-center" title={label} aria-label={label}>
      <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
    </span>
  );
}

const PASSPORT_EXTRACTED_FIELDS = new Set<string>([
  "passportNumber", "passportIssueDate", "passportExpiry",
  "dateOfBirth", "nationality", "motherName", "fatherName", "address",
]);
const DIPLOMA_EXTRACTED_FIELDS = new Set<string>([
  "highSchool", "graduationYear", "gpa",
]);

type ApplyStep = "personal" | "documents" | "analyzing" | "review" | "success";

const EMPTY_FORM = {
  firstName: "", lastName: "", email: "", phone: "", phoneCode: "",
  nationality: "", dateOfBirth: "", gender: "", notes: "",
  motherName: "", fatherName: "", passportNumber: "",
  passportIssueDate: "", passportExpiry: "",
  address: "", highSchool: "", graduationYear: "", gpa: "", languageScore: "",
};

function StepIndicator({ current, steps }: { current: number; steps: string[] }) {
  return (
    <div className="flex items-center justify-center gap-2 mb-2">
      {steps.map((label, i) => (
        <div key={i} className="flex items-center gap-2">
          <div className={`flex items-center gap-1.5 ${i <= current ? "text-primary" : "text-muted-foreground/50"}`}>
            <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold border-2 transition-all
              ${i < current ? "bg-primary text-white border-primary" : i === current ? "border-primary text-primary bg-primary/10" : "border-muted-foreground/30 text-muted-foreground/50"}`}>
              {i < current ? <CheckCircle2 className="w-4 h-4" /> : i + 1}
            </div>
            <span className="text-xs font-medium hidden sm:inline">{label}</span>
          </div>
          {i < steps.length - 1 && (
            <div className={`w-8 h-0.5 rounded-full transition-all ${i < current ? "bg-primary" : "bg-muted-foreground/20"}`} />
          )}
        </div>
      ))}
    </div>
  );
}

function splitPhoneNumber(full: string | null | undefined, fallbackCode: string): { code: string; number: string } {
  if (!full) return { code: fallbackCode, number: "" };
  const trimmed = String(full).trim();
  if (!trimmed) return { code: fallbackCode, number: "" };
  const sortedCodes = Array.from(new Set(PHONE_CODES.map(p => p.code))).sort((a, b) => b.length - a.length);
  for (const c of sortedCodes) {
    if (trimmed.startsWith(c)) return { code: c, number: trimmed.slice(c.length).trim() };
  }
  return { code: fallbackCode, number: trimmed };
}

interface ExistingDocInfo {
  id: number;
  name: string;
  status: string;
  mimeType: string | null;
  createdAt: string;
  type: string;
}

function ApplyDialog({ open, onClose, program, countries }: { open: boolean; onClose: () => void; program: Program | null; countries: string[] }) {
  const { t, localePath } = useI18n();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const { user } = useAuth(false);
  const isLoggedInStudent = !!user && user.role === "student";
  const [step, setStep] = useState<ApplyStep>("personal");
  const [docs, setDocs] = useState<Record<string, UploadedDoc>>({});
  const [form, setForm] = useState({ ...EMPTY_FORM });
  // SIT student-information questions (Review & Submit step only).
  const [sitInfo, setSitInfo] = useState({ transferStudent: false, hasTcId: false, hasBlueCard: false });
  const [extracted, setExtracted] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [leadId, setLeadId] = useState<number | null>(null);
  const [creatingLead, setCreatingLead] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [allCountries, setAllCountries] = useState<Array<{ id: number; name: string; code?: string; flagEmoji?: string | null }>>([]);
  const [existingDocs, setExistingDocs] = useState<ExistingDocInfo[]>([]);
  const [replacedTypes, setReplacedTypes] = useState<Set<string>>(new Set());
  const [profileLoaded, setProfileLoaded] = useState(false);
  const applicationSessionRef = useRef(
    globalThis.crypto?.randomUUID?.() || `app-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  useEffect(() => {
    if (open && allCountries.length === 0) {
      fetch(`${import.meta.env.BASE_URL}api/countries?limit=500`).then(r => r.json()).then(d => {
        if (d?.data) setAllCountries(d.data);
      }).catch(() => {});
    }
  }, [open]);

  useEffect(() => {
    if (!open || !isLoggedInStudent) return;
    let cancelled = false;
    (async () => {
      try {
        const [profile, docsResp] = await Promise.all([
          customFetch<any>("/api/students/me", { method: "GET" }).catch(() => null),
          customFetch<any[]>("/api/documents", { method: "GET" }).catch(() => []),
        ]);
        if (cancelled) return;
        if (profile && typeof profile === "object") {
          const phoneStr = (profile as any).phone || user?.phone || "";
          const { code, number } = splitPhoneNumber(phoneStr, "");
          setForm(f => ({
            ...f,
            firstName: (profile as any).firstName || user?.firstName || f.firstName,
            lastName: (profile as any).lastName || user?.lastName || f.lastName,
            email: user?.email || (profile as any).email || f.email,
            phone: number || f.phone,
            phoneCode: code || f.phoneCode,
            nationality: (profile as any).nationality || f.nationality,
            dateOfBirth: (profile as any).dateOfBirth || f.dateOfBirth,
            gender: (profile as any).gender || f.gender,
            motherName: (profile as any).motherName || f.motherName,
            fatherName: (profile as any).fatherName || f.fatherName,
            passportNumber: (profile as any).passportNumber || f.passportNumber,
            passportIssueDate: (profile as any).passportIssueDate || f.passportIssueDate,
            passportExpiry: (profile as any).passportExpiry || f.passportExpiry,
            address: (profile as any).address || f.address,
            highSchool: (profile as any).highSchool || f.highSchool,
            graduationYear: (profile as any).graduationYear ? String((profile as any).graduationYear) : f.graduationYear,
            gpa: (profile as any).gpa || f.gpa,
            languageScore: (profile as any).languageScore || f.languageScore,
          }));
        }
        const list = Array.isArray(docsResp) ? docsResp : [];
        const all: ExistingDocInfo[] = [];
        for (const d of list) {
          if (!d?.type || d.deletedAt || d.status === "rejected") continue;
          all.push({
            id: d.id,
            name: d.name || d.type,
            status: d.status || "pending",
            mimeType: d.mimeType ?? null,
            createdAt: d.createdAt || new Date(0).toISOString(),
            type: String(d.type),
          });
        }
        setExistingDocs(all);
        setReplacedTypes(new Set());
        setProfileLoaded(true);
      } catch (e) {
        console.error("[ApplyDialog] Failed to load student profile/docs:", e);
        setProfileLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [open, isLoggedInStudent, user?.id]);

  // Pull the effective program+degree document policy from the catalog.
  // A configured empty list stays empty; a failed request is fail-closed.
  const {
    data: programReqs = [],
    isFetched: programReqsFetched,
    isLoading: programReqsLoading,
    isError: programReqsError,
  } = useProgramDocRequirements(program?.id);
  const resolveDocMeta = useResolveDocMeta();
  const docTypes: DocType[] = useMemo(() => {
    if (programReqsError) return [];
    if (program?.id && programReqsFetched) {
      return [...programReqs]
        .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
        .map(req => {
          const meta = resolveDocMeta(req.documentType);
          return {
            key: meta.key,
            label: meta.label,
            labelKey: `apply.docLabel_${meta.key}`,
            icon: meta.icon,
            accept: meta.accept,
            required: !!req.mandatory,
          } as DocType;
        });
    }
    return program?.id ? [] : getDocTypesForDegree(program?.degree);
  }, [programReqs, programReqsFetched, programReqsError, program?.id, program?.degree, resolveDocMeta]);
  const requiredDocs = docTypes.filter(d => d.required);
  const reusableForProgram: Record<string, ExistingDocInfo> = {};
  for (const dt of docTypes) {
    if (replacedTypes.has(dt.key) || docs[dt.key]) continue;
    const ex = findEquivalentDoc(dt.key, existingDocs, (a, b) =>
      new Date(a.createdAt).getTime() >= new Date(b.createdAt).getTime() ? a : b,
    );
    if (ex) reusableForProgram[dt.key] = ex;
  }
  const newUploadsCount = Object.keys(docs).length;
  const reusedCount = Object.keys(reusableForProgram).length;
  const uploadedCount = newUploadsCount + reusedCount;
  const totalCount = docTypes.length;
  const missingRequired = requiredDocs.filter(d => !docs[d.key] && !reusableForProgram[d.key]);
  const allRequiredOnFile =
    isLoggedInStudent &&
    profileLoaded &&
    requiredDocs.length > 0 &&
    missingRequired.length === 0 &&
    newUploadsCount === 0 &&
    requiredDocs.every(d => reusableForProgram[d.key]);

  const stepIndex = step === "personal" ? 0 : step === "documents" || step === "analyzing" ? 1 : step === "review" ? 2 : 2;

  function reset() {
    applicationSessionRef.current = globalThis.crypto?.randomUUID?.() || `app-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setStep("personal");
    setDocs({});
    setForm({ ...EMPTY_FORM });
    setSitInfo({ transferStudent: false, hasTcId: false, hasBlueCard: false });
    setExtracted(new Set());
    setSubmitting(false);
    setAiError(null);
    setLeadId(null);
    setCreatingLead(false);
    setEmailError(null);
    setExistingDocs([]);
    setReplacedTypes(new Set());
    setProfileLoaded(false);
    onClose();
  }

  async function handleNextPersonal() {
    if (!form.firstName || !form.lastName || !form.email || !form.phone || !form.phoneCode) {
      toast({ title: t("apply.fillAllFields"), variant: "destructive" });
      return;
    }

    if (isLoggedInStudent) {
      // If every required doc is already on file (via equivalence), skip
      // the documents step entirely and jump straight to review. The
      // existing reusableForProgram → reuseDocumentIds flow on submit
      // handles linking the existing docs to the new application.
      if (allRequiredOnFile) {
        setStep("review");
        return;
      }
      setStep("documents");
      return;
    }

    // Lead capture is BEST-EFFORT — never block the applicant from
    // advancing to Documents/Review/Submit if /public/lead fails (e.g.
    // strict name normalization, rate limit, transient network issue).
    // The final /public/apply call will create the lead row if needed,
    // and the user's primary goal is to submit the application — the
    // CRM-side lead row is a nice-to-have, not a hard prerequisite.
    setCreatingLead(true);
    try {
      const resp = await fetch(`${BASE_URL}/api/public/lead`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName: form.firstName,
          lastName: form.lastName,
          email: form.email,
          phone: `${form.phoneCode}${form.phone}`,
          interestedProgram: program?.name || null,
          interestedCountry: program?.universityCountry || null,
        }),
      });

      if (resp.ok) {
        const data = await resp.json().catch(() => ({}));
        if (data?.leadId) setLeadId(data.leadId);
      } else {
        // Log for staff visibility but do not block the user.
        try {
          const err = await resp.json();
          console.warn("[apply] lead capture failed (non-blocking):", err?.error || resp.status);
        } catch {
          console.warn("[apply] lead capture failed (non-blocking):", resp.status);
        }
      }
    } catch (e) {
      console.warn("[apply] lead capture network error (non-blocking):", e);
    } finally {
      setCreatingLead(false);
      setStep("documents");
    }
  }

  async function analyzeDocuments() {
    const uploadedDocs = Object.values(docs);
    if (uploadedDocs.length === 0) {
      toast({ title: t("apply.uploadAtLeastOne"), variant: "destructive" });
      return;
    }

    setStep("analyzing");
    setAiError(null);
    let timeout: number | undefined;

    try {
      const controller = new AbortController();
      timeout = window.setTimeout(() => controller.abort(), 60_000);
      const docPayload = uploadedDocs.map((d) => ({
        type: d.isImage ? "image" as const : "pdf" as const,
        data: d.base64,
        mediaType: d.mediaType,
        label: d.label,
      }));

      const resp = await fetch(`${BASE_URL}/api/public/ai/extract-document`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Application-Session": applicationSessionRef.current,
        },
        body: JSON.stringify({ documents: docPayload }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: "AI extraction failed" }));
        throw new Error(err.error || "AI extraction failed");
      }

      const { extracted: data, warnings: serverWarnings } = await resp.json();

      if (data.passportExpired === true) {
        setAiError(t("apply.passportExpired", { date: data.passportExpiry }));
        mergeAiData(data);
        setStep("review");
        return;
      }

      if (serverWarnings?.length) {
        setAiError(serverWarnings.join(" "));
      }

      mergeAiData(data);
      setStep("review");
    } catch (err: any) {
      setAiError(err?.name === "AbortError"
        ? "AI analysis is taking longer than expected. Please continue manually."
        : (err.message || "AI extraction failed"));
      setStep("review");
    } finally {
      if (timeout !== undefined) window.clearTimeout(timeout);
    }
  }

  function mergeAiData(data: Record<string, any>) {
    const newForm = { ...form };
    const newExtracted = new Set<string>();

    const mapping: [keyof typeof EMPTY_FORM, string][] = [
      ["motherName", "motherName"], ["fatherName", "fatherName"],
      ["nationality", "nationality"], ["dateOfBirth", "dateOfBirth"],
      ["gender", "gender"],
      ["passportNumber", "passportNumber"],
      ["passportIssueDate", "passportIssueDate"], ["passportExpiry", "passportExpiry"],
      ["address", "address"], ["highSchool", "highSchool"],
      ["graduationYear", "graduationYear"], ["gpa", "gpa"],
      ["languageScore", "languageScore"],
    ];

    for (const [fk, ek] of mapping) {
      let val = data[ek];
      if (val != null && val !== "") {
        if (fk === "nationality") {
          const countryNames = allCountries.map(c => c.name);
          val = normalizeNationality(String(val), countryNames);
        }
        if (fk === "gender") {
          const gl = String(val).trim().toLowerCase();
          if (gl === "f" || gl === "female") val = "female";
          else if (gl === "m" || gl === "male") val = "male";
          else continue;
        }
        (newForm as any)[fk] = String(val);
        newExtracted.add(fk);
        // The server normalizes any source GPA scale (4.0/5/10/20/raw)
        // into a 0-100 percent string and adds gpaScale=100. Lock the
        // grading system to /100 so the value displayed matches.
        if (fk === "gpa" && (data.gpaScale === 100 || data.gpaScale === "100")) {
          (newForm as any).gradingSystem = "100";
        }
      }
    }

    if (data.firstName && data.firstName !== "") {
      newForm.firstName = String(data.firstName);
      newExtracted.add("firstName");
    }
    if (data.lastName && data.lastName !== "") {
      newForm.lastName = String(data.lastName);
      newExtracted.add("lastName");
    }

    if (data.email && data.email !== "") {
      newForm.email = String(data.email);
      newExtracted.add("email");
    }
    if (data.phone && data.phone !== "") {
      newForm.phone = String(data.phone);
      newExtracted.add("phone");
    }

    setForm(newForm);
    setExtracted(newExtracted);
  }

  function setField<K extends keyof typeof EMPTY_FORM>(key: K, value: string) {
    setForm(f => ({ ...f, [key]: value }));
    if (extracted.has(key as string)) {
      setExtracted(prev => {
        const next = new Set(prev);
        next.delete(key as string);
        return next;
      });
    }
  }

  function handleSkipToReview() {
    if (programReqsLoading || programReqsError) {
      toast({
        title: "Document requirements could not be verified. Please retry.",
        variant: "destructive",
      });
      return;
    }
    if (missingRequired.length > 0) {
      toast({ title: t("apply.uploadRequired", { docs: missingRequired.map(d => t(d.labelKey)).join(", ") }), variant: "destructive" });
      return;
    }
    setStep("review");
  }

  async function handleSubmit() {
    setEmailError(null);

    if (programReqsLoading || programReqsError) {
      toast({
        title: "Document requirements could not be verified. Please retry.",
        variant: "destructive",
      });
      return;
    }

    if (!form.firstName || !form.lastName || !form.email || !form.phone || !form.phoneCode || !form.motherName || !form.fatherName || !form.nationality || !form.gender) {
      toast({ title: t("apply.fillRequiredFields"), variant: "destructive" });
      return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(form.email)) {
      setEmailError(t("apply.invalidEmail"));
      return;
    }

    setSubmitting(true);
    try {
      const docPayload = Object.values(docs).map(d => ({
        key: d.key,
        label: d.label,
        name: d.file.name,
        base64: d.base64,
        mediaType: d.mediaType,
        sizeBytes: d.file.size,
      }));
      const reuseDocumentIds = Object.values(reusableForProgram).map(r => r.id);
      const resp = await fetch(`${BASE_URL}/api/public/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          transferStudent: sitInfo.transferStudent,
          hasTcId: sitInfo.hasTcId,
          hasBlueCard: sitInfo.hasBlueCard,
          programId: program?.id,
          programName: program?.name,
          universityName: program?.universityName,
          programDegree: program?.degree || null,
          documents: docPayload,
          reuseDocumentIds,
          leadId,
        }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: t("apply.submissionFailed") }));
        if (resp.status === 422 && err.error === "PASSPORT_EXPIRED") {
          toast({
            title: t("studentAcademic.passportExpiredWarning"),
            variant: "destructive",
            duration: 12000,
          });
        } else if (err.code === "QUOTA_FULL") {
          toast({
            title: t("programs.quotaFull"),
            description: err.error || t("programs.quotaFullDesc"),
            variant: "destructive",
            duration: 12000,
          });
        } else if (err.code === "ELIGIBILITY_FAILED" && err.eligibilityErrors) {
          toast({
            title: "Eligibility Requirements Not Met",
            description: err.eligibilityErrors.join(". "),
            variant: "destructive",
            duration: 12000,
          });
        } else {
          toast({ title: err.error || t("apply.failedToSubmit"), variant: "destructive" });
        }
        return;
      }

      setStep("success");
    } catch {
      toast({ title: t("apply.failedToSubmit"), variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  }

  if (!program) return null;

  const hasPassportDoc =
    Object.values(docs).some(d => d.key === "passport") ||
    Object.values(reusableForProgram).some(r => r.type === "passport") ||
    existingDocs.some(d => d.type === "passport" && !replacedTypes.has("passport"));
  const hasDiplomaDoc =
    Object.values(docs).some(d => d.key === "hs_diploma" || d.key === "hs_transcript") ||
    Object.values(reusableForProgram).some(r => r.type === "hs_diploma" || r.type === "hs_transcript") ||
    existingDocs.some(d => (d.type === "hs_diploma" || d.type === "hs_transcript") && !replacedTypes.has(d.type));

  const needsReview = (key: string): boolean => {
    const val = (form as any)[key];
    if (val) return false;
    if (PASSPORT_EXTRACTED_FIELDS.has(key) && hasPassportDoc) return true;
    if (DIPLOMA_EXTRACTED_FIELDS.has(key) && hasDiplomaDoc) return true;
    return false;
  };

  const fieldClass = (key: string) =>
    `rounded-xl ${extracted.has(key) ? "border-emerald-300 bg-emerald-50/40" : needsReview(key) ? "border-amber-300 bg-amber-50/40" : ""}`;

  const labelExtras = (key: string) => (
    <>
      {extracted.has(key) && <AiBadge />}
      {!extracted.has(key) && needsReview(key) && (
        <MissingHint label={t("apply.aiCouldNotExtract")} />
      )}
    </>
  );

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) reset(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            <GraduationCap className="w-5 h-5 text-primary" />
            {t("apply.title", { name: program.name })}
          </DialogTitle>
          <p className="text-sm text-muted-foreground">{program.universityName}</p>
        </DialogHeader>

        {step !== "success" && step !== "analyzing" && (
          <StepIndicator current={stepIndex} steps={[t("apply.stepPersonal"), t("apply.stepDocuments"), t("apply.stepReview")]} />
        )}

        {step === "personal" && (
          <div className="space-y-5">
            {isLoggedInStudent && profileLoaded && (
              <div className="bg-emerald-50 dark:bg-emerald-950/30 rounded-xl p-3 border border-emerald-200 dark:border-emerald-800 flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-emerald-500" />
                <div className="space-y-1">
                  <p className="text-xs text-emerald-800 dark:text-emerald-300">
                    {t("apply.welcomeBack", { name: user?.firstName || form.firstName || "" })}
                  </p>
                  {allRequiredOnFile && (
                    <p className="text-xs font-medium text-emerald-900 dark:text-emerald-200">
                      {t("apply.docsAllOnFile")}
                    </p>
                  )}
                </div>
              </div>
            )}
            <div className="bg-primary/5 rounded-xl p-4 border border-primary/20">
              <div className="flex items-center gap-2 mb-1">
                <Users className="w-4 h-4 text-primary" />
                <h3 className="font-semibold text-sm">{t("apply.personalInfo")}</h3>
              </div>
              <p className="text-xs text-muted-foreground">
                {t("apply.personalInfoDesc")}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-sm font-semibold">
                  {t("apply.firstName")} <span className="text-destructive ml-0.5">*</span>
                </Label>
                <Input value={form.firstName} onChange={(e) => setForm(f => ({ ...f, firstName: toLatinUpper(e.target.value) }))}
                  placeholder={t("apply.firstNamePlaceholder")} className="rounded-xl uppercase" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm font-semibold">
                  {t("apply.lastName")} <span className="text-destructive ml-0.5">*</span>
                </Label>
                <Input value={form.lastName} onChange={(e) => setForm(f => ({ ...f, lastName: toLatinUpper(e.target.value) }))}
                  placeholder={t("apply.lastNamePlaceholder")} className="rounded-xl uppercase" />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-sm font-semibold">
                {t("apply.email")} <span className="text-destructive ml-0.5">*</span>
              </Label>
              <Input
                type="email"
                value={form.email}
                onChange={(e) => { if (!isLoggedInStudent) setForm(f => ({ ...f, email: e.target.value })); }}
                readOnly={isLoggedInStudent}
                placeholder={t("apply.emailPlaceholder")}
                className={`rounded-xl ${isLoggedInStudent ? "bg-muted cursor-not-allowed" : ""}`}
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-sm font-semibold">
                {t("apply.phone")} <span className="text-destructive ml-0.5">*</span>
              </Label>
              <div className="flex gap-1.5">
                <PhoneCodePicker
                  value={form.phoneCode}
                  onChange={(code) => setForm(f => ({ ...f, phoneCode: code }))}
                  className="w-[110px] shrink-0"
                />
                <Input value={form.phone} onChange={(e) => setForm(f => ({ ...f, phone: digitsOnly(e.target.value) }))}
                  inputMode="numeric" placeholder={t("apply.phonePlaceholder")} className="rounded-xl flex-1" />
              </div>
            </div>

            <div className="bg-secondary/50 rounded-xl p-3 text-sm">
              <p className="font-medium text-foreground mb-1">{t("apply.applyingFor")}</p>
              <p className="text-muted-foreground">{program.name} — {program.universityName}</p>
            </div>

            <Button onClick={handleNextPersonal} className="w-full rounded-xl gap-2" disabled={creatingLead}>
              {creatingLead && <Loader2 className="w-4 h-4 animate-spin" />}
              {t("common.next")}
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        )}

        {step === "documents" && (
          <div className="space-y-5">
            <div className="bg-primary/5 rounded-xl p-4 border border-primary/20">
              <div className="flex items-center gap-2 mb-2">
                <Sparkles className="w-4 h-4 text-primary" />
                <h3 className="font-semibold text-sm">{t("apply.aiDocAnalysis")}</h3>
              </div>
              <p className="text-xs text-muted-foreground">
                {t("apply.aiDocAnalysisDesc")}
              </p>
            </div>

            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-sm text-foreground">{t("apply.requiredDocuments")}</h3>
              <span className="text-xs text-muted-foreground">{t("apply.uploaded", { count: uploadedCount, total: totalCount })}</span>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-900/60 dark:bg-amber-950/20">
              <p className="text-[11px] text-amber-900 dark:text-amber-200">{APPLICATION_DOCUMENT_HELP_TEXT}</p>
              <Badge variant="outline" className="border-amber-500 bg-background text-[10px] font-bold text-amber-800 dark:text-amber-200">MAX 5 MB / FILE</Badge>
            </div>
            {programReqsError && (
              <div className="bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800 rounded-xl p-3 text-xs text-rose-700 dark:text-rose-300">
                Document requirements could not be verified. Please retry.
              </div>
            )}
            {isLoggedInStudent && reusedCount > 0 && (
              <div className="bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 rounded-xl p-3 text-xs text-emerald-800 dark:text-emerald-300 flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-emerald-500" />
                <span>{t("apply.docsAlreadyUploaded", { count: reusedCount })}</span>
              </div>
            )}

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {docTypes.map((dt) => {
                const reused = reusableForProgram[dt.key];
                if (reused) {
                  return (
                    <div key={dt.key} className="relative flex flex-col items-center gap-1.5 p-3 border-2 border-emerald-300 bg-emerald-50 dark:bg-emerald-950/30 rounded-2xl text-center min-h-[110px] justify-center">
                      <button
                        type="button"
                        onClick={() => setReplacedTypes(prev => { const n = new Set(prev); n.add(dt.key); return n; })}
                        className="absolute top-1.5 right-1.5 text-[10px] text-emerald-700 dark:text-emerald-300 hover:underline font-medium"
                        title={t("apply.replaceDoc")}
                      >
                        {t("apply.replace")}
                      </button>
                      <CheckCircle2 className="w-5 h-5 text-emerald-500" />
                      <p className="text-xs font-semibold text-foreground truncate max-w-[100px]">{t(dt.labelKey)}</p>
                      <span className="text-[10px] text-muted-foreground truncate max-w-[100px]" title={reused.name}>{reused.name}</span>
                      <span className="text-[10px] bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300 px-1.5 py-0.5 rounded-full font-semibold">{t("apply.alreadyOnFile")}</span>
                    </div>
                  );
                }
                return (
                  <DropZone
                    key={dt.key}
                    docType={dt}
                    uploaded={docs[dt.key]}
                    onUpload={(d) => {
                      setDocs((prev) => ({ ...prev, [dt.key]: d }));
                      setReplacedTypes(prev => { const n = new Set(prev); n.add(dt.key); return n; });
                    }}
                    onRemove={() => {
                      setDocs((prev) => { const n = { ...prev }; delete n[dt.key]; return n; });
                      if (findEquivalentDoc(dt.key, existingDocs)) {
                        setReplacedTypes(prev => { const n = new Set(prev); n.delete(dt.key); return n; });
                      }
                    }}
                    applicationSession={applicationSessionRef.current}
                  />
                );
              })}
            </div>

            {missingRequired.length > 0 && uploadedCount > 0 && (
              <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-xl p-3 text-xs text-amber-700 dark:text-amber-300">
                {t("apply.missingRequired", { docs: missingRequired.map(d => t(d.labelKey)).join(", ") })}
              </div>
            )}

            <div className="flex gap-3">
              {newUploadsCount > 0 && (
                <Button onClick={analyzeDocuments} className="flex-1 rounded-xl gap-2" disabled={missingRequired.length > 0 || programReqsLoading || programReqsError}>
                  <Sparkles className="w-4 h-4" /> {t("apply.analyzeWithAi")}
                </Button>
              )}
              <Button
                variant={newUploadsCount > 0 ? "ghost" : "default"}
                onClick={handleSkipToReview}
                className={newUploadsCount > 0 ? "rounded-xl" : "flex-1 rounded-xl gap-2"}
                disabled={missingRequired.length > 0 || programReqsLoading || programReqsError}
              >
                {newUploadsCount > 0 ? t("apply.skipFillManually") : (<>{t("apply.continueToReview")} <ChevronRight className="w-4 h-4" /></>)}
              </Button>
            </div>
          </div>
        )}

        {step === "analyzing" && (
          <div className="flex flex-col items-center py-12 gap-4">
            <div className="relative">
              <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
                <Sparkles className="w-8 h-8 text-primary animate-pulse" />
              </div>
              <Loader2 className="absolute -top-1 -right-1 w-6 h-6 text-primary animate-spin" />
            </div>
            <h3 className="font-semibold text-foreground">{t("apply.aiAnalyzing")}</h3>
            <p className="text-sm text-muted-foreground">{t("apply.aiAnalyzingDesc")}</p>
          </div>
        )}

        {step === "success" && (
          <div className="flex flex-col items-center py-8 gap-5 text-center">
            <div className="w-16 h-16 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
              <CheckCircle2 className="w-8 h-8 text-green-600 dark:text-green-400" />
            </div>
            <div>
              <h3 className="font-display font-bold text-xl text-foreground mb-2">{t("apply.appSubmitted")}</h3>
              <p className="text-muted-foreground text-sm leading-relaxed max-w-sm mx-auto">
                {t("apply.appSubmittedDesc")}
              </p>
            </div>
            <div className="bg-primary/5 border border-primary/20 rounded-xl p-4 w-full text-left">
              <p className="text-sm font-semibold text-foreground mb-2">{t("apply.whatHappensNext")}</p>
              <ul className="text-xs text-muted-foreground space-y-1.5">
                <li className="flex items-start gap-2"><span className="text-primary font-bold mt-0.5">1.</span> {t("apply.step1")}</li>
                <li className="flex items-start gap-2"><span className="text-primary font-bold mt-0.5">2.</span> {t("apply.step2")}</li>
                <li className="flex items-start gap-2"><span className="text-primary font-bold mt-0.5">3.</span> {t("apply.step3")}</li>
              </ul>
            </div>
            <div className="flex gap-3 w-full">
              <Button variant="outline" onClick={reset} className="flex-1 rounded-xl">
                {t("common.close")}
              </Button>
              <Button onClick={() => { reset(); setLocation(localePath("/login")); }} className="flex-1 rounded-xl gap-2">
                {t("apply.goToLogin")}
              </Button>
            </div>
          </div>
        )}

        {step === "review" && (
          <div className="space-y-4">
            {aiError && (
              <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-xl p-3 text-sm text-amber-700 dark:text-amber-300">
                {aiError}. {t("apply.fillManually")}
              </div>
            )}
            {extracted.size > 0 && !aiError && (
              <div className="bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 rounded-xl p-3 text-sm text-emerald-700 dark:text-emerald-300 flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                {t("apply.aiExtracted", { count: extracted.size })}
              </div>
            )}

            {(() => {
              const anyExtracted = ["motherName", "fatherName", "nationality", "dateOfBirth", "passportNumber",
                "passportIssueDate", "passportExpiry", "address", "highSchool", "graduationYear", "gpa"]
                .some(k => extracted.has(k));
              const extractedSectionTitle = anyExtracted || hasPassportDoc || hasDiplomaDoc
                ? t("apply.extractedSection")
                : t("apply.additionalInfoSection");
              const extractedSectionHint = anyExtracted || hasPassportDoc || hasDiplomaDoc
                ? t("apply.extractedHint")
                : t("apply.additionalInfoHint");

              return (
                <>
                  <div className="rounded-2xl border border-border bg-card p-4 space-y-3">
                    <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                      <Users className="w-4 h-4 text-primary" />
                      {t("apply.personalSection")}
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label className="text-sm font-semibold flex items-center">
                          {t("apply.firstName")} <span className="text-destructive ml-0.5">*</span>
                          {extracted.has("firstName") && <AiBadge />}
                        </Label>
                        <Input value={form.firstName} onChange={(e) => setField("firstName", toLatinUpper(e.target.value))}
                          placeholder={t("apply.firstNamePlaceholder")} className={fieldClass("firstName")} />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-sm font-semibold flex items-center">
                          {t("apply.lastName")} <span className="text-destructive ml-0.5">*</span>
                          {extracted.has("lastName") && <AiBadge />}
                        </Label>
                        <Input value={form.lastName} onChange={(e) => setField("lastName", toLatinUpper(e.target.value))}
                          placeholder={t("apply.lastNamePlaceholder")} className={fieldClass("lastName")} />
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <Label className="text-sm font-semibold flex items-center">
                        {t("apply.email")} <span className="text-destructive ml-0.5">*</span>
                        {extracted.has("email") && <AiBadge />}
                      </Label>
                      <Input
                        type="email"
                        value={form.email}
                        onChange={(e) => { if (isLoggedInStudent) return; setField("email", e.target.value); setEmailError(null); }}
                        readOnly={isLoggedInStudent}
                        placeholder={t("apply.emailPlaceholder")}
                        className={`rounded-xl ${isLoggedInStudent ? "bg-muted cursor-not-allowed" : ""} ${emailError ? "border-destructive" : extracted.has("email") ? "border-emerald-300 bg-emerald-50/40" : ""}`}
                      />
                      {emailError && <p className="text-xs text-destructive">{emailError}</p>}
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label className="text-sm font-semibold flex items-center">
                          {t("apply.phone")} <span className="text-destructive ml-0.5">*</span>
                          {extracted.has("phone") && <AiBadge />}
                        </Label>
                        <div className="flex gap-1.5">
                          <PhoneCodePicker
                            value={form.phoneCode}
                            onChange={(code) => setForm(f => ({ ...f, phoneCode: code }))}
                            className="w-[110px] shrink-0"
                            triggerClassName={extracted.has("phone") ? "border-emerald-300 bg-emerald-50/40" : ""}
                          />
                          <Input value={form.phone} onChange={(e) => setField("phone", digitsOnly(e.target.value))}
                            placeholder={t("apply.phonePlaceholder")} className={`rounded-xl flex-1 ${extracted.has("phone") ? "border-emerald-300 bg-emerald-50/40" : ""}`} />
                        </div>
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-sm font-semibold flex items-center">
                          {t("apply.gender")} <span className="text-destructive ml-0.5">*</span>
                          {labelExtras("gender")}
                        </Label>
                        <select
                          value={form.gender}
                          onChange={(e) => setForm(f => ({ ...f, gender: e.target.value }))}
                          className={`flex h-10 w-full rounded-xl border border-input bg-background px-3 py-2 text-sm ${extracted.has("gender") ? "border-emerald-300 bg-emerald-50/40" : needsReview("gender") ? "border-amber-300 bg-amber-50/40" : ""}`}
                        >
                          <option value="">{t("apply.selectGender")}</option>
                          <option value="female">{t("apply.genderFemale")}</option>
                          <option value="male">{t("apply.genderMale")}</option>
                        </select>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-2xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50/30 dark:bg-emerald-950/20 p-4 space-y-3">
                    <div className="flex items-start gap-2">
                      <FileText className="w-4 h-4 text-emerald-600 dark:text-emerald-400 mt-0.5 shrink-0" />
                      <div className="flex-1">
                        <div className="text-sm font-semibold text-foreground">{extractedSectionTitle}</div>
                        <div className="text-xs text-muted-foreground mt-0.5">{extractedSectionHint}</div>
                      </div>
                    </div>

                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                          <Label className="text-sm font-semibold flex items-center">
                            {t("apply.motherName")} <span className="text-destructive ml-0.5">*</span>
                            {labelExtras("motherName")}
                          </Label>
                          <Input value={form.motherName} onChange={(e) => setField("motherName", e.target.value)}
                            placeholder={t("apply.motherNamePlaceholder")} className={fieldClass("motherName")} />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-sm font-semibold flex items-center">
                            {t("apply.fatherName")} <span className="text-destructive ml-0.5">*</span>
                            {labelExtras("fatherName")}
                          </Label>
                          <Input value={form.fatherName} onChange={(e) => setField("fatherName", e.target.value)}
                            placeholder={t("apply.fatherNamePlaceholder")} className={fieldClass("fatherName")} />
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                          <Label className="text-sm font-semibold flex items-center">
                            {t("contact.nationality")} <span className="text-destructive ml-0.5">*</span>
                            {labelExtras("nationality")}
                          </Label>
                          <select value={form.nationality} onChange={(e) => setField("nationality", e.target.value)}
                            className={`w-full h-10 rounded-xl border border-input bg-background px-3 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 ${extracted.has("nationality") ? "border-emerald-300 bg-emerald-50/40" : needsReview("nationality") ? "border-amber-300 bg-amber-50/40" : ""}`}>
                            <option value="">{t("apply.selectNationality")}</option>
                            {allCountries.length > 0
                              ? allCountries.map(c => <option key={c.id} value={c.name}>{c.name}</option>)
                              : FALLBACK_COUNTRIES.map(c => <option key={c} value={c}>{c}</option>)}
                          </select>
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-sm font-semibold flex items-center">
                            {t("apply.dateOfBirth")}
                            {labelExtras("dateOfBirth")}
                          </Label>
                          <Input type="date" value={form.dateOfBirth} onChange={(e) => setField("dateOfBirth", e.target.value)}
                            className={fieldClass("dateOfBirth")} />
                        </div>
                      </div>

                      <div className="space-y-1.5">
                        <Label className="text-sm font-semibold flex items-center">
                          {t("apply.passportNumber")}
                          {labelExtras("passportNumber")}
                        </Label>
                        <Input value={form.passportNumber} onChange={(e) => setField("passportNumber", e.target.value)}
                          placeholder={t("apply.passportPlaceholder")} className={fieldClass("passportNumber")} />
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                          <Label className="text-sm font-semibold flex items-center">
                            {t("apply.passportIssueDate")}
                            {labelExtras("passportIssueDate")}
                          </Label>
                          <Input type="date" value={form.passportIssueDate} onChange={(e) => setField("passportIssueDate", e.target.value)}
                            className={fieldClass("passportIssueDate")} />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-sm font-semibold flex items-center">
                            {t("apply.passportExpiryDate")}
                            {labelExtras("passportExpiry")}
                          </Label>
                          <Input type="date" value={form.passportExpiry} onChange={(e) => setField("passportExpiry", e.target.value)}
                            className={fieldClass("passportExpiry")} />
                        </div>
                      </div>

                      <div className="space-y-1.5">
                        <Label className="text-sm font-semibold flex items-center">
                          {t("apply.address")}
                          {labelExtras("address")}
                        </Label>
                        <Input value={form.address} onChange={(e) => setField("address", e.target.value)}
                          placeholder={t("apply.addressPlaceholder")} className={fieldClass("address")} />
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                          <Label className="text-sm font-semibold flex items-center">
                            {t("apply.highSchool")}
                            {labelExtras("highSchool")}
                          </Label>
                          <Input value={form.highSchool} onChange={(e) => setField("highSchool", e.target.value)}
                            placeholder={t("apply.highSchoolPlaceholder")} className={fieldClass("highSchool")} />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-sm font-semibold flex items-center">
                            {t("apply.graduationYear")}
                            {labelExtras("graduationYear")}
                          </Label>
                          <Input value={form.graduationYear} onChange={(e) => setField("graduationYear", e.target.value)}
                            placeholder={t("apply.gradYearPlaceholder")} className={fieldClass("graduationYear")} />
                        </div>
                      </div>

                      <div className="space-y-1.5">
                        <Label className="text-sm font-semibold flex items-center">
                          {t("apply.gpa")}
                          {labelExtras("gpa")}
                        </Label>
                        <Input value={form.gpa} onChange={(e) => setField("gpa", e.target.value)}
                          placeholder={t("apply.gpaPlaceholder")} className={fieldClass("gpa")} />
                      </div>
                  </div>
                </>
              );
            })()}

            <div className="space-y-1.5">
              <Label className="text-sm font-semibold flex items-center">
                {t("apply.languageScore")}
                {labelExtras("languageScore")}
              </Label>
              <Input value={form.languageScore} onChange={(e) => setForm(f => ({ ...f, languageScore: e.target.value }))}
                placeholder={t("apply.languageScorePlaceholder")} className={fieldClass("languageScore")} />
            </div>

            <div className="space-y-1.5">
              <Label className="text-sm font-semibold">{t("apply.additionalNotes")}</Label>
              <Textarea value={form.notes} onChange={(e) => setForm(f => ({ ...f, notes: e.target.value }))}
                placeholder={t("apply.notesPlaceholder")} className="rounded-xl resize-none" rows={3} />
            </div>

            <div className="space-y-3 border rounded-xl p-4">
              <p className="text-sm font-semibold">{t("studentAcademic.studentInformation")}</p>
              {([
                ["transferStudent", t("studentAcademic.transferStudent")],
                ["hasTcId", t("studentAcademic.haveTcId")],
                ["hasBlueCard", t("studentAcademic.blueCard")],
              ] as const).map(([key, label]) => (
                <div key={key} className="flex items-center justify-between gap-3">
                  <Label className="text-sm">{label}</Label>
                  <RadioGroup
                    className="flex gap-4"
                    value={sitInfo[key] ? "yes" : "no"}
                    onValueChange={(v) => setSitInfo((s) => ({ ...s, [key]: v === "yes" }))}
                  >
                    <div className="flex items-center gap-1.5">
                      <RadioGroupItem value="yes" id={`sit-${key}-yes`} />
                      <Label htmlFor={`sit-${key}-yes`} className="text-sm font-normal">{t("studentAcademic.yes")}</Label>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <RadioGroupItem value="no" id={`sit-${key}-no`} />
                      <Label htmlFor={`sit-${key}-no`} className="text-sm font-normal">{t("studentAcademic.no")}</Label>
                    </div>
                  </RadioGroup>
                </div>
              ))}
            </div>

            <div className="bg-secondary/50 rounded-xl p-3 text-sm">
              <p className="font-medium text-foreground mb-1">{t("apply.applyingFor")}</p>
              <p className="text-muted-foreground">{program.name} — {program.universityName}</p>
            </div>

            <div className="flex gap-3">
              <Button onClick={() => setStep("documents")} variant="outline" className="rounded-xl">
                {t("common.back")}
              </Button>
              <Button onClick={handleSubmit} className="flex-1 rounded-xl gap-2" disabled={submitting}>
                {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                {submitting ? t("apply.submitting") : t("apply.submitApplication")}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ProgramDetailDialog({ open, onClose, program }: { open: boolean; onClose: () => void; program: Program | null }) {
  const { t } = useI18n();
  if (!program) return null;
  const effectiveFee = program.discountedFee ?? program.tuitionFee;
  const hasDiscount = program.discountedFee && program.tuitionFee && program.discountedFee < program.tuitionFee;
  const logoSrc = fixStorageUrl(program.universityLogoUrl);

  const detailRows: { icon: React.ReactNode; label: string; value: string }[] = [];
  if (program.degree) detailRows.push({ icon: <GraduationCap className="w-4 h-4 text-primary" />, label: t("apply.degree"), value: program.degree });
  if (program.field) detailRows.push({ icon: <Award className="w-4 h-4 text-violet-500" />, label: t("apply.field"), value: program.field });
  if (program.language) detailRows.push({ icon: <Languages className="w-4 h-4 text-blue-500" />, label: t("apply.language"), value: program.language });
  if (program.duration) detailRows.push({ icon: <Clock className="w-4 h-4 text-green-500" />, label: t("programs.duration"), value: program.duration });
  if (program.intakes) detailRows.push({ icon: <BookOpen className="w-4 h-4 text-orange-500" />, label: t("apply.intakes"), value: program.intakes });
  if (program.feeType) detailRows.push({ icon: <DollarSign className="w-4 h-4 text-emerald-500" />, label: t("apply.feeType"), value: program.feeType });
  if (program.applicationFee) detailRows.push({ icon: <DollarSign className="w-4 h-4 text-amber-500" />, label: t("apply.applicationFee"), value: formatFee(program.applicationFee, program.currency) });
  if (program.depositFee) detailRows.push({ icon: <DollarSign className="w-4 h-4 text-cyan-500" />, label: t("apply.depositFee"), value: formatFee(program.depositFee, program.currency) });
  if (program.advancedFee) detailRows.push({ icon: <DollarSign className="w-4 h-4 text-sky-500" />, label: t("apply.advancedFee"), value: formatFee(program.advancedFee, program.currency) });
  if (program.languageFee) detailRows.push({ icon: <Languages className="w-4 h-4 text-indigo-500" />, label: t("apply.languageFee"), value: formatFee(program.languageFee, program.currency) });

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center shrink-0 overflow-hidden ring-2 ring-primary/20">
              {logoSrc ? (
                <img src={logoSrc} alt={program.universityName} className="w-9 h-9 object-contain" loading="lazy"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; (e.target as HTMLImageElement).nextElementSibling?.classList.remove("hidden"); }} />
              ) : null}
              <GraduationCap className={`w-6 h-6 text-primary ${logoSrc ? "hidden" : ""}`} />
            </div>
            <div className="min-w-0">
              <DialogTitle className="text-lg leading-tight">{program.name}</DialogTitle>
              <p className="text-sm text-muted-foreground mt-0.5">{program.universityName}</p>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4 mt-2">
          <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <MapPin className="w-4 h-4 text-primary/60 shrink-0" />
            <span>{[program.universityCity, program.universityCountry].filter(Boolean).join(", ")}</span>
          </div>

          {(effectiveFee || program.scholarship) && (
            <div className="bg-gradient-to-r from-primary/5 to-emerald-500/5 rounded-xl p-4 border border-primary/10">
              {effectiveFee ? (
                <div className="flex items-baseline gap-2 mb-1">
                  <span className="text-2xl font-bold text-foreground">{formatFee(effectiveFee, program.currency)}</span>
                  {hasDiscount && (
                    <span className="text-sm line-through text-muted-foreground/50">{formatFee(program.tuitionFee, program.currency)}</span>
                  )}
                  {hasDiscount && (
                    <Badge className="bg-emerald-500 text-white text-[10px] px-1.5 py-0">
                      {t("programs.percentOff", { percent: String(Math.round(((program.tuitionFee! - program.discountedFee!) / program.tuitionFee!) * 100)) })}
                    </Badge>
                  )}
                </div>
              ) : null}
              {program.scholarship && program.scholarship > 0 ? (
                <div className="flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
                  <Award className="w-4 h-4" />
                  <span className="font-medium">{t("apply.scholarship")}: {formatFee(program.scholarship, program.currency)}</span>
                </div>
              ) : null}
            </div>
          )}

          {detailRows.length > 0 && (
            <div className="grid grid-cols-2 gap-3">
              {detailRows.map((row, idx) => (
                <div key={idx} className="flex items-center gap-2.5 bg-secondary/30 rounded-lg px-3 py-2.5">
                  {row.icon}
                  <div className="min-w-0">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">{row.label}</p>
                    <p className="text-sm font-medium text-foreground truncate">{row.value}</p>
                  </div>
                </div>
              ))}
            </div>
          )}

          {program.description && (
            <div className="space-y-1.5">
              <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">{t("common.description")}</p>
              <p className="text-sm text-foreground/80 whitespace-pre-line leading-relaxed">{program.description}</p>
            </div>
          )}

          {program.requirements && (
            <div className="space-y-1.5">
              <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">{t("programs.requirements")}</p>
              <p className="text-sm text-foreground/80 whitespace-pre-line leading-relaxed">{program.requirements}</p>
            </div>
          )}

          {program.universityDescription && (
            <div className="space-y-1.5 pt-2 border-t border-border/30">
              <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">{t("apply.universityInfo")}</p>
              <p className="text-sm text-foreground/80 leading-relaxed line-clamp-4">{program.universityDescription}</p>
            </div>
          )}

          {(program.universityRanking || program.universityQsRanking || program.universityTimesRanking) && (
            <div className="flex flex-wrap gap-2">
              {program.universityRanking && (
                <Badge variant="outline" className="text-xs gap-1"><Award className="w-3 h-3" /> {t("programs.ranking", { value: program.universityRanking })}</Badge>
              )}
              {program.universityQsRanking && (
                <Badge variant="outline" className="text-xs gap-1">{t("programs.qsRanking", { value: program.universityQsRanking })}</Badge>
              )}
              {program.universityTimesRanking && (
                <Badge variant="outline" className="text-xs gap-1">{t("programs.timesRanking", { value: program.universityTimesRanking })}</Badge>
              )}
            </div>
          )}

          {program.universityWebsite && (
            <a href={program.universityWebsite} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-primary hover:text-primary/80 font-medium transition-colors">
              <ExternalLink className="w-3.5 h-3.5" /> {t("programs.visitUniversity")}
            </a>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function Programs() {
  const { t, lang, localePath } = useI18n();
  useSeo({ title: t("seo.programsTitle"), description: t("seo.programsDesc"), lang });
  const [search, setSearch] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [country, setCountry] = useState<string[]>([]);
  const [city, setCity] = useState<string[]>([]);
  const [universityType, setUniversityType] = useState<string[]>([]);
  const [universityId, setUniversityId] = useState<string[]>([]);
  const [level, setLevel] = useState<string[]>([]);
  const [language, setLanguage] = useState<string[]>([]);
  const [field, setField] = useState<string[]>([]);
  const [feeMin, setFeeMin] = useState("");
  const [feeMax, setFeeMax] = useState("");
  const [programs, setPrograms] = useState<Program[]>([]);

  useJsonLd([
    {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      "@id": `${SITE_URL}/en/programs#webpage`,
      name: `Study Programs — ${SITE_NAME}`,
      url: `${SITE_URL}/en/programs`,
      description: "Browse thousands of undergraduate and postgraduate study programs at universities worldwide.",
      isPartOf: { "@id": `${SITE_URL}/#website` },
      breadcrumb: {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
          { "@type": "ListItem", position: 2, name: "Programs", item: `${SITE_URL}/en/programs` },
        ],
      },
    },
    ...(programs.length > 0
      ? [
          {
            "@context": "https://schema.org",
            "@type": "ItemList",
            "@id": `${SITE_URL}/en/programs#itemlist`,
            name: "Study Programs",
            url: `${SITE_URL}/en/programs`,
            numberOfItems: programs.length,
            itemListElement: programs.slice(0, 20).map((p, i) => ({
              "@type": "ListItem",
              position: i + 1,
              item: {
                "@type": "Course",
                "@id": `${SITE_URL}/en/programs?id=${p.id}`,
                name: p.name,
                description: [p.field, p.degree, p.duration].filter(Boolean).join(" · ") || undefined,
                provider: {
                  "@type": "CollegeOrUniversity",
                  name: p.universityName,
                  ...(p.universityCountry ? { address: { "@type": "PostalAddress", addressCountry: p.universityCountry } } : {}),
                },
                ...(p.language ? { inLanguage: p.language } : {}),
                ...(p.duration ? { timeRequired: p.duration } : {}),
                ...(p.tuitionFee != null
                  ? {
                      offers: {
                        "@type": "Offer",
                        price: p.discountedFee ?? p.tuitionFee,
                        priceCurrency: p.currency || "USD",
                      },
                    }
                  : {}),
              },
            })),
          },
        ]
      : []),
  ]);

  const [isLoading, setIsLoading] = useState(true);
  const [filters, setFilters] = useState<Filters>({ countries: [], cities: [], universityTypes: [], universities: [], degrees: [], languages: [], fields: [], feeRange: null });
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [applyProgram, setApplyProgram] = useState<Program | null>(null);
  const [detailProgram, setDetailProgram] = useState<Program | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const debouncedFeeMin = useDebounce(feeMin, 500);
  const debouncedFeeMax = useDebounce(feeMax, 500);

  // Cascading facets — re-fetch /filters whenever a selection changes so each
  // dropdown reflects only options compatible with the user's other choices
  // (e.g. picking Country=Turkey narrows the City and University lists).
  const filterParams = useMemo(() => {
    const p = new URLSearchParams();
    p.set("scope", "public");
    if (debouncedSearch) p.set("search", debouncedSearch);
    if (country.length) p.set("country", country.join(","));
    if (city.length) p.set("city", city.join(","));
    if (universityType.length) p.set("universityType", universityType.join(","));
    if (universityId.length) p.set("universityId", universityId.join(","));
    if (level.length) p.set("level", level.join(","));
    if (language.length) p.set("language", language.join(","));
    if (field.length) p.set("field", field.join(","));
    if (debouncedFeeMin) p.set("feeMin", debouncedFeeMin);
    if (debouncedFeeMax) p.set("feeMax", debouncedFeeMax);
    return p.toString();
  }, [debouncedSearch, country, city, universityType, universityId, level, language, field, debouncedFeeMin, debouncedFeeMax]);

  useEffect(() => {
    customFetch<Filters>(`/api/course-finder/filters${filterParams ? `?${filterParams}` : ""}`, { method: "GET" })
      .then(data => setFilters(data))
      .catch(() => {});
  }, [filterParams]);

  // Auto-prune selections that the new option list no longer contains, so a
  // stale pick (e.g. City=Istanbul after switching Country to Germany) does
  // not silently filter all results to zero. We must NOT short-circuit on
  // empty option arrays — that's exactly when stale selections are most
  // dangerous. `feeRange` is null only in the pre-fetch initial state, so
  // we use it as a loaded-flag instead.
  useEffect(() => {
    if (filters.feeRange === null) return;
    const validCity = new Set(filters.cities);
    const validType = new Set(filters.universityTypes);
    const validUni = new Set(filters.universities.map(u => String(u.id)));
    const validLevel = new Set(filters.degrees.map(d => d.toLowerCase()));
    const validLang = new Set(filters.languages.map(l => l.toLowerCase()));
    const validField = new Set(filters.fields.map(f => f.toLowerCase()));
    const validCountry = new Set(filters.countries);
    setCountry(prev => { const n = prev.filter(v => validCountry.has(v)); return n.length === prev.length ? prev : n; });
    setCity(prev => { const n = prev.filter(v => validCity.has(v)); return n.length === prev.length ? prev : n; });
    setUniversityType(prev => { const n = prev.filter(v => validType.has(v)); return n.length === prev.length ? prev : n; });
    setUniversityId(prev => { const n = prev.filter(v => validUni.has(v)); return n.length === prev.length ? prev : n; });
    setLevel(prev => { const n = prev.filter(v => validLevel.has(v.toLowerCase())); return n.length === prev.length ? prev : n; });
    setLanguage(prev => { const n = prev.filter(v => validLang.has(v.toLowerCase())); return n.length === prev.length ? prev : n; });
    setField(prev => { const n = prev.filter(v => validField.has(v.toLowerCase())); return n.length === prev.length ? prev : n; });
  }, [filters]);

  const fetchPrograms = useCallback(async () => {
    setIsLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: "24" });
      params.set("scope", "public");
      params.set("locale", lang);
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (country.length) params.set("country", country.join(","));
      if (city.length) params.set("city", city.join(","));
      if (universityType.length) params.set("universityType", universityType.join(","));
      if (universityId.length) params.set("universityId", universityId.join(","));
      if (level.length) params.set("level", level.join(","));
      if (language.length) params.set("language", language.join(","));
      if (field.length) params.set("field", field.join(","));
      if (debouncedFeeMin) params.set("feeMin", debouncedFeeMin);
      if (debouncedFeeMax) params.set("feeMax", debouncedFeeMax);

      const resp = await customFetch<{ data: Program[]; meta: { total: number; page: number; totalPages: number } }>(
        `/api/course-finder?${params.toString()}`,
        { method: "GET" }
      );
      setPrograms(resp.data || []);
      setTotal(resp.meta?.total || 0);
      setTotalPages(resp.meta?.totalPages || 1);
    } catch {
      setPrograms([]);
    } finally {
      setIsLoading(false);
    }
  }, [page, debouncedSearch, country, city, universityType, universityId, level, language, field, debouncedFeeMin, debouncedFeeMax, lang]);

  useEffect(() => { fetchPrograms(); }, [fetchPrograms]);
  useEffect(() => { setPage(1); }, [debouncedSearch, country, city, universityType, universityId, level, language, field, debouncedFeeMin, debouncedFeeMax]);

  const filteredCities = filters.cities;

  const hasActiveFilters = country.length || city.length || universityType.length || universityId.length || level.length || language.length || field.length || feeMin || feeMax;

  function clearAllFilters() {
    setCountry([]);
    setCity([]);
    setUniversityType([]);
    setUniversityId([]);
    setLevel([]);
    setLanguage([]);
    setField([]);
    setFeeMin("");
    setFeeMax("");
    setSearch("");
  }

  const activeFilterCount = [country.length, city.length, universityType.length, universityId.length, level.length, language.length, field.length, feeMin, feeMax].filter(Boolean).length;

  const pageNumbers = (() => {
    const pages: (number | "...")[] = [];
    if (totalPages <= 7) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
      pages.push(1);
      if (page > 3) pages.push("...");
      for (let i = Math.max(2, page - 1); i <= Math.min(totalPages - 1, page + 1); i++) pages.push(i);
      if (page < totalPages - 2) pages.push("...");
      pages.push(totalPages);
    }
    return pages;
  })();

  return (
    <>
      <section className="pt-24 pb-6 bg-gradient-to-br from-primary/5 via-accent/5 to-primary/5 relative">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-primary/[0.07] via-transparent to-transparent" />
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6 }}>
            <div className="text-center mb-10">
              <span className="inline-flex items-center gap-2 bg-primary/10 text-primary text-sm font-semibold px-4 py-2 rounded-full mb-6 border border-primary/20">
                <GraduationCap className="w-4 h-4" /> {t("programs.badge")}
              </span>
              <h1 className="text-4xl md:text-5xl font-display font-bold text-foreground mb-4">
                {t("programs.title")} <span className="text-primary">{t("programs.titleHighlight")}</span>
              </h1>
              <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
                {t("programs.subtitle")}
              </p>
            </div>
          </motion.div>

          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, delay: 0.15 }}>
            <div className="glass-card rounded-2xl p-6 pb-6 -mb-8 relative z-20 shadow-lg shadow-primary/[0.03]">
              <div className="flex flex-col sm:flex-row gap-3">
                <div className="relative flex-1">
                  <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-primary/60" />
                  <Input
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder={t("programs.searchPlaceholder")}
                    aria-label={t("programs.searchPlaceholder")}
                    className="pl-12 pr-4 h-12 text-base rounded-xl border-border/50 focus:border-primary bg-background/80 backdrop-blur-sm shadow-sm w-full" />
                </div>
                <button
                  type="button"
                  onClick={() => setShowFilters(prev => !prev)}
                  aria-expanded={showFilters}
                  aria-controls="programs-filter-panel"
                  aria-label={showFilters ? t("programs.lessFilters") : t("programs.moreFilters")}
                  className={`inline-flex items-center gap-2 h-12 px-5 rounded-xl text-sm font-semibold transition-all duration-200 border shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2
                    ${showFilters
                      ? "bg-primary text-primary-foreground border-primary shadow-md shadow-primary/20 hover:bg-primary/90"
                      : "bg-background/80 text-foreground border-border/50 hover:border-primary/40 hover:bg-primary/5 shadow-sm"
                    }`}
                >
                  <SlidersHorizontal className="w-4 h-4" />
                  <span className="hidden sm:inline">{showFilters ? t("programs.lessFilters") : t("programs.moreFilters")}</span>
                  {activeFilterCount > 0 && (
                    <span className={`inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-xs font-bold
                      ${showFilters ? "bg-white/25 text-primary-foreground" : "bg-primary text-primary-foreground"}`}>
                      {activeFilterCount}
                    </span>
                  )}
                  {showFilters ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                </button>
              </div>

              <AnimatePresence initial={false}>
                {showFilters && (
                  <motion.div
                    key="filter-panel"
                    initial={{ opacity: 0, height: 0, overflow: "hidden" }}
                    animate={{ opacity: 1, height: "auto", overflow: "visible" }}
                    exit={{ opacity: 0, height: 0, overflow: "hidden" }}
                    transition={{ duration: 0.25, ease: "easeInOut" }}
                  >
                    <div id="programs-filter-panel" className="pt-5 space-y-4">
                      <div className="h-px bg-gradient-to-r from-transparent via-border/60 to-transparent" />

                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-3">
                        <div className="space-y-1.5">
                          <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                            <Globe2 className="w-3 h-3" /> {t("programs.filterCountry")}
                          </label>
                          <MultiSelectFilter
                            values={country}
                            onChange={setCountry}
                            options={filters.countries.map(c => ({ value: c, label: c }))}
                            placeholder={t("programs.allCountries")}
                          />
                        </div>

                        <div className="space-y-1.5">
                          <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                            <MapPin className="w-3 h-3" /> {t("programs.filterCity")}
                          </label>
                          <MultiSelectFilter
                            values={city}
                            onChange={setCity}
                            options={filteredCities.map(c => ({ value: c, label: c }))}
                            placeholder={t("programs.allCities")}
                          />
                        </div>

                        <div className="space-y-1.5">
                          <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                            <Building2 className="w-3 h-3" /> {t("programs.filterUniversityType")}
                          </label>
                          <MultiSelectFilter
                            values={universityType}
                            onChange={setUniversityType}
                            options={filters.universityTypes.map(ut => ({ value: ut, label: ut }))}
                            placeholder={t("programs.allTypes")}
                          />
                        </div>

                        <div className="space-y-1.5">
                          <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                            <GraduationCap className="w-3 h-3" /> {t("programs.filterUniversity")}
                          </label>
                          <MultiSelectFilter
                            values={universityId}
                            onChange={setUniversityId}
                            options={filters.universities.map(u => ({ value: String(u.id), label: u.name }))}
                            placeholder={t("programs.allUniversities")}
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-3">
                        <div className="space-y-1.5">
                          <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                            <BookOpen className="w-3 h-3" /> {t("programs.filterLevel")}
                          </label>
                          <MultiSelectFilter
                            values={level}
                            onChange={setLevel}
                            options={filters.degrees.map(d => ({ value: d, label: d }))}
                            placeholder={t("programs.allLevels")}
                          />
                        </div>

                        <div className="space-y-1.5">
                          <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                            <Languages className="w-3 h-3" /> {t("programs.filterLanguage")}
                          </label>
                          <MultiSelectFilter
                            values={language}
                            onChange={setLanguage}
                            options={filters.languages.map(lg => ({ value: lg, label: lg }))}
                            placeholder={t("programs.allLanguages")}
                          />
                        </div>

                        <div className="space-y-1.5">
                          <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                            <Award className="w-3 h-3" /> {t("programs.filterField")}
                          </label>
                          <MultiSelectFilter
                            values={field}
                            onChange={setField}
                            options={filters.fields.map(f => ({ value: f, label: f }))}
                            placeholder={t("programs.allFields")}
                          />
                        </div>

                        <div className="space-y-1.5">
                          <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                            <DollarSign className="w-3 h-3" /> {t("programs.filterTuitionFee")}
                          </label>
                          <div className="flex items-center gap-2">
                            <Input type="number" value={feeMin} onChange={e => setFeeMin(e.target.value)}
                              placeholder={filters.feeRange?.min != null ? t("programs.feeMinValue", { value: String(filters.feeRange.min) }) : t("programs.feeMin")}
                              aria-label={t("programs.feeMin")}
                              className="h-10 rounded-xl border-border/50 bg-background/80 text-sm flex-1 hover:border-primary/40 transition-all" min="0"
                              max={filters.feeRange?.max} />
                            <span className="text-muted-foreground text-sm font-medium" aria-hidden="true">–</span>
                            <Input type="number" value={feeMax} onChange={e => setFeeMax(e.target.value)}
                              placeholder={filters.feeRange?.max != null ? t("programs.feeMaxValue", { value: String(filters.feeRange.max) }) : t("programs.feeMax")}
                              aria-label={t("programs.feeMax")}
                              className="h-10 rounded-xl border-border/50 bg-background/80 text-sm flex-1 hover:border-primary/40 transition-all" min="0"
                              max={filters.feeRange?.max} />
                          </div>
                        </div>
                      </div>

                      {hasActiveFilters && (
                        <div className="flex items-center justify-between pt-3 mt-1 border-t border-border/30">
                          <div className="flex items-center gap-2">
                            <SlidersHorizontal className="w-4 h-4 text-primary" />
                            <p className="text-sm text-muted-foreground">
                              {t("programs.showingResults", { count: String(total) })}
                            </p>
                          </div>
                          <button type="button" onClick={clearAllFilters} className="inline-flex items-center gap-1.5 text-sm text-destructive/80 hover:text-destructive font-semibold transition-colors bg-destructive/5 hover:bg-destructive/10 px-3 py-1.5 rounded-lg">
                            <X className="w-3.5 h-3.5" aria-hidden="true" /> {t("programs.clearFilters")}
                          </button>
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        </div>
      </section>

      <section className="pt-2 pb-16">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.3 }}
            className="flex items-center justify-between mb-8 bg-card/60 backdrop-blur-sm rounded-2xl px-6 py-4 border border-border/30 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                <BookOpen className="w-4 h-4 text-primary" />
              </div>
              <p className="text-muted-foreground">
                {t("programs.showingResults", { count: String(total) })}
              </p>
            </div>
          </motion.div>

          {isLoading ? (
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
              {[...Array(6)].map((_, i) => (
                <div key={i} className="rounded-2xl overflow-hidden border border-border/30 bg-card">
                  <div className="h-20 bg-gradient-to-r from-secondary via-secondary/50 to-secondary animate-pulse relative overflow-hidden">
                    <div className="absolute inset-0 -translate-x-full animate-[shimmer_2s_infinite] bg-gradient-to-r from-transparent via-white/30 to-transparent" />
                  </div>
                  <div className="p-5 space-y-3">
                    <div className="h-5 bg-secondary rounded-lg w-4/5 animate-pulse" />
                    <div className="h-4 bg-secondary rounded-lg w-3/5 animate-pulse" />
                    <div className="grid grid-cols-2 gap-2 mt-4">
                      <div className="h-4 bg-secondary rounded-lg animate-pulse" />
                      <div className="h-4 bg-secondary rounded-lg animate-pulse" />
                    </div>
                    <div className="h-10 bg-secondary rounded-xl mt-4 animate-pulse" />
                  </div>
                </div>
              ))}
            </div>
          ) : programs.length === 0 ? (
            <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}
              className="text-center py-24 bg-gradient-to-br from-primary/[0.03] via-accent/[0.03] to-primary/[0.03] rounded-3xl border border-border/30">
              <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-6">
                <Globe2 className="w-10 h-10 text-primary/40" />
              </div>
              <h3 className="text-xl font-bold font-display text-foreground mb-2">{t("programs.noResults")}</h3>
              <p className="text-muted-foreground mb-6">{t("programs.noResultsDesc")}</p>
              <Button variant="outline" onClick={clearAllFilters} className="rounded-full px-6">
                <X className="w-4 h-4 mr-2" /> {t("programs.clearFilters")}
              </Button>
            </motion.div>
          ) : (
            <>
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
                {programs.map((prog, i) => {
                  const effectiveFee = prog.discountedFee ?? prog.tuitionFee;
                  const hasDiscount = prog.discountedFee && prog.tuitionFee && prog.discountedFee < prog.tuitionFee;
                  const logoSrc = fixStorageUrl(prog.universityLogoUrl);
                  const cardGradients = [
                    "from-blue-500/15 via-indigo-500/10 to-violet-500/5",
                    "from-emerald-500/15 via-teal-500/10 to-cyan-500/5",
                    "from-rose-500/15 via-pink-500/10 to-fuchsia-500/5",
                    "from-amber-500/15 via-orange-500/10 to-yellow-500/5",
                    "from-violet-500/15 via-purple-500/10 to-indigo-500/5",
                    "from-cyan-500/15 via-sky-500/10 to-blue-500/5",
                  ];
                  const gradient = cardGradients[i % cardGradients.length];

                  return (
                    <motion.div key={prog.id} initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: i * 0.04, duration: 0.4 }}
                      className="group bg-card rounded-2xl overflow-hidden shadow-md shadow-black/[0.04] hover:-translate-y-1.5 hover:shadow-xl hover:shadow-primary/[0.08] transition-all duration-300 border border-border/40 hover:border-primary/20 flex flex-col">

                      {/* Banner (white) */}
                      <div className="flex items-center gap-3 px-4 py-3 border-b border-border/50 bg-card">
                        {/* Logo */}
                        {prog.universityWebsite ? (
                          <a href={prog.universityWebsite} target="_blank" rel="noopener noreferrer"
                            className="w-10 h-10 rounded-xl border border-border/60 bg-background flex items-center justify-center shrink-0 overflow-hidden hover:border-primary/40 hover:scale-105 transition-all cursor-pointer"
                            onClick={(e) => e.stopPropagation()}>
                            {logoSrc ? (
                              <img src={logoSrc} alt={prog.universityName} className="w-full h-full object-contain p-0.5" loading="lazy"
                                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; (e.target as HTMLImageElement).nextElementSibling?.classList.remove("hidden"); }}
                              />
                            ) : null}
                            <Building2 className={`w-5 h-5 text-muted-foreground ${logoSrc ? "hidden" : ""}`} />
                          </a>
                        ) : (
                          <div className="w-10 h-10 rounded-xl border border-border/60 bg-background flex items-center justify-center shrink-0 overflow-hidden">
                            {logoSrc ? (
                              <img src={logoSrc} alt={prog.universityName} className="w-full h-full object-contain p-0.5" loading="lazy"
                                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; (e.target as HTMLImageElement).nextElementSibling?.classList.remove("hidden"); }}
                              />
                            ) : null}
                            <Building2 className={`w-5 h-5 text-muted-foreground ${logoSrc ? "hidden" : ""}`} />
                          </div>
                        )}
                        {/* University name + location */}
                        <div className="min-w-0 flex-1">
                          <p className="text-[12px] font-bold text-foreground/80 truncate leading-tight">{prog.universityName}</p>
                          {(prog.universityCity || prog.universityCountry) && (
                            <div className="flex items-center gap-1 text-[10px] text-muted-foreground mt-0.5">
                              <MapPin className="w-3 h-3 shrink-0 text-primary/60" />
                              <span className="truncate">{[prog.universityCity, prog.universityCountry].filter(Boolean).join(", ")}</span>
                            </div>
                          )}
                        </div>
                        {/* Type + Degree badges */}
                        <div className="flex flex-col items-end gap-1 shrink-0">
                          {prog.universityType && (
                            <Badge variant="outline" className="text-[10px] px-2 py-0 h-[18px] font-medium">{prog.universityType}</Badge>
                          )}
                          {prog.degree && (
                            <Badge className="text-[10px] px-2 py-0 h-[18px] bg-primary text-primary-foreground font-medium">{prog.degree}</Badge>
                          )}
                        </div>
                      </div>

                      {/* Card body */}
                      <div className="p-4 flex-1 flex flex-col gap-3">
                        {/* Program name */}
                        <h3 className="font-bold text-foreground text-[15px] leading-snug line-clamp-2 group-hover:text-primary transition-colors duration-200">
                          {prog.name}
                        </h3>

                        {/* Fee + Scholarship */}
                        {effectiveFee != null && (
                          <div className="flex items-start gap-3">
                            <div className="min-w-0 flex-1">
                              <p className="text-[10px] text-muted-foreground mb-1.5">
                                {t("courseFinderPage.tuitionFee")}{(prog as any).feeType ? ` (${(prog as any).feeType})` : ""}
                              </p>
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-[22px] font-extrabold leading-none tracking-tight">
                                  {formatFee(effectiveFee, prog.currency)}
                                </span>
                                {hasDiscount && (
                                  <span className="text-sm text-muted-foreground/50 line-through leading-none">{formatFee(prog.tuitionFee, prog.currency)}</span>
                                )}
                                {hasDiscount && (
                                  <Badge className="bg-emerald-500 text-white text-[10px] font-bold rounded-full border-0 px-2 py-0 h-[18px]">
                                    {Math.round(((prog.tuitionFee! - prog.discountedFee!) / prog.tuitionFee!) * 100)}% OFF
                                  </Badge>
                                )}
                              </div>
                            </div>
                            {prog.scholarship != null && prog.scholarship > 0 && (
                              <div className="shrink-0 border border-emerald-200 dark:border-emerald-800/50 bg-emerald-50 dark:bg-emerald-950/30 rounded-xl px-3 py-2 text-center min-w-[76px]">
                                <Award className="w-4 h-4 text-emerald-600 dark:text-emerald-400 mx-auto" />
                                <p className="text-[9px] text-muted-foreground font-medium mt-0.5">{t("courseFinderPage.scholarship")}:</p>
                                <p className="text-[13px] font-extrabold text-emerald-700 dark:text-emerald-400 leading-tight">{formatFee(prog.scholarship, prog.currency)}</p>
                              </div>
                            )}
                          </div>
                        )}

                        {/* Deposit strip */}
                        {prog.depositFee != null && prog.depositFee > 0 && (
                          <div className="flex items-center gap-2 bg-indigo-50 dark:bg-indigo-950/30 border border-indigo-200/60 dark:border-indigo-700/30 rounded-lg px-3 py-2 text-[11px] text-indigo-700 dark:text-indigo-400 font-medium">
                            <Shield className="w-3.5 h-3.5 shrink-0" />
                            {t("courseFinderPage.depositStrip", { fee: formatFee(prog.depositFee, prog.currency) })}
                          </div>
                        )}

                        {/* Metadata 3-col grid */}
                        <div className="grid grid-cols-3 gap-2 bg-muted/40 rounded-xl p-3">
                          {prog.degree && (
                            <div className="flex flex-col gap-0.5 min-w-0">
                              <span className="flex items-center gap-1 text-[9px] text-muted-foreground font-medium">
                                <GraduationCap className="w-3 h-3 text-violet-500 shrink-0" />{t("courseFinderPage.degree")}
                              </span>
                              <span className="text-[11px] font-bold truncate">{prog.degree}</span>
                            </div>
                          )}
                          {prog.field && (
                            <div className="flex flex-col gap-0.5 min-w-0">
                              <span className="flex items-center gap-1 text-[9px] text-muted-foreground font-medium">
                                <BookOpen className="w-3 h-3 text-orange-500 shrink-0" />{t("courseFinderPage.field")}
                              </span>
                              <span className="text-[11px] font-bold truncate">{prog.field}</span>
                            </div>
                          )}
                          {prog.language && (
                            <div className="flex flex-col gap-0.5 min-w-0">
                              <span className="flex items-center gap-1 text-[9px] text-muted-foreground font-medium">
                                <Languages className="w-3 h-3 text-blue-500 shrink-0" />{t("courseFinderPage.language")}
                              </span>
                              <span className="text-[11px] font-bold truncate">{prog.language}</span>
                            </div>
                          )}
                          {prog.duration && (
                            <div className="flex flex-col gap-0.5 min-w-0">
                              <span className="flex items-center gap-1 text-[9px] text-muted-foreground font-medium">
                                <Clock className="w-3 h-3 text-green-500 shrink-0" />{t("courseFinderPage.duration")}
                              </span>
                              <span className="text-[11px] font-bold truncate">{prog.duration}</span>
                            </div>
                          )}
                          {prog.intakes && (
                            <div className="flex flex-col gap-0.5 min-w-0">
                              <span className="flex items-center gap-1 text-[9px] text-muted-foreground font-medium">
                                <Calendar className="w-3 h-3 text-indigo-500 shrink-0" />{t("courseFinderPage.intakes")}
                              </span>
                              <span className="text-[11px] font-bold truncate">{prog.intakes}</span>
                            </div>
                          )}
                          {prog.languageFee != null && prog.languageFee > 0 && (
                            <div className="flex flex-col gap-0.5 min-w-0">
                              <span className="flex items-center gap-1 text-[9px] text-muted-foreground font-medium">
                                <Globe2 className="w-3 h-3 text-pink-500 shrink-0" />{t("courseFinderPage.languageFee")}
                              </span>
                              <span className="text-[11px] font-bold truncate">{formatFee(prog.languageFee, prog.currency)}</span>
                            </div>
                          )}
                        </div>

                        {/* Bottom actions */}
                        <div className="mt-auto flex items-center gap-2 pt-1">
                          <button
                            onClick={() => setDetailProgram(prog)}
                            className="w-9 h-9 rounded-full border-2 border-border/60 flex items-center justify-center text-muted-foreground hover:border-primary/40 hover:text-primary hover:bg-primary/5 transition-all shrink-0"
                            aria-label={t("programs.programDetails")}
                          >
                            <Info className="w-4 h-4" aria-hidden="true" />
                          </button>
                          <Button onClick={() => setApplyProgram(prog)} className="flex-1 rounded-xl font-bold shadow-md shadow-primary/10 hover:shadow-lg hover:shadow-primary/20 transition-all duration-300">
                            {t("courseFinderPage.apply")} →
                          </Button>
                        </div>
                      </div>
                    </motion.div>
                  );
                })}
              </div>

              {totalPages > 1 && (
                <div className="flex items-center justify-center gap-1.5 mt-12">
                  <Button variant="outline" size="icon" disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="rounded-full w-10 h-10" aria-label={t("programs.prevPage")}>
                    <ChevronLeft className="w-4 h-4" aria-hidden="true" />
                  </Button>
                  {pageNumbers.map((p, idx) => (
                    p === "..." ? (
                      <span key={`dots-${idx}`} className="px-2 text-muted-foreground" aria-hidden="true">...</span>
                    ) : (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setPage(p as number)}
                        aria-label={t("programs.goToPage", { page: String(p) })}
                        aria-current={page === p ? "page" : undefined}
                        className={`w-10 h-10 rounded-full text-sm font-semibold transition-all duration-200 ${
                          page === p
                            ? "bg-primary text-primary-foreground shadow-md shadow-primary/25"
                            : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                        }`}>
                        {p}
                      </button>
                    )
                  ))}
                  <Button variant="outline" size="icon" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)} className="rounded-full w-10 h-10" aria-label={t("programs.nextPage")}>
                    <ChevronRight className="w-4 h-4" aria-hidden="true" />
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </section>

      <section className="py-16 bg-gradient-to-r from-primary to-accent text-white mx-4 sm:mx-8 rounded-3xl mb-12 overflow-hidden relative">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_bottom_left,_rgba(255,255,255,0.1),transparent_60%)]" />
        <div className="max-w-3xl mx-auto px-8 text-center relative z-10">
          <h2 className="text-3xl font-display font-bold mb-4">{t("programs.cantFind")}</h2>
          <p className="text-white/80 mb-8">{t("programs.cantFindDesc")}</p>
          <Button asChild size="lg" variant="secondary" className="rounded-full px-8 text-primary font-bold shadow-xl shadow-black/10 hover:-translate-y-1 transition-all duration-300">
            <Link href={localePath("/contact")}>{t("programs.talkToAdvisor")}</Link>
          </Button>
        </div>
      </section>

      <ApplyDialog open={!!applyProgram} onClose={() => setApplyProgram(null)} program={applyProgram} countries={filters.countries} />
      <ProgramDetailDialog open={!!detailProgram} onClose={() => setDetailProgram(null)} program={detailProgram} />
    </>
  );
}
