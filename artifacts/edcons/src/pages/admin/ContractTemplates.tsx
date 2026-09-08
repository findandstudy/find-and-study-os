import { useEffect, useState, useMemo } from "react";
import { customFetch } from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/hooks/use-i18n";
import { FileText, Plus, Edit, Trash2, Loader2, ChevronDown, ChevronUp, AlertTriangle, ArrowRight, Palette, Send, CheckCircle2, Copy } from "lucide-react";
import { ContractRichTextEditor } from "@/components/contracts/ContractRichTextEditor";
import { ContractFieldBuilder, type ContractIntakeField } from "@/components/contracts/ContractFieldBuilder";
import { ContractBrandProfilesDialog, type ContractBrandProfile } from "@/components/contracts/ContractBrandProfilesDialog";
import { SYSTEM_LANGUAGE_OPTIONS } from "@/lib/i18n";

type Template = {
  id: number;
  name: string;
  title: string;
  language: string;
  entityType: "company" | "individual";
  version: number;
  bodyHtml: string;
  intakeSchema: any;
  signingPageConfig: Partial<SigningPageConfig> | null;
  brandProfileId: number | null;
  publicationStatus: "draft" | "review_pending" | "published" | "archived";
  isActive: boolean;
  updatedAt: string;
};

type IntakeField = ContractIntakeField;

const LANGUAGES = SYSTEM_LANGUAGE_OPTIONS;

const STARTER_BODY = `<h1>Service Agreement</h1>
<p>This Service Agreement is made on {{contract.date}} between Find And Study OS and {{agent.businessName}}.</p>
<h2>1. Parties</h2>
<p><strong>Agent:</strong> {{agent.firstName}} {{agent.lastName}} — {{agent.businessName}}</p>
<p><strong>Email:</strong> {{agent.email}}</p>
<p><strong>Country:</strong> {{agent.country}}</p>
<p><strong>Tax number:</strong> {{agent.taxNumber}}</p>
<h2>2. Scope</h2>
<p>The Agent agrees to provide student recruitment services in accordance with the standard terms.</p>
<h2>3. Signature</h2>
<p>Signed by {{contract.signerName}} ({{contract.signerEmail}}) on {{contract.date}}.</p>`;

const STARTER_INTAKE: IntakeField[] = [
  { key: "fullName", label: "Full Name", type: "text", required: true },
  { key: "companyName", label: "Company / Trade Name", type: "text" },
  { key: "taxNumber", label: "Tax Number", type: "text" },
  { key: "address", label: "Address", type: "textarea" },
];

// Bridge aliases from contractRenderer.ts: camelCase intake keys → snake_case placeholders
const BRIDGE_ALIASES: Record<string, string> = {
  fullName: "contact_person_name",
  fullname: "contact_person_name",
  contactName: "contact_person_name",
  signerName: "contact_person_name",
  companyName: "agency_name",
  company: "agency_name",
  tradeName: "agency_name",
  legalName: "agency_name",
  agencyName: "agency_name",
  taxNumber: "tax_number",
  taxNo: "tax_number",
  taxId: "tax_number",
};

function resolveFieldPlaceholder(field: IntakeField): string {
  // Explicit override wins
  if (field.maps_to) return field.maps_to;
  // Known bridge alias
  if (BRIDGE_ALIASES[field.key]) return BRIDGE_ALIASES[field.key];
  // Direct match
  return field.key;
}

function placeholderInBody(placeholder: string, bodyHtml: string): boolean {
  // Check for both {{placeholder}} and {{{placeholder}}} forms
  return bodyHtml.includes(`{{${placeholder}}}`) || bodyHtml.includes(`{{{${placeholder}}}}`) ||
    bodyHtml.includes(`{{intake.${placeholder}}}`) || bodyHtml.includes(`{{{intake.${placeholder}}}}`) ||
    bodyHtml.includes(`{{agent.${placeholder}}}`) || bodyHtml.includes(`{{{agent.${placeholder}}}}`) ||
    bodyHtml.includes(`{{contract.${placeholder}}}`) || bodyHtml.includes(`{{{contract.${placeholder}}}}`) ||
    bodyHtml.includes(`{{${placeholder}}`);
}

