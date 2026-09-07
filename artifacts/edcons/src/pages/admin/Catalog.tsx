import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Globe, Building2, GraduationCap, BookOpen, Plus, Upload, Download, Search, Pencil, Trash2, ChevronLeft, ChevronRight, AlertTriangle, ImageIcon, Lock, ExternalLink, ChevronsUpDown, ChevronUp, ChevronDown, Settings2, Loader2, Check, X, FileText, Save, GripVertical, ArrowUp, ArrowDown, Eye, Languages, RefreshCw } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { CountryFlag } from "@/components/CountryFlag";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { ColumnHeader } from "@/components/ui/column-header";
import { apiFetch } from "@/lib/apiFetch";
import { useDocumentTypeCatalog } from "@/lib/programDocTypes";
import { cn } from "@/lib/utils";
import { useI18n } from "@/hooks/use-i18n";
import { useSeason } from "@/contexts/SeasonContext";
import { LANGUAGE_META } from "@/lib/i18n";
import {
  chunkBulkImportRows,
  findProgramIdentityCollisions,
  type BulkImportProgress,
} from "@/lib/catalogBulkImport";

/* ─── helpers ──────────────────────────────────────────────── */

async function api(url: string, opts?: RequestInit) {
  const r = await apiFetch(url, opts);
  if (!r.ok) {
    let detail = "";
    try {
      const text = await r.text();
      try {
        const parsed = JSON.parse(text);
        detail = parsed?.error || parsed?.message || text;
      } catch {
        detail = text;
      }
    } catch { /* ignore */ }
    throw new Error(detail ? `HTTP ${r.status}: ${detail}` : `HTTP ${r.status}`);
  }
  if (r.status === 204) return undefined;
  return r.json();
}

async function apiDelete(url: string) {
  const r = await apiFetch(url, { method: "DELETE" });
  if (!r.ok && r.status !== 204) throw new Error(`HTTP ${r.status}`);
}

// Delete many ids with bounded concurrency; never rejects, returns failure count.
async function bulkDelete(ids: number[], toUrl: (id: number) => string, concurrency = 8): Promise<number> {
  let idx = 0;
  let failures = 0;
  async function worker() {
    while (idx < ids.length) {
      const id = ids[idx++];
      try { await apiDelete(toUrl(id)); } catch { failures++; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length || 1) }, worker));
  return failures;
}

// Fetch every row across all pages, respecting per-endpoint limit caps.
// The list endpoints silently cap `limit` (countries 500, cities 1000,
// universities/programs 100), so a single big request would truncate. We
// paginate with a conservative page size and stop once meta.total is reached.
async function fetchAllRows<T = any>(url: string, pageSize = 100): Promise<T[]> {
  const u = new URL(url, window.location.origin);
  u.searchParams.delete("page");
  u.searchParams.delete("limit");
  u.searchParams.set("limit", String(pageSize));
  const out: T[] = [];
  for (let page = 1; page <= 5000; page++) {
    u.searchParams.set("page", String(page));
    const res = await api(`${u.pathname}${u.search}`);
    const rows = (res?.data ?? res ?? []) as T[];
    out.push(...rows);
    const total = res?.meta?.total;
    if (rows.length < pageSize) break;
    if (typeof total === "number" && out.length >= total) break;
  }
  return out;
}

async function fetchAllIds(url: string): Promise<number[]> {
  const rows = await fetchAllRows<{ id?: number }>(url);
  return rows.map(r => r.id).filter((id): id is number => typeof id === "number");
}

async function exportToExcel(rows: Record<string, any>[], sheetName: string, filename: string) {
  const XLSX = await import("xlsx");
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, filename);
}

async function downloadExcelTemplate(
  templateRows: Record<string, any>[],
  sheetName: string,
  filename: string,
  notesRows?: Record<string, any>[],
) {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(templateRows);
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  if (notesRows && notesRows.length > 0) {
    const wsNotes = XLSX.utils.json_to_sheet(notesRows);
    XLSX.utils.book_append_sheet(wb, wsNotes, "Instructions");
  }
  XLSX.writeFile(wb, filename);
}

async function parseExcel(file: File): Promise<Record<string, string>[]> {
  const XLSX = await import("xlsx");
  const data = await file.arrayBuffer();
  const wb = XLSX.read(data, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return [];
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(ws, { defval: "" });
  return rows.map(row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k.trim(), String(v).trim()])));
}

function useDebounce<T>(value: T, delay = 300): T {
  const [debouncedValue, setDebouncedValue] = useState(value);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const update = useCallback((v: T) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setDebouncedValue(v), delay);
  }, [delay]);
  if (value !== debouncedValue) update(value);
  return debouncedValue;
}

/* ─── types ─────────────────────────────────────────────────── */

type Country = { id: number; name: string; code: string; flagEmoji?: string | null; dialCode?: string | null; isActive: boolean };
type City = { id: number; name: string; countryId: number; isActive: boolean };
type University = {
  id: number; name: string; country: string; city?: string | null; website?: string | null;
  description?: string | null; ranking?: number | null; logoUrl?: string | null; isActive: boolean;
  universityType?: string | null; taxType?: string | null; taxPercent?: number | null;
  qsRanking?: number | null; timesRanking?: number | null; shanghaiRanking?: number | null;
  cwtsLeidenRanking?: number | null; address?: string | null; onlinePaymentUrl?: string | null;
  cricosLink?: string | null; documentsLink?: string | null; currentFeeListLink?: string | null;
  initialDepositOptions?: string | null; admissionProcess?: string | null;
  contactPersonName?: string | null; contactPersonPhone?: string | null; contactPersonEmail?: string | null;
  status: string;
};
type UniversityOption = Pick<University, "id" | "name">;
type ProgramTranslationSummary = { total: number; published: number; pending: number; failed: number; manual: number; target: number };
type Program = { id: number; universityId: number; universityName?: string | null; name: string; description?: string | null; degree?: string | null; field?: string | null; language?: string | null; duration?: string | null; tuitionFee?: number | null; currency?: string | null; scholarship?: number | null; intakes?: string | null; requirements?: string | null; commissionRate?: number | null; applicationFee?: number | null; advancedFee?: number | null; depositFee?: number | null; serviceFeeAmount?: number | null; discountedFee?: number | null; languageFee?: number | null; feeType?: string | null; minGpa?: number | null; minLanguageScore?: number | null; quota?: number | null; isActive: boolean; translationSummary?: ProgramTranslationSummary };

type ProgramTranslationRow = {
  programId: number;
  locale: string;
  status: "queued" | "processing" | "retrying" | "published" | "failed" | "stale_manual";
  isManual: boolean;
  attempts: number;
  errorCode?: string | null;
  translatedAt?: string | null;
};

/* ─── BulkImportModal ─────────────────────────────────────── */

type BulkImportResult = {
  inserted: number;
  skipped: number;
  updated?: number;
  invalidDocCells?: number;
  docsTouched?: number;
  unknownDocColumns?: string[];
  unknownDocColumnsMessage?: string;
  createdUniversities?: string[];
};

async function importRowsInChunks(
  endpoint: string,
  rows: Record<string, string>[],
  onProgress: (progress: BulkImportProgress) => void,
): Promise<BulkImportResult> {
  const chunks = chunkBulkImportRows(rows);
  const unknownDocColumns = new Set<string>();
  const createdUniversities = new Set<string>();
  let inserted = 0;
  let skipped = 0;
  let updated = 0;
  let docsTouched = 0;
  let invalidDocCells = 0;
  let sawUpdated = false;
  let sawDocsTouched = false;
  let sawInvalidDocCells = false;

  onProgress({ completed: 0, total: chunks.length });
  for (let index = 0; index < chunks.length; index++) {
    const result = await api(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(chunks[index]),
    }) as BulkImportResult;

    inserted += Number(result.inserted || 0);
    skipped += Number(result.skipped || 0);
    if (result.updated !== undefined) {
      sawUpdated = true;
      updated += Number(result.updated || 0);
    }
    if (result.docsTouched !== undefined) {
      sawDocsTouched = true;
      docsTouched += Number(result.docsTouched || 0);
    }
    if (result.invalidDocCells !== undefined) {
      sawInvalidDocCells = true;
      invalidDocCells += Number(result.invalidDocCells || 0);
    }
    for (const column of result.unknownDocColumns || []) unknownDocColumns.add(column);
    for (const university of result.createdUniversities || []) createdUniversities.add(university);
    onProgress({ completed: index + 1, total: chunks.length });
  }

  const unknown = [...unknownDocColumns].sort();
  return {
    inserted,
    skipped,
    ...(sawUpdated ? { updated } : {}),
    ...(sawDocsTouched ? { docsTouched } : {}),
    ...(sawInvalidDocCells ? { invalidDocCells } : {}),
    ...(unknown.length > 0 ? {
      unknownDocColumns: unknown,
      unknownDocColumnsMessage: `Tanımsız belge sütunları (katalogda yok, atlandı): ${unknown.join(", ")}`,
    } : {}),
    ...(createdUniversities.size > 0 ? { createdUniversities: [...createdUniversities] } : {}),
  };
}

function BulkImportModal({ open, onClose, title, templateRows, notesRows, onImport }: {
  open: boolean; onClose: () => void; title: string;
  templateRows: Record<string, any>[];
  notesRows?: Record<string, any>[];
  onImport: (
    rows: Record<string, string>[],
    onProgress: (progress: BulkImportProgress) => void,
  ) => Promise<BulkImportResult>;
}) {
  const { t } = useI18n();
  const [result, setResult] = useState<BulkImportResult | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<BulkImportProgress | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const progressSnapshot: { current: BulkImportProgress | null } = { current: null };
    try {
      setLoading(true);
      setResult(null);
      setError("");
      setProgress(null);
      const rows = await parseExcel(file);
      if (rows.length === 0) { setError(t("catalogPage.fileEmptyInvalid")); return; }
      const res = await onImport(rows, (nextProgress) => {
        progressSnapshot.current = nextProgress;
        setProgress(nextProgress);
      });
      setResult(res);
    } catch (err) {
      const msg = err instanceof Error && err.message ? err.message : t("catalogPage.unknownError");
      console.error("[BulkImport] failed:", err);
      // Detect auth/CSRF errors and tell the user to sign in again instead of
      // showing a confusing generic "Import failed" message.
      if (/HTTP\s*401/i.test(msg) || /Authentication required/i.test(msg)) {
        setError(t("catalogPage.sessionExpired"));
      } else if (/HTTP\s*403/i.test(msg) || /CSRF/i.test(msg)) {
        setError(t("catalogPage.permissionDenied"));
      } else if (
        progressSnapshot.current &&
        progressSnapshot.current.completed > 0 &&
        progressSnapshot.current.completed < progressSnapshot.current.total
      ) {
        setError(t("catalogPage.importPartiallyCompleted", {
          completed: progressSnapshot.current.completed,
          total: progressSnapshot.current.total,
          msg,
        }));
      } else {
        // Surface the backend's reason (e.g. unknown university names) so the
        // user knows what to fix instead of seeing a generic "Import failed".
        setError(t("catalogPage.importFailedDetail", { msg }));
      }
    }
    finally { setLoading(false); if (fileRef.current) fileRef.current.value = ""; }
  };

  const reset = () => { setResult(null); setError(""); setProgress(null); onClose(); };

  return (
    <>
    <Dialog open={open} onOpenChange={reset}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>{t("catalogPage.bulkImport")} — {title}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <Button variant="outline" size="sm" onClick={() => downloadExcelTemplate(templateRows, title, `${title.toLowerCase().replace(/\s/g, "_")}_template.xlsx`, notesRows)}>
            <Download className="h-4 w-4 mr-2" /> {t("catalogPage.downloadTemplate")}
          </Button>
          <div>
            <Label htmlFor="xlsxfile">{t("catalogPage.selectExcelFile")}</Label>
            <Input id="xlsxfile" ref={fileRef} type="file" accept=".xlsx,.xls,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" className="mt-1" onChange={handleFile} disabled={loading} />
          </div>
          {loading && (
            <p className="text-sm text-muted-foreground animate-pulse">
              {t("catalogPage.processing")}
              {progress && progress.total > 0 ? ` ${progress.completed}/${progress.total}` : ""}
            </p>
          )}
          {error && <p className="text-sm text-destructive flex items-center gap-1"><AlertTriangle className="h-4 w-4" />{error}</p>}
          {result && (
            <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm space-y-1">
              <p className="font-medium text-green-700">{t("catalogPage.importCompleted")}</p>
              <p className="text-green-600">{t("catalogPage.importAdded", { n: result.inserted })}{result.updated ? ` — ${t("catalogPage.importUpdated", { n: result.updated })}` : null} — {t("catalogPage.importSkipped", { n: result.skipped })}</p>
              {result.createdUniversities && result.createdUniversities.length > 0 && (
                <p className="text-green-600 text-xs">
                  {t("catalogPage.importCreatedUniversities", { n: result.createdUniversities.length, names: result.createdUniversities.join(", ") })}
                </p>
              )}
              {(result.docsTouched !== undefined || result.invalidDocCells !== undefined) && (
                <p className="text-green-600 text-xs">
                  {result.docsTouched !== undefined && t("catalogPage.docReqsUpdated", { n: result.docsTouched })}
                  {result.invalidDocCells !== undefined && result.invalidDocCells > 0 && (
                    <span className="ml-2 text-amber-700">{t("catalogPage.skippedInvalidDocCells", { n: result.invalidDocCells })}</span>
                  )}
                </p>
              )}
            </div>
          )}
          {result && result.unknownDocColumns && result.unknownDocColumns.length > 0 && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm space-y-2">
              <p className="font-medium text-amber-800 flex items-center gap-1.5">
                <AlertTriangle className="h-4 w-4" />
                {t("catalogPage.unknownDocColumns")}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {result.unknownDocColumns.map(col => (
                  <code key={col} className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-900 text-xs font-mono break-all dark:bg-amber-900/40 dark:text-amber-200">
                    {col}
                  </code>
                ))}
              </div>
              <a
                href="/admin/catalog"
                className="inline-flex items-center gap-1 text-amber-900 underline hover:no-underline text-xs font-medium"
              >
                {t("catalogPage.goToDocCatalog")} <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          )}
        </div>
        <DialogFooter><Button variant="outline" onClick={reset}>{t("common.close")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}

/* ─── Pagination ─────────────────────────────────────────── */
function Pagination({ page, totalPages, onPage }: { page: number; totalPages: number; onPage: (p: number) => void }) {
  if (totalPages <= 1) return null;
  return (
    <>
    <div className="flex items-center gap-2 justify-end mt-4">
      <Button size="icon" variant="ghost" disabled={page <= 1} onClick={() => onPage(page - 1)}><ChevronLeft className="h-4 w-4" /></Button>
      <span className="text-sm text-muted-foreground">{page} / {totalPages}</span>
      <Button size="icon" variant="ghost" disabled={page >= totalPages} onClick={() => onPage(page + 1)}><ChevronRight className="h-4 w-4" /></Button>
    </div>
    </>
  );
}

function SelectAllBanner({ selectedCount, total, allMatchingSelected, selecting, onSelectAllMatching, onClear }: {
  selectedCount: number;
  total: number;
  allMatchingSelected: boolean;
  selecting: boolean;
  onSelectAllMatching: () => void;
  onClear: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-center justify-center gap-2 rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-sm">
      {allMatchingSelected ? (
        <>
          <span className="text-muted-foreground">{t("catalogPage.allItemsSelected", { n: total })}</span>
          <button type="button" className="font-medium text-primary hover:underline" onClick={onClear}>
            {t("catalogPage.clearSelection")}
          </button>
        </>
      ) : (
        <>
          <span className="text-muted-foreground">{t("catalogPage.pageItemsSelected", { n: selectedCount })}</span>
          <button
            type="button"
            className="font-medium text-primary hover:underline disabled:opacity-50"
            onClick={onSelectAllMatching}
            disabled={selecting}
          >
            {selecting ? t("catalogPage.selecting") : t("catalogPage.selectAllItems", { n: total })}
          </button>
        </>
      )}
    </div>
  );
}

/* ─── Sort helpers ──────────────────────────────────────── */
type SortState = { col: string; dir: "asc" | "desc" };

function sortCompare<T>(a: T, b: T, key: keyof T, dir: "asc" | "desc"): number {
  const av = a[key] ?? "";
  const bv = b[key] ?? "";
  const cmp = String(av).localeCompare(String(bv), "tr", { numeric: true, sensitivity: "base" });
  return dir === "asc" ? cmp : -cmp;
}

function SortTh({ label, col, sort, onSort, className }: { label: string; col: string; sort: SortState; onSort: (col: string) => void; className?: string }) {
  const active = sort.col === col;
  return (
    <>
    <th
      className={`text-left px-4 py-2 font-medium cursor-pointer select-none hover:bg-muted/80 transition-colors ${className ?? ""}`}
      onClick={() => onSort(col)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active
          ? sort.dir === "asc"
            ? <ChevronUp className="h-3.5 w-3.5 text-primary" />
            : <ChevronDown className="h-3.5 w-3.5 text-primary" />
          : <ChevronsUpDown className="h-3 w-3 text-muted-foreground/50" />
        }
      </span>
    </th>
    </>
  );
}

