import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { Link, useLocation } from "wouter";
import { QuickContactDialog } from "@/components/QuickContact";
import { AssignPopover } from "@/components/AssignPopover";
import { RowActionsMenu } from "@/components/RowActionsMenu";
import { StageDocUploadDialog } from "@/components/StageDocUploadDialog";
import { StageDocRequestDialog } from "@/components/StageDocRequestDialog";
import { StageDocsIncompleteDialog } from "@/components/StageDocsIncompleteDialog";
import { requestStageChange, type MissingDocEntry } from "@/lib/stageTransition";
import { useSeason } from "@/contexts/SeasonContext";
import { useAuth } from "@/hooks/use-auth";
import { isStaffRole, isAgentRole } from "@workspace/roles";
import { useQuery, useQueries, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { CountryFlag } from "@/components/CountryFlag";
import { OriginBadge } from "@/components/OriginBadge";
import { Checkbox } from "@/components/ui/checkbox";
import { ColumnHeader } from "@/components/ui/column-header";
import { ColumnSettingsMenu } from "@/components/ColumnSettingsMenu";
import { useTablePrefs, usePersistedFilterValue } from "@/hooks/use-table-prefs";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TablePagination, useTablePagination } from "@/components/TablePagination";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useStudyLevels } from "@/hooks/useStudyLevels";
import {
  Search, Plus, LayoutGrid, List, ArrowUpDown, ArrowUp, ArrowDown,
  Trash2, Pencil, ChevronLeft, ChevronRight, TrendingUp, Filter,
  User, X, Check, GraduationCap, BookOpen, FileCheck, Send,
  Eye, Stamp, CheckCircle, XCircle, Trophy, MessageSquare, Mail,
  UserPlus, UserCheck2, Download, Building2, MapPin, Award, ExternalLink, Globe, DollarSign,
} from "lucide-react";
import { StageBadgeWithDocs } from "@/components/StageBadgeWithDocs";
import { useToast } from "@/hooks/use-toast";
import { usePipelineStages, type PipelineStage, type StageAction } from "@/hooks/use-pipeline-stages";
import { invalidateAssignmentWorkspaceQueries } from "@/lib/workspaceQueryInvalidation";
import { resolveStageCompletionTargetKey } from "@/lib/pipelineStageCompletion";
import { BulkActionBar } from "@/components/BulkActionBar";
import { BulkMessageDialog } from "@/components/BulkMessageDialog";
import {
  DndContext,
  DragOverlay,
  closestCorners,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { useDroppable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { useI18n } from "@/hooks/use-i18n";
import {
  APPLICATION_CREATION_ERROR_TOAST_DURATION_MS,
  applicationCreationErrorToast,
} from "@/components/ApplicationCreationErrorToast";
import { collectPortalPreflightIssueLabels } from "@/lib/portalBulkRunFeedback";
import { useDateFormat } from "@/hooks/use-date-format";
import { LinkedTableCell } from "@/components/LinkedTableCell";
import { StudentListPhotoAvatar } from "@/components/StudentListPhotoAvatar";

const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";
const VIEW_KEY = "edcons_applications_view";
const PIPELINE_BATCH_SIZE = 25;

// Full (base-prefixed) URL to an application's detail page, used so middle-click
// and ctrl/cmd/right-click open the detail in a new browser tab as a real link.
function appDetailHref(id: number): string {
  return `${BASE_URL}/staff/applications/${id}`;
}
// True when a mouse event should open in a new tab (middle button or modifier click).
function wantsNewTab(e: React.MouseEvent): boolean {
  return e.button === 1 || e.metaKey || e.ctrlKey || e.shiftKey;
}

function getCsrfToken(): string {
  const m = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]*)/);
  return m ? decodeURIComponent(m[1]) : "";
}

async function apiFetch(url: string, opts?: RequestInit) {
  const headers = new Headers(opts?.headers);
  if (opts?.method && opts.method !== "GET" && opts.method !== "HEAD") {
    headers.set("x-csrf-token", getCsrfToken());
  }
  const r = await fetch(url, { credentials: "include", ...opts, headers });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(text || `HTTP ${r.status}`);
  }
  if (r.status === 204) return undefined;
  return r.json();
}

const STAGE_COLORS = [
  "bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800/50 dark:text-slate-300 dark:border-slate-600/50",
  "bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/40 dark:text-blue-300 dark:border-blue-700/60",
  "bg-violet-100 text-violet-700 border-violet-200 dark:bg-violet-900/40 dark:text-violet-300 dark:border-violet-700/60",
  "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-700/60",
  "bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-900/40 dark:text-orange-300 dark:border-orange-700/60",
  "bg-cyan-100 text-cyan-700 border-cyan-200 dark:bg-cyan-900/40 dark:text-cyan-300 dark:border-cyan-700/60",
  "bg-teal-100 text-teal-700 border-teal-200 dark:bg-teal-900/40 dark:text-teal-300 dark:border-teal-700/60",
  "bg-indigo-100 text-indigo-700 border-indigo-200 dark:bg-indigo-900/40 dark:text-indigo-300 dark:border-indigo-700/60",
];
const WON_COLOR = "bg-green-100 text-green-700 border-green-200 dark:bg-green-900/40 dark:text-green-300 dark:border-green-700/60";
const LOST_COLOR = "bg-rose-100 text-rose-700 border-rose-200 dark:bg-rose-900/40 dark:text-rose-300 dark:border-rose-700/60";

function getStageColor(stage: PipelineStage, index: number): string {
  if (stage.variant === "won") return WON_COLOR;
  if (stage.variant === "lost") return LOST_COLOR;
  return STAGE_COLORS[index % STAGE_COLORS.length];
}


const INSTRUCTION_LANGUAGES = [
  "English", "Turkish", "French", "German", "Arabic", "Russian",
  "Dutch", "Spanish", "Italian", "Chinese", "Japanese", "Portuguese",
];

type CountryRecord = { id: number; name: string; code: string; flagEmoji?: string; isActive: boolean };

function useCountries() {
  return useQuery<CountryRecord[]>({
    queryKey: ["countries-all"],
    queryFn: async () => {
      const res = await apiFetch(`${BASE_URL}/api/countries?limit=500`);
      return res.data ?? res;
    },
    staleTime: 5 * 60_000,
  });
}

function generateIntakes(): string[] {
  const intakes: string[] = [];
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const months = [
    { label: "Sep", month: 8 }, { label: "Jan", month: 0 },
    { label: "Feb", month: 1 }, { label: "May", month: 4 },
  ];
  for (let y = year; y <= year + 3; y++) {
    for (const m of months) {
      if (y === year && m.month < month) continue;
      intakes.push(`${m.label} ${y}`);
    }
  }
  return intakes;
}
const INTAKES = generateIntakes();

function intakeOptions(programIntakes?: string | null): string[] {
  const raw = programIntakes?.trim();
  if (!raw) return INTAKES;
  const programmeValues = [raw, ...raw.split(",").map(v => v.trim()).filter(Boolean)];
  return Array.from(new Set([...programmeValues, ...INTAKES]));
}

function formatCurrency(value: number | string | null | undefined): string {
  const num = typeof value === "string" ? parseFloat(value) : (value ?? 0);
  if (!num || isNaN(num)) return "";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(num);
}

