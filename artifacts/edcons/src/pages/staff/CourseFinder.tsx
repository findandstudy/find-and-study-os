import { lazy, Suspense, useState, useMemo, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useProgramDocRequirements, useResolveDocMeta } from "@/lib/programDocTypes";
import { findMissingMandatoryTypes } from "@workspace/doc-equivalence";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MultiSelectFilter } from "@/components/ui/multi-select-filter";
import { ColumnHeader } from "@/components/ui/column-header";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useDebouncedValue } from "@/hooks/use-countries";
import { Textarea } from "@/components/ui/textarea";
import {
  Search, Heart, Send, Info, GraduationCap, Globe, Clock,
  Languages, DollarSign, BookOpen, Building2, MapPin,
  ChevronLeft, ChevronRight, X, FileText, ExternalLink,
  Mail, Phone, User, Award, Calendar, Check, Loader2, UserSearch,
  Download, CheckSquare, Square, FileDown, LayoutGrid, List, ArrowUpDown,
  ArrowUp, ArrowDown, CheckCircle2, AlertCircle, Upload, UserPlus, Shield,
  Camera,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  collectProposalStudyLevels,
  loadProposalDocumentRequirements,
} from "@/lib/proposalDocumentRequirements";
import { resolveProposalBranding } from "@/lib/proposalBranding";
import { createDocumentRecord, uploadDocumentFile } from "@/lib/uploadDocumentFile";
import { applicationCreationErrorMessage } from "@/lib/applicationCreationError";
import { useI18n } from "@/hooks/use-i18n";
import {
  APPLICATION_DOCUMENT_HELP_TEXT,
  validateApplicationDocumentFileObj,
} from "@/lib/fileUploadValidation";
import { MAX_DOCUMENT_PARTS, isSingleImageDocumentType, mergeDocumentParts } from "@/lib/documentPartMerge";

const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";
const TRANSIENT_API_STATUSES = new Set([502, 503, 504]);
const COURSE_FINDER_VIEW_STORAGE_KEY = "course-finder-view-mode";

const LazyPdfMarkupModal = lazy(() =>
  import("@/components/course-finder/PdfMarkupModal").then((module) => ({
    default: module.PdfMarkupModal,
  })),
);

const LazyDocumentScanner = lazy(() =>
  import("@/components/DocumentScanner").then((module) => ({
    default: module.DocumentScanner,
  })),
);

class CourseFinderApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly transient: boolean,
  ) {
    super(message);
    this.name = "CourseFinderApiError";
  }
}

function isTransientCourseFinderError(error: unknown): boolean {
  return error instanceof CourseFinderApiError && error.transient;
}

function retryDelay(attempt: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 400 * (2 ** attempt)));
}

function getCsrfToken(): string {
  const m = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]*)/);
  return m ? decodeURIComponent(m[1]) : "";
}

