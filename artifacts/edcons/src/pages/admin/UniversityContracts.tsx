import { useEffect, useMemo, useRef, useState } from "react";
import { customFetch } from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { MultiSelectFilter } from "@/components/ui/multi-select-filter";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { CountryFlag, countryCodeFromEmoji, countryNameToIso } from "@/components/CountryFlag";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/hooks/use-i18n";
import { getLocale } from "@/lib/i18n";
import {
  GraduationCap, Plus, Edit, Trash2, Loader2, Save, Search,
  Upload, Download, FileText, AlertTriangle, AlertOctagon, CheckCircle2,
} from "lucide-react";

type Status = "active" | "expiring_soon" | "expired" | "no_dates";

type Contract = {
  id: number;
  universityId: number;
  destinationId: number | null;
  country: string;
  year: number | null;
  effectiveDate: string | null;
  expiryDate: string | null;
  fileObjectKey: string | null;
  fileName: string | null;
  fileMime: string | null;
  fileSize: number | null;
  notes: string | null;
  uploadedByUserId: number | null;
  assignedUserIds?: number[] | null;
  createdAt: string;
  universityName?: string | null;
  universityLogoUrl?: string | null;
  destinationName?: string | null;
  destinationCountry?: string | null;
  destinationFlagEmoji?: string | null;
  status: Status;
};

type University = { id: number; name: string; country: string; city: string | null };
type Destination = { id: number; name: string; country: string; flagEmoji?: string | null };

type FormState = {
  universityId: string;
  destinationId: string;
  year: string;
  effectiveDate: string;
  expiryDate: string;
  notes: string;
  fileObjectKey: string;
  fileName: string;
  fileMime: string;
  fileSize: number | null;
  assignedUserIds: number[];
  universityAssignedStaffIds: number[];
};

const emptyForm: FormState = {
  universityId: "",
  destinationId: "",
  year: "",
  effectiveDate: "",
  expiryDate: "",
  notes: "",
  fileObjectKey: "",
  fileName: "",
  fileMime: "",
  fileSize: null,
  assignedUserIds: [],
  universityAssignedStaffIds: [],
};

type StaffUser = { id: number; firstName: string | null; lastName: string | null; email: string | null; role: string };

const STATUS_META: Record<Status, { tone: "default" | "secondary" | "destructive" | "outline"; icon: any }> = {
  active: { tone: "outline", icon: CheckCircle2 },
  expiring_soon: { tone: "secondary", icon: AlertTriangle },
  expired: { tone: "destructive", icon: AlertOctagon },
  no_dates: { tone: "outline", icon: FileText },
};

const ALLOWED_CONTRACT_EXTS = /\.(pdf|docx|doc)$/i;
const ALLOWED_CONTRACT_MIMES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
]);

function formatDate(d: string | null, locale: string = "en-US"): string {
  if (!d) return "-";
  try { return new Date(d).toLocaleDateString(locale, { day: "2-digit", month: "long", year: "numeric" }); }
  catch { return "-"; }
}