function formatDate(dateStr: string | null | undefined, dateFormat?: string | null): string {
  if (!dateStr) return "-";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "-";
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

type Student = { id: number; firstName: string; lastName: string; email?: string | null; nationality?: string | null };

function PipelineStageViewport({
  stageKey,
  onVisible,
  children,
}: {
  stageKey: string;
  onVisible: (stageKey: string) => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      onVisible(stageKey);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          onVisible(stageKey);
          observer.disconnect();
        }
      },
      { threshold: 0, rootMargin: "0px 320px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [onVisible, stageKey]);

  return (
    <div
      ref={ref}
      className="h-full shrink-0"
      style={{ contentVisibility: "auto", containIntrinsicSize: "288px 720px" }}
    >
      {children}
    </div>
  );
}

/* ── AppStudentAvatar ────────────────────────────────────── */
function AppStudentAvatar({ app, size = "sm" }: { app: any; size?: "sm" | "md" }) {
  return (
    <StudentListPhotoAvatar
      studentId={app.studentId}
      firstName={app.studentFirstName}
      lastName={app.studentLastName}
      photoUrl={app.studentPhotoUrl}
      size={size}
    />
  );
}

/* ── StudentSearchInput ──────────────────────────────────── */
function StudentSearchInput({ value, onChange }: { value: Student | null; onChange: (s: Student | null) => void }) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const { data: studentsResp, isLoading } = useQuery({
    queryKey: ["students-search", debouncedQuery],
    queryFn: () => apiFetch(`${BASE_URL}/api/students?limit=20${debouncedQuery ? `&search=${encodeURIComponent(debouncedQuery)}` : ""}`),
    enabled: open,
  });
  const students: Student[] = studentsResp?.data ?? [];

  if (value) {
    return (
      <>
      <div className="flex items-center gap-2 p-2.5 border border-primary rounded-xl bg-primary/5">
        <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
          <User className="w-4 h-4 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-foreground truncate">{value.firstName} {value.lastName}</p>
          {value.email && <p className="text-xs text-muted-foreground truncate">{value.email}</p>}
        </div>
        <button type="button" onClick={() => { onChange(null); setQuery(""); }} className="p-1 rounded-full hover:bg-destructive/10 hover:text-destructive transition-colors">
          <X className="w-4 h-4" />
        </button>
      </div>
      </>
    );
  }

  return (
    <>
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div className="relative cursor-text" onClick={() => { setOpen(true); setTimeout(() => inputRef.current?.focus(), 50); }}>
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
          <Input ref={inputRef} placeholder="Search student..." value={query} onChange={e => { setQuery(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} className="pl-9 rounded-xl" autoComplete="off" />
        </div>
      </PopoverTrigger>
      <PopoverContent className="p-0 w-[var(--radix-popover-trigger-width)] max-h-64 overflow-y-auto" align="start" onOpenAutoFocus={e => e.preventDefault()}>
        {isLoading && <div className="p-3 text-sm text-muted-foreground text-center">Searching...</div>}
        {!isLoading && students.length === 0 && <div className="p-4 text-sm text-muted-foreground text-center">{query.length === 0 ? "Start typing to search" : "No students found"}</div>}
        {students.map(student => (
          <button key={student.id} type="button" className="w-full flex items-center gap-3 p-3 hover:bg-secondary/70 transition-colors text-left border-b border-border/50 last:border-0" onMouseDown={e => { e.preventDefault(); onChange(student); setQuery(""); setOpen(false); }}>
            <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0"><User className="w-4 h-4 text-primary" /></div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground">{student.firstName} {student.lastName}</p>
              <p className="text-xs text-muted-foreground truncate">{student.email || student.nationality || "—"}</p>
            </div>
          </button>
        ))}
      </PopoverContent>
    </Popover>
    </>
  );
}

type ColVariant = "won" | "lost" | undefined;

// Task #167 — minimal row/document shapes used by stage-action handlers.
// Avoids `any` casts inside the button render and download paths.
interface ApplicationRow {
  id: number;
  stage: string;
  [key: string]: unknown;
}
interface StageDocumentEntry {
  id: number;
  fileName?: string | null;
  createdAt?: string | null;
  isMissingDocNote?: boolean | null;
  hasFileData?: boolean | null;
  fileUrl?: string | null;
}

type AppColId =
  | "student"
  | "stage"
  | "country"
  | "university"
  | "program"
  | "level"
  | "intake"
  | "commission"
  | "assigned"
  | "created"
  | "button1"
  | "button2";

const APP_COLUMN_DEFS: { id: AppColId; label: string }[] = [
  { id: "student", label: "Student" },
  { id: "stage", label: "Stage" },
  { id: "level", label: "Level" },
  { id: "university", label: "University" },
  { id: "program", label: "Program" },
  { id: "country", label: "Country" },
  // Task #167 — admin-configurable per-stage action buttons (always visible).
  { id: "button1", label: "Quick Button 1" },
  { id: "button2", label: "Quick Button 2" },
  { id: "intake", label: "Intake" },
  { id: "commission", label: "Commission" },
  { id: "assigned", label: "Assigned" },
  { id: "created", label: "Created" },
];

const APP_ALWAYS_VISIBLE_COLS: AppColId[] = ["button1", "button2"];

const APP_DEFAULT_PREFS = {
  order: APP_COLUMN_DEFS.map((c) => c.id),
  hidden: [] as string[],
};

function ensureUrl(u?: string | null) {
  if (!u) return null;
  return /^https?:\/\//i.test(u) ? u : `https://${u}`;
}

function UniversityInfoPopup({ universityId, onClose }: { universityId: number; onClose: () => void }) {
  const { data: uni, isLoading } = useQuery<any>({
    queryKey: ["university-info", universityId],
    queryFn: () => apiFetch(`${BASE_URL}/api/universities/${universityId}`),
    enabled: !!universityId,
  });

  return (
    <>
    <Dialog open onOpenChange={o => !o && onClose()}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" /></div>
        ) : uni ? (
          <>
            <DialogHeader>
              <div className="flex items-center gap-4">
                <div className="w-16 h-16 rounded-xl border-2 border-muted bg-white flex items-center justify-center overflow-hidden shrink-0">
                  {uni.logoUrl ? (
                    <img src={uni.logoUrl} alt={uni.name} className="w-full h-full object-contain p-1" />
                  ) : (
                    <Building2 className="w-8 h-8 text-muted-foreground" />
                  )}
                </div>
                <div className="min-w-0">
                  <DialogTitle className="text-lg">{uni.name}</DialogTitle>
                  <div className="flex flex-wrap gap-1.5 mt-1">
                    {uni.universityType && <Badge variant="secondary" className="text-xs">{uni.universityType}</Badge>}
                    {uni.status && (
                      <Badge variant="outline" className={`text-xs ${uni.status === "open" ? "border-emerald-300 text-emerald-700 bg-emerald-50 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-700/60" : "border-amber-300 text-amber-700 bg-amber-50 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-700/60"}`}>
                        {uni.status === "open" ? "Open" : "Closed"}
                      </Badge>
                    )}
                  </div>
                </div>
              </div>
            </DialogHeader>
            <div className="space-y-4 mt-3">
              {uni.description && <p className="text-sm text-muted-foreground leading-relaxed">{uni.description}</p>}
              <div className="bg-muted/30 rounded-xl p-4 space-y-3">
                <h4 className="text-sm font-semibold flex items-center gap-2"><MapPin className="w-4 h-4 text-primary" /> Location</h4>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  {uni.country && <div><span className="text-muted-foreground text-xs">Country</span><p className="font-medium">{uni.country}</p></div>}
                  {uni.city && <div><span className="text-muted-foreground text-xs">City</span><p className="font-medium">{uni.city}</p></div>}
                </div>
                {uni.address && <div><span className="text-muted-foreground text-xs">Address</span><p className="text-sm font-medium">{uni.address}</p></div>}
              </div>
              {(uni.qsRanking || uni.timesRanking || uni.ranking) && (
                <div className="bg-muted/30 rounded-xl p-4 space-y-3">
                  <h4 className="text-sm font-semibold flex items-center gap-2"><Award className="w-4 h-4 text-primary" /> Rankings</h4>
                  <div className="grid grid-cols-3 gap-3">
                    {uni.qsRanking && <div className="text-center bg-white rounded-lg p-2 border"><p className="text-lg font-bold text-primary">#{uni.qsRanking}</p><p className="text-[10px] text-muted-foreground font-medium">QS World</p></div>}
                    {uni.timesRanking && <div className="text-center bg-white rounded-lg p-2 border"><p className="text-lg font-bold text-primary">#{uni.timesRanking}</p><p className="text-[10px] text-muted-foreground font-medium">Times HE</p></div>}
                    {uni.ranking && <div className="text-center bg-white rounded-lg p-2 border"><p className="text-lg font-bold text-primary">#{uni.ranking}</p><p className="text-[10px] text-muted-foreground font-medium">National</p></div>}
                  </div>
                </div>
              )}
              {(uni.contactName || uni.contactEmail || uni.contactPhone) && (
                <div className="bg-muted/30 rounded-xl p-4 space-y-3">
                  <h4 className="text-sm font-semibold flex items-center gap-2"><User className="w-4 h-4 text-primary" /> Contact</h4>
                  <div className="space-y-2">
                    {uni.contactName && <div className="flex items-center gap-2 text-sm"><User className="w-3.5 h-3.5 text-muted-foreground" /><span className="font-medium">{uni.contactName}</span></div>}
                    {uni.contactEmail && <a href={`mailto:${uni.contactEmail}`} className="flex items-center gap-2 text-sm text-primary hover:underline"><Mail className="w-3.5 h-3.5" />{uni.contactEmail}</a>}
                    {uni.contactPhone && <a href={`tel:${uni.contactPhone}`} className="flex items-center gap-2 text-sm text-primary hover:underline"><MessageSquare className="w-3.5 h-3.5" />{uni.contactPhone}</a>}
                  </div>
                </div>
              )}
              {ensureUrl(uni.website) && (
                <a href={ensureUrl(uni.website)!} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 text-sm text-primary hover:underline">
                  <Globe className="w-4 h-4" /> Visit Website <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground py-8 text-center">University information not available.</p>
        )}
      </DialogContent>
    </Dialog>
    </>
  );
}

function ProgramInfoPopup({ programId, onClose, canSeeCommission }: { programId: number; onClose: () => void; canSeeCommission?: boolean }) {
  const { data, isLoading } = useQuery<any>({
    queryKey: ["program-info", programId],
    queryFn: () => apiFetch(`${BASE_URL}/api/course-finder?programId=${programId}&limit=1`),
    enabled: !!programId,
  });
  const p = Array.isArray(data?.data) ? data.data[0] : Array.isArray(data) ? data[0] : null;

  const fmtCur = (v: any, cur = "USD") => v != null && v !== "" ? `$${Number(v).toLocaleString()}` : null;

  return (
    <>
    <Dialog open onOpenChange={o => !o && onClose()}>
      <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" /></div>
        ) : p ? (
          <>
            <DialogHeader>
              <div className="flex items-start gap-3">
                <div className="w-14 h-14 rounded-xl border-2 border-muted bg-white flex items-center justify-center overflow-hidden shrink-0">
                  {p.universityLogoUrl ? (
                    <img src={p.universityLogoUrl} alt={p.universityName} className="w-full h-full object-contain p-1" />
                  ) : (
                    <Building2 className="w-7 h-7 text-muted-foreground" />
                  )}
                </div>
                <div className="min-w-0">
                  <p className="text-sm text-muted-foreground">{p.universityName}</p>
                  <DialogTitle className="text-lg">{p.name}</DialogTitle>
                  <div className="flex gap-1.5 mt-1.5">
                    {p.degree && <Badge variant="secondary" className="text-xs">{p.degree}</Badge>}
                    {p.universityStatus && (
                      <Badge variant="outline" className={`text-xs ${p.universityStatus === "open" ? "border-emerald-300 text-emerald-700 bg-emerald-50 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-700/60" : "border-amber-300 text-amber-700 bg-amber-50 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-700/60"}`}>
                        {p.universityStatus}
                      </Badge>
                    )}
                  </div>
                </div>
              </div>
            </DialogHeader>
            <div className="space-y-4 mt-3">
              <div className="bg-muted/30 rounded-xl p-4 space-y-3">
                <h4 className="text-sm font-semibold flex items-center gap-2"><GraduationCap className="w-4 h-4 text-primary" /> Program Details</h4>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div><span className="text-muted-foreground text-xs">Program Name</span><p className="font-medium">{p.name}</p></div>
                  {p.degree && <div><span className="text-muted-foreground text-xs">Degree / Level</span><p className="font-medium">{p.degree}</p></div>}
                  {p.language && <div><span className="text-muted-foreground text-xs">Language</span><p className="font-medium">{p.language}</p></div>}
                  {p.duration && <div><span className="text-muted-foreground text-xs">Duration</span><p className="font-medium">{p.duration}</p></div>}
                  {p.intakes && <div><span className="text-muted-foreground text-xs">Intakes</span><p className="font-medium">{p.intakes}</p></div>}
                  {p.field && <div><span className="text-muted-foreground text-xs">Field of Study</span><p className="font-medium">{p.field}</p></div>}
                </div>
              </div>
              <div className="bg-muted/30 rounded-xl p-4 space-y-3">
                <h4 className="text-sm font-semibold flex items-center gap-2"><Building2 className="w-4 h-4 text-primary" /> University</h4>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  {p.universityName && <div><span className="text-muted-foreground text-xs">University</span><p className="font-medium">{p.universityName}</p></div>}
                  {p.universityCountry && <div><span className="text-muted-foreground text-xs">Country</span><p className="font-medium">{p.universityCountry}</p></div>}
                  {p.universityCity && <div><span className="text-muted-foreground text-xs">City</span><p className="font-medium">{p.universityCity}</p></div>}
                  {p.universityStatus && <div><span className="text-muted-foreground text-xs">Status</span><p className="font-medium">{p.universityStatus}</p></div>}
                </div>
              </div>
              <div className="bg-muted/30 rounded-xl p-4 space-y-3">
                <h4 className="text-sm font-semibold flex items-center gap-2"><DollarSign className="w-4 h-4 text-primary" /> Fees & Finance</h4>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  {fmtCur(p.tuitionFee) && <div><span className="text-muted-foreground text-xs">Tuition Fee</span><p className="font-medium">{fmtCur(p.tuitionFee)}</p></div>}
                  {p.feeType && <div><span className="text-muted-foreground text-xs">Fee Type</span><p className="font-medium">{p.feeType}</p></div>}
                  {fmtCur(p.applicationFee) && <div><span className="text-muted-foreground text-xs">Application Fee</span><p className="font-medium">{fmtCur(p.applicationFee)}</p></div>}
                  {fmtCur(p.depositFee) && <div><span className="text-muted-foreground text-xs">Deposit Fee</span><p className="font-medium">{fmtCur(p.depositFee)}</p></div>}
                  {fmtCur(p.serviceFeeAmount) && <div><span className="text-muted-foreground text-xs">Service Fee</span><p className="font-medium">{fmtCur(p.serviceFeeAmount)}</p></div>}
                  {canSeeCommission && fmtCur(p.commissionAmount) && <div><span className="text-muted-foreground text-xs">Commission</span><p className="font-medium text-emerald-600">{fmtCur(p.commissionAmount)}</p></div>}
                </div>
              </div>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground py-8 text-center">Program information not available.</p>
        )}
      </DialogContent>
    </Dialog>
    </>
  );
}

/* ── DraggableAppCard ─────────────────────────────────────── */
function DraggableAppCard({ app, onView, variant, assignedUserName, onAssign, staffUsersList, currentUserId, canSeeCommission, canAssign, canReassign, canMoveCards }: { app: any; onView: (id: number) => void; variant?: ColVariant; assignedUserName?: string; onAssign?: (entityId: number, userId: number) => void; staffUsersList?: { id: number; name: string }[]; currentUserId?: number; canSeeCommission?: boolean; canAssign?: boolean; canReassign?: boolean; canMoveCards?: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: app.id, disabled: !canMoveCards });
  const style = { transform: CSS.Transform.toString(transform), transition };
  const [contactOpen, setContactOpen] = useState(false);
  const [contactChannel, setContactChannel] = useState<"email" | "whatsapp" | "instagram" | "internal">("internal");
  const [uniInfoOpen, setUniInfoOpen] = useState(false);
  const [progInfoId, setProgInfoId] = useState<number | null>(null);
  const [, setLoc] = useLocation();

  const isDirect = !app.originType || app.originType === "direct";
  const cardBg =
    variant === "won" ? "bg-emerald-50 border-emerald-200 hover:border-emerald-300 dark:bg-emerald-900/20 dark:border-emerald-700/40 dark:hover:border-emerald-600/60" :
    variant === "lost" ? "bg-rose-50 border-rose-200 hover:border-rose-300 dark:bg-rose-900/20 dark:border-rose-700/40 dark:hover:border-rose-600/60" :
    isDirect ? "bg-blue-50 border-blue-200 hover:border-blue-300 hover:shadow-md dark:bg-blue-900/20 dark:border-blue-700/40 dark:hover:border-blue-600/60" :
    "bg-card border-border hover:shadow-md";

  function openContact(ch: "email" | "whatsapp" | "internal") {
    setContactChannel(ch);
    setContactOpen(true);
  }

  const studentName = `${app.studentFirstName || ""} ${app.studentLastName || ""}`.trim() || "Student";

  return (
    <>
    <div
      ref={setNodeRef}
      style={style}
      className={`rounded-xl border ${isDragging ? "border-primary shadow-xl opacity-50 z-50 relative" : cardBg} mb-3 transition-shadow duration-200`}
      onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); window.open(appDetailHref(app.id), "_blank", "noopener"); } }}
    >
      <div {...attributes} {...listeners} className={`p-4 pb-2 ${!canMoveCards ? "cursor-default" : isDragging ? "cursor-grabbing" : "cursor-grab"}`}>
        <div className="flex items-center gap-2.5 mb-1.5">
          <AppStudentAvatar app={app} />
          {app.studentId ? (
            <Link
              href={`/staff/students/${app.studentId}`}
              className="min-w-0 line-clamp-1 cursor-pointer text-sm font-bold text-foreground transition-colors hover:text-primary hover:underline"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              title={`Open ${studentName}`}
            >
              {app.studentFirstName} {app.studentLastName}
            </Link>
          ) : (
            <h4 className="min-w-0 line-clamp-1 text-sm font-bold text-foreground">
              {app.studentFirstName} {app.studentLastName}
            </h4>
          )}
        </div>
        {app.universityName && (
          <p
            className="text-xs text-muted-foreground hover:text-primary hover:underline cursor-pointer transition-colors"
            onClick={(e) => { e.stopPropagation(); if (app.universityId) setUniInfoOpen(true); }}
          >{app.universityName}</p>
        )}
        {app.programName && (
          <p
            className="text-xs font-medium text-primary mt-1.5 bg-primary/5 block max-w-full px-2 py-1 rounded-md hover:bg-primary/15 hover:underline cursor-pointer transition-colors leading-relaxed"
            onClick={(e) => { e.stopPropagation(); if (app.programId) setProgInfoId(app.programId); }}
          >{app.programName}</p>
        )}
        <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
          {app.country && <span className="text-[10px] px-2 py-0.5 rounded-full bg-secondary text-secondary-foreground font-medium">{app.country}</span>}
          <OriginBadge originType={app.originType || "direct"} originDisplayName={app.originDisplayName} />
          {canSeeCommission && app.commissionAmount && parseFloat(app.commissionAmount) > 0 && (
            <div className="flex items-center gap-1 ml-auto">
              <TrendingUp className="w-3 h-3 text-emerald-500" />
              <span className="text-xs font-semibold text-emerald-600">{formatCurrency(parseFloat(app.commissionAmount))}</span>
            </div>
          )}
        </div>
      </div>
      {app.agentName && (
        <div className="px-4 pb-1.5">
          <span
            className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 font-medium cursor-pointer hover:bg-amber-100 hover:border-amber-300 transition-colors max-w-full truncate dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-700/50 dark:hover:bg-amber-900/50"
            onClick={(e) => { e.stopPropagation(); setLoc(`/staff/agents/${app.agentId}`); }}
            title={`Agent: ${app.agentName}`}
          >
            <Building2 className="w-3 h-3 shrink-0" />{app.agentName}
          </span>
        </div>
      )}
      <div className="px-4 pb-3 flex items-center gap-1">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
          {onAssign && app.assignedToId ? (
            (canReassign || app.assignedToId === currentUserId) && staffUsersList ? (
              <AssignPopover assignedUserName={assignedUserName} staffUsers={staffUsersList} currentUserId={currentUserId} onAssign={(uid) => onAssign(app.id, uid)} />
            ) : assignedUserName ? (
              <span className="flex min-w-0 items-center gap-0.5 truncate text-[10px] text-muted-foreground" title={assignedUserName}><UserCheck2 className="w-3 h-3 shrink-0" />{assignedUserName}</span>
            ) : null
          ) : onAssign && !app.assignedToId ? (
            canReassign && staffUsersList ? (
              <AssignPopover staffUsers={staffUsersList} currentUserId={currentUserId} onAssign={(uid) => onAssign(app.id, uid)} />
            ) : canAssign && currentUserId ? (
              <button onClick={(e) => { e.stopPropagation(); onAssign(app.id, currentUserId); }} className="text-[10px] text-primary hover:underline font-medium flex items-center gap-0.5" title="Assign to me">
                <UserPlus className="w-3 h-3 shrink-0" />Assign to me
              </button>
            ) : null
          ) : assignedUserName ? (
            <span className="flex min-w-0 items-center gap-0.5 truncate text-[10px] text-muted-foreground" title={assignedUserName}><UserCheck2 className="w-3 h-3 shrink-0" />{assignedUserName}</span>
          ) : null}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <button onClick={(e) => { e.stopPropagation(); openContact("internal"); }} title="Message"
            className="w-6 h-6 flex items-center justify-center rounded-md text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors">
            <MessageSquare className="w-3.5 h-3.5" />
          </button>
          {app.studentEmail && (
            <button onClick={(e) => { e.stopPropagation(); openContact("email"); }} title="Email"
              className="w-6 h-6 flex items-center justify-center rounded-md text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors">
              <Mail className="w-3.5 h-3.5" />
            </button>
          )}
          {app.studentPhone && (
            <button onClick={(e) => { e.stopPropagation(); openContact("whatsapp"); }} title="WhatsApp"
              className="w-6 h-6 flex items-center justify-center rounded-md text-muted-foreground hover:text-emerald-600 hover:bg-emerald-50 transition-colors">
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
            </button>
          )}
          <a
            href={appDetailHref(app.id)}
            onClick={(e) => { if (wantsNewTab(e)) return; e.preventDefault(); onView(app.id); }}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
            title="View application"
          >
            <Eye className="w-3.5 h-3.5" />
          </a>
        </div>
      </div>
      <QuickContactDialog
        open={contactOpen}
        onClose={() => setContactOpen(false)}
        channel={contactChannel}
        setChannel={setContactChannel}
        name={studentName}
        email={app.studentEmail}
        phone={app.studentPhone}
        entityType="application"
        entityId={app.id}
        hideEmail={!app.studentEmail}
        hideWhatsApp={!app.studentPhone}
      />
      {uniInfoOpen && app.universityId && (
        <UniversityInfoPopup universityId={app.universityId} onClose={() => setUniInfoOpen(false)} />
      )}
      {progInfoId && (
        <ProgramInfoPopup programId={progInfoId} onClose={() => setProgInfoId(null)} canSeeCommission={canSeeCommission} />
      )}
    </div>
    </>
  );
}