async function apiFetch(url: string, opts?: RequestInit) {
  const headers = new Headers(opts?.headers);
  const method = (opts?.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    headers.set("x-csrf-token", getCsrfToken());
  }

  const attempts = method === "GET" || method === "HEAD" ? 4 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let res: Response;
    try {
      res = await fetch(url, { ...opts, credentials: "include", headers });
    } catch (error) {
      if (
        opts?.signal?.aborted ||
        (error instanceof DOMException && error.name === "AbortError")
      ) {
        throw error;
      }
      if (attempt < attempts - 1) {
        await retryDelay(attempt);
        continue;
      }
      throw new CourseFinderApiError(
        error instanceof Error ? error.message : "Network request failed",
        null,
        true,
      );
    }

    const transient = TRANSIENT_API_STATUSES.has(res.status);
    if (transient && attempt < attempts - 1) {
      await retryDelay(attempt);
      continue;
    }
    if (!res.ok) {
      const contentType = res.headers.get("content-type") || "";
      const text = await res.text().catch(() => "");
      // Nginx sends a full HTML error document for upstream failures. Never
      // expose that implementation detail in a user-facing toast.
      const safeMessage = !/text\/html/i.test(contentType) && !/^\s*<!?html/i.test(text)
        ? text.slice(0, 500)
        : "";
      throw new CourseFinderApiError(safeMessage || `API ${res.status}`, res.status, transient);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  throw new CourseFinderApiError("Network request failed", null, true);
}

type Program = {
  id: number;
  name: string;
  description?: string | null;
  degree?: string | null;
  field?: string | null;
  language?: string | null;
  duration?: string | null;
  tuitionFee?: number | null;
  currency?: string | null;
  scholarship?: number | null;
  intakes?: string | null;
  requirements?: string | null;
  commissionRate?: number | null;
  applicationFee?: number | null;
  advancedFee?: number | null;
  depositFee?: number | null;
  serviceFeeAmount?: number | null;
  discountedFee?: number | null;
  languageFee?: number | null;
  feeType?: string | null;
  isActive?: boolean;
  universityId: number;
  universityName: string;
  universityLogoUrl?: string | null;
  universityCountry?: string | null;
  universityCity?: string | null;
  universityStatus?: string | null;
  universityType?: string | null;
  universityWebsite?: string | null;
  universityDescription?: string | null;
  universityQsRanking?: number | null;
  universityTimesRanking?: number | null;
  universityShanghaiRanking?: number | null;
  universityCwtsLeidenRanking?: number | null;
  universityAddress?: string | null;
  universityTaxType?: string | null;
  universityContactName?: string | null;
  universityContactPhone?: string | null;
  universityContactEmail?: string | null;
};

type FilterOptions = {
  countries: string[];
  cities: string[];
  universityTypes: string[];
  universities: { id: number; name: string }[];
  degrees: string[];
  languages: string[];
  fields: string[];
  feeRange: { min: number; max: number };
};

type Filters = {
  country: string[];
  city: string[];
  universityType: string[];
  universityId: string[];
  level: string[];
  language: string[];
  field: string[];
  search: string;
  feeMin: string;
  feeMax: string;
};

type CourseFinderPage = {
  data: Program[];
  meta: { total: number; page: number; limit: number; totalPages: number };
};

type PdfSettings = {
  companyName?: string;
  publicBrandName?: string;
  companyEmail?: string;
  supportEmail?: string;
  salesEmail?: string;
  companyPhone?: string;
  whatsappNumber?: string;
  companyWebsite?: string;
  canonicalBaseUrl?: string;
  logoUrl?: string | null;
  logoSquareUrl?: string | null;
  pdfLogoUrl?: string | null;
  pdfPrimaryColor?: string | null;
  pdfAccentColor?: string | null;
  themePrimary?: string | null;
  themeSecondary?: string | null;
  themeAccent?: string | null;
  themeSuccess?: string | null;
};

const SHOW_COMMISSION_ROLES = ["super_admin", "agent", "sub_agent"];

function formatCurrency(amount: number | null | undefined, currency = "USD") {
  if (amount == null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(amount);
}

function calcCommissionAmount(program: Program, agentShareRate?: number | null | undefined): number | null {
  if (program.commissionRate == null) return null;
  const effectiveFee = program.discountedFee ?? program.tuitionFee;
  if (effectiveFee == null) return null;
  const fullCommission = (effectiveFee * program.commissionRate) / 100;
  if (agentShareRate === undefined) {
    return null;
  }
  if (agentShareRate !== null) {
    return Math.round((fullCommission * agentShareRate) / 100);
  }
  return Math.round(fullCommission);
}

function ensureUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  return `https://${url}`;
}

function getInitialCourseFinderViewMode(): "grid" | "list" {
  if (typeof window === "undefined") return "list";
  try {
    return window.localStorage.getItem(COURSE_FINDER_VIEW_STORAGE_KEY) === "grid"
      ? "grid"
      : "list";
  } catch {
    return "list";
  }
}

export default function CourseFinder() {
  const { t, lang } = useI18n();
  const { user, hasAgentStaffPermission } = useAuth(true);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const resolveProposalDocMeta = useResolveDocMeta();
  const [filters, setFilters] = useState<Filters>({
    country: [], city: [], universityType: [], universityId: [],
    level: [], language: [], field: [], search: "", feeMin: "", feeMax: "",
  });
  // Text and numeric inputs update immediately in the UI, but wait briefly
  // before changing the server query. This prevents one list request plus
  // eight cascading-facet queries from being fired for every keystroke.
  const debouncedSearch = useDebouncedValue(filters.search.trim(), 400);
  const debouncedFeeMin = useDebouncedValue(filters.feeMin, 400);
  const debouncedFeeMax = useDebouncedValue(filters.feeMax, 400);
  const [hideServiceFee, setHideServiceFee] = useState(false);
  const [page, setPage] = useState(1);
  const [selectedProgram, setSelectedProgram] = useState<Program | null>(null);
  const [selectedUniversity, setSelectedUniversity] = useState<Program | null>(null);
  const [applyProgram, setApplyProgram] = useState<Program | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [generatingPdf, setGeneratingPdf] = useState(false);
  const [pdfMarkup, setPdfMarkup] = useState(0);
  const [markupModalOpen, setMarkupModalOpen] = useState(false);
  const [viewMode, setViewMode] = useState<"grid" | "list">(getInitialCourseFinderViewMode);
  const [sortField, setSortField] = useState<string>("");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  // Column-header level filters that aren't represented in the server-side
  // `filters` state (intakes substring + university open/closed status).
  const [colIntakes, setColIntakes] = useState<string>("");
  const [colStatus, setColStatus] = useState<string>("all");
  const showCommission = user && (SHOW_COMMISSION_ROLES.includes(user.role) || (user.role === "agent_staff" && hasAgentStaffPermission("view_commission_amount")));
  const canViewServiceFee = user && (SHOW_COMMISSION_ROLES.includes(user.role) || (user.role === "agent_staff" && hasAgentStaffPermission("view_service_fee")));
  const isAgent = user && ["agent", "sub_agent"].includes(user.role);
  // Agency-side roles that should respect the agency's service-fee visibility,
  // including agency staff (agent_staff) — otherwise an agency could bypass a
  // parent's "hide service fee" simply by viewing through a staff account.
  const isAgentSide = user && ["agent", "sub_agent", "agent_staff"].includes(user.role);
  const isStudent = user?.role === "student";
  const showWishlist = isStudent || !user;
  const canUsePdfMarkup = user && ["super_admin", "admin", "manager", "agent", "sub_agent"].includes(user.role);
  const canUseNegativeMarkup = user && ["super_admin", "admin", "manager"].includes(user.role);
  const canExportExcel = user && ["super_admin", "admin"].includes(user.role);

  useEffect(() => {
    try {
      window.localStorage.setItem(COURSE_FINDER_VIEW_STORAGE_KEY, viewMode);
    } catch {
      // Storage may be unavailable in privacy-restricted browser contexts.
    }
  }, [viewMode]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const pid = params.get("programId");
    if (pid) {
      apiFetch(`${BASE_URL}/api/course-finder?programId=${pid}&limit=1&locale=${encodeURIComponent(lang)}`)
        .then((res: any) => {
          const prog = res?.data?.[0];
          if (prog) setSelectedProgram(prog);
        })
        .catch(() => {});
    }
  }, [lang]);

  // Build a query string of just the active filter selections — used both
  // for the program list and (now) for the cascading /filters endpoint so
  // each dropdown narrows itself based on the other selected facets.
  const filterParams = useMemo(() => {
    const p = new URLSearchParams();
    if (filters.country.length) p.set("country", filters.country.join(","));
    if (filters.city.length) p.set("city", filters.city.join(","));
    if (filters.universityType.length) p.set("universityType", filters.universityType.join(","));
    if (filters.universityId.length) p.set("universityId", filters.universityId.join(","));
    if (filters.level.length) p.set("level", filters.level.join(","));
    if (filters.language.length) p.set("language", filters.language.join(","));
    if (filters.field.length) p.set("field", filters.field.join(","));
    if (debouncedSearch) p.set("search", debouncedSearch);
    if (debouncedFeeMin) p.set("feeMin", debouncedFeeMin);
    if (debouncedFeeMax) p.set("feeMax", debouncedFeeMax);
    return p.toString();
  }, [filters, debouncedSearch, debouncedFeeMin, debouncedFeeMax]);

  const { data: filterOptions } = useQuery<FilterOptions>({
    queryKey: ["course-finder-filters", filterParams],
    queryFn: ({ signal }) => apiFetch(
      `${BASE_URL}/api/course-finder/filters${filterParams ? `?${filterParams}` : ""}`,
      { signal },
    ),
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000,
    // Cascading options belong to the exact active filter set. Reusing the
    // previous query's options can make the effect below prune newly selected
    // values while the matching options request is still in flight.
    placeholderData: undefined,
  });

  // Auto-prune selected values that are no longer present in the cascading
  // option list (e.g. user picked City=Istanbul, then changed Country to
  // Germany — Istanbul is no longer offered, so drop it instead of leaving
  // the result list empty with no visible reason).
  useEffect(() => {
    if (!filterOptions) return;
    setFilters(prev => {
      const validCity = new Set(filterOptions.cities || []);
      const validType = new Set(filterOptions.universityTypes || []);
      const validUni = new Set((filterOptions.universities || []).map(u => String(u.id)));
      const validLevel = new Set((filterOptions.degrees || []).map(d => d.toLowerCase()));
      const validLang = new Set((filterOptions.languages || []).map(l => l.toLowerCase()));
      const validField = new Set((filterOptions.fields || []).map(f => f.toLowerCase()));
      const validCountry = new Set(filterOptions.countries || []);
      const next = {
        ...prev,
        country: prev.country.filter(v => validCountry.has(v)),
        city: prev.city.filter(v => validCity.has(v)),
        universityType: prev.universityType.filter(v => validType.has(v)),
        universityId: prev.universityId.filter(v => validUni.has(v)),
        level: prev.level.filter(v => validLevel.has(v.toLowerCase())),
        language: prev.language.filter(v => validLang.has(v.toLowerCase())),
        field: prev.field.filter(v => validField.has(v.toLowerCase())),
      };
      const changed =
        next.country.length !== prev.country.length ||
        next.city.length !== prev.city.length ||
        next.universityType.length !== prev.universityType.length ||
        next.universityId.length !== prev.universityId.length ||
        next.level.length !== prev.level.length ||
        next.language.length !== prev.language.length ||
        next.field.length !== prev.field.length;
      return changed ? next : prev;
    });
  }, [filterOptions]);

  const buildQueryParams = useCallback((targetPage: number) => {
    const p = new URLSearchParams(filterParams);
    p.set("locale", lang);
    p.set("page", String(targetPage));
    p.set("limit", "24");
    if (sortField === "tuition") p.set("sort", sortDir === "asc" ? "price_asc" : "price_desc");
    return p.toString();
  }, [filterParams, lang, sortField, sortDir]);

  const queryParams = useMemo(() => buildQueryParams(page), [buildQueryParams, page]);

  const {
    data,
    isPending,
    isFetching,
    isError,
    refetch,
  } = useQuery<CourseFinderPage>({
    queryKey: ["course-finder", queryParams],
    queryFn: ({ signal }) => apiFetch(`${BASE_URL}/api/course-finder?${queryParams}`, { signal }),
    staleTime: 60_000,
    gcTime: 10 * 60_000,
    // The application-wide query default keeps previous data. That is useful
    // for many tables, but misleading here: filter chips can represent the new
    // query while cards and the total still represent the old one.
    placeholderData: undefined,
  });

  const programs = data?.data ?? [];
  const meta = data?.meta;

  // Prepare only the next page after the current page has settled. This keeps
  // the initial request small while making the common next-page action feel
  // immediate. Older pages remain in React Query's bounded cache as well.
  useEffect(() => {
    if (!meta || isFetching || meta.page >= meta.totalPages) return;
    const nextQueryParams = buildQueryParams(meta.page + 1);
    const prefetchTimer = window.setTimeout(() => {
      void queryClient.prefetchQuery<CourseFinderPage>({
        queryKey: ["course-finder", nextQueryParams],
        queryFn: ({ signal }) => apiFetch(
          `${BASE_URL}/api/course-finder?${nextQueryParams}`,
          { signal },
        ),
        staleTime: 60_000,
        gcTime: 10 * 60_000,
      });
    }, 200);

    return () => window.clearTimeout(prefetchTimer);
  }, [buildQueryParams, isFetching, meta, queryClient]);

  const { data: wishlistIds = [] } = useQuery<number[]>({
    queryKey: ["wishlists"],
    queryFn: () => apiFetch(`${BASE_URL}/api/wishlists`),
    enabled: !!user,
  });

  const addWishlist = useMutation({
    mutationFn: (programId: number) => apiFetch(`${BASE_URL}/api/wishlists`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ programId }) }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["wishlists"] }); queryClient.invalidateQueries({ queryKey: ["wishlist-details"] }); toast({ title: t("courseFinderPage.addedToWishlist") }); },
  });

  const removeWishlist = useMutation({
    mutationFn: (programId: number) => apiFetch(`${BASE_URL}/api/wishlists/${programId}`, { method: "DELETE" }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["wishlists"] }); queryClient.invalidateQueries({ queryKey: ["wishlist-details"] }); toast({ title: t("courseFinderPage.removedFromWishlist") }); },
  });

  function toggleWishlist(programId: number) {
    if (wishlistIds.includes(programId)) removeWishlist.mutate(programId);
    else addWishlist.mutate(programId);
  }

  function toggleSelect(programId: number) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(programId)) next.delete(programId);
      else next.add(programId);
      return next;
    });
  }

  async function toggleSelectAll() {
    if (selectedIds.size > 0) {
      setSelectedIds(new Set());
    } else {
      try {
        const allParams = new URLSearchParams();
        allParams.set("page", "1");
        allParams.set("limit", "1000");
        if (filters.country.length) allParams.set("country", filters.country.join(","));
        if (filters.city.length) allParams.set("city", filters.city.join(","));
        if (filters.universityType.length) allParams.set("universityType", filters.universityType.join(","));
        if (filters.universityId.length) allParams.set("universityId", filters.universityId.join(","));
        if (filters.level.length) allParams.set("level", filters.level.join(","));
        if (filters.language.length) allParams.set("language", filters.language.join(","));
        if (filters.field.length) allParams.set("field", filters.field.join(","));
        if (filters.search) allParams.set("search", filters.search);
        if (filters.feeMin) allParams.set("feeMin", filters.feeMin);
        if (filters.feeMax) allParams.set("feeMax", filters.feeMax);
        const allData = await apiFetch(`${BASE_URL}/api/course-finder?${allParams.toString()}`) as { data: Program[] };
        setSelectedIds(new Set(allData.data.map(p => p.id)));
      } catch {
        setSelectedIds(new Set(programs.map(p => p.id)));
      }
    }
  }

  const { data: agentProfile, isFetched: isAgentProfileFetched } = useQuery<{
    logoUrl?: string | null;
    companyName?: string;
    businessName?: string;
    email?: string | null;
    phone?: string | null;
    phoneE164?: string | null;
    website?: string | null;
    commissionRate?: number | null;
    subAgentCommissionRate?: number | null;
    effectiveCommissionRate?: number | null;
    hideServiceFees?: boolean;
    effectiveHideServiceFees?: boolean;
  }>({
    queryKey: ["agent-me-pdf"],
    queryFn: () => apiFetch(`${BASE_URL}/api/agents/me`),
    enabled: !!isAgentSide,
    staleTime: 10 * 60_000,
  });

  // Whether service fees must be hidden from the current agency-side user. The
  // backend resolves this up the whole sub-agent tree (effectiveHideServiceFees),
  // so a parent's "hide" cascades to every descendant sub-agent (and the
  // agency's own staff). When true we suppress every on-screen service-fee
  // figure and force the PDF proposal to omit them, regardless of the manual
  // "Hide Service Fee" toggle.
  const forceHideServiceFee: boolean = !!isAgentSide && (
    !isAgentProfileFetched || !!agentProfile?.effectiveHideServiceFees
  );
  const effectiveForceHideServiceFee: boolean = forceHideServiceFee || (user?.role === "agent_staff" && !hasAgentStaffPermission("view_service_fee"));

  // Use the backend-computed effective (cascaded) rate as the single source of
  // truth. For sub-agents this is parentRate × subRate / 100 so the estimate
  // matches what finance books; for parent/standalone agents it equals their
  // own commissionRate.
  const agentShareRate: number | null | undefined = isAgent
    ? (agentProfile?.effectiveCommissionRate ?? undefined)
    : null;

  async function handleGeneratePdf() {
    if (selectedIds.size === 0) {
      toast({ title: t("courseFinderPage.noProgramsSelected"), description: t("courseFinderPage.noProgramsSelectedDesc"), variant: "destructive" });
      return;
    }
    setGeneratingPdf(true);
    try {
      const proposalPdfImport = import("@/lib/generateProposalPdf");
      let selected = programs.filter(p => selectedIds.has(p.id));
      if (selected.length < selectedIds.size) {
        const allParams = new URLSearchParams();
        allParams.set("page", "1");
        allParams.set("limit", "1000");
        if (filters.country.length) allParams.set("country", filters.country.join(","));
        if (filters.city.length) allParams.set("city", filters.city.join(","));
        if (filters.universityType.length) allParams.set("universityType", filters.universityType.join(","));
        if (filters.universityId.length) allParams.set("universityId", filters.universityId.join(","));
        if (filters.level.length) allParams.set("level", filters.level.join(","));
        if (filters.language.length) allParams.set("language", filters.language.join(","));
        if (filters.field.length) allParams.set("field", filters.field.join(","));
        if (filters.search) allParams.set("search", filters.search);
        if (filters.feeMin) allParams.set("feeMin", filters.feeMin);
        if (filters.feeMax) allParams.set("feeMax", filters.feeMax);
        const allData = await apiFetch(`${BASE_URL}/api/course-finder?${allParams.toString()}`) as { data: Program[] };
        selected = allData.data.filter(p => selectedIds.has(p.id));
      }
      const [{ generateProposalPdf }, settings] = await Promise.all([
        proposalPdfImport,
        queryClient.fetchQuery<PdfSettings>({
          queryKey: ["settings-for-pdf"],
          queryFn: () => apiFetch(`${BASE_URL}/api/settings/client`),
          staleTime: 10 * 60_000,
          gcTime: 30 * 60_000,
        }),
      ]);
      const proposalBranding = resolveProposalBranding(user?.role, settings, agentProfile);
      const agencyBrandedProposal =
        user?.role === "agent" || user?.role === "sub_agent" || user?.role === "agent_staff";
      const selectedStudyLevels = collectProposalStudyLevels(selected, filters.level);
      if (selectedStudyLevels.length === 0) {
        throw new Error("The selected programs do not have a study level for the document checklist.");
      }
      const { documentRequirements, missingStudyLevels } = await loadProposalDocumentRequirements({
        studyLevels: selectedStudyLevels,
        fetchRequirements: async (studyLevel) => {
          try {
            return await apiFetch(
              `${BASE_URL}/api/degrees/by-value/${encodeURIComponent(studyLevel)}/document-requirements`,
            ) as Array<{ documentType: string; mandatory: boolean; sortOrder?: number }>;
          } catch (error) {
            // A document checklist enriches the proposal but is not required
            // to render its selected programs and prices. If the API is only
            // briefly unavailable, generate the PDF and report the checklist
            // as partial instead of failing the whole download.
            if (isTransientCourseFinderError(error)) return [];
            throw error;
          }
        },
        resolveLabel: (documentType) => resolveProposalDocMeta(documentType).label,
      });

      await generateProposalPdf({
        programs: selected,
        documentRequirements,
        // The PDF generator owns URL normalisation, authenticated fetching,
        // rasterisation and compression for both tenant and agency logos.
        // Tenant PDFs use the stable branding endpoint so a private object URL
        // or later object replacement cannot break the downloaded proposal.
        logoDataUrl: agencyBrandedProposal
          ? proposalBranding.logoSrc
          : `${BASE_URL}/api/settings/branding/logo?variant=pdf`,
        companyName: proposalBranding.companyName,
        companyEmail: proposalBranding.companyEmail,
        companyPhone: proposalBranding.companyPhone,
        companyWebsite: proposalBranding.companyWebsite || window.location.origin,
        showCommission: !!showCommission,
        agentShareRate: agentShareRate ?? null,
        serviceFeeMarkup: pdfMarkup !== 0 ? pdfMarkup : undefined,
        hideServiceFee: hideServiceFee || effectiveForceHideServiceFee,
        // A PDF-specific override wins. Otherwise white-label proposals inherit
        // the tenant theme automatically, with safe defaults in the generator.
        primaryColor: settings?.pdfPrimaryColor || settings?.themePrimary || undefined,
        secondaryColor: settings?.themeSecondary || settings?.themePrimary || undefined,
        accentColor: settings?.pdfAccentColor || settings?.themeAccent || undefined,
        successColor: settings?.themeSuccess || undefined,
      });
      toast({ title: t("courseFinderPage.pdfGenerated"), description: t("courseFinderPage.proposalDownloaded", { n: selected.length }) });
      if (missingStudyLevels.length > 0) {
        toast({
          title: "Proposal generated with a partial document checklist",
          description: `No document requirements are configured for: ${missingStudyLevels.join(", ")}.`,
        });
      }
    } catch (err: any) {
      toast({
        title: t("courseFinderPage.pdfGenerationFailed"),
        description: isTransientCourseFinderError(err)
          ? t("courseFinderPage.temporaryServiceUnavailable")
          : err.message || t("courseFinderPage.unknownError"),
        variant: "destructive",
      });
    } finally {
      setGeneratingPdf(false);
    }
  }

  function handleFilterChange(key: keyof Filters, value: any) {
    setFilters(prev => ({ ...prev, [key]: value }));
    setPage(1);
    setSelectedIds(new Set());
    setPdfMarkup(0);
  }

  function clearFilters() {
    setFilters({ country: [], city: [], universityType: [], universityId: [], level: [], language: [], field: [], search: "", feeMin: "", feeMax: "" });
    setPage(1);
    setSelectedIds(new Set());
    setPdfMarkup(0);
  }

  const hasActiveFilters = filters.country.length || filters.city.length || filters.universityType.length || filters.universityId.length || filters.level.length || filters.language.length || filters.field.length || filters.search || filters.feeMin || filters.feeMax;

  function handleSort(field: string) {
    if (sortField === field) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  }

  function handlePriceSort(value: string) {
    if (value === "default") {
      setSortField("");
      setSortDir("asc");
    } else {
      setSortField("tuition");
      setSortDir(value === "price_desc" ? "desc" : "asc");
    }
    setPage(1);
  }

  const sortedPrograms = useMemo(() => {
    if (!sortField) return programs;
    const sorted = [...programs].sort((a, b) => {
      let va: any, vb: any;
      switch (sortField) {
        case "name": va = a.name; vb = b.name; break;
        case "university": va = a.universityName; vb = b.universityName; break;
        case "country": va = a.universityCountry || ""; vb = b.universityCountry || ""; break;
        case "tuition": va = a.discountedFee ?? a.tuitionFee ?? 0; vb = b.discountedFee ?? b.tuitionFee ?? 0; break;
        case "degree": va = a.degree || ""; vb = b.degree || ""; break;
        case "language": va = a.language || ""; vb = b.language || ""; break;
        default: return 0;
      }
      if (typeof va === "string") return sortDir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
      return sortDir === "asc" ? (va - vb) : (vb - va);
    });
    return sorted;
  }, [programs, sortField, sortDir]);

  // Apply column-header level filters (intakes substring, university status)
  // on top of the server-filtered + locally sorted list.
  const displayedPrograms = useMemo(() => {
    const q = colIntakes.trim().toLowerCase();
    return sortedPrograms.filter(p => {
      if (q) {
        const v = (p.intakes || "").toLowerCase();
        if (!v.includes(q)) return false;
      }
      if (colStatus !== "all") {
        const s = (p.universityStatus || "").toLowerCase();
        if (colStatus === "open" && s !== "open") return false;
        if (colStatus === "closed" && s === "open") return false;
      }
      return true;
    });
  }, [sortedPrograms, colIntakes, colStatus]);

  async function exportToExcel() {
    const excelImport = import("xlsx");
    let exportPrograms = sortedPrograms;
    const total = meta?.total ?? 0;
    if (total > programs.length) {
      try {
        const allParams = new URLSearchParams();
        allParams.set("page", "1");
        allParams.set("limit", "1000");
        if (filters.country.length) allParams.set("country", filters.country.join(","));
        if (filters.city.length) allParams.set("city", filters.city.join(","));
        if (filters.universityType.length) allParams.set("universityType", filters.universityType.join(","));
        if (filters.universityId.length) allParams.set("universityId", filters.universityId.join(","));
        if (filters.level.length) allParams.set("level", filters.level.join(","));
        if (filters.language.length) allParams.set("language", filters.language.join(","));
        if (filters.field.length) allParams.set("field", filters.field.join(","));
        if (filters.search) allParams.set("search", filters.search);
        if (filters.feeMin) allParams.set("feeMin", filters.feeMin);
        if (filters.feeMax) allParams.set("feeMax", filters.feeMax);
        const allData = await apiFetch(`${BASE_URL}/api/course-finder?${allParams.toString()}`) as { data: Program[] };
        exportPrograms = allData.data;
      } catch {}
    }
    if (!exportPrograms.length) return;
    const rows = exportPrograms.map(p => ({
      "Program Name": p.name,
      "University": p.universityName,
      "Country": p.universityCountry || "",
      "City": p.universityCity || "",
      "Degree": p.degree || "",
      "Language": p.language || "",
      "Duration": p.duration || "",
      "Tuition Fee": p.tuitionFee ?? "",
      "Discounted Fee": p.discountedFee ?? "",
      "Currency": p.currency || "USD",
      "Scholarship": p.scholarship ?? "",
      "Application Fee": p.applicationFee ?? "",
      "Commission Rate (%)": p.commissionRate ?? "",
      "Commission Amount": calcCommissionAmount(p, agentShareRate) ?? "",
      "Fee Type": p.feeType || "",
      "Intakes": p.intakes || "",
      "University Type": p.universityType || "",
      "Status": p.universityStatus || "",
    }));
    const XLSX = await excelImport;
    const ws = XLSX.utils.json_to_sheet(rows);
    const colWidths = Object.keys(rows[0]).map(k => ({ wch: Math.max(k.length, 14) }));
    ws["!cols"] = colWidths;
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Programs");
    XLSX.writeFile(wb, `programs_export_${new Date().toISOString().slice(0, 10)}.xlsx`);
    toast({ title: t("courseFinderPage.excelExported"), description: t("courseFinderPage.programsExportedDesc", { n: rows.length }) });
  }

  return (
    <>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-display font-bold tracking-tight">{t("staffCourseFinder.title")}</h1>
          <p className="text-muted-foreground mt-1">{t("staffCourseFinder.subtitle")}</p>
        </div>

        <div className="bg-card rounded-2xl border p-4 space-y-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder={t("courseFinderPage.searchProgramsUniversities")}
              value={filters.search}
              onChange={e => handleFilterChange("search", e.target.value)}
              className="pl-10 rounded-xl h-11"
            />
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7 gap-3">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">{t("courseFinderPage.country")}</Label>
              <MultiSelectFilter
                values={filters.country}
                onChange={v => handleFilterChange("country", v)}
                options={filterOptions?.countries?.map(c => ({ value: c, label: c })) || []}
                placeholder={t("courseFinderPage.allCountries")}
              />
            </div>

            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">{t("courseFinderPage.city")}</Label>
              <MultiSelectFilter
                values={filters.city}
                onChange={v => handleFilterChange("city", v)}
                options={filterOptions?.cities?.map(c => ({ value: c, label: c })) || []}
                placeholder={t("courseFinderPage.allCities")}
              />
            </div>

            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">{t("courseFinderPage.universityType")}</Label>
              <MultiSelectFilter
                values={filters.universityType}
                onChange={v => handleFilterChange("universityType", v)}
                options={filterOptions?.universityTypes?.map(t => ({ value: t, label: t })) || []}
                placeholder={t("courseFinderPage.allTypes")}
              />
            </div>

            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">{t("courseFinderPage.university")}</Label>
              <MultiSelectFilter
                values={filters.universityId}
                onChange={v => handleFilterChange("universityId", v)}
                options={filterOptions?.universities?.map(u => ({ value: String(u.id), label: u.name })) || []}
                placeholder={t("courseFinderPage.allUniversities")}
              />
            </div>

            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">{t("courseFinderPage.studyLevel")}</Label>
              <MultiSelectFilter
                values={filters.level}
                onChange={v => handleFilterChange("level", v)}
                options={filterOptions?.degrees?.map(d => ({ value: d, label: d })) || []}
                placeholder={t("courseFinderPage.allLevels")}
              />
            </div>

            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">{t("courseFinderPage.language")}</Label>
              <MultiSelectFilter
                values={filters.language}
                onChange={v => handleFilterChange("language", v)}
                options={filterOptions?.languages?.map(l => ({ value: l, label: l })) || []}
                placeholder={t("courseFinderPage.allLanguages")}
              />
            </div>

            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">{t("courseFinderPage.field")}</Label>
              <MultiSelectFilter
                values={filters.field}
                onChange={v => handleFilterChange("field", v)}
                options={filterOptions?.fields?.map(f => ({ value: f, label: f })) || []}
                placeholder={t("courseFinderPage.allFields")}
              />
            </div>

            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">
                {t("courseFinderPage.tuitionFee")} {filters.feeMin || filters.feeMax ? (
                  <span className="text-primary">
                    ({filters.feeMin ? `$${Number(filters.feeMin).toLocaleString()}` : "$0"} – {filters.feeMax ? `$${Number(filters.feeMax).toLocaleString()}` : "Max"})
                  </span>
                ) : null}
              </Label>
              <div className="flex gap-1.5 items-center">
                <Input
                  type="number"
                  placeholder={t("courseFinderPage.min")}
                  value={filters.feeMin}
                  onChange={e => handleFilterChange("feeMin", e.target.value)}
                  className="h-9 rounded-lg text-sm w-full"
                />
                <span className="text-muted-foreground text-xs shrink-0">–</span>
                <Input
                  type="number"
                  placeholder={t("courseFinderPage.max")}
                  value={filters.feeMax}
                  onChange={e => handleFilterChange("feeMax", e.target.value)}
                  className="h-9 rounded-lg text-sm w-full"
                />
              </div>
            </div>

            <div className="flex items-end sm:col-span-1">
              <div
                className="inline-flex h-9 items-center overflow-hidden rounded-xl border border-border/70 bg-muted/50 p-0.5 shadow-sm"
                role="group"
                aria-label="Sort programs"
              >
                <button
                  type="button"
                  onClick={() => handlePriceSort("default")}
                  className={cn(
                    "flex h-8 w-9 items-center justify-center rounded-lg transition-colors",
                    sortField !== "tuition"
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "text-muted-foreground hover:bg-background/80 hover:text-foreground",
                  )}
                  aria-label="Recommended order"
                  title="Recommended order"
                >
                  <ArrowUpDown className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => handlePriceSort("price_asc")}
                  className={cn(
                    "flex h-8 w-9 items-center justify-center rounded-lg transition-colors",
                    sortField === "tuition" && sortDir === "asc"
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "text-muted-foreground hover:bg-background/80 hover:text-foreground",
                  )}
                  aria-label="Price from low to high"
                  title="Price from low to high"
                >
                  <ArrowUp className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => handlePriceSort("price_desc")}
                  className={cn(
                    "flex h-8 w-9 items-center justify-center rounded-lg transition-colors",
                    sortField === "tuition" && sortDir === "desc"
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "text-muted-foreground hover:bg-background/80 hover:text-foreground",
                  )}
                  aria-label="Price from high to low"
                  title="Price from high to low"
                >
                  <ArrowDown className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div className="flex items-center gap-2">
              {hasActiveFilters && (
                <Button variant="ghost" size="sm" onClick={clearFilters} className="h-8 text-xs text-muted-foreground">
                  <X className="w-3 h-3 mr-1" /> Clear Filters
                </Button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2 xl:justify-end">
              {programs.length > 0 && (
                <div className={cn(
                  "flex flex-wrap items-center gap-2",
                  selectedIds.size > 0 && "rounded-xl border border-primary/20 bg-primary/[0.04] px-2 py-1.5",
                )}>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={toggleSelectAll}
                    className="h-8 text-xs gap-1.5"
                  >
                    {selectedIds.size > 0 ? (
                      <CheckSquare className="w-3.5 h-3.5 text-primary" />
                    ) : (
                      <Square className="w-3.5 h-3.5" />
                    )}
                    {selectedIds.size > 0 ? "Deselect All" : "Select All"}
                  </Button>
                  {selectedIds.size > 0 && (
                    <>
                      {canUsePdfMarkup && !effectiveForceHideServiceFee && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setMarkupModalOpen(true)}
                          className="h-8 text-xs gap-1.5 rounded-lg"
                        >
                          <DollarSign className="w-3.5 h-3.5" />
                          PDF Fee Adjustment
                          {pdfMarkup !== 0 && (
                            <Badge variant="secondary" className={`ml-1 text-[10px] px-1.5 py-0 h-4 ${pdfMarkup > 0 ? "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300" : "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300"}`}>
                              {pdfMarkup > 0 ? "+" : ""}{pdfMarkup.toLocaleString()} {programs[0]?.currency || "USD"}
                            </Badge>
                          )}
                        </Button>
                      )}
                      {!isStudent && !effectiveForceHideServiceFee && (
                        <label className="flex h-8 items-center gap-1.5 rounded-lg border bg-background px-2.5 text-xs text-muted-foreground cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={hideServiceFee}
                            onChange={e => setHideServiceFee(e.target.checked)}
                            className="rounded border-gray-300 text-primary focus:ring-primary h-3.5 w-3.5"
                          />
                          Hide Service Fee
                        </label>
                      )}
                      <Button
                        size="sm"
                        onClick={handleGeneratePdf}
                        disabled={generatingPdf}
                        className="h-8 text-xs gap-1.5 bg-gradient-to-r from-primary to-blue-600 hover:from-primary/90 hover:to-blue-700 text-white border-0 rounded-lg"
                      >
                        {generatingPdf ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <FileDown className="w-3.5 h-3.5" />
                        )}
                        Download Proposal ({selectedIds.size})
                      </Button>
                    </>
                  )}
                </div>
              )}
              {canExportExcel && programs.length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={exportToExcel}
                  className="h-8 text-xs gap-1.5 rounded-lg"
                >
                  <Download className="w-3.5 h-3.5" />
                  Export Excel
                </Button>
              )}
              <div className="flex items-center border rounded-lg overflow-hidden">
                <button
                  onClick={() => setViewMode("grid")}
                  className={`p-1.5 transition-colors ${viewMode === "grid" ? "bg-primary text-white" : "bg-card text-muted-foreground hover:text-foreground"}`}
                  title="Grid view"
                >
                  <LayoutGrid className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setViewMode("list")}
                  className={`p-1.5 transition-colors ${viewMode === "list" ? "bg-primary text-white" : "bg-card text-muted-foreground hover:text-foreground"}`}
                  title="List view"
                >
                  <List className="w-4 h-4" />
                </button>
              </div>
              {isFetching && !isPending && !isError && (
                <div className="flex items-center gap-1.5 text-sm text-muted-foreground" role="status">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Updating results...
                </div>
              )}
              {meta && !isError && (
                <div className="text-sm text-muted-foreground">
                  {meta.total} program{meta.total !== 1 ? "s" : ""} found
                </div>
              )}
            </div>
          </div>
        </div>

        {isPending ? (
          viewMode === "grid" ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="bg-card border rounded-2xl p-5 animate-pulse space-y-4">
                  <div className="flex gap-3 items-center">
                    <div className="w-14 h-14 bg-muted rounded-xl" />
                    <div className="space-y-2 flex-1">
                      <div className="h-4 bg-muted rounded w-3/4" />
                      <div className="h-3 bg-muted rounded w-1/2" />
                    </div>
                  </div>
                  <div className="h-3 bg-muted rounded w-full" />
                  <div className="h-3 bg-muted rounded w-2/3" />
                </div>
              ))}
            </div>
          ) : (
            <div className="bg-card border rounded-2xl overflow-hidden">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4 p-4 border-b animate-pulse">
                  <div className="w-10 h-10 bg-muted rounded-lg" />
                  <div className="flex-1 space-y-2"><div className="h-4 bg-muted rounded w-1/3" /><div className="h-3 bg-muted rounded w-1/4" /></div>
                  <div className="h-4 bg-muted rounded w-20" />
                </div>
              ))}
            </div>
          )
        ) : isError ? (
          <div className="rounded-2xl border border-destructive/30 bg-destructive/5 px-6 py-12 text-center" role="alert">
            <AlertCircle className="mx-auto mb-3 h-10 w-10 text-destructive" />
            <p className="text-lg font-semibold">Programs could not be loaded</p>
            <p className="mx-auto mt-1 max-w-xl text-sm text-muted-foreground">
              The selected filters were not applied. No previous results are being shown.
            </p>
            <Button variant="outline" className="mt-4" onClick={() => void refetch()}>
              {t("common.retry")}
            </Button>
          </div>
        ) : programs.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">
            <BookOpen className="w-12 h-12 mx-auto mb-3 opacity-50" />
            <p className="text-lg font-medium">No programs found</p>
            <p className="text-sm">Try adjusting your filters or search terms</p>
          </div>
        ) : viewMode === "grid" ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
            {sortedPrograms.map(prog => (
              <ProgramCard
                key={prog.id}
                program={prog}
                isWishlisted={wishlistIds.includes(prog.id)}
                onToggleWishlist={() => toggleWishlist(prog.id)}
                onInfo={() => setSelectedProgram(prog)}
                onApply={() => setApplyProgram(prog)}
                onUniversityClick={() => setSelectedUniversity(prog)}
                showCommission={!!showCommission}
                showServiceFee={!!canViewServiceFee && !effectiveForceHideServiceFee}
                agentShareRate={agentShareRate}
                showWishlist={!!showWishlist}
                isSelected={selectedIds.has(prog.id)}
                onToggleSelect={() => toggleSelect(prog.id)}
              />
            ))}
          </div>
        ) : (
          <ProgramListView
            programs={displayedPrograms}
            wishlistIds={wishlistIds}
            selectedIds={selectedIds}
            showCommission={!!showCommission}
            showServiceFee={!!canViewServiceFee && !effectiveForceHideServiceFee}
            agentShareRate={agentShareRate}
            showWishlist={!!showWishlist}
            sortField={sortField}
            sortDir={sortDir}
            onSort={handleSort}
            onToggleSelect={toggleSelect}
            onToggleWishlist={toggleWishlist}
            onInfo={setSelectedProgram}
            onApply={setApplyProgram}
            onUniversityClick={setSelectedUniversity}
            filterOptions={filterOptions}
            filters={filters}
            setFilters={setFilters}
            colIntakes={colIntakes}
            setColIntakes={setColIntakes}
            colStatus={colStatus}
            setColStatus={setColStatus}
            onResetPage={() => { setPage(1); setSelectedIds(new Set()); }}
          />
        )}

        {meta && meta.totalPages > 1 && (
          <div className="flex items-center justify-center gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => { setPage(p => p - 1); setSelectedIds(new Set()); }}>
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <span className="text-sm text-muted-foreground px-3">
              Page {meta.page} of {meta.totalPages}
            </span>
            <Button variant="outline" size="sm" disabled={page >= meta.totalPages} onClick={() => { setPage(p => p + 1); setSelectedIds(new Set()); }}>
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        )}
      </div>

      <ProgramInfoDialog
        program={selectedProgram}
        onClose={() => setSelectedProgram(null)}
        showCommission={!!showCommission}
        agentShareRate={agentShareRate}
        showApplicationFee={!!showCommission}
        showServiceFee={!!canViewServiceFee && !effectiveForceHideServiceFee}
      />

      <UniversityInfoDialog
        program={selectedUniversity}
        onClose={() => setSelectedUniversity(null)}
      />

      <ApplyDialog
        program={applyProgram}
        onClose={() => setApplyProgram(null)}
        currentUser={user}
        agentShareRate={agentShareRate}
        hideServiceFee={effectiveForceHideServiceFee}
        showCommission={!!showCommission}
      />

      {canUsePdfMarkup && !effectiveForceHideServiceFee && markupModalOpen && (
        <Suspense fallback={null}>
          <LazyPdfMarkupModal
            open={markupModalOpen}
            onOpenChange={setMarkupModalOpen}
            currentMarkup={pdfMarkup}
            onApply={setPdfMarkup}
            currency={programs[0]?.currency || "USD"}
            sampleFee={programs[0]?.serviceFeeAmount}
            allowNegative={!!canUseNegativeMarkup}
          />
        </Suspense>
      )}
    </>
  );
}