function daysLeft(expiry: string | null): number | null {
  if (!expiry) return null;
  const e = new Date(expiry);
  if (isNaN(e.getTime())) return null;
  return Math.ceil((e.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
}

interface Props { openId?: number }

export default function UniversityContractsPage({ openId }: Props = {}) {
  const { toast } = useToast();
  const { t, lang } = useI18n();
  const locale = getLocale(lang);
  const STATUS_LABELS: Record<Status, { label: string; tone: "default" | "secondary" | "destructive" | "outline"; icon: any }> = {
    active: { label: t("universityContracts.statusActive"), tone: STATUS_META.active.tone, icon: STATUS_META.active.icon },
    expiring_soon: { label: t("universityContracts.statusExpiringSoon"), tone: STATUS_META.expiring_soon.tone, icon: STATUS_META.expiring_soon.icon },
    expired: { label: t("universityContracts.statusExpired"), tone: STATUS_META.expired.tone, icon: STATUS_META.expired.icon },
    no_dates: { label: t("universityContracts.statusNoDates"), tone: STATUS_META.no_dates.tone, icon: STATUS_META.no_dates.icon },
  };
  const [rows, setRows] = useState<Contract[]>([]);
  const [universities, setUniversities] = useState<University[]>([]);
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [staffUsers, setStaffUsers] = useState<StaffUser[]>([]);
  const [countries, setCountries] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  const [filterCountry, setFilterCountry] = useState<string>("all");
  const [filterUniversity, setFilterUniversity] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [filterYear, setFilterYear] = useState<string>("");
  const [search, setSearch] = useState("");

  const [showDialog, setShowDialog] = useState(false);
  const [editing, setEditing] = useState<Contract | null>(null);
  const [form, setForm] = useState<FormState>({ ...emptyForm });
  const [saving, setSaving] = useState(false);
  const [originalUniStaffIds, setOriginalUniStaffIds] = useState<number[]>([]);
  const [uploading, setUploading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Contract | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const handledOpenIdRef = useRef<number | null>(null);

  const normCountry = (c: string | null | undefined) => (c ?? "").trim().toLowerCase();

  const destByCountry = useMemo(() => {
    const m: Record<string, Destination> = {};
    for (const d of destinations) m[normCountry(d.country)] = d;
    return m;
  }, [destinations]);

  // Destination options: curated destinations (with real DB IDs) first,
  // then synthetic options for any university-catalog country that has
  // no matching curated destination. Synthetic values use the prefix
  // "c:" so the save handler maps them to destinationId: null while
  // still showing the correct country in the UI.
  const destinationOptions = useMemo(() => {
    const result: { value: string; country: string; label: string }[] = destinations.map(d => {
      const dedup = normCountry(d.name) === normCountry(d.country);
      const base = dedup ? d.name : `${d.name} — ${d.country}`;
      return {
        value: String(d.id),
        country: d.country,
        label: d.flagEmoji ? `${d.flagEmoji} ${base}` : base,
      };
    });
    const coveredKeys = new Set(destinations.map(d => normCountry(d.country)));
    for (const c of countries) {
      if (c && !coveredKeys.has(normCountry(c))) {
        result.push({ value: `c:${c}`, country: c, label: c });
      }
    }
    return result;
  }, [destinations, countries]);

  // Auto-fill: prefer a curated destination whose country matches;
  // fall back to a synthetic "c:<country>" option so the field still
  // shows the correct country even when no curated destination exists.
  const destValueForCountry = (country: string | null | undefined) => {
    const key = normCountry(country);
    const curated = destByCountry[key];
    if (curated) return String(curated.id);
    const inCatalog = countries.some(c => normCountry(c) === key);
    return inCatalog && country ? `c:${country}` : "";
  };

  async function load() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filterCountry !== "all") params.set("country", filterCountry);
      if (filterUniversity !== "all") params.set("universityId", filterUniversity);
      if (filterStatus !== "all") params.set("status", filterStatus);
      if (filterYear.trim()) params.set("year", filterYear.trim());
      if (search.trim()) params.set("search", search.trim());
      params.set("pageSize", "100");
      const res: any = await customFetch(`/api/university-contracts?${params.toString()}`);
      setRows(res.data || []);
    } catch (err: any) {
      toast({ title: t("universityContracts.loadError"), description: err.message, variant: "destructive" });
    }
    setLoading(false);
  }

  // The /api/universities endpoint caps limit at 100 server-side, so a
  // single request silently drops universities once the catalog exceeds
  // 100 rows. Page through until the full list is loaded so every
  // university is selectable in the contract dialog.
  async function fetchAllUniversities(): Promise<University[]> {
    const byId = new Map<number, University>();
    let page = 1;
    while (page <= 100) {
      const res: any = await customFetch(`/api/universities?limit=100&page=${page}`);
      const batch: University[] = res?.data || [];
      for (const u of batch) byId.set(u.id, u);
      const total = Number(res?.meta?.total ?? byId.size);
      if (batch.length === 0 || byId.size >= total) break;
      page++;
    }
    return Array.from(byId.values());
  }

  async function loadMeta() {
    try {
      const [unis, cs, dests, users]: any = await Promise.all([
        fetchAllUniversities(),
        customFetch(`/api/universities/countries`),
        customFetch(`/api/public/destinations`),
        customFetch(`/api/users?limit=500`).catch(() => ({ data: [] })),
      ]);
      setUniversities(Array.isArray(unis) ? unis : (unis?.data || []));
      setCountries(cs || []);
      setDestinations(Array.isArray(dests) ? dests : (dests?.data || []));
      const list: any[] = users?.data || [];
      setStaffUsers(list
        .filter(u => u.isActive !== false && ["super_admin", "admin", "manager", "staff", "consultant", "agent_staff"].includes(u.role))
        .map(u => ({ id: u.id, firstName: u.firstName, lastName: u.lastName, email: u.email, role: u.role })));
    } catch {}
  }

  useEffect(() => { loadMeta(); }, []);
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [filterCountry, filterUniversity, filterStatus, filterYear]);

  // Deep-link: open dialog for /admin/university-contracts/:id.
  // Prefer the loaded list (avoids extra round-trip); otherwise fall
  // back to a direct fetch so notification links always open the
  // intended record even when it isn't on the current page.
  useEffect(() => {
    if (!openId || handledOpenIdRef.current === openId) return;
    const inList = rows.find(r => r.id === openId);
    if (inList) {
      handledOpenIdRef.current = openId;
      openEdit(inList);
      return;
    }
    if (loading) return;
    handledOpenIdRef.current = openId;
    (async () => {
      try {
        const res: any = await customFetch(`/api/university-contracts/${openId}`);
        if (res?.data) openEdit(res.data as Contract);
      } catch (err: any) {
        toast({ title: t("universityContracts.notFoundTitle"), description: err.message, variant: "destructive" });
      }
    })();
    // eslint-disable-next-line
  }, [openId, rows, loading]);

  async function fetchUniStaffIds(uniId: number): Promise<number[]> {
    try {
      const u: any = await customFetch(`/api/universities/${uniId}/assigned-staff`);
      return Array.isArray(u?.assignedStaffIds) ? u.assignedStaffIds : [];
    } catch { return []; }
  }

  function openCreate() {
    setEditing(null);
    setForm({ ...emptyForm });
    setOriginalUniStaffIds([]);
    setShowDialog(true);
  }

  function openEdit(c: Contract) {
    setEditing(c);
    setForm({
      universityId: String(c.universityId),
      destinationId: c.destinationId != null ? String(c.destinationId) : "",
      year: c.year != null ? String(c.year) : "",
      effectiveDate: c.effectiveDate ? c.effectiveDate.slice(0, 10) : "",
      expiryDate: c.expiryDate ? c.expiryDate.slice(0, 10) : "",
      notes: c.notes || "",
      fileObjectKey: c.fileObjectKey || "",
      fileName: c.fileName || "",
      fileMime: c.fileMime || "",
      fileSize: c.fileSize ?? null,
      assignedUserIds: Array.isArray(c.assignedUserIds) ? c.assignedUserIds : [],
      universityAssignedStaffIds: [],
    });
    setShowDialog(true);
    fetchUniStaffIds(c.universityId).then(ids => {
      setOriginalUniStaffIds(ids);
      setForm(f => ({ ...f, universityAssignedStaffIds: ids }));
    });
  }

  // Auto-default destination from selected university's country and
  // load that university's assigned-staff list (per-university source
  // of truth for contract expiry recipients).
  function onUniversityChange(uniId: string) {
    setForm(f => {
      const next = { ...f, universityId: uniId, universityAssignedStaffIds: [] };
      const uni = universities.find(u => String(u.id) === uniId);
      if (uni && !next.destinationId) {
        next.destinationId = destValueForCountry(uni.country);
      }
      return next;
    });
    setOriginalUniStaffIds([]);
    const idNum = parseInt(uniId, 10);
    if (!Number.isNaN(idNum)) {
      fetchUniStaffIds(idNum).then(ids => {
        setOriginalUniStaffIds(ids);
        setForm(f => (f.universityId === uniId ? { ...f, universityAssignedStaffIds: ids } : f));
      });
    }
  }

  async function uploadFile(file: File) {
    if (!ALLOWED_CONTRACT_MIMES.has(file.type) && !ALLOWED_CONTRACT_EXTS.test(file.name)) {
      toast({ title: t("universityContracts.fileTypeUnsupported"), description: t("universityContracts.fileTypeUnsupportedDesc"), variant: "destructive" });
      return;
    }
    setUploading(true);
    try {
      const urlRes: any = await customFetch(`/api/storage/uploads/request-url`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type }),
      });
      if (!urlRes.uploadURL) throw new Error(t("universityContracts.uploadLinkFailed"));
      const putRes = await fetch(urlRes.uploadURL, { method: "PUT", body: file, headers: { "Content-Type": file.type } });
      if (!putRes.ok) throw new Error(t("universityContracts.uploadFailed"));
      setForm(f => ({
        ...f,
        fileObjectKey: urlRes.objectPath,
        fileName: file.name,
        fileMime: file.type || "application/octet-stream",
        fileSize: file.size,
      }));
      toast({ title: t("universityContracts.uploadSucceeded") });
    } catch (err: any) {
      toast({ title: t("universityContracts.uploadFailed"), description: err.message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  }

  async function save() {
    if (!form.universityId) { toast({ title: t("universityContracts.selectUniversityRequired"), variant: "destructive" }); return; }
    setSaving(true);
    try {
      const body: any = {
        universityId: parseInt(form.universityId, 10),
        // Only curated destinations have a real FK id; synthetic
        // "c:<country>" values carry no id (the contract's country is
        // derived from the university server-side regardless).
        destinationId: /^\d+$/.test(form.destinationId) ? parseInt(form.destinationId, 10) : null,
        year: form.year ? parseInt(form.year, 10) : null,
        effectiveDate: form.effectiveDate || null,
        expiryDate: form.expiryDate || null,
        notes: form.notes || null,
        assignedUserIds: form.assignedUserIds,
      };
      if (form.fileObjectKey && (!editing || form.fileObjectKey !== editing.fileObjectKey)) {
        body.fileObjectKey = form.fileObjectKey;
        body.fileName = form.fileName;
        body.fileMime = form.fileMime;
        body.fileSize = form.fileSize;
      }
      if (editing) {
        await customFetch(`/api/university-contracts/${editing.id}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
        toast({ title: t("universityContracts.contractUpdated") });
      } else {
        await customFetch(`/api/university-contracts`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
        toast({ title: t("universityContracts.contractCreated") });
      }

      // Persist per-university assigned staff if changed.
      const a = [...form.universityAssignedStaffIds].sort((x, y) => x - y);
      const b = [...originalUniStaffIds].sort((x, y) => x - y);
      const changed = a.length !== b.length || a.some((v, i) => v !== b[i]);
      if (changed && body.universityId) {
        try {
          await customFetch(`/api/universities/${body.universityId}`, {
            method: "PATCH", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ assignedStaffIds: a }),
          });
        } catch (err: any) {
          toast({ title: t("universityContracts.uniStaffUpdateFailed"), description: err.message, variant: "destructive" });
        }
      }
      setShowDialog(false);
      await load();
    } catch (err: any) {
      toast({ title: t("universityContracts.saveFailed"), description: err.message, variant: "destructive" });
    }
    setSaving(false);
  }

  async function performDelete() {
    if (!confirmDelete) return;
    const id = confirmDelete.id;
    try {
      await customFetch(`/api/university-contracts/${id}`, { method: "DELETE" });
      toast({ title: t("universityContracts.trashDone"), description: t("universityContracts.trashDoneDesc") });
      setConfirmDelete(null);
      await load();
    } catch (err: any) {
      toast({ title: t("universityContracts.deleteFailed"), description: err.message, variant: "destructive" });
    }
  }

  async function download(c: Contract) {
    try {
      const res = await fetch(`/api/university-contracts/${c.id}/file`, { credentials: "include" });
      if (!res.ok) throw new Error(t("universityContracts.downloadFailed"));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = c.fileName || `contract-${c.id}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      toast({ title: t("universityContracts.downloadFailed"), description: err.message, variant: "destructive" });
    }
  }

  const filteredRows = useMemo(() => {
    if (!search.trim()) return rows;
    const term = search.trim().toLowerCase();
    return rows.filter(r =>
      (r.universityName || "").toLowerCase().includes(term) ||
      (r.country || "").toLowerCase().includes(term) ||
      (r.fileName || "").toLowerCase().includes(term),
    );
  }, [rows, search]);

  const stats = useMemo(() => {
    const s = { total: rows.length, active: 0, expiring: 0, expired: 0, no_dates: 0 };
    for (const r of rows) {
      if (r.status === "active") s.active++;
      else if (r.status === "expiring_soon") s.expiring++;
      else if (r.status === "expired") s.expired++;
      else s.no_dates++;
    }
    return s;
  }, [rows]);

  return (
    <TooltipProvider>
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <GraduationCap className="w-6 h-6" /> {t("universityContracts.title")}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {t("universityContracts.subtitle")}
          </p>
        </div>
        <Button onClick={openCreate}><Plus className="w-4 h-4 mr-2" /> {t("universityContracts.newContract")}</Button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Card className="p-4"><div className="text-xs text-muted-foreground">{t("universityContracts.statTotal")}</div><div className="text-2xl font-bold mt-1">{stats.total}</div></Card>
        <Card className="p-4"><div className="text-xs text-muted-foreground">{t("universityContracts.statActive")}</div><div className="text-2xl font-bold mt-1 text-green-600">{stats.active}</div></Card>
        <Card className="p-4"><div className="text-xs text-muted-foreground">{t("universityContracts.statExpiring")}</div><div className="text-2xl font-bold mt-1 text-amber-600">{stats.expiring}</div></Card>
        <Card className="p-4"><div className="text-xs text-muted-foreground">{t("universityContracts.statExpired")}</div><div className="text-2xl font-bold mt-1 text-red-600">{stats.expired}</div></Card>
        <Card className="p-4"><div className="text-xs text-muted-foreground">{t("universityContracts.statNoDates")}</div><div className="text-2xl font-bold mt-1 text-muted-foreground">{stats.no_dates}</div></Card>
      </div>

      <Card className="p-4 flex flex-wrap gap-3 items-end">
        <div className="flex-1 min-w-[200px]">
          <Label className="text-xs">{t("universityContracts.search")}</Label>
          <div className="relative">
            <Search className="w-4 h-4 absolute left-2 top-2.5 text-muted-foreground" />
            <Input value={search} onChange={e => setSearch(e.target.value)} placeholder={t("universityContracts.searchPlaceholder")} className="pl-8" />
          </div>
        </div>
        <div className="min-w-[220px]">
          <Label className="text-xs">{t("universityContracts.university")}</Label>
          <Select value={filterUniversity} onValueChange={setFilterUniversity}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent className="max-h-[320px]">
              <SelectItem value="all">{t("universityContracts.all")}</SelectItem>
              {universities.map(u => <SelectItem key={u.id} value={String(u.id)}>{u.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="min-w-[180px]">
          <Label className="text-xs">{t("universityContracts.country")}</Label>
          <Select value={filterCountry} onValueChange={setFilterCountry}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("universityContracts.all")}</SelectItem>
              {countries.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="min-w-[180px]">
          <Label className="text-xs">{t("universityContracts.status")}</Label>
          <Select value={filterStatus} onValueChange={setFilterStatus}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("universityContracts.all")}</SelectItem>
              <SelectItem value="active">{t("universityContracts.statusActive")}</SelectItem>
              <SelectItem value="expiring_soon">{t("universityContracts.statusExpiringSoon")}</SelectItem>
              <SelectItem value="expired">{t("universityContracts.statusExpired")}</SelectItem>
              <SelectItem value="no_dates">{t("universityContracts.statusNoDates")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="w-[120px]">
          <Label className="text-xs">{t("universityContracts.year")}</Label>
          <Input type="number" value={filterYear} onChange={e => setFilterYear(e.target.value)} placeholder="2025" />
        </div>
      </Card>

      <Card className="p-0 overflow-hidden">
        {loading ? (
          <div className="p-12 text-center text-muted-foreground"><Loader2 className="w-6 h-6 mx-auto animate-spin" /></div>
        ) : filteredRows.length === 0 ? (
          <div className="p-12 text-center text-muted-foreground">{t("universityContracts.emptyList")}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40">
                <tr>
                  <th className="text-left px-4 py-3">{t("universityContracts.colUniversity")}</th>
                  <th className="text-left px-4 py-3">{t("universityContracts.colDestination")}</th>
                  <th className="text-left px-4 py-3">{t("universityContracts.colYear")}</th>
                  <th className="text-left px-4 py-3">{t("universityContracts.colEffective")}</th>
                  <th className="text-left px-4 py-3">{t("universityContracts.colExpiry")}</th>
                  <th className="text-left px-4 py-3">{t("universityContracts.colDaysLeft")}</th>
                  <th className="text-left px-4 py-3">{t("universityContracts.colStatus")}</th>
                  <th className="text-left px-4 py-3">{t("universityContracts.colFile")}</th>
                  <th className="text-right px-4 py-3">{t("universityContracts.colActions")}</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map(c => {
                  const meta = STATUS_LABELS[c.status];
                  const Icon = meta.icon;
                  const dl = daysLeft(c.expiryDate);
                  // Prefer destination joined from API by destinationId; fall
                  // back to country-based lookup only when destinationId is
                  // not set on the contract.
                  const dest = c.destinationName
                    ? { name: c.destinationName, flagEmoji: c.destinationFlagEmoji || null }
                    : destByCountry[normCountry(c.country)];
                  const tooltipText = dl === null ? t("universityContracts.tooltipNoExpiry") :
                    dl < 0 ? t(Math.abs(dl) === 1 ? "universityContracts.tooltipExpiredAgo" : "universityContracts.tooltipExpiredAgoPlural", { n: Math.abs(dl) }) :
                    t("universityContracts.tooltipExpiresOn", { date: formatDate(c.expiryDate, locale) });
                  const daysSuffix = t("universityContracts.daysSuffix");
                  const daysCellText = dl === null ? "-" :
                    dl < 0 ? `−${Math.abs(dl)} ${daysSuffix}` :
                    dl === 0 ? t("universityContracts.today") :
                    `${dl} ${daysSuffix}`;
                  const daysCellTone = dl === null ? "text-muted-foreground" :
                    dl < 0 ? "text-red-600 font-semibold" :
                    dl <= 7 ? "text-red-600 font-semibold" :
                    dl <= 30 ? "text-amber-600 font-medium" :
                    "text-foreground";
                  return (
                    <tr key={c.id} className="border-t hover:bg-muted/30">
                      <td className="px-4 py-3 font-medium">
                        <span className="inline-flex items-center gap-2">
                          {c.universityLogoUrl ? (
                            <img src={c.universityLogoUrl} alt="" className="w-6 h-6 rounded object-cover bg-muted" />
                          ) : (
                            <span className="w-6 h-6 rounded bg-muted inline-flex items-center justify-center text-[10px] text-muted-foreground">
                              {(c.universityName || "?").slice(0, 1).toUpperCase()}
                            </span>
                          )}
                          <span>{c.universityName || `#${c.universityId}`}</span>
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1.5">
                          {(() => {
                            const iso = (c.country && c.country.length === 2 ? c.country : null) || (c.country && c.country.length > 2 ? countryNameToIso(c.country) : null) || (dest?.flagEmoji ? countryCodeFromEmoji(dest.flagEmoji) : null);
                            return iso ? <CountryFlag code={iso} size="md" rounded /> : <span className="w-5 h-[15px] inline-block bg-muted rounded-[2px]" />;
                          })()}
                          <span>{dest?.name || c.country}</span>
                        </span>
                      </td>
                      <td className="px-4 py-3">{c.year ?? "-"}</td>
                      <td className="px-4 py-3">{formatDate(c.effectiveDate, locale)}</td>
                      <td className="px-4 py-3">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="cursor-help underline decoration-dotted underline-offset-2">{formatDate(c.expiryDate, locale)}</span>
                          </TooltipTrigger>
                          <TooltipContent>{tooltipText}</TooltipContent>
                        </Tooltip>
                      </td>
                      <td className="px-4 py-3">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className={`cursor-help ${daysCellTone}`}>{daysCellText}</span>
                          </TooltipTrigger>
                          <TooltipContent>{tooltipText}</TooltipContent>
                        </Tooltip>
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={meta.tone}><Icon className="w-3 h-3 mr-1" />{meta.label}</Badge>
                      </td>
                      <td className="px-4 py-3">
                        {c.fileObjectKey ? (
                          <Button variant="ghost" size="sm" onClick={() => download(c)}>
                            <Download className="w-4 h-4 mr-1" /> {c.fileName ? (c.fileName.length > 24 ? c.fileName.slice(0, 24) + "…" : c.fileName) : t("universityContracts.download")}
                          </Button>
                        ) : <span className="text-muted-foreground">-</span>}
                      </td>
                      <td className="px-4 py-3 text-right space-x-1">
                        <Button variant="ghost" size="sm" onClick={() => openEdit(c)}><Edit className="w-4 h-4" /></Button>
                        <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(c)}><Trash2 className="w-4 h-4 text-red-600" /></Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="max-w-lg p-0 gap-0 max-h-[88vh] flex flex-col overflow-hidden">
          <DialogHeader className="px-5 pt-5 pb-3 border-b shrink-0">
            <DialogTitle className="text-base flex items-center gap-2">
              <FileText className="w-4 h-4 text-muted-foreground" />
              {editing ? t("universityContracts.editContract") : t("universityContracts.newContract")}
            </DialogTitle>
          </DialogHeader>
          <div className="px-5 py-4 space-y-4 overflow-y-auto">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">{t("universityContracts.university")} *</Label>
              <SearchableSelect
                value={form.universityId}
                onChange={onUniversityChange}
                placeholder={t("universityContracts.selectUniversity")}
                searchPlaceholder={t("universityContracts.searchUniversity")}
                options={universities.map(u => ({
                  value: String(u.id),
                  label: `${u.name} — ${u.country}${u.city ? `, ${u.city}` : ""}`,
                }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">{t("universityContracts.destinationAuto")}</Label>
              {(() => {
                const selectedUni = universities.find(u => String(u.id) === form.universityId);
                const uniCountry = selectedUni?.country || "";
                const uniKey = normCountry(uniCountry);
                const sortedOptions = [...destinationOptions].sort((a, b) => {
                  if (uniKey) {
                    const am = normCountry(a.country) === uniKey;
                    const bm = normCountry(b.country) === uniKey;
                    if (am && !bm) return -1;
                    if (bm && !am) return 1;
                  }
                  return a.country.localeCompare(b.country);
                });
                const selectOptions = sortedOptions.map(o => ({
                  value: o.value,
                  label: o.label,
                  group: uniKey && normCountry(o.country) === uniKey ? t("universityContracts.matchingDestination") : t("universityContracts.otherDestinations"),
                }));
                // Keep an already-saved destination visible in edit mode even
                // when it is no longer in the active destinations list (e.g.
                // it was deactivated) — otherwise the control would render
                // blank and the user could silently overwrite the value.
                if (form.destinationId && !selectOptions.some(o => o.value === form.destinationId)) {
                  const fallbackLabel = editing?.destinationName
                    ? (normCountry(editing.destinationName) === normCountry(editing.destinationCountry) || !editing.destinationCountry
                        ? editing.destinationName
                        : `${editing.destinationName} — ${editing.destinationCountry}`)
                    : (editing?.destinationCountry || editing?.country || form.destinationId);
                  selectOptions.unshift({
                    value: form.destinationId,
                    label: fallbackLabel,
                    group: t("universityContracts.matchingDestination"),
                  });
                }
                return (
                  <SearchableSelect
                    value={form.destinationId}
                    onChange={v => setForm(f => ({ ...f, destinationId: v }))}
                    placeholder={t("universityContracts.destinationAutoPlaceholder")}
                    searchPlaceholder={t("universityContracts.searchDestination")}
                    clearable
                    options={selectOptions}
                  />
                );
              })()}
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">{t("universityContracts.year")}</Label>
                <Input className="h-9" type="number" value={form.year} onChange={e => setForm(f => ({ ...f, year: e.target.value }))} placeholder="2025" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">{t("universityContracts.effectiveDate")}</Label>
                <Input className="h-9" type="date" value={form.effectiveDate} onChange={e => setForm(f => ({ ...f, effectiveDate: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">{t("universityContracts.expiryDate")}</Label>
                <Input className="h-9" type="date" value={form.expiryDate} onChange={e => setForm(f => ({ ...f, expiryDate: e.target.value }))} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">{t("universityContracts.notes")}</Label>
              <Textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={2} />
            </div>
            <div className="space-y-1.5">
              <div>
                <Label className="text-xs font-medium">{t("universityContracts.uniStaffLabel")}</Label>
                <p className="text-[11px] leading-snug text-muted-foreground mt-0.5">
                  {t("universityContracts.uniStaffHelp")}
                </p>
              </div>
              {!form.universityId ? (
                <div className="text-xs text-muted-foreground border rounded-md p-2 bg-muted/20">{t("universityContracts.selectUniFirst")}</div>
              ) : staffUsers.length === 0 ? (
                <div className="text-xs text-muted-foreground border rounded-md p-2 bg-muted/20">{t("universityContracts.noStaffFound")}</div>
              ) : (
                <MultiSelectFilter
                  values={form.universityAssignedStaffIds.map(String)}
                  onChange={(vals) => setForm(f => ({ ...f, universityAssignedStaffIds: vals.map(Number) }))}
                  options={staffUsers.map(u => {
                    const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || `#${u.id}`;
                    return { value: String(u.id), label: `${name} (${u.role})` };
                  })}
                  placeholder={t("universityContracts.selectStaffPlaceholder")}
                />
              )}
            </div>
            <div className="space-y-1.5">
              <div>
                <Label className="text-xs font-medium">{t("universityContracts.contractStaffLabel")}</Label>
                <p className="text-[11px] leading-snug text-muted-foreground mt-0.5">
                  {t("universityContracts.contractStaffHelp")}
                </p>
              </div>
              {staffUsers.length === 0 ? (
                <div className="text-xs text-muted-foreground border rounded-md p-2 bg-muted/20">{t("universityContracts.noStaffFound")}</div>
              ) : (
                <MultiSelectFilter
                  values={form.assignedUserIds.map(String)}
                  onChange={(vals) => setForm(f => ({ ...f, assignedUserIds: vals.map(Number) }))}
                  options={staffUsers.map(u => {
                    const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || `#${u.id}`;
                    return { value: String(u.id), label: `${name} (${u.role})` };
                  })}
                  placeholder={t("universityContracts.selectStaffPlaceholder")}
                />
              )}
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">{t("universityContracts.fileLabel")}</Label>
              <input
                ref={fileInputRef}
                type="file"
                hidden
                accept=".pdf,.docx,.doc,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword"
                onChange={e => { const f = e.target.files?.[0]; if (f) uploadFile(f); e.target.value = ""; }}
              />
              <div className="flex items-center gap-2 flex-wrap">
                <Button type="button" variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
                  {uploading ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Upload className="w-4 h-4 mr-1" />}
                  {form.fileObjectKey ? t("universityContracts.fileReplace") : t("universityContracts.fileUpload")}
                </Button>
                {form.fileName && <span className="text-xs text-muted-foreground truncate max-w-[200px]">{form.fileName}</span>}
              </div>
              <p className="text-[11px] text-muted-foreground">{t("universityContracts.fileAcceptedTypes")}</p>
            </div>
          </div>
          <DialogFooter className="px-5 py-3 border-t shrink-0 bg-muted/20">
            <Button variant="outline" size="sm" onClick={() => setShowDialog(false)}>{t("universityContracts.cancel")}</Button>
            <Button size="sm" onClick={save} disabled={saving}>
              {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
              {t("universityContracts.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("universityContracts.trashTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmDelete ? t("universityContracts.trashDesc", { name: confirmDelete.universityName || t("universityContracts.colUniversity") }) : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("universityContracts.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={performDelete} className="bg-red-600 hover:bg-red-700">{t("universityContracts.trashAction")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
    </TooltipProvider>
  );
}