/* ── DroppableAppColumn ──────────────────────────────────── */
function DroppableAppColumn({ stage, label, variant, apps, totalCount, totalRevenue, isLoading, onLoadMore, onView, staffUsersMap, onAssign, staffUsersList, currentUserId, canSeeCommission, canAssign, canReassign, canMoveCards }: {
  stage: string; label: string; variant?: string | null; apps: any[]; onView: (id: number) => void;
  totalCount?: number; totalRevenue?: number; isLoading?: boolean; onLoadMore?: () => void;
  staffUsersMap?: Record<number, string>; onAssign?: (entityId: number, userId: number) => void;
  staffUsersList?: { id: number; name: string }[]; currentUserId?: number; canSeeCommission?: boolean; canAssign?: boolean; canReassign?: boolean; canMoveCards?: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage });
  const v = variant as ColVariant;
  const loadedRevenue = apps.reduce((sum, a) => sum + (parseFloat(a.commissionAmount) || 0), 0);
  const resolvedTotalRevenue = totalRevenue ?? loadedRevenue;

  const colBg =
    v === "won" ? "bg-emerald-50/60 border-emerald-200/50 dark:bg-emerald-900/20 dark:border-emerald-700/30" :
    v === "lost" ? "bg-rose-50/60 border-rose-200/50 dark:bg-rose-900/20 dark:border-rose-700/30" :
    "bg-secondary/50 border-border/50";

  const headerBg =
    v === "won" ? "bg-emerald-100/80 border-emerald-200/70 dark:bg-emerald-900/40 dark:border-emerald-700/50" :
    v === "lost" ? "bg-rose-100/80 border-rose-200/70 dark:bg-rose-900/40 dark:border-rose-700/50" :
    "bg-card/50 border-border/50";

  const badgeBg =
    v === "won" ? "bg-emerald-200/60 text-emerald-800 border-emerald-300/50 dark:bg-emerald-800/40 dark:text-emerald-200 dark:border-emerald-600/40" :
    v === "lost" ? "bg-rose-200/60 text-rose-800 border-rose-300/50 dark:bg-rose-800/40 dark:text-rose-200 dark:border-rose-600/40" :
    "bg-background text-muted-foreground border shadow-sm";

  const dropBg =
    v === "won" ? (isOver ? "bg-emerald-100/60 dark:bg-emerald-900/30" : "") :
    v === "lost" ? (isOver ? "bg-rose-100/60 dark:bg-rose-900/30" : "") :
    (isOver ? "bg-primary/5" : "");

  const emptyBorder =
    v === "won" ? "border-emerald-300/50 text-emerald-500" :
    v === "lost" ? "border-rose-300/50 text-rose-400" :
    "border-border/50 text-muted-foreground";

  const icon =
    v === "won" ? <Trophy className="w-4 h-4 text-emerald-500 shrink-0" /> :
    v === "lost" ? <XCircle className="w-4 h-4 text-rose-400 shrink-0" /> :
    null;

  return (
    <>
    <div className={`w-72 flex flex-col max-h-full rounded-2xl border overflow-hidden ${colBg}`}>
      <div className={`p-4 border-b shrink-0 ${headerBg}`}>
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-1.5">
            {icon}
            <h3 className={`font-display font-bold text-sm ${v === "won" ? "text-emerald-800" : v === "lost" ? "text-rose-700" : "text-foreground"}`}>{label}</h3>
          </div>
          <span className={`min-w-6 h-6 px-1.5 rounded-full flex items-center justify-center text-xs font-bold border ${badgeBg}`}>{totalCount ?? apps.length}</span>
        </div>
        {canSeeCommission && resolvedTotalRevenue > 0 && (
          <div className="mt-2 flex items-center gap-1.5 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 rounded-lg px-2.5 py-1">
            <TrendingUp className="w-3.5 h-3.5 text-emerald-600" />
            <span className="text-xs font-bold text-emerald-700">{formatCurrency(resolvedTotalRevenue)}</span>
          </div>
        )}
      </div>
      <div ref={setNodeRef} className={`p-3 flex-1 overflow-y-auto custom-scrollbar transition-colors duration-150 ${dropBg}`}>
        <SortableContext items={apps.map(a => a.id)} strategy={verticalListSortingStrategy}>
          {apps.map((app: any) => (
            <DraggableAppCard key={app.id} app={app} onView={onView} variant={v} assignedUserName={app.assignedToId && staffUsersMap ? staffUsersMap[app.assignedToId] : undefined} onAssign={onAssign} staffUsersList={staffUsersList} currentUserId={currentUserId} canSeeCommission={canSeeCommission} canAssign={canAssign} canReassign={canReassign} canMoveCards={canMoveCards} />
          ))}
          {!isLoading && apps.length === 0 && (
            <div className={`h-20 border-2 border-dashed rounded-xl flex items-center justify-center text-sm font-medium ${emptyBorder}`}>
              Drop here
            </div>
          )}
          {isLoading && apps.length === 0 && (
            <div className="h-20 rounded-xl flex items-center justify-center text-sm text-muted-foreground">
              Loading…
            </div>
          )}
          {onLoadMore && apps.length < (totalCount ?? apps.length) && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full mt-1"
              disabled={isLoading}
              onClick={onLoadMore}
            >
              {isLoading ? "Loading…" : `Load more (${apps.length}/${totalCount})`}
            </Button>
          )}
        </SortableContext>
      </div>
    </div>
    </>
  );
}

/* ── SortHeader ──────────────────────────────────────────── */
type SortKey = "student" | "stage" | "country" | "university" | "program" | "level" | "intake" | "fee" | "date";
type SortDir = "asc" | "desc";

function SortHeader({ label, sortKey, currentSort, onSort }: {
  label: string; sortKey: SortKey; currentSort: { key: SortKey; dir: SortDir }; onSort: (k: SortKey) => void;
}) {
  const active = currentSort.key === sortKey;
  return (
    <>
    <TableHead className="cursor-pointer select-none hover:bg-muted/50 transition-colors" onClick={() => onSort(sortKey)}>
      <div className="flex items-center gap-1">
        {label}
        {active ? (currentSort.dir === "asc" ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />) : <ArrowUpDown className="w-3 h-3 text-muted-foreground/50" />}
      </div>
    </TableHead>
    </>
  );
}