function SortHeader({ label, field, sortField, sortDir, onSort }: {
  label: string; field: string; sortField: string; sortDir: "asc" | "desc"; onSort: (f: string) => void;
}) {
  const active = sortField === field;
  return (
    <>
    <button onClick={() => onSort(field)} className="flex items-center gap-1 hover:text-foreground transition-colors group">
      <span>{label}</span>
      {active ? (
        sortDir === "asc" ? <ArrowUp className="w-3 h-3 text-primary" /> : <ArrowDown className="w-3 h-3 text-primary" />
      ) : (
        <ArrowUpDown className="w-3 h-3 opacity-0 group-hover:opacity-50 transition-opacity" />
      )}
    </button>
    </>
  );
}

function ProgramListView(props: any) { const { t } = useI18n(); return <ProgramListViewBody {...props} t={t} />; }
function ProgramListViewBody({ programs, wishlistIds, selectedIds, showCommission, showServiceFee, agentShareRate, showWishlist = true, sortField, sortDir, onSort, onToggleSelect, onToggleWishlist, onInfo, onApply, onUniversityClick, filterOptions, filters, setFilters, colIntakes, setColIntakes, colStatus, setColStatus, onResetPage, t }: {
  programs: Program[];
  wishlistIds: number[];
  selectedIds: Set<number>;
  showCommission: boolean;
  showServiceFee: boolean;
  agentShareRate?: number | null | undefined;
  showWishlist?: boolean;
  sortField: string;
  sortDir: "asc" | "desc";
  onSort: (field: string) => void;
  onToggleSelect: (id: number) => void;
  onToggleWishlist: (id: number) => void;
  onInfo: (p: Program) => void;
  onApply: (p: Program) => void;
  onUniversityClick: (p: Program) => void;
  filterOptions: FilterOptions | undefined;
  filters: Filters;
  setFilters: React.Dispatch<React.SetStateAction<Filters>>;
  colIntakes: string;
  setColIntakes: (v: string) => void;
  colStatus: string;
  setColStatus: (v: string) => void;
  onResetPage: () => void;
  t: (k: string) => string;
}) {
  // Convert ColumnHeader's single-select API to the array-based server filters.
  const setSingle = (key: keyof Filters, v: string) => {
    setFilters(prev => ({ ...prev, [key]: v ? [v] : [] } as Filters));
    onResetPage();
  };
  const currentSort = { key: sortField, dir: sortDir };
  const sortHandler = onSort;
  const sortFor = (k: string) => ({ sortKey: k, current: currentSort as any, onSort: sortHandler });
  return (
    <>
    <div className="bg-card border rounded-2xl overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/30 text-xs text-muted-foreground font-medium">
              <th className="p-3 w-10"></th>
              <th className="p-3 text-left min-w-[250px]">
                <SortHeader label="Program" field="name" sortField={sortField} sortDir={sortDir} onSort={onSort} />
              </th>
              <ColumnHeader
                asTh
                label="University"
                className="text-left min-w-[160px]"
                sort={sortFor("university")}
                filter={{
                  type: "select",
                  value: filters.universityId[0] ?? "all",
                  onChange: v => setSingle("universityId", v === "all" ? "" : v),
                  options: (filterOptions?.universities ?? []).map(u => ({ value: String(u.id), label: u.name })),
                  label: "University",
                }}
              />
              <ColumnHeader
                asTh
                label="Degree"
                className="text-left"
                sort={sortFor("degree")}
                filter={{
                  type: "select",
                  value: filters.level[0] ?? "all",
                  onChange: v => setSingle("level", v === "all" ? "" : v),
                  options: (filterOptions?.degrees ?? []).map(d => ({ value: d, label: d })),
                  label: "Degree",
                }}
              />
              <ColumnHeader
                asTh
                label="Country"
                className="text-left"
                sort={sortFor("country")}
                filter={{
                  type: "select",
                  value: filters.country[0] ?? "all",
                  onChange: v => setSingle("country", v === "all" ? "" : v),
                  options: (filterOptions?.countries ?? []).map(c => ({ value: c, label: c })),
                  label: "Country",
                }}
              />
              <ColumnHeader
                asTh
                label="Language"
                className="text-left"
                sort={sortFor("language")}
                filter={{
                  type: "select",
                  value: filters.language[0] ?? "all",
                  onChange: v => setSingle("language", v === "all" ? "" : v),
                  options: (filterOptions?.languages ?? []).map(l => ({ value: l, label: l })),
                  label: "Language",
                }}
              />
              <ColumnHeader
                asTh
                label="Tuition"
                align="right"
                className="text-right"
                sort={sortFor("tuition")}
                filter={{
                  type: "text",
                  value: filters.feeMax,
                  onChange: v => { setFilters(prev => ({ ...prev, feeMax: v })); onResetPage(); },
                  placeholder: "Max amount (e.g. 5000)",
                  label: "Max tuition fee",
                }}
              />
              {(showCommission || showServiceFee) && (
                <th className="p-3 text-right">Internal Fees</th>
              )}
              <ColumnHeader
                asTh
                label="Intakes"
                align="center"
                className="text-center"
                filter={{
                  type: "text",
                  value: colIntakes,
                  onChange: setColIntakes,
                  placeholder: t("courseFinderPage.intakesPlaceholder"),
                  label: "Intake contains",
                }}
              />
              <ColumnHeader
                asTh
                label="Status"
                align="center"
                className="text-center"
                filter={{
                  type: "select",
                  value: colStatus,
                  onChange: setColStatus,
                  options: [
                    { value: "open", label: "Open" },
                    { value: "closed", label: "Closed" },
                  ],
                  label: "University status",
                }}
              />
              <th className="p-3 text-center w-[120px]">{t("courseFinderPage.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {programs.map(p => {
              const hasDiscount = p.discountedFee != null && p.tuitionFee != null && p.discountedFee < p.tuitionFee;
              const commissionAmount = calcCommissionAmount(p, agentShareRate);
              const cur = p.currency ?? "USD";
              const isSelected = selectedIds.has(p.id);
              const isWishlisted = wishlistIds.includes(p.id);

              return (
                <tr
                  key={p.id}
                  className={`border-b last:border-b-0 hover:bg-muted/20 transition-colors ${isSelected ? "bg-primary/5" : ""}`}
                >
                  <td className="p-3">
                    <button onClick={() => onToggleSelect(p.id)} className="p-0.5 rounded hover:bg-muted/80">
                      {isSelected ? (
                        <CheckSquare className="w-4 h-4 text-primary" />
                      ) : (
                        <Square className="w-4 h-4 text-muted-foreground/40" />
                      )}
                    </button>
                  </td>
                  <td className="p-3">
                    <div className="flex items-center gap-2.5">
                      <div className="w-9 h-9 rounded-lg border bg-white flex items-center justify-center overflow-hidden shrink-0">
                        {p.universityLogoUrl ? (
                          <img src={p.universityLogoUrl} alt={p.universityName || 'University logo'} width={36} height={36} loading="lazy" className="w-full h-full object-contain p-0.5" />
                        ) : (
                          <Building2 className="w-4 h-4 text-muted-foreground" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <p className="font-semibold text-foreground text-sm truncate max-w-[220px]">{p.name}</p>
                        {p.duration && (
                          <p className="text-[11px] text-muted-foreground flex items-center gap-1 mt-0.5">
                            <Clock className="w-3 h-3" />{p.duration}
                          </p>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="p-3">
                    <button
                      onClick={() => onUniversityClick(p)}
                      className="text-sm text-foreground hover:text-primary hover:underline transition-colors truncate max-w-[150px] block text-left"
                    >
                      {p.universityName}
                    </button>
                  </td>
                  <td className="p-3">
                    {p.degree && (
                      <Badge className="text-[10px] px-2 py-0.5 h-auto rounded-full bg-primary/10 text-primary border-0 font-medium">
                        {p.degree}
                      </Badge>
                    )}
                  </td>
                  <td className="p-3">
                    <div className="text-sm">
                      <span>{p.universityCountry || "—"}</span>
                      {p.universityCity && (
                        <span className="text-muted-foreground text-xs block">{p.universityCity}</span>
                      )}
                    </div>
                  </td>
                  <td className="p-3 text-sm">{p.language || "—"}</td>
                  <td className="p-3 text-right">
                    <div>
                      {hasDiscount && (
                        <span className="text-xs text-muted-foreground line-through block">{formatCurrency(p.tuitionFee, cur)}</span>
                      )}
                      <span className={`text-sm font-semibold ${hasDiscount ? "text-emerald-600" : ""}`}>
                        {formatCurrency(hasDiscount ? p.discountedFee : p.tuitionFee, cur)}
                      </span>
                      {hasDiscount && (
                        <Badge className="text-[9px] px-1 py-0 h-3.5 bg-emerald-100 text-emerald-700 border-0 rounded-full ml-1 dark:bg-emerald-900/40 dark:text-emerald-300">
                          -{Math.round(((p.tuitionFee! - p.discountedFee!) / p.tuitionFee!) * 100)}%
                        </Badge>
                      )}
                    </div>
                  </td>
                  {(showCommission || showServiceFee) && (
                    <td className="p-3 min-w-[150px]">
                      <div className="space-y-1 text-[10px]">
                        {showCommission && (
                          <>
                            <div className="flex items-center justify-between gap-3">
                              <span className="text-muted-foreground">{t("courseFinderPage.commission")}</span>
                              <span className="font-semibold text-indigo-600">{formatCurrency(commissionAmount, cur)}</span>
                            </div>
                            <div className="flex items-center justify-between gap-3">
                              <span className="text-muted-foreground">{t("courseFinderPage.appFee")}</span>
                              <span className="font-semibold">{formatCurrency(p.applicationFee, cur)}</span>
                            </div>
                          </>
                        )}
                        {showServiceFee && (
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-muted-foreground">{t("catalogPage.serviceFee")}</span>
                            <span className="font-semibold text-amber-600 dark:text-amber-400">{formatCurrency(p.serviceFeeAmount, cur)}</span>
                          </div>
                        )}
                      </div>
                    </td>
                  )}
                  <td className="p-3 text-center">
                    {p.intakes ? (
                      <div className="flex flex-wrap gap-1 justify-center">
                        {p.intakes.split(",").slice(0, 3).map(intake => (
                          <Badge key={intake.trim()} variant="outline" className="text-[10px] px-1.5 py-0 h-4 rounded-full">
                            {intake.trim()}
                          </Badge>
                        ))}
                        {p.intakes.split(",").length > 3 && (
                          <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 rounded-full">
                            +{p.intakes.split(",").length - 3}
                          </Badge>
                        )}
                      </div>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="p-3 text-center">
                    {p.universityStatus && (
                      <div className="flex items-center gap-1.5 justify-center">
                        <div className={`w-2 h-2 rounded-full ${p.universityStatus === "open" ? "bg-emerald-500" : "bg-amber-500"}`} />
                        <span className="text-[11px] capitalize">{p.universityStatus === "open" ? "Open" : "Closed"}</span>
                      </div>
                    )}
                  </td>
                  <td className="p-3">
                    <div className="flex items-center justify-center gap-1">
                      {showWishlist && (
                        <button
                          onClick={() => onToggleWishlist(p.id)}
                          className="p-1.5 rounded-lg hover:bg-muted/80 transition-colors"
                          title={isWishlisted ? "Remove from wishlist" : "Add to wishlist"}
                        >
                          <Heart className={`w-3.5 h-3.5 ${isWishlisted ? "fill-red-500 text-red-500" : "text-muted-foreground"}`} />
                        </button>
                      )}
                      <button
                        onClick={() => onInfo(p)}
                        className="p-1.5 rounded-lg hover:bg-muted/80 transition-colors"
                        title="Details"
                      >
                        <Info className="w-3.5 h-3.5 text-muted-foreground" />
                      </button>
                      <button
                        onClick={() => onApply(p)}
                        className="p-1.5 rounded-lg hover:bg-primary/10 transition-colors"
                        title="Apply"
                      >
                        <Send className="w-3.5 h-3.5 text-primary" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
    </>
  );
}

function ProgramCard(props: any) { const { t } = useI18n(); return <ProgramCardBody {...props} t={t} />; }
function ProgramCardBody({ program: p, isWishlisted, onToggleWishlist, onInfo, onApply, onUniversityClick, showCommission, showServiceFee, agentShareRate, showWishlist = true, isSelected, onToggleSelect, t }: {
  program: Program;
  isWishlisted: boolean;
  onToggleWishlist: () => void;
  onInfo: () => void;
  onApply: () => void;
  onUniversityClick: () => void;
  showCommission: boolean;
  showServiceFee: boolean;
  agentShareRate?: number | null;
  showWishlist?: boolean;
  isSelected: boolean;
  onToggleSelect: () => void;
  t: (k: string, vars?: Record<string, string>) => string;
}) {
  const hasDiscount = p.discountedFee != null && p.tuitionFee != null && p.discountedFee < p.tuitionFee;
  const commissionAmount = calcCommissionAmount(p, agentShareRate);
  const cur = p.currency ?? "USD";
  const websiteUrl = ensureUrl(p.universityWebsite);

  const pct = hasDiscount ? Math.round(((p.tuitionFee ?? 0) - (p.discountedFee ?? 0)) / (p.tuitionFee ?? 1) * 100) : 0;

  return (
    <>
    <div className={`bg-card border rounded-2xl overflow-hidden hover:shadow-xl hover:shadow-primary/[0.08] hover:-translate-y-1 transition-all duration-300 group flex flex-col ${isSelected ? "ring-2 ring-primary border-primary/50" : "border-border/50 hover:border-primary/20"}`}>

      {/* ── Banner (white) ── */}
      <div className="flex items-center gap-2.5 px-3 py-3 border-b border-border/50 bg-card">
        {/* Select */}
        <button onClick={onToggleSelect} className="shrink-0 p-0.5 rounded hover:bg-muted/80 transition-colors" title={isSelected ? "Deselect" : "Select for proposal"}>
          {isSelected ? <CheckSquare className="w-4 h-4 text-primary" /> : <Square className="w-4 h-4 text-muted-foreground/30 group-hover:text-muted-foreground" />}
        </button>
        {/* Logo */}
        {websiteUrl ? (
          <a href={websiteUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}
            className="w-10 h-10 rounded-xl border border-border/60 bg-background flex items-center justify-center shrink-0 overflow-hidden hover:border-primary/40 hover:scale-105 transition-all">
            {p.universityLogoUrl ? <img src={p.universityLogoUrl} alt={p.universityName} loading="lazy" className="w-full h-full object-contain p-0.5" /> : <Building2 className="w-5 h-5 text-muted-foreground" />}
          </a>
        ) : (
          <div className="w-10 h-10 rounded-xl border border-border/60 bg-background flex items-center justify-center shrink-0 overflow-hidden">
            {p.universityLogoUrl ? <img src={p.universityLogoUrl} alt={p.universityName} loading="lazy" className="w-full h-full object-contain p-0.5" /> : <Building2 className="w-5 h-5 text-muted-foreground" />}
          </div>
        )}
        {/* Uni name + location */}
        <div className="min-w-0 flex-1">
          <button onClick={onUniversityClick} className="text-[12px] font-bold text-foreground/80 truncate block max-w-full text-left hover:text-primary transition-colors hover:underline leading-tight">
            {p.universityName}
          </button>
          {(p.universityCity || p.universityCountry) && (
            <div className="flex items-center gap-1 text-[10px] text-muted-foreground mt-0.5">
              <MapPin className="w-3 h-3 shrink-0 text-primary/60" />
              <span className="truncate">{[p.universityCity, p.universityCountry].filter(Boolean).join(", ")}</span>
            </div>
          )}
        </div>
        {/* Type + Degree badges */}
        <div className="flex flex-col items-end gap-1 shrink-0">
          {p.universityType && <Badge variant="outline" className="text-[10px] px-2 py-0 h-[18px] font-medium">{p.universityType}</Badge>}
          {p.degree && <Badge className="text-[10px] px-2 py-0 h-[18px] bg-primary text-primary-foreground font-medium">{p.degree}</Badge>}
        </div>
        {/* Wishlist */}
        {showWishlist && (
          <button onClick={onToggleWishlist} className="shrink-0 p-1.5 rounded-full hover:bg-muted/80 transition-colors" title={isWishlisted ? "Remove from wishlist" : "Add to wishlist"}>
            <Heart className={`w-4 h-4 transition-all ${isWishlisted ? "fill-red-500 text-red-500" : "text-muted-foreground/30 hover:text-red-400"}`} />
          </button>
        )}
      </div>

      {/* ── Body ── */}
      <div className="p-4 flex-1 flex flex-col gap-3">
        {/* Program name */}
        <h3 className="font-bold text-[15px] leading-snug line-clamp-2 group-hover:text-primary transition-colors">{p.name}</h3>

        {/* Fee + Scholarship */}
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] text-muted-foreground mb-1.5">
              {t("courseFinderPage.tuitionFee")}{p.feeType ? ` (${p.feeType})` : ""}
            </p>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[22px] font-extrabold leading-none tracking-tight">
                {formatCurrency(hasDiscount ? p.discountedFee : p.tuitionFee, cur)}
              </span>
              {hasDiscount && (
                <span className="text-sm text-muted-foreground/50 line-through leading-none">{formatCurrency(p.tuitionFee, cur)}</span>
              )}
              {hasDiscount && (
                <Badge className="bg-emerald-500 text-white text-[10px] font-bold rounded-full border-0 px-2 py-0 h-[18px]">{pct}% OFF</Badge>
              )}
            </div>
          </div>
          {p.scholarship != null && p.scholarship > 0 && (
            <div className="shrink-0 border border-emerald-200 dark:border-emerald-800/50 bg-emerald-50 dark:bg-emerald-950/30 rounded-xl px-3 py-2 text-center min-w-[76px]">
              <Award className="w-4 h-4 text-emerald-600 dark:text-emerald-400 mx-auto" />
              <p className="text-[9px] text-muted-foreground font-medium mt-0.5">{t("courseFinderPage.scholarship")}:</p>
              <p className="text-[13px] font-extrabold text-emerald-700 dark:text-emerald-400 leading-tight">{formatCurrency(p.scholarship, cur)}</p>
            </div>
          )}
        </div>

        {/* Deposit strip */}
        {p.depositFee != null && p.depositFee > 0 && (
          <div className="flex items-center gap-2 bg-indigo-50 dark:bg-indigo-950/30 border border-indigo-200/60 dark:border-indigo-700/30 rounded-lg px-3 py-2 text-[11px] text-indigo-700 dark:text-indigo-400 font-medium">
            <Shield className="w-3.5 h-3.5 shrink-0" />
            {t("courseFinderPage.depositStrip", { fee: formatCurrency(p.depositFee, cur) })}
          </div>
        )}

        {/* Metadata 3-col grid */}
        <div className="grid grid-cols-3 gap-2 bg-muted/40 rounded-xl p-3">
          {p.degree && (
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="flex items-center gap-1 text-[9px] text-muted-foreground font-medium">
                <GraduationCap className="w-3 h-3 text-violet-500 shrink-0" />{t("courseFinderPage.degree")}
              </span>
              <span className="text-[11px] font-bold truncate">{p.degree}</span>
            </div>
          )}
          {p.field && (
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="flex items-center gap-1 text-[9px] text-muted-foreground font-medium">
                <BookOpen className="w-3 h-3 text-orange-500 shrink-0" />{t("courseFinderPage.field")}
              </span>
              <span className="text-[11px] font-bold truncate">{p.field}</span>
            </div>
          )}
          {p.language && (
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="flex items-center gap-1 text-[9px] text-muted-foreground font-medium">
                <Languages className="w-3 h-3 text-blue-500 shrink-0" />{t("courseFinderPage.language")}
              </span>
              <span className="text-[11px] font-bold truncate">{p.language}</span>
            </div>
          )}
          {p.duration && (
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="flex items-center gap-1 text-[9px] text-muted-foreground font-medium">
                <Clock className="w-3 h-3 text-green-500 shrink-0" />{t("courseFinderPage.duration")}
              </span>
              <span className="text-[11px] font-bold truncate">{p.duration}</span>
            </div>
          )}
          {p.intakes && (
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="flex items-center gap-1 text-[9px] text-muted-foreground font-medium">
                <Calendar className="w-3 h-3 text-indigo-500 shrink-0" />{t("courseFinderPage.intakes")}
              </span>
              <span className="text-[11px] font-bold truncate">{p.intakes}</span>
            </div>
          )}
          {p.languageFee != null && p.languageFee > 0 && (
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="flex items-center gap-1 text-[9px] text-muted-foreground font-medium">
                <DollarSign className="w-3 h-3 text-pink-500 shrink-0" />{t("courseFinderPage.languageFee")}
              </span>
              <span className="text-[11px] font-bold truncate">{formatCurrency(p.languageFee, cur)}{p.feeType ? ` (${p.feeType})` : ""}</span>
            </div>
          )}
          {(showCommission || showServiceFee) && (
            <div className={cn(
              "grid gap-2 min-w-0 col-span-3 pt-2 mt-0.5 border-t border-dashed border-muted-foreground/20",
              showCommission ? (showServiceFee ? "grid-cols-3" : "grid-cols-2") : "grid-cols-1",
            )}>
              {showCommission && (
                <>
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="flex items-center gap-1 text-[9px] text-indigo-600 dark:text-indigo-400 font-medium">
                      <Award className="w-3 h-3 shrink-0" />{t("courseFinderPage.commission")}
                    </span>
                    <span className="text-[13px] font-extrabold text-indigo-600 dark:text-indigo-400 truncate">{formatCurrency(commissionAmount, cur)}</span>
                  </div>
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="flex items-center gap-1 text-[9px] text-muted-foreground font-medium">
                      <FileText className="w-3 h-3 shrink-0" />{t("courseFinderPage.appFee")}
                    </span>
                    <span className="text-[13px] font-extrabold truncate">{formatCurrency(p.applicationFee, cur)}</span>
                  </div>
                </>
              )}
              {showServiceFee && (
                <div className="flex flex-col gap-0.5 min-w-0">
                  <span className="flex items-center gap-1 text-[9px] text-amber-600 dark:text-amber-400 font-medium">
                    <DollarSign className="w-3 h-3 shrink-0" />{t("catalogPage.serviceFee")}
                  </span>
                  <span className="text-[13px] font-extrabold text-amber-600 dark:text-amber-400 truncate">{formatCurrency(p.serviceFeeAmount, cur)}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Bottom actions ── */}
      <div className="flex items-center gap-2 px-4 py-3 border-t border-border/60">
        <button
          onClick={onInfo}
          className="w-9 h-9 rounded-full border-2 border-border/60 flex items-center justify-center text-muted-foreground hover:border-primary/40 hover:text-primary hover:bg-primary/5 transition-all shrink-0"
          aria-label="Details"
        >
          <Info className="w-4 h-4" />
        </button>
        <button
          onClick={onApply}
          className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-sm font-bold bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          {t("courseFinderPage.apply")} →
        </button>
      </div>
    </div>
    </>
  );
}

function UniversityInfoDialog({ program: p, onClose }: {
  program: Program | null;
  onClose: () => void;
}) {
  const { user } = useAuth(true);
  const canSeeContacts = !!user && ["super_admin", "admin", "manager", "staff", "consultant", "editor", "accountant"].includes(user.role);
  if (!p) return null;
  const websiteUrl = ensureUrl(p.universityWebsite);

  return (
    <>
    <Dialog open={!!p} onOpenChange={o => !o && onClose()}>
      <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-y-auto overflow-x-hidden p-0">
        {/* Header: logo + name + badges in one tight row */}
        <DialogHeader className="space-y-0 px-6 pt-6 pb-4 border-b">
          <div className="flex items-start gap-4">
            <div className="w-16 h-16 rounded-xl bg-muted/40 border flex items-center justify-center overflow-hidden shrink-0">
              {p.universityLogoUrl ? (
                <img
                  src={p.universityLogoUrl}
                  alt={p.universityName}
                  loading="lazy"
                  className="w-full h-full object-contain p-1.5"
                />
              ) : (
                <Building2 className="w-8 h-8 text-muted-foreground" />
              )}
            </div>
            <div className="min-w-0 flex-1 pt-0.5">
              <DialogTitle className="text-lg leading-snug font-semibold pr-8">{p.universityName}</DialogTitle>
              <div className="flex flex-wrap items-center gap-1.5 mt-2">
                {p.universityStatus && (
                  <Badge variant="outline" className={`text-[11px] h-5 px-2 ${p.universityStatus === "open" ? "border-emerald-300 text-emerald-700 bg-emerald-50" : "border-amber-300 text-amber-700 bg-amber-50"}`}>
                    <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1 ${p.universityStatus === "open" ? "bg-emerald-500" : "bg-amber-500"}`} />
                    {p.universityStatus === "open" ? "Open for Applications" : "Closed"}
                  </Badge>
                )}
                {p.universityType && <Badge variant="secondary" className="text-[11px] h-5 px-2 capitalize">{p.universityType}</Badge>}
                {(p.universityCountry || p.universityCity) && (
                  <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                    <MapPin className="w-3 h-3" />
                    {[p.universityCity, p.universityCountry].filter(Boolean).join(", ")}
                  </span>
                )}
              </div>
            </div>
          </div>
        </DialogHeader>

        <div className="px-6 py-5 space-y-5">
          {p.universityDescription && (
            <p className="text-sm text-muted-foreground leading-relaxed">{p.universityDescription}</p>
          )}

          {/* Rankings */}
          {(p.universityQsRanking || p.universityTimesRanking || p.universityShanghaiRanking || p.universityCwtsLeidenRanking) && (
            <div>
              <h4 className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium flex items-center gap-1.5 mb-2">
                <Award className="w-3.5 h-3.5" /> World Rankings
              </h4>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {p.universityQsRanking && (
                  <div className="bg-muted/40 border rounded-lg px-3 py-2">
                    <p className="text-base font-bold text-primary leading-none">#{p.universityQsRanking}</p>
                    <p className="text-[10px] text-muted-foreground font-medium mt-1">QS World</p>
                  </div>
                )}
                {p.universityTimesRanking && (
                  <div className="bg-muted/40 border rounded-lg px-3 py-2">
                    <p className="text-base font-bold text-primary leading-none">#{p.universityTimesRanking}</p>
                    <p className="text-[10px] text-muted-foreground font-medium mt-1">Times HE</p>
                  </div>
                )}
                {p.universityShanghaiRanking && (
                  <div className="bg-muted/40 border rounded-lg px-3 py-2">
                    <p className="text-base font-bold text-primary leading-none">#{p.universityShanghaiRanking}</p>
                    <p className="text-[10px] text-muted-foreground font-medium mt-1">Shanghai</p>
                  </div>
                )}
                {p.universityCwtsLeidenRanking && (
                  <div className="bg-muted/40 border rounded-lg px-3 py-2">
                    <p className="text-base font-bold text-primary leading-none">#{p.universityCwtsLeidenRanking}</p>
                    <p className="text-[10px] text-muted-foreground font-medium mt-1">CWTS Leiden</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Contact */}
          {canSeeContacts && (p.universityContactName || p.universityContactEmail || p.universityContactPhone) && (
            <div>
              <h4 className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium flex items-center gap-1.5 mb-2">
                <User className="w-3.5 h-3.5" /> Contact Person
              </h4>
              <div className="bg-muted/40 border rounded-lg p-3 space-y-1.5">
                {p.universityContactName && (
                  <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                    <User className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    <span>{p.universityContactName}</span>
                  </div>
                )}
                {p.universityContactEmail && (
                  <a href={`mailto:${p.universityContactEmail}`} className="flex items-center gap-2 text-sm text-primary hover:underline">
                    <Mail className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate">{p.universityContactEmail}</span>
                  </a>
                )}
                {p.universityContactPhone && (
                  <a href={`tel:${p.universityContactPhone}`} className="flex items-center gap-2 text-sm text-primary hover:underline">
                    <Phone className="w-3.5 h-3.5 shrink-0" />
                    <span>{p.universityContactPhone}</span>
                  </a>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Sticky footer CTA */}
        {websiteUrl && (
          <div className="px-6 py-4 border-t bg-muted/20">
            <a
              href={websiteUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 w-full py-2.5 bg-primary text-primary-foreground rounded-lg text-sm font-semibold hover:bg-primary/90 transition-colors"
            >
              <ExternalLink className="w-4 h-4" /> Visit University Website
            </a>
          </div>
        )}
      </DialogContent>
    </Dialog>
    </>
  );
}

function ProgramInfoDialog({ program: p, onClose, showCommission, agentShareRate, showApplicationFee = false, showServiceFee = false }: {
  program: Program | null;
  onClose: () => void;
  showCommission: boolean;
  agentShareRate?: number | null;
  showApplicationFee?: boolean;
  showServiceFee?: boolean;
}) {
  const { t } = useI18n();
  if (!p) return null;
  const hasDiscount = p.discountedFee != null && p.tuitionFee != null && p.discountedFee < p.tuitionFee;
  const cur = p.currency ?? "USD";
  const commissionAmount = calcCommissionAmount(p, agentShareRate);

  const sections: { title: string; icon: typeof GraduationCap; items: { label: string; value: string | null | undefined; highlight?: string }[] }[] = [
    {
      title: "Program Details",
      icon: GraduationCap,
      items: [
        { label: "Program Name", value: p.name },
        { label: "Degree / Level", value: p.degree },
        { label: "Field of Study", value: p.field },
        { label: "Language", value: p.language },
        { label: "Duration", value: p.duration },
        { label: "Intakes", value: p.intakes },
      ],
    },
    {
      title: "University",
      icon: Building2,
      items: [
        { label: "University", value: p.universityName },
        { label: "Country", value: p.universityCountry },
        { label: "City", value: p.universityCity },
        { label: "Type", value: p.universityType },
        { label: "Status", value: p.universityStatus },
      ],
    },
    {
      title: "Fees & Finance",
      icon: DollarSign,
      items: [
        { label: "Tuition Fee", value: formatCurrency(p.tuitionFee, cur) },
        ...(p.feeType ? [{ label: "Fee Type", value: p.feeType }] : []),
        ...(hasDiscount ? [{ label: "Discounted Fee", value: formatCurrency(p.discountedFee, cur), highlight: "amber" }] : []),
        ...(showApplicationFee ? [{ label: "Application Fee", value: formatCurrency(p.applicationFee, cur) }] : []),
        { label: "Deposit Fee", value: formatCurrency(p.depositFee, cur) },
        { label: "Advanced Fee", value: formatCurrency(p.advancedFee, cur) },
        { label: "Language Fee", value: formatCurrency(p.languageFee, cur) },
        ...(showServiceFee ? [{ label: "Service Fee", value: formatCurrency(p.serviceFeeAmount, cur) }] : []),
        ...(p.scholarship != null && p.scholarship > 0 ? [{ label: "Scholarship", value: formatCurrency(p.scholarship, cur), highlight: "green" }] : []),
        ...(showCommission && commissionAmount != null ? [{ label: "Commission", value: formatCurrency(commissionAmount, cur), highlight: "indigo" }] : []),
      ],
    },
  ];

  return (
    <>
    <Dialog open={!!p} onOpenChange={o => !o && onClose()}>
      <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-start gap-3">
            <div className="w-14 h-14 rounded-xl border-2 border-muted bg-white flex items-center justify-center overflow-hidden shrink-0">
              {p.universityLogoUrl ? (
                <img src={p.universityLogoUrl} alt={p.universityName} width={40} height={40} loading="lazy" className="w-full h-full object-contain p-1" />
              ) : (
                <Building2 className="w-7 h-7 text-muted-foreground" />
              )}
            </div>
            <div>
              <p className="text-sm text-muted-foreground">{p.universityName}</p>
              <DialogTitle className="text-lg">{p.name}</DialogTitle>
              <div className="flex gap-1.5 mt-1.5">
                {p.degree && <Badge variant="secondary" className="text-xs">{p.degree}</Badge>}
                {hasDiscount && <Badge className="text-xs bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-300 dark:border-emerald-700/60">Discounted</Badge>}
                {p.universityStatus && (
                  <Badge variant="outline" className={`text-xs ${p.universityStatus === "open" ? "border-emerald-300 text-emerald-700" : "border-amber-300 text-amber-700"}`}>
                    {p.universityStatus}
                  </Badge>
                )}
              </div>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-5 mt-2">
          {sections.map((section) => (
            <div key={section.title}>
              <div className="flex items-center gap-2 mb-2">
                <section.icon className="w-4 h-4 text-primary" />
                <h3 className="font-semibold text-sm">{section.title}</h3>
              </div>
              <div className="bg-muted/30 rounded-xl p-3 space-y-1.5">
                {section.items.filter(item => item.value && item.value !== "—").map((item, i) => (
                  <div key={i} className="flex justify-between text-sm">
                    <span className={item.highlight === "amber" ? "text-amber-600" : item.highlight === "indigo" ? "text-indigo-600" : item.highlight === "green" ? "text-emerald-600" : "text-muted-foreground"}>{item.label}</span>
                    <span className={`font-medium text-right max-w-[60%] ${item.highlight === "amber" ? "text-amber-600" : item.highlight === "indigo" ? "text-indigo-600 font-semibold" : item.highlight === "green" ? "text-emerald-600 font-semibold" : ""}`}>{item.value}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {p.description && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <FileText className="w-4 h-4 text-primary" />
                <h3 className="font-semibold text-sm">{t("common.description")}</h3>
              </div>
              <div className="bg-muted/30 rounded-xl p-3">
                <p className="text-sm text-muted-foreground whitespace-pre-wrap">{p.description}</p>
              </div>
            </div>
          )}

          {p.requirements && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <FileText className="w-4 h-4 text-primary" />
                <h3 className="font-semibold text-sm">Requirements</h3>
              </div>
              <div className="bg-muted/30 rounded-xl p-3">
                <p className="text-sm text-muted-foreground whitespace-pre-wrap">{p.requirements}</p>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
    </>
  );
}

type StudentOption = {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string | null;
  nationality?: string | null;
  agentId?: number | null;
  createdAt: string;
};

type AppLevel = "pathway" | "undergraduate" | "graduate" | "doctorate";
type LevelDoc = { key: string; label: string; icon: string; accept: string; required: boolean; note?: string };
type UploadedDoc = { key: string; label: string; file: File; mediaType: string; isImage: boolean; partCount?: number };

const LEVEL_DOCS: Record<AppLevel, LevelDoc[]> = {
  pathway: [
    { key: "passport", label: "Passport", icon: "🛂", accept: "image/*,.pdf", required: true },
    { key: "hs_diploma", label: "HS Diploma", icon: "🎓", accept: "image/*,.pdf", required: false },
    { key: "hs_transcript", label: "HS Transcript", icon: "📋", accept: "image/*,.pdf", required: false },
    { key: "photo", label: "Photograph", icon: "📷", accept: ".pdf,.jpg,.jpeg,.png", required: false },
  ],
  undergraduate: [
    { key: "hs_diploma", label: "HS Diploma", icon: "🎓", accept: "image/*,.pdf", required: true },
    { key: "hs_transcript", label: "HS Transcript", icon: "📋", accept: "image/*,.pdf", required: true },
    { key: "passport", label: "Passport", icon: "🛂", accept: "image/*,.pdf", required: true },
    { key: "photo", label: "Photograph", icon: "📷", accept: ".pdf,.jpg,.jpeg,.png", required: true },
    { key: "language_proof", label: "Language Proof", icon: "🌐", accept: "image/*,.pdf", required: false, note: "If available" },
  ],
  graduate: [
    { key: "bachelor_diploma", label: "Bachelor Diploma", icon: "🎓", accept: "image/*,.pdf", required: true },
    { key: "bachelor_transcript", label: "Bachelor Transcript", icon: "📋", accept: "image/*,.pdf", required: true },
    { key: "passport", label: "Passport", icon: "🛂", accept: "image/*,.pdf", required: true },
    { key: "photo", label: "Photograph", icon: "📷", accept: ".pdf,.jpg,.jpeg,.png", required: true },
    { key: "equivalency", label: "Equivalency Letter", icon: "📜", accept: "image/*,.pdf", required: false, note: "Recognition" },
    { key: "cv", label: "CV", icon: "📄", accept: "image/*,.pdf", required: false, note: "If required" },
    { key: "sop", label: "SOP", icon: "✍️", accept: "image/*,.pdf", required: false, note: "If required" },
    { key: "language_proof", label: "Language Proof", icon: "🌐", accept: "image/*,.pdf", required: false, note: "If available" },
  ],
  doctorate: [
    { key: "bachelor_diploma", label: "Bachelor Diploma", icon: "🎓", accept: "image/*,.pdf", required: true },
    { key: "bachelor_transcript", label: "Bachelor Transcript", icon: "📋", accept: "image/*,.pdf", required: true },
    { key: "master_diploma", label: "Master Diploma", icon: "🎓", accept: "image/*,.pdf", required: true },
    { key: "master_transcript", label: "Master Transcript", icon: "📋", accept: "image/*,.pdf", required: true },
    { key: "passport", label: "Passport", icon: "🛂", accept: "image/*,.pdf", required: true },
    { key: "photo", label: "Photograph", icon: "📷", accept: ".pdf,.jpg,.jpeg,.png", required: true },
    { key: "equivalency", label: "Equivalency Letter", icon: "📜", accept: "image/*,.pdf", required: false, note: "Recognition" },
    { key: "cv", label: "CV", icon: "📄", accept: "image/*,.pdf", required: false, note: "If required" },
    { key: "sop", label: "SOP", icon: "✍️", accept: "image/*,.pdf", required: false, note: "If required" },
    { key: "language_proof", label: "Language Proof", icon: "🌐", accept: "image/*,.pdf", required: false, note: "If available" },
  ],
};

function degreeToLevel(degree?: string | null): AppLevel {
  if (!degree) return "undergraduate";
  const d = degree.toLowerCase().replace(/['''`\s.]/g, "");
  if (d.includes("phd") || d.includes("doctor") || d.includes("doctorate")) return "doctorate";
  if (d.includes("master") || d.includes("graduate") || d.includes("msc") || d.includes("mba")) return "graduate";
  if (d.includes("pathway") || d.includes("prep") || d.includes("language") || d.includes("foundation")) return "pathway";
  return "undergraduate";
}

function compressImageCF(file: File, maxWidth = 1600, quality = 0.78): Promise<File> {
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
        canvas.toBlob((blob) => {
          if (!blob) { reject(new Error("compress failed")); return; }
          const newName = file.name.replace(/\.[^.]+$/, "") + ".jpg";
          resolve(new File([blob], newName, { type: "image/jpeg" }));
        }, "image/jpeg", quality);
      };
      img.onerror = reject;
      img.src = e.target?.result as string;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function prepareDocFile(file: File): Promise<{ file: File; mediaType: string; isImage: boolean }> {
  const isImage = file.type.startsWith("image/");
  if (isImage) {
    const compressed = await compressImageCF(file);
    return { file: compressed, mediaType: "image/jpeg", isImage: true };
  }
  return { file, mediaType: file.type || "application/pdf", isImage: false };
}

function ApplyDropZone({ docType, uploaded, onFile, onUpload, onRemove }: {
  docType: LevelDoc; uploaded?: UploadedDoc; onFile?: boolean;
  onUpload: (doc: UploadedDoc) => void; onRemove: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [merging, setMerging] = useState(false);
  const { t } = useI18n();
  const { toast } = useToast();

  async function handleFiles(files: File[]) {
    if (files.length === 0) return;
    const currentPartCount = uploaded?.partCount || (uploaded ? 1 : 0);
    if (isSingleImageDocumentType(docType.key) && (uploaded || files.length > 1)) {
      toast({ title: "Photograph accepts one file", description: "Remove the current photograph before choosing another PDF or image.", variant: "destructive" });
      return;
    }
    if (currentPartCount + files.length > MAX_DOCUMENT_PARTS) {
      toast({ title: "Too many document parts", description: `You can combine up to ${MAX_DOCUMENT_PARTS} parts in one document box.`, variant: "destructive" });
      return;
    }
    for (const file of files) {
      const validation = validateApplicationDocumentFileObj(file);
      if (!validation.valid) {
        toast({ title: t("apply.fileError"), description: validation.message, variant: "destructive" });
        return;
      }
    }
    setMerging(true);
    try {
      const prepared = await Promise.all(files.map(prepareDocFile));
      if (!uploaded && prepared.length === 1) {
        onUpload({ key: docType.key, label: docType.label, ...prepared[0], partCount: 1 });
        return;
      }
      const merged = await mergeDocumentParts({
        documentType: docType.key,
        label: docType.label,
        parts: [
          ...(uploaded ? [{ file: uploaded.file, mediaType: uploaded.mediaType }] : []),
          ...prepared.map((item) => ({ file: item.file, mediaType: item.mediaType })),
        ],
      });
      onUpload({ key: docType.key, label: docType.label, file: merged.file, mediaType: merged.mediaType, isImage: false, partCount: currentPartCount + files.length });
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
      <>
      <div className="relative flex flex-col items-center gap-1 p-2.5 border-2 border-green-300 bg-green-50 rounded-xl text-center min-h-[100px] justify-center">
        <button type="button" onClick={onRemove} className="absolute top-1.5 right-1.5 w-5 h-5 bg-destructive/10 hover:bg-destructive/20 text-destructive rounded-full flex items-center justify-center">
          <X className="w-3 h-3" />
        </button>
        <CheckCircle2 className="w-5 h-5 text-green-500" />
        <p className="text-[10px] font-semibold text-foreground truncate max-w-[80px]">{uploaded.file.name}</p>
        {(uploaded.partCount || 1) > 1 && <p className="text-[9px] font-medium text-green-700">{uploaded.partCount} parts combined</p>}
        <span className="text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded-full font-medium">{docType.label}</span>
        {!isSingleImageDocumentType(docType.key) && (
          <div className="flex items-center gap-2">
            <button type="button" disabled={merging} onClick={() => inputRef.current?.click()} className="text-[9px] font-semibold text-primary hover:underline disabled:opacity-50">
              {merging ? "Combining..." : "+ Add part"}
            </button>
            <button type="button" disabled={merging} onClick={() => setScannerOpen(true)} className="text-[9px] font-semibold text-primary hover:underline disabled:opacity-50">Scan</button>
          </div>
        )}
        <input ref={inputRef} type="file" multiple={!isSingleImageDocumentType(docType.key)} accept={docType.accept} className="hidden"
          onChange={(e) => { void handleFiles(Array.from(e.target.files || [])); e.target.value = ""; }} />
        {scannerOpen && (
          <Suspense fallback={null}>
            <LazyDocumentScanner open onClose={() => setScannerOpen(false)} baseName={docType.key} onCapture={handleFile} />
          </Suspense>
        )}
      </div>
      </>
    );
  }

  const requiredBadge = onFile
    ? <span className="text-[9px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full font-semibold border border-green-200 dark:bg-green-900/40 dark:text-green-300 dark:border-green-700/60">On file</span>
    : docType.required
    ? <span className="text-[9px] bg-rose-100 text-rose-600 px-1.5 py-0.5 rounded-full font-semibold border border-rose-200 dark:bg-rose-900/40 dark:text-rose-300 dark:border-rose-700/60">Required</span>
    : <span className="text-[9px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded-full font-medium border border-gray-200 dark:bg-gray-800/50 dark:text-gray-300 dark:border-gray-600/50">Optional</span>;

  return (
    <>
    <div
      className={cn(
        "flex flex-col items-center gap-1 p-2.5 border-2 border-dashed rounded-xl text-center cursor-pointer min-h-[100px] justify-center transition-all",
        dragging ? "border-primary bg-primary/10"
          : onFile ? "border-green-300 bg-green-50/40 hover:border-green-400"
          : docType.required ? "border-rose-200 hover:border-rose-400 hover:bg-rose-50/50" : "border-border hover:border-primary/50 hover:bg-secondary/50"
      )}
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); void handleFiles(Array.from(e.dataTransfer.files)); }}
    >
      <span className="text-xl">{docType.icon}</span>
      <p className="text-[10px] font-semibold text-foreground leading-tight">{docType.label}</p>
      {docType.note && <p className="text-[9px] text-muted-foreground leading-tight">{docType.note}</p>}
      <div className="mt-0.5">{requiredBadge}</div>
      <input ref={inputRef} type="file" multiple={!isSingleImageDocumentType(docType.key)} accept={docType.accept} className="hidden"
        onChange={(e) => { void handleFiles(Array.from(e.target.files || [])); e.target.value = ""; }}
      />
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setScannerOpen(true); }}
        className="mt-0.5 inline-flex items-center gap-1 text-[9px] font-medium text-primary hover:underline"
      >
        <Camera className="w-3 h-3" /> {t("scanner.scanWithCamera")}
      </button>
      {scannerOpen && (
        <Suspense fallback={null}>
          <LazyDocumentScanner
            open
            onClose={() => setScannerOpen(false)}
            baseName={docType.key}
            onCapture={handleFile}
          />
        </Suspense>
      )}
    </div>
    </>
  );
}

function ApplyDialog({ program: p, onClose, currentUser, agentShareRate, hideServiceFee = false, showCommission = false }: { program: Program | null; onClose: () => void; currentUser: any; agentShareRate?: number | null | undefined; hideServiceFee?: boolean; showCommission?: boolean }) {
  const { t } = useI18n();
  const isStudentUser = currentUser?.role === "student";
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedStudent, setSelectedStudent] = useState<StudentOption | null>(null);
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [step, setStep] = useState<"select" | "new_student" | "documents">("select");
  const [docs, setDocs] = useState<Record<string, UploadedDoc>>({});
  const [submittedDocumentCount, setSubmittedDocumentCount] = useState(0);
  const [newStudentForm, setNewStudentForm] = useState({ firstName: "", lastName: "", email: "", phone: "", nationality: "" });
  const [creatingStudent, setCreatingStudent] = useState(false);

  // A signed-in student's auth user id and students.id are separate keys.
  // Resolve (or lazily create) the actual student profile before loading or
  // registering documents; using currentUser.id here made existing files look
  // missing and caused uploads to be rejected as belonging to another student.
  const { data: selfStudentProfile } = useQuery<any>({
    queryKey: ["course-finder-self-student", currentUser?.id],
    queryFn: async () => {
      try {
        return await apiFetch(`${BASE_URL}/api/students/me`);
      } catch (error) {
        if (!(error instanceof CourseFinderApiError) || error.status !== 404) throw error;
        return apiFetch(`${BASE_URL}/api/students/me`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
      }
    },
    enabled: isStudentUser && !!p && !!currentUser?.id,
    staleTime: 30_000,
  });

  const level = p ? degreeToLevel(p.degree) : "undergraduate";
  // Pull program-specific document requirements from the catalog. Falls
  // back to the legacy degree-level LEVEL_DOCS only when the program has
  // no requirements configured (so unconfigured programs still show
  // something instead of an empty list).
  const { data: programReqs = [], isFetched: programReqsFetched } = useProgramDocRequirements(p?.id);
  const resolveDocMeta = useResolveDocMeta();
  const currentDocs: LevelDoc[] = useMemo(() => {
    if (programReqsFetched && programReqs.length > 0) {
      return [...programReqs]
        .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
        .map(req => {
          const meta = resolveDocMeta(req.documentType);
          return {
            key: meta.key,
            label: meta.label,
            icon: meta.icon,
            accept: meta.accept,
            required: !!req.mandatory,
          };
        });
    }
    return LEVEL_DOCS[level];
  }, [programReqs, programReqsFetched, level, resolveDocMeta]);
  const requiredDocKeys = currentDocs.filter(d => d.required).map(d => d.key);

  // Documents the selected student already has on file satisfy required
  // doc slots via type-equivalence, so staff aren't forced to re-upload
  // documents already stored on the student's profile.
  const { data: existingStudentDocs = [] } = useQuery<any[]>({
    queryKey: ["apply-existing-docs", selectedStudent?.id],
    queryFn: () => apiFetch(`${BASE_URL}/api/documents?studentId=${selectedStudent!.id}`),
    enabled: !!p && !!selectedStudent?.id,
    staleTime: 30_000,
  });
  const existingDocTypes = useMemo(
    () => new Set<string>(
      existingStudentDocs
        .filter((d) => String(d.status || "").toLowerCase() !== "rejected")
        .map((d) => (d.type || "").toLowerCase()),
    ),
    [existingStudentDocs],
  );
  const onFileSatisfiedKeys = useMemo(() => {
    const set = new Set<string>();
    for (const k of requiredDocKeys) {
      if (findMissingMandatoryTypes([k], existingDocTypes).length === 0) set.add(k);
    }
    return set;
  }, [requiredDocKeys, existingDocTypes]);
  const missingRequiredCount = requiredDocKeys.filter(k => !docs[k] && !onFileSatisfiedKeys.has(k)).length;
  const satisfiedRequiredCount = requiredDocKeys.length - missingRequiredCount;
  const allRequiredUploaded = missingRequiredCount === 0;

  const debouncedSearch = useMemo(() => searchTerm.trim(), [searchTerm]);

  useEffect(() => {
    if (isStudentUser && currentUser && selfStudentProfile?.id && p) {
      setSelectedStudent({
        id: selfStudentProfile.id,
        firstName: selfStudentProfile.firstName || currentUser.firstName || "",
        lastName: selfStudentProfile.lastName || currentUser.lastName || "",
        email: selfStudentProfile.email || currentUser.email || "",
        nationality: selfStudentProfile.nationality || null,
        createdAt: selfStudentProfile.createdAt || currentUser.createdAt || new Date().toISOString(),
      });
    }
  }, [isStudentUser, currentUser, selfStudentProfile, p]);

  const { data: recentStudents = [], isLoading: loadingRecent } = useQuery<StudentOption[]>({
    queryKey: ["apply-recent-students"],
    queryFn: () => apiFetch(`${BASE_URL}/api/course-finder/students?limit=3`),
    enabled: !!p && !isStudentUser,
    staleTime: 30_000,
  });

  const { data: searchResults = [], isLoading: loadingSearch } = useQuery<StudentOption[]>({
    queryKey: ["apply-search-students", debouncedSearch],
    queryFn: () => apiFetch(`${BASE_URL}/api/course-finder/students?search=${encodeURIComponent(debouncedSearch)}&limit=10`),
    enabled: !!p && !isStudentUser && debouncedSearch.length >= 2,
    staleTime: 10_000,
  });

  const studentsToShow = debouncedSearch.length >= 2 ? searchResults : recentStudents;
  const isSearching = debouncedSearch.length >= 2 ? loadingSearch : loadingRecent;

  function handleClose() {
    setSearchTerm("");
    setSelectedStudent(null);
    setNotes("");
    setSubmitting(false);
    setSuccess(false);
    setStep("select");
    setDocs({});
    setSubmittedDocumentCount(0);
    setNewStudentForm({ firstName: "", lastName: "", email: "", phone: "", nationality: "" });
    setCreatingStudent(false);
    onClose();
  }

  function handleNextToDocuments() {
    if (!selectedStudent) return;
    setStep("documents");
  }

  async function handleCreateAndContinue() {
    if (!newStudentForm.firstName.trim() || !newStudentForm.lastName.trim()) return;
    setCreatingStudent(true);
    try {
      const created = await apiFetch(`${BASE_URL}/api/students`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName: newStudentForm.firstName.trim(),
          lastName: newStudentForm.lastName.trim(),
          email: newStudentForm.email.trim() || undefined,
          phone: newStudentForm.phone.trim() || undefined,
          nationality: newStudentForm.nationality.trim() || undefined,
        }),
      });
      setSelectedStudent({
        id: created.id,
        firstName: created.firstName,
        lastName: created.lastName,
        email: created.email || "",
        nationality: created.nationality || null,
        createdAt: created.createdAt,
      });
      toast({ title: "Student registered", description: `${created.firstName} ${created.lastName} has been added to the system.` });
      setStep("documents");
    } catch (err: any) {
      toast({ title: "Registration failed", description: err.message || "Could not create student", variant: "destructive" });
    } finally {
      setCreatingStudent(false);
    }
  }

  async function saveDocumentsForStudent(studentId: number, studentFirstName: string, studentLastName: string): Promise<number[]> {
    const uploadedDocs = Object.values(docs);
    if (uploadedDocs.length === 0) return [];
    const savedDocumentIds: number[] = [];
    for (const d of uploadedDocs) {
      try {
        const docName = `${studentFirstName}-${studentLastName}-${d.label}`;
        // Always send the canonical doc-type key (e.g. `bachelors_certificate`,
        // `high_school_diploma_translation`) so it matches the program's
        // requirements stored in `program_document_requirements`. Falling back
        // to the (legacy) label-derived slug only if a key is somehow missing.
        let docType = d.key
          || (d.label ? d.label.toLowerCase().replace(/\s+/g, "_") : "other");
        if (docType === "photograph") docType = "photo";
        const { fileKey, mimeType, sizeBytes } = await uploadDocumentFile(d.file);
        const createdDocument = await createDocumentRecord({
          name: docName,
          type: docType,
          status: "pending",
          studentId,
          fileKey,
          mimeType,
          sizeBytes,
          originalFileName: d.file?.name ?? null,
        });
        savedDocumentIds.push(createdDocument.id);
      } catch (err: any) {
        console.error(`Document upload error for ${d.label}:`, err);
        throw new Error(`${d.label}: ${err?.message || "Document upload failed"}`);
      }
    }
    return savedDocumentIds;
  }

  async function handleSubmit() {
    if (!selectedStudent || !p) return;
    if (!allRequiredUploaded) return;
    setSubmitting(true);
    try {
      // Mandatory-document and portal-readiness gates inspect the student's
      // persisted library. Save selected files first, then tell the API which
      // new records should also be bound to the created application.
      const uploadedDocumentIds = await saveDocumentsForStudent(
        selectedStudent.id,
        selectedStudent.firstName,
        selectedStudent.lastName,
      );
      setSubmittedDocumentCount(uploadedDocumentIds.length);
      await apiFetch(`${BASE_URL}/api/course-finder/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentId: selectedStudent.id,
          programId: p.id,
          notes: notes || null,
          uploadedDocumentIds,
        }),
      });

      setSuccess(true);
      queryClient.invalidateQueries({ queryKey: ["applications"] });
      queryClient.invalidateQueries({ queryKey: ["students"] });
      queryClient.invalidateQueries({ queryKey: ["/api/documents"] });
      const docMsg = uploadedDocumentIds.length > 0
        ? t("courseFinderPage.withDocuments", { n: uploadedDocumentIds.length })
        : "";
      toast({ title: t("courseFinderPage.applicationCreated"), description: t("courseFinderPage.applicationCreatedDesc", { student: `${selectedStudent.firstName} ${selectedStudent.lastName}`, program: p.name, docs: docMsg }) });
      setTimeout(() => handleClose(), 1500);
    } catch (err: any) {
      toast({
        title: t("common.error"),
        description: applicationCreationErrorMessage(
          err,
          t("courseFinderPage.failedToCreateApplication"),
        ),
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  }

  if (!p) return null;

  const effectiveFee = p.discountedFee ?? p.tuitionFee;
  const cur = p.currency ?? "USD";
  const commissionAmount = calcCommissionAmount(p, agentShareRate);

  const levelLabel = level === "pathway" ? "Language / Prep" : level === "undergraduate" ? "Bachelor / Associate" : level === "graduate" ? "Master's Degree" : "Doctorate (PhD)";

  return (
    <>
    <Dialog open={!!p} onOpenChange={o => !o && handleClose()}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-lg">{t("courseFinderPage.createApplication")}</DialogTitle>
        </DialogHeader>

        {success ? (
          <div className="flex flex-col items-center py-8 gap-3">
            <div className="w-16 h-16 rounded-full bg-emerald-100 flex items-center justify-center">
              <Check className="w-8 h-8 text-emerald-600" />
            </div>
            <p className="text-lg font-semibold text-emerald-700">Application Created!</p>
            <p className="text-sm text-muted-foreground text-center">
              {isStudentUser ? "Your application has been submitted for review." : "Application, commission and service fee records have been created automatically."}
            </p>
            {submittedDocumentCount > 0 && (
              <p className="text-xs text-muted-foreground">{submittedDocumentCount} document{submittedDocumentCount !== 1 ? "s" : ""} uploaded successfully.</p>
            )}
          </div>
        ) : (
          <div className="space-y-5">
            <div className="bg-muted/40 rounded-xl p-3 space-y-1.5">
              <p className="font-semibold text-sm">{p.name}</p>
              <p className="text-xs text-muted-foreground">{p.universityName} — {p.universityCountry}</p>
              <div className="flex flex-wrap gap-2 mt-2">
                {effectiveFee != null && (
                  <Badge variant="outline" className="text-xs">{formatCurrency(effectiveFee, cur)}</Badge>
                )}
                {p.feeType && (
                  <Badge variant="outline" className="text-xs">{p.feeType}</Badge>
                )}
                {p.scholarship != null && p.scholarship > 0 && (
                  <Badge className="text-xs bg-emerald-100 text-emerald-700 border-0 dark:bg-emerald-900/40 dark:text-emerald-300">Scholarship: {formatCurrency(p.scholarship, cur)}</Badge>
                )}
                {!isStudentUser && showCommission && commissionAmount != null && (
                  <Badge className="text-xs bg-indigo-100 text-indigo-700 border-0 dark:bg-indigo-900/40 dark:text-indigo-300">Commission: {formatCurrency(commissionAmount, cur)}</Badge>
                )}
                {!isStudentUser && !hideServiceFee && p.serviceFeeAmount != null && p.serviceFeeAmount > 0 && (
                  <Badge className="text-xs bg-amber-100 text-amber-700 border-0 dark:bg-amber-900/40 dark:text-amber-300">Service Fee: {formatCurrency(p.serviceFeeAmount, cur)}</Badge>
                )}
              </div>
            </div>

            {step === "select" && (
              <>
                {isStudentUser ? (
                  <div className="bg-muted/30 rounded-xl p-3 flex items-center gap-3">
                    <div className="w-9 h-9 rounded-full bg-primary flex items-center justify-center text-xs font-bold text-white shrink-0">
                      {(currentUser?.firstName?.[0] || "").toUpperCase()}{(currentUser?.lastName?.[0] || "").toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{currentUser?.firstName} {currentUser?.lastName}</p>
                      <p className="text-xs text-muted-foreground truncate">{currentUser?.email}</p>
                    </div>
                    <Check className="w-4 h-4 text-primary shrink-0" />
                  </div>
                ) : (
                  <div>
                    <Label className="text-sm font-medium mb-2 block">{t("courseFinderPage.selectStudent")}</Label>
                    <div className="relative mb-3">
                      <UserSearch className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      <Input
                        placeholder={t("courseFinderPage.searchByNameEmailPhone")}
                        value={searchTerm}
                        onChange={e => { setSearchTerm(e.target.value); setSelectedStudent(null); }}
                        className="pl-10 rounded-lg"
                      />
                    </div>
                    {!debouncedSearch && recentStudents.length > 0 && (
                      <p className="text-[11px] text-muted-foreground mb-2 uppercase tracking-wide font-medium">{t("courseFinderPage.recentStudents")}</p>
                    )}
                    <div className="space-y-1.5 max-h-52 overflow-y-auto">
                      {isSearching ? (
                        <div className="flex items-center justify-center py-6 gap-2 text-muted-foreground">
                          <Loader2 className="w-4 h-4 animate-spin" />
                          <span className="text-sm">Searching...</span>
                        </div>
                      ) : studentsToShow.length === 0 ? (
                        <div className="text-center py-6 text-muted-foreground">
                          <User className="w-8 h-8 mx-auto mb-2 opacity-40" />
                          <p className="text-sm">{debouncedSearch.length >= 2 ? "No students found" : "No students yet"}</p>
                        </div>
                      ) : (
                        studentsToShow.map(s => {
                          const isSelected = selectedStudent?.id === s.id;
                          return (
                            <button
                              key={s.id}
                              onClick={() => setSelectedStudent(isSelected ? null : s)}
                              className={`w-full text-left p-3 rounded-lg border transition-all ${
                                isSelected ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-muted hover:border-primary/30 hover:bg-muted/40"
                              }`}
                            >
                              <div className="flex items-center gap-3">
                                <div className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                                  isSelected ? "bg-primary text-white" : "bg-muted text-muted-foreground"
                                }`}>
                                  {(s.firstName?.[0] || "").toUpperCase()}{(s.lastName?.[0] || "").toUpperCase()}
                                </div>
                                <div className="min-w-0 flex-1">
                                  <p className="text-sm font-medium truncate">{s.firstName} {s.lastName}</p>
                                  <p className="text-xs text-muted-foreground truncate">{s.email}</p>
                                </div>
                                {s.nationality && <Badge variant="outline" className="text-[10px] shrink-0">{s.nationality}</Badge>}
                                {isSelected && <Check className="w-4 h-4 text-primary shrink-0" />}
                              </div>
                            </button>
                          );
                        })
                      )}
                    </div>
                  </div>
                )}
                <Button onClick={handleNextToDocuments} disabled={!selectedStudent} className="w-full rounded-xl h-11">
                  <FileText className="w-4 h-4 mr-2" /> Continue to Documents
                </Button>

                <div className="relative my-1">
                  <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-border" /></div>
                  <div className="relative flex justify-center"><span className="bg-background px-2 text-[11px] text-muted-foreground uppercase tracking-wide">or</span></div>
                </div>
                <Button
                  variant="outline"
                  className="w-full rounded-xl h-10 text-sm"
                  onClick={() => { setSelectedStudent(null); setSearchTerm(""); setStep("new_student"); }}
                >
                  <UserPlus className="w-4 h-4 mr-2" /> Register New Student
                </Button>
              </>
            )}

            {step === "new_student" && (
              <>
                <div className="flex items-center gap-2 mb-1">
                  <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                    <UserPlus className="w-4 h-4 text-primary" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-foreground">Register New Student</p>
                    <p className="text-xs text-muted-foreground">They will be registered and applied to this course immediately.</p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs font-medium mb-1 block">First Name <span className="text-destructive">*</span></Label>
                    <Input
                      value={newStudentForm.firstName}
                      onChange={e => setNewStudentForm(s => ({ ...s, firstName: e.target.value }))}
                      placeholder="First name"
                      className="rounded-lg h-9"
                    />
                  </div>
                  <div>
                    <Label className="text-xs font-medium mb-1 block">Last Name <span className="text-destructive">*</span></Label>
                    <Input
                      value={newStudentForm.lastName}
                      onChange={e => setNewStudentForm(s => ({ ...s, lastName: e.target.value }))}
                      placeholder="Last name"
                      className="rounded-lg h-9"
                    />
                  </div>
                </div>

                <div>
                  <Label className="text-xs font-medium mb-1 block">Email</Label>
                  <Input
                    type="email"
                    value={newStudentForm.email}
                    onChange={e => setNewStudentForm(s => ({ ...s, email: e.target.value }))}
                    placeholder="student@example.com"
                    className="rounded-lg h-9"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs font-medium mb-1 block">Phone</Label>
                    <Input
                      value={newStudentForm.phone}
                      onChange={e => setNewStudentForm(s => ({ ...s, phone: e.target.value }))}
                      placeholder="+90 5xx xxx xx xx"
                      className="rounded-lg h-9"
                    />
                  </div>
                  <div>
                    <Label className="text-xs font-medium mb-1 block">Nationality</Label>
                    <Input
                      value={newStudentForm.nationality}
                      onChange={e => setNewStudentForm(s => ({ ...s, nationality: e.target.value }))}
                      placeholder="e.g. Turkish"
                      className="rounded-lg h-9"
                    />
                  </div>
                </div>

                <div className="flex gap-3">
                  <Button variant="outline" onClick={() => setStep("select")} className="rounded-xl h-11">
                    <ChevronLeft className="w-4 h-4 mr-1" /> Back
                  </Button>
                  <Button
                    onClick={handleCreateAndContinue}
                    disabled={!newStudentForm.firstName.trim() || !newStudentForm.lastName.trim() || creatingStudent}
                    className="flex-1 rounded-xl h-11"
                  >
                    {creatingStudent
                      ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Registering...</>
                      : <><UserPlus className="w-4 h-4 mr-2" /> Register &amp; Continue to Documents</>
                    }
                  </Button>
                </div>
              </>
            )}

            {step === "documents" && (
              <>
                <div className="bg-muted/40 border border-muted rounded-xl p-3 flex items-start gap-3">
                  <FileText className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
                  <div>
                    <p className="text-sm font-semibold text-foreground">{t("courseFinderPage.documentUploadTitle")}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {t("courseFinderPage.documentUploadSubtitle", { level: levelLabel })}
                    </p>
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-sm font-semibold text-foreground">{t("courseFinderPage.requiredDocuments")}</p>
                    <p className="text-xs text-muted-foreground">{t("courseFinderPage.uploadedCount", { n: satisfiedRequiredCount, total: requiredDocKeys.length })}</p>
                  </div>
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-900/60 dark:bg-amber-950/20">
                    <p className="text-[11px] text-amber-900 dark:text-amber-200">{APPLICATION_DOCUMENT_HELP_TEXT}</p>
                    <Badge variant="outline" className="border-amber-500 bg-background text-[10px] font-bold text-amber-800 dark:text-amber-200">MAX 5 MB / FILE</Badge>
                  </div>
                  <div className={cn(
                    "grid gap-2",
                    currentDocs.length <= 5 ? "grid-cols-5" : currentDocs.length <= 7 ? "grid-cols-4" : "grid-cols-3"
                  )}>
                    {currentDocs.map((dt) => (
                      <ApplyDropZone
                        key={dt.key}
                        docType={dt}
                        uploaded={docs[dt.key]}
                        onFile={onFileSatisfiedKeys.has(dt.key)}
                        onUpload={(doc) => setDocs((d) => ({ ...d, [dt.key]: doc }))}
                        onRemove={() => setDocs((d) => { const n = { ...d }; delete n[dt.key]; return n; })}
                      />
                    ))}
                  </div>
                </div>

                <div>
                  <p className="text-sm font-semibold text-foreground mb-2">{t("courseFinderPage.noteOptional")}</p>
                  <Textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    rows={3}
                    className="rounded-xl resize-none"
                  />
                </div>

                <div className="flex gap-3">
                  <Button variant="outline" onClick={() => setStep("select")} className="rounded-xl h-11">
                    <ChevronLeft className="w-4 h-4 mr-1" /> Back
                  </Button>
                  <Button
                    onClick={handleSubmit}
                    disabled={submitting || !allRequiredUploaded}
                    className="flex-1 rounded-xl h-11"
                  >
                    {submitting ? (
                      <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> {isStudentUser ? t("courseFinderPage.submitting") : t("courseFinderPage.creating")}</>
                    ) : !allRequiredUploaded ? (
                      <><Send className="w-4 h-4 mr-2" /> {t("courseFinderPage.uploadRequiredRemaining", { count: missingRequiredCount })}</>
                    ) : (
                      <><Send className="w-4 h-4 mr-2" /> {isStudentUser ? t("courseFinderPage.submitApplication") : t("courseFinderPage.createApplication")}</>
                    )}
                  </Button>
                </div>
              </>
            )}

          </div>
        )}
      </DialogContent>
    </Dialog>
    </>
  );
}
