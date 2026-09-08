import { useEffect, useMemo, useState } from "react";
import { customFetch } from "@workspace/api-client-react";
import { fmtDate, fmtDateTime } from "@/lib/formatDate";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/hooks/use-i18n";
import { Send, Loader2, FileSignature, RotateCw, Ban, Download, Trash2, ChevronUp, ChevronDown, ChevronsUpDown, AlertTriangle } from "lucide-react";
import { ContractAssociationLink } from "@/components/contracts/ContractAssociationLink";
import { ContractSubjectPicker, type ContractSubjectSearchResult } from "@/components/contracts/ContractSubjectPicker";
import { SYSTEM_LANGUAGE_LABELS } from "@/lib/i18n";

const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

type Session = {
  id: number; templateId: number; agentId: number | null; mode: string; status: string;
  signerEmail: string; signerName: string | null; expiresAt: string;
  openedAt: string | null; signedAt: string | null; revokedAt: string | null; createdAt: string;
  subjectType: string | null; subjectId: number | null; subjectLabel: string | null;
  isPrimaryOnboarding?: boolean;
};
type Signed = {
  id: number; signingSessionId: number; agentId: number | null; templateId: number;
  pdfObjectKey: string | null; evidenceHash: string | null; signerEmail: string; signerName: string | null; signedAt: string;
  subjectType: string | null; subjectId: number | null; subjectLabel: string | null;
  templateTitle?: string | null;
};
type Template = {
  id: number;
  name: string;
  language: string;
  entityType: string;
  version: number;
  isActive: boolean;
  publicationStatus: "published";
  signingPageConfig?: { requireEmailVerification?: boolean } | null;
};

const LANG_LABELS = SYSTEM_LANGUAGE_LABELS;

const SUBJECT_TYPES = ["agent", "company", "university", "student", "lead", "application", "other"] as const;
const SUBJECT_LABELS: Record<string, string> = {
  agent: "Agent", company: "Company", university: "University", student: "Student",
  lead: "Lead", application: "Application", other: "Other",
};