/* ── EditApplicationDialog ───────────────────────────────── */
function EditApplicationDialog({ open, onClose, app, stages }: { open: boolean; onClose: () => void; app: any; stages: PipelineStage[] }) {
  const { t } = useI18n();
  const { user, hasPermission } = useAuth();
  const canSeeCommission = hasPermission("applications.view_commission");
  const isAdmin = user?.role === "super_admin" || user?.role === "admin" || user?.role === "manager";
  const [form, setForm] = useState({
    stage: "", level: "", country: "", universityId: "", universityName: "",
    programId: "", programName: "", intake: "", instructionLanguage: "",
    tuitionFee: "", notes: "",
  });
  const [docUploadDialog, setDocUploadDialog] = useState<{ targetStage: string; targetStageLabel: string } | null>(null);
  const [docRequestDialog, setDocRequestDialog] = useState<{ stage: string; stageLabel: string; suggestedDocTypes: string[]; title: string | null } | null>(null);
  const [docsIncompleteDialog, setDocsIncompleteDialog] = useState<{ currentStageLabel: string; missing: MissingDocEntry[] } | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { levels: studyLevels } = useStudyLevels();

  const { data: allCountries = [] } = useCountries();
  const activeDestinations = useMemo(() => allCountries.filter(c => c.isActive), [allCountries]);

  const { data: uniData } = useQuery<{ data: Array<{ id: number; name: string }> }>({
    queryKey: ["universities-by-country", form.country],
    queryFn: () => apiFetch(`${BASE_URL}/api/universities?country=${encodeURIComponent(form.country)}&limit=100`),
    enabled: !!form.country,
  });
  const universities = uniData?.data ?? [];

  const { data: progData } = useQuery<{ data: Array<{ id: number; name: string; degree?: string | null; language?: string | null; intakes?: string | null; tuitionFee?: number | null; discountedFee?: number | null; commissionRate?: number | null }> }>({
    queryKey: ["programs-by-university", form.universityId],
    queryFn: () => apiFetch(`${BASE_URL}/api/programs?universityId=${form.universityId}&limit=100`),
    enabled: !!form.universityId,
  });
  const programs = progData?.data ?? [];

  function degreeToLevel(degree?: string | null): string {
    if (!degree) return "";
    const d = degree.toLowerCase();
    if (d.includes("phd") || d.includes("doctorate")) return "doctorate";
    if (d.includes("mba")) return "mba";
    if (d.includes("msc") || d.includes("ma") || d.includes("master")) return "masters";
    if (d.includes("bsc") || d.includes("ba") || d.includes("undergrad")) return "undergraduate";
    if (d.includes("diploma")) return "diploma";
    if (d.includes("foundation")) return "foundation";
    return "";
  }

  const updateApp = useMutation({
    mutationFn: (payload: Record<string, unknown>) => apiFetch(`${BASE_URL}/api/applications/${app?.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }),
    onSuccess: () => { toast({ title: "Application updated" }); queryClient.invalidateQueries({ queryKey: ["applications"] }); onClose(); },
    onError: () => { toast({ title: "Error", description: "Failed to update", variant: "destructive" }); },
  });

  useEffect(() => {
    if (open && app) {
      setForm({
        stage: app.stage || "inquiry",
        level: app.level || "",
        country: app.country || "",
        universityId: app.universityId ? String(app.universityId) : "",
        universityName: app.universityName || "",
        programId: app.programId ? String(app.programId) : "",
        programName: app.programName || "",
        intake: app.intake || "",
        instructionLanguage: app.instructionLanguage || "",
        tuitionFee: app.tuitionFee ? String(app.tuitionFee) : "",
        notes: app.notes || "",
      });
    }
  }, [open, app]);

  function handleCountryChange(country: string) {
    if (country === form.country) return;
    setForm({ ...form, country, universityId: "", universityName: "", programId: "", programName: "" });
  }

  function handleUniversityChange(uniId: string) {
    const uni = universities.find(u => String(u.id) === uniId);
    setForm({ ...form, universityId: uniId, universityName: uni?.name ?? "", programId: "", programName: "" });
  }

  function handleProgramChange(progId: string) {
    const prog = programs.find(p => String(p.id) === progId);
    if (!prog) return;
    const autoLevel = degreeToLevel(prog.degree);
    const autoLang = prog.language && INSTRUCTION_LANGUAGES.includes(prog.language) ? prog.language : form.instructionLanguage;
    const effectiveFee = prog.discountedFee ?? prog.tuitionFee;
    const autoFee = effectiveFee != null ? String(effectiveFee) : form.tuitionFee;
    setForm({ ...form, programId: progId, programName: prog.name, level: autoLevel || form.level, instructionLanguage: autoLang, intake: prog.intakes || form.intake, tuitionFee: autoFee });
  }

  async function handleSave() {
    const fee = parseFloat(form.tuitionFee);
    const payload: any = {
      stage: form.stage,
      level: form.level || null,
      country: form.country || null,
      universityId: form.universityId ? parseInt(form.universityId, 10) : null,
      universityName: form.universityName || null,
      programId: form.programId ? parseInt(form.programId, 10) : null,
      programName: form.programName || null,
      intake: form.intake || null,
      instructionLanguage: form.instructionLanguage || null,
      tuitionFee: form.tuitionFee && !isNaN(fee) ? fee : null,
      notes: form.notes || null,
    };

    try {
      const csrfToken = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]*)/)?.[1] ? decodeURIComponent(document.cookie.match(/(?:^|;\s*)csrf_token=([^;]*)/)![1]) : "";
      const res = await fetch(`${BASE_URL}/api/applications/${app.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        toast({ title: "Application updated" });
        queryClient.invalidateQueries({ queryKey: ["applications"] });
        onClose();
        return;
      }
      const body = await res.json().catch(() => ({}));
      const stageLabelOf = (key: string) => stages.find(s => s.key === key)?.label ?? key;
      if (res.status === 422 && body.code === "DOC_SELECTION_REQUIRED") {
        const stage = body.requiredStage || form.stage;
        setDocRequestDialog({
          stage,
          stageLabel: stageLabelOf(stage),
          suggestedDocTypes: Array.isArray(body.suggestedDocTypes) ? body.suggestedDocTypes : [],
          title: typeof body.actionLabel === "string" ? body.actionLabel : null,
        });
      } else if (res.status === 422 && body.code === "DOCS_INCOMPLETE") {
        setDocsIncompleteDialog({
          currentStageLabel: stageLabelOf(body.currentStage || app?.stage || ""),
          missing: Array.isArray(body.missing) ? body.missing : [],
        });
      } else if (res.status === 422 && body.code === "DOCS_REQUIRED") {
        setDocUploadDialog({ targetStage: form.stage, targetStageLabel: stageLabelOf(form.stage) });
      } else {
        toast({ title: "Error", description: body.error || "Failed to update", variant: "destructive" });
      }
    } catch {
      toast({ title: "Error", description: "Failed to update", variant: "destructive" });
    }
  }

  const selectedProgForFee = programs.find(p => String(p.id) === form.programId);
  const hasDiscountedFee = selectedProgForFee != null && selectedProgForFee.discountedFee != null;
  const editIntakeOptions = intakeOptions(selectedProgForFee?.intakes || form.intake);

  return (
    <>
    <>
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{t("applicationsPage.editApplication")}</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-4 py-2">
          <div className="space-y-1.5">
            <Label>{t("applicationsPage.stage")}</Label>
            <Select value={form.stage} onValueChange={v => setForm({ ...form, stage: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{stages.map(s => <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{t("applicationsPage.country")}</Label>
            <Select value={form.country} onValueChange={handleCountryChange}>
              <SelectTrigger><SelectValue placeholder={t("applicationsPage.selectCountry")} /></SelectTrigger>
              <SelectContent className="max-h-60">{activeDestinations.map(c => <SelectItem key={c.id} value={c.name}><span className="inline-flex items-center gap-1.5"><CountryFlag code={c.code} size="sm" />{c.name}</span></SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5 col-span-2">
            <Label>{t("applicationsPage.university")}</Label>
            <Select value={form.universityId} onValueChange={handleUniversityChange} disabled={!form.country}>
              <SelectTrigger>
                <SelectValue placeholder={!form.country ? "Select country first..." : universities.length === 0 ? "No universities found" : "Select university..."} />
              </SelectTrigger>
              <SelectContent className="max-h-60">
                {universities.map(u => <SelectItem key={u.id} value={String(u.id)}>{u.name}</SelectItem>)}
              </SelectContent>
            </Select>
            {form.universityName && !form.universityId && (
              <p className="text-xs text-muted-foreground mt-1">Current: {form.universityName}</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label>{t("applicationsPage.level")}</Label>
            <Select value={form.level} onValueChange={v => setForm({ ...form, level: v })}>
              <SelectTrigger><SelectValue placeholder={t("applicationsPage.select")} /></SelectTrigger>
              <SelectContent>{studyLevels.map(l => <SelectItem key={l.key} value={l.key}>{l.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{t("applicationsPage.program")}</Label>
            <Select value={form.programId} onValueChange={handleProgramChange} disabled={!form.universityId}>
              <SelectTrigger>
                <SelectValue placeholder={!form.universityId ? "Select university first..." : programs.length === 0 ? "No programs found" : "Select program..."} />
              </SelectTrigger>
              <SelectContent className="max-h-60">
                {programs.map(p => (
                  <SelectItem key={p.id} value={String(p.id)}>
                    {p.name}{p.degree && <span className="text-muted-foreground ml-1 text-xs">({p.degree})</span>}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {form.programName && !form.programId && (
              <p className="text-xs text-muted-foreground mt-1">Current: {form.programName}</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label>{t("applicationsPage.language")}</Label>
            <Select value={form.instructionLanguage} onValueChange={v => setForm({ ...form, instructionLanguage: v })}>
              <SelectTrigger><SelectValue placeholder={t("applicationsPage.select")} /></SelectTrigger>
              <SelectContent>{INSTRUCTION_LANGUAGES.map(l => <SelectItem key={l} value={l}>{l}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{t("applicationsPage.intake")}</Label>
            <Select value={form.intake} onValueChange={v => setForm({ ...form, intake: v })}>
              <SelectTrigger><SelectValue placeholder={t("applicationsPage.select")} /></SelectTrigger>
              <SelectContent>{editIntakeOptions.map(i => <SelectItem key={i} value={i}>{i}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5 col-span-2">
            <Label className="flex items-center gap-2">
              <TrendingUp className="w-3.5 h-3.5 text-emerald-500" />
              Tuition Fee (USD)
              {hasDiscountedFee && <span className="text-xs font-normal text-amber-600 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded-full dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-700/50">Discounted</span>}
            </Label>
            <Input type="number" min="0" step="100" value={form.tuitionFee} onChange={e => setForm({ ...form, tuitionFee: e.target.value })} />
            {selectedProgForFee && (selectedProgForFee.tuitionFee != null || selectedProgForFee.discountedFee != null || selectedProgForFee.commissionRate != null) && (
              <div className="flex flex-wrap gap-3 text-xs mt-1">
                {selectedProgForFee.tuitionFee != null && <span className="text-muted-foreground">Standard: <strong>${selectedProgForFee.tuitionFee.toLocaleString()}</strong></span>}
                {selectedProgForFee.discountedFee != null && <span className="text-amber-600">Discounted: <strong>${selectedProgForFee.discountedFee.toLocaleString()}</strong></span>}
                {canSeeCommission && selectedProgForFee.commissionRate != null && <span className="text-indigo-600">Commission: <strong>{selectedProgForFee.commissionRate}%</strong></span>}
              </div>
            )}
          </div>
          <div className="space-y-1.5 col-span-2">
            <Label>{t("applicationsPage.notes")}</Label>
            <textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} rows={2} className="w-full rounded-xl border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-none" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("applicationsPage.cancel")}</Button>
          <Button onClick={handleSave} disabled={updateApp.isPending}>{updateApp.isPending ? "Saving..." : "Save Changes"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    {docUploadDialog && app && (
      <StageDocUploadDialog
        open={!!docUploadDialog}
        onClose={() => setDocUploadDialog(null)}
        applicationId={app.id}
        targetStage={docUploadDialog.targetStage}
        targetStageLabel={docUploadDialog.targetStageLabel}
        onUploaded={() => {
          queryClient.invalidateQueries({ queryKey: ["applications"] });
          onClose();
        }}
      />
    )}
    {docRequestDialog && app && (
      <StageDocRequestDialog
        open={!!docRequestDialog}
        onOpenChange={(o) => { if (!o) setDocRequestDialog(null); }}
        applicationId={app.id}
        stage={docRequestDialog.stage}
        stageLabel={docRequestDialog.stageLabel}
        suggestedDocTypes={docRequestDialog.suggestedDocTypes}
        title={docRequestDialog.title}
        onSaved={() => {
          setDocRequestDialog(null);
          queryClient.invalidateQueries({ queryKey: ["applications"] });
          void handleSave();
        }}
      />
    )}
    {docsIncompleteDialog && app && (
      <StageDocsIncompleteDialog
        open={!!docsIncompleteDialog}
        onOpenChange={(o) => { if (!o) setDocsIncompleteDialog(null); }}
        applicationId={app.id}
        currentStageLabel={docsIncompleteDialog.currentStageLabel}
        missing={docsIncompleteDialog.missing}
        isAdmin={isAdmin}
        onRetry={() => {
          setDocsIncompleteDialog(null);
          void handleSave();
        }}
      />
    )}
    </>
    </>
  );
}

/* ── DeleteConfirmDialog ─────────────────────────────────── */
function DeleteConfirmDialog({ open, onClose, count, onConfirm, isPending }: {
  open: boolean; onClose: () => void; count: number; onConfirm: () => void; isPending: boolean;
}) {
  const { t } = useI18n();
  return (
    <>
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>Delete {count} Application{count > 1 ? "s" : ""}?</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground py-2">This action cannot be undone.</p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("applicationsPage.cancel")}</Button>
          <Button variant="destructive" onClick={onConfirm} disabled={isPending}>{isPending ? "Deleting..." : `Delete ${count}`}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}

/* ── RunConfirmDialog ────────────────────────────────────── */
function RunConfirmDialog({ open, onClose, count, onConfirm, isPending }: {
  open: boolean; onClose: () => void; count: number; onConfirm: () => void; isPending: boolean;
}) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>{t("portalAutomation.bulkRun.confirmTitle", { count })}</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground py-2">{t("portalAutomation.bulkRun.confirmBody", { count })}</p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isPending}>{t("portalAutomation.bulkRun.confirmCancel")}</Button>
          <Button onClick={onConfirm} disabled={isPending}>{isPending ? "…" : t("portalAutomation.bulkRun.confirmAccept")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── FilterPopover ────────────────────────────────────────── */
type AppFilters = { stage: string; country: string; university: string; universityType: string; agent: string; assignedTo: string; dateRange: string; originType: string; createdSource: string };
const DEFAULT_FILTERS: AppFilters = { stage: "all", country: "all", university: "all", universityType: "all", agent: "all", assignedTo: "mine_unassigned", dateRange: "all", originType: "all", createdSource: "all" };

function isDateInRange(dateStr: string, range: string): boolean {
  if (range === "all") return true;
  const d = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (range === "today") return d >= today;
  if (range === "yesterday") { const y = new Date(today); y.setDate(y.getDate() - 1); return d >= y && d < today; }
  if (range === "last7") { const w = new Date(today); w.setDate(w.getDate() - 7); return d >= w; }
  if (range === "thisMonth") return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  if (range === "thisYear") return d.getFullYear() === now.getFullYear();
  return true;
}

type ApplicationFilterFacets = {
  countries?: string[];
  universities?: Array<{ id: number; name: string }>;
  agents?: Array<{ id: number; name: string }>;
};

function FilterPopover({ filters, onChange, stages, apps, facets, staffUsersList, canViewOthers, canViewUnassigned, currentUserId, clearAssignedTo }: {
  stages: PipelineStage[];
  filters: AppFilters;
  onChange: (f: AppFilters) => void;
  apps: any[];
  facets?: ApplicationFilterFacets;
  staffUsersList: { id: number; name: string }[];
  canViewOthers: boolean;
  canViewUnassigned: boolean;
  currentUserId?: number;
  clearAssignedTo: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const hasActive = Object.entries(filters).some(([k, v]) => v !== (k === "assignedTo" ? clearAssignedTo : (DEFAULT_FILTERS as any)[k]));
  const { data: allCountries = [] } = useCountries();

  const countriesInApps = useMemo(() => {
    const seen = new Set<string>(facets?.countries || []);
    if (seen.size === 0) {
      apps.forEach((a: any) => { if (a.country) seen.add(a.country); });
    }
    return allCountries.filter(c => seen.has(c.name)).sort((a, b) => a.name.localeCompare(b.name));
  }, [apps, allCountries, facets?.countries]);

  const uniqueUniversities = useMemo(() => {
    if (facets?.universities?.length) {
      return facets.universities.map(u => [u.id, u.name] as [number, string]);
    }
    const map = new Map<number, string>();
    apps.forEach((a: any) => { if (a.universityId && a.universityName) map.set(a.universityId, a.universityName); });
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [apps, facets?.universities]);

  const uniqueAgents = useMemo(() => {
    if (facets?.agents?.length) {
      return facets.agents.map(a => [a.id, a.name] as [number, string]);
    }
    const map = new Map<number, string>();
    apps.forEach((a: any) => { if (a.agentId && a.agentName) map.set(a.agentId, a.agentName); });
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [apps, facets?.agents]);

  return (
    <>
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="icon" className={`rounded-full relative ${hasActive ? "border-primary text-primary bg-primary/5" : ""}`}>
          <Filter className="w-4 h-4" />
          {hasActive && <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-primary" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-4 space-y-3 max-h-[70vh] overflow-y-auto" align="end">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold">Filters</p>
          {hasActive && <Button variant="ghost" size="sm" className="h-6 text-xs text-muted-foreground" onClick={() => onChange({ ...DEFAULT_FILTERS, assignedTo: clearAssignedTo })}>Clear</Button>}
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Stage</Label>
          <Select value={filters.stage} onValueChange={v => onChange({ ...filters, stage: v })}>
            <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("applicationsPage.all")}</SelectItem>
              {stages.map(s => <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Study Country</Label>
          <Select value={filters.country} onValueChange={v => onChange({ ...filters, country: v })}>
            <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent className="max-h-60">
              <SelectItem value="all">{t("applicationsPage.all")}</SelectItem>
              {countriesInApps.map(c => <SelectItem key={c.id} value={c.name}><span className="inline-flex items-center gap-1.5"><CountryFlag code={c.code} size="sm" />{c.name}</span></SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">University</Label>
          <Select value={filters.university} onValueChange={v => onChange({ ...filters, university: v })}>
            <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent className="max-h-60">
              <SelectItem value="all">{t("applicationsPage.all")}</SelectItem>
              {uniqueUniversities.map(([id, name]) => <SelectItem key={id} value={String(id)}>{name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">University Type</Label>
          <Select value={filters.universityType} onValueChange={v => onChange({ ...filters, universityType: v })}>
            <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("applicationsPage.all")}</SelectItem>
              <SelectItem value="state">{t("applicationsPage.state")}</SelectItem>
              <SelectItem value="private">{t("applicationsPage.privateLabel")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Agent</Label>
          <Select value={filters.agent} onValueChange={v => onChange({ ...filters, agent: v })}>
            <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent className="max-h-60">
              <SelectItem value="all">{t("applicationsPage.all")}</SelectItem>
              <SelectItem value="none">{t("leadsPage.noAgent")}</SelectItem>
              {uniqueAgents.map(([id, name]) => <SelectItem key={id} value={String(id)}>{name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Origin</Label>
          <Select value={filters.originType} onValueChange={v => onChange({ ...filters, originType: v })}>
            <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="direct">Direct</SelectItem>
              <SelectItem value="agent">Agent</SelectItem>
              <SelectItem value="sub_agent">Sub-Agent</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Assigned To</Label>
          <Select value={filters.assignedTo} onValueChange={v => onChange({ ...filters, assignedTo: v })}>
            <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent className="max-h-60">
              <SelectItem value="all">{t("applicationsPage.all")}</SelectItem>
              <SelectItem value="mine">{t("applicationsPage.me")}</SelectItem>
              <SelectItem value="unassigned">{t("applicationsPage.unassigned")}</SelectItem>
              <SelectItem value="mine_unassigned">{t("applicationsPage.meUnassigned")}</SelectItem>
              {canViewOthers && staffUsersList.filter(u => u.id !== currentUserId).map(u => (
                <SelectItem key={u.id} value={String(u.id)}>{u.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t("applicationsPage.source")}</Label>
          <Select value={filters.createdSource} onValueChange={v => onChange({ ...filters, createdSource: v })}>
            <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("applicationsPage.all")}</SelectItem>
              <SelectItem value="exclude_automation">{t("applicationsPage.excludeAutomation")}</SelectItem>
              <SelectItem value="only_automation">{t("applicationsPage.onlyAutomation")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Created Date</Label>
          <Select value={filters.dateRange} onValueChange={v => onChange({ ...filters, dateRange: v })}>
            <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("applicationsPage.allTime")}</SelectItem>
              <SelectItem value="today">{t("applicationsPage.today")}</SelectItem>
              <SelectItem value="yesterday">{t("applicationsPage.yesterday")}</SelectItem>
              <SelectItem value="last7">Last 7 Days</SelectItem>
              <SelectItem value="thisMonth">{t("applicationsPage.thisMonth")}</SelectItem>
              <SelectItem value="thisYear">{t("applicationsPage.thisYear")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button size="sm" className="w-full" onClick={() => setOpen(false)}>Apply</Button>
      </PopoverContent>
    </Popover>
    </>
  );
}

/* ── AddApplicationModal ─────────────────────────────────── */
function AddApplicationModal({ open, onClose, onSuccess, defaultStage }: { open: boolean; onClose: () => void; onSuccess: () => void; defaultStage?: string }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const { season } = useSeason();
  const { levels: studyLevels } = useStudyLevels();
  const { hasPermission } = useAuth();
  const canSeeCommission = hasPermission("applications.view_commission");
  const [selectedStudent, setSelectedStudent] = useState<Student | null>(null);
  const [form, setForm] = useState({ country: "", universityId: "", universityName: "", programId: "", programName: "", level: "", instructionLanguage: "", intake: "", tuitionFee: "", notes: "" });

  const { data: allCountriesAdd = [] } = useCountries();
  const activeDestinations = useMemo(() => allCountriesAdd.filter(c => c.isActive), [allCountriesAdd]);

  const { data: uniData } = useQuery<{ data: Array<{ id: number; name: string }> }>({
    queryKey: ["universities-by-country", form.country],
    queryFn: () => apiFetch(`${BASE_URL}/api/universities?country=${encodeURIComponent(form.country)}&limit=100`),
    enabled: !!form.country,
  });
  const universities = uniData?.data ?? [];

  const { data: progData } = useQuery<{ data: Array<{ id: number; name: string; degree?: string | null; language?: string | null; intakes?: string | null; tuitionFee?: number | null; discountedFee?: number | null; commissionRate?: number | null }> }>({
    queryKey: ["programs-by-university", form.universityId],
    queryFn: () => apiFetch(`${BASE_URL}/api/programs?universityId=${form.universityId}&limit=100`),
    enabled: !!form.universityId,
  });
  const programs = progData?.data ?? [];

  function degreeToLevel(degree?: string | null): string {
    if (!degree) return "";
    const d = degree.toLowerCase();
    if (d.includes("phd") || d.includes("doctorate")) return "doctorate";
    if (d.includes("mba")) return "mba";
    if (d.includes("msc") || d.includes("ma") || d.includes("master")) return "masters";
    if (d.includes("bsc") || d.includes("ba") || d.includes("undergrad")) return "undergraduate";
    if (d.includes("diploma")) return "diploma";
    if (d.includes("foundation")) return "foundation";
    return "";
  }

  function handleProgramSelect(programId: string) {
    const prog = programs.find(p => String(p.id) === programId);
    if (!prog) return;
    const autoLevel = degreeToLevel(prog.degree);
    const autoLang = prog.language && INSTRUCTION_LANGUAGES.includes(prog.language) ? prog.language : form.instructionLanguage;
    const effectiveFee = prog.discountedFee ?? prog.tuitionFee;
    const autoFee = effectiveFee != null ? String(effectiveFee) : form.tuitionFee;
    setForm({ ...form, programId, programName: prog.name, level: autoLevel || form.level, instructionLanguage: autoLang, intake: prog.intakes || form.intake, tuitionFee: autoFee });
  }

  const createApplication = useMutation({
    mutationFn: (payload: Record<string, unknown>) => apiFetch(`${BASE_URL}/api/applications`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }),
    onSuccess: () => { toast({ title: "Application created" }); handleClose(); onSuccess(); },
    onError: (err: any) => {
      toast(applicationCreationErrorToast(err, "Failed to create application"));
    },
  });

  function handleClose() { setSelectedStudent(null); setForm({ country: "", universityId: "", universityName: "", programId: "", programName: "", level: "", instructionLanguage: "", intake: "", tuitionFee: "", notes: "" }); onClose(); }

  function handleSubmit() {
    if (!selectedStudent) { toast({ title: "Select a student", variant: "destructive", duration: APPLICATION_CREATION_ERROR_TOAST_DURATION_MS }); return; }
    if (!form.country) { toast({ title: "Select a country", variant: "destructive", duration: APPLICATION_CREATION_ERROR_TOAST_DURATION_MS }); return; }
    if (!form.level) { toast({ title: "Select a level", variant: "destructive", duration: APPLICATION_CREATION_ERROR_TOAST_DURATION_MS }); return; }
    const fee = parseFloat(form.tuitionFee);
    createApplication.mutate({
      studentId: selectedStudent.id, stage: defaultStage || "inquiry", season,
      country: form.country || null,
      universityId: form.universityId ? parseInt(form.universityId, 10) : null,
      universityName: form.universityName || null,
      programId: form.programId ? parseInt(form.programId, 10) : null,
      level: form.level || null, programName: form.programName || null,
      instructionLanguage: form.instructionLanguage || null, intake: form.intake || null,
      tuitionFee: form.tuitionFee && !isNaN(fee) ? fee : null, notes: form.notes || null,
    });
  }

  const addSelProgForFee = programs.find(p => String(p.id) === form.programId);
  const addHasDiscountedFee = addSelProgForFee != null && addSelProgForFee.discountedFee != null;
  const addIntakeOptions = intakeOptions(addSelProgForFee?.intakes || form.intake);

  return (
    <>
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle className="text-xl font-display">New Application</DialogTitle></DialogHeader>
        <div className="space-y-5 py-2">
          <div className="space-y-2">
            <Label className="font-semibold flex items-center gap-1.5"><User className="w-4 h-4 text-primary" /> Student <span className="text-destructive">*</span></Label>
            <StudentSearchInput value={selectedStudent} onChange={setSelectedStudent} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="font-semibold">Country <span className="text-destructive">*</span></Label>
              <Select value={form.country} onValueChange={v => setForm({ ...form, country: v, universityId: "", universityName: "", programId: "", programName: "", level: "", instructionLanguage: "", intake: "" })}>
                <SelectTrigger className="rounded-xl"><SelectValue placeholder="Select..." /></SelectTrigger>
                <SelectContent className="max-h-60">{activeDestinations.map(c => <SelectItem key={c.id} value={c.name}><span className="inline-flex items-center gap-1.5"><CountryFlag code={c.code} size="sm" />{c.name}</span></SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label className="font-semibold">University</Label>
              <Select value={form.universityId} onValueChange={v => { const uni = universities.find(u => String(u.id) === v); setForm({ ...form, universityId: v, universityName: uni?.name ?? "", programId: "", programName: "", level: "", instructionLanguage: "", intake: "" }); }} disabled={!form.country || universities.length === 0}>
                <SelectTrigger className="rounded-xl"><SelectValue placeholder={!form.country ? "Select country first..." : universities.length === 0 ? "No universities" : "Select..."} /></SelectTrigger>
                <SelectContent className="max-h-60">{universities.map(u => <SelectItem key={u.id} value={String(u.id)}>{u.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label className="font-semibold">Level <span className="text-destructive">*</span></Label>
              <Select value={form.level} onValueChange={v => setForm({ ...form, level: v })}>
                <SelectTrigger className="rounded-xl"><SelectValue placeholder="Select..." /></SelectTrigger>
                <SelectContent>{studyLevels.map(l => <SelectItem key={l.key} value={l.key}>{l.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label className="font-semibold">Program</Label>
              <Select value={form.programId} onValueChange={handleProgramSelect} disabled={!form.universityId || programs.length === 0}>
                <SelectTrigger className="rounded-xl"><SelectValue placeholder={!form.universityId ? "Select uni first..." : programs.length === 0 ? "No programs" : "Select..."} /></SelectTrigger>
                <SelectContent className="max-h-60">{programs.map(p => <SelectItem key={p.id} value={String(p.id)}>{p.name}{p.degree && <span className="text-muted-foreground ml-1 text-xs">({p.degree})</span>}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label className="font-semibold">Language</Label>
              <Select value={form.instructionLanguage} onValueChange={v => setForm({ ...form, instructionLanguage: v })}>
                <SelectTrigger className="rounded-xl"><SelectValue placeholder="Select..." /></SelectTrigger>
                <SelectContent>{INSTRUCTION_LANGUAGES.map(l => <SelectItem key={l} value={l}>{l}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label className="font-semibold">Intake</Label>
              <Select value={form.intake} onValueChange={v => setForm({ ...form, intake: v })}>
                <SelectTrigger className="rounded-xl"><SelectValue placeholder="Select..." /></SelectTrigger>
                <SelectContent>{addIntakeOptions.map(i => <SelectItem key={i} value={i}>{i}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-2 col-span-2">
              <Label className="font-semibold flex items-center gap-2">
                <TrendingUp className="w-3.5 h-3.5 text-emerald-500" />
                Tuition Fee (USD)
                {addHasDiscountedFee && <span className="text-xs font-normal text-amber-600 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded-full dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-700/50">Discounted</span>}
              </Label>
              <Input type="number" min="0" step="100" value={form.tuitionFee} onChange={e => setForm({ ...form, tuitionFee: e.target.value })} placeholder="e.g. 15000" className="rounded-xl" />
              {addSelProgForFee && (addSelProgForFee.tuitionFee != null || addSelProgForFee.discountedFee != null || addSelProgForFee.commissionRate != null) && (
                <div className="flex flex-wrap gap-3 text-xs">
                  {addSelProgForFee.tuitionFee != null && <span className="text-muted-foreground">Standard: <strong>${addSelProgForFee.tuitionFee.toLocaleString()}</strong></span>}
                  {addSelProgForFee.discountedFee != null && <span className="text-amber-600">Discounted: <strong>${addSelProgForFee.discountedFee.toLocaleString()}</strong></span>}
                  {canSeeCommission && addSelProgForFee.commissionRate != null && <span className="text-indigo-600">Commission: <strong>{addSelProgForFee.commissionRate}%</strong></span>}
                </div>
              )}
            </div>
            <div className="space-y-2 col-span-2">
              <Label className="font-semibold">Notes</Label>
              <textarea placeholder={t("applicationsPage.notesPlaceholder")} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} rows={2} className="w-full rounded-xl border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-none" />
            </div>
          </div>
        </div>
        <DialogFooter className="gap-2 pt-2">
          <Button variant="outline" onClick={handleClose} className="rounded-xl">{t("applicationsPage.cancel")}</Button>
          <Button onClick={handleSubmit} disabled={createApplication.isPending || !selectedStudent || !form.country || !form.level} className="rounded-xl">{createApplication.isPending ? "Creating..." : "Create Application"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}

/* ── ApplicationsPage ────────────────────────────────────── */
export default function ApplicationsPage() {
  const { t } = useI18n();
  const dateFormat = useDateFormat();
  const { levels: studyLevels, labelOf: studyLabelOf } = useStudyLevels();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { season } = useSeason();
  const { user, hasPermission } = useAuth(true, ["super_admin", "admin", "manager", "staff", "consultant", "editor", "accountant"]);
  const canSeeCommission = hasPermission("applications.view_commission");
  const canViewOthers = hasPermission("records.view_others");
  const canViewUnassigned = hasPermission("records.view_unassigned");

  const {
    prefs: colPrefs,
    toggleHidden: toggleAppColRaw,
    moveColumn: moveAppCol,
    reset: resetAppCols,
  } = useTablePrefs("applications-table", APP_DEFAULT_PREFS, user?.id);

  // Task #167 — button1/button2 are always visible even if saved prefs hide them.
  const visibleAppCols = useMemo(() => {
    const alwaysSet = new Set<string>(APP_ALWAYS_VISIBLE_COLS);
    const knownIds = new Set<string>(APP_COLUMN_DEFS.map((c) => c.id));
    const ordered = colPrefs.order.filter((id) => knownIds.has(id));
    // Ensure always-visible cols exist in the order (append missing at end).
    APP_ALWAYS_VISIBLE_COLS.forEach((id) => { if (!ordered.includes(id)) ordered.push(id); });
    return ordered.filter((id) => alwaysSet.has(id) || !colPrefs.hidden.includes(id));
  }, [colPrefs.order, colPrefs.hidden]);

  const toggleAppCol = (id: string) => {
    if ((APP_ALWAYS_VISIBLE_COLS as string[]).includes(id)) return;
    toggleAppColRaw(id);
  };

  const [search, setSearch] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [viewMode, setViewMode] = useState<"pipeline" | "list">(() => (localStorage.getItem(VIEW_KEY) as "pipeline" | "list") || "list");
  // Role-based default for the "Assigned to" filter: admins/managers/super admins
  // default to "all", every other role to the restricted value they are allowed to
  // see. Shared between the persisted default and the filter panel's Clear action.
  const roleBasedAssignedDefault =
    (user?.role === "super_admin" || user?.role === "admin" || user?.role === "manager") ? "all" : DEFAULT_FILTERS.assignedTo;
  // Persist the user's "Assigned to" choice locally (per user), like column prefs.
  const [persistedAssignedTo, setPersistedAssignedTo] = usePersistedFilterValue(
    "applications-table", "assignedTo_v2",
    roleBasedAssignedDefault,
    user?.id,
  );
  const [filters, setFilters] = useState<AppFilters>({ ...DEFAULT_FILTERS, assignedTo: persistedAssignedTo });
  // Restore saved value into filters once auth (and thus the per-user key) resolves.
  useEffect(() => {
    setFilters(f => f.assignedTo === persistedAssignedTo ? f : { ...f, assignedTo: persistedAssignedTo });
  }, [persistedAssignedTo]);
  // Persist whenever the user changes the choice. Use a ref for the setter so this
  // only fires on an actual assignedTo change — depending on setPersistedAssignedTo
  // (whose identity changes when the userId-scoped key resolves) would re-fire on
  // key change and clobber the freshly-restored value with stale pre-auth state.
  const persistAssignedToRef = useRef(setPersistedAssignedTo);
  persistAssignedToRef.current = setPersistedAssignedTo;
  useEffect(() => {
    persistAssignedToRef.current(filters.assignedTo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.assignedTo]);
  const [colFilters, setColFilters] = useState({ student: "", program: "", level: "all", intake: "" });
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [messageCampaignOpen, setMessageCampaignOpen] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "date", dir: "desc" });
  const [editApp, setEditApp] = useState<any>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [tableUniInfoId, setTableUniInfoId] = useState<number | null>(null);
  const [tableProgInfoId, setTableProgInfoId] = useState<number | null>(null);
  const [deleteInProgress, setDeleteInProgress] = useState(false);
  const [runConfirmOpen, setRunConfirmOpen] = useState(false);
  const [runInProgress, setRunInProgress] = useState(false);
  const [pipelineLimits, setPipelineLimits] = useState<Record<string, number>>({});
  const [visiblePipelineStages, setVisiblePipelineStages] = useState<Set<string>>(new Set());
  const pg = useTablePagination(25);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [docUploadDialog, setDocUploadDialog] = useState<{ appId: number; uploadStage: string; targetStage: string; targetStageLabel: string; documentNameOverride?: string | null; moveAfterUpload?: boolean; quickMode?: boolean } | null>(null);
  // Task #269 — modern per-application document-request modal, opened when an
  // application is moved INTO a stage with the "Belge Yükle" (missing_docs)
  // action, or manually via the stage action button. `retryTarget` is the
  // stage to move to after the requests are saved (null = manual edit only).
  const [docRequestDialog, setDocRequestDialog] = useState<{ appId: number; stage: string; stageLabel: string; suggestedDocTypes: string[]; title: string | null; retryTarget: string | null } | null>(null);
  // Task #269 — shown when a forward move is blocked because the current stage
  // still has unfulfilled document requests.
  const [docsIncompleteDialog, setDocsIncompleteDialog] = useState<{ appId: number; currentStageLabel: string; missing: MissingDocEntry[]; retryTarget: string } | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor)
  );

  const { stages: pipelineStages } = usePipelineStages("application");
  const stageOrder = pipelineStages.map(s => s.key);
  const stageMap = Object.fromEntries(pipelineStages.map((s, i) => [s.key, { ...s, _index: i }]));
  const pipelineStageKeys = stageOrder.join("\u001f");
  useEffect(() => {
    const initialKeys = filters.stage !== "all"
      ? pipelineStages.filter(stage => stage.key === filters.stage).map(stage => stage.key)
      : [];
    setVisiblePipelineStages(new Set(initialKeys));
  }, [filters.stage, pipelineStageKeys]);
  const markPipelineStageVisible = useCallback((stageKey: string) => {
    setVisiblePipelineStages(current => {
      if (current.has(stageKey)) return current;
      const next = new Set(current);
      next.add(stageKey);
      return next;
    });
  }, []);

  const [debouncedSearch, setDebouncedSearch] = useState(search);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const applicationListParams = useMemo(() => {
    const params = new URLSearchParams({
      season,
      page: String(pg.page),
      limit: String(pg.pageSize),
      sortKey: sort.key,
      sortDir: sort.dir,
    });
    const setIf = (key: string, value: string | undefined) => {
      if (value && value !== "all") params.set(key, value);
    };
    setIf("search", debouncedSearch);
    setIf("stage", filters.stage);
    setIf("country", filters.country);
    setIf("universityId", filters.university);
    setIf("universityType", filters.universityType);
    setIf("agentId", filters.agent);
    setIf("assignment", filters.assignedTo);
    setIf("dateRange", filters.dateRange);
    setIf("originType", filters.originType);
    setIf("createdSource", filters.createdSource);
    setIf("name", colFilters.student);
    setIf("program", colFilters.program);
    setIf("level", colFilters.level);
    setIf("intake", colFilters.intake);
    const shouldIncludeFacets = pg.page === 1;
    params.set("includeFacets", shouldIncludeFacets ? "1" : "0");
    return params.toString();
  }, [
    season, pg.page, pg.pageSize, sort, debouncedSearch,
    filters, colFilters,
  ]);

  const { data: applicationsResp, isLoading } = useQuery({
    queryKey: ["applications", applicationListParams],
    queryFn: ({ signal }) => apiFetch(`${BASE_URL}/api/applications?${applicationListParams}`, { signal }),
    enabled: viewMode === "list",
  });
  const applicationFacetScopeKey = useMemo(() => {
    const params = new URLSearchParams(applicationListParams);
    params.delete("page");
    params.delete("limit");
    params.delete("includeFacets");
    params.sort();
    return params.toString();
  }, [applicationListParams]);
  const applicationFacetCache = useRef<{
    key: string;
    facets: ApplicationFilterFacets;
  } | null>(null);
  const listApplicationFacets = useMemo(() => {
    const facets = applicationsResp?.meta?.facets as ApplicationFilterFacets | undefined;
    if (facets) {
      const next = { key: applicationFacetScopeKey, facets };
      applicationFacetCache.current = next;
      return facets;
    }
    return applicationFacetCache.current?.key === applicationFacetScopeKey
      ? applicationFacetCache.current.facets
      : undefined;
  }, [applicationsResp, applicationFacetScopeKey]);

  const pipelineSummaryParams = useMemo(() => {
    const params = new URLSearchParams(applicationListParams);
    params.delete("page");
    params.delete("limit");
    params.set("pipelineSummary", "1");
    params.set("includeFacets", "1");
    return params.toString();
  }, [applicationListParams]);
  const { data: pipelineSummaryResp, isLoading: isPipelineSummaryLoading } = useQuery({
    queryKey: ["applications", "pipeline-summary", pipelineSummaryParams],
    queryFn: ({ signal }) => apiFetch(`${BASE_URL}/api/applications?${pipelineSummaryParams}`, { signal }),
    enabled: viewMode === "pipeline",
  });
  const pipelineSummaryMap = useMemo(() => new Map<string, { total: number; totalCommission?: number }>(
    (pipelineSummaryResp?.meta?.stages || []).map((row: any) => [String(row.stage), {
      total: Number(row.total || 0),
      totalCommission: row.totalCommission == null ? undefined : Number(row.totalCommission),
    }]),
  ), [pipelineSummaryResp]);

  const pipelineStageQueries = useQueries({
    queries: pipelineStages.map((stageDef) => {
      const limit = pipelineLimits[stageDef.key] ?? PIPELINE_BATCH_SIZE;
      const params = new URLSearchParams(applicationListParams);
      params.set("page", "1");
      params.set("limit", String(limit));
      params.set("stage", stageDef.key);
      params.set("includeFacets", "0");
      params.set("includeTotals", "0");
      return {
        queryKey: ["applications", "pipeline", stageDef.key, params.toString()],
        queryFn: ({ signal }: { signal: AbortSignal }) => apiFetch(`${BASE_URL}/api/applications?${params.toString()}`, { signal }),
        enabled: viewMode === "pipeline"
          && visiblePipelineStages.has(stageDef.key)
          && (filters.stage === "all" || filters.stage === stageDef.key),
      };
    }),
  });

  const pipelineStageData = useMemo(() => {
    const entries = pipelineStages.map((stageDef, index) => {
      const query = pipelineStageQueries[index];
      const summary = pipelineSummaryMap.get(stageDef.key);
      return [stageDef.key, {
        apps: (query?.data?.data || []) as any[],
        total: summary?.total || 0,
        totalCommission: summary?.totalCommission,
        isLoading: Boolean(isPipelineSummaryLoading || query?.isLoading || query?.isFetching),
      }] as const;
    });
    return new Map(entries);
  }, [pipelineStages, pipelineStageQueries, pipelineSummaryMap, isPipelineSummaryLoading]);

  const pipelineApps = useMemo(
    () => Array.from(pipelineStageData.values()).flatMap(stageData => stageData.apps),
    [pipelineStageData],
  );
  const allApps: any[] = viewMode === "list" ? (applicationsResp?.data || []) : pipelineApps;
  const pipelineFacets = pipelineSummaryResp?.meta?.facets;
  const applicationFacets = (viewMode === "list" ? listApplicationFacets : pipelineFacets) as ApplicationFilterFacets | undefined;

  const uniqueAppCountries = useMemo(() => {
    const set = new Set<string>(applicationFacets?.countries || []);
    allApps.forEach((a: any) => { if (a.country) set.add(a.country); });
    return Array.from(set).sort();
  }, [allApps, applicationFacets?.countries]);

  const uniqueAppUniversities = useMemo(() => {
    if (applicationFacets?.universities?.length) {
      return applicationFacets.universities.map(u => [u.id, u.name] as [number, string]);
    }
    const m = new Map<number, string>();
    allApps.forEach((a: any) => { if (a.universityId) m.set(a.universityId, a.universityName || ""); });
    return Array.from(m.entries()).sort((a, b) => (a[1] || "").localeCompare(b[1] || ""));
  }, [allApps, applicationFacets?.universities]);

  const isAdmin = user?.role === "super_admin" || user?.role === "admin" || user?.role === "manager";
  const canMoveCards = isAdmin || hasPermission("records.move_cards");
  const canAssign = isAdmin || hasPermission("records.assign_button");
  const canReassign = !!isAdmin; // Task #494: non-admin relies on per-record current-assignee check

  const { data: staffUsersData } = useQuery({
    queryKey: ["staff-users-list"],
    queryFn: ({ signal }) => apiFetch(`${BASE_URL}/api/users?roles=super_admin,admin,manager,staff,consultant,accountant,editor&limit=100`, { signal }),
    staleTime: 5 * 60 * 1000,
  });
  const staffUsers = staffUsersData
    ? (Array.isArray(staffUsersData) ? staffUsersData : staffUsersData?.data || []).filter((u: any) => ["super_admin", "admin", "manager", "staff", "consultant", "accountant", "editor"].includes(u.role))
    : [];
  const staffUsersMap = useMemo(() => {
    const m: Record<number, string> = {};
    staffUsers.forEach((u: any) => { m[u.id] = `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email; });
    return m;
  }, [staffUsers]);

  const staffUsersList = useMemo(() =>
    staffUsers.map((u: any) => ({ id: u.id, name: `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email })),
    [staffUsers]
  );

  async function handleAssign(appId: number, userId: number) {
    try {
      await apiFetch(`${BASE_URL}/api/applications/${appId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignedToId: userId }),
      });
      await invalidateAssignmentWorkspaceQueries(queryClient);
      toast({ title: "Application assigned" });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  }

  const filteredApps = allApps.filter((a: any) => {
    if (colFilters.student) {
      const sn = `${a.studentFirstName || ""} ${a.studentLastName || ""}`.toLowerCase();
      if (!sn.includes(colFilters.student.toLowerCase())) return false;
    }
    if (colFilters.program && !(a.programName || "").toLowerCase().includes(colFilters.program.toLowerCase())) return false;
    if (colFilters.level !== "all" && (a.level || "") !== colFilters.level) return false;
    if (colFilters.intake && !(a.intake || "").toLowerCase().includes(colFilters.intake.toLowerCase())) return false;
    if (filters.stage !== "all" && a.stage !== filters.stage) return false;
    if (filters.country !== "all" && a.country !== filters.country) return false;
    if (filters.university !== "all" && String(a.universityId) !== filters.university) return false;
    if (filters.universityType !== "all") {
      const uType = (a.universityType || "").toLowerCase();
      const expectedType = filters.universityType === "state" ? "public" : filters.universityType;
      if (uType !== expectedType && !(filters.universityType === "state" && uType === "state")) return false;
    }
    if (filters.agent !== "all") {
      if (filters.agent === "none") { if (a.agentId) return false; }
      else if (String(a.agentId) !== filters.agent) return false;
    }
    if (filters.assignedTo === "mine" && a.assignedToId !== user?.id) return false;
    if (filters.assignedTo === "mine_unassigned" && !(a.assignedToId === user?.id || a.assignedToId == null)) return false;
    if (filters.assignedTo === "unassigned" && a.assignedToId != null) return false;
    if (filters.assignedTo !== "all" && filters.assignedTo !== "mine" && filters.assignedTo !== "mine_unassigned" && filters.assignedTo !== "unassigned" && !isNaN(Number(filters.assignedTo)) && a.assignedToId !== Number(filters.assignedTo)) return false;
    if (filters.originType !== "all" && (a.originType || "direct") !== filters.originType) return false;
    if (filters.createdSource === "exclude_automation" && (a.createdSource || "student") === "automation") return false;
    if (filters.createdSource === "only_automation" && (a.createdSource || "student") !== "automation") return false;
    if (filters.dateRange !== "all" && a.createdAt && !isDateInRange(a.createdAt, filters.dateRange)) return false;
    if (search) {
      const q = search.toLowerCase();
      const name = `${a.studentFirstName || ""} ${a.studentLastName || ""}`.toLowerCase();
      if (!name.includes(q) && !(a.universityName || "").toLowerCase().includes(q) && !(a.programName || "").toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const sortedApps = useMemo(() => {
    const arr = [...filteredApps];
    arr.sort((a: any, b: any) => {
      let valA: any, valB: any;
      switch (sort.key) {
        case "student": valA = `${a.studentFirstName} ${a.studentLastName}`.toLowerCase(); valB = `${b.studentFirstName} ${b.studentLastName}`.toLowerCase(); break;
        case "stage": {
          const indexA = stageOrder.indexOf(a.stage);
          const indexB = stageOrder.indexOf(b.stage);
          // Keep retired/unknown custom stages after configured pipeline
          // stages, matching the server-side ordering used before pagination.
          valA = indexA === -1 ? Number.MAX_SAFE_INTEGER : indexA;
          valB = indexB === -1 ? Number.MAX_SAFE_INTEGER : indexB;
          break;
        }
        case "country": valA = (a.country || "").toLowerCase(); valB = (b.country || "").toLowerCase(); break;
        case "university": valA = (a.universityName || "").toLowerCase(); valB = (b.universityName || "").toLowerCase(); break;
        case "program": valA = (a.programName || "").toLowerCase(); valB = (b.programName || "").toLowerCase(); break;
        case "level": valA = a.level || ""; valB = b.level || ""; break;
        case "intake": valA = a.intake || ""; valB = b.intake || ""; break;
        case "fee": valA = parseFloat(a.commissionAmount) || 0; valB = parseFloat(b.commissionAmount) || 0; break;
        case "date": valA = a.createdAt || ""; valB = b.createdAt || ""; break;
        default: return 0;
      }
      if (valA < valB) return sort.dir === "asc" ? -1 : 1;
      if (valA > valB) return sort.dir === "asc" ? 1 : -1;
      return 0;
    });
    return arr;
  }, [filteredApps, sort, stageOrder]);

  const pagedApps = sortedApps;
  const totalAppsCount = viewMode === "list"
    ? Number(applicationsResp?.meta?.total ?? sortedApps.length)
    : Number(pipelineSummaryResp?.meta?.total || 0);

  useEffect(() => { pg.setPage(1); setSelectedIds(new Set()); }, [search, filters, colFilters, sort]);
  useEffect(() => { setPipelineLimits({}); }, [season, debouncedSearch, filters, colFilters, sort]);

  const pagedIds = useMemo(() => new Set(pagedApps.map((a: any) => a.id)), [pagedApps]);
  const allPageSelected = pagedApps.length > 0 && pagedApps.every((a: any) => selectedIds.has(a.id));

  function toggleView(mode: "pipeline" | "list") { setViewMode(mode); localStorage.setItem(VIEW_KEY, mode); setSelectedIds(new Set()); }
  function handleSort(key: SortKey) { setSort(prev => prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }); }
  function toggleSelect(id: number) { setSelectedIds(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }
  function toggleSelectAll() {
    if (allPageSelected) { setSelectedIds(prev => { const next = new Set(prev); pagedIds.forEach(id => next.delete(id)); return next; }); }
    else { setSelectedIds(prev => { const next = new Set(prev); pagedIds.forEach(id => next.add(id)); return next; }); }
  }

  const allColumnIds = new Set(pipelineStages.map(s => s.key));
  const activeCard = activeId ? allApps.find((a: any) => a.id === activeId) : null;

  const handleDragStart = (event: DragStartEvent) => setActiveId(event.active.id as number);

  const isSuperAdmin = user?.role === "super_admin";

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);
    if (!over) return;

    if (!canMoveCards) {
      toast({ title: "You don't have permission to move cards", variant: "destructive" });
      return;
    }

    const appId = active.id as number;
    const overId = over.id;

    let targetStage: string;
    if (allColumnIds.has(overId as string)) {
      targetStage = overId as string;
    } else {
      const overApp = allApps.find((a: any) => a.id === overId);
      if (!overApp) return;
      targetStage = overApp.stage;
    }

    const app = allApps.find((a: any) => a.id === appId);
    if (!app || app.stage === targetStage) return;

    void performStageMove(appId, targetStage);
  };

  const stageLabelOf = (key: string) => pipelineStages.find((s) => s.key === key)?.label ?? key;

  // Task #269 — single source of truth for every stage transition (kanban drag,
  // list/detail action buttons). Calls the centralized PATCH and routes the
  // document-gating 422 responses to the right modal: DOC_SELECTION_REQUIRED →
  // doc-request modal (then retry move), DOCS_INCOMPLETE → incomplete-docs
  // modal, DOCS_REQUIRED → file upload dialog. Returns true on a completed move.
  async function performStageMove(appId: number, targetStage: string): Promise<boolean> {
    const colLabel = stageLabelOf(targetStage);
    const result = await requestStageChange(appId, targetStage);
    switch (result.kind) {
      case "ok":
        queryClient.invalidateQueries({ queryKey: ["applications"] });
        queryClient.invalidateQueries({ queryKey: [`/api/applications/${appId}`] });
        toast({ title: t("staffApplications.movedTo", { stage: colLabel }) });
        return true;
      case "doc_selection_required":
        setDocRequestDialog({
          appId,
          stage: result.requiredStage,
          stageLabel: stageLabelOf(result.requiredStage),
          suggestedDocTypes: result.suggestedDocTypes,
          title: result.actionLabel,
          retryTarget: targetStage,
        });
        return false;
      case "docs_incomplete":
        setDocsIncompleteDialog({
          appId,
          currentStageLabel: stageLabelOf(result.currentStage),
          missing: result.missing,
          retryTarget: targetStage,
        });
        return false;
      case "docs_required":
        setDocUploadDialog({ appId, uploadStage: targetStage, targetStage, targetStageLabel: colLabel });
        return false;
      case "student_docs_required":
        toast({ title: t("staffApplications.studentDocsRequired"), description: result.missingDocTypes.join(", "), variant: "destructive" });
        return false;
      default:
        toast({ title: t("common.error"), description: result.message, variant: "destructive" });
        return false;
    }
  }

  // Task #167 — generic stage transition used by stage action buttons. Returns
  // true on success so callers can chain follow-up UI (close dialogs, reset
  // state). "Don't change" semantics: empty/null target = no transition.
  async function moveAppToStage(appId: number, targetStage: string | null | undefined): Promise<boolean> {
    if (!targetStage) return true;
    return performStageMove(appId, targetStage);
  }

  async function handleStageAction(app: ApplicationRow, action: StageAction) {
    const sourceStage = pipelineStages.find((stage) => stage.key === app.stage);
    const completionTargetKey = resolveStageCompletionTargetKey(sourceStage, pipelineStages);
    // Older pipeline rows can have a Deposit Receipt quick action without a
    // target. Keep those rows compatible with the canonical lifecycle.
    const actionName = `${action.label || ""} ${action.documentName || ""}`.trim().toLowerCase();
    const isDepositReceiptUpload = action.type === "upload" && /deposit[ _-]*receipt/.test(actionName);
    const targetKey = completionTargetKey
      ?? action.targetStageKey
      ?? (isDepositReceiptUpload && pipelineStages.some((stage) => stage.key === "upload_payment")
        ? "upload_payment"
        : null);
    const targetLabel = targetKey
      ? (pipelineStages.find((s) => s.key === targetKey)?.label ?? targetKey)
      : "";
    const buttonLabel = action.label || (action.type === "upload" ? "Upload" : action.type === "download" ? "Download" : "Missing Docs");
    if (action.type === "upload") {
      // Task #167 — when the action moves to a different stage, attach the
      // uploaded document to that TARGET stage so it satisfies any
      // file-upload-mandatory rule on the target and the PATCH /stage
      // transition is not blocked by DOCS_REQUIRED. When the target is
      // "Don't change" (stay), attach to the current stage.
      const uploadStageKey = targetKey ?? app.stage;
      setDocUploadDialog({
        appId: app.id,
        uploadStage: uploadStageKey,
        targetStage: targetKey ?? app.stage,
        targetStageLabel: targetLabel || (pipelineStages.find((s) => s.key === app.stage)?.label ?? app.stage),
        documentNameOverride: action.documentName ?? null,
        moveAfterUpload: !!targetKey,
        quickMode: true,
      });
      return;
    }
    if (action.type === "download") {
      try {
        const docs = await apiFetch(`${BASE_URL}/api/applications/${app.id}/stage-documents?stage=${encodeURIComponent(app.stage)}`) as StageDocumentEntry[];
        // Exclude missing-doc-note rows and non-file entries — only real
        // uploaded documents (have either fileData or fileUrl) are
        // downloadable. Then match by admin-configured Document Name.
        const list = (Array.isArray(docs) ? docs : []).filter(
          (d) => !d.isMissingDocNote && (d.hasFileData || d.fileUrl)
        );
        const wanted = (action.documentName || "").trim().toLowerCase();
        const filtered = wanted
          ? list.filter((d) => (d.fileName || "").toLowerCase().includes(wanted))
          : list;
        if (filtered.length === 0) {
          toast({
            title: "Belge bulunamadı",
            description: wanted
              ? `"${action.documentName}" adlı belge bu aşamada yok.`
              : "Bu aşamada indirilebilecek bir belge yok.",
            variant: "destructive",
          });
          return;
        }
        const latest = filtered.slice().sort((a, b) => (b.id ?? 0) - (a.id ?? 0))[0];
        const link = document.createElement("a");
        link.href = `${BASE_URL}/api/applications/${app.id}/stage-documents/${latest.id}/download`;
        link.target = "_blank";
        link.rel = "noopener";
        link.click();
        await moveAppToStage(app.id, targetKey);
      } catch {
        toast({ title: "Error", description: "Belge indirilemedi", variant: "destructive" });
      }
      return;
    }
    if (action.type === "missing_docs") {
      // The missing_docs action requests documents via the shared modern modal.
      // Two shapes are supported:
      //   - New: request documents for the CURRENT stage; the stage-level
      //     completion target is applied by the fulfillment hook only after
      //     every requested catalog document is complete.
      //   - Legacy (no stage-level target, action has targetStageKey): retain
      //     the previous move-first behavior for already-saved pipelines.
      if (!completionTargetKey && action.targetStageKey) {
        await performStageMove(app.id, action.targetStageKey);
        return;
      }
      const required = Array.isArray(action.requiredDocTypes) ? action.requiredDocTypes : [];
      setDocRequestDialog({
        appId: app.id,
        stage: app.stage,
        stageLabel: pipelineStages.find((s) => s.key === app.stage)?.label ?? app.stage,
        suggestedDocTypes: required,
        title: buttonLabel,
        retryTarget: null,
      });
      return;
    }
  }

  const deleteApp = useMutation({ mutationFn: (id: number) => apiFetch(`${BASE_URL}/api/applications/${id}`, { method: "DELETE" }) });

  async function handleBulkDelete() {
    setDeleteInProgress(true);
    try {
      const res = await apiFetch(`${BASE_URL}/api/applications/bulk-action`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: Array.from(selectedIds), action: "delete" }) });
      const d = res as any;
      toast({ title: `${d.updated} application${d.updated !== 1 ? "s" : ""} deleted` });
    } catch { toast({ title: "Some could not be deleted", variant: "destructive" }); }
    setDeleteInProgress(false); setDeleteOpen(false); setSelectedIds(new Set());
    queryClient.invalidateQueries({ queryKey: ["applications"] });
  }

  async function handleBulkAssign(userId: number) {
    try {
      const res = await apiFetch(`${BASE_URL}/api/applications/bulk-action`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: Array.from(selectedIds), action: "assign", assignedToId: userId }) });
      const d = res as any;
      toast({ title: `${d.updated} application${d.updated !== 1 ? "s" : ""} assigned` });
      await invalidateAssignmentWorkspaceQueries(queryClient);
    } catch { toast({ title: "Could not assign applications", variant: "destructive" }); }
    setSelectedIds(new Set());
    queryClient.invalidateQueries({ queryKey: ["applications"] });
  }

  async function handleBulkMoveStage(stage: string) {
    try {
      const res = await apiFetch(`${BASE_URL}/api/applications/bulk-action`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: Array.from(selectedIds), action: "move", stage }) });
      const d = res as any;
      const skipped: any[] = Array.isArray(d.skipped) ? d.skipped : [];
      toast({ title: `${d.updated} application${d.updated !== 1 ? "s" : ""} moved` });
      if (skipped.length > 0) {
        // Task #269 — bulk moves can't open a per-application document modal, so
        // affected applications are skipped server-side and reported here.
        toast({
          title: t("staffApplications.bulkSkippedTitle", { count: skipped.length }),
          description: t("staffApplications.bulkSkippedDesc"),
          variant: "destructive",
        });
      }
    } catch { toast({ title: "Could not move applications", variant: "destructive" }); }
    setSelectedIds(new Set());
    queryClient.invalidateQueries({ queryKey: ["applications"] });
  }

  async function handleBulkRun() {
    setRunInProgress(true);
    try {
      const res = await apiFetch(`${BASE_URL}/api/applications/bulk-action`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: Array.from(selectedIds), action: "run_portal_automation" }) });
      const d = res as any;
      const queuedN: number = Array.isArray(d.queued) ? d.queued.length : 0;
      const skippedArr: any[] = Array.isArray(d.skipped) ? d.skipped : [];
      const noAdapterN = skippedArr.filter((s) => s.reason === "NO_PORTAL").length;
      const alreadyQueuedN = skippedArr.filter((s) => s.reason === "ALREADY_QUEUED").length;
      const missingDocs = skippedArr.filter((s) => s.reason === "MISSING_MANDATORY_DOCUMENTS");
      const preflightBlocked = skippedArr.filter((s) => s.reason === "PREFLIGHT_NOT_READY");
      const descParts: string[] = [];
      if (noAdapterN > 0) descParts.push(t("portalAutomation.bulkRun.noAdapterNote", { count: noAdapterN }));
      if (alreadyQueuedN > 0) descParts.push(t("portalAutomation.bulkRun.alreadyQueuedNote", { count: alreadyQueuedN }));
      if (missingDocs.length > 0) {
        const labels = Array.from(new Set(
          missingDocs.flatMap((s: any) => Array.isArray(s.missingDocLabels) ? s.missingDocLabels : []),
        ));
        descParts.push(
          `${missingDocs.length} application(s) stayed out of the queue because mandatory documents are missing` +
          (labels.length > 0 ? `: ${labels.join(", ")}` : ""),
        );
      }
      if (preflightBlocked.length > 0) {
        const fields = collectPortalPreflightIssueLabels(preflightBlocked);
        descParts.push(
          t("portalAutomation.bulkRun.preflightNote", {
            count: preflightBlocked.length,
            fields: fields.join(", "),
          }),
        );
      }
      toast({
        title: t("portalAutomation.bulkRun.queuedToast", { count: queuedN }),
        description: descParts.length > 0 ? descParts.join(" · ") : undefined,
        variant:
          queuedN === 0 && (missingDocs.length > 0 || preflightBlocked.length > 0)
            ? "destructive"
            : undefined,
      });
    } catch {
      toast({ title: t("portalAutomation.bulkRun.submitError"), variant: "destructive" });
    }
    setRunInProgress(false);
    setRunConfirmOpen(false);
    setSelectedIds(new Set());
    queryClient.invalidateQueries({ queryKey: ["applications"] });
    queryClient.invalidateQueries({ queryKey: ["portal-submissions"] });
  }

  return (
    <>
      <div className="h-[calc(100vh-8rem)] flex flex-col">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6 shrink-0">
          <div>
            <h1 className="text-3xl font-display font-bold text-foreground">{t("staffApplications.title")}</h1>
            <p className="text-muted-foreground text-sm mt-1">{t("staffApplications.subtitle")}</p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <div className="relative w-full sm:w-56 lg:w-64">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input placeholder={t("applicationsPage.searchApplications")} value={search} onChange={e => setSearch(e.target.value)} className="pl-9 bg-white dark:bg-black/20 border-border rounded-full" />
            </div>
            <FilterPopover filters={filters} onChange={setFilters} stages={pipelineStages} apps={allApps} facets={applicationFacets} staffUsersList={staffUsersList} canViewOthers={canViewOthers} canViewUnassigned={canViewUnassigned} currentUserId={user?.id} clearAssignedTo={roleBasedAssignedDefault} />
            <div className="flex items-center border rounded-full overflow-hidden">
              <button onClick={() => toggleView("pipeline")} className={`p-2 transition-colors ${viewMode === "pipeline" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted"}`} title="Pipeline view"><LayoutGrid className="w-4 h-4" /></button>
              <button onClick={() => toggleView("list")} className={`p-2 transition-colors ${viewMode === "list" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted"}`} title="List view"><List className="w-4 h-4" /></button>
            </div>
            <BulkActionBar
              selectedCount={selectedIds.size}
              onDelete={(isAdmin || hasPermission("applications.delete")) ? () => setDeleteOpen(true) : undefined}
              onAssign={handleBulkAssign}
              onMove={handleBulkMoveStage}
              onSendMessage={() => setMessageCampaignOpen(true)}
              stages={pipelineStages.map(s => ({ key: s.key, label: s.label }))}
              staffUsers={canReassign ? staffUsersList : []}
              entityLabel="applications"
              moveLabel="Move Stage"
            />
            {selectedIds.size > 0 && (
              <Button
                variant="outline"
                size="sm"
                className="rounded-full h-8 gap-1.5 border-emerald-300 text-emerald-700 hover:bg-emerald-50"
                onClick={() => setRunConfirmOpen(true)}
              >
                <Send className="w-3.5 h-3.5" /> {t("portalAutomation.bulkRun.button")}
              </Button>
            )}
            {viewMode === "list" && (
              <ColumnSettingsMenu
                columns={APP_COLUMN_DEFS.filter(c => c.id !== "commission" || canSeeCommission)}
                order={colPrefs.order}
                hidden={colPrefs.hidden}
                onToggle={toggleAppCol}
                onMove={moveAppCol}
                onReset={resetAppCols}
                alwaysVisibleIds={APP_ALWAYS_VISIBLE_COLS}
              />
            )}
            {isAdmin && (
              <Button variant="outline" size="sm" className="rounded-full h-8 gap-1.5" onClick={() => { const a = document.createElement("a"); const idsParam = selectedIds.size > 0 ? `&ids=${Array.from(selectedIds).join(",")}` : ""; a.href = `${BASE_URL}/api/export/applications?season=${encodeURIComponent(season || "")}${idsParam}`; a.click(); }}>
                <Download className="w-3.5 h-3.5" /> Excel
              </Button>
            )}
            <Button className="rounded-full shadow-lg shadow-primary/20" onClick={() => setAddOpen(true)}>
              <Plus className="w-4 h-4 mr-2" /> New Application
            </Button>
          </div>
        </div>

        {viewMode === "pipeline" && (
          <div className="flex-1 overflow-x-auto overflow-y-hidden pb-4">
            <div className="flex gap-5 h-full min-w-max px-1">
              <DndContext
                sensors={sensors}
                collisionDetection={closestCorners}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
              >
                {pipelineStages.map(s => {
                  const stageData = pipelineStageData.get(s.key);
                  const stageApps = [...(stageData?.apps || [])].sort((a: any, b: any) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime());
                  return (
                    <PipelineStageViewport key={s.key} stageKey={s.key} onVisible={markPipelineStageVisible}>
                      <DroppableAppColumn
                        stage={s.key}
                        label={s.label}
                        variant={s.variant}
                        apps={stageApps}
                        totalCount={stageData?.total || 0}
                        totalRevenue={stageData?.totalCommission}
                        isLoading={stageData?.isLoading}
                        onLoadMore={() => setPipelineLimits(current => ({
                          ...current,
                          [s.key]: (current[s.key] ?? PIPELINE_BATCH_SIZE) + PIPELINE_BATCH_SIZE,
                        }))}
                        onView={id => setLocation(`/staff/applications/${id}`)}
                        staffUsersMap={staffUsersMap}
                        onAssign={handleAssign}
                        staffUsersList={staffUsersList}
                        currentUserId={user?.id}
                        canSeeCommission={canSeeCommission}
                        canAssign={canAssign}
                        canReassign={canReassign}
                        canMoveCards={canMoveCards}
                      />
                    </PipelineStageViewport>
                  );
                })}

                <DragOverlay>
                  {activeCard ? (
                    <div className="bg-card rounded-xl border border-primary shadow-2xl p-4 w-72 opacity-95 rotate-1">
                      <div className="flex items-center gap-2.5 mb-1.5">
                        <AppStudentAvatar app={activeCard} />
                        <h4 className="font-bold text-sm text-foreground line-clamp-1 min-w-0">
                          {activeCard.studentFirstName} {activeCard.studentLastName}
                        </h4>
                      </div>
                      {activeCard.universityName && <p className="text-xs text-muted-foreground">{activeCard.universityName}</p>}
                      {activeCard.programName && (
                        <p className="text-xs font-medium text-primary mt-1.5 bg-primary/5 block max-w-full px-2 py-1 rounded-md leading-relaxed">
                          {activeCard.programName}
                        </p>
                      )}
                      <div className="mt-2 flex items-center justify-between">
                        {activeCard.country && <span className="text-[10px] px-2 py-0.5 rounded-full bg-secondary text-secondary-foreground font-medium">{activeCard.country}</span>}
                        {canSeeCommission && activeCard.commissionAmount && parseFloat(activeCard.commissionAmount) > 0 && (
                          <div className="flex items-center gap-1">
                            <TrendingUp className="w-3 h-3 text-emerald-500" />
                            <span className="text-xs font-semibold text-emerald-600">{formatCurrency(parseFloat(activeCard.commissionAmount))}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  ) : null}
                </DragOverlay>
              </DndContext>
            </div>
          </div>
        )}

        {viewMode === "list" && (
          <div className="flex-1 flex flex-col overflow-hidden bg-card rounded-2xl border">
            <div className="flex-1 overflow-auto">
              {(() => {
                const renderHeaderCell = (id: AppColId) => {
                  switch (id) {
                    case "student":
                      return (
                        <ColumnHeader
                          key={id}
                          label="Student"
                          sort={{ sortKey: "student", current: sort, onSort: handleSort }}
                          filter={{ type: "text", value: colFilters.student, onChange: v => setColFilters(f => ({ ...f, student: v })), placeholder: "Filter by student…", label: "Student contains" }}
                        />
                      );
                    case "stage":
                      return (
                        <ColumnHeader
                          key={id}
                          label="Stage"
                          sort={{ sortKey: "stage", current: sort, onSort: handleSort }}
                          filter={{ type: "select", value: filters.stage, onChange: v => setFilters(f => ({ ...f, stage: v })), options: pipelineStages.map(s => ({ value: s.key, label: s.label })), label: "Stage" }}
                        />
                      );
                    case "country":
                      return (
                        <ColumnHeader
                          key={id}
                          label="Country"
                          sort={{ sortKey: "country", current: sort, onSort: handleSort }}
                          filter={{ type: "select", value: filters.country, onChange: v => setFilters(f => ({ ...f, country: v })), options: uniqueAppCountries.map(c => ({ value: c, label: c })), label: "Country" }}
                        />
                      );
                    case "university":
                      return (
                        <ColumnHeader
                          key={id}
                          label="University"
                          sort={{ sortKey: "university", current: sort, onSort: handleSort }}
                          filter={{ type: "searchable-select", value: filters.university, onChange: v => setFilters(f => ({ ...f, university: v })), options: uniqueAppUniversities.map(([uid, name]) => ({ value: String(uid), label: name || `#${uid}` })), label: "University", placeholder: "Search universities…" }}
                        />
                      );
                    case "program":
                      return (
                        <ColumnHeader
                          key={id}
                          label="Program"
                          sort={{ sortKey: "program", current: sort, onSort: handleSort }}
                          filter={{ type: "text", value: colFilters.program, onChange: v => setColFilters(f => ({ ...f, program: v })), placeholder: "Filter by program…", label: "Program contains" }}
                        />
                      );
                    case "level":
                      return (
                        <ColumnHeader
                          key={id}
                          label="Level"
                          sort={{ sortKey: "level", current: sort, onSort: handleSort }}
                          filter={{ type: "select", value: colFilters.level, onChange: v => setColFilters(f => ({ ...f, level: v })), options: studyLevels.map(l => ({ value: l.key, label: l.label })), label: "Level" }}
                        />
                      );
                    case "intake":
                      return (
                        <ColumnHeader
                          key={id}
                          label="Intake"
                          sort={{ sortKey: "intake", current: sort, onSort: handleSort }}
                          filter={{ type: "text", value: colFilters.intake, onChange: v => setColFilters(f => ({ ...f, intake: v })), placeholder: "Filter by intake…", label: "Intake contains" }}
                        />
                      );
                    case "commission":
                      if (!canSeeCommission) return null;
                      return (
                        <ColumnHeader
                          key={id}
                          label="Commission"
                          sort={{ sortKey: "fee", current: sort, onSort: handleSort }}
                        />
                      );
                    case "assigned":
                      return (
                        <ColumnHeader
                          key={id}
                          label="Assigned"
                          filter={{
                            type: "select",
                            value: filters.assignedTo,
                            onChange: v => setFilters(f => ({ ...f, assignedTo: v })),
                            options: [
                              { value: "mine", label: t("applicationsPage.me") },
                              { value: "unassigned", label: t("applicationsPage.unassigned") },
                              { value: "mine_unassigned", label: t("applicationsPage.meUnassigned") },
                              ...(canViewOthers
                                ? staffUsersList
                                    .filter((u: { id: number; name: string }) => u.id !== user?.id)
                                    .map((u: { id: number; name: string }) => ({ value: String(u.id), label: u.name }))
                                : []),
                            ],
                            allLabel: t("applicationsPage.all"),
                            hideAll: false,
                            label: t("applicationsPage.assignedTo"),
                          }}
                        />
                      );
                    case "button1":
                      return <TableHead key={id} className="w-28 text-xs font-semibold text-muted-foreground">Quick Button</TableHead>;
                    case "button2":
                      return <TableHead key={id} className="w-28 text-xs font-semibold text-muted-foreground">Quick Button</TableHead>;
                    case "created":
                      return (
                        <ColumnHeader
                          key={id}
                          label="Created"
                          sort={{ sortKey: "date", current: sort, onSort: handleSort }}
                          filter={{
                            type: "select",
                            value: filters.dateRange,
                            onChange: v => setFilters(f => ({ ...f, dateRange: v })),
                            options: [
                              { value: "today", label: "Today" },
                              { value: "yesterday", label: "Yesterday" },
                              { value: "last7", label: "Last 7 Days" },
                              { value: "thisMonth", label: "This Month" },
                              { value: "thisYear", label: "This Year" },
                            ],
                            label: "Created date",
                          }}
                        />
                      );
                    default:
                      return null;
                  }
                };
                const renderBodyCell = (id: AppColId, app: any, stageLabel: string, stageColor: string, levelLabel: string) => {
                  switch (id) {
                    case "student":
                      return (
                        <LinkedTableCell
                          key={id}
                          href={`/staff/applications/${app.id}`}
                          linkLabel={`Open application for ${app.studentFirstName} ${app.studentLastName}`}
                          primary
                          className="font-medium"
                        >
                          <div className="flex items-center gap-2">
                            <AppStudentAvatar app={app} />
                            <div className="flex items-center gap-1.5 min-w-0">
                              {app.studentId ? (
                                <Link href={`/staff/students/${app.studentId}`} className="hover:text-primary hover:underline cursor-pointer transition-colors">
                                  {app.studentFirstName} {app.studentLastName}
                                </Link>
                              ) : (
                                <span>{app.studentFirstName} {app.studentLastName}</span>
                              )}
                              <OriginBadge originType={app.originType} originDisplayName={app.originDisplayName} />
                            </div>
                          </div>
                        </LinkedTableCell>
                      );
                    case "stage":
                      return (
                        <LinkedTableCell key={id} href={`/staff/applications/${app.id}`} linkLabel={`Open application for ${app.studentFirstName} ${app.studentLastName}`}>
                          <StageBadgeWithDocs app={app} stageLabel={stageLabel} stageColor={stageColor} baseUrl={BASE_URL} />
                        </LinkedTableCell>
                      );
                    case "country":
                      return <LinkedTableCell key={id} href={`/staff/applications/${app.id}`} linkLabel={`Open application for ${app.studentFirstName} ${app.studentLastName}`} className="text-muted-foreground">{app.country || "-"}</LinkedTableCell>;
                    case "university":
                      return (
                        <LinkedTableCell key={id} href={`/staff/applications/${app.id}`} linkLabel={`Open application for ${app.studentFirstName} ${app.studentLastName}`} className="max-w-[250px]">
                          {app.universityId ? (
                            <button type="button" className="text-left hover:text-primary hover:underline cursor-pointer transition-colors line-clamp-2" title={app.universityName || ""} onClick={() => setTableUniInfoId(app.universityId)}>
                              {app.universityName || "-"}
                            </button>
                          ) : (
                            <span className="line-clamp-2" title={app.universityName || ""}>{app.universityName || "-"}</span>
                          )}
                        </LinkedTableCell>
                      );
                    case "program":
                      return (
                        <LinkedTableCell key={id} href={`/staff/applications/${app.id}`} linkLabel={`Open application for ${app.studentFirstName} ${app.studentLastName}`} className="max-w-[250px]">
                          {app.programId ? (
                            <button type="button" className="text-left hover:text-primary hover:underline cursor-pointer transition-colors line-clamp-2" title={app.programName || ""} onClick={() => setTableProgInfoId(app.programId)}>
                              {app.programName || "-"}
                            </button>
                          ) : (
                            <span className="line-clamp-2" title={app.programName || ""}>{app.programName || "-"}</span>
                          )}
                        </LinkedTableCell>
                      );
                    case "level":
                      return <LinkedTableCell key={id} href={`/staff/applications/${app.id}`} linkLabel={`Open application for ${app.studentFirstName} ${app.studentLastName}`}>{levelLabel}</LinkedTableCell>;
                    case "intake":
                      return <LinkedTableCell key={id} href={`/staff/applications/${app.id}`} linkLabel={`Open application for ${app.studentFirstName} ${app.studentLastName}`}>{app.intake || "-"}</LinkedTableCell>;
                    case "commission":
                      return (
                        canSeeCommission ? (
                        <LinkedTableCell key={id} href={`/staff/applications/${app.id}`} linkLabel={`Open application for ${app.studentFirstName} ${app.studentLastName}`}>
                          {app.commissionAmount && parseFloat(app.commissionAmount) > 0
                            ? <span className="text-emerald-600 font-medium">{formatCurrency(parseFloat(app.commissionAmount))}</span>
                            : "-"}
                        </LinkedTableCell>
                        ) : null
                      );
                    case "assigned":
                      return (
                        <TableCell key={id} onClick={e => e.stopPropagation()}>
                          {app.assignedToId ? (
                            (canReassign || app.assignedToId === user?.id) ? (
                              <AssignPopover
                                assignedUserName={staffUsersMap[app.assignedToId]}
                                staffUsers={staffUsersList}
                                currentUserId={user?.id}
                                onAssign={(userId) => handleAssign(app.id, userId)}
                                size="list"
                              />
                            ) : (
                              <span className="text-xs text-muted-foreground truncate flex items-center gap-1">
                                <UserCheck2 className="w-3 h-3" />{staffUsersMap[app.assignedToId] || t("leadsPage.assigned")}
                              </span>
                            )
                          ) : canReassign ? (
                            <AssignPopover
                              staffUsers={staffUsersList}
                              currentUserId={user?.id}
                              onAssign={(userId) => handleAssign(app.id, userId)}
                              size="list"
                            />
                          ) : canAssign ? (
                            <button
                              onClick={e => { e.stopPropagation(); handleAssign(app.id, user!.id); }}
                              className="text-[10px] text-primary hover:underline font-medium flex items-center gap-1"
                            >
                              <UserPlus className="w-3 h-3 shrink-0" />{t("leadsPage.assignToMe")}
                            </button>
                          ) : null}
                        </TableCell>
                      );
                    case "created":
                      return <LinkedTableCell key={id} href={`/staff/applications/${app.id}`} linkLabel={`Open application for ${app.studentFirstName} ${app.studentLastName}`} className="text-muted-foreground text-xs">{formatDate(app.createdAt, dateFormat)}</LinkedTableCell>;
                    case "button1":
                    case "button2": {
                      const slot = id === "button1" ? 0 : 1;
                      const stageDef: PipelineStage | undefined = stageMap[app.stage];
                      const action: StageAction | undefined = stageDef?.actions?.[slot];
                      if (!action) {
                        // Task #167 — empty cell (not "-") when slot is None / unconfigured.
                        return <TableCell key={id} />;
                      }
                      // Task #167 — gate by role.
                      // Upload action follows the stage's uploadPermissionLevel so
                      // admin/staff/agent visibility matches the document upload rules.
                      // missing_docs is admin-only. download is staff+admin (no agents).
                      const permLevel = stageDef?.uploadPermissionLevel || "none";
                      const role = user?.role || "";
                      const isAgent = isAgentRole(role);
                      const isStaff = isStaffRole(role);
                      let allowed = true;
                      let denyReason = "";
                      if (action.type === "upload") {
                        if (permLevel === "none") { allowed = false; denyReason = "Bu aşamada yükleme kapalı"; }
                        else if (permLevel === "admin_only" && !isAdmin) { allowed = false; denyReason = "Yalnızca yönetici"; }
                        else if (permLevel === "staff_only" && !isStaff) { allowed = false; denyReason = "Yalnızca personel"; }
                        else if (permLevel === "staff_and_agent" && !isStaff && !isAgent) { allowed = false; denyReason = "Yalnızca personel/acente"; }
                      } else if (action.type === "missing_docs") {
                        if (permLevel === "none") { allowed = false; denyReason = "Bu aşamada kapalı"; }
                        else if (permLevel === "admin_only" && !isAdmin) { allowed = false; denyReason = "Yalnızca yönetici"; }
                        else if (permLevel === "staff_only" && !isStaff) { allowed = false; denyReason = "Yalnızca personel"; }
                        else if (permLevel === "staff_and_agent" && !isStaff && !isAgent) { allowed = false; denyReason = "Yalnızca personel/acente"; }
                      } else if (action.type === "download") {
                        // Download follows backend stage-documents visibility:
                        // staff + agents (who can already see the application
                        // via row-level access). Students never see this column.
                        if (!isStaff && !isAgent) { allowed = false; denyReason = "Erişim yok"; }
                      }
                      const fallbackLabel = action.type === "upload" ? "Upload" : action.type === "download" ? "Download" : "Missing Docs";
                      const label = action.label || fallbackLabel;
                      const color = action.color || undefined;
                      return (
                        <TableCell key={id} onClick={(e) => e.stopPropagation()}>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2 text-xs font-medium"
                            style={color ? { borderColor: color, color } : undefined}
                            disabled={!allowed}
                            title={!allowed ? denyReason : undefined}
                            onClick={() => { if (allowed) void handleStageAction(app as ApplicationRow, action); }}
                          >
                            {label}
                          </Button>
                        </TableCell>
                      );
                    }
                    default:
                      return null;
                  }
                };
                const totalColSpan = visibleAppCols.length + 2; // +select +actions
                return (
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/50">
                        <TableHead className="w-10"><Checkbox checked={allPageSelected} onCheckedChange={toggleSelectAll} /></TableHead>
                        {visibleAppCols.map((id) => renderHeaderCell(id as AppColId))}
                        <TableHead className="w-20 text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {isLoading ? (
                        <TableRow><TableCell colSpan={totalColSpan} className="text-center py-12 text-muted-foreground">Loading...</TableCell></TableRow>
                      ) : pagedApps.length === 0 ? (
                        <TableRow><TableCell colSpan={totalColSpan} className="text-center py-12 text-muted-foreground">No applications found</TableCell></TableRow>
                      ) : pagedApps.map((app: any) => {
                        const sm = stageMap[app.stage];
                        const stageColor = sm ? getStageColor(sm, sm._index) : "bg-gray-100 text-gray-700 border-gray-200";
                        const stageLabel = sm?.label || app.stage;
                        const levelLabel = studyLabelOf(app.level) || app.level || "-";
                        return (
                          <TableRow
                            key={app.id}
                            className={`hover:bg-muted/30 transition-colors cursor-pointer ${selectedIds.has(app.id) ? "bg-primary/5" : ""}`}
                          >
                            <TableCell onClick={e => e.stopPropagation()}><Checkbox checked={selectedIds.has(app.id)} onCheckedChange={() => toggleSelect(app.id)} /></TableCell>
                            {visibleAppCols.map((id) => renderBodyCell(id as AppColId, app, stageLabel, stageColor, levelLabel))}
                            <TableCell className="text-right" onClick={e => e.stopPropagation()}>
                              <RowActionsMenu
                                entityType="application"
                                entityId={app.id}
                                entityName={`${app.studentFirstName} ${app.studentLastName}`}
                                currentAgentId={app.agentId}
                                currentAgentName={app.agentName}
                                currentAssignedToId={app.assignedToId}
                                staffUsersMap={staffUsersMap}
                                staffUsersList={staffUsersList}
                                currentUserId={user?.id}
                                isAdmin={isAdmin}
                                canAssign={canAssign}
                                canReassign={canReassign}
                                onEdit={() => setEditApp(app)}
                                onDelete={(isAdmin || hasPermission("applications.delete")) ? () => { setSelectedIds(new Set([app.id])); setDeleteOpen(true); } : undefined}
                                onAssign={(uid) => handleAssign(app.id, uid)}
                                onRefresh={() => queryClient.invalidateQueries({ queryKey: ["applications"] })}
                              />
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                );
              })()}
            </div>
            <TablePagination
              currentPage={pg.page}
              totalItems={totalAppsCount}
              pageSize={pg.pageSize}
              onPageChange={pg.setPage}
              onPageSizeChange={pg.setPageSize}
            />
          </div>
        )}
      </div>

      <EditApplicationDialog open={!!editApp} onClose={() => setEditApp(null)} app={editApp} stages={pipelineStages} />
      <DeleteConfirmDialog open={deleteOpen} onClose={() => setDeleteOpen(false)} count={selectedIds.size} onConfirm={handleBulkDelete} isPending={deleteInProgress} />
      <RunConfirmDialog open={runConfirmOpen} onClose={() => setRunConfirmOpen(false)} count={selectedIds.size} onConfirm={handleBulkRun} isPending={runInProgress} />
      <BulkMessageDialog
        open={messageCampaignOpen}
        onOpenChange={setMessageCampaignOpen}
        entityType="application"
        entityIds={Array.from(selectedIds)}
        onCreated={() => setSelectedIds(new Set())}
      />
      <AddApplicationModal open={addOpen} onClose={() => setAddOpen(false)} onSuccess={() => queryClient.invalidateQueries({ queryKey: ["applications"] })} defaultStage={pipelineStages[0]?.key} />
      {docUploadDialog && (
        <StageDocUploadDialog
          open={!!docUploadDialog}
          onClose={() => setDocUploadDialog(null)}
          applicationId={docUploadDialog.appId}
          uploadStage={docUploadDialog.uploadStage}
          targetStage={docUploadDialog.targetStage}
          targetStageLabel={docUploadDialog.targetStageLabel}
          documentNameOverride={docUploadDialog.documentNameOverride ?? null}
          moveAfterUpload={docUploadDialog.moveAfterUpload !== false}
          quickMode={docUploadDialog.quickMode === true}
          onUploaded={() => {
            queryClient.invalidateQueries({ queryKey: ["applications"] });
            queryClient.invalidateQueries({ queryKey: [`/api/applications/${docUploadDialog.appId}`] });
          }}
        />
      )}
      {tableUniInfoId && (
        <UniversityInfoPopup universityId={tableUniInfoId} onClose={() => setTableUniInfoId(null)} />
      )}
      {tableProgInfoId && (
        <ProgramInfoPopup programId={tableProgInfoId} onClose={() => setTableProgInfoId(null)} canSeeCommission={canSeeCommission} />
      )}
      {/* Task #269 — modern per-application document-request modal. */}
      {docRequestDialog && (
        <StageDocRequestDialog
          open={!!docRequestDialog}
          onOpenChange={(o) => { if (!o) setDocRequestDialog(null); }}
          applicationId={docRequestDialog.appId}
          stage={docRequestDialog.stage}
          stageLabel={docRequestDialog.stageLabel}
          suggestedDocTypes={docRequestDialog.suggestedDocTypes}
          title={docRequestDialog.title}
          onSaved={() => {
            const dlg = docRequestDialog;
            setDocRequestDialog(null);
            queryClient.invalidateQueries({ queryKey: ["applications"] });
            queryClient.invalidateQueries({ queryKey: [`/api/applications/${dlg.appId}`] });
            if (dlg.retryTarget) {
              void performStageMove(dlg.appId, dlg.retryTarget);
            } else {
              toast({ title: t("stageDocRequest.saved") });
            }
          }}
        />
      )}

      {/* Task #269 — incomplete-docs blocker shown on forward moves. */}
      {docsIncompleteDialog && (
        <StageDocsIncompleteDialog
          open={!!docsIncompleteDialog}
          onOpenChange={(o) => { if (!o) setDocsIncompleteDialog(null); }}
          applicationId={docsIncompleteDialog.appId}
          currentStageLabel={docsIncompleteDialog.currentStageLabel}
          missing={docsIncompleteDialog.missing}
          isAdmin={isAdmin}
          onRetry={() => {
            const dlg = docsIncompleteDialog;
            setDocsIncompleteDialog(null);
            void performStageMove(dlg.appId, dlg.retryTarget);
          }}
        />
      )}
    </>
  );
}