type SigningPageConfig = {
  brandName: string;
  logoUrl: string;
  primaryColor: string;
  accentColor: string;
  pageTitle: string;
  pageSubtitle: string;
  pdfHeaderText: string;
  pdfFooterText: string;
  companySignatureDataUrl: string;
  requireEmailVerification: boolean;
};

const EMPTY_SPC: SigningPageConfig = {
  brandName: "", logoUrl: "", primaryColor: "#143591", accentColor: "#0f766e",
  pageTitle: "", pageSubtitle: "", pdfHeaderText: "", pdfFooterText: "",
  companySignatureDataUrl: "",
  requireEmailVerification: true,
};

function FieldMappingPanel({ schema, bodyHtml, t }: { schema: IntakeField[]; bodyHtml: string; t: (k: string, p?: any) => string }) {
  if (!schema.length) {
    return <p className="text-xs text-muted-foreground italic">{t("contractTemplates.fieldMappingEmpty")}</p>;
  }
  return (
    <div className="divide-y border rounded-md overflow-hidden">
      {schema.map(field => {
        const placeholder = resolveFieldPlaceholder(field);
        const found = placeholderInBody(placeholder, bodyHtml);
        const isAlias = BRIDGE_ALIASES[field.key] && !field.maps_to;
        const isOverride = Boolean(field.maps_to);
        return (
          <div key={field.key} className="flex items-center gap-2 px-3 py-2 text-xs bg-card hover:bg-muted/30 transition-colors">
            <div className="flex-1 min-w-0">
              <span className="font-medium text-foreground">{field.label}</span>
              <span className="text-muted-foreground ml-1.5">({field.key})</span>
              {isAlias && <span className="ml-1.5 text-[10px] text-blue-500 uppercase tracking-wide">alias</span>}
              {isOverride && <span className="ml-1.5 text-[10px] text-purple-500 uppercase tracking-wide">maps_to</span>}
            </div>
            <ArrowRight className="w-3 h-3 shrink-0 text-muted-foreground" />
            <div className="flex items-center gap-1 shrink-0">
              <code className="font-mono text-emerald-700 dark:text-emerald-400">{`{{${placeholder}}}`}</code>
              {!found && (
                <span title={t("contractTemplates.fieldMappingNotInBody")}>
                  <AlertTriangle className="w-3 h-3 text-amber-500" />
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function ContractTemplatesPage() {
  const { toast } = useToast();
  const { t } = useI18n();
  const [rows, setRows] = useState<Template[]>([]);
  const [brands, setBrands] = useState<ContractBrandProfile[]>([]);
  const [brandDialogOpen, setBrandDialogOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showDialog, setShowDialog] = useState(false);
  const [editing, setEditing] = useState<Template | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    name: "",
    title: "",
    language: "en",
    entityType: "company" as "company" | "individual",
    version: 1,
    bodyHtml: STARTER_BODY,
    intakeSchema: STARTER_INTAKE as IntakeField[],
    isActive: true,
    brandProfileId: null as number | null,
    signingPageConfig: EMPTY_SPC,
  });
  const [signingPageOpen, setSigningPageOpen] = useState(false);

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const res: any = await customFetch(`/api/contract-templates`);
      setRows(res.data || []);
      setSelected(new Set());
    } catch (err: any) {
      toast({ title: t("contractTemplates.error"), description: err.message, variant: "destructive" });
    }
    setLoading(false);
  }

  async function loadBrands() {
    try {
      const response: any = await customFetch("/api/contract-brands");
      setBrands(response.data || []);
    } catch (error: any) {
      toast({ title: "Contract brands could not be loaded", description: error.message, variant: "destructive" });
    }
  }

  useEffect(() => { load(); loadBrands(); }, []);

  function openNew() {
    setEditing(null);
    setForm({
      name: "", title: "", language: "en", entityType: "company", version: 1,
      bodyHtml: STARTER_BODY, intakeSchema: STARTER_INTAKE, isActive: true,
      brandProfileId: null,
      signingPageConfig: EMPTY_SPC,
    });
    setSigningPageOpen(false);
    setShowDialog(true);
  }

  function openEdit(tpl: Template) {
    setEditing(tpl);
    const spc = tpl.signingPageConfig;
    setForm({
      name: tpl.name,
      title: tpl.title || "",
      language: tpl.language,
      entityType: tpl.entityType,
      version: tpl.version,
      bodyHtml: tpl.bodyHtml,
      intakeSchema: Array.isArray(tpl.intakeSchema) ? tpl.intakeSchema : STARTER_INTAKE,
      isActive: tpl.isActive,
      brandProfileId: tpl.brandProfileId || null,
      signingPageConfig: {
        brandName: spc?.brandName || "",
        logoUrl: spc?.logoUrl || "",
        primaryColor: spc?.primaryColor || "#143591",
        accentColor: spc?.accentColor || "#0f766e",
        pageTitle: spc?.pageTitle || "",
        pageSubtitle: spc?.pageSubtitle || "",
        pdfHeaderText: spc?.pdfHeaderText || "",
        pdfFooterText: spc?.pdfFooterText || "",
        companySignatureDataUrl: spc?.companySignatureDataUrl || "",
        // Missing is the secure legacy default: existing templates continue
        // to require mailbox verification until an administrator opts out.
        requireEmailVerification: spc?.requireEmailVerification !== false,
      },
    });
    setSigningPageOpen(Boolean(spc && Object.values(spc).some(Boolean)));
    setShowDialog(true);
  }

  function loadCompanySignature(file: File | undefined) {
    if (!file) return;
    if (!/^image\/(png|jpeg)$/.test(file.type) || file.size > 2 * 1024 * 1024) {
      toast({ title: "Signature must be a PNG or JPEG up to 2 MB", variant: "destructive" });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setForm(f => ({
      ...f,
      signingPageConfig: { ...f.signingPageConfig, companySignatureDataUrl: String(reader.result || "") },
    }));
    reader.readAsDataURL(file);
  }

  async function save() {
    if (!form.name.trim()) { toast({ title: t("contractTemplates.nameRequired"), variant: "destructive" }); return; }
    setSaving(true);
    try {
      const spc = form.signingPageConfig;
      const payload = {
        ...form,
        // A selected brand profile remains the single source of branding and
        // the official signature. The verification policy is template-owned,
        // so preserve it even when branding comes from a central profile.
        signingPageConfig: form.brandProfileId
          ? { requireEmailVerification: spc.requireEmailVerification }
          : spc,
      };
      const body = JSON.stringify(payload);
      if (editing) {
        await customFetch(`/api/contract-templates/${editing.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body });
      } else {
        await customFetch(`/api/contract-templates`, { method: "POST", headers: { "content-type": "application/json" }, body });
      }
      toast({
        title: editing ? t("contractTemplates.updated") : t("contractTemplates.created"),
        description: editing ? undefined : "Template saved as a draft. Publish it before creating or sending signing links.",
      });
      setShowDialog(false);
      await load();
    } catch (err: any) {
      toast({ title: t("contractTemplates.error"), description: err.message, variant: "destructive" });
    }
    setSaving(false);
  }

  async function workflowAction(template: Template, action: "submit-review" | "publish" | "new-version") {
    const labels = { "submit-review": "Submitted for review", publish: "Template published", "new-version": "New draft version created" };
    try {
      const response: any = await customFetch(`/api/contract-templates/${template.id}/${action}`, { method: "POST" });
      toast({ title: labels[action] });
      await load();
      if (action === "new-version" && response?.data) openEdit(response.data);
    } catch (error: any) {
      toast({ title: "Template workflow could not be updated", description: error.message, variant: "destructive" });
    }
  }

  function applyBrandProfile(value: string) {
    if (value === "none") {
      setForm(current => ({ ...current, brandProfileId: null }));
      return;
    }
    const brand = brands.find(item => item.id === Number(value));
    if (!brand) return;
    setForm(current => ({
      ...current,
      brandProfileId: brand.id,
      signingPageConfig: {
        ...EMPTY_SPC,
        requireEmailVerification: current.signingPageConfig.requireEmailVerification,
      },
    }));
    setSigningPageOpen(true);
  }

  async function remove(id: number) {
    if (!confirm(t("contractTemplates.confirmDelete"))) return;
    try {
      await customFetch(`/api/contract-templates/${id}`, { method: "DELETE" });
      toast({ title: t("contractTemplates.deleted") });
      await load();
    } catch (err: any) {
      toast({ title: t("contractTemplates.error"), description: err.message, variant: "destructive" });
    }
  }

  function toggleSelect(id: number) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (rows.every(r => selected.has(r.id)) && rows.length > 0) {
      setSelected(new Set());
    } else {
      setSelected(new Set(rows.map(r => r.id)));
    }
  }

  async function bulkDelete() {
    if (!confirm(t("common.confirmBulkDelete", { n: selected.size }))) return;
    setBulkDeleting(true);
    let failed = 0;
    for (const id of Array.from(selected)) {
      try { await customFetch(`/api/contract-templates/${id}`, { method: "DELETE" }); }
      catch { failed++; }
    }
    if (failed > 0) toast({ title: t("contractTemplates.error"), description: t("common.bulkDeletePartialFailure", { n: failed }), variant: "destructive" });
    else toast({ title: t("contractTemplates.bulkDeleted") });
    setBulkDeleting(false);
    await load();
  }

  const allSelected = rows.length > 0 && rows.every(r => selected.has(r.id));
  const editingPublished = editing?.publicationStatus === "published";
  const selectedBrand = form.brandProfileId
    ? brands.find(brand => brand.id === form.brandProfileId) || null
    : null;

  // Live-parse intake schema for the mapping panel
  const parsedSchema = useMemo<IntakeField[]>(() => {
    return Array.isArray(form.intakeSchema) ? form.intakeSchema : [];
  }, [form.intakeSchema]);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><FileText className="w-6 h-6" /> {t("contractTemplates.title")}</h1>
          <p className="text-sm text-muted-foreground mt-1">{t("contractTemplates.subtitle")} <code className="text-xs">{`{{agent.field}}, {{intake.field}}, {{contract.date}}, {{contract.signerName}}`}</code></p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setBrandDialogOpen(true)}><Palette className="w-4 h-4 mr-2" /> Brand profiles</Button>
          <Button onClick={openNew}><Plus className="w-4 h-4 mr-2" /> {t("contractTemplates.newTemplate")}</Button>
        </div>
      </div>

      {selected.size > 0 && (
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
        ) : rows.length === 0 ? (
          <div className="p-12 text-center text-muted-foreground">{t("contractTemplates.empty")}</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/40">
              <tr>
                <th className="px-4 py-3 w-10">
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} className="cursor-pointer" title={t("common.selectAll")} />
                </th>
                <th className="text-left px-4 py-3 font-medium">{t("contractTemplates.colName")}</th>
                <th className="text-left px-4 py-3 font-medium">{t("contractTemplates.colLanguage")}</th>
                <th className="text-left px-4 py-3 font-medium">{t("contractTemplates.colType")}</th>
                <th className="text-left px-4 py-3 font-medium">{t("contractTemplates.colVersion")}</th>
                <th className="text-left px-4 py-3 font-medium">{t("contractTemplates.colStatus")}</th>
                <th className="text-right px-4 py-3 font-medium">{t("contractTemplates.colActions")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(tpl => (
                <tr key={tpl.id} className="border-t">
                  <td className="px-4 py-3">
                    <input type="checkbox" checked={selected.has(tpl.id)} onChange={() => toggleSelect(tpl.id)} className="cursor-pointer" />
                  </td>
                  <td className="px-4 py-3 font-medium">{tpl.name}</td>
                  <td className="px-4 py-3 uppercase">{tpl.language}</td>
                  <td className="px-4 py-3">{tpl.entityType === "individual" ? t("contractTemplates.entityIndividual") : t("contractTemplates.entityCompany")}</td>
                  <td className="px-4 py-3">v{tpl.version}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant={tpl.publicationStatus === "published" ? "default" : tpl.publicationStatus === "review_pending" ? "secondary" : "outline"}>
                        {tpl.publicationStatus === "review_pending" ? "In review" : tpl.publicationStatus}
                      </Badge>
                      {tpl.signingPageConfig?.requireEmailVerification === false ? (
                        <Badge variant="outline" className="border-amber-400 bg-amber-50 text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                          <AlertTriangle className="mr-1 h-3 w-3" />
                          {t("contractTemplates.emailVerificationOffBadge")}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="border-emerald-400 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200">
                          <CheckCircle2 className="mr-1 h-3 w-3" />
                          {t("contractTemplates.emailVerificationRequiredBadge")}
                        </Badge>
                      )}
                      {!tpl.isActive && <Badge variant="secondary">{t("contractTemplates.statusInactive")}</Badge>}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right space-x-2">
                    <Button size="sm" variant="ghost" onClick={() => openEdit(tpl)}><Edit className="w-4 h-4" /></Button>
                    {tpl.publicationStatus === "draft" && <Button size="sm" variant="outline" title="Submit for review" onClick={() => workflowAction(tpl, "submit-review")}><Send className="w-4 h-4" /></Button>}
                    {(["draft", "review_pending"] as const).includes(tpl.publicationStatus as any) && <Button size="sm" variant="outline" title="Publish" onClick={() => workflowAction(tpl, "publish")}><CheckCircle2 className="w-4 h-4 mr-2" />Publish</Button>}
                    {tpl.publicationStatus === "published" && <Button size="sm" variant="outline" title="Create new version" onClick={() => workflowAction(tpl, "new-version")}><Copy className="w-4 h-4" /></Button>}
                    <Button size="sm" variant="ghost" onClick={() => remove(tpl.id)}><Trash2 className="w-4 h-4 text-red-500" /></Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? t("contractTemplates.editTemplate") : t("contractTemplates.newTemplate")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {editingPublished && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/20 px-4 py-3 text-sm text-amber-900 dark:text-amber-100">
                This version is published and its contract content, fields and branding are locked. Create a new version to make changes without altering already-issued contracts.
              </div>
            )}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label>{t("contractTemplates.colName")} *</Label>
                <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
                <Label className="mt-2 block">{t("contractTemplates.titleLabel")}</Label>
                <Input disabled={editingPublished} className="mt-1" placeholder={t("contractTemplates.titlePlaceholder")} value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <Label>{t("contractTemplates.colLanguage")}</Label>
                  <Select disabled={editingPublished} value={form.language} onValueChange={v => setForm(f => ({ ...f, language: v }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {LANGUAGES.map(l => <SelectItem key={l.code} value={l.code}>{l.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>{t("contractTemplates.colType")}</Label>
                  <Select disabled={editingPublished} value={form.entityType} onValueChange={v => setForm(f => ({ ...f, entityType: v as any }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="company">{t("contractTemplates.entityCompany")}</SelectItem>
                      <SelectItem value="individual">{t("contractTemplates.entityIndividual")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>{t("contractTemplates.colVersion")}</Label>
                  <Input disabled={Boolean(editing)} type="number" min={1} value={form.version} onChange={e => setForm(f => ({ ...f, version: parseInt(e.target.value, 10) || 1 }))} />
                </div>
              </div>
            </div>
            <div>
              <Label>{t("contractTemplates.bodyLabel")}</Label>
              <p className="text-xs text-muted-foreground mb-2">Write and format the agreement visually. HTML remains available in Advanced mode.</p>
              <ContractRichTextEditor value={form.bodyHtml} disabled={editingPublished} onChange={bodyHtml => setForm(current => ({ ...current, bodyHtml }))} />
            </div>
            <div>
              <Label>{t("contractTemplates.intakeSchemaLabel")}</Label>
              <p className="text-xs text-muted-foreground mb-2">Build the counterparty form field by field. Reorder fields and mark required information without writing JSON.</p>
              <ContractFieldBuilder value={parsedSchema} disabled={editingPublished} onChange={intakeSchema => setForm(current => ({ ...current, intakeSchema }))} />

              {/* Field → placeholder mapping panel */}
              {parsedSchema.length > 0 && (
                <div className="mt-3">
                  <p className="text-xs font-medium text-muted-foreground mb-1.5">{t("contractTemplates.fieldMappingTitle")}</p>
                  <FieldMappingPanel schema={parsedSchema} bodyHtml={form.bodyHtml} t={t} />
                </div>
              )}
              {parsedSchema.length === 0 && (
                <p className="text-xs text-muted-foreground italic mt-2">{t("contractTemplates.fieldMappingEmpty")}</p>
              )}
            </div>

            {/* Signing page branding section (collapsible) */}
            <div className="border rounded-lg overflow-hidden">
              <button
                type="button"
                onClick={() => setSigningPageOpen(o => !o)}
                className="w-full flex items-center justify-between px-4 py-3 bg-muted/40 hover:bg-muted/60 transition-colors text-sm font-medium text-left"
              >
                <span>{t("contractTemplates.signingPageSection")}</span>
                {signingPageOpen ? <ChevronUp className="w-4 h-4 shrink-0" /> : <ChevronDown className="w-4 h-4 shrink-0" />}
              </button>
              {signingPageOpen && (
                <div className="p-4 space-y-3 bg-background">
                  <div>
                    <Label className="text-xs">Reusable brand profile</Label>
                    <div className="flex gap-2 mt-1">
                      <Select disabled={editingPublished} value={form.brandProfileId ? String(form.brandProfileId) : "none"} onValueChange={applyBrandProfile}>
                        <SelectTrigger><SelectValue placeholder="Use template-specific branding" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">Template-specific branding</SelectItem>
                          {brands.filter(brand => brand.isActive).map(brand => <SelectItem key={brand.id} value={String(brand.id)}>{brand.name}</SelectItem>)}
                        </SelectContent>
                      </Select>
                      <Button type="button" variant="outline" onClick={() => setBrandDialogOpen(true)}><Palette className="h-4 w-4" /></Button>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">The selected profile is the central source for the logo, colors and official signature. A contract receives an immutable snapshot when its signing link is issued.</p>
                  </div>
                  {selectedBrand ? (
                    <div className="rounded-lg border bg-muted/20 p-4 space-y-3">
                      <div className="flex items-center gap-3">
                        {selectedBrand.config.logoUrl ? (
                          <img src={selectedBrand.config.logoUrl} alt="" className="h-12 w-20 rounded border bg-white object-contain p-1" />
                        ) : (
                          <div className="h-12 w-20 rounded border" style={{ background: selectedBrand.config.primaryColor || "#143591" }} />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="font-medium">{selectedBrand.name}</div>
                          <div className="text-xs text-muted-foreground">Managed centrally in Brand profiles</div>
                        </div>
                        <Badge variant={selectedBrand.hasCompanySignature ? "secondary" : "destructive"}>
                          {selectedBrand.hasCompanySignature ? "Signature ready" : "Signature required"}
                        </Badge>
                      </div>
                      {selectedBrand.hasCompanySignature && <p className="text-xs text-muted-foreground">The official signature is stored privately and appears only on the final signed PDF.</p>}
                      <Button type="button" size="sm" variant="outline" onClick={() => setBrandDialogOpen(true)}>
                        <Palette className="mr-2 h-4 w-4" /> Manage brand profile
                      </Button>
                    </div>
                  ) : <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <Label className="text-xs">Brand name</Label>
                      <Input disabled={editingPublished} className="mt-1" placeholder="Find And Study" value={form.signingPageConfig.brandName}
                        onChange={e => setForm(f => ({ ...f, signingPageConfig: { ...f.signingPageConfig, brandName: e.target.value } }))} />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <Label className="text-xs">Primary color</Label>
                        <Input disabled={editingPublished} className="mt-1 h-10 p-1" type="color" value={form.signingPageConfig.primaryColor}
                          onChange={e => setForm(f => ({ ...f, signingPageConfig: { ...f.signingPageConfig, primaryColor: e.target.value } }))} />
                      </div>
                      <div>
                        <Label className="text-xs">Accent color</Label>
                        <Input disabled={editingPublished} className="mt-1 h-10 p-1" type="color" value={form.signingPageConfig.accentColor}
                          onChange={e => setForm(f => ({ ...f, signingPageConfig: { ...f.signingPageConfig, accentColor: e.target.value } }))} />
                      </div>
                    </div>
                  </div>
                  <div>
                    <Label className="text-xs">{t("contractTemplates.signingPageLogoUrl")}</Label>
                    <Input
                      disabled={editingPublished}
                      className="mt-1"
                      placeholder="https://example.com/logo.png"
                      value={form.signingPageConfig.logoUrl}
                      onChange={e => setForm(f => ({ ...f, signingPageConfig: { ...f.signingPageConfig, logoUrl: e.target.value } }))}
                    />
                    <p className="text-xs text-muted-foreground mt-0.5">{t("contractTemplates.signingPageLogoUrlHint")}</p>
                    {form.signingPageConfig.logoUrl && (
                      <img
                        src={form.signingPageConfig.logoUrl}
                        alt="Logo preview"
                        className="mt-2 h-10 max-w-[200px] object-contain border rounded bg-[#143591] p-1"
                        onError={e => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                        onLoad={e => { (e.currentTarget as HTMLImageElement).style.display = "block"; }}
                      />
                    )}
                  </div>
                  <div>
                    <Label className="text-xs">{t("contractTemplates.signingPageTitle")}</Label>
                    <Input
                      disabled={editingPublished}
                      className="mt-1"
                      placeholder={t("contractTemplates.signingPageTitlePlaceholder")}
                      value={form.signingPageConfig.pageTitle}
                      onChange={e => setForm(f => ({ ...f, signingPageConfig: { ...f.signingPageConfig, pageTitle: e.target.value } }))}
                    />
                    <p className="text-xs text-muted-foreground mt-0.5">{t("contractTemplates.signingPageTitleHint")}</p>
                  </div>
                  <div>
                    <Label className="text-xs">{t("contractTemplates.signingPageSubtitle")}</Label>
                    <Input
                      disabled={editingPublished}
                      className="mt-1"
                      placeholder={t("contractTemplates.signingPageSubtitlePlaceholder")}
                      value={form.signingPageConfig.pageSubtitle}
                      onChange={e => setForm(f => ({ ...f, signingPageConfig: { ...f.signingPageConfig, pageSubtitle: e.target.value } }))}
                    />
                    <p className="text-xs text-muted-foreground mt-0.5">{t("contractTemplates.signingPageSubtitleHint")}</p>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <Label className="text-xs">PDF header text</Label>
                      <Input disabled={editingPublished} className="mt-1" placeholder="Official agreement" value={form.signingPageConfig.pdfHeaderText}
                        onChange={e => setForm(f => ({ ...f, signingPageConfig: { ...f.signingPageConfig, pdfHeaderText: e.target.value } }))} />
                    </div>
                    <div>
                      <Label className="text-xs">PDF footer text</Label>
                      <Input disabled={editingPublished} className="mt-1" placeholder="Company contact or legal text" value={form.signingPageConfig.pdfFooterText}
                        onChange={e => setForm(f => ({ ...f, signingPageConfig: { ...f.signingPageConfig, pdfFooterText: e.target.value } }))} />
                    </div>
                  </div>
                  <div className="rounded-md border p-3 space-y-2">
                    <div>
                      <Label className="text-xs">Company signature for final PDF</Label>
                      <p className="text-xs text-muted-foreground">Hidden during details and review. It is added only after the counterparty signs.</p>
                    </div>
                    <Input disabled={editingPublished} type="file" accept="image/png,image/jpeg" onChange={e => loadCompanySignature(e.target.files?.[0])} />
                    {form.signingPageConfig.companySignatureDataUrl && (
                      <div className="flex items-center gap-3">
                        <img src={form.signingPageConfig.companySignatureDataUrl} alt="Company signature preview" className="h-14 max-w-[220px] object-contain border rounded p-1" />
                        <Button disabled={editingPublished} type="button" size="sm" variant="outline" onClick={() => setForm(f => ({ ...f, signingPageConfig: { ...f.signingPageConfig, companySignatureDataUrl: "" } }))}>Remove</Button>
                      </div>
                    )}
                  </div>
                  </>}
                </div>
              )}
            </div>

            <div className="rounded-lg border p-4">
              <div className="flex items-start gap-3">
                <input
                  id="requireEmailVerification"
                  type="checkbox"
                  className="mt-1"
                  disabled={editingPublished}
                  checked={form.signingPageConfig.requireEmailVerification}
                  onChange={e => setForm(current => ({
                    ...current,
                    signingPageConfig: {
                      ...current.signingPageConfig,
                      requireEmailVerification: e.target.checked,
                    },
                  }))}
                />
                <div>
                  <Label htmlFor="requireEmailVerification">
                    {t("contractTemplates.requireEmailVerification")}
                  </Label>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("contractTemplates.requireEmailVerificationHint")}
                  </p>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <input id="isActive" type="checkbox" checked={form.isActive} onChange={e => setForm(f => ({ ...f, isActive: e.target.checked }))} />
              <Label htmlFor="isActive">{t("contractTemplates.statusActive")}</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)}>{t("contractTemplates.cancel")}</Button>
            {editingPublished && editing && <Button variant="secondary" onClick={() => workflowAction(editing, "new-version")}><Copy className="h-4 w-4 mr-2" /> Create editable version</Button>}
            <Button onClick={save} disabled={saving}>{saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null} {t("contractTemplates.save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ContractBrandProfilesDialog open={brandDialogOpen} onOpenChange={setBrandDialogOpen} profiles={brands} onChanged={loadBrands} />
    </div>
  );
}