export default function ContractsPage() {
  const { toast } = useToast();
  const { t } = useI18n();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [signed, setSigned] = useState<Signed[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"sessions" | "signed">("sessions");
  const [downloadingId, setDownloadingId] = useState<number | null>(null);
  const [regeneratingId, setRegeneratingId] = useState<number | null>(null);

  // The signed PDF is produced asynchronously by a background worker. The
  // endpoint returns 202 while it is still being generated, so we fetch it from
  // JS and surface a friendly toast instead of opening the raw 202 JSON.
  async function downloadSignedPdf(id: number) {
    setDownloadingId(id);
    try {
      const res = await fetch(`${BASE_URL}/api/contracts/signed/${id}/pdf`, {
        credentials: "include",
      });
      if (res.status === 202) {
        toast({ title: t("signedContract.pdfPending") });
        return;
      }
      if (!res.ok) {
        toast({ title: t("signedContract.pdfDownloadError"), variant: "destructive" });
        return;
      }
      const blob = await res.blob();
      const cd = res.headers.get("Content-Disposition") || "";
      const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
      const filename = m ? decodeURIComponent(m[1]) : `contract-${id}.pdf`;
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (err: any) {
      toast({ title: t("signedContract.pdfDownloadError"), description: err?.message, variant: "destructive" });
    } finally {
      setDownloadingId(null);
    }
  }

  // Force a re-render of an already-generated PDF (e.g. to pick up the
  // main-agency seal added after the contract was first signed). The backend
  // clears the render cache and a background worker rebuilds the PDF off the
  // request path; the new file is downloadable within ~30s.
  async function regeneratePdf(id: number) {
    setRegeneratingId(id);
    try {
      await customFetch(`/api/contracts/signed/${id}/regenerate`, { method: "POST" });
      toast({ title: t("signedContract.regenerateQueued") });
    } catch (err: any) {
      toast({ title: t("signedContract.regenerateError"), description: err?.message, variant: "destructive" });
    } finally {
      setRegeneratingId(null);
    }
  }

  const [showSendDialog, setShowSendDialog] = useState(false);
  const [signerName, setSignerName] = useState("");
  const [signerEmail, setSignerEmail] = useState("");
  const [subjectType, setSubjectType] = useState("");
  const [subjectId, setSubjectId] = useState("");
  const [subjectLabel, setSubjectLabel] = useState("");
  const [templateId, setTemplateId] = useState<string>("auto");
  const [expiryDays, setExpiryDays] = useState("14");
  const [sending, setSending] = useState(false);
  const selectedTemplate = templates.find(template => String(template.id) === templateId) || null;

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);

  type SortDir = "asc" | "desc";
  type SortState = { key: string; dir: SortDir } | null;
  const [sessionSort, setSessionSort] = useState<SortState>(null);
  const [signedSort, setSignedSort] = useState<SortState>(null);

  // Click cycle per column: unsorted -> ascending -> descending -> unsorted.
  function nextSort(current: SortState, key: string): SortState {
    if (!current || current.key !== key) return { key, dir: "asc" };
    if (current.dir === "asc") return { key, dir: "desc" };
    return null;
  }
  // Direction-aware sort that always pushes null/empty values last, in BOTH asc
  // and desc — the direction only flips the order of the populated values, never
  // the null placement (negating a null-aware comparator would float nulls up).
  function sortByDir<T>(arr: T[], getVal: (x: T) => string | number | null, dir: SortDir): T[] {
    return [...arr].sort((a, b) => {
      const va = getVal(a), vb = getVal(b);
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      const r = (typeof va === "number" && typeof vb === "number") ? va - vb : String(va).localeCompare(String(vb));
      return dir === "asc" ? r : -r;
    });
  }

  const STATUS_LABELS: Record<string, { label: string; tone: "default" | "secondary" | "destructive" | "outline" }> = {
    intake_pending: { label: t("contracts.statusIntakePending"), tone: "secondary" },
    review_pending: { label: t("contracts.statusReviewPending"), tone: "default" },
    signed: { label: t("contracts.statusSigned"), tone: "outline" },
    revoked: { label: t("contracts.statusRevoked"), tone: "destructive" },
    expired: { label: t("contracts.statusExpired"), tone: "destructive" },
  };

  async function load() {
    setLoading(true);
    try {
      const [s, sc]: any = await Promise.all([
        customFetch(`/api/contracts/sessions?mode=admin_driven`),
        customFetch(`/api/contracts/signed`),
      ]);
      setSessions(s.data || []);
      setSigned(sc.data || []);
      setSelected(new Set());
      try {
        const tpls: any = await customFetch(`/api/contract-templates?isActive=true&publicationStatus=published`);
        const published = (tpls.data || []).filter((template: Template) => template.isActive && template.publicationStatus === "published");
        setTemplates(published);
        setTemplateId(current => current === "auto" || published.some((template: Template) => String(template.id) === current)
          ? current
          : "auto");
      } catch (tErr: any) {
        setTemplates([]);
        toast({ title: t("contracts.templatesLoadError"), description: tErr.message, variant: "destructive" });
      }
    } catch (err: any) {
      toast({ title: t("contracts.error"), description: err.message, variant: "destructive" });
    }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function send() {
    const linkedAgent = subjectType === "agent" && Number(subjectId) > 0;
    const normalizedEmail = signerEmail.trim();
    if (!linkedAgent && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      toast({ title: "Enter a valid signer email", variant: "destructive" }); return;
    }
    if (subjectType && subjectType !== "other" && (!subjectId || Number(subjectId) < 1)) {
      toast({ title: "Select a record for the association", variant: "destructive" }); return;
    }
    if (templateId === "auto" && !linkedAgent) {
      toast({ title: "Select a contract template when no agent is linked", variant: "destructive" }); return;
    }
    setSending(true);
    try {
      await customFetch(`/api/contracts/admin-send`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          signerName: signerName.trim() || undefined,
          signerEmail: normalizedEmail || undefined,
          templateId: templateId !== "auto" ? parseInt(templateId, 10) : undefined,
          expiryDays: Number(expiryDays),
          subjectType: subjectType || null,
          subjectId: subjectId ? Number(subjectId) : null,
          subjectLabel: subjectLabel || null,
        }),
      });
      toast({ title: t("contracts.sentTitle") });
      setShowSendDialog(false);
      resetSendForm();
      await load();
    } catch (err: any) {
      toast({ title: t("contracts.error"), description: err.message, variant: "destructive" });
    }
    setSending(false);
  }

  function resetSendForm() {
    setSignerName("");
    setSignerEmail("");
    setSubjectType("");
    setSubjectId("");
    setSubjectLabel("");
    setTemplateId("auto");
    setExpiryDays("14");
  }

  function handleSubjectChange(id: string, label: string, result?: ContractSubjectSearchResult) {
    setSubjectId(id);
    setSubjectLabel(label);
    if (subjectType === "agent" && id) {
      if (!signerName.trim()) setSignerName(label);
      if (!signerEmail.trim() && result?.email) setSignerEmail(result.email);
    }
  }

  async function revoke(id: number) {
    if (!confirm(t("contracts.confirmRevoke"))) return;
    try {
      await customFetch(`/api/contracts/sessions/${id}/revoke`, { method: "POST" });
      toast({ title: t("contracts.revokedTitle") });
      await load();
    } catch (err: any) { toast({ title: t("contracts.error"), description: err.message, variant: "destructive" }); }
  }
  async function resendOnboarding(agentId: number) {
    if (!confirm(t("contracts.confirmResendOnboarding"))) return;
    try {
      const res: any = await customFetch(`/api/contracts/agent/${agentId}/resend-onboarding`, { method: "POST" });
      toast({ title: t("contracts.onboardingResentTitle"), description: t("contracts.onboardingResentDesc", { date: fmtDateTime(res.data?.expiresAt) }) });
      await load();
    } catch (err: any) { toast({ title: t("contracts.error"), description: err.message, variant: "destructive" }); }
  }
  async function resend(id: number) {
    try {
      const res: any = await customFetch(`/api/contracts/sessions/${id}/resend`, { method: "POST" });
      toast({ title: t("contracts.resentTitle"), description: t("contracts.sentDesc", { url: res.data?.signUrl }) });
      await load();
    } catch (err: any) { toast({ title: t("contracts.error"), description: err.message, variant: "destructive" }); }
  }

  async function deleteSession(id: number) {
    const session = sessions.find(s => s.id === id);
    if (session?.status === "signed") return;
    if (!confirm(t("contracts.confirmDeleteSession"))) return;
    try {
      await customFetch(`/api/contracts/sessions/${id}`, { method: "DELETE" });
      toast({ title: t("contracts.sessionDeleted") });
      await load();
    } catch (err: any) { toast({ title: t("contracts.error"), description: err.message, variant: "destructive" }); }
  }

  function toggleSelect(id: number) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    const deletable = sessions.filter(s => s.status !== "signed" && s.status !== "revoked").map(s => s.id);
    if (deletable.every(id => selected.has(id)) && deletable.length > 0) {
      setSelected(new Set());
    } else {
      setSelected(new Set(deletable));
    }
  }

  async function bulkDelete() {
    if (!confirm(t("common.confirmBulkDelete", { n: selected.size }))) return;
    setBulkDeleting(true);
    let failed = 0;
    for (const id of Array.from(selected)) {
      try { await customFetch(`/api/contracts/sessions/${id}`, { method: "DELETE" }); }
      catch { failed++; }
    }
    if (failed > 0) toast({ title: t("common.error"), description: t("common.bulkDeletePartialFailure", { n: failed }), variant: "destructive" });
    else toast({ title: t("contracts.sessionsBulkDeleted") });
    setBulkDeleting(false);
    await load();
  }

  const deletableSessions = sessions.filter(s => s.status !== "signed" && s.status !== "revoked");
  const allDeletableSelected = deletableSessions.length > 0 && deletableSessions.every(s => selected.has(s.id));

  const sortedSessions = useMemo(() => {
    if (!sessionSort) return sessions;
    const getVal = (s: Session): string | number | null => {
      switch (sessionSort.key) {
        case "signer": return (s.signerName || s.signerEmail || "").toLowerCase();
        case "status": return s.status;
        case "association": return `${s.subjectType || ""}:${s.subjectId || ""}:${s.subjectLabel || ""}`.toLowerCase();
        case "opened": return s.openedAt ? new Date(s.openedAt).getTime() : null;
        case "expires": return s.expiresAt ? new Date(s.expiresAt).getTime() : null;
        default: return null;
      }
    };
    return sortByDir(sessions, getVal, sessionSort.dir);
  }, [sessions, sessionSort]);

  const sortedSigned = useMemo(() => {
    if (!signedSort) return signed;
    const getVal = (c: Signed): string | number | null => {
      switch (signedSort.key) {
        case "signer": return (c.signerName || c.signerEmail || "").toLowerCase();
        case "date": return c.signedAt ? new Date(c.signedAt).getTime() : null;
        case "evidence": return c.evidenceHash || null;
        case "title": return (c.templateTitle || "").toLowerCase();
        case "association": return `${c.subjectType || ""}:${c.subjectId || ""}:${c.subjectLabel || ""}`.toLowerCase();
        default: return null;
      }
    };
    return sortByDir(signed, getVal, signedSort.dir);
  }, [signed, signedSort]);

  const sortTh = (label: string, sortKey: string, state: SortState, setState: (s: SortState) => void, align: "left" | "right" = "left") => {
    const active = state?.key === sortKey;
    return (
      <th className={`px-4 py-3 ${align === "right" ? "text-right" : "text-left"}`}>
        <button type="button" onClick={() => setState(nextSort(state, sortKey))} className={`inline-flex items-center gap-1 font-medium hover:text-foreground ${align === "right" ? "flex-row-reverse" : ""}`}>
          {label}
          {active ? (state!.dir === "asc" ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />) : <ChevronsUpDown className="w-3.5 h-3.5 opacity-40" />}
        </button>
      </th>
    );
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><FileSignature className="w-6 h-6" /> {t("contracts.title")}</h1>
          <p className="text-sm text-muted-foreground mt-1">{t("contracts.subtitle")}</p>
        </div>
        <Button onClick={() => setShowSendDialog(true)}><Send className="w-4 h-4 mr-2" /> {t("contracts.sendSigningRequest")}</Button>
      </div>

      <div className="flex gap-2 border-b">
        <button onClick={() => { setTab("sessions"); setSelected(new Set()); }} className={`px-4 py-2 text-sm font-medium ${tab === "sessions" ? "border-b-2 border-primary" : "text-muted-foreground"}`}>
          {t("contracts.tabSessions")} ({sessions.length})
        </button>
        <button onClick={() => { setTab("signed"); setSelected(new Set()); }} className={`px-4 py-2 text-sm font-medium ${tab === "signed" ? "border-b-2 border-primary" : "text-muted-foreground"}`}>
          {t("contracts.tabSigned")} ({signed.length})
        </button>
      </div>

      {tab === "sessions" && selected.size > 0 && (
        <div className="flex items-center gap-3 px-4 py-2 bg-muted/60 rounded-lg border">
          <span className="text-sm font-medium">{t("common.selectedCount", { n: selected.size })}</span>
          <Button size="sm" variant="destructive" onClick={bulkDelete} disabled={bulkDeleting}>
            {bulkDeleting ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <Trash2 className="w-3.5 h-3.5 mr-1" />}
            {t("common.deleteSelected", { n: selected.size })}
          </Button>
        </div>
      )}

      <Card className="p-0 overflow-hidden">
        {loading ? (
          <div className="p-12 text-center text-muted-foreground"><Loader2 className="w-6 h-6 mx-auto animate-spin" /></div>
        ) : tab === "sessions" ? (
          sessions.length === 0 ? (
            <div className="p-12 text-center text-muted-foreground">{t("contracts.noSessions")}</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-muted/40">
                <tr>
                  <th className="px-4 py-3 w-10">
                    <input type="checkbox" checked={allDeletableSelected} onChange={toggleAll} className="cursor-pointer" title={t("common.selectAll")} />
                  </th>
                  {sortTh(t("contracts.colSigner"), "signer", sessionSort, setSessionSort)}
                  {sortTh("Association", "association", sessionSort, setSessionSort)}
                  {sortTh(t("contracts.colStatus"), "status", sessionSort, setSessionSort)}
                  {sortTh(t("contracts.colOpened"), "opened", sessionSort, setSessionSort)}
                  {sortTh(t("contracts.colExpires"), "expires", sessionSort, setSessionSort)}
                  <th className="text-right px-4 py-3">{t("contracts.colActions")}</th>
                </tr>
              </thead>
              <tbody>
                {sortedSessions.map(s => {
                  const canDelete = s.status !== "signed" && s.status !== "revoked";
                  return (
                    <tr key={s.id} className="border-t">
                      <td className="px-4 py-3">
                        {canDelete ? (
                          <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggleSelect(s.id)} className="cursor-pointer" />
                        ) : null}
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium flex items-center gap-2">
                          {s.signerName || "-"}
                          {s.isPrimaryOnboarding && <Badge variant="secondary" className="text-[10px] px-1.5 py-0">{t("contracts.onboarding")}</Badge>}
                        </div>
                        <div className="text-xs text-muted-foreground">{s.signerEmail}</div>
                      </td>
                      <td className="px-4 py-3 text-xs">
                        <ContractAssociationLink subjectType={s.subjectType} subjectId={s.subjectId} subjectLabel={s.subjectLabel} />
                      </td>
                      <td className="px-4 py-3"><Badge variant={STATUS_LABELS[s.status]?.tone}>{STATUS_LABELS[s.status]?.label || s.status}</Badge></td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">{s.openedAt ? fmtDateTime(s.openedAt) : "-"}</td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">{fmtDateTime(s.expiresAt)}</td>
                      <td className="px-4 py-3 text-right space-x-1">
                        {s.status !== "signed" && s.status !== "revoked" && (
                          <>
                            <Button size="sm" variant="ghost" title={t("contracts.actionResend")} onClick={() => resend(s.id)}><RotateCw className="w-4 h-4" /></Button>
                            <Button size="sm" variant="ghost" title={t("contracts.actionRevoke")} onClick={() => revoke(s.id)}><Ban className="w-4 h-4 text-red-500" /></Button>
                          </>
                        )}
                        {s.isPrimaryOnboarding && (s.status === "expired" || s.status === "revoked") && s.agentId && (
                          <Button size="sm" variant="outline" title={t("contracts.actionResendOnboarding")} onClick={() => resendOnboarding(s.agentId!)}>
                            <RotateCw className="w-3.5 h-3.5 mr-1" /> {t("contracts.resendOnboardingShort")}
                          </Button>
                        )}
                        <Button
                          size="sm" variant="ghost"
                          title={canDelete ? t("common.delete") : t("contracts.cannotDeleteSigned")}
                          onClick={() => deleteSession(s.id)}
                          disabled={!canDelete}
                        >
                          <Trash2 className={`w-4 h-4 ${canDelete ? "text-red-500" : "text-muted-foreground"}`} />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )
        ) : signed.length === 0 ? (
          <div className="p-12 text-center text-muted-foreground">{t("contracts.noSigned")}</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/40">
              <tr>
                {sortTh(t("contracts.colSigner"), "signer", signedSort, setSignedSort)}
                {sortTh("Association", "association", signedSort, setSignedSort)}
                {sortTh(t("contracts.colTitle"), "title", signedSort, setSignedSort)}
                {sortTh(t("contracts.colDate"), "date", signedSort, setSignedSort)}
                {sortTh(t("contracts.colEvidenceHash"), "evidence", signedSort, setSignedSort)}
                <th className="text-right px-4 py-3">{t("contracts.colPdf")}</th>
              </tr>
            </thead>
            <tbody>
              {sortedSigned.map(c => (
                <tr key={c.id} className="border-t">
                  <td className="px-4 py-3">
                    <div className="font-medium">{c.signerName || "-"}</div>
                    <div className="text-xs text-muted-foreground">{c.signerEmail}</div>
                  </td>
                  <td className="px-4 py-3 text-xs">
                    <ContractAssociationLink subjectType={c.subjectType} subjectId={c.subjectId} subjectLabel={c.subjectLabel} />
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{c.templateTitle || "—"}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{fmtDate(c.signedAt)}</td>
                  <td className="px-4 py-3 text-xs font-mono text-muted-foreground">{c.evidenceHash ? c.evidenceHash.slice(0, 16) + "…" : "—"}</td>
                  <td className="px-4 py-3 text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      title={t("signedContract.regenerate")}
                      disabled={regeneratingId === c.id}
                      onClick={() => regeneratePdf(c.id)}
                    >
                      {regeneratingId === c.id
                        ? <Loader2 className="w-4 h-4 animate-spin" />
                        : <RotateCw className="w-4 h-4" />}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      title={t("signedContract.download")}
                      disabled={downloadingId === c.id}
                      onClick={() => downloadSignedPdf(c.id)}
                    >
                      {downloadingId === c.id
                        ? <Loader2 className="w-4 h-4 animate-spin" />
                        : <Download className="w-4 h-4" />}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Dialog open={showSendDialog} onOpenChange={(open) => { setShowSendDialog(open); if (!open) resetSendForm(); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t("contracts.sendSigningRequest")}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Signer name</Label>
                <Input value={signerName} onChange={event => setSignerName(event.target.value)} placeholder="Name or company" />
              </div>
              <div>
                <Label>Signer email *</Label>
                <Input type="email" value={signerEmail} onChange={event => setSignerEmail(event.target.value)} placeholder="name@example.com" />
              </div>
            </div>
            <div>
              <Label>Associate with (optional)</Label>
              <Select value={subjectType || "none"} onValueChange={value => {
                setSubjectType(value === "none" ? "" : value);
                setSubjectId("");
                setSubjectLabel("");
              }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No association</SelectItem>
                  {SUBJECT_TYPES.map(type => <SelectItem key={type} value={type}>{SUBJECT_LABELS[type]}</SelectItem>)}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1">Linking an agent, company or another record is optional.</p>
            </div>
            {subjectType && <div>
              <Label>{subjectType === "other" ? "Association label" : `Select ${SUBJECT_LABELS[subjectType]}`}</Label>
              {subjectType === "other" ? (
                <Input value={subjectLabel} onChange={event => setSubjectLabel(event.target.value)} placeholder="Name or reference" />
              ) : (
                <ContractSubjectPicker
                  subjectType={subjectType}
                  subjectId={subjectId}
                  subjectLabel={subjectLabel}
                  onChange={handleSubjectChange}
                />
              )}
            </div>}
            <div>
              <Label>{t("contracts.contractTemplate")}</Label>
              <Select value={templateId} onValueChange={setTemplateId}>
                <SelectTrigger><SelectValue placeholder={t("contracts.selectTemplatePlaceholder")} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">{t("contracts.selectTemplatePlaceholder")}</SelectItem>
                  {templates.map(tpl => (
                    <SelectItem key={tpl.id} value={String(tpl.id)}>
                      {tpl.name} — {LANG_LABELS[tpl.language] || tpl.language} · {tpl.entityType === "individual" ? t("contractTemplates.entityIndividual") : t("contractTemplates.entityCompany")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1">Auto-match is available for linked agents. Otherwise select a template.</p>
              {selectedTemplate?.signingPageConfig?.requireEmailVerification === false && (
                <div className="mt-2 flex gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{t("contractTemplates.emailVerificationOffWarning")}</span>
                </div>
              )}
            </div>
            <div>
              <Label>Link validity (days)</Label>
              <Input type="number" min={1} max={90} value={expiryDays} onChange={event => setExpiryDays(event.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowSendDialog(false)}>{t("contracts.cancel")}</Button>
            <Button onClick={send} disabled={sending}>{sending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Send className="w-4 h-4 mr-2" />} {t("contracts.send")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