/* ═══════════════════════════════════════════════════════════
   COUNTRIES TAB
══════════════════════════════════════════════════════════ */
function CountriesTab() {
  const { t } = useI18n();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const dSearch = useDebounce(search);
  const [form, setForm] = useState<Partial<Country> | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [delId, setDelId] = useState<number | null>(null);
  const [sort, setSort] = useState<SortState>({ col: "name", dir: "asc" });
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkDelOpen, setBulkDelOpen] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [selectingAll, setSelectingAll] = useState(false);

  const [fName, setFName] = useState("");
  const [fCode, setFCode] = useState("");
  const [fStatus, setFStatus] = useState("");
  const dfName = useDebounce(fName);
  const dfCode = useDebounce(fCode);

  const { data } = useQuery({
    queryKey: ["countries", page, dSearch, dfName, dfCode, fStatus],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), limit: "50" });
      if (dSearch) params.set("search", dSearch);
      if (dfName) params.set("name", dfName);
      if (dfCode) params.set("code", dfCode);
      if (fStatus) params.set("status", fStatus);
      return api(`/api/countries?${params.toString()}`);
    },
  });
  const countries: Country[] = data?.data ?? [];
  const totalPages = Math.ceil((data?.meta?.total ?? 0) / 50);

  const sorted = useMemo(() => {
    const colMap: Record<string, keyof Country> = { name: "name", code: "code", dialCode: "dialCode", status: "isActive" };
    const key = colMap[sort.col] ?? "name";
    return [...countries].sort((a, b) => sortCompare(a, b, key, sort.dir));
  }, [countries, sort]);

  function handleSort(col: string) {
    setSort(s => s.col === col ? { col, dir: s.dir === "asc" ? "desc" : "asc" } : { col, dir: "asc" });
  }

  const allSelected = sorted.length > 0 && sorted.every(c => selected.has(c.id));
  function toggleAll() {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(sorted.map(c => c.id)));
  }
  function toggleOne(id: number) {
    setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  const save = useMutation({
    mutationFn: async (f: Partial<Country>) => f.id
      ? api(`/api/countries/${f.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(f) })
      : api("/api/countries", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(f) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["countries"] }); setForm(null); },
  });

  const del = useMutation({
    mutationFn: (id: number) => apiDelete(`/api/countries/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["countries"] }); setDelId(null); },
  });

  async function handleBulkDelete() {
    setBulkDeleting(true);
    const count = selected.size;
    const failures = await bulkDelete([...selected], id => `/api/countries/${id}`);
    setSelected(new Set());
    setBulkDelOpen(false);
    setBulkDeleting(false);
    qc.invalidateQueries({ queryKey: ["countries"] });
    if (failures > 0) toast({ title: t("catalogPage.bulkDeleteFailed"), description: t("catalogPage.bulkDeleteFailedDesc", { failed: failures, total: count }), variant: "destructive" });
  }

  const total = data?.meta?.total ?? 0;
  const allMatchingSelected = total > 0 && selected.size >= total;
  async function selectAllMatching() {
    setSelectingAll(true);
    try {
      const params = new URLSearchParams({ limit: "5000" });
      if (dSearch) params.set("search", dSearch);
      if (dfName) params.set("name", dfName);
      if (dfCode) params.set("code", dfCode);
      if (fStatus) params.set("status", fStatus);
      const ids = await fetchAllIds(`/api/countries?${params.toString()}`);
      setSelected(new Set(ids));
    } catch {} finally { setSelectingAll(false); }
  }
  async function runExport(onlySelected: boolean) {
    try {
      let list = await fetchAllRows<Country>("/api/countries");
      if (onlySelected) list = list.filter(c => selected.has(c.id));
      const rows = list.map((c: Country) => ({
        Name: c.name, "ISO Code": c.code, "Flag Emoji": c.flagEmoji ?? "",
        "Dial Code": c.dialCode ?? "",
        Status: c.isActive ? "Active" : "Inactive",
      }));
      await exportToExcel(rows, "Countries", `countries-${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch {}
  }

  const handleBulkImport = async (
    rows: Record<string, string>[],
    onProgress: (progress: BulkImportProgress) => void,
  ) => {
    const res = await importRowsInChunks("/api/countries/bulk", rows, onProgress);
    qc.invalidateQueries({ queryKey: ["countries"] });
    return res;
  };

  const templateRows = [
    { name: "Türkiye", code: "TR", flagEmoji: "🇹🇷", dialCode: "+90" },
    { name: "United Kingdom", code: "GB", flagEmoji: "🇬🇧", dialCode: "+44" },
    { name: "Germany", code: "DE", flagEmoji: "🇩🇪", dialCode: "+49" },
    { name: "France", code: "FR", flagEmoji: "🇫🇷", dialCode: "+33" },
  ];

  return (
    <>
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input placeholder={t("catalogPage.searchCountries")} className="pl-8" value={search} onChange={e => { setSearch(e.target.value); setPage(1); setSelected(new Set()); }} />
        </div>
        {selected.size > 0 && (
          <Button variant="destructive" size="sm" onClick={() => setBulkDelOpen(true)}>
            <Trash2 className="h-4 w-4 mr-2" />{t("catalogPage.deleteSelected", { n: selected.size })}
          </Button>
        )}
        {selected.size > 0 && (
          <Button variant="outline" size="sm" onClick={() => runExport(true)}>
            <Download className="h-4 w-4 mr-2" />{t("catalogPage.exportSelected", { n: selected.size })}
          </Button>
        )}
        <Button variant="outline" onClick={() => setBulkOpen(true)}><Upload className="h-4 w-4 mr-2" />{t("catalogPage.importExcel")}</Button>
        <Button variant="outline" onClick={() => runExport(false)}><Download className="h-4 w-4 mr-2" />{t("catalogPage.exportExcel")}</Button>
        <Button onClick={() => setForm({ isActive: true })}><Plus className="h-4 w-4 mr-2" />{t("catalogPage.addCountry")}</Button>
      </div>

      <div className="rounded-lg border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-2 w-8">
                <input type="checkbox" checked={allSelected} onChange={toggleAll} className="rounded cursor-pointer" />
              </th>
              <ColumnHeader asTh label={t("catalogPage.country")}
                sort={{ sortKey: "name", current: { key: sort.col, dir: sort.dir }, onSort: handleSort }}
                filter={{ type: "text", value: fName, onChange: v => { setFName(v); setPage(1); }, placeholder: t("catalogPage.filterByName"), label: t("catalogPage.country") }} />
              <ColumnHeader asTh label={t("catalogPage.code")}
                sort={{ sortKey: "code", current: { key: sort.col, dir: sort.dir }, onSort: handleSort }}
                filter={{ type: "text", value: fCode, onChange: v => { setFCode(v.toUpperCase()); setPage(1); }, placeholder: t("catalogPage.codePlaceholder"), label: t("catalogPage.isoCode") }} />
              <ColumnHeader asTh label={t("catalogPage.dialCode")}
                sort={{ sortKey: "dialCode", current: { key: sort.col, dir: sort.dir }, onSort: handleSort }} />
              <ColumnHeader asTh label={t("common.status")}
                sort={{ sortKey: "status", current: { key: sort.col, dir: sort.dir }, onSort: handleSort }}
                filter={{ type: "select", value: fStatus || "all", onChange: v => { setFStatus(v === "all" ? "" : v); setPage(1); },
                  options: [{ value: "active", label: t("common.active") }, { value: "inactive", label: t("common.inactive") }], allLabel: t("common.all"), label: t("common.status") }} />
              <th className="w-20 px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {sorted.length === 0 && (
              <tr><td colSpan={6} className="text-center py-8 text-muted-foreground">{t("catalogPage.noCountriesFound")}</td></tr>
            )}
            {sorted.map(c => (
              <tr key={c.id} className={`hover:bg-muted/20 transition-colors ${selected.has(c.id) ? "bg-primary/5" : ""}`}>
                <td className="px-4 py-2.5">
                  <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggleOne(c.id)} className="rounded cursor-pointer" />
                </td>
                <td className="px-4 py-2.5 font-medium"><span className="inline-flex items-center gap-1.5">{c.code ? <CountryFlag code={c.code} size="md" /> : null}{c.name}</span></td>
                <td className="px-4 py-2.5 text-muted-foreground font-mono">{c.code}</td>
                <td className="px-4 py-2.5 text-muted-foreground font-mono">{c.dialCode || "—"}</td>
                <td className="px-4 py-2.5">
                  <Badge variant={c.isActive ? "default" : "secondary"} className="text-xs">{c.isActive ? t("common.active") : t("common.inactive")}</Badge>
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex gap-1 justify-end">
                    <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setForm(c)}><Pencil className="h-3.5 w-3.5" /></Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" onClick={() => setDelId(c.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {allSelected && total > sorted.length && (
        <SelectAllBanner
          selectedCount={selected.size}
          total={total}
          allMatchingSelected={allMatchingSelected}
          selecting={selectingAll}
          onSelectAllMatching={selectAllMatching}
          onClear={() => setSelected(new Set())}
        />
      )}
      <Pagination page={page} totalPages={totalPages} onPage={p => { setPage(p); setSelected(new Set()); }} />

      {/* Add/Edit Modal */}
      <Dialog open={form !== null} onOpenChange={o => !o && setForm(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>{form?.id ? t("catalogPage.editCountry") : t("catalogPage.newCountry")}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label>{t("catalogPage.countryNameReq")}</Label><Input className="mt-1" value={form?.name ?? ""} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></div>
            <div><Label>{t("catalogPage.isoCode2Req")}</Label><Input className="mt-1 uppercase" maxLength={2} value={form?.code ?? ""} onChange={e => setForm(f => ({ ...f, code: e.target.value.toUpperCase() }))} /></div>
            <div><Label>{t("catalogPage.flagEmoji")}</Label><Input className="mt-1" placeholder="🇹🇷" value={form?.flagEmoji ?? ""} onChange={e => setForm(f => ({ ...f, flagEmoji: e.target.value }))} /></div>
            <div><Label>{t("catalogPage.dialCodeOptional")}</Label><Input className="mt-1 font-mono" placeholder="+90" value={form?.dialCode ?? ""} onChange={e => setForm(f => ({ ...f, dialCode: e.target.value }))} /></div>
            <div className="flex items-center justify-between">
              <Label>{t("common.active")}</Label>
              <Switch checked={form?.isActive ?? true} onCheckedChange={v => setForm(f => ({ ...f, isActive: v }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setForm(null)}>{t("common.cancel")}</Button>
            <Button onClick={() => save.mutate(form!)} disabled={save.isPending || !form?.name || !form?.code}>{t("common.save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Single delete confirm */}
      <Dialog open={delId !== null} onOpenChange={o => !o && setDelId(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>{t("catalogPage.deleteCountry")}</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">{t("catalogPage.confirmDeleteCountry")}</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDelId(null)}>{t("common.cancel")}</Button>
            <Button variant="destructive" onClick={() => del.mutate(delId!)} disabled={del.isPending}>{t("common.delete")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk delete confirm */}
      <Dialog open={bulkDelOpen} onOpenChange={o => !o && setBulkDelOpen(false)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>{t("catalogPage.bulkDelete")}</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">{t("catalogPage.confirmBulkDeleteCountries", { n: selected.size })}</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkDelOpen(false)}>{t("common.cancel")}</Button>
            <Button variant="destructive" onClick={handleBulkDelete} disabled={bulkDeleting}>
              {bulkDeleting ? t("catalogPage.deleting") : t("catalogPage.deleteNCountries", { n: selected.size })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <BulkImportModal open={bulkOpen} onClose={() => setBulkOpen(false)} title={t("adminCatalog.tabCountries")} templateRows={templateRows} onImport={handleBulkImport} />
    </div>
    </>
  );
}

/* ═══════════════════════════════════════════════════════════
   CITIES TAB
══════════════════════════════════════════════════════════ */
function CitiesTab() {
  const { t } = useI18n();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [filterCountry, setFilterCountry] = useState("all");
  const dSearch = useDebounce(search);
  const [form, setForm] = useState<Partial<City> | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [delId, setDelId] = useState<number | null>(null);
  const [sort, setSort] = useState<SortState>({ col: "name", dir: "asc" });
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkDelOpen, setBulkDelOpen] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [selectingAll, setSelectingAll] = useState(false);

  const [fName, setFName] = useState("");
  const [fStatus, setFStatus] = useState("");
  const dfName = useDebounce(fName);

  const { data: countriesData } = useQuery({
    queryKey: ["all-countries-cities"],
    queryFn: () => api("/api/countries?limit=500"),
  });
  const countries: Country[] = countriesData?.data ?? [];
  const countryMap: Record<number, Country> = Object.fromEntries(countries.map(c => [c.id, c]));

  const { data } = useQuery({
    queryKey: ["cities", page, dSearch, filterCountry, dfName, fStatus],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), limit: "50" });
      if (dSearch) params.set("search", dSearch);
      if (dfName) params.set("name", dfName);
      if (filterCountry !== "all") params.set("countryId", filterCountry);
      if (fStatus) params.set("status", fStatus);
      return api(`/api/cities?${params.toString()}`);
    },
  });
  const cities: City[] = data?.data ?? [];
  const totalPages = Math.ceil((data?.meta?.total ?? 0) / 50);

  const sorted = useMemo(() => {
    const key = sort.col === "country" ? "countryId" : sort.col === "status" ? "isActive" : "name";
    return [...cities].sort((a, b) => {
      if (sort.col === "country") {
        const an = countryMap[a.countryId]?.name ?? "";
        const bn = countryMap[b.countryId]?.name ?? "";
        const cmp = an.localeCompare(bn, "tr", { sensitivity: "base" });
        return sort.dir === "asc" ? cmp : -cmp;
      }
      return sortCompare(a, b, key as keyof City, sort.dir);
    });
  }, [cities, sort, countryMap]);

  function handleSort(col: string) {
    setSort(s => s.col === col ? { col, dir: s.dir === "asc" ? "desc" : "asc" } : { col, dir: "asc" });
  }

  const allSelected = sorted.length > 0 && sorted.every(c => selected.has(c.id));
  function toggleAll() {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(sorted.map(c => c.id)));
  }
  function toggleOne(id: number) {
    setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  const save = useMutation({
    mutationFn: async (f: Partial<City>) => f.id
      ? api(`/api/cities/${f.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(f) })
      : api("/api/cities", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(f) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["cities"] }); setForm(null); },
  });

  const del = useMutation({
    mutationFn: (id: number) => apiDelete(`/api/cities/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["cities"] }); setDelId(null); },
  });

  async function handleBulkDelete() {
    setBulkDeleting(true);
    const count = selected.size;
    const failures = await bulkDelete([...selected], id => `/api/cities/${id}`);
    setSelected(new Set());
    setBulkDelOpen(false);
    setBulkDeleting(false);
    qc.invalidateQueries({ queryKey: ["cities"] });
    if (failures > 0) toast({ title: t("catalogPage.bulkDeleteFailed"), description: t("catalogPage.bulkDeleteFailedDesc", { failed: failures, total: count }), variant: "destructive" });
  }

  const total = data?.meta?.total ?? 0;
  const allMatchingSelected = total > 0 && selected.size >= total;
  async function selectAllMatching() {
    setSelectingAll(true);
    try {
      const params = new URLSearchParams({ limit: "5000" });
      if (dSearch) params.set("search", dSearch);
      if (dfName) params.set("name", dfName);
      if (filterCountry !== "all") params.set("countryId", filterCountry);
      if (fStatus) params.set("status", fStatus);
      const ids = await fetchAllIds(`/api/cities?${params.toString()}`);
      setSelected(new Set(ids));
    } catch {} finally { setSelectingAll(false); }
  }
  async function runExport(onlySelected: boolean) {
    try {
      const allCities = { data: await fetchAllRows<City>("/api/cities") };
      const cMap = Object.fromEntries(countries.map(c => [c.id, c]));
      let list = (allCities?.data ?? allCities ?? []) as City[];
      if (onlySelected) list = list.filter(c => selected.has(c.id));
      const rows = list.map((c: City) => ({
        Name: c.name, Country: cMap[c.countryId]?.name ?? "", "Country Code": cMap[c.countryId]?.code ?? "",
        Status: c.isActive ? "Active" : "Inactive",
      }));
      await exportToExcel(rows, "Cities", `cities-${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch {}
  }

  const handleBulkImport = async (
    rows: Record<string, string>[],
    onProgress: (progress: BulkImportProgress) => void,
  ) => {
    const res = await importRowsInChunks("/api/cities/bulk", rows, onProgress);
    qc.invalidateQueries({ queryKey: ["cities"] });
    return res;
  };

  const templateRows = [
    { name: "İstanbul", countryCode: "TR" },
    { name: "Ankara", countryCode: "TR" },
    { name: "London", countryCode: "GB" },
    { name: "Berlin", countryCode: "DE" },
  ];

  return (
    <>
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[160px] max-w-xs">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input placeholder={t("catalogPage.searchCities")} className="pl-8" value={search} onChange={e => { setSearch(e.target.value); setPage(1); setSelected(new Set()); }} />
        </div>
        <SearchableSelect
          value={filterCountry}
          onValueChange={v => { setFilterCountry(v); setPage(1); setSelected(new Set()); }}
          placeholder={t("catalogPage.allCountries")}
          className="w-[200px]"
          options={[
            { value: "all", label: t("catalogPage.allCountries") },
            ...countries.map(c => ({
              value: String(c.id),
              label: c.name,
              icon: c.code ? <CountryFlag code={c.code} size="sm" /> : undefined,
            })),
          ]}
        />
        {selected.size > 0 && (
          <Button variant="destructive" size="sm" onClick={() => setBulkDelOpen(true)}>
            <Trash2 className="h-4 w-4 mr-2" />{t("catalogPage.deleteSelected", { n: selected.size })}
          </Button>
        )}
        {selected.size > 0 && (
          <Button variant="outline" size="sm" onClick={() => runExport(true)}>
            <Download className="h-4 w-4 mr-2" />{t("catalogPage.exportSelected", { n: selected.size })}
          </Button>
        )}
        <Button variant="outline" onClick={() => setBulkOpen(true)}><Upload className="h-4 w-4 mr-2" />{t("catalogPage.importExcel")}</Button>
        <Button variant="outline" onClick={() => runExport(false)}><Download className="h-4 w-4 mr-2" />{t("catalogPage.exportExcel")}</Button>
        <Button onClick={() => setForm({ isActive: true })}><Plus className="h-4 w-4 mr-2" />{t("catalogPage.addCity")}</Button>
      </div>

      <div className="rounded-lg border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-2 w-8">
                <input type="checkbox" checked={allSelected} onChange={toggleAll} className="rounded cursor-pointer" />
              </th>
              <ColumnHeader asTh label={t("catalogPage.city")}
                sort={{ sortKey: "name", current: { key: sort.col, dir: sort.dir }, onSort: handleSort }}
                filter={{ type: "text", value: fName, onChange: v => { setFName(v); setPage(1); }, placeholder: t("catalogPage.filterByName"), label: t("catalogPage.city") }} />
              <ColumnHeader asTh label={t("catalogPage.country")}
                sort={{ sortKey: "country", current: { key: sort.col, dir: sort.dir }, onSort: handleSort }}
                filter={{ type: "select", value: filterCountry, onChange: v => { setFilterCountry(v); setPage(1); setSelected(new Set()); },
                  options: countries.map(c => ({ value: String(c.id), label: c.name })), allLabel: t("catalogPage.allCountries"), allValue: "all", label: t("catalogPage.country") }} />
              <ColumnHeader asTh label={t("common.status")}
                sort={{ sortKey: "status", current: { key: sort.col, dir: sort.dir }, onSort: handleSort }}
                filter={{ type: "select", value: fStatus || "all", onChange: v => { setFStatus(v === "all" ? "" : v); setPage(1); },
                  options: [{ value: "active", label: t("common.active") }, { value: "inactive", label: t("common.inactive") }], allLabel: t("common.all"), label: t("common.status") }} />
              <th className="w-20 px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {sorted.length === 0 && (
              <tr><td colSpan={5} className="text-center py-8 text-muted-foreground">{t("catalogPage.noCitiesFound")}</td></tr>
            )}
            {sorted.map(c => (
              <tr key={c.id} className={`hover:bg-muted/20 transition-colors ${selected.has(c.id) ? "bg-primary/5" : ""}`}>
                <td className="px-4 py-2.5">
                  <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggleOne(c.id)} className="rounded cursor-pointer" />
                </td>
                <td className="px-4 py-2.5 font-medium">{c.name}</td>
                <td className="px-4 py-2.5 text-muted-foreground"><span className="inline-flex items-center gap-1.5">{countryMap[c.countryId]?.code ? <CountryFlag code={countryMap[c.countryId].code} size="sm" /> : null}{countryMap[c.countryId]?.name ?? c.countryId}</span></td>
                <td className="px-4 py-2.5">
                  <Badge variant={c.isActive ? "default" : "secondary"} className="text-xs">{c.isActive ? t("common.active") : t("common.inactive")}</Badge>
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex gap-1 justify-end">
                    <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setForm(c)}><Pencil className="h-3.5 w-3.5" /></Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" onClick={() => setDelId(c.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {allSelected && total > sorted.length && (
        <SelectAllBanner
          selectedCount={selected.size}
          total={total}
          allMatchingSelected={allMatchingSelected}
          selecting={selectingAll}
          onSelectAllMatching={selectAllMatching}
          onClear={() => setSelected(new Set())}
        />
      )}
      <Pagination page={page} totalPages={totalPages} onPage={p => { setPage(p); setSelected(new Set()); }} />

      <Dialog open={form !== null} onOpenChange={o => !o && setForm(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>{form?.id ? t("catalogPage.editCity") : t("catalogPage.newCity")}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label>{t("catalogPage.cityNameReq")}</Label><Input className="mt-1" value={form?.name ?? ""} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></div>
            <div>
              <Label>{t("catalogPage.countryReq")}</Label>
              <SearchableSelect
                className="mt-1"
                value={form?.countryId ? String(form.countryId) : ""}
                onValueChange={v => setForm(f => ({ ...f, countryId: Number(v) }))}
                placeholder={t("catalogPage.selectCountry")}
                options={countries.map(c => ({
                  value: String(c.id),
                  label: c.name,
                  icon: c.code ? <CountryFlag code={c.code} size="sm" /> : undefined,
                }))}
              />
            </div>
            <div className="flex items-center justify-between">
              <Label>{t("common.active")}</Label>
              <Switch checked={form?.isActive ?? true} onCheckedChange={v => setForm(f => ({ ...f, isActive: v }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setForm(null)}>{t("common.cancel")}</Button>
            <Button onClick={() => save.mutate(form!)} disabled={save.isPending || !form?.name || !form?.countryId}>{t("common.save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={delId !== null} onOpenChange={o => !o && setDelId(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>{t("catalogPage.deleteCity")}</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">{t("catalogPage.confirmDeleteCity")}</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDelId(null)}>{t("common.cancel")}</Button>
            <Button variant="destructive" onClick={() => del.mutate(delId!)} disabled={del.isPending}>{t("common.delete")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={bulkDelOpen} onOpenChange={o => !o && setBulkDelOpen(false)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>{t("catalogPage.bulkDelete")}</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">{t("catalogPage.confirmBulkDeleteCities", { n: selected.size })}</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkDelOpen(false)}>{t("common.cancel")}</Button>
            <Button variant="destructive" onClick={handleBulkDelete} disabled={bulkDeleting}>
              {bulkDeleting ? t("catalogPage.deleting") : t("catalogPage.deleteNCities", { n: selected.size })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <BulkImportModal open={bulkOpen} onClose={() => setBulkOpen(false)} title={t("adminCatalog.tabCities")} templateRows={templateRows} onImport={handleBulkImport} />
    </div>
    </>
  );
}

/* ═══════════════════════════════════════════════════════════
   UNIVERSITIES TAB
══════════════════════════════════════════════════════════ */
function UniversitiesTab() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const isSuperAdmin = user?.role === "super_admin";
  const logoInputRef = useRef<HTMLInputElement>(null);

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const dSearch = useDebounce(search);
  const [form, setForm] = useState<Partial<University> | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [delId, setDelId] = useState<number | null>(null);
  const [selCountryId, setSelCountryId] = useState<number | null>(null);
  const [sort, setSort] = useState<SortState>({ col: "name", dir: "asc" });
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkDelOpen, setBulkDelOpen] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [selectingAll, setSelectingAll] = useState(false);

  // Column filters
  const [fName, setFName] = useState("");
  const [fCountry, setFCountry] = useState("");
  const [fCity, setFCity] = useState("");
  const [fType, setFType] = useState("");
  const [fQs, setFQs] = useState("");
  const [fStatus, setFStatus] = useState("");
  const dfName = useDebounce(fName);
  const dfCity = useDebounce(fCity);
  const dfQs = useDebounce(fQs);

  const { data: catOptsResp } = useQuery({ queryKey: ["catalog-options"], queryFn: () => api("/api/catalog-options") });
  const uniTypeOpts = ((catOptsResp as any)?.grouped?.university_type || []).filter((o: any) => o.isActive).map((o: any) => o.value);

  const { data } = useQuery({
    queryKey: ["universities", page, dSearch, dfName, fCountry, dfCity, fType, dfQs, fStatus],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), limit: "30", summary: "1" });
      if (dSearch) params.set("search", dSearch);
      if (dfName) params.set("name", dfName);
      if (fCountry) params.set("country", fCountry);
      if (dfCity) params.set("city", dfCity);
      if (fType) params.set("type", fType);
      if (dfQs) params.set("qs", dfQs);
      if (fStatus) params.set("status", fStatus);
      return api(`/api/universities?${params.toString()}`);
    },
  });
  const universities: University[] = data?.data ?? [];
  const totalPages = data?.meta?.totalPages ?? 1;

  const sorted = useMemo(() => {
    return [...universities].sort((a, b) => {
      if (sort.col === "country") {
        const cmp = (a.country ?? "").localeCompare(b.country ?? "", "tr", { sensitivity: "base" });
        return sort.dir === "asc" ? cmp : -cmp;
      }
      if (sort.col === "city") {
        const cmp = (a.city ?? "").localeCompare(b.city ?? "", "tr", { sensitivity: "base" });
        return sort.dir === "asc" ? cmp : -cmp;
      }
      if (sort.col === "type") return sortCompare(a, b, "universityType" as keyof University, sort.dir);
      if (sort.col === "qs") return sortCompare(a, b, "qsRanking" as keyof University, sort.dir);
      if (sort.col === "status") return sortCompare(a, b, "status" as keyof University, sort.dir);
      return sortCompare(a, b, "name" as keyof University, sort.dir);
    });
  }, [universities, sort]);

  function handleSort(col: string) {
    setSort(s => s.col === col ? { col, dir: s.dir === "asc" ? "desc" : "asc" } : { col, dir: "asc" });
  }

  const allSelected = sorted.length > 0 && sorted.every(u => selected.has(u.id));
  function toggleAll() {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(sorted.map(u => u.id)));
  }
  function toggleOne(id: number) {
    setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  async function handleBulkDelete() {
    setBulkDeleting(true);
    const count = selected.size;
    const failures = await bulkDelete([...selected], id => `/api/universities/${id}`);
    setSelected(new Set());
    setBulkDelOpen(false);
    setBulkDeleting(false);
    qc.invalidateQueries({ queryKey: ["universities"] });
    if (failures > 0) toast({ title: t("catalogPage.bulkDeleteFailed"), description: t("catalogPage.bulkDeleteFailedDesc", { failed: failures, total: count }), variant: "destructive" });
  }

  const total = data?.meta?.total ?? 0;
  const allMatchingSelected = total > 0 && selected.size >= total;
  async function selectAllMatching() {
    setSelectingAll(true);
    try {
      const params = new URLSearchParams({ limit: "5000", summary: "1" });
      if (dSearch) params.set("search", dSearch);
      if (dfName) params.set("name", dfName);
      if (fCountry) params.set("country", fCountry);
      if (dfCity) params.set("city", dfCity);
      if (fType) params.set("type", fType);
      if (dfQs) params.set("qs", dfQs);
      if (fStatus) params.set("status", fStatus);
      const ids = await fetchAllIds(`/api/universities?${params.toString()}`);
      setSelected(new Set(ids));
    } catch {} finally { setSelectingAll(false); }
  }
  async function runExport(onlySelected: boolean) {
    try {
      let list = await fetchAllRows<University>("/api/universities");
      if (onlySelected) list = list.filter(u => selected.has(u.id));
      const rows = list.map((u: University) => ({
        Name: u.name, Country: u.country, City: u.city ?? "", Website: u.website ?? "",
        Type: u.universityType ?? "", "Tax Type": u.taxType ?? "", "Tax %": u.taxPercent ?? "",
        Status: u.status, Active: u.isActive ? "Yes" : "No",
        "QS Ranking": u.qsRanking ?? "", "Times Ranking": u.timesRanking ?? "",
        "Shanghai Ranking": u.shanghaiRanking ?? "", "CWTS Leiden Ranking": u.cwtsLeidenRanking ?? "",
        Address: u.address ?? "", "Logo URL": u.logoUrl ?? "",
        "Online Payment URL": u.onlinePaymentUrl ?? "", "CRICOS Link": u.cricosLink ?? "",
        "Documents Link": u.documentsLink ?? "", "Current Fee List Link": u.currentFeeListLink ?? "",
        "Initial Deposit Options": u.initialDepositOptions ?? "", "Admission Process": u.admissionProcess ?? "",
        "Contact Person": u.contactPersonName ?? "", "Contact Phone": u.contactPersonPhone ?? "",
        "Contact Email": u.contactPersonEmail ?? "", Description: u.description ?? "",
      }));
      await exportToExcel(rows, "Universities", `universities-${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch {}
  }

  const { data: allCountriesResp } = useQuery({
    queryKey: ["all-countries-uni"],
    queryFn: () => api("/api/countries?limit=500"),
  });
  const allCountries: Country[] = allCountriesResp?.data ?? [];

  const { data: uniCountriesResp } = useQuery({
    queryKey: ["uni-countries-distinct"],
    queryFn: () => api("/api/universities/countries"),
  });
  const uniCountries: string[] = Array.isArray(uniCountriesResp) ? uniCountriesResp : [];

  const { data: uniCitiesResp } = useQuery({
    queryKey: ["uni-cities-distinct"],
    queryFn: () => api("/api/universities/cities"),
  });
  const uniCities: string[] = Array.isArray(uniCitiesResp) ? uniCitiesResp : [];

  const { data: formCitiesResp } = useQuery({
    queryKey: ["form-cities-uni", selCountryId],
    queryFn: () => api(`/api/cities?countryId=${selCountryId}&limit=500`),
    enabled: selCountryId != null,
  });
  const formCities: City[] = formCitiesResp?.data ?? [];

  const save = useMutation({
    mutationFn: async (f: Partial<University>) => f.id
      ? api(`/api/universities/${f.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(f) })
      : api("/api/universities", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(f) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["universities"] });
      setForm(null);
      toast({ title: t("common.saved"), description: t("catalogPage.universitySaved") });
    },
    onError: (e: any) => toast({ title: t("catalogPage.saveFailed"), description: String(e?.message || e), variant: "destructive" }),
  });

  const del = useMutation({
    mutationFn: (id: number) => apiDelete(`/api/universities/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["universities"] }); setDelId(null); },
  });

  const handleBulkImport = async (
    rows: Record<string, string>[],
    onProgress: (progress: BulkImportProgress) => void,
  ) => {
    const res = await importRowsInChunks("/api/universities/bulk", rows, onProgress);
    qc.invalidateQueries({ queryKey: ["universities"] });
    return res;
  };

  const handleLogoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const dataUrl = ev.target?.result as string;
      setForm(f => ({ ...f, logoUrl: dataUrl }));
    };
    reader.readAsDataURL(file);
  };

  const setF = (updates: Partial<University>) => setForm(f => ({ ...f, ...updates } as Partial<University>));

  const openEditUniversity = async (id: number) => {
    try {
      const university = await api(`/api/universities/${id}`);
      setForm(university);
      setSelCountryId(allCountries.find(c => c.name === university.country)?.id ?? null);
    } catch (error: any) {
      toast({
        title: t("common.error"),
        description: String(error?.message || error),
        variant: "destructive",
      });
    }
  };

  const templateRows = [
    { name: "Istanbul University", country: "Turkey", city: "Istanbul", website: "https://www.istanbul.edu.tr", description: "Leading state university", ranking: 351, universityType: "Public", taxType: "KDV", taxPercent: 18, qsRanking: 501, timesRanking: 601, shanghaiRanking: 401, cwtsLeidenRanking: 0, address: "Beyazıt, 34452 Fatih/İstanbul", logoUrl: "", onlinePaymentUrl: "", cricosLink: "", documentsLink: "", currentFeeListLink: "", initialDepositOptions: "Bank Transfer", admissionProcess: "Online application via portal", contactPersonName: "Ahmet Yılmaz", contactPersonPhone: "+90 212 440 0000", contactPersonEmail: "intl@istanbul.edu.tr", status: "open", isActive: "Yes" },
    { name: "Middle East Technical University", country: "Turkey", city: "Ankara", website: "https://www.metu.edu.tr", description: "Top technical university", ranking: 601, universityType: "Public", taxType: "KDV", taxPercent: 18, qsRanking: 336, timesRanking: 401, shanghaiRanking: 501, cwtsLeidenRanking: 0, address: "Üniversiteler Mah. Dumlupınar Blv. No:1, 06800 Çankaya/Ankara", logoUrl: "", onlinePaymentUrl: "", cricosLink: "", documentsLink: "", currentFeeListLink: "", initialDepositOptions: "Credit Card, Bank Transfer", admissionProcess: "Apply through international office", contactPersonName: "Elif Demir", contactPersonPhone: "+90 312 210 2000", contactPersonEmail: "intl@metu.edu.tr", status: "open", isActive: "Yes" },
    { name: "King's College London", country: "United Kingdom", city: "London", website: "https://www.kcl.ac.uk", description: "Russell Group university", ranking: 35, universityType: "Private", taxType: "VAT", taxPercent: 20, qsRanking: 40, timesRanking: 35, shanghaiRanking: 47, cwtsLeidenRanking: 55, address: "Strand, London WC2R 2LS, UK", logoUrl: "", onlinePaymentUrl: "https://pay.kcl.ac.uk", cricosLink: "", documentsLink: "https://docs.kcl.ac.uk", currentFeeListLink: "https://www.kcl.ac.uk/study/fees", initialDepositOptions: "Credit Card, Bank Transfer", admissionProcess: "UCAS application required", contactPersonName: "James Smith", contactPersonPhone: "+44 20 7836 5454", contactPersonEmail: "admissions@kcl.ac.uk", status: "open", isActive: "Yes" },
  ];

  return (
    <>
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input placeholder={t("catalogPage.searchUniversities")} className="pl-8" value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} />
        </div>
        {selected.size > 0 && (
          <Button variant="destructive" size="sm" onClick={() => setBulkDelOpen(true)}>
            <Trash2 className="h-4 w-4 mr-2" />{t("catalogPage.deleteSelected", { n: selected.size })}
          </Button>
        )}
        {selected.size > 0 && (
          <Button variant="outline" size="sm" onClick={() => runExport(true)}>
            <Download className="h-4 w-4 mr-2" />{t("catalogPage.exportSelected", { n: selected.size })}
          </Button>
        )}
        <Button variant="outline" onClick={() => setBulkOpen(true)}><Upload className="h-4 w-4 mr-2" />{t("catalogPage.importExcel")}</Button>
        <Button variant="outline" onClick={() => runExport(false)}><Download className="h-4 w-4 mr-2" />{t("catalogPage.exportExcel")}</Button>
        <Button onClick={() => { setForm({ isActive: true, status: "open" }); setSelCountryId(null); }}><Plus className="h-4 w-4 mr-2" />{t("catalogPage.addUniversity")}</Button>
      </div>

      <div className="rounded-lg border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-2 w-8">
                <input type="checkbox" checked={allSelected} onChange={toggleAll} className="rounded cursor-pointer" />
              </th>
              <ColumnHeader asTh label={t("catalogPage.university")}
                sort={{ sortKey: "name", current: { key: sort.col, dir: sort.dir }, onSort: handleSort }}
                filter={{ type: "text", value: fName, onChange: v => { setFName(v); setPage(1); }, placeholder: t("catalogPage.filterByName"), label: t("catalogPage.university") }} />
              <ColumnHeader asTh label={t("catalogPage.country")}
                sort={{ sortKey: "country", current: { key: sort.col, dir: sort.dir }, onSort: handleSort }}
                filter={{ type: "searchable-select", value: fCountry || "all", onChange: v => { setFCountry(v === "all" ? "" : v); setPage(1); },
                  options: uniCountries.map(c => ({ value: c, label: c })), allLabel: t("catalogPage.allCountries"), allValue: "all", label: t("catalogPage.country"), placeholder: t("catalogPage.filterByName") }} />
              <ColumnHeader asTh label={t("catalogPage.city")}
                sort={{ sortKey: "city", current: { key: sort.col, dir: sort.dir }, onSort: handleSort }}
                filter={{ type: "searchable-select", value: fCity || "all", onChange: v => { setFCity(v === "all" ? "" : v); setPage(1); },
                  options: uniCities.map(c => ({ value: c, label: c })), allLabel: t("catalogPage.allCities"), allValue: "all", label: t("catalogPage.city"), placeholder: t("catalogPage.filterByCity") }} />
              <ColumnHeader asTh label={t("catalogPage.type")}
                sort={{ sortKey: "type", current: { key: sort.col, dir: sort.dir }, onSort: handleSort }}
                filter={{ type: "select", value: fType || "all", onChange: v => { setFType(v === "all" ? "" : v); setPage(1); },
                  options: uniTypeOpts.map((ut: string) => ({ value: ut, label: ut.charAt(0).toUpperCase() + ut.slice(1) })), allLabel: t("catalogPage.allTypes"), label: t("catalogPage.type") }} />
              <ColumnHeader asTh label={t("catalogPage.qs")}
                sort={{ sortKey: "qs", current: { key: sort.col, dir: sort.dir }, onSort: handleSort }}
                filter={{ type: "text", value: fQs, onChange: v => { setFQs(v.replace(/[^\d]/g, "")); setPage(1); }, placeholder: t("catalogPage.exactQsRank"), label: t("catalogPage.qsRanking") }} />
              <ColumnHeader asTh label={t("common.status")}
                sort={{ sortKey: "status", current: { key: sort.col, dir: sort.dir }, onSort: handleSort }}
                filter={{ type: "select", value: fStatus || "all", onChange: v => { setFStatus(v === "all" ? "" : v); setPage(1); },
                  options: [{ value: "open", label: t("catalogPage.open") }, { value: "closed", label: t("catalogPage.closed") }], allLabel: t("common.all"), label: t("common.status") }} />
              <th className="w-20 px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {sorted.length === 0 && (
              <tr><td colSpan={8} className="text-center py-8 text-muted-foreground">{t("catalogPage.noUniversitiesFound")}</td></tr>
            )}
            {sorted.map(u => (
              <tr key={u.id} className={`hover:bg-muted/20 transition-colors ${selected.has(u.id) ? "bg-primary/5" : ""}`}>
                <td className="px-4 py-2.5">
                  <input type="checkbox" checked={selected.has(u.id)} onChange={() => toggleOne(u.id)} className="rounded cursor-pointer" />
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    {u.logoUrl
                      ? <img src={u.logoUrl} alt={u.name} loading="lazy" decoding="async" className="w-7 h-7 rounded object-contain border bg-white" />
                      : <div className="w-7 h-7 rounded border bg-muted flex items-center justify-center"><Building2 className="h-3.5 w-3.5 text-muted-foreground" /></div>
                    }
                    <div>
                      <div className="font-medium">{u.name}</div>
                      {u.website && <a href={u.website} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline">{u.website}</a>}
                    </div>
                  </div>
                </td>
                <td className="px-4 py-2.5 text-muted-foreground">{u.country ?? "—"}</td>
                <td className="px-4 py-2.5 text-muted-foreground">{u.city ?? "—"}</td>
                <td className="px-4 py-2.5 text-muted-foreground text-xs">
                  {(() => {
                    const ut = (u.universityType ?? "").toLowerCase();
                    if (ut === "public" || ut === "state") return t("catalogPage.uniTypePublic");
                    if (ut === "private") return t("catalogPage.uniTypePrivate");
                    if (ut === "foundation") return t("catalogPage.uniTypeFoundation");
                    return u.universityType ?? "—";
                  })()}
                </td>
                <td className="px-4 py-2.5 text-muted-foreground">{u.qsRanking ?? "—"}</td>
                <td className="px-4 py-2.5">
                  <div className="flex flex-col gap-0.5">
                    <Badge variant={u.status === "open" ? "default" : "secondary"} className="text-xs w-fit">
                      {u.status === "open" ? t("catalogPage.open") : t("catalogPage.closed")}
                    </Badge>
                    {!u.isActive && <Badge variant="outline" className="text-xs w-fit text-muted-foreground">{t("common.inactive")}</Badge>}
                  </div>
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex gap-1 justify-end">
                    <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => openEditUniversity(u.id)}><Pencil className="h-3.5 w-3.5" /></Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" onClick={() => setDelId(u.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {allSelected && total > sorted.length && (
        <SelectAllBanner
          selectedCount={selected.size}
          total={total}
          allMatchingSelected={allMatchingSelected}
          selecting={selectingAll}
          onSelectAllMatching={selectAllMatching}
          onClear={() => setSelected(new Set())}
        />
      )}
      <Pagination page={page} totalPages={totalPages} onPage={p => { setPage(p); setSelected(new Set()); }} />

      <Dialog open={form !== null} onOpenChange={o => !o && setForm(null)}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{form?.id ? t("catalogPage.editUniversity") : t("catalogPage.newUniversity")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-5">

            {/* ── Logo ──────────────────────────────── */}
            <div className="flex items-center gap-4">
              <div className="w-20 h-20 rounded-lg border-2 border-dashed bg-muted flex items-center justify-center overflow-hidden shrink-0">
                {form?.logoUrl
                  ? <img src={form.logoUrl} alt="logo" className="w-full h-full object-contain" />
                  : <ImageIcon className="h-8 w-8 text-muted-foreground" />
                }
              </div>
              <div className="flex-1">
                <Label className="text-sm font-medium">{t("catalogPage.universityLogo")}</Label>
                <p className="text-xs text-muted-foreground mt-0.5 mb-2">{t("catalogPage.uploadLogoHint")}</p>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => logoInputRef.current?.click()}>
                    <Upload className="h-3.5 w-3.5 mr-1.5" />{t("catalogPage.chooseFile")}
                  </Button>
                  {form?.logoUrl && (
                    <Button type="button" variant="ghost" size="sm" className="text-destructive" onClick={() => setF({ logoUrl: undefined })}>
                      {t("catalogPage.remove")}
                    </Button>
                  )}
                </div>
                <input ref={logoInputRef} type="file" accept="image/*" className="hidden" onChange={handleLogoUpload} />
                <div className="mt-2">
                  <Input placeholder={t("catalogPage.pasteLogoUrl")} className="text-xs h-8"
                    value={form?.logoUrl?.startsWith("data:") ? "" : form?.logoUrl ?? ""}
                    onChange={e => setF({ logoUrl: e.target.value || undefined })}
                  />
                </div>
              </div>
            </div>

            {/* ── Basic Information ───────────────────── */}
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">{t("catalogPage.basicInformation")}</p>
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <Label>{t("catalogPage.universityNameReq")}</Label>
                  <Input className="mt-1" value={form?.name ?? ""} onChange={e => setF({ name: e.target.value })} />
                </div>
                <div>
                  <Label>{t("catalogPage.countryReq")}</Label>
                  <SearchableSelect
                    className="mt-1"
                    value={form?.country ?? ""}
                    onValueChange={v => {
                      const found = allCountries.find(c => c.name === v);
                      setF({ country: v, city: null });
                      setSelCountryId(found?.id ?? null);
                    }}
                    placeholder={t("catalogPage.selectCountry")}
                    options={allCountries.map(c => ({
                      value: c.name,
                      label: c.name,
                      icon: c.code ? <CountryFlag code={c.code} size="sm" /> : undefined,
                    }))}
                  />
                </div>
                <div>
                  <Label>{t("catalogPage.city")}</Label>
                  <SearchableSelect
                    className="mt-1"
                    value={form?.city ?? ""}
                    onValueChange={v => setF({ city: v === "__none__" ? null : (v || null) })}
                    disabled={!selCountryId}
                    placeholder={selCountryId ? t("catalogPage.selectCity") : t("catalogPage.selectCountryFirst")}
                    options={[
                      { value: "__none__", label: t("catalogPage.noCity") },
                      ...formCities.map(c => ({ value: c.name, label: c.name })),
                    ]}
                  />
                </div>
                <div>
                  <Label>{t("catalogPage.universityType")}</Label>
                  <Select value={form?.universityType ?? ""} onValueChange={v => setF({ universityType: v || null })}>
                    <SelectTrigger className="mt-1"><SelectValue placeholder={t("catalogPage.selectType")} /></SelectTrigger>
                    <SelectContent>
                      {uniTypeOpts.map((t: string) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>{t("catalogPage.applicationStatus")}</Label>
                  <Select value={form?.status ?? "open"} onValueChange={v => setF({ status: v })}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="open">{t("catalogPage.open")}</SelectItem>
                      <SelectItem value="closed">{t("catalogPage.closed")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="col-span-2">
                  <Label>{t("catalogPage.address")}</Label>
                  <Input className="mt-1" placeholder={t("catalogPage.fullAddress")} value={form?.address ?? ""} onChange={e => setF({ address: e.target.value })} />
                </div>
                <div className="col-span-2">
                  <Label>{t("common.description")}</Label>
                  <Textarea className="mt-1" rows={2} value={form?.description ?? ""} onChange={e => setF({ description: e.target.value })} />
                </div>
                <div className="col-span-2 flex items-center justify-between">
                  <Label>{t("catalogPage.activeInSystem")}</Label>
                  <Switch checked={form?.isActive ?? true} onCheckedChange={v => setF({ isActive: v })} />
                </div>
              </div>
            </div>

            {/* ── Tax ───────────────────────────────── */}
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">{t("catalogPage.taxInformation")}</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>{t("catalogPage.taxType")}</Label>
                  <Input className="mt-1" placeholder={t("catalogPage.taxTypePlaceholder")} value={form?.taxType ?? ""} onChange={e => setF({ taxType: e.target.value })} />
                </div>
                <div>
                  <Label>{t("catalogPage.taxRate")}</Label>
                  <Input className="mt-1" type="number" step="0.01" placeholder="18" value={form?.taxPercent ?? ""} onChange={e => setF({ taxPercent: e.target.value ? Number(e.target.value) : undefined })} />
                </div>
              </div>
            </div>

            {/* ── Rankings ──────────────────────────── */}
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">{t("catalogPage.worldRankings")}</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>{t("catalogPage.qsWorldRanking")}</Label>
                  <Input className="mt-1" type="number" placeholder="—" value={form?.qsRanking ?? ""} onChange={e => setF({ qsRanking: e.target.value ? Number(e.target.value) : undefined })} />
                </div>
                <div>
                  <Label>{t("catalogPage.timesHigherEducation")}</Label>
                  <Input className="mt-1" type="number" placeholder="—" value={form?.timesRanking ?? ""} onChange={e => setF({ timesRanking: e.target.value ? Number(e.target.value) : undefined })} />
                </div>
                <div>
                  <Label>{t("catalogPage.shanghaiArwu")}</Label>
                  <Input className="mt-1" type="number" placeholder="—" value={form?.shanghaiRanking ?? ""} onChange={e => setF({ shanghaiRanking: e.target.value ? Number(e.target.value) : undefined })} />
                </div>
                <div>
                  <Label>{t("catalogPage.cwtsLeiden")}</Label>
                  <Input className="mt-1" type="number" placeholder="—" value={form?.cwtsLeidenRanking ?? ""} onChange={e => setF({ cwtsLeidenRanking: e.target.value ? Number(e.target.value) : undefined })} />
                </div>
              </div>
            </div>

            {/* ── Links ─────────────────────────────── */}
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">{t("catalogPage.linksDocuments")}</p>
              <div className="grid grid-cols-1 gap-3">
                <div>
                  <Label>{t("catalogPage.website")}</Label>
                  <div className="flex gap-2 mt-1">
                    <Input placeholder="https://university.edu" value={form?.website ?? ""} onChange={e => setF({ website: e.target.value })} />
                    {form?.website && <a href={form.website} target="_blank" rel="noopener noreferrer"><Button type="button" variant="ghost" size="icon"><ExternalLink className="h-4 w-4" /></Button></a>}
                  </div>
                </div>
                <div>
                  <Label>{t("catalogPage.onlinePaymentLink")}</Label>
                  <Input className="mt-1" placeholder="https://…" value={form?.onlinePaymentUrl ?? ""} onChange={e => setF({ onlinePaymentUrl: e.target.value })} />
                </div>
                <div>
                  <Label>{t("catalogPage.cricosLink")}</Label>
                  <Input className="mt-1" placeholder="https://cricos.education.gov.au/…" value={form?.cricosLink ?? ""} onChange={e => setF({ cricosLink: e.target.value })} />
                </div>
                <div>
                  <Label>{t("catalogPage.documentsLink")}</Label>
                  <Input className="mt-1" placeholder="https://…" value={form?.documentsLink ?? ""} onChange={e => setF({ documentsLink: e.target.value })} />
                </div>
                <div>
                  <Label>{t("catalogPage.currentFeeList")}</Label>
                  <Input className="mt-1" placeholder="https://…" value={form?.currentFeeListLink ?? ""} onChange={e => setF({ currentFeeListLink: e.target.value })} />
                </div>
              </div>
            </div>

            {/* ── Admission Process ─────────────────── */}
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">{t("catalogPage.admissionProcess")}</p>
              <div className="space-y-3">
                <div>
                  <Label>{t("catalogPage.initialDepositOptions")}</Label>
                  <Textarea className="mt-1" rows={2} placeholder={t("catalogPage.depositOptionsPlaceholder")} value={form?.initialDepositOptions ?? ""} onChange={e => setF({ initialDepositOptions: e.target.value })} />
                </div>
                <div>
                  <Label>{t("catalogPage.admissionProcessDesc")}</Label>
                  <Textarea className="mt-1" rows={3} placeholder={t("catalogPage.admissionProcessPlaceholder")} value={form?.admissionProcess ?? ""} onChange={e => setF({ admissionProcess: e.target.value })} />
                </div>
              </div>
            </div>

            {/* ── Contact Person (Super Admin only) ─── */}
            {isSuperAdmin && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
                <div className="flex items-center gap-2 mb-3">
                  <Lock className="h-4 w-4 text-amber-600" />
                  <p className="text-xs font-semibold text-amber-700 uppercase tracking-wider">{t("catalogPage.contactPersonSuperAdmin")}</p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="col-span-2">
                    <Label>{t("catalogPage.fullName")}</Label>
                    <Input className="mt-1 bg-white" placeholder={t("catalogPage.fullNamePlaceholder")} value={form?.contactPersonName ?? ""} onChange={e => setF({ contactPersonName: e.target.value })} />
                  </div>
                  <div>
                    <Label>{t("common.phone")}</Label>
                    <Input className="mt-1 bg-white" placeholder="+1 555 000 0000" value={form?.contactPersonPhone ?? ""} onChange={e => setF({ contactPersonPhone: e.target.value })} />
                  </div>
                  <div>
                    <Label>{t("common.email")}</Label>
                    <Input className="mt-1 bg-white" type="email" placeholder="contact@university.edu" value={form?.contactPersonEmail ?? ""} onChange={e => setF({ contactPersonEmail: e.target.value })} />
                  </div>
                </div>
              </div>
            )}
          </div>

          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setForm(null)}>{t("common.cancel")}</Button>
            <Button onClick={() => save.mutate(form!)} disabled={save.isPending || !form?.name || !form?.country}>
              {save.isPending ? t("common.saving") : t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={delId !== null} onOpenChange={o => !o && setDelId(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>{t("catalogPage.deleteUniversity")}</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">{t("catalogPage.confirmDeleteUniversity")}</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDelId(null)}>{t("common.cancel")}</Button>
            <Button variant="destructive" onClick={() => del.mutate(delId!)} disabled={del.isPending}>{t("common.delete")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={bulkDelOpen} onOpenChange={o => !o && setBulkDelOpen(false)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>{t("catalogPage.bulkDelete")}</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">{t("catalogPage.confirmBulkDeleteUniversities", { n: selected.size })}</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkDelOpen(false)}>{t("common.cancel")}</Button>
            <Button variant="destructive" onClick={handleBulkDelete} disabled={bulkDeleting}>
              {bulkDeleting ? t("catalogPage.deleting") : t("catalogPage.deleteNUniversities", { n: selected.size })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <BulkImportModal open={bulkOpen} onClose={() => setBulkOpen(false)} title={t("adminCatalog.tabUniversities")} templateRows={templateRows} onImport={handleBulkImport} />
    </div>
    </>
  );
}

/* ═══════════════════════════════════════════════════════════
   PROGRAMS TAB
══════════════════════════════════════════════════════════ */
function ProgramsTab() {
  const { t } = useI18n();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { season } = useSeason();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [filterUni, setFilterUni] = useState("all");
  const dSearch = useDebounce(search);
  const [form, setForm] = useState<Partial<Program> | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [delId, setDelId] = useState<number | null>(null);
  const [sort, setSort] = useState<SortState>({ col: "name", dir: "asc" });
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkDelOpen, setBulkDelOpen] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [bulkStatusUpdating, setBulkStatusUpdating] = useState<boolean | null>(null);
  const [selectingAll, setSelectingAll] = useState(false);
  const [delAllOpen, setDelAllOpen] = useState(false);
  const [delAllInProgress, setDelAllInProgress] = useState(false);
  const [translationProgram, setTranslationProgram] = useState<Program | null>(null);

  const { data: unisData } = useQuery({
    queryKey: ["university-options"],
    queryFn: () => api("/api/universities/options"),
  });
  const universities: UniversityOption[] = unisData?.data ?? [];
  const uniMap: Record<number, UniversityOption> = Object.fromEntries(universities.map(u => [u.id, u]));

  const { data: catOptsResp } = useQuery({ queryKey: ["catalog-options"], queryFn: () => api("/api/catalog-options") });
  const catOpts: Record<string, CatalogOption[]> = (catOptsResp as any)?.grouped || {};
  const activeOpts = (key: string) => (catOpts[key] || []).filter(o => o.isActive).map(o => o.value);

  const [fName, setFName] = useState("");
  const [fDegree, setFDegree] = useState("");
  const [fLanguage, setFLanguage] = useState("");
  const [fField, setFField] = useState("");
  const dfName = useDebounce(fName);

  function programFilterParams(pageValue?: number, limitValue?: number) {
    const params = new URLSearchParams();
    if (pageValue != null) params.set("page", String(pageValue));
    if (limitValue != null) params.set("limit", String(limitValue));
    if (dSearch) params.set("search", dSearch);
    if (filterUni !== "all") params.set("universityId", filterUni);
    if (dfName) params.set("name", dfName);
    if (fDegree) params.set("degree", fDegree);
    if (fLanguage) params.set("language", fLanguage);
    if (fField) params.set("field", fField);
    return params;
  }

  const { data } = useQuery({
    queryKey: ["programs", page, dSearch, filterUni, dfName, fDegree, fLanguage, fField],
    queryFn: () => {
      const params = programFilterParams(page, 30);
      return api(`/api/programs?${params.toString()}`);
    },
  });
  const programs: Program[] = data?.data ?? [];
  const totalPages = data?.meta?.totalPages ?? 1;

  const translationDetails = useQuery<{ sourceLocale: string; targetLocales: string[]; data: ProgramTranslationRow[] }>({
    queryKey: ["program-translations", translationProgram?.id],
    queryFn: () => api(`/api/programs/${translationProgram!.id}/translations`),
    enabled: translationProgram !== null,
  });

  const retryTranslations = useMutation({
    mutationFn: (programId: number) => api(`/api/programs/${programId}/translations/retry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["programs"] }),
        qc.invalidateQueries({ queryKey: ["program-translations", translationProgram?.id] }),
      ]);
      toast({ title: t("common.success"), description: t("catalogPage.translationsQueued") });
    },
  });

  const retryAllFailed = useMutation({
    mutationFn: () => api("/api/programs/translations/retry-failed", { method: "POST" }),
    onSuccess: async (result) => {
      await qc.invalidateQueries({ queryKey: ["programs"] });
      toast({
        title: t("common.success"),
        description: t("catalogPage.failedTranslationsQueued", { n: result?.queued ?? 0 }),
      });
    },
  });

  const { data: enrolledCounts = {} } = useQuery<Record<number, number>>({
    queryKey: ["programs-enrolled-counts", season],
    queryFn: () => api(`/api/programs/enrolled-counts?season=${encodeURIComponent(season)}`),
    staleTime: 60_000,
  });

  const sorted = useMemo(() => {
    return [...programs].sort((a, b) => {
      if (sort.col === "university") {
        const an = a.universityName ?? uniMap[a.universityId]?.name ?? "";
        const bn = b.universityName ?? uniMap[b.universityId]?.name ?? "";
        const cmp = an.localeCompare(bn, "tr", { sensitivity: "base" });
        return sort.dir === "asc" ? cmp : -cmp;
      }
      if (sort.col === "degree") return sortCompare(a, b, "degree" as keyof Program, sort.dir);
      if (sort.col === "field") return sortCompare(a, b, "field" as keyof Program, sort.dir);
      if (sort.col === "fee") return sortCompare(a, b, "tuitionFee" as keyof Program, sort.dir);
      if (sort.col === "commission") return sortCompare(a, b, "commissionRate" as keyof Program, sort.dir);
      return sortCompare(a, b, "name" as keyof Program, sort.dir);
    });
  }, [programs, sort, uniMap]);

  function handleSort(col: string) {
    setSort(s => s.col === col ? { col, dir: s.dir === "asc" ? "desc" : "asc" } : { col, dir: "asc" });
  }

  const allSelected = sorted.length > 0 && sorted.every(p => selected.has(p.id));
  function toggleAll() {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(sorted.map(p => p.id)));
  }
  function toggleOne(id: number) {
    setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  async function handleBulkDelete() {
    setBulkDeleting(true);
    const count = selected.size;
    const failures = await bulkDelete([...selected], id => `/api/programs/${id}`);
    setSelected(new Set());
    setBulkDelOpen(false);
    setBulkDeleting(false);
    qc.invalidateQueries({ queryKey: ["programs"] });
    if (failures > 0) toast({ title: t("catalogPage.bulkDeleteFailed"), description: t("catalogPage.bulkDeleteFailedDesc", { failed: failures, total: count }), variant: "destructive" });
  }

  async function handleBulkStatus(isActive: boolean) {
    if (selected.size === 0) return;
    setBulkStatusUpdating(isActive);
    try {
      const result = await api("/api/programs/bulk-status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [...selected], isActive }),
      });
      setSelected(new Set());
      await qc.invalidateQueries({ queryKey: ["programs"] });
      toast({
        title: t("common.success"),
        description: `${result.updated} ${t("adminCatalog.tabPrograms")} · ${isActive ? t("common.active") : t("common.inactive")}`,
      });
    } catch (error) {
      toast({
        title: t("common.error"),
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    } finally {
      setBulkStatusUpdating(null);
    }
  }

  const total = data?.meta?.total ?? 0;
  const allMatchingSelected = total > 0 && selected.size >= total;
  async function selectAllMatching() {
    setSelectingAll(true);
    try {
      const params = programFilterParams(undefined, 100);
      const ids = await fetchAllIds(`/api/programs?${params.toString()}`);
      setSelected(new Set(ids));
    } catch {} finally { setSelectingAll(false); }
  }
  async function runExport(onlySelected: boolean) {
    try {
      const params = programFilterParams();
      const exportUrl = `/api/programs${params.size ? `?${params.toString()}` : ""}`;
      let list = await fetchAllRows<Program>(exportUrl);
      if (onlySelected) list = list.filter(p => selected.has(p.id));
      const rows = list.map((p: Program) => ({
        Program: p.name, University: p.universityName ?? uniMap[p.universityId]?.name ?? "",
        Description: p.description ?? "",
        Degree: p.degree ?? "", Field: p.field ?? "", Language: p.language ?? "",
        Duration: p.duration ?? "", "Fee Type": p.feeType ?? "",
        "Tuition Fee": p.tuitionFee ?? "", Currency: p.currency ?? "",
        "Commission %": p.commissionRate ?? "", "Scholarship": p.scholarship ?? "",
        Intakes: p.intakes ?? "", "Application Fee": p.applicationFee ?? "",
        "Advance Fee": p.advancedFee ?? "", "Deposit Fee": p.depositFee ?? "",
        "Service Fee": p.serviceFeeAmount ?? "", "Discounted Fee": p.discountedFee ?? "",
        "Language Fee": p.languageFee ?? "", "Min GPA": p.minGpa ?? "",
        "Min Language Score": p.minLanguageScore ?? "", "Quota": p.quota ?? "",
        Active: p.isActive ? "Yes" : "No",
        Requirements: p.requirements ?? "",
      }));
      await exportToExcel(rows, "Programs", `programs-${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch {}
  }

  async function handleDeleteAll() {
    setDelAllInProgress(true);
    try {
      await apiDelete("/api/programs");
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ["programs"] });
    } catch {}
    setDelAllInProgress(false);
    setDelAllOpen(false);
  }

  const [docReqs, setDocReqs] = useState<Record<string, "mandatory" | "optional" | "none">>({});
  const [docSearch, setDocSearch] = useState("");
  const docReqsInitRef = useRef<number | "new" | null>(null);

  useEffect(() => {
    if (form === null) { docReqsInitRef.current = null; return; }
    const key = form.id ?? "new";
    if (docReqsInitRef.current === key) return;
    const map: Record<string, "mandatory" | "optional" | "none"> = {};
    for (const dt of PROGRAM_DOC_TYPE_KEYS) map[dt] = "none";
    const list = (form as any).documentRequirements as { documentType: string; mandatory: boolean }[] | undefined;
    if (Array.isArray(list)) {
      for (const r of list) {
        if (map[r.documentType] !== undefined) map[r.documentType] = r.mandatory ? "mandatory" : "optional";
      }
    }
    setDocReqs(map);
    docReqsInitRef.current = key;
  }, [form]);

  const save = useMutation({
    mutationFn: async (f: Partial<Program>) => {
      const { documentRequirements: _drop, ...rest } = (f as any);
      const saved = f.id
        ? await api(`/api/programs/${f.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(rest) })
        : await api("/api/programs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(rest) });
      const programId = saved?.id ?? f.id;
      if (programId) {
        const requirements = PROGRAM_DOC_TYPE_KEYS
          .map((dt, idx) => {
            const v = docReqs[dt];
            if (v === "mandatory") return { documentType: dt, mandatory: true, sortOrder: idx };
            if (v === "optional") return { documentType: dt, mandatory: false, sortOrder: idx };
            return null;
          })
          .filter(Boolean);
        await api(`/api/programs/${programId}/document-requirements`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requirements }),
        });
      }
      return saved;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["programs"] });
      toast({ title: t("common.success"), description: t("catalogPage.autoTranslationQueued") });
      setForm(null);
    },
  });

  const del = useMutation({
    mutationFn: (id: number) => apiDelete(`/api/programs/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["programs"] }); setDelId(null); },
  });

  const handleBulkImport = async (
    rows: Record<string, string>[],
    onProgress: (progress: BulkImportProgress) => void,
  ) => {
    const collisions = findProgramIdentityCollisions(rows);
    if (collisions.extraRows > 0) {
      const samples = collisions.sampleRows
        .map(({ firstRow, duplicateRow }) => `${firstRow}↔${duplicateRow}`)
        .join(", ");
      throw new Error(t("catalogPage.programIdentityCollisions", {
        groups: collisions.groups,
        rows: collisions.extraRows,
        samples,
      }));
    }

    const res = await importRowsInChunks("/api/programs/bulk", rows, onProgress);
    qc.invalidateQueries({ queryKey: ["programs"] });
    return res;
  };

  const docColumnsAll = (val: string) =>
    Object.fromEntries(PROGRAM_DOC_TYPE_KEYS.map(k => [k, val])) as Record<string, string>;

  // Clean template seeded from REAL programs already in this system so admins
  // see the exact value formats (university spelling, degree label, duration
  // syntax, intake codes, fee shape, doc-requirement mix) that the importer
  // accepts. One row per education level (Associate / Bachelor / Master).
  // Empty doc cells default to "not required" — fill with "mandatory" or
  // "optional" only for the document types that program actually needs. The
  // Instructions sheet documents every column and accepted value.
  const templateRows = [
    {
      universityName: "Antalya Bilim University", name: "Associate of Cookery (Turkish)",
      description: "A practice-focused associate programme in professional cookery.",
      degree: "Associate", field: "Business", language: "Turkish", duration: "24 Months",
      tuitionFee: 5200, currency: "USD", scholarship: 2860, intakes: "Sep",
      requirements: "High school diploma", commissionRate: 13, applicationFee: 0,
      advancedFee: 0, depositFee: 1000, serviceFeeAmount: 0, discountedFee: 2340,
      languageFee: 0, feeType: "Per Year", minGpa: 0, minLanguageScore: 0, quota: "",
      isActive: "Yes",
      ...docColumnsAll(""),
      passport: "mandatory", high_school_diploma_translation: "mandatory",
      class_12th_hsc_marks_sheet: "mandatory", photo: "mandatory",
    },
    {
      universityName: "Antalya Bilim University", name: "Bachelor of Dentistry (Turkish)",
      description: "A five-year dentistry programme combining clinical and scientific education.",
      degree: "Bachelor", field: "Medicine", language: "Turkish", duration: "60 Months",
      tuitionFee: 14000, currency: "USD", scholarship: 2100, intakes: "Sep",
      requirements: "High school diploma, TR-YOS or equivalent",
      commissionRate: 9, applicationFee: 0, advancedFee: 0, depositFee: 2000,
      serviceFeeAmount: 0, discountedFee: 11900, languageFee: 0, feeType: "Per Year",
      minGpa: 0, minLanguageScore: 0, quota: "", isActive: "Yes",
      ...docColumnsAll(""),
      passport: "mandatory", high_school_diploma_translation: "mandatory",
      class_12th_hsc_marks_sheet: "mandatory", photo: "mandatory",
    },
    {
      universityName: "Antalya Bilim University",
      name: "Master of Business Administration (Thesis) (English)",
      description: "An advanced business administration programme with a research thesis.",
      degree: "Master", field: "Business", language: "English", duration: "12 Months",
      tuitionFee: 5400, currency: "USD", scholarship: 810, intakes: "Feb, Sep",
      requirements: "Bachelor's degree, English proficiency",
      commissionRate: 13, applicationFee: 0, advancedFee: 0, depositFee: 1000,
      serviceFeeAmount: 0, discountedFee: 4590, languageFee: 0, feeType: "Per Year",
      minGpa: 0, minLanguageScore: 0, quota: "", isActive: "Yes",
      ...docColumnsAll(""),
      passport: "mandatory", bachelors_certificate: "mandatory",
      bachelors_transcript: "mandatory", photo: "mandatory",
      ielts_pte_gre_gmat_toefl_duolingo: "optional",
    },
  ];

  const notesRows: Record<string, string>[] = [
    { Column: "universityName", Required: "Yes", Notes: "Exact name as it appears in the Universities tab. Case-insensitive but spelling must match." },
    { Column: "name", Required: "Yes", Notes: "Program name (e.g. Computer Engineering)." },
    { Column: "description", Required: "No", Notes: "Canonical English description. Saving automatically queues the other 15 languages." },
    { Column: "degree", Required: "No", Notes: "BSc, MSc, MBA, PhD, Diploma, etc." },
    { Column: "field", Required: "No", Notes: "Field of study (Engineering, Business, Arts, ...)." },
    { Column: "language", Required: "No", Notes: "Language of instruction (English, Turkish, ...)." },
    { Column: "duration", Required: "No", Notes: "Free text: '4 years', '2 years', '18 months'." },
    { Column: "tuitionFee", Required: "No", Notes: "Numeric value only (no currency symbol)." },
    { Column: "currency", Required: "No", Notes: "ISO code: USD, EUR, TRY, GBP. Defaults to USD." },
    { Column: "scholarship", Required: "No", Notes: "Numeric — scholarship amount in the chosen currency." },
    { Column: "intakes", Required: "No", Notes: "Comma-separated: 'Fall, Spring, Summer'." },
    { Column: "requirements", Required: "No", Notes: "Free text shown to students." },
    { Column: "commissionRate", Required: "No", Notes: "Agent commission percent (numeric, e.g. 10)." },
    { Column: "applicationFee / advancedFee / depositFee / serviceFeeAmount / discountedFee / languageFee", Required: "No", Notes: "All numeric (no currency symbol). Leave blank if not applicable." },
    { Column: "feeType", Required: "No", Notes: "Free text: 'per year', 'per semester', 'one-time'." },
    { Column: "minGpa", Required: "No", Notes: "Numeric on a 4.0 scale (e.g. 2.5, 3.0)." },
    { Column: "minLanguageScore", Required: "No", Notes: "Numeric — IELTS / TOEFL / Duolingo equivalent." },
    { Column: "quota", Required: "No", Notes: "Integer — number of seats per intake." },
    { Column: "isActive", Required: "No", Notes: "Yes / No (defaults to Yes)." },
    { Column: "— Document columns —", Required: "", Notes: "Every column from 'passport' onwards is a required-document marker." },
    { Column: "Allowed cell values", Required: "", Notes: "'mandatory' = student MUST upload before applying. 'optional' = shown but not required. (blank) = not requested." },
    { Column: "Removed columns", Required: "", Notes: "Any document column that you delete from the sheet is left UNCHANGED on existing programs (only filled cells overwrite)." },
  ];

  return (
    <>
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[160px] max-w-xs">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t("catalogPage.searchPrograms")}
            className="pl-8"
            value={search}
            onChange={e => {
              setSearch(e.target.value);
              setPage(1);
              setSelected(new Set());
            }}
          />
        </div>
        <SearchableSelect
          value={filterUni}
          onValueChange={v => {
            setFilterUni(v);
            setPage(1);
            setSelected(new Set());
          }}
          placeholder={t("catalogPage.allUniversities")}
          searchPlaceholder={t("common.searchPlaceholder")}
          className="w-[220px]"
          options={[
            { value: "all", label: t("catalogPage.allUniversities") },
            ...universities.map(u => ({
              value: String(u.id),
              label: u.name,
            })),
          ]}
        />
        <SearchableSelect
          value={fDegree || "all"}
          onValueChange={v => {
            setFDegree(v === "all" ? "" : v);
            setPage(1);
            setSelected(new Set());
          }}
          placeholder={t("catalogPage.degree")}
          searchPlaceholder={t("common.searchPlaceholder")}
          className="w-[170px]"
          options={[
            { value: "all", label: `${t("common.all")} · ${t("catalogPage.degree")}` },
            ...activeOpts("degree").map(degree => ({ value: degree, label: degree })),
          ]}
        />
        <SearchableSelect
          value={fLanguage || "all"}
          onValueChange={v => {
            setFLanguage(v === "all" ? "" : v);
            setPage(1);
            setSelected(new Set());
          }}
          placeholder={t("catalogPage.language")}
          searchPlaceholder={t("common.searchPlaceholder")}
          className="w-[170px]"
          options={[
            { value: "all", label: `${t("common.all")} · ${t("catalogPage.language")}` },
            ...activeOpts("language").map(language => ({ value: language, label: language })),
          ]}
        />
        {selected.size > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="border-emerald-300 text-emerald-700 hover:bg-emerald-50"
            onClick={() => handleBulkStatus(true)}
            disabled={bulkStatusUpdating !== null}
          >
            {bulkStatusUpdating === true
              ? <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              : <Check className="h-4 w-4 mr-2" />}
            {t("common.active")} ({selected.size})
          </Button>
        )}
        {selected.size > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="border-amber-300 text-amber-700 hover:bg-amber-50"
            onClick={() => handleBulkStatus(false)}
            disabled={bulkStatusUpdating !== null}
          >
            {bulkStatusUpdating === false
              ? <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              : <X className="h-4 w-4 mr-2" />}
            {t("common.inactive")} ({selected.size})
          </Button>
        )}
        {selected.size > 0 && (
          <Button variant="destructive" size="sm" onClick={() => setBulkDelOpen(true)}>
            <Trash2 className="h-4 w-4 mr-2" />{t("catalogPage.deleteSelected", { n: selected.size })}
          </Button>
        )}
        {selected.size > 0 && (
          <Button variant="outline" size="sm" onClick={() => runExport(true)}>
            <Download className="h-4 w-4 mr-2" />{t("catalogPage.exportSelected", { n: selected.size })}
          </Button>
        )}
        <Button variant="destructive" size="sm" className="gap-1.5" onClick={() => setDelAllOpen(true)}>
          <Trash2 className="h-4 w-4" />{t("catalogPage.deleteAll")}
        </Button>
        <Button variant="outline" onClick={() => setBulkOpen(true)}><Upload className="h-4 w-4 mr-2" />{t("catalogPage.importExcel")}</Button>
        <Button variant="outline" onClick={() => runExport(false)}><Download className="h-4 w-4 mr-2" />{t("catalogPage.exportExcel")}</Button>
        <Button
          variant="outline"
          onClick={() => retryAllFailed.mutate()}
          disabled={retryAllFailed.isPending}
        >
          {retryAllFailed.isPending
            ? <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            : <RefreshCw className="h-4 w-4 mr-2" />}
          {t("catalogPage.retryFailedTranslations")}
        </Button>
        <Button onClick={() => setForm({ isActive: true, currency: "USD" })}><Plus className="h-4 w-4 mr-2" />{t("catalogPage.addProgram")}</Button>
      </div>

      <div className="rounded-lg border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-2 w-8">
                <input type="checkbox" checked={allSelected} onChange={toggleAll} className="rounded cursor-pointer" />
              </th>
              <ColumnHeader asTh label={t("catalogPage.program")}
                sort={{ sortKey: "name", current: { key: sort.col, dir: sort.dir }, onSort: handleSort }}
                filter={{ type: "text", value: fName, onChange: v => { setFName(v); setPage(1); setSelected(new Set()); }, placeholder: t("catalogPage.filterByName"), label: t("catalogPage.program") }} />
              <ColumnHeader asTh label={t("catalogPage.university")}
                sort={{ sortKey: "university", current: { key: sort.col, dir: sort.dir }, onSort: handleSort }}
                filter={{ type: "select", value: filterUni, onChange: v => { setFilterUni(v); setPage(1); setSelected(new Set()); },
                  options: universities.map(u => ({ value: String(u.id), label: u.name })), allLabel: t("catalogPage.allUniversities"), allValue: "all", label: t("catalogPage.university") }} />
              <ColumnHeader asTh label={t("catalogPage.degree")}
                sort={{ sortKey: "degree", current: { key: sort.col, dir: sort.dir }, onSort: handleSort }}
                filter={{ type: "select", value: fDegree || "all", onChange: v => { setFDegree(v === "all" ? "" : v); setPage(1); setSelected(new Set()); },
                  options: activeOpts("degree").map(d => ({ value: d, label: d })), allLabel: t("common.all"), label: t("catalogPage.degree") }} />
              <ColumnHeader asTh label={t("catalogPage.field")}
                sort={{ sortKey: "field", current: { key: sort.col, dir: sort.dir }, onSort: handleSort }}
                filter={{ type: "select", value: fField || "all", onChange: v => { setFField(v === "all" ? "" : v); setPage(1); setSelected(new Set()); },
                  options: activeOpts("field").map(f => ({ value: f, label: f })), allLabel: t("common.all"), label: t("catalogPage.field") }} />
              <SortTh label={t("common.fee")} col="fee" sort={sort} onSort={handleSort} />
              <SortTh label={t("catalogPage.commission")} col="commission" sort={sort} onSort={handleSort} />
              <th className="px-4 py-2 text-xs font-medium text-left">{t("catalogPage.quota")}</th>
              <th className="px-4 py-2 text-xs font-medium text-left">{t("common.status")}</th>
              <th className="w-20 px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {sorted.length === 0 && (
              <tr><td colSpan={10} className="text-center py-8 text-muted-foreground">{t("catalogPage.noProgramsFound")}</td></tr>
            )}
            {sorted.map(p => (
              <tr key={p.id} className={`hover:bg-muted/20 transition-colors ${selected.has(p.id) ? "bg-primary/5" : ""}`}>
                <td className="px-4 py-2.5">
                  <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggleOne(p.id)} className="rounded cursor-pointer" />
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <div className="font-medium">{p.name}</div>
                    {p.translationSummary && (
                      <button
                        type="button"
                        onClick={() => setTranslationProgram(p)}
                        title={t("catalogPage.translationStatus")}
                        className="shrink-0"
                      >
                        <Badge
                          variant="outline"
                          className={p.translationSummary.published === p.translationSummary.target
                            ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                            : p.translationSummary.failed > 0
                              ? "border-red-200 bg-red-50 text-red-700"
                              : "border-amber-200 bg-amber-50 text-amber-700"}
                        >
                          <Languages className="h-3 w-3 mr-1" />
                          {p.translationSummary.published}/{p.translationSummary.target}
                        </Badge>
                      </button>
                    )}
                  </div>
                  {p.language && <span className="text-xs text-muted-foreground">{p.language} {p.duration ? `· ${p.duration}` : ""}</span>}
                </td>
                <td className="px-4 py-2.5 text-muted-foreground text-xs">{p.universityName ?? uniMap[p.universityId]?.name ?? `#${p.universityId}`}</td>
                <td className="px-4 py-2.5 text-muted-foreground text-xs">{p.degree || "—"}</td>
                <td className="px-4 py-2.5 text-muted-foreground text-xs">{p.field || "—"}</td>
                <td className="px-4 py-2.5 text-xs">{p.tuitionFee ? `${p.tuitionFee.toLocaleString()} ${p.currency ?? "USD"}` : "—"}</td>
                <td className="px-4 py-2.5 text-xs">{p.commissionRate != null ? `%${p.commissionRate}` : "—"}</td>
                <td className="px-4 py-2.5 text-xs">
                  {p.quota != null
                    ? <span className={(enrolledCounts[p.id] ?? 0) >= p.quota ? "text-destructive font-semibold" : ""}>{enrolledCounts[p.id] ?? 0}/{p.quota}</span>
                    : "∞"}
                </td>
                <td className="px-4 py-2.5 text-xs">
                  <Badge
                    variant="outline"
                    className={p.isActive
                      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                      : "border-slate-200 bg-slate-50 text-slate-500"}
                  >
                    {p.isActive ? t("common.active") : t("common.inactive")}
                  </Badge>
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex gap-1 justify-end">
                    <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setForm(p)}><Pencil className="h-3.5 w-3.5" /></Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" onClick={() => setDelId(p.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {allSelected && total > sorted.length && (
        <SelectAllBanner
          selectedCount={selected.size}
          total={total}
          allMatchingSelected={allMatchingSelected}
          selecting={selectingAll}
          onSelectAllMatching={selectAllMatching}
          onClear={() => setSelected(new Set())}
        />
      )}
      <Pagination page={page} totalPages={totalPages} onPage={p => { setPage(p); setSelected(new Set()); }} />

      <Dialog open={form !== null} onOpenChange={o => !o && setForm(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto overflow-x-hidden">
          <DialogHeader><DialogTitle>{form?.id ? t("catalogPage.editProgram") : t("catalogPage.newProgram")}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>{t("catalogPage.universityRequired")}</Label>
              <Select value={form?.universityId ? String(form.universityId) : ""} onValueChange={v => setForm(f => ({ ...f, universityId: Number(v) }))}>
                <SelectTrigger className="mt-1"><SelectValue placeholder={t("catalogPage.selectUniversity")} /></SelectTrigger>
                <SelectContent>{universities.map(u => <SelectItem key={u.id} value={String(u.id)}>{u.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div><Label>{t("catalogPage.programNameRequired")}</Label><Input className="mt-1" value={form?.name ?? ""} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></div>
            <div><Label>{t("catalogPage.programDescriptionEnglish")}</Label><Textarea className="mt-1" rows={4} value={form?.description ?? ""} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder={t("catalogPage.programDescriptionPlaceholder")} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>{t("catalogPage.degree")}</Label>
                <Select value={form?.degree ?? ""} onValueChange={v => setForm(f => ({ ...f, degree: v }))}>
                  <SelectTrigger className="mt-1"><SelectValue placeholder={t("catalogPage.select")} /></SelectTrigger>
                  <SelectContent>
                    {activeOpts("degree").map(d => <SelectItem key={d} value={d}>{d}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>{t("catalogPage.field")}</Label>
                <Select value={form?.field ?? ""} onValueChange={v => setForm(f => ({ ...f, field: v }))}>
                  <SelectTrigger className="mt-1"><SelectValue placeholder={t("catalogPage.select")} /></SelectTrigger>
                  <SelectContent>
                    {activeOpts("field").map(f => <SelectItem key={f} value={f}>{f}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>{t("catalogPage.language")}</Label>
                <Select value={form?.language ?? ""} onValueChange={v => setForm(f => ({ ...f, language: v }))}>
                  <SelectTrigger className="mt-1"><SelectValue placeholder={t("catalogPage.select")} /></SelectTrigger>
                  <SelectContent>
                    {activeOpts("language").map(l => <SelectItem key={l} value={l}>{l}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>{t("catalogPage.duration")}</Label>
                <Select value={form?.duration ?? ""} onValueChange={v => setForm(f => ({ ...f, duration: v }))}>
                  <SelectTrigger className="mt-1"><SelectValue placeholder={t("catalogPage.select")} /></SelectTrigger>
                  <SelectContent>
                    {activeOpts("duration").map(d => <SelectItem key={d} value={d}>{d}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>{t("catalogPage.annualFee")}</Label>
                <Input className="mt-1" type="number" value={form?.tuitionFee ?? ""} onChange={e => setForm(f => ({ ...f, tuitionFee: e.target.value ? Number(e.target.value) : undefined }))} />
              </div>
              <div>
                <Label>{t("catalogPage.currency")}</Label>
                <Select value={form?.currency ?? "USD"} onValueChange={v => setForm(f => ({ ...f, currency: v }))}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(activeOpts("currency").length > 0 ? activeOpts("currency") : ["USD", "EUR", "GBP", "TRY", "AED"]).map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>{t("catalogPage.feeType")}</Label>
                <Select value={form?.feeType ?? ""} onValueChange={v => setForm(f => ({ ...f, feeType: v || null }))}>
                  <SelectTrigger className="mt-1"><SelectValue placeholder={t("catalogPage.select")} /></SelectTrigger>
                  <SelectContent>
                    {activeOpts("fee_type").map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div><Label>{t("catalogPage.scholarship")}</Label><Input className="mt-1" type="number" value={form?.scholarship ?? ""} onChange={e => setForm(f => ({ ...f, scholarship: e.target.value ? Number(e.target.value) : null }))} /></div>
              <div><Label>{t("catalogPage.commissionPercent")}</Label><Input className="mt-1" type="number" value={form?.commissionRate ?? ""} onChange={e => setForm(f => ({ ...f, commissionRate: e.target.value ? Number(e.target.value) : null }))} /></div>
            </div>

            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-3">
              <p className="text-xs font-semibold text-amber-600 uppercase tracking-wide">{t("catalogPage.minimumRequirements")}</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">{t("catalogPage.minDiplomaGpa")}</Label>
                  <Input className="mt-1" type="number" step="0.01" placeholder={t("catalogPage.egGpa")} value={form?.minGpa ?? ""} onChange={e => setForm(f => ({ ...f, minGpa: e.target.value ? Number(e.target.value) : null }))} />
                </div>
                <div>
                  <Label className="text-xs">{t("catalogPage.minLanguageScore")}</Label>
                  <Input className="mt-1" type="number" step="0.5" placeholder={t("catalogPage.egLanguageScore")} value={form?.minLanguageScore ?? ""} onChange={e => setForm(f => ({ ...f, minLanguageScore: e.target.value ? Number(e.target.value) : null }))} />
                </div>
                <div>
                  <Label className="text-xs">{t("catalogPage.quota")}</Label>
                  <Input className="mt-1" type="number" step="1" min="1" placeholder={t("catalogPage.quotaPlaceholder")} value={form?.quota ?? ""} onChange={e => setForm(f => ({ ...f, quota: e.target.value ? Math.max(1, Math.round(Number(e.target.value))) : null }))} />
                </div>
              </div>
            </div>

            {/* ── Additional Fees ────────────────────────────── */}
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-3">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">{t("catalogPage.additionalFees")} ({form?.currency ?? "USD"})</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">{t("catalogPage.applicationFee")}</Label>
                  <Input className="mt-1" type="number" placeholder={t("catalogPage.zeroNone")} value={form?.applicationFee ?? ""} onChange={e => setForm(f => ({ ...f, applicationFee: e.target.value ? Number(e.target.value) : null }))} />
                </div>
                <div>
                  <Label className="text-xs">{t("catalogPage.advancedFee")}</Label>
                  <Input className="mt-1" type="number" placeholder={t("catalogPage.zeroNone")} value={form?.advancedFee ?? ""} onChange={e => setForm(f => ({ ...f, advancedFee: e.target.value ? Number(e.target.value) : null }))} />
                </div>
                <div>
                  <Label className="text-xs">{t("catalogPage.depositFee")}</Label>
                  <Input className="mt-1" type="number" placeholder={t("catalogPage.zeroNone")} value={form?.depositFee ?? ""} onChange={e => setForm(f => ({ ...f, depositFee: e.target.value ? Number(e.target.value) : null }))} />
                </div>
                <div>
                  <Label className="text-xs">{t("catalogPage.serviceFee")}</Label>
                  <Input className="mt-1" type="number" placeholder={t("catalogPage.zeroNone")} value={form?.serviceFeeAmount ?? ""} onChange={e => setForm(f => ({ ...f, serviceFeeAmount: e.target.value ? Number(e.target.value) : null }))} />
                </div>
                <div>
                  <Label className="text-xs">{t("catalogPage.discountedFee")}</Label>
                  <Input className="mt-1" type="number" placeholder={t("catalogPage.discountedAmount")} value={form?.discountedFee ?? ""} onChange={e => setForm(f => ({ ...f, discountedFee: e.target.value ? Number(e.target.value) : null }))} />
                </div>
                <div>
                  <Label className="text-xs">{t("catalogPage.languageFee")}</Label>
                  <Input className="mt-1" type="number" placeholder={t("catalogPage.zeroNone")} value={form?.languageFee ?? ""} onChange={e => setForm(f => ({ ...f, languageFee: e.target.value ? Number(e.target.value) : null }))} />
                </div>
              </div>
            </div>

            <div>
              <Label>{t("catalogPage.intakePeriods")}</Label>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {activeOpts("intake").map(ip => {
                  const selected = (form?.intakes ?? "").split(",").map(s => s.trim()).filter(Boolean).includes(ip);
                  return (
                    <Badge
                      key={ip}
                      variant={selected ? "default" : "outline"}
                      className={`cursor-pointer text-xs ${selected ? "" : "opacity-60 hover:opacity-100"}`}
                      onClick={() => {
                        const current = (form?.intakes ?? "").split(",").map(s => s.trim()).filter(Boolean);
                        const next = selected ? current.filter(c => c !== ip) : [...current, ip];
                        setForm(f => ({ ...f, intakes: next.join(", ") }));
                      }}
                    >{ip}</Badge>
                  );
                })}
              </div>
            </div>
            <div><Label>{t("catalogPage.requirements")}</Label><Textarea className="mt-1" rows={2} placeholder={t("catalogPage.requirementsPlaceholder")} value={form?.requirements ?? ""} onChange={e => setForm(f => ({ ...f, requirements: e.target.value }))} /></div>

            <div className="rounded-lg border border-blue-200 bg-blue-50/50 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-blue-700 uppercase tracking-wide">{t("catalogPage.requiredDocuments")}</p>
                <p className="text-[11px] text-muted-foreground">
                  {t("catalogPage.docReqSummary", { req: Object.values(docReqs).filter(v => v !== "none").length, mand: Object.values(docReqs).filter(v => v === "mandatory").length })}
                </p>
              </div>
              <p className="text-[11px] text-muted-foreground">{t("catalogPage.docReqHelp")}</p>
              <Input
                value={docSearch}
                onChange={e => setDocSearch(e.target.value)}
                placeholder={t("catalogPage.searchDocuments")}
                className="h-8 text-xs"
              />
              <div className="max-h-[260px] overflow-y-auto rounded border bg-background">
                <table className="w-full text-xs">
                  <tbody className="divide-y">
                    {(() => {
                      const q = docSearch.trim().toLowerCase();
                      const filtered = q
                        ? PROGRAM_DOC_TYPE_KEYS.filter(dt =>
                            dt.toLowerCase().includes(q) ||
                            (DEGREE_DOC_TYPE_LABELS[dt] ?? "").toLowerCase().includes(q),
                          )
                        : PROGRAM_DOC_TYPE_KEYS;
                      if (filtered.length === 0) {
                        return (
                          <tr><td className="px-2 py-3 text-center text-muted-foreground">{t("catalogPage.noDocsMatch", { q: docSearch })}</td></tr>
                        );
                      }
                      return filtered.map(dt => {
                      const v = docReqs[dt] ?? "none";
                      return (
                        <tr key={dt} className="hover:bg-muted/30">
                          <td className="px-2 py-1.5 break-words">{DEGREE_DOC_TYPE_LABELS[dt]}</td>
                          <td className="px-2 py-1.5 w-[210px] text-right whitespace-nowrap">
                            <div className="inline-flex rounded-md border overflow-hidden">
                              {(["none", "optional", "mandatory"] as const).map(opt => (
                                <button
                                  key={opt}
                                  type="button"
                                  onClick={() => setDocReqs(prev => ({ ...prev, [dt]: opt }))}
                                  className={`px-2 py-0.5 text-[11px] transition-colors ${
                                    v === opt
                                      ? opt === "mandatory" ? "bg-red-600 text-white"
                                        : opt === "optional" ? "bg-blue-600 text-white"
                                        : "bg-muted text-foreground"
                                      : "bg-background hover:bg-muted/50 text-muted-foreground"
                                  }`}
                                >{opt === "none" ? t("catalogPage.none") : opt === "optional" ? t("common.optional") : t("catalogPage.mandatory")}</button>
                              ))}
                            </div>
                          </td>
                        </tr>
                      );
                    });
                    })()}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <Label>{t("common.active")}</Label>
              <Switch checked={form?.isActive ?? true} onCheckedChange={v => setForm(f => ({ ...f, isActive: v }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setForm(null)}>{t("common.cancel")}</Button>
            <Button onClick={() => save.mutate(form!)} disabled={save.isPending || !form?.name || !form?.universityId}>{t("common.save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={delId !== null} onOpenChange={o => !o && setDelId(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>{t("catalogPage.deleteProgram")}</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">{t("catalogPage.confirmDeleteProgram")}</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDelId(null)}>{t("common.cancel")}</Button>
            <Button variant="destructive" onClick={() => del.mutate(delId!)} disabled={del.isPending}>{t("common.delete")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={translationProgram !== null} onOpenChange={open => !open && setTranslationProgram(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Languages className="h-5 w-5 text-primary" />
              {t("catalogPage.translationStatus")} · {translationProgram?.name}
            </DialogTitle>
          </DialogHeader>
          <div className="rounded-lg border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-3 py-2 text-left">{t("catalogPage.translationLanguage")}</th>
                  <th className="px-3 py-2 text-left">{t("common.status")}</th>
                  <th className="px-3 py-2 text-left">{t("catalogPage.translationAttempts")}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {translationDetails.isLoading && (
                  <tr><td colSpan={3} className="px-3 py-8 text-center"><Loader2 className="h-5 w-5 animate-spin mx-auto" /></td></tr>
                )}
                {translationDetails.data?.data.map((row: ProgramTranslationRow) => {
                  const meta = (LANGUAGE_META as Record<string, { flag: string; nativeName: string }>)[row.locale];
                  const statusLabel = row.status === "published"
                    ? t("catalogPage.translationPublished")
                    : row.status === "failed"
                      ? t("catalogPage.translationFailed")
                      : row.status === "stale_manual"
                        ? t("catalogPage.translationManualReview")
                        : t("catalogPage.translationPending");
                  return (
                    <tr key={row.locale}>
                      <td className="px-3 py-2.5 font-medium">{meta?.flag} {meta?.nativeName || row.locale.toUpperCase()}</td>
                      <td className="px-3 py-2.5">
                        <Badge variant="outline" className={row.status === "published"
                          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                          : row.status === "failed"
                            ? "border-red-200 bg-red-50 text-red-700"
                            : "border-amber-200 bg-amber-50 text-amber-700"}
                        >
                          {statusLabel}{row.isManual ? ` · ${t("catalogPage.translationManual")}` : ""}
                        </Badge>
                        {row.errorCode && <div className="mt-1 text-[11px] text-destructive font-mono">{row.errorCode}</div>}
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground">{row.attempts}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTranslationProgram(null)}>{t("common.close")}</Button>
            <Button
              onClick={() => translationProgram && retryTranslations.mutate(translationProgram.id)}
              disabled={!translationProgram || retryTranslations.isPending}
            >
              {retryTranslations.isPending
                ? <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                : <RefreshCw className="h-4 w-4 mr-2" />}
              {t("catalogPage.retryTranslations")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={bulkDelOpen} onOpenChange={o => !o && setBulkDelOpen(false)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>{t("catalogPage.bulkDelete")}</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">{t("catalogPage.confirmBulkDeletePrograms", { n: selected.size })}</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkDelOpen(false)}>{t("common.cancel")}</Button>
            <Button variant="destructive" onClick={handleBulkDelete} disabled={bulkDeleting}>
              {bulkDeleting ? t("catalogPage.deleting") : t("catalogPage.deleteNPrograms", { n: selected.size })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <BulkImportModal open={bulkOpen} onClose={() => setBulkOpen(false)} title={t("adminCatalog.tabPrograms")} templateRows={templateRows} notesRows={notesRows} onImport={handleBulkImport} />

      <Dialog open={delAllOpen} onOpenChange={o => !o && setDelAllOpen(false)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>{t("catalogPage.deleteAllPrograms")}</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">{t("catalogPage.confirmDeleteAllPrograms")}</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDelAllOpen(false)}>{t("common.cancel")}</Button>
            <Button variant="destructive" onClick={handleDeleteAll} disabled={delAllInProgress}>
              {delAllInProgress ? t("catalogPage.deleting") : t("catalogPage.deleteAllPrograms")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
    </>
  );
}

/* ═══════════════════════════════════════════════════════════
   OPTIONS TAB
══════════════════════════════════════════════════════════ */

type CatalogOptionMetadata = { label?: string; icon?: string; accept?: string } | null;
type CatalogOption = { id: number; category: string; value: string; sortOrder: number; isActive: boolean; metadata?: CatalogOptionMetadata };

const OPTION_CATEGORIES = [
  { key: "degree", labelKey: "catalogPage.optDegree", descKey: "catalogPage.optDegreeDesc" },
  { key: "language", labelKey: "catalogPage.optLanguage", descKey: "catalogPage.optLanguageDesc" },
  { key: "duration", labelKey: "catalogPage.optDuration", descKey: "catalogPage.optDurationDesc" },
  { key: "fee_type", labelKey: "catalogPage.optFeeType", descKey: "catalogPage.optFeeTypeDesc" },
  { key: "intake", labelKey: "catalogPage.optIntake", descKey: "catalogPage.optIntakeDesc" },
  { key: "field", labelKey: "catalogPage.optField", descKey: "catalogPage.optFieldDesc" },
  { key: "university_type", labelKey: "catalogPage.optUniversityType", descKey: "catalogPage.optUniversityTypeDesc" },
  { key: "documents", labelKey: "catalogPage.optDocuments", descKey: "catalogPage.optDocumentsDesc" },
  { key: "currency", labelKey: "catalogPage.optCurrency", descKey: "catalogPage.optCurrencyDesc" },
];

const OPTIONS_PANEL_CATEGORIES = [
  ...OPTION_CATEGORIES,
  {
    key: "public_catalog",
    labelKey: "adminCatalog.publicCatalogTitle",
    descKey: "adminCatalog.publicCatalogDesc",
  },
];


const PROGRAM_DOC_TYPE_KEYS = [
  "high_school_diploma_translation", "class_10th_ssc_marks_sheet",
  "class_12th_hsc_certificate", "class_12th_hsc_marks_sheet",
  "diploma_certificate", "diploma_transcript",
  "bachelors_certificate", "bachelors_transcript",
  "bachelors_provisional_certificate", "bachelors_transcript_all_semesters",
  "masters_certificate", "masters_transcript",
  "masters_provisional_certificate", "masters_transcript_all_semesters",
  "passport", "cv", "lor", "sop", "essay", "experience_letters",
  "other_certificates_documents", "ielts_pte_gre_gmat_toefl_duolingo",
  "photo", "diploma_recognition",
  // A. Akademik
  "portfolio", "research_proposal", "publication_list", "writing_sample",
  "subject_specific_test_score", "transcript_evaluation_report",
  "medium_of_instruction_letter", "predicted_grades",
  "gap_year_explanation_letter", "academic_reference_form",
  // B. Finansal
  "bank_statement", "financial_evidence_28_days", "financial_documents_3_months",
  "gic_certificate", "sponsor_letter", "affidavit_of_support",
  "sponsor_id_proof", "sponsor_relationship_proof", "sponsor_employment_letter",
  "sponsor_tax_returns", "scholarship_award_letter", "proof_of_tuition_payment",
  "education_loan_approval_letter", "fixed_deposit_receipt",
  // C. Sağlık
  "medical_examination_report", "hiv_test_certificate", "tb_test_certificate",
  "hepatitis_b_test", "hepatitis_c_test", "vaccination_record",
  "covid_vaccination_certificate", "panel_physician_medical_exam",
  "mental_health_clearance", "physical_fitness_certificate",
  // D. Vize ve Göçmenlik
  "visa_application_form", "i20_form", "ds160_confirmation", "sevis_fee_receipt",
  "cas_letter", "atas_certificate", "pal_tal_letter", "letter_of_acceptance_dli",
  "biometrics_appointment_receipt", "previous_visa_copies", "visa_refusal_history",
  "travel_history", "residence_permit", "police_clearance_certificate",
  "good_conduct_certificate",
  // E. Kimlik
  "birth_certificate", "national_id_card", "family_book", "marriage_certificate",
  "name_change_affidavit", "passport_size_photo_specifications",
  // F. Çalışma ve Ara Yıl
  "no_objection_certificate", "employer_letter", "work_experience_certificate",
  "internship_certificates", "professional_license", "business_registration",
  // G. Ülkeye Özel
  "military_status_document", "yos_score_report", "sat_score_report",
  "gaokao_score_report", "abitur_certificate", "a_level_certificate",
  "ib_diploma", "olympiad_certificates",
  // H. Konaklama ve Refakatçi
  "accommodation_proof", "custodian_declaration", "parental_consent",
  "dependents_documents",
  // I. Dil ve Beyan
  "ukvi_approved_english_test", "statement_of_finance", "personal_statement",
  "diversity_statement", "ai_usage_declaration", "gdpr_consent_form",
  "fraud_declaration",
] as const;

const DEGREE_DOC_TYPE_LABELS: Record<string, string> = {
  high_school_diploma_translation: "High School Diploma (Translation)",
  class_10th_ssc_marks_sheet: "Class 10th/SSC Marks Sheet",
  class_12th_hsc_certificate: "Class 12th/+2/HSC Certificate",
  class_12th_hsc_marks_sheet: "Class 12th/+2/HSC Marks Sheet",
  diploma_certificate: "Diploma Certificate",
  diploma_transcript: "Diploma Transcript",
  bachelors_certificate: "Bachelors Certificate",
  bachelors_transcript: "Bachelors Transcript",
  bachelors_provisional_certificate: "Bachelors Provisional Certificate",
  bachelors_transcript_all_semesters: "Bachelors Transcript (All Semesters)",
  masters_certificate: "Masters Certificate",
  masters_transcript: "Masters Transcript",
  masters_provisional_certificate: "Masters Provisional Certificate",
  masters_transcript_all_semesters: "Masters Transcript (All Semesters)",
  passport: "Passport",
  cv: "CV",
  lor: "LOR",
  sop: "SOP",
  essay: "Essay",
  experience_letters: "Experience Letters",
  other_certificates_documents: "Other Certificates/Documents",
  ielts_pte_gre_gmat_toefl_duolingo: "IELTS/PTE/GRE/GMAT/TOEFL/Duolingo",
  photo: "Photo",
  diploma_recognition: "Diploma Recognition",
  portfolio: "Portfolio",
  research_proposal: "Research Proposal",
  publication_list: "Publication List",
  writing_sample: "Writing Sample",
  subject_specific_test_score: "Subject-Specific Test Score (SAT/ACT/GRE/GMAT/LSAT/MCAT/BMAT)",
  transcript_evaluation_report: "Transcript Evaluation Report (WES/ENIC-NARIC)",
  medium_of_instruction_letter: "Medium of Instruction Letter",
  predicted_grades: "Predicted Grades (UK)",
  gap_year_explanation_letter: "Gap Year Explanation Letter",
  academic_reference_form: "Academic Reference Form",
  bank_statement: "Bank Statement",
  financial_evidence_28_days: "Financial Evidence (28 Days, UK)",
  financial_documents_3_months: "Financial Documents (3 Months, USA)",
  gic_certificate: "GIC Certificate (Canada SDS)",
  sponsor_letter: "Sponsor Letter",
  affidavit_of_support: "Affidavit of Support (I-134/I-864)",
  sponsor_id_proof: "Sponsor ID / Passport",
  sponsor_relationship_proof: "Sponsor Relationship Proof",
  sponsor_employment_letter: "Sponsor Employment Letter",
  sponsor_tax_returns: "Sponsor Tax Returns",
  scholarship_award_letter: "Scholarship Award Letter",
  proof_of_tuition_payment: "Proof of Tuition Payment",
  education_loan_approval_letter: "Education Loan Approval Letter",
  fixed_deposit_receipt: "Fixed Deposit Receipt",
  medical_examination_report: "Medical Examination Report",
  hiv_test_certificate: "HIV Test Certificate",
  tb_test_certificate: "TB Test Certificate",
  hepatitis_b_test: "Hepatitis B Test",
  hepatitis_c_test: "Hepatitis C Test",
  vaccination_record: "Vaccination Record",
  covid_vaccination_certificate: "COVID-19 Vaccination Certificate",
  panel_physician_medical_exam: "Panel Physician Medical Exam (Canada)",
  mental_health_clearance: "Mental Health Clearance",
  physical_fitness_certificate: "Physical Fitness Certificate",
  visa_application_form: "Visa Application Form",
  i20_form: "I-20 Form (USA F-1)",
  ds160_confirmation: "DS-160 Confirmation (USA)",
  sevis_fee_receipt: "SEVIS I-901 Fee Receipt",
  cas_letter: "CAS Letter (UK)",
  atas_certificate: "ATAS Certificate (UK)",
  pal_tal_letter: "PAL / TAL Letter (Canada)",
  letter_of_acceptance_dli: "Letter of Acceptance from DLI (Canada)",
  biometrics_appointment_receipt: "Biometrics Appointment Receipt",
  previous_visa_copies: "Previous Visa Copies",
  visa_refusal_history: "Visa Refusal History / Explanation",
  travel_history: "Travel History",
  residence_permit: "Residence Permit",
  police_clearance_certificate: "Police Clearance Certificate",
  good_conduct_certificate: "Good Conduct Certificate",
  birth_certificate: "Birth Certificate",
  national_id_card: "National ID Card",
  family_book: "Family Book",
  marriage_certificate: "Marriage Certificate",
  name_change_affidavit: "Name Change Affidavit",
  passport_size_photo_specifications: "Passport-Size Photo (Spec-Compliant)",
  no_objection_certificate: "No Objection Certificate (NOC)",
  employer_letter: "Employer Letter",
  work_experience_certificate: "Work Experience Certificate",
  internship_certificates: "Internship Certificates",
  professional_license: "Professional License",
  business_registration: "Business Registration",
  military_status_document: "Military Status Document (Türkiye)",
  yos_score_report: "YÖS Score Report (Türkiye)",
  sat_score_report: "SAT Score Report",
  gaokao_score_report: "Gaokao Score Report (China)",
  abitur_certificate: "Abitur Certificate (Germany)",
  a_level_certificate: "A-Level Certificate (UK)",
  ib_diploma: "IB Diploma",
  olympiad_certificates: "Olympiad Certificates",
  accommodation_proof: "Accommodation Proof",
  custodian_declaration: "Custodian Declaration",
  parental_consent: "Parental Consent",
  dependents_documents: "Dependents' Documents",
  ukvi_approved_english_test: "UKVI-Approved English Test",
  statement_of_finance: "Statement of Finance",
  personal_statement: "Personal Statement",
  diversity_statement: "Diversity Statement",
  ai_usage_declaration: "AI Usage Declaration",
  gdpr_consent_form: "GDPR Consent Form",
  fraud_declaration: "Fraud Declaration",
};
type DeleteBlockedDocPayload = {
  message?: string;
  category: "documents";
  value: string;
  programs: { id: number; name: string; universityName: string; mandatory: boolean }[];
  degrees: { id: number; value: string; mandatory: boolean }[];
  totals: { programs: number; degrees: number; total: number };
};
type DeleteBlockedDegreePayload = {
  message?: string;
  category: "degree";
  value: string;
  documents: { documentType: string; mandatory: boolean; sortOrder: number }[];
  totals: { documents: number };
};
type DeleteBlockedCurrencyPayload = {
  message?: string;
  category: "currency";
  value: string;
  usage: { programs: number; commissions: number; serviceFees: number; total: number };
};
type DeleteBlockedPayload = DeleteBlockedDocPayload | DeleteBlockedDegreePayload | DeleteBlockedCurrencyPayload;

function OptionsTab() {
  const { t } = useI18n();
  const { toast } = useToast();
  const [activeCategory, setActiveCategory] = useState(OPTIONS_PANEL_CATEGORIES[0].key);
  const [editItem, setEditItem] = useState<CatalogOption | null>(null);
  const [newValue, setNewValue] = useState("");
  const [addMode, setAddMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [docsForOption, setDocsForOption] = useState<CatalogOption | null>(null);
  const [docMetaItem, setDocMetaItem] = useState<CatalogOption | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<CatalogOption | null>(null);
  const [deleteBlocked, setDeleteBlocked] = useState<DeleteBlockedPayload | null>(null);
  const [orphanModalOpen, setOrphanModalOpen] = useState(false);
  const qc = useQueryClient();

  const { data: optionsResp, isLoading } = useQuery({
    queryKey: ["catalog-options"],
    queryFn: () => api("/api/catalog-options"),
  });

  const grouped: Record<string, CatalogOption[]> = (optionsResp as any)?.grouped || {};
  const items = grouped[activeCategory] || [];
  const catMeta = OPTIONS_PANEL_CATEGORIES.find(c => c.key === activeCategory)!;
  const catLabel = t(catMeta.labelKey);
  const isPublicCatalog = activeCategory === "public_catalog";

  async function handleAdd() {
    const trimmed = newValue.trim();
    if (!trimmed) return;
    const duplicate = items.some(o => o.value.trim().toLowerCase() === trimmed.toLowerCase());
    if (duplicate) {
      toast({ title: t("catalogPage.duplicateValue"), description: t("catalogPage.duplicateValueDesc", { value: trimmed, category: catLabel }), variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const created: any = await api("/api/catalog-options", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: activeCategory, value: trimmed, sortOrder: items.length + 1 }),
      });
      setNewValue("");
      setAddMode(false);
      qc.invalidateQueries({ queryKey: ["catalog-options"] });
      qc.invalidateQueries({ queryKey: ["catalog-options", "degree"] });
      toast({ title: t("catalogPage.added"), description: t("catalogPage.addedDesc", { value: trimmed, category: catLabel }) });
    } catch (err: any) {
      toast({ title: t("catalogPage.addFailed"), description: err?.message || t("catalogPage.tryAgain"), variant: "destructive" });
    }
    setSaving(false);
  }

  async function handleUpdate(item: CatalogOption, updates: Partial<CatalogOption>) {
    try {
      await api(`/api/catalog-options/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      qc.invalidateQueries({ queryKey: ["catalog-options"] });
      setEditItem(null);
      toast({ title: t("common.saved"), description: t("catalogPage.optionUpdated", { category: catLabel }) });
    } catch (err: any) {
      toast({ title: t("catalogPage.updateFailed"), description: err?.message || t("catalogPage.tryAgain"), variant: "destructive" });
    }
  }

  async function handleDelete(item: CatalogOption) {
    // We bypass the throw-on-error `api()` helper so we can inspect the
    // structured 409 payload the backend returns when a delete is blocked
    // by existing program/degree references.
    try {
      const r = await apiFetch(`/api/catalog-options/${item.id}`, { method: "DELETE" });
      if (r.status === 409) {
        const body = await r.json().catch(() => null) as DeleteBlockedPayload | null;
        if (body && (body.category === "documents" || body.category === "degree" || body.category === "currency")) {
          setDeleteBlocked(body);
          setConfirmDelete(null);
          return;
        }
        toast({ title: t("catalogPage.couldNotDelete"), description: t("catalogPage.recordInUse"), variant: "destructive" });
        return;
      }
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        throw new Error(text || `HTTP ${r.status}`);
      }
      qc.invalidateQueries({ queryKey: ["catalog-options"] });
      qc.invalidateQueries({ queryKey: ["catalog-orphans"] });
      qc.invalidateQueries({ queryKey: ["document-type-catalog"] });
      setConfirmDelete(null);
      toast({ title: t("catalogPage.deleted"), description: t("catalogPage.removedFromList", { category: catLabel }) });
    } catch (err: any) {
      toast({ title: t("catalogPage.deleteFailed"), description: err?.message || t("catalogPage.tryAgain"), variant: "destructive" });
    }
  }

  if (isLoading) return <div className="flex items-center justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>;

  return (
    <>
    <div className="grid grid-cols-1 md:grid-cols-[240px_1fr] gap-4">
      <div className="space-y-1">
        {OPTIONS_PANEL_CATEGORIES.map(cat => (
          <button
            key={cat.key}
            onClick={() => { setActiveCategory(cat.key); setAddMode(false); setEditItem(null); }}
            className={`w-full text-left px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${cat.key === "public_catalog" ? "mt-3 border-t pt-4" : ""} ${activeCategory === cat.key ? "bg-primary/10 text-primary" : "hover:bg-muted text-muted-foreground hover:text-foreground"}`}
          >
            {t(cat.labelKey)}
            {cat.key !== "public_catalog" && (
              <span className="ml-2 text-xs opacity-60">({(grouped[cat.key] || []).length})</span>
            )}
          </button>
        ))}
      </div>

      {isPublicCatalog ? (
        <div className="rounded-lg border p-4">
          <div className="mb-4 border-b pb-3">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <Eye className="h-4 w-4 text-primary" />
              {catLabel}
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">{t(catMeta.descKey)}</p>
          </div>
          <PublicCatalogSettingsTab />
        </div>
      ) : (
      <div className="border rounded-lg">
        <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/30">
          <div>
            <h3 className="text-sm font-semibold">{catLabel}</h3>
            <p className="text-xs text-muted-foreground">{t(catMeta.descKey)}</p>
          </div>
          <div className="flex items-center gap-2">
            {activeCategory === "documents" && (
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  try {
                    const r = await apiFetch("/api/programs/import-template");
                    if (!r.ok) {
                      const txt = await r.text().catch(() => "");
                      throw new Error(txt || `HTTP ${r.status}`);
                    }
                    const blob = await r.blob();
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `programs_template_${new Date().toISOString().slice(0, 10)}.xlsx`;
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    URL.revokeObjectURL(url);
                    toast({ title: t("catalogPage.templateDownloaded"), description: t("catalogPage.templateReady") });
                  } catch (err: any) {
                    toast({
                      title: t("catalogPage.templateDownloadFailed"),
                      description: err?.message || t("catalogPage.tryAgain"),
                      variant: "destructive",
                    });
                  }
                }}
              >
                <Download className="w-4 h-4 mr-1" /> {t("catalogPage.downloadProgramTemplate")}
              </Button>
            )}
            <Button size="sm" onClick={() => { setAddMode(true); setNewValue(""); }} disabled={addMode}>
              <Plus className="w-4 h-4 mr-1" /> {t("common.add")}
            </Button>
          </div>
        </div>

        {addMode && (
          <div className="flex items-center gap-2 px-4 py-3 border-b bg-green-50/50">
            <Input
              autoFocus
              value={newValue}
              onChange={e => setNewValue(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") handleAdd(); if (e.key === "Escape") setAddMode(false); }}
              placeholder={t("catalogPage.enterNewValue", { category: catLabel.toLowerCase() })}
              className="flex-1"
            />
            <Button size="sm" onClick={handleAdd} disabled={saving || !newValue.trim()}>
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAddMode(false)}>
              <X className="w-4 h-4" />
            </Button>
          </div>
        )}

        <div className="divide-y">
          {items.length === 0 && !addMode && (
            <p className="text-center text-muted-foreground text-sm py-8">{t("catalogPage.noOptionsYet")}</p>
          )}
          {items.map((item, idx) => {
            const isDoc = activeCategory === "documents";
            const docLabel = isDoc ? (item.metadata?.label || item.value) : item.value;
            const docIcon = isDoc ? (item.metadata?.icon || "📄") : null;
            const docAccept = isDoc ? (item.metadata?.accept || ".pdf,.jpg,.jpeg,.png") : null;
            return (
            <div key={item.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/30 group">
              <span className="text-xs text-muted-foreground w-6 text-center">{idx + 1}</span>
              {isDoc && docIcon && <span className="text-lg leading-none w-6 text-center shrink-0">{docIcon}</span>}
              {editItem?.id === item.id ? (
                <Input
                  autoFocus
                  className="flex-1 h-8"
                  value={editItem.value}
                  onChange={e => setEditItem({ ...editItem, value: e.target.value })}
                  onKeyDown={e => {
                    if (e.key === "Enter") handleUpdate(item, { value: editItem.value });
                    if (e.key === "Escape") setEditItem(null);
                  }}
                />
              ) : (
                <span className={`flex-1 text-sm ${!item.isActive ? "line-through text-muted-foreground" : ""}`}>
                  {docLabel}
                  {isDoc && docLabel !== item.value && (
                    <span className="ml-2 text-[10px] text-muted-foreground font-mono">{item.value}</span>
                  )}
                </span>
              )}
              {isDoc && docAccept && (
                <Badge variant="outline" className="text-[10px] font-mono text-muted-foreground">{docAccept}</Badge>
              )}
              {!item.isActive && <Badge variant="outline" className="text-[10px] bg-muted">{t("common.inactive")}</Badge>}
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                {editItem?.id === item.id ? (
                  <>
                    <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => handleUpdate(item, { value: editItem.value })}><Check className="w-3.5 h-3.5 text-green-600" /></Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setEditItem(null)}><X className="w-3.5 h-3.5" /></Button>
                  </>
                ) : (
                  <>
                    {activeCategory === "degree" && (
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs gap-1" onClick={() => setDocsForOption(item)}>
                        <FileText className="w-3.5 h-3.5" /> {t("catalogPage.documents")}
                      </Button>
                    )}
                    {isDoc && (
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs gap-1" onClick={() => setDocMetaItem(item)}>
                        <Settings2 className="w-3.5 h-3.5" /> {t("catalogPage.meta")}
                      </Button>
                    )}
                    <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setEditItem({ ...item })}><Pencil className="w-3.5 h-3.5" /></Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => handleUpdate(item, { isActive: !item.isActive })}>
                      {item.isActive ? <Lock className="w-3.5 h-3.5 text-orange-500" /> : <Check className="w-3.5 h-3.5 text-green-600" />}
                    </Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setConfirmDelete(item)}><Trash2 className="w-3.5 h-3.5 text-destructive" /></Button>
                  </>
                )}
              </div>
            </div>
            );
          })}
        </div>
      </div>
      )}
    </div>
    {docsForOption && (
      <DegreeDocsDialog option={docsForOption} onClose={() => setDocsForOption(null)} />
    )}
    {docMetaItem && (
      <DocumentMetaDialog option={docMetaItem} onClose={() => setDocMetaItem(null)} />
    )}
    {activeCategory === "documents" && (
      <OrphanDocumentsCard
        open={orphanModalOpen}
        setOpen={setOrphanModalOpen}
      />
    )}
    <DeleteCatalogOptionDialog
      item={confirmDelete}
      onCancel={() => setConfirmDelete(null)}
      onConfirm={() => confirmDelete && handleDelete(confirmDelete)}
    />
    <DeleteBlockedDialog payload={deleteBlocked} onClose={() => setDeleteBlocked(null)} />
    </>
  );
}

function DeleteCatalogOptionDialog({ item, onCancel, onConfirm }: {
  item: CatalogOption | null; onCancel: () => void; onConfirm: () => void;
}) {
  const { t } = useI18n();
  const isDoc = item?.category === "documents";
  const isDegree = item?.category === "degree";
  const label = isDoc ? t("catalogPage.docTypeAccusative") : isDegree ? t("catalogPage.degreeAccusative") : t("catalogPage.optionAccusative");
  // Proactive usage preview: only fetched when the option is documents/degree
  // (the only two categories that can be blocked server-side). Saves the
  // admin from clicking Delete just to learn it's in use.
  const { data: usage, isLoading: usageLoading } = useQuery<{
    totals?: { total?: number; programs?: number; degrees?: number; documents?: number };
  }>({
    queryKey: ["catalog-options", item?.id, "usage"],
    queryFn: () => api(`/api/catalog-options/${item!.id}/usage`),
    enabled: !!item && (isDoc || isDegree),
    staleTime: 0,
  });
  const blockedCount = isDoc
    ? (usage?.totals?.total ?? 0)
    : isDegree
      ? (usage?.totals?.documents ?? 0)
      : 0;
  const willBeBlocked = (isDoc || isDegree) && blockedCount > 0;
  return (
    <Dialog open={item !== null} onOpenChange={o => !o && onCancel()}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>{t("catalogPage.deleteConfirmation")}</DialogTitle></DialogHeader>
        <div className="text-sm text-muted-foreground space-y-2">
          <p>{t("catalogPage.confirmDeleteOption", { value: item?.value ?? "", label })}</p>
          {(isDoc || isDegree) && (
            usageLoading ? (
              <p className="text-xs flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" /> {t("catalogPage.checkingUsage")}</p>
            ) : willBeBlocked ? (
              <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                <div className="flex items-center gap-1.5 font-medium">
                  <AlertTriangle className="h-3.5 w-3.5" /> {isDoc ? t("catalogPage.recordUsedInPrograms", { programs: usage?.totals?.programs ?? 0, degrees: usage?.totals?.degrees ?? 0 }) : t("catalogPage.recordUsedInDocs", { count: blockedCount })}
                </div>
                <p className="mt-1">{t("catalogPage.deleteWillBeBlocked")}</p>
              </div>
            ) : (
              <p className="text-xs">{t("catalogPage.noActiveUsage")}</p>
            )
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>{t("common.cancel")}</Button>
          <Button variant="destructive" onClick={onConfirm} disabled={usageLoading}>{t("common.delete")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteBlockedDialog({ payload, onClose }: {
  payload: DeleteBlockedPayload | null; onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog open={payload !== null} onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            {t("catalogPage.deleteBlocked")}
          </DialogTitle>
        </DialogHeader>
        {payload && (
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              {payload.message || t("catalogPage.deleteBlockedDefault")}
            </p>
            <p>
              <span className="text-muted-foreground">{t("catalogPage.keyLabel")}</span>{" "}
              <code className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded">{payload.value}</code>
            </p>
            {payload.category === "documents" && (
              <>
                {payload.programs.length > 0 && (
                  <div>
                    <p className="font-medium mb-1.5">{t("catalogPage.programsCount", { n: payload.programs.length })}</p>
                    <div className="max-h-48 overflow-auto rounded border bg-muted/30 divide-y">
                      {payload.programs.slice(0, 50).map(p => (
                        <a
                          key={p.id}
                          href={`/admin/programs?focus=${p.id}`}
                          className="flex items-center justify-between px-3 py-1.5 text-xs hover:bg-muted/60"
                          title={t("catalogPage.goToProgram")}
                        >
                          <span className="truncate text-blue-600 hover:underline">
                            <span className="text-muted-foreground">{p.universityName}</span> — {p.name}
                          </span>
                          <Badge variant={p.mandatory ? "default" : "secondary"} className="ml-2 shrink-0 text-[10px]">
                            {p.mandatory ? t("catalogPage.badgeMandatory") : t("catalogPage.badgeOptional")}
                          </Badge>
                        </a>
                      ))}
                      {payload.programs.length > 50 && (
                        <div className="px-3 py-1.5 text-[10px] text-muted-foreground italic">
                          {t("catalogPage.moreProgramsCount", { n: payload.programs.length - 50 })}
                        </div>
                      )}
                    </div>
                  </div>
                )}
                {payload.degrees.length > 0 && (
                  <div>
                    <p className="font-medium mb-1.5">{t("catalogPage.academicDegreesCount", { n: payload.degrees.length })}</p>
                    <div className="rounded border bg-muted/30 divide-y">
                      {payload.degrees.map(d => (
                        <a
                          key={d.id}
                          href={`/admin/catalog?tab=options&category=degree&focus=${d.id}`}
                          className="flex items-center justify-between px-3 py-1.5 text-xs hover:bg-muted/60"
                          title={t("catalogPage.goToDegree")}
                        >
                          <span className="text-blue-600 hover:underline">{d.value}</span>
                          <Badge variant={d.mandatory ? "default" : "secondary"} className="text-[10px]">
                            {d.mandatory ? t("catalogPage.badgeMandatory") : t("catalogPage.badgeOptional")}
                          </Badge>
                        </a>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
            {payload.category === "currency" && (
              <div>
                <p className="font-medium mb-1.5">{t("catalogPage.usageLocationsCount", { n: payload.usage.total })}</p>
                <div className="rounded border bg-muted/30 divide-y">
                  {payload.usage.programs > 0 && (
                    <div className="flex items-center justify-between px-3 py-1.5 text-xs">
                      <span>{t("catalogPage.usagePrograms")}</span>
                      <Badge variant="secondary" className="text-[10px]">{payload.usage.programs}</Badge>
                    </div>
                  )}
                  {payload.usage.commissions > 0 && (
                    <div className="flex items-center justify-between px-3 py-1.5 text-xs">
                      <span>{t("catalogPage.usageCommissions")}</span>
                      <Badge variant="secondary" className="text-[10px]">{payload.usage.commissions}</Badge>
                    </div>
                  )}
                  {payload.usage.serviceFees > 0 && (
                    <div className="flex items-center justify-between px-3 py-1.5 text-xs">
                      <span>{t("catalogPage.usageServiceFees")}</span>
                      <Badge variant="secondary" className="text-[10px]">{payload.usage.serviceFees}</Badge>
                    </div>
                  )}
                </div>
              </div>
            )}
            {payload.category === "degree" && (
              <div>
                <p className="font-medium mb-1.5">{t("catalogPage.docReqsForDegreeCount", { n: payload.documents.length })}</p>
                <div className="max-h-48 overflow-auto rounded border bg-muted/30 divide-y">
                  {payload.documents.map(d => (
                    <div key={d.documentType} className="flex items-center justify-between px-3 py-1.5 text-xs">
                      <code className="font-mono">{d.documentType}</code>
                      <Badge variant={d.mandatory ? "default" : "secondary"} className="text-[10px]">
                        {d.mandatory ? t("catalogPage.badgeMandatory") : t("catalogPage.badgeOptional")}
                      </Badge>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <p className="text-xs text-muted-foreground border-t pt-3">
              {t("catalogPage.removeFromAboveToDelete")}
            </p>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("common.close")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type OrphanRow = { documentType: string; programCount: number; degreeCount: number; total: number };

function OrphanDocumentsCard({ open, setOpen }: { open: boolean; setOpen: (o: boolean) => void }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<{ orphans: OrphanRow[] }>({
    queryKey: ["catalog-orphans", "documents"],
    queryFn: () => api("/api/catalog-options/orphans?category=documents"),
  });
  const orphans = data?.orphans || [];
  const [busy, setBusy] = useState<string | null>(null);

  async function act(documentType: string, action: "delete_refs" | "restore_to_catalog") {
    setBusy(documentType);
    try {
      const res = await api("/api/catalog-options/orphans/cleanup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentType, action }),
      });
      qc.invalidateQueries({ queryKey: ["catalog-orphans"] });
      qc.invalidateQueries({ queryKey: ["catalog-options"] });
      qc.invalidateQueries({ queryKey: ["document-type-catalog"] });
      if (action === "delete_refs") {
        toast({ title: t("catalogPage.orphanRefsCleared"), description: t("catalogPage.orphanRefsClearedDesc", { dt: documentType, n: res?.removed ?? 0 }) });
      } else {
        toast({ title: t("catalogPage.orphanRestored"), description: t("catalogPage.orphanRestoredDesc", { dt: documentType }) });
      }
    } catch (err: any) {
      toast({ title: t("catalogPage.operationFailed"), description: err?.message || t("catalogPage.tryAgain"), variant: "destructive" });
    }
    setBusy(null);
  }

  return (
    <>
      {orphans.length > 0 && (
        <div className="md:col-span-2 -mt-2">
          <div className="flex items-center justify-between rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm">
            <div className="flex items-center gap-2 text-amber-900">
              <AlertTriangle className="h-4 w-4" />
              <span><strong>{orphans.length}</strong> {t("catalogPage.orphanBannerText")}</span>
            </div>
            <Button size="sm" variant="outline" className="border-amber-400 text-amber-900 hover:bg-amber-100" onClick={() => setOpen(true)}>
              {t("catalogPage.review")}
            </Button>
          </div>
        </div>
      )}
      <Dialog open={open} onOpenChange={o => !o && setOpen(false)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              {t("catalogPage.orphanTitle")}
            </DialogTitle>
            <p className="text-xs text-muted-foreground">
              {t("catalogPage.orphanDesc")}
            </p>
          </DialogHeader>
          {isLoading ? (
            <div className="flex items-center justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : orphans.length === 0 ? (
            <p className="text-center text-sm text-muted-foreground py-8">{t("catalogPage.noOrphans")}</p>
          ) : (
            <div className="rounded-lg border divide-y max-h-[60vh] overflow-auto">
              {orphans.map(o => (
                <div key={o.documentType} className="flex items-center gap-2 px-3 py-2 text-sm">
                  <code className="flex-1 font-mono text-xs truncate">{o.documentType}</code>
                  <Badge variant="outline" className="text-[10px]">
                    {t("catalogPage.orphanUsage", { p: o.programCount, d: o.degreeCount })}
                  </Badge>
                  <Button
                    size="sm" variant="outline" className="h-7 text-xs"
                    disabled={busy === o.documentType}
                    onClick={() => act(o.documentType, "restore_to_catalog")}
                  >
                    {t("catalogPage.addToCatalog")}
                  </Button>
                  <Button
                    size="sm" variant="destructive" className="h-7 text-xs"
                    disabled={busy === o.documentType}
                    onClick={() => act(o.documentType, "delete_refs")}
                  >
                    {busy === o.documentType ? <Loader2 className="h-3 w-3 animate-spin" /> : t("catalogPage.deleteRefs")}
                  </Button>
                </div>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>{t("common.close")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function DocumentMetaDialog({ option, onClose }: { option: CatalogOption; onClose: () => void }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const qc = useQueryClient();
  const md = option.metadata || {};
  const [label, setLabel] = useState<string>(typeof md.label === "string" ? md.label : "");
  const [icon, setIcon] = useState<string>(typeof md.icon === "string" ? md.icon : "📄");
  const [accept, setAccept] = useState<string>(typeof md.accept === "string" ? md.accept : ".pdf,.jpg,.jpeg,.png");
  const [saving, setSaving] = useState(false);
  async function save() {
    setSaving(true);
    try {
      await api(`/api/catalog-options/${option.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ metadata: { label: label.trim() || option.value, icon: icon.trim() || "📄", accept: accept.trim() || ".pdf,.jpg,.jpeg,.png" } }),
      });
      qc.invalidateQueries({ queryKey: ["catalog-options"] });
      qc.invalidateQueries({ queryKey: ["document-type-catalog"] });
      toast({ title: t("catalogPage.metaSaved"), description: t("catalogPage.metaSavedDesc") });
      onClose();
    } catch (err: any) {
      toast({ title: t("catalogPage.metaSaveFailed"), description: err?.message || t("catalogPage.tryAgain"), variant: "destructive" });
    }
    setSaving(false);
  }
  return (
    <Dialog open onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("catalogPage.docMetaTitle", { value: option.value })}</DialogTitle>
          <p className="text-xs text-muted-foreground">{t("catalogPage.docMetaDesc")}</p>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div>
            <Label className="text-xs">{t("catalogPage.displayNameLabel")}</Label>
            <Input value={label} onChange={e => setLabel(e.target.value)} placeholder={t("catalogPage.egPassport")} className="h-9 text-sm" />
          </div>
          <div>
            <Label className="text-xs">{t("catalogPage.iconEmojiLabel")}</Label>
            <Input value={icon} onChange={e => setIcon(e.target.value)} maxLength={4} placeholder="📄" className="h-9 text-sm w-20" />
          </div>
          <div>
            <Label className="text-xs">{t("catalogPage.acceptedExtensionsLabel")}</Label>
            <Input value={accept} onChange={e => setAccept(e.target.value)} placeholder=".pdf,.jpg,.jpeg,.png" className="h-9 text-sm font-mono" />
            <p className="text-[10px] text-muted-foreground mt-1">{t("catalogPage.extensionsHint")}</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
          <Button onClick={save} disabled={saving}>{saving ? t("common.saving") : t("common.save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DegreeDocsDialog({ option, onClose }: { option: CatalogOption; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Dialog open onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{t("catalogPage.requiredDocsTitle", { value: option.value })}</DialogTitle>
          <p className="text-xs text-muted-foreground">
            {t("catalogPage.degreeDocsHelp")}
          </p>
        </DialogHeader>
        <DegreeDocsEditor option={option} onSaved={onClose} variant="dialog" />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("common.close")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DegreeDocsEditor({ option, onSaved, variant = "inline" }: { option: CatalogOption; onSaved?: () => void; variant?: "inline" | "dialog" }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [docReqs, setDocReqs] = useState<Record<string, "none" | "optional" | "mandatory">>({});
  const [order, setOrder] = useState<string[]>([]);
  const [docSearch, setDocSearch] = useState("");
  const [saving, setSaving] = useState(false);
  // Pull the master document catalog (admin-managed). Falls back to the
  // hardcoded PROGRAM_DOC_TYPE_KEYS / DEGREE_DOC_TYPE_LABELS only if the
  // catalog API returns nothing.
  const { data: docCatalog } = useDocumentTypeCatalog();
  const catalogKeys = useMemo(() => {
    if (docCatalog && Object.keys(docCatalog).length > 0) return Object.keys(docCatalog);
    return PROGRAM_DOC_TYPE_KEYS;
  }, [docCatalog]);
  const labelFor = (dt: string) =>
    docCatalog?.[dt]?.label ?? DEGREE_DOC_TYPE_LABELS[dt] ?? dt;

  const { data: existing, isLoading } = useQuery<{ documentType: string; mandatory: boolean; sortOrder: number }[]>({
    queryKey: ["catalog-option-doc-reqs", option.id],
    queryFn: () => api(`/api/catalog-options/${option.id}/document-requirements`),
  });

  useEffect(() => {
    if (!existing) return;
    const next: Record<string, "none" | "optional" | "mandatory"> = {};
    const sorted = [...existing].sort((a, b) => a.sortOrder - b.sortOrder);
    for (const r of sorted) next[r.documentType] = r.mandatory ? "mandatory" : "optional";
    setDocReqs(next);
    setOrder(sorted.map(r => r.documentType));
  }, [existing]);

  function setLevel(dt: string, opt: "none" | "optional" | "mandatory") {
    setDocReqs(prev => ({ ...prev, [dt]: opt }));
    setOrder(prev => {
      const inList = prev.includes(dt);
      if (opt === "none") return inList ? prev.filter(x => x !== dt) : prev;
      return inList ? prev : [...prev, dt];
    });
  }

  function move(dt: string, dir: -1 | 1) {
    setOrder(prev => {
      const i = prev.indexOf(dt);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  async function handleSave() {
    setSaving(true);
    try {
      const ordered = order
        .filter(dt => (docReqs[dt] ?? "none") !== "none")
        .map((dt, idx) => ({ documentType: dt, mandatory: docReqs[dt] === "mandatory", sortOrder: idx }));
      await api(`/api/catalog-options/${option.id}/document-requirements`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requirements: ordered }),
      });
      qc.invalidateQueries({ queryKey: ["catalog-option-doc-reqs", option.id] });
      qc.invalidateQueries({ queryKey: ["degree-doc-reqs", option.value] });
      toast({ title: t("catalogPage.docReqsSaved"), description: t("catalogPage.docReqsSavedDesc", { value: option.value }) });
      onSaved?.();
    } catch (err: any) {
      toast({ title: t("catalogPage.docReqsSaveFailed"), description: err?.message || t("catalogPage.tryAgain"), variant: "destructive" });
    }
    setSaving(false);
  }

  const matchesSearch = (dt: string) => {
    if (!docSearch.trim()) return true;
    const q = docSearch.toLowerCase();
    return dt.toLowerCase().includes(q) || labelFor(dt).toLowerCase().includes(q);
  };

  const selectedKeys = order.filter(dt => (docReqs[dt] ?? "none") !== "none" && matchesSearch(dt));
  const selectedSet = new Set(order.filter(dt => (docReqs[dt] ?? "none") !== "none"));
  const availableKeys = catalogKeys.filter(dt => !selectedSet.has(dt) && matchesSearch(dt));

  const [dragKey, setDragKey] = useState<string | null>(null);

  function moveTo(dt: string, targetDt: string) {
    setOrder(prev => {
      const from = prev.indexOf(dt);
      const to = prev.indexOf(targetDt);
      if (from < 0 || to < 0 || from === to) return prev;
      const next = [...prev];
      const [removed] = next.splice(from, 1);
      next.splice(to, 0, removed);
      return next;
    });
  }

  return (
    <div className={cn("flex flex-col gap-3 min-h-0", variant === "dialog" ? "flex-1 overflow-hidden" : "flex-1 overflow-hidden")}>
      {variant === "inline" && (
        <div className="flex items-center justify-between gap-3 pb-2 border-b">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold truncate">{t("catalogPage.docsForDegreeTitle", { value: option.value })}</h3>
            <p className="text-[11px] text-muted-foreground">
              {t("catalogPage.docsForDegreeDesc")}
            </p>
          </div>
          <Button size="sm" onClick={handleSave} disabled={saving || isLoading}>
            {saving ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Check className="w-4 h-4 mr-1" />}
            {saving ? t("common.saving") : t("common.save")}
          </Button>
        </div>
      )}
      {isLoading ? (
        <div className="flex items-center justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
      ) : (
        <div className="flex-1 overflow-hidden flex flex-col gap-3">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">
                <strong className="text-foreground">{selectedSet.size}</strong> {t("catalogPage.selectedDocsLabel")}
              </span>
            </div>
            <Input
              value={docSearch}
              onChange={e => setDocSearch(e.target.value)}
              placeholder={t("catalogPage.searchDocs")}
              className="h-8 text-xs"
            />

            <div className="flex-1 overflow-y-auto flex flex-col gap-3">
              {/* Selected (ordered) */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <p className="text-[11px] font-bold uppercase tracking-wider text-foreground">
                    {t("catalogPage.selectedDocsOrder", { n: selectedKeys.length })}
                  </p>
                  <p className="text-[10px] text-muted-foreground">{t("catalogPage.dragHint1")} <GripVertical className="inline h-3 w-3" /> {t("catalogPage.dragHint2")}</p>
                </div>
                <div className="rounded-lg border-2 border-dashed border-primary/30 bg-primary/5 min-h-[60px] divide-y divide-border">
                  {selectedKeys.length === 0 ? (
                    <div className="text-[11px] text-muted-foreground text-center py-4 px-3">
                      {t("catalogPage.noDocsAddedYet")}
                    </div>
                  ) : selectedKeys.map((dt, i) => (
                    <div
                      key={dt}
                      draggable
                      onDragStart={() => setDragKey(dt)}
                      onDragOver={(e) => { e.preventDefault(); }}
                      onDrop={(e) => {
                        e.preventDefault();
                        if (dragKey && dragKey !== dt) moveTo(dragKey, dt);
                        setDragKey(null);
                      }}
                      onDragEnd={() => setDragKey(null)}
                      className={cn(
                        "flex items-center gap-2 px-2 py-1.5 bg-background hover:bg-muted/30 transition-colors",
                        dragKey === dt && "opacity-40"
                      )}
                    >
                      <GripVertical className="h-4 w-4 text-muted-foreground cursor-grab shrink-0" />
                      <span className="inline-block w-6 text-[11px] font-semibold text-muted-foreground tabular-nums shrink-0">{i + 1}.</span>
                      <span className="flex-1 text-xs break-words">{labelFor(dt)}</span>
                      <button
                        type="button"
                        onClick={() => setLevel(dt, docReqs[dt] === "mandatory" ? "optional" : "mandatory")}
                        title={docReqs[dt] === "mandatory" ? t("catalogPage.badgeOptional") : t("catalogPage.badgeMandatory")}
                        className={cn(
                          "shrink-0 px-2 py-0.5 text-[11px] rounded-full border font-medium transition-colors",
                          docReqs[dt] === "mandatory"
                            ? "bg-red-50 text-red-600 border-red-200 hover:bg-red-100 dark:bg-red-950 dark:text-red-400 dark:border-red-800"
                            : "bg-muted text-muted-foreground border-border hover:bg-primary/10 hover:text-primary hover:border-primary/30"
                        )}
                      >
                        {docReqs[dt] === "mandatory" ? t("catalogPage.badgeMandatory") : t("catalogPage.badgeOptional")}
                      </button>
                      <div className="flex flex-col gap-0.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => move(dt, -1)}
                          disabled={i === 0}
                          className="h-4 w-6 rounded hover:bg-primary/20 disabled:opacity-20 disabled:cursor-not-allowed flex items-center justify-center"
                          title={t("catalogPage.moveUp")}
                        ><ArrowUp className="h-3 w-3" /></button>
                        <button
                          type="button"
                          onClick={() => move(dt, 1)}
                          disabled={i === selectedKeys.length - 1}
                          className="h-4 w-6 rounded hover:bg-primary/20 disabled:opacity-20 disabled:cursor-not-allowed flex items-center justify-center"
                          title={t("catalogPage.moveDown")}
                        ><ArrowDown className="h-3 w-3" /></button>
                      </div>
                      <button
                        type="button"
                        onClick={() => setLevel(dt, "none")}
                        className="shrink-0 px-2 py-0.5 text-[11px] rounded border bg-background hover:bg-destructive/10 hover:text-destructive hover:border-destructive/40 text-muted-foreground transition-colors"
                      >{t("catalogPage.removeAction")}</button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Available */}
              {availableKeys.length > 0 && (
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-1.5">
                    {t("catalogPage.availableCount", { n: availableKeys.length })}
                  </p>
                  <div className="rounded-lg border bg-background divide-y divide-border">
                    {availableKeys.map(dt => (
                      <div key={dt} className="flex items-center gap-2 px-2 py-1.5 hover:bg-muted/30">
                        <span className="flex-1 text-xs text-muted-foreground break-words">{labelFor(dt)}</span>
                        <button
                          type="button"
                          onClick={() => setLevel(dt, "optional")}
                          className="shrink-0 px-2 py-0.5 text-[11px] rounded border bg-background hover:bg-primary/10 hover:text-primary hover:border-primary/40 text-muted-foreground transition-colors"
                        >{t("catalogPage.addShort")}</button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {selectedKeys.length === 0 && availableKeys.length === 0 && (
                <div className="text-center text-muted-foreground py-6 text-xs">{t("catalogPage.noDocsMatch", { q: docSearch })}</div>
              )}
            </div>
          </div>
      )}
      {variant === "dialog" && !isLoading && (
        <div className="flex justify-end pt-2 border-t">
          <Button onClick={handleSave} disabled={saving}>{saving ? t("common.saving") : t("common.save")}</Button>
        </div>
      )}
    </div>
  );
}

type PublicCatalogSettings = {
  allowedCountries: string[];
  allowedUniversityTypes: string[];
  countryRules: Record<string, string[]>;
  availableCountries: string[];
  availableUniversityTypes: string[];
};

function PublicCatalogSettingsTab() {
  const { t } = useI18n();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [universityTypes, setUniversityTypes] = useState<string[]>([]);
  const [countryRules, setCountryRules] = useState<Record<string, string[]>>({});
  const [countrySearch, setCountrySearch] = useState("");

  const settingsQuery = useQuery<PublicCatalogSettings>({
    queryKey: ["public-catalog-settings"],
    queryFn: () => api("/api/course-finder/public-settings"),
  });

  useEffect(() => {
    if (!settingsQuery.data) return;
    setUniversityTypes(settingsQuery.data.allowedUniversityTypes || []);
    const nextRules = { ...(settingsQuery.data.countryRules || {}) };
    // Preserve legacy country allow-lists when an old policy is first opened
    // in the new matrix UI: excluded countries become explicit hidden rules.
    if (
      Object.keys(nextRules).length === 0
      && (settingsQuery.data.allowedCountries || []).length > 0
    ) {
      const legacyAllowed = new Set(settingsQuery.data.allowedCountries);
      for (const country of settingsQuery.data.availableCountries || []) {
        if (!legacyAllowed.has(country)) nextRules[country] = [];
      }
    }
    setCountryRules(nextRules);
  }, [settingsQuery.data]);

  const saveMutation = useMutation({
    mutationFn: () => api("/api/course-finder/public-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        allowedCountries: [],
        allowedUniversityTypes: universityTypes,
        countryRules,
      }),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["public-catalog-settings"] });
      toast({ title: t("adminCatalog.publicCatalogSaved") });
    },
    onError: (error: Error) => {
      toast({
        title: t("adminCatalog.publicCatalogSaveFailed"),
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const toggle = (
    value: string,
    selected: string[],
    setSelected: (next: string[]) => void,
  ) => {
    setSelected(
      selected.includes(value)
        ? selected.filter((item) => item !== value)
        : [...selected, value],
    );
  };

  if (settingsQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("adminCatalog.publicCatalogLoading")}
      </div>
    );
  }

  const data = settingsQuery.data;
  const filteredCountries = (data?.availableCountries || []).filter((country) =>
    country.toLocaleLowerCase().includes(countrySearch.trim().toLocaleLowerCase())
  );

  const setCountryRule = (country: string, rule: string[] | undefined) => {
    setCountryRules((current) => {
      const next = { ...current };
      if (rule === undefined) delete next[country];
      else next[country] = rule;
      return next;
    });
  };

  const toggleCountryType = (country: string, universityType: string) => {
    const current = Object.prototype.hasOwnProperty.call(countryRules, country)
      ? countryRules[country]
      : universityTypes;
    const next = current.includes(universityType)
      ? current.filter((value) => value !== universityType)
      : [...current, universityType];
    setCountryRule(country, next);
  };

  return (
    <div className="space-y-6">
      <div className="rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground">
        {t("adminCatalog.publicCatalogPrivateOnlyNote")}
      </div>

      <section className="space-y-3">
        <div>
          <Label className="text-sm font-semibold">{t("adminCatalog.publicCatalogDefaultTypes")}</Label>
          <p className="mt-1 text-xs text-muted-foreground">{t("adminCatalog.publicCatalogDefaultTypesHelp")}</p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {(data?.availableUniversityTypes || []).map((value) => (
            <label key={value} className="flex cursor-pointer items-center gap-2 rounded-md border p-3 text-sm hover:bg-muted/50">
              <Checkbox
                checked={universityTypes.includes(value)}
                onCheckedChange={() => toggle(value, universityTypes, setUniversityTypes)}
              />
              <span>{value}</span>
            </label>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <Label className="text-sm font-semibold">{t("adminCatalog.publicCatalogCountryRules")}</Label>
          <p className="mt-1 text-xs text-muted-foreground">{t("adminCatalog.publicCatalogCountryRulesHelp")}</p>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={countrySearch}
            onChange={(event) => setCountrySearch(event.target.value)}
            placeholder={t("adminCatalog.publicCatalogCountrySearch")}
            className="pl-9"
          />
        </div>
        <div className="max-h-[34rem] space-y-2 overflow-y-auto pr-1">
          {filteredCountries.map((country) => {
            const hasRule = Object.prototype.hasOwnProperty.call(countryRules, country);
            const rule = hasRule ? countryRules[country] : undefined;
            const effectiveTypes = rule ?? universityTypes;
            const isHidden = hasRule && effectiveTypes.length === 0;
            return (
              <div
                key={country}
                className="grid gap-3 rounded-lg border p-3 lg:grid-cols-[minmax(10rem,1fr)_auto_minmax(18rem,2fr)] lg:items-center"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{country}</div>
                  <Badge variant="outline" className="mt-1 text-[10px]">
                    {!hasRule
                      ? t("adminCatalog.publicCatalogDefaultBadge")
                      : isHidden
                        ? t("adminCatalog.publicCatalogHidden")
                        : t("adminCatalog.publicCatalogCustom")}
                  </Badge>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant={!hasRule ? "default" : "outline"}
                    onClick={() => setCountryRule(country, undefined)}
                  >
                    {t("adminCatalog.publicCatalogUseDefault")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={isHidden ? "destructive" : "outline"}
                    onClick={() => setCountryRule(country, [])}
                  >
                    {t("adminCatalog.publicCatalogHidden")}
                  </Button>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {(data?.availableUniversityTypes || []).map((universityType) => (
                    <label
                      key={universityType}
                      className={cn(
                        "flex cursor-pointer items-center gap-2 rounded-md border p-2 text-sm hover:bg-muted/50",
                        effectiveTypes.includes(universityType) && "border-primary/40 bg-primary/5",
                      )}
                    >
                      <Checkbox
                        checked={effectiveTypes.includes(universityType)}
                        onCheckedChange={() => toggleCountryType(country, universityType)}
                      />
                      <span>{universityType}</span>
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <div className="flex justify-end border-t pt-4">
        <Button
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending || universityTypes.length === 0}
        >
          {saveMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {t("adminCatalog.publicCatalogSave")}
        </Button>
      </div>
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════
   MAIN PAGE
══════════════════════════════════════════════════════════ */
export default function AdminCatalog() {
  const { t } = useI18n();
  const tabs = [
    { value: "countries", label: t("adminCatalog.tabCountries"), icon: Globe },
    { value: "cities", label: t("adminCatalog.tabCities"), icon: Building2 },
    { value: "universities", label: t("adminCatalog.tabUniversities"), icon: GraduationCap },
    { value: "programs", label: t("adminCatalog.tabPrograms"), icon: BookOpen },
    { value: "options", label: t("adminCatalog.tabOptions"), icon: Settings2 },
  ];

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">{t("adminCatalog.title")}</h1>
        <p className="text-muted-foreground text-sm mt-1">{t("adminCatalog.subtitle")}</p>
      </div>
      <Tabs defaultValue="countries" className="space-y-4">
        <TabsList className="grid w-full grid-cols-5">
          {tabs.map(tab => (
            <TabsTrigger key={tab.value} value={tab.value} className="flex items-center gap-1.5">
              <tab.icon className="h-4 w-4" />
              <span className="hidden sm:inline">{tab.label}</span>
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="countries">
          <Card className="p-4">
            <div className="mb-4">
              <h2 className="text-base font-semibold flex items-center gap-2"><Globe className="h-4 w-4 text-primary" />{t("adminCatalog.countriesTitle")}</h2>
              <p className="text-xs text-muted-foreground mt-0.5">{t("adminCatalog.countriesDesc")}</p>
            </div>
            <CountriesTab />
          </Card>
        </TabsContent>

        <TabsContent value="cities">
          <Card className="p-4">
            <div className="mb-4">
              <h2 className="text-base font-semibold flex items-center gap-2"><Building2 className="h-4 w-4 text-primary" />{t("adminCatalog.citiesTitle")}</h2>
              <p className="text-xs text-muted-foreground mt-0.5">{t("adminCatalog.citiesDesc")}</p>
            </div>
            <CitiesTab />
          </Card>
        </TabsContent>

        <TabsContent value="universities">
          <Card className="p-4">
            <div className="mb-4">
              <h2 className="text-base font-semibold flex items-center gap-2"><GraduationCap className="h-4 w-4 text-primary" />{t("adminCatalog.universitiesTitle")}</h2>
              <p className="text-xs text-muted-foreground mt-0.5">{t("adminCatalog.universitiesDesc")}</p>
            </div>
            <UniversitiesTab />
          </Card>
        </TabsContent>

        <TabsContent value="programs">
          <Card className="p-4">
            <div className="mb-4">
              <h2 className="text-base font-semibold flex items-center gap-2"><BookOpen className="h-4 w-4 text-primary" />{t("adminCatalog.programsTitle")}</h2>
              <p className="text-xs text-muted-foreground mt-0.5">{t("adminCatalog.programsDesc")}</p>
            </div>
            <ProgramsTab />
          </Card>
        </TabsContent>

        <TabsContent value="options">
          <Card className="p-4">
            <div className="mb-4">
              <h2 className="text-base font-semibold flex items-center gap-2"><Settings2 className="h-4 w-4 text-primary" />{t("adminCatalog.optionsTitle")}</h2>
              <p className="text-xs text-muted-foreground mt-0.5">{t("adminCatalog.optionsDesc")}</p>
            </div>
            <OptionsTab />
          </Card>
        </TabsContent>

      </Tabs>
    </>
  );
}
