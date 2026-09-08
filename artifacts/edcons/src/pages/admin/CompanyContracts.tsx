import { useEffect, useMemo, useRef, useState } from "react";
import { customFetch } from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { MultiSelectFilter } from "@/components/ui/multi-select-filter";
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
  Building2, Plus, Edit, Trash2, Loader2, Save, Search,
  Upload, Download, FileText, AlertTriangle, AlertOctagon, CheckCircle2,
} from "lucide-react";

type Status = "active" | "expiring_soon" | "expired" | "no_dates";

type Contract = {
  id: number;
  companyName: string;
  country: string | null;
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
  status: Status;
};

type FormState = {
  companyName: string;
  country: string;
  year: string;
  effectiveDate: string;
  expiryDate: string;
  notes: string;
  fileObjectKey: string;
  fileName: string;
  fileMime: string;
  fileSize: number | null;
  assignedUserIds: number[];
};

const emptyForm: FormState = {
  companyName: "",
  country: "",
  year: "",
  effectiveDate: "",
  expiryDate: "",
  notes: "",
  fileObjectKey: "",
  fileName: "",
  fileMime: "",
  fileSize: null,
  assignedUserIds: [],
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

export default function CompanyContractsPage({ openId }: Props = {}) {
  const { toast } = useToast();
  const { t, lang } = useI18n();
  const locale = getLocale(lang);
  const STATUS_LABELS: Record<Status, { label: string; tone: "default" | "secondary" | "destructive" | "outline"; icon: any }> = {
    active: { label: t("companyContracts.statusActive"), tone: STATUS_META.active.tone, icon: STATUS_META.active.icon },
    expiring_soon: { label: t("companyContracts.statusExpiringSoon"), tone: STATUS_META.expiring_soon.tone, icon: STATUS_META.expiring_soon.icon },
    expired: { label: t("companyContracts.statusExpired"), tone: STATUS_META.expired.tone, icon: STATUS_META.expired.icon },
    no_dates: { label: t("companyContracts.statusNoDates"), tone: STATUS_META.no_dates.tone, icon: STATUS_META.no_dates.icon },
  };
  const [rows, setRows] = useState<Contract[]>([]);
  const [staffUsers, setStaffUsers] = useState<StaffUser[]>([]);
  const [loading, setLoading] = useState(true);

  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [filterYear, setFilterYear] = useState<string>("");
  const [filterCompany, setFilterCompany] = useState<string>("all");
  const [filterEffectiveFrom, setFilterEffectiveFrom] = useState<string>("");
  const [filterEffectiveTo, setFilterEffectiveTo] = useState<string>("");
  const [filterExpiryFrom, setFilterExpiryFrom] = useState<string>("");
  const [filterExpiryTo, setFilterExpiryTo] = useState<string>("");
  const [companies, setCompanies] = useState<string[]>([]);
  const [search, setSearch] = useState("");

  const [showDialog, setShowDialog] = useState(false);
  const [editing, setEditing] = useState<Contract | null>(null);
  const [form, setForm] = useState<FormState>({ ...emptyForm });
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Contract | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const handledOpenIdRef = useRef<number | null>(null);

  async function load() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filterStatus !== "all") params.set("status", filterStatus);
      if (filterYear.trim()) params.set("year", filterYear.trim());
      if (filterCompany !== "all") params.set("company", filterCompany);
      if (filterEffectiveFrom) params.set("effectiveFrom", filterEffectiveFrom);
      if (filterEffectiveTo) params.set("effectiveTo", filterEffectiveTo);
      if (filterExpiryFrom) params.set("expiryFrom", filterExpiryFrom);
      if (filterExpiryTo) params.set("expiryTo", filterExpiryTo);
      if (search.trim()) params.set("search", search.trim());
      params.set("pageSize", "100");
      const res: any = await customFetch(`/api/company-contracts?${params.toString()}`);
      setRows(res.data || []);
    } catch (err: any) {
      toast({ title: t("companyContracts.loadError"), description: err.message, variant: "destructive" });
    }
    setLoading(false);
  }

  async function loadMeta() {
    try {
      const users: any = await customFetch(`/api/users?limit=500`).catch(() => ({ data: [] }));
      const list: any[] = users?.data || [];
      setStaffUsers(list
        .filter(u => u.isActive !== false && ["super_admin", "admin", "manager", "staff", "consultant", "agent_staff"].includes(u.role))
        .map(u => ({ id: u.id, firstName: u.firstName, lastName: u.lastName, email: u.email, role: u.role })));
    } catch {}
  }

  async function loadCompanies() {
    try {
      const res: any = await customFetch(`/api/company-contracts/companies`).catch(() => ({ data: [] }));
      setCompanies(Array.isArray(res?.data) ? res.data : []);
    } catch {}
  }

  useEffect(() => { loadMeta(); loadCompanies(); }, []);
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [filterStatus, filterYear, filterCompany, filterEffectiveFrom, filterEffectiveTo, filterExpiryFrom, filterExpiryTo]);

  // Deep-link: open dialog for /admin/company-contracts/:id. Prefer the loaded
  // list; otherwise fall back to a direct fetch so notification links always
  // open the intended record even when it isn't on the current page.
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
        const res: any = await customFetch(`/api/company-contracts/${openId}`);
        if (res?.data) openEdit(res.data as Contract);
      } catch (err: any) {
        toast({ title: t("companyContracts.notFoundTitle"), description: err.message, variant: "destructive" });
      }
    })();
    // eslint-disable-next-line
  }, [openId, rows, loading]);

  function openCreate() {
    setEditing(null);
    setForm({ ...emptyForm });
    setShowDialog(true);
  }

  function openEdit(c: Contract) {
    setEditing(c);
    setForm({
      companyName: c.companyName || "",
      country: c.country || "",
      year: c.year != null ? String(c.year) : "",
      effectiveDate: c.effectiveDate ? c.effectiveDate.slice(0, 10) : "",
      expiryDate: c.expiryDate ? c.expiryDate.slice(0, 10) : "",
      notes: c.notes || "",
      fileObjectKey: c.fileObjectKey || "",
      fileName: c.fileName || "",
      fileMime: c.fileMime || "",
      fileSize: c.fileSize ?? null,
      assignedUserIds: Array.isArray(c.assignedUserIds) ? c.assignedUserIds : [],
    });
    setShowDialog(true);
  }

  async function uploadFile(file: File) {
    if (!ALLOWED_CONTRACT_MIMES.has(file.type) && !ALLOWED_CONTRACT_EXTS.test(file.name)) {
      toast({ title: t("companyContracts.fileTypeUnsupported"), description: t("companyContracts.fileTypeUnsupportedDesc"), variant: "destructive" });
      return;
    }
    setUploading(true);
    try {
      const urlRes: any = await customFetch(`/api/storage/uploads/request-url`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type }),
      });
      if (!urlRes.uploadURL) throw new Error(t("companyContracts.uploadLinkFailed"));
      const putRes = await fetch(urlRes.uploadURL, { method: "PUT", body: file, headers: { "Content-Type": file.type } });
      if (!putRes.ok) throw new Error(t("companyContracts.uploadFailed"));
      setForm(f => ({
        ...f,
        fileObjectKey: urlRes.objectPath,
        fileName: file.name,
        fileMime: file.type || "application/octet-stream",
        fileSize: file.size,
      }));
      toast({ title: t("companyContracts.uploadSucceeded") });
    } catch (err: any) {
      toast({ title: t("companyContracts.uploadFailed"), description: err.message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  }

  async function save() {
    if (!form.companyName.trim()) { toast({ title: t("companyContracts.companyNameRequired"), variant: "destructive" }); return; }
    setSaving(true);
    try {
      const body: any = {
        companyName: form.companyName.trim(),
        country: form.country.trim() || null,
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
        await customFetch(`/api/company-contracts/${editing.id}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
        toast({ title: t("companyContracts.contractUpdated") });
      } else {
        await customFetch(`/api/company-contracts`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
        toast({ title: t("companyContracts.contractCreated") });
      }
      setShowDialog(false);
      await load();
    } catch (err: any) {
      toast({ title: t("companyContracts.saveFailed"), description: err.message, variant: "destructive" });
    }
    setSaving(false);
  }

  async function performDelete() {
    if (!confirmDelete) return;
    const id = confirmDelete.id;
    try {
      await customFetch(`/api/company-contracts/${id}`, { method: "DELETE" });
      toast({ title: t("companyContracts.trashDone"), description: t("companyContracts.trashDoneDesc") });
      setConfirmDelete(null);
      await load();
    } catch (err: any) {
      toast({ title: t("companyContracts.deleteFailed"), description: err.message, variant: "destructive" });
    }
  }

  async function download(c: Contract) {
    try {
      const res = await fetch(`/api/company-contracts/${c.id}/file`, { credentials: "include" });
      if (!res.ok) throw new Error(t("companyContracts.downloadFailed"));
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
      toast({ title: t("companyContracts.downloadFailed"), description: err.message, variant: "destructive" });
    }
  }

  const filteredRows = useMemo(() => {
    if (!search.trim()) return rows;
    const term = search.trim().toLowerCase();
    return rows.filter(r =>
      (r.companyName || "").toLowerCase().includes(term) ||
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
            <Building2 className="w-6 h-6" /> {t("companyContracts.title")}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {t("companyContracts.subtitle")}
          </p>
        </div>
        <Button onClick={openCreate}><Plus className="w-4 h-4 mr-2" /> {t("companyContracts.newContract")}</Button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Card className="p-4"><div className="text-xs text-muted-foreground">{t("companyContracts.statTotal")}</div><div className="text-2xl font-bold mt-1">{stats.total}</div></Card>
        <Card className="p-4"><div className="text-xs text-muted-foreground">{t("companyContracts.statActive")}</div><div className="text-2xl font-bold mt-1 text-green-600">{stats.active}</div></Card>
        <Card className="p-4"><div className="text-xs text-muted-foreground">{t("companyContracts.statExpiring")}</div><div className="text-2xl font-bold mt-1 text-amber-600">{stats.expiring}</div></Card>
        <Card className="p-4"><div className="text-xs text-muted-foreground">{t("companyContracts.statExpired")}</div><div className="text-2xl font-bold mt-1 text-red-600">{stats.expired}</div></Card>
        <Card className="p-4"><div className="text-xs text-muted-foreground">{t("companyContracts.statNoDates")}</div><div className="text-2xl font-bold mt-1 text-muted-foreground">{stats.no_dates}</div></Card>
      </div>

      <Card className="p-4 flex flex-wrap gap-3 items-end">
        <div className="flex-1 min-w-[200px]">
          <Label className="text-xs">{t("companyContracts.search")}</Label>
          <div className="relative">
            <Search className="w-4 h-4 absolute left-2 top-2.5 text-muted-foreground" />
            <Input value={search} onChange={e => setSearch(e.target.value)} placeholder={t("companyContracts.searchPlaceholder")} className="pl-8" />
          </div>
        </div>
        <div className="min-w-[180px]">
          <Label className="text-xs">{t("companyContracts.status")}</Label>
          <Select value={filterStatus} onValueChange={setFilterStatus}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("companyContracts.all")}</SelectItem>
              <SelectItem value="active">{t("companyContracts.statusActive")}</SelectItem>
              <SelectItem value="expiring_soon">{t("companyContracts.statusExpiringSoon")}</SelectItem>
              <SelectItem value="expired">{t("companyContracts.statusExpired")}</SelectItem>
              <SelectItem value="no_dates">{t("companyContracts.statusNoDates")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="min-w-[180px]">
          <Label className="text-xs">{t("companyContracts.company")}</Label>
          <Select value={filterCompany} onValueChange={setFilterCompany}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("companyContracts.all")}</SelectItem>
              {companies.map(c => (
                <SelectItem key={c} value={c}>{c}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="w-[120px]">
          <Label className="text-xs">{t("companyContracts.year")}</Label>
          <Input type="number" value={filterYear} onChange={e => setFilterYear(e.target.value)} placeholder="2025" />
        </div>
        <div className="w-[150px]">
          <Label className="text-xs">{t("companyContracts.filterEffectiveFrom")}</Label>
          <Input type="date" value={filterEffectiveFrom} onChange={e => setFilterEffectiveFrom(e.target.value)} />
        </div>
        <div className="w-[150px]">
          <Label className="text-xs">{t("companyContracts.filterEffectiveTo")}</Label>
          <Input type="date" value={filterEffectiveTo} onChange={e => setFilterEffectiveTo(e.target.value)} />
        </div>
        <div className="w-[150px]">
          <Label className="text-xs">{t("companyContracts.filterExpiryFrom")}</Label>
          <Input type="date" value={filterExpiryFrom} onChange={e => setFilterExpiryFrom(e.target.value)} />
        </div>
        <div className="w-[150px]">
          <Label className="text-xs">{t("companyContracts.filterExpiryTo")}</Label>
          <Input type="date" value={filterExpiryTo} onChange={e => setFilterExpiryTo(e.target.value)} />
        </div>
        {(filterCompany !== "all" || filterEffectiveFrom || filterEffectiveTo || filterExpiryFrom || filterExpiryTo || filterYear || filterStatus !== "all") && (
          <div>
            <Button variant="ghost" size="sm" onClick={() => {
              setFilterCompany("all"); setFilterEffectiveFrom(""); setFilterEffectiveTo("");
              setFilterExpiryFrom(""); setFilterExpiryTo(""); setFilterYear(""); setFilterStatus("all");
            }}>{t("companyContracts.clearFilters")}</Button>
          </div>
        )}
      </Card>

      <Card className="p-0 overflow-hidden">
        {loading ? (
          <div className="p-12 text-center text-muted-foreground"><Loader2 className="w-6 h-6 mx-auto animate-spin" /></div>
        ) : filteredRows.length === 0 ? (
          <div className="p-12 text-center text-muted-foreground">{t("companyContracts.emptyList")}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40">
                <tr>
                  <th className="text-left px-4 py-3">{t("companyContracts.colCompany")}</th>
                  <th className="text-left px-4 py-3">{t("companyContracts.colCountry")}</th>
                  <th className="text-left px-4 py-3">{t("companyContracts.colYear")}</th>
                  <th className="text-left px-4 py-3">{t("companyContracts.colEffective")}</th>
                  <th className="text-left px-4 py-3">{t("companyContracts.colExpiry")}</th>
                  <th className="text-left px-4 py-3">{t("companyContracts.colDaysLeft")}</th>
                  <th className="text-left px-4 py-3">{t("companyContracts.colStatus")}</th>
                  <th className="text-left px-4 py-3">{t("companyContracts.colFile")}</th>
                  <th className="text-right px-4 py-3">{t("companyContracts.colActions")}</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map(c => {
                  const meta = STATUS_LABELS[c.status];
                  const Icon = meta.icon;
                  const dl = daysLeft(c.expiryDate);
                  const tooltipText = dl === null ? t("companyContracts.tooltipNoExpiry") :
                    dl < 0 ? t(Math.abs(dl) === 1 ? "companyContracts.tooltipExpiredAgo" : "companyContracts.tooltipExpiredAgoPlural", { n: Math.abs(dl) }) :
                    t("companyContracts.tooltipExpiresOn", { date: formatDate(c.expiryDate, locale) });
                  const daysSuffix = t("companyContracts.daysSuffix");
                  const daysCellText = dl === null ? "-" :
                    dl < 0 ? `−${Math.abs(dl)} ${daysSuffix}` :
                    dl === 0 ? t("companyContracts.today") :
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
                          <span className="w-6 h-6 rounded bg-muted inline-flex items-center justify-center text-[10px] text-muted-foreground">
                            {(c.companyName || "?").slice(0, 1).toUpperCase()}
                          </span>
                          <span>{c.companyName || `#${c.id}`}</span>
                        </span>
                      </td>
                      <td className="px-4 py-3">{c.country || "-"}</td>
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
                            <Download className="w-4 h-4 mr-1" /> {c.fileName ? (c.fileName.length > 24 ? c.fileName.slice(0, 24) + "…" : c.fileName) : t("companyContracts.download")}
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
              {editing ? t("companyContracts.editContract") : t("companyContracts.newContract")}
            </DialogTitle>
          </DialogHeader>
          <div className="px-5 py-4 space-y-4 overflow-y-auto">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">{t("companyContracts.company")} *</Label>
              <Input className="h-9" value={form.companyName} onChange={e => setForm(f => ({ ...f, companyName: e.target.value }))} placeholder={t("companyContracts.companyPlaceholder")} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">{t("companyContracts.country")}</Label>
              <Input className="h-9" value={form.country} onChange={e => setForm(f => ({ ...f, country: e.target.value }))} placeholder={t("companyContracts.countryPlaceholder")} />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">{t("companyContracts.year")}</Label>
                <Input className="h-9" type="number" value={form.year} onChange={e => setForm(f => ({ ...f, year: e.target.value }))} placeholder="2025" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">{t("companyContracts.effectiveDate")}</Label>
                <Input className="h-9" type="date" value={form.effectiveDate} onChange={e => setForm(f => ({ ...f, effectiveDate: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">{t("companyContracts.expiryDate")}</Label>
                <Input className="h-9" type="date" value={form.expiryDate} onChange={e => setForm(f => ({ ...f, expiryDate: e.target.value }))} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">{t("companyContracts.notes")}</Label>
              <Textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={2} />
            </div>
            <div className="space-y-1.5">
              <div>
                <Label className="text-xs font-medium">{t("companyContracts.contractStaffLabel")}</Label>
                <p className="text-[11px] leading-snug text-muted-foreground mt-0.5">
                  {t("companyContracts.contractStaffHelp")}
                </p>
              </div>
              {staffUsers.length === 0 ? (
                <div className="text-xs text-muted-foreground border rounded-md p-2 bg-muted/20">{t("companyContracts.noStaffFound")}</div>
              ) : (
                <MultiSelectFilter
                  values={form.assignedUserIds.map(String)}
                  onChange={(vals) => setForm(f => ({ ...f, assignedUserIds: vals.map(Number) }))}
                  options={staffUsers.map(u => {
                    const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || `#${u.id}`;
                    return { value: String(u.id), label: `${name} (${u.role})` };
                  })}
                  placeholder={t("companyContracts.selectStaffPlaceholder")}
                />
              )}
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">{t("companyContracts.fileLabel")}</Label>
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
                  {form.fileObjectKey ? t("companyContracts.fileReplace") : t("companyContracts.fileUpload")}
                </Button>
                {form.fileName && <span className="text-xs text-muted-foreground truncate max-w-[200px]">{form.fileName}</span>}
              </div>
              <p className="text-[11px] text-muted-foreground">{t("companyContracts.fileAcceptedTypes")}</p>
            </div>
          </div>
          <DialogFooter className="px-5 py-3 border-t shrink-0 bg-muted/20">
            <Button variant="outline" size="sm" onClick={() => setShowDialog(false)}>{t("companyContracts.cancel")}</Button>
            <Button size="sm" onClick={save} disabled={saving}>
              {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
              {t("companyContracts.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("companyContracts.trashTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmDelete ? t("companyContracts.trashDesc", { name: confirmDelete.companyName || t("companyContracts.colCompany") }) : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("companyContracts.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={performDelete} className="bg-red-600 hover:bg-red-700">{t("companyContracts.trashAction")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
    </TooltipProvider>
  );
}
