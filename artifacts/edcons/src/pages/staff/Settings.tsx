import { useState, useEffect, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { customFetch } from "@workspace/api-client-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { QuickLinkLogo } from "@/components/QuickLinkLogo";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PhoneCodePicker } from "@/components/ui/phone-code-picker";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/hooks/use-i18n";
import { useTheme } from "@/contexts/ThemeContext";
import {
  User, Globe, Bell, Shield, Save, Check, Loader2, Phone, Mail,
  Palette, Upload, X, Sun, Moon, Monitor, Image as ImageIcon, Plug,
  Building2, Search as SearchIcon, FileText, Code, ChevronRight, Copy,
  ExternalLink, Eye, Info, AlertTriangle, Instagram, Linkedin,
  Youtube, Facebook, Twitter, Camera, Kanban, Pencil, ChevronDown,
  CalendarDays, Plus, Trash2, GripVertical, Power, PowerOff, Link as LinkIcon,
  Calendar,
} from "lucide-react";
import { DATE_FORMAT_OPTIONS, type DateFormatKey } from "@workspace/i18n";
import { performLogout } from "@/lib/logout";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { NotificationRulesManager } from "@/components/NotificationRulesManager";
import { CountryFlag } from "@/components/CountryFlag";
import { MultiSelectFilter } from "@/components/ui/multi-select-filter";
import { PHONE_CODES as PHONE_CODES_LIB } from "@/lib/nationalities";
import { IntegrationsManager } from "@/components/IntegrationsManager";
import { ApiTokensManager } from "@/pages/admin/ApiTokens";
import { usePipelineStages } from "@/hooks/use-pipeline-stages";
import { EditStagesDialog } from "@/components/EditStagesDialog";
import { SYSTEM_LANGUAGE_OPTIONS } from "@/lib/i18n";

const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

const LANGUAGES = SYSTEM_LANGUAGE_OPTIONS;

const PHONE_CODES = [
  { code: "+90", country: "TR" }, { code: "+1", country: "US" }, { code: "+44", country: "GB" },
  { code: "+49", country: "DE" }, { code: "+33", country: "FR" }, { code: "+39", country: "IT" },
  { code: "+34", country: "ES" }, { code: "+31", country: "NL" }, { code: "+46", country: "SE" },
  { code: "+47", country: "NO" }, { code: "+45", country: "DK" }, { code: "+41", country: "CH" },
  { code: "+43", country: "AT" }, { code: "+48", country: "PL" }, { code: "+7", country: "RU" },
  { code: "+380", country: "UA" }, { code: "+86", country: "CN" }, { code: "+81", country: "JP" },
  { code: "+82", country: "KR" }, { code: "+91", country: "IN" }, { code: "+92", country: "PK" },
  { code: "+93", country: "AF" }, { code: "+966", country: "SA" }, { code: "+971", country: "AE" },
  { code: "+964", country: "IQ" }, { code: "+98", country: "IR" }, { code: "+962", country: "JO" },
  { code: "+961", country: "LB" }, { code: "+20", country: "EG" }, { code: "+212", country: "MA" },
  { code: "+234", country: "NG" }, { code: "+254", country: "KE" }, { code: "+55", country: "BR" },
  { code: "+52", country: "MX" }, { code: "+61", country: "AU" }, { code: "+64", country: "NZ" },
  { code: "+60", country: "MY" }, { code: "+65", country: "SG" }, { code: "+66", country: "TH" },
  { code: "+84", country: "VN" }, { code: "+62", country: "ID" }, { code: "+63", country: "PH" },
  { code: "+880", country: "BD" }, { code: "+94", country: "LK" }, { code: "+977", country: "NP" },
  { code: "+251", country: "ET" }, { code: "+255", country: "TZ" }, { code: "+233", country: "GH" },
];

function parsePhoneCode(fullPhone: string): { phoneCode: string; phone: string } {
  if (!fullPhone) return { phoneCode: "+90", phone: "" };
  const sorted = [...PHONE_CODES].sort((a, b) => b.code.length - a.code.length);
  const matched = sorted.find(pc => fullPhone.startsWith(pc.code));
  if (matched) return { phoneCode: matched.code, phone: fullPhone.slice(matched.code.length) };
  const intlMatch = fullPhone.match(/^(\+\d{1,4})(.*)/);
  if (intlMatch) return { phoneCode: intlMatch[1], phone: intlMatch[2] };
  return { phoneCode: "+90", phone: fullPhone };
}

const ROLE_LABELS: Record<string, string> = {
  super_admin: "Super Admin", admin: "Admin", manager: "Manager",
  staff: "Staff", consultant: "Consultant", accountant: "Accountant", editor: "Editor",
  student: "Student", agent: "Agent", sub_agent: "Sub Agent",
};

import { ADMIN_ROLES, MANAGER_ROLES as _MANAGER_ROLES } from "@workspace/roles";
const MANAGER_ROLES = _MANAGER_ROLES;

function SectionHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-6">
      <h2 className="font-display font-bold text-xl text-foreground">{title}</h2>
      {description && <p className="text-sm text-muted-foreground mt-1">{description}</p>}
    </div>
  );
}

function FieldGroup({ label, description, children, className }: { label: string; description?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`space-y-1.5 ${className || ""}`}>
      <Label className="text-sm font-semibold">{label}</Label>
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
      {children}
    </div>
  );
}

function ColorField({ label, description, value, onChange, defaultColor }: { label: string; description: string; value: string; onChange: (v: string) => void; defaultColor: string }) {
  return (
    <div className="flex items-center gap-4 p-4 rounded-xl border border-border/50 hover:border-primary/20 transition-colors">
      <div className="relative shrink-0">
        <div className="w-10 h-10 rounded-lg border-2 border-border shadow-sm cursor-pointer overflow-hidden"
          style={{ backgroundColor: value || defaultColor }}
          onClick={() => document.getElementById(`color-${label.replace(/\s/g, "")}`)?.click()} />
        <input id={`color-${label.replace(/\s/g, "")}`} type="color" className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
          value={value || defaultColor}
          onChange={e => onChange(e.target.value)} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-semibold text-sm text-foreground">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Input value={value} onChange={e => onChange(e.target.value)} placeholder={defaultColor} className="w-28 rounded-lg text-xs font-mono h-8" />
        {value && <button onClick={() => onChange("")} className="text-muted-foreground hover:text-destructive transition-colors"><X className="w-4 h-4" /></button>}
      </div>
    </div>
  );
}

function LogoUploader({ label, description, value, onChange, bgClass, dims }: { label: string; description?: string; value: string; onChange: (v: string) => void; bgClass?: string; dims?: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const { toast } = useToast();

  async function upload(file: File) {
    setUploading(true);
    try {
      const urlRes = await customFetch(`/api/storage/uploads/request-url`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type, prefix: "branding" }),
      });
      if (!(urlRes as any).uploadURL || !(urlRes as any).objectPath) throw new Error("Failed to get upload URL");
      const putRes = await fetch((urlRes as any).uploadURL, { method: "PUT", body: file, headers: { "Content-Type": file.type } });
      if (!putRes.ok) throw new Error("Upload failed");
      const strippedPath = (urlRes as any).objectPath.replace(/^\/objects/, "");
      onChange(`${BASE_URL}/api/storage/objects${strippedPath}`);
      toast({ title: `${label} uploaded` });
    } catch (err: any) {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    } finally { setUploading(false); }
  }

  return (
    <div className="space-y-2">
      <Label className="text-xs font-semibold">{label}</Label>
      {dims && <p className="text-[11px] text-muted-foreground">Recommended: {dims}</p>}
      <div className={`relative w-full h-28 rounded-xl border-2 border-dashed border-border hover:border-primary/50 transition-colors flex items-center justify-center overflow-hidden ${bgClass || "bg-secondary/20"}`}>
        {value ? (
          <>
            <img src={value} alt={label} className="max-h-20 max-w-full object-contain" />
            <button onClick={() => onChange("")}
              className="absolute top-2 right-2 w-6 h-6 rounded-full bg-destructive/90 text-white flex items-center justify-center hover:bg-destructive"><X className="w-3 h-3" /></button>
          </>
        ) : (
          <button onClick={() => inputRef.current?.click()} disabled={uploading}
            className="flex flex-col items-center gap-1.5 text-muted-foreground hover:text-primary transition-colors">
            {uploading ? <Loader2 className="w-6 h-6 animate-spin" /> : <Upload className="w-6 h-6" />}
            <span className="text-[10px] font-medium">{uploading ? "Uploading..." : "Upload"}</span>
          </button>
        )}
      </div>
      <input ref={inputRef} type="file" accept="image/*" className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ""; }} />
    </div>
  );
}

function SaveButton({ onClick, saving, label }: { onClick: () => void; saving: boolean; label?: string }) {
  return (
    <Button onClick={onClick} disabled={saving} className="rounded-xl gap-2 px-8">
      {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
      {label || "Save Changes"}
    </Button>
  );
}

type SettingsTab = "profile" | "language" | "notifications" | "security" | "pipeline" | "seasons" | "branding" | "company" | "seo" | "email" | "documents" | "integrations" | "quicklinks" | "leadAssignment" | "advanced";

interface NavItem { id: SettingsTab; label: string; navKey: string; icon: typeof User; group: "personal" | "organization"; managerOnly?: boolean; superAdminOnly?: boolean }

const NAV_ITEMS: NavItem[] = [
  { id: "profile", label: "Profile", navKey: "navProfile", icon: User, group: "personal" },
  { id: "language", label: "Language & Region", navKey: "navLanguage", icon: Globe, group: "personal" },
  { id: "notifications", label: "Notifications", navKey: "navNotifications", icon: Bell, group: "personal" },
  { id: "security", label: "Security", navKey: "navSecurity", icon: Shield, group: "personal" },
  { id: "pipeline", label: "Pipeline Stages", navKey: "navPipeline", icon: Kanban, group: "organization", managerOnly: true },
  { id: "seasons", label: "Academic Years", navKey: "navSeasons", icon: CalendarDays, group: "organization", managerOnly: true },
  { id: "branding", label: "Branding & Appearance", navKey: "navBranding", icon: Palette, group: "organization", managerOnly: true },
  { id: "company", label: "Company & Contact", navKey: "navCompany", icon: Building2, group: "organization", managerOnly: true },
  { id: "seo", label: "SEO & Social", navKey: "navSeo", icon: SearchIcon, group: "organization", managerOnly: true },
  { id: "email", label: "Email Branding", navKey: "navEmail", icon: Mail, group: "organization", managerOnly: true },
  { id: "documents", label: "Documents / PDF", navKey: "navDocuments", icon: FileText, group: "organization", managerOnly: true },
  { id: "integrations", label: "Integrations", navKey: "navIntegrations", icon: Plug, group: "organization", managerOnly: true },
  { id: "quicklinks", label: "Quick Links", navKey: "navQuickLinks", icon: LinkIcon, group: "organization", managerOnly: true },
  { id: "leadAssignment", label: "Lead Otomatik Atama", navKey: "navLeadAssignment", icon: GripVertical, group: "organization", managerOnly: true },
  { id: "advanced", label: "Advanced", navKey: "navAdvanced", icon: Code, group: "organization", managerOnly: true },
];

export default function SettingsPage() {
  const { user } = useAuth(true);
  const { lang, setLang, t } = useI18n();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { mode, setMode, resolvedTheme, settings: themeSettings, refreshSettings } = useTheme();
  const [, setLocation] = useLocation();

  const [activeTab, setActiveTab] = useState<SettingsTab>("profile");
  const [form, setForm] = useState({ firstName: "", lastName: "", phoneCode: "+90", phone: "", avatarUrl: "", email: "", startDate: "", homeAddress: "", passportNumber: "", contractUrl: "", passportUrl: "", emergencyContactName: "", emergencyPhoneCode: "+90", emergencyPhone: "" });
  const [avatarUploading, setAvatarUploading] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  const [pwForm, setPwForm] = useState({ currentPassword: "", newPassword: "", confirmPassword: "" });
  const [pwSaving, setPwSaving] = useState(false);
  const [notifications, setNotifications] = useState({ newLeads: true, applicationUpdates: true, documentAlerts: true, financeAlerts: false });
  const [settings, setSettings] = useState<Record<string, any>>({});
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [sectionSaving, setSectionSaving] = useState<string | null>(null);

  const isManager = MANAGER_ROLES.includes(user?.role || "");

  useEffect(() => {
    if (!user) return;
    const parsed = parsePhoneCode((user as any).phone || "");
    setForm(f => ({
      ...f,
      firstName: user.firstName || "",
      lastName: user.lastName || "",
      phoneCode: parsed.phoneCode,
      phone: parsed.phone,
      avatarUrl: user.avatarUrl || "",
      email: user.email || "",
    }));
    customFetch("/api/users/me/profile").then((p: any) => {
      if (!p) return;
      const eParsed = parsePhoneCode(p.emergencyContactPhone || "");
      setForm(f => ({
        ...f,
        startDate: p.startDate || "",
        homeAddress: p.homeAddress || "",
        passportNumber: p.passportNumber || "",
        contractUrl: p.contractUrl || "",
        passportUrl: p.passportUrl || "",
        emergencyContactName: p.emergencyContactName || "",
        emergencyPhoneCode: eParsed.phoneCode,
        emergencyPhone: eParsed.phone,
      }));
    }).catch(() => {});
  }, [user]);

  useEffect(() => {
    if (isManager) {
      customFetch("/api/settings").then((data: any) => {
        setSettings(data || {});
        setSettingsLoaded(true);
      }).catch(() => setSettingsLoaded(true));
    }
  }, [isManager]);

  function updateSettings(updates: Record<string, any>) {
    setSettings(prev => ({ ...prev, ...updates }));
  }

  async function saveSection(section: string, fields: Record<string, any>) {
    setSectionSaving(section);
    try {
      const res = await customFetch("/api/settings", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
      });
      setSettings(prev => ({ ...prev, ...(res as any) }));
      if (section === "branding") await refreshSettings();
      toast({ title: `${section.charAt(0).toUpperCase() + section.slice(1)} saved` });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally { setSectionSaving(null); }
  }

  async function handleAvatarUpload(file: File) {
    setAvatarUploading(true);
    try {
      const urlRes = await customFetch(`/api/storage/uploads/request-url`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type }),
      });
      if (!(urlRes as any).uploadURL || !(urlRes as any).objectPath) throw new Error("Failed to get upload URL");
      const putRes = await fetch((urlRes as any).uploadURL, { method: "PUT", body: file, headers: { "Content-Type": file.type } });
      if (!putRes.ok) throw new Error("Upload failed");
      const strippedPath = (urlRes as any).objectPath.replace(/^\/objects/, "");
      const avatarUrl = `${BASE_URL}/api/storage/objects${strippedPath}`;
      setForm(f => ({ ...f, avatarUrl }));
      await customFetch(`/api/users/${user!.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ avatarUrl }),
      });
      await qc.invalidateQueries({ queryKey: ["/api/auth/me"] });
      toast({ title: "Profile photo updated" });
    } catch (err: any) {
      // On 401, customFetch already dispatches `api:unauthorized` and the host
      // app redirects to /login. Show a friendly Turkish message instead of
      // the raw "HTTP 401 Unauthorized: Authentication required" string.
      if (err?.status === 401) {
        toast({ title: "Oturum süreniz doldu", description: "Lütfen tekrar giriş yapın.", variant: "destructive" });
      } else {
        toast({ title: "Upload failed", description: err.message, variant: "destructive" });
      }
    } finally { setAvatarUploading(false); }
  }

  const contractInputRef = useRef<HTMLInputElement>(null);
  const [contractUploading, setContractUploading] = useState(false);

  async function handleContractUpload(file: File) {
    setContractUploading(true);
    try {
      const urlRes = await customFetch(`/api/storage/uploads/request-url`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type }),
      });
      if (!(urlRes as any).uploadURL || !(urlRes as any).objectPath) throw new Error("Failed to get upload URL");
      const putRes = await fetch((urlRes as any).uploadURL, { method: "PUT", body: file, headers: { "Content-Type": file.type } });
      if (!putRes.ok) throw new Error("Upload failed");
      const strippedPath = (urlRes as any).objectPath.replace(/^\/objects/, "");
      const contractUrl = `${BASE_URL}/api/storage/objects${strippedPath}`;
      setForm(f => ({ ...f, contractUrl }));
      toast({ title: "Contract uploaded" });
    } catch (err: any) {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    } finally { setContractUploading(false); }
  }

  const passportInputRef = useRef<HTMLInputElement>(null);
  const [passportUploading, setPassportUploading] = useState(false);

  async function handlePassportUpload(file: File) {
    setPassportUploading(true);
    try {
      const urlRes = await customFetch(`/api/storage/uploads/request-url`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type }),
      });
      if (!(urlRes as any).uploadURL || !(urlRes as any).objectPath) throw new Error("Failed to get upload URL");
      const putRes = await fetch((urlRes as any).uploadURL, { method: "PUT", body: file, headers: { "Content-Type": file.type } });
      if (!putRes.ok) throw new Error("Upload failed");
      const strippedPath = (urlRes as any).objectPath.replace(/^\/objects/, "");
      const passportUrl = `${BASE_URL}/api/storage/objects${strippedPath}`;
      setForm(f => ({ ...f, passportUrl }));
      toast({ title: "Passport uploaded" });
    } catch (err: any) {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    } finally { setPassportUploading(false); }
  }

  async function handleRemoveAvatar() {
    try {
      setForm(f => ({ ...f, avatarUrl: "" }));
      await customFetch(`/api/users/${user!.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ avatarUrl: null }),
      });
      await qc.invalidateQueries({ queryKey: ["/api/auth/me"] });
      toast({ title: "Profile photo removed" });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  }

  async function handleSaveProfile() {
    if (!user) return;
    setSaving(true);
    try {
      await customFetch(`/api/users/${user.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ firstName: form.firstName, lastName: form.lastName, phone: form.phone ? `${form.phoneCode}${form.phone}` : undefined, avatarUrl: form.avatarUrl || null, email: form.email || undefined, startDate: form.startDate || null, homeAddress: form.homeAddress || null, passportNumber: form.passportNumber || null, contractUrl: form.contractUrl || null, passportUrl: form.passportUrl || null, emergencyContactName: form.emergencyContactName || null, emergencyContactPhone: form.emergencyPhone ? `${form.emergencyPhoneCode}${form.emergencyPhone}` : null }),
      });
      await qc.invalidateQueries({ queryKey: ["/api/auth/me"] });
      toast({ title: "Profile updated" });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally { setSaving(false); }
  }

  async function handleChangePassword() {
    if (!pwForm.currentPassword || !pwForm.newPassword) {
      toast({ title: "Please fill in all password fields", variant: "destructive" });
      return;
    }
    if (pwForm.newPassword.length < 6) {
      toast({ title: "New password must be at least 6 characters", variant: "destructive" });
      return;
    }
    if (pwForm.newPassword !== pwForm.confirmPassword) {
      toast({ title: "New passwords do not match", variant: "destructive" });
      return;
    }
    setPwSaving(true);
    try {
      await customFetch(`/api/users/me/change-password`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: pwForm.currentPassword, newPassword: pwForm.newPassword }),
      });
      setPwForm({ currentPassword: "", newPassword: "", confirmPassword: "" });
      toast({ title: "Password changed successfully" });
    } catch (err: any) {
      toast({ title: "Error", description: err.message || "Failed to change password", variant: "destructive" });
    } finally { setPwSaving(false); }
  }

  async function handleSaveLang(code: string) {
    if (!user) return;
    setLang(code as any);
    try {
      await customFetch(`/api/users/${user.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language: code }),
      });
      toast({ title: "Language updated" });
    } catch {}
  }

  const initials = `${user?.firstName?.[0] || ""}${user?.lastName?.[0] || user?.email?.[0] || "?"}`.toUpperCase();
  const isSuperAdmin = user?.role === "super_admin";
  const visibleNav = NAV_ITEMS.filter(n => {
    if (n.superAdminOnly) return isSuperAdmin;
    if (n.managerOnly) return isManager;
    return true;
  });

  function renderContent() {
    switch (activeTab) {
      case "profile": return ProfileTab();
      case "language": return LanguageTab();
      case "notifications": return NotificationsTab();
      case "security": return SecurityTab();
      case "pipeline": return isManager ? <PipelineTab qc={qc} /> : null;
      case "seasons": return isManager ? <SeasonsTabContent /> : null;
      case "branding": return isManager ? BrandingTab() : null;
      case "company": return isManager ? CompanyTab() : null;
      case "seo": return isManager ? SeoTab() : null;
      case "email": return isManager ? EmailBrandingTab() : null;
      case "documents": return isManager ? DocumentsTab() : null;
      case "integrations": return isManager ? IntegrationsTab() : null;
      case "quicklinks": return isManager ? <QuickLinksTab /> : null;
      case "leadAssignment": return isManager ? <LeadAssignmentRulesTab /> : null;
      case "advanced": return isManager ? AdvancedTab() : null;
      default: return null;
    }
  }

  function ProfileTab() {
    return (<>
      <Card className="border-none shadow-lg shadow-black/5 p-6">
        <SectionHeader title={t("settingsPage.personalInformation")} description={t("settingsPage.personalInformationDesc")} />
        <div className="flex items-center gap-5 mb-8 p-5 rounded-2xl bg-gradient-to-r from-primary/5 to-accent/5 border border-primary/10">
          <div className="relative group shrink-0">
            {form.avatarUrl ? (
              <img src={form.avatarUrl} alt="" className="w-20 h-20 rounded-2xl object-cover shadow-lg" />
            ) : (
              <div className="w-20 h-20 rounded-2xl bg-gradient-to-tr from-primary to-accent flex items-center justify-center text-white font-display font-bold text-2xl shadow-lg">{initials}</div>
            )}
            <button
              onClick={() => avatarInputRef.current?.click()}
              disabled={avatarUploading}
              className="absolute inset-0 rounded-2xl bg-black/0 group-hover:bg-black/40 flex items-center justify-center transition-all opacity-0 group-hover:opacity-100"
            >
              {avatarUploading ? <Loader2 className="w-6 h-6 text-white animate-spin" /> : <Camera className="w-6 h-6 text-white" />}
            </button>
            {form.avatarUrl && (
              <button onClick={handleRemoveAvatar} className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-destructive text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-destructive/90">
                <X className="w-3 h-3" />
              </button>
            )}
            <input ref={avatarInputRef} type="file" accept="image/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleAvatarUpload(f); e.target.value = ""; }} />
          </div>
          <div>
            <p className="font-display font-bold text-lg text-foreground">{user?.firstName} {user?.lastName}</p>
            <p className="text-muted-foreground text-sm">{user?.email}</p>
            <Badge className="bg-blue-500/10 text-blue-600 border-blue-200 text-xs mt-2 capitalize">{ROLE_LABELS[user?.role || ""] || user?.role}</Badge>
            <p className="text-xs text-muted-foreground mt-1">Hover to change photo</p>
          </div>
        </div>
        <div className="grid sm:grid-cols-2 gap-5">
          <FieldGroup label="First Name"><Input value={form.firstName} onChange={e => setForm(f => ({ ...f, firstName: e.target.value }))} className="rounded-xl" /></FieldGroup>
          <FieldGroup label="Last Name"><Input value={form.lastName} onChange={e => setForm(f => ({ ...f, lastName: e.target.value }))} className="rounded-xl" /></FieldGroup>
          <FieldGroup label="Email" className="sm:col-span-2">
            <Input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} className="rounded-xl" />
          </FieldGroup>
          <FieldGroup label="Phone" className="sm:col-span-2">
            <div className="flex gap-2">
              <PhoneCodePicker value={form.phoneCode} onChange={v => setForm(f => ({ ...f, phoneCode: v }))} triggerClassName="min-w-[100px] h-10 shrink-0" />
              <Input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} placeholder="555 123 4567" className="rounded-xl flex-1" />
            </div>
          </FieldGroup>
        </div>
      </Card>
      <Card className="border-none shadow-lg shadow-black/5 p-6 mt-6">
        <SectionHeader title={t("settingsPage.workIdentity")} description={t("settingsPage.workIdentityDesc")} />
        <div className="grid sm:grid-cols-2 gap-5">
          <FieldGroup label="Start Date">
            <Input type="date" value={form.startDate} onChange={e => setForm(f => ({ ...f, startDate: e.target.value }))} className="rounded-xl" />
          </FieldGroup>
          <FieldGroup label="Passport Number">
            <Input value={form.passportNumber} onChange={e => setForm(f => ({ ...f, passportNumber: e.target.value }))} placeholder="Enter passport number" className="rounded-xl" />
          </FieldGroup>
          <FieldGroup label="Home Address" className="sm:col-span-2">
            <Input value={form.homeAddress} onChange={e => setForm(f => ({ ...f, homeAddress: e.target.value }))} placeholder="Enter your home address" className="rounded-xl" />
          </FieldGroup>
          <FieldGroup label="Employment Contract">
            <div className="flex items-center gap-3">
              {form.contractUrl ? (
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <a href={form.contractUrl} target="_blank" rel="noopener noreferrer" className="text-sm text-primary hover:underline truncate">View Contract</a>
                  <Button variant="ghost" size="sm" onClick={() => setForm(f => ({ ...f, contractUrl: "" }))}>
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No contract uploaded</p>
              )}
              <Button variant="outline" size="sm" onClick={() => contractInputRef.current?.click()} disabled={contractUploading}>
                {contractUploading ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Upload className="w-4 h-4 mr-1" />}
                {form.contractUrl ? "Replace" : "Upload"}
              </Button>
              <input ref={contractInputRef} type="file" accept=".pdf,.doc,.docx,.jpg,.jpeg,.png" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleContractUpload(f); e.target.value = ""; }} />
            </div>
          </FieldGroup>
          <FieldGroup label="Passport Document">
            <div className="flex items-center gap-3">
              {form.passportUrl ? (
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <a href={form.passportUrl} target="_blank" rel="noopener noreferrer" className="text-sm text-primary hover:underline truncate">View Passport</a>
                  <Button variant="ghost" size="sm" onClick={() => setForm(f => ({ ...f, passportUrl: "" }))}>
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No passport uploaded</p>
              )}
              <Button variant="outline" size="sm" onClick={() => passportInputRef.current?.click()} disabled={passportUploading}>
                {passportUploading ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Upload className="w-4 h-4 mr-1" />}
                {form.passportUrl ? "Replace" : "Upload"}
              </Button>
              <input ref={passportInputRef} type="file" accept=".pdf,.jpg,.jpeg,.png" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handlePassportUpload(f); e.target.value = ""; }} />
            </div>
          </FieldGroup>
        </div>
        <div className="mt-6"><SaveButton onClick={handleSaveProfile} saving={saving} /></div>
      </Card>
      <Card className="border-none shadow-lg shadow-black/5 p-6 mt-6">
        <SectionHeader title={t("settingsPage.emergencyContact")} description={t("settingsPage.emergencyContactDesc")} />
        <div className="grid sm:grid-cols-3 gap-5">
          <FieldGroup label="Full Name" className="sm:col-span-2">
            <Input value={form.emergencyContactName} onChange={e => setForm(f => ({ ...f, emergencyContactName: e.target.value }))} placeholder="Enter emergency contact name" className="rounded-xl" />
          </FieldGroup>
          <FieldGroup label="Phone Number">
            <div className="flex gap-2">
              <PhoneCodePicker value={form.emergencyPhoneCode} onChange={v => setForm(f => ({ ...f, emergencyPhoneCode: v }))} triggerClassName="min-w-[100px] h-10 shrink-0" />
              <Input value={form.emergencyPhone} onChange={e => setForm(f => ({ ...f, emergencyPhone: e.target.value }))} placeholder="555 123 4567" className="rounded-xl flex-1" />
            </div>
          </FieldGroup>
        </div>
        <div className="mt-6"><SaveButton onClick={handleSaveProfile} saving={saving} /></div>
      </Card>
      <Card className="border-none shadow-lg shadow-black/5 p-6 mt-6">
        <SectionHeader title={t("settingsPage.changePassword")} description={t("settingsPage.changePasswordDesc")} />
        <div className="space-y-4 max-w-md">
          <FieldGroup label="Current Password">
            <Input type="password" value={pwForm.currentPassword} onChange={e => setPwForm(f => ({ ...f, currentPassword: e.target.value }))} placeholder="Enter current password" className="rounded-xl" />
          </FieldGroup>
          <FieldGroup label="New Password">
            <Input type="password" value={pwForm.newPassword} onChange={e => setPwForm(f => ({ ...f, newPassword: e.target.value }))} placeholder="Enter new password" className="rounded-xl" />
          </FieldGroup>
          <FieldGroup label="Confirm New Password">
            <Input type="password" value={pwForm.confirmPassword} onChange={e => setPwForm(f => ({ ...f, confirmPassword: e.target.value }))} placeholder="Confirm new password" className="rounded-xl" />
          </FieldGroup>
        </div>
        <div className="mt-6">
          <Button onClick={handleChangePassword} disabled={pwSaving || !pwForm.currentPassword || !pwForm.newPassword || !pwForm.confirmPassword} className="rounded-xl gap-2">
            {pwSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Shield className="w-4 h-4" />}
            Change Password
          </Button>
        </div>
      </Card>
    </>);
  }

  async function handleSaveDateFormat(fmt: DateFormatKey) {
    if (!isManager) return;
    try {
      await saveSection("dateFormat", { dateFormat: fmt });
    } catch {}
  }

  function LanguageTab() {
    const currentDateFormat = (settings.dateFormat as DateFormatKey) || "DD.MM.YYYY";
    const today = new Date();

    return (
      <div className="space-y-4">
        <Card className="border-none shadow-lg shadow-black/5 p-6">
          <SectionHeader title={t("settingsPage.languageRegion")} description={t("settingsPage.languageRegionDesc")} />
          <div className="grid sm:grid-cols-2 gap-3">
            {LANGUAGES.map(l => (
              <button key={l.code} onClick={() => handleSaveLang(l.code)}
                className={`flex items-center gap-4 p-4 rounded-xl border-2 text-left transition-all hover:border-primary/50
                  ${lang === l.code ? "border-primary bg-primary/5 shadow-sm shadow-primary/10" : "border-border hover:bg-secondary/30"}`}>
                <CountryFlag code={l.country} size="xl" />
                <div className="flex-1">
                  <p className="font-bold text-foreground">{l.label}</p>
                  <p className="text-xs text-muted-foreground">{l.code.toUpperCase()}</p>
                </div>
                {lang === l.code && <Check className="w-5 h-5 text-primary" />}
              </button>
            ))}
          </div>
          <p className="text-muted-foreground text-sm mt-4">{t("settingsPage.rtlNote")}</p>
        </Card>

        {isManager && (
          <Card className="border-none shadow-lg shadow-black/5 p-6">
            <SectionHeader title={t("settingsPage.dateFormat")} description={t("settingsPage.dateFormatDesc")} />
            <div className="grid sm:grid-cols-2 gap-3">
              {DATE_FORMAT_OPTIONS.map(fmt => {
                const dd = String(today.getDate()).padStart(2, "0");
                const mm = String(today.getMonth() + 1).padStart(2, "0");
                const yyyy = String(today.getFullYear());
                const preview =
                  fmt === "DD/MM/YYYY" ? `${dd}/${mm}/${yyyy}` :
                  fmt === "MM/DD/YYYY" ? `${mm}/${dd}/${yyyy}` :
                  fmt === "YYYY-MM-DD" ? `${yyyy}-${mm}-${dd}` :
                  `${dd}.${mm}.${yyyy}`;
                const isSelected = currentDateFormat === fmt;
                return (
                  <button
                    key={fmt}
                    onClick={() => handleSaveDateFormat(fmt)}
                    className={`flex items-center gap-4 p-4 rounded-xl border-2 text-left transition-all hover:border-primary/50
                      ${isSelected ? "border-primary bg-primary/5 shadow-sm shadow-primary/10" : "border-border hover:bg-secondary/30"}`}
                  >
                    <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                      <Calendar className="w-5 h-5 text-primary" />
                    </div>
                    <div className="flex-1">
                      <p className="font-bold text-foreground font-mono">{fmt}</p>
                      <p className="text-xs text-muted-foreground">{preview}</p>
                    </div>
                    {isSelected && <Check className="w-5 h-5 text-primary" />}
                  </button>
                );
              })}
            </div>
          </Card>
        )}
      </div>
    );
  }

  function NotificationsTab() {
    const isSuperAdminLocal = user?.role === "super_admin";
    return (
      <div className="space-y-6">
        {isSuperAdminLocal && <OfferExpiryThresholdsCard />}
        {isSuperAdminLocal && <ContractExpiryThresholdsCard />}
        <SigningDeadlineDaysCard />
        <SuppressAutomationNotificationsCard />
        {isSuperAdminLocal && <AutoAssignStuckConversationsCard />}
        <NotificationRulesManager isAdmin={isManager} notifications={notifications} setNotifications={setNotifications} />
      </div>
    );
  }

  function SecurityTab() {
    return (
      <Card className="border-none shadow-lg shadow-black/5 p-6">
        <SectionHeader title={t("settingsPage.securityAccess")} description={t("settingsPage.securityAccessDesc")} />
        <div className="space-y-4">
          <div className="p-5 rounded-xl bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800">
            <p className="font-bold text-blue-800 dark:text-blue-300 flex items-center gap-2"><Shield className="w-5 h-5" /> Secure Authentication</p>
            <p className="text-sm text-blue-700 dark:text-blue-400 mt-2">Your account is secured with email and password authentication.</p>
          </div>
          <div className="p-5 rounded-xl border border-border/50 space-y-2">
            <p className="font-semibold text-foreground">Account Details</p>
            <div className="flex justify-between text-sm"><span className="text-muted-foreground">Role</span><Badge className="bg-blue-500/10 text-blue-600 border-blue-200 text-xs capitalize">{ROLE_LABELS[user?.role || ""] || user?.role}</Badge></div>
            <div className="flex justify-between text-sm"><span className="text-muted-foreground">Account ID</span><span className="font-mono text-foreground">#{user?.id}</span></div>
          </div>
          <div className="p-5 rounded-xl border border-border/50">
            <p className="font-semibold text-foreground mb-3">{t("settingsPage.activeSessions")}</p>
            <div className="flex items-center justify-between">
              <div><p className="text-sm text-foreground">{t("settingsPage.currentSession")}</p><p className="text-xs text-muted-foreground">{t("settingsPage.thisDevice")}</p></div>
              <Badge className="bg-green-500/10 text-green-600 border-green-200 text-xs">{t("settingsPage.active")}</Badge>
            </div>
          </div>
          <Button variant="outline" className="w-full rounded-xl text-destructive hover:bg-destructive/5 hover:border-destructive/30" onClick={() => void performLogout()}>
            {t("settingsPage.signOut")}
          </Button>
        </div>
      </Card>
    );
  }

  function SeasonsTabContent() {
    return (
      <div className="space-y-6">
        <YearsManagement />
      </div>
    );
  }

  function BrandingTab() {
    const s = settings;
    return (
      <div className="space-y-6">
        <Card className="border-none shadow-lg shadow-black/5 p-6">
          <SectionHeader title={t("settingsPage.appearanceMode")} description={t("settingsPage.appearanceModeDesc")} />
          <div className="grid grid-cols-3 gap-3">
            {([
              { value: "light" as const, label: t("settingsPage.themeLight"), icon: Sun, desc: t("settingsPage.themeLightDesc") },
              { value: "dark" as const, label: t("settingsPage.themeDark"), icon: Moon, desc: t("settingsPage.themeDarkDesc") },
              { value: "system" as const, label: t("settingsPage.themeSystem"), icon: Monitor, desc: t("settingsPage.themeSystemDesc") },
            ]).map(opt => (
              <button key={opt.value} onClick={() => setMode(opt.value)}
                className={`flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all hover:border-primary/50
                  ${mode === opt.value ? "border-primary bg-primary/5 shadow-sm" : "border-border hover:bg-secondary/30"}`}>
                <opt.icon className={`w-6 h-6 ${mode === opt.value ? "text-primary" : "text-muted-foreground"}`} />
                <span className="font-semibold text-sm">{opt.label}</span>
                <span className="text-xs text-muted-foreground">{opt.desc}</span>
              </button>
            ))}
          </div>
        </Card>

        <Card className="border-none shadow-lg shadow-black/5 p-6">
          <SectionHeader title={t("settingsPage.systemLogos")} description={t("settingsPage.systemLogosDesc")} />
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
            <LogoUploader label="Light Mode Logo" dims="300x80px, PNG/SVG" value={s.logoUrl || ""} onChange={v => updateSettings({ logoUrl: v })} bgClass="bg-white" />
            <LogoUploader label="Dark Mode Logo" dims="300x80px, PNG/SVG" value={s.logoDarkUrl || ""} onChange={v => updateSettings({ logoDarkUrl: v })} bgClass="bg-gray-900" />
            <LogoUploader label="Square Logo" dims="200x200px" value={s.logoSquareUrl || ""} onChange={v => updateSettings({ logoSquareUrl: v })} />
            <LogoUploader label="Favicon" dims="32x32px, ICO/PNG" value={s.faviconUrl || ""} onChange={v => updateSettings({ faviconUrl: v })} />
            <LogoUploader label="Apple Touch Icon" dims="180x180px, PNG" value={s.appleTouchIconUrl || ""} onChange={v => updateSettings({ appleTouchIconUrl: v })} />
            <LogoUploader label="PWA / App Icon" dims="512x512px, PNG" value={s.pwaIconUrl || ""} onChange={v => updateSettings({ pwaIconUrl: v })} />
          </div>
        </Card>

        <Card className="border-none shadow-lg shadow-black/5 p-6">
          <SectionHeader title={t("settingsPage.themeColors")} description={t("settingsPage.themeColorsDesc")} />
          <div className="space-y-3">
            <ColorField label="Primary Color" description="Navigation, links, and accents" value={s.themePrimary || ""} onChange={v => updateSettings({ themePrimary: v })} defaultColor="#3B82F6" />
            <ColorField label="Secondary Color" description="Secondary elements and backgrounds" value={s.themeSecondary || ""} onChange={v => updateSettings({ themeSecondary: v })} defaultColor="#6B7280" />
            <ColorField label="Accent Color" description="Highlights and special elements" value={s.themeAccent || ""} onChange={v => updateSettings({ themeAccent: v })} defaultColor="#8B5CF6" />
            <ColorField label="Button Color" description="Primary action buttons" value={s.themeButton || ""} onChange={v => updateSettings({ themeButton: v })} defaultColor="#3B82F6" />
            <ColorField label="Hover Color" description="Button and link hover state" value={s.themeHover || ""} onChange={v => updateSettings({ themeHover: v })} defaultColor="#2563EB" />
            <ColorField label="Link Color" description="Hyperlinks and text links" value={s.themeLinkColor || ""} onChange={v => updateSettings({ themeLinkColor: v })} defaultColor="#2563EB" />
            <ColorField label="Success" description="Success states and positive feedback" value={s.themeSuccess || ""} onChange={v => updateSettings({ themeSuccess: v })} defaultColor="#22C55E" />
            <ColorField label="Warning" description="Warning states and caution indicators" value={s.themeWarning || ""} onChange={v => updateSettings({ themeWarning: v })} defaultColor="#F59E0B" />
            <ColorField label="Danger" description="Error states and destructive actions" value={s.themeDanger || ""} onChange={v => updateSettings({ themeDanger: v })} defaultColor="#EF4444" />
          </div>
        </Card>

        <Card className="border-none shadow-lg shadow-black/5 p-6">
          <SectionHeader title={t("settingsPage.brandPreview")} description={t("settingsPage.brandPreviewDesc")} />
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="p-4 rounded-xl border border-border/50 bg-background">
              <p className="text-xs font-semibold text-muted-foreground mb-3">Sidebar Logo</p>
              <div className="h-12 bg-secondary/30 rounded-lg flex items-center px-4">
                {s.logoUrl ? <img src={s.logoUrl} className="max-h-8 object-contain" alt="" /> : <span className="text-sm font-bold text-muted-foreground">Your Logo</span>}
              </div>
            </div>
            <div className="p-4 rounded-xl border border-border/50 bg-background">
              <p className="text-xs font-semibold text-muted-foreground mb-3">Button Preview</p>
              <div className="flex gap-2">
                <button className="px-4 py-2 rounded-lg text-white text-sm font-medium" style={{ backgroundColor: s.themeButton || s.themePrimary || "#3B82F6" }}>Primary</button>
                <button className="px-4 py-2 rounded-lg text-white text-sm font-medium" style={{ backgroundColor: s.themeSuccess || "#22C55E" }}>Success</button>
                <button className="px-4 py-2 rounded-lg text-white text-sm font-medium" style={{ backgroundColor: s.themeDanger || "#EF4444" }}>Danger</button>
              </div>
            </div>
            <div className="p-4 rounded-xl border border-border/50 bg-gray-900 sm:col-span-2">
              <p className="text-xs font-semibold text-gray-400 mb-3">Dark Mode Logo</p>
              <div className="h-12 bg-gray-800 rounded-lg flex items-center px-4">
                {s.logoDarkUrl ? <img src={s.logoDarkUrl} className="max-h-8 object-contain" alt="" /> : <span className="text-sm font-bold text-gray-500">Dark Logo</span>}
              </div>
            </div>
          </div>
        </Card>

        <SaveButton onClick={() => saveSection("branding", {
          logoUrl: s.logoUrl || null, logoDarkUrl: s.logoDarkUrl || null,
          logoSquareUrl: s.logoSquareUrl || null, faviconUrl: s.faviconUrl || null,
          appleTouchIconUrl: s.appleTouchIconUrl || null, pwaIconUrl: s.pwaIconUrl || null,
          themePrimary: s.themePrimary || null, themeSecondary: s.themeSecondary || null,
          themeAccent: s.themeAccent || null, themeButton: s.themeButton || null,
          themeHover: s.themeHover || null, themeLinkColor: s.themeLinkColor || null,
          themeSuccess: s.themeSuccess || null, themeWarning: s.themeWarning || null,
          themeDanger: s.themeDanger || null,
        })} saving={sectionSaving === "branding"} label="Save Branding" />
      </div>
    );
  }

  function CompanyTab() {
    const s = settings;
    return (
      <div className="space-y-6">
        <Card className="border-none shadow-lg shadow-black/5 p-6">
          <SectionHeader title={t("settingsPage.companyInformation")} description={t("settingsPage.companyInformationDesc")} />
          <div className="grid sm:grid-cols-2 gap-5">
            <FieldGroup label="Legal Company Name" description="Official registered company name"><Input value={s.legalCompanyName || ""} onChange={e => updateSettings({ legalCompanyName: e.target.value })} className="rounded-xl" /></FieldGroup>
            <FieldGroup label="Public Brand Name" description="The name shown to clients and on the website"><Input value={s.publicBrandName || ""} onChange={e => updateSettings({ publicBrandName: e.target.value })} className="rounded-xl" /></FieldGroup>
            <FieldGroup label="General Email"><Input value={s.companyEmail || ""} onChange={e => updateSettings({ companyEmail: e.target.value })} type="email" className="rounded-xl" /></FieldGroup>
            <FieldGroup label="Support Email"><Input value={s.supportEmail || ""} onChange={e => updateSettings({ supportEmail: e.target.value })} type="email" className="rounded-xl" /></FieldGroup>
            <FieldGroup label="Sales Email"><Input value={s.salesEmail || ""} onChange={e => updateSettings({ salesEmail: e.target.value })} type="email" className="rounded-xl" /></FieldGroup>
            <FieldGroup label="Phone"><Input value={s.companyPhone || ""} onChange={e => updateSettings({ companyPhone: e.target.value })} className="rounded-xl" /></FieldGroup>
            <FieldGroup label="Website"><Input value={s.companyWebsite || ""} onChange={e => updateSettings({ companyWebsite: e.target.value })} placeholder="https://findandstudy.com" className="rounded-xl" /></FieldGroup>
            <FieldGroup label="WhatsApp Number"><Input value={s.whatsappNumber || ""} onChange={e => updateSettings({ whatsappNumber: e.target.value })} placeholder="+90 555 123 4567" className="rounded-xl" /></FieldGroup>
            <FieldGroup label="Working Hours"><Input value={s.workingHours || ""} onChange={e => updateSettings({ workingHours: e.target.value })} placeholder="Mon-Fri 9:00-18:00" className="rounded-xl" /></FieldGroup>
            <FieldGroup label="Address" className="sm:col-span-2"><Input value={s.companyAddress || ""} onChange={e => updateSettings({ companyAddress: e.target.value })} className="rounded-xl" /></FieldGroup>
            <FieldGroup label="City"><Input value={s.companyCity || ""} onChange={e => updateSettings({ companyCity: e.target.value })} className="rounded-xl" /></FieldGroup>
            <FieldGroup label="Country"><Input value={s.companyCountry || ""} onChange={e => updateSettings({ companyCountry: e.target.value })} className="rounded-xl" /></FieldGroup>
          </div>
        </Card>

        <Card className="border-none shadow-lg shadow-black/5 p-6">
          <SectionHeader title={t("settingsPage.footerPublicContent")} description={t("settingsPage.footerPublicContentDesc")} />
          <div className="space-y-5">
            <FieldGroup label="Footer Description" description="Short company description for the website footer">
              <Textarea value={s.footerDescription || ""} onChange={e => updateSettings({ footerDescription: e.target.value })} className="rounded-xl min-h-[70px]" />
            </FieldGroup>
            <FieldGroup label="Footer Copyright Text" description="e.g. © 2025 Find & Study. All rights reserved.">
              <Input value={s.footerCopyright || ""} onChange={e => updateSettings({ footerCopyright: e.target.value })} className="rounded-xl" />
            </FieldGroup>
            <FieldGroup label="Contact CTA Text" description="Call-to-action text on contact sections">
              <Input value={s.contactCtaText || ""} onChange={e => updateSettings({ contactCtaText: e.target.value })} placeholder="Get in touch with us today!" className="rounded-xl" />
            </FieldGroup>
          </div>
        </Card>

        <Card className="border-none shadow-lg shadow-black/5 p-6">
          <SectionHeader title={t("settingsPage.socialMediaLinks")} description={t("settingsPage.socialMediaLinksDesc")} />
          <div className="grid sm:grid-cols-2 gap-5">
            {[
              { key: "socialInstagram", label: "Instagram", icon: Instagram, placeholder: "https://instagram.com/..." },
              { key: "socialFacebook", label: "Facebook", icon: Facebook, placeholder: "https://facebook.com/..." },
              { key: "socialLinkedin", label: "LinkedIn", icon: Linkedin, placeholder: "https://linkedin.com/company/..." },
              { key: "socialTwitter", label: "X / Twitter", icon: Twitter, placeholder: "https://x.com/..." },
              { key: "socialYoutube", label: "YouTube", icon: Youtube, placeholder: "https://youtube.com/@..." },
              { key: "socialTiktok", label: "TikTok", icon: Globe, placeholder: "https://tiktok.com/@..." },
            ].map(item => (
              <FieldGroup key={item.key} label={item.label}>
                <div className="relative">
                  <item.icon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input value={s[item.key] || ""} onChange={e => updateSettings({ [item.key]: e.target.value })} placeholder={item.placeholder} className="rounded-xl pl-10" />
                </div>
              </FieldGroup>
            ))}
          </div>
        </Card>

        <SaveButton onClick={() => saveSection("company", {
          legalCompanyName: s.legalCompanyName || null, publicBrandName: s.publicBrandName || null,
          companyEmail: s.companyEmail || null, supportEmail: s.supportEmail || null,
          salesEmail: s.salesEmail || null, companyPhone: s.companyPhone || null,
          companyWebsite: s.companyWebsite || null,
          whatsappNumber: s.whatsappNumber || null, companyAddress: s.companyAddress || null,
          companyCity: s.companyCity || null, companyCountry: s.companyCountry || null,
          workingHours: s.workingHours || null,
          footerDescription: s.footerDescription || null, footerCopyright: s.footerCopyright || null,
          contactCtaText: s.contactCtaText || null,
          socialInstagram: s.socialInstagram || null, socialFacebook: s.socialFacebook || null,
          socialLinkedin: s.socialLinkedin || null, socialTwitter: s.socialTwitter || null,
          socialYoutube: s.socialYoutube || null, socialTiktok: s.socialTiktok || null,
        })} saving={sectionSaving === "company"} label="Save Company Details" />
      </div>
    );
  }

  function SeoTab() {
    const s = settings;
    const titleLen = (s.seoMetaTitle || "").length;
    const descLen = (s.seoMetaDescription || "").length;
    return (
      <div className="space-y-6">
        <Card className="border-none shadow-lg shadow-black/5 p-6">
          <SectionHeader title="Site Identity" description="Configure your site name and title format for search engines." />
          <div className="grid sm:grid-cols-2 gap-5">
            <FieldGroup label="Site Name" description="Used in structured data and browser tabs"><Input value={s.siteName || ""} onChange={e => updateSettings({ siteName: e.target.value })} placeholder="Find & Study" className="rounded-xl" /></FieldGroup>
            <FieldGroup label="Title Template" description="Use {{pageTitle}} as placeholder"><Input value={s.siteTitleTemplate || ""} onChange={e => updateSettings({ siteTitleTemplate: e.target.value })} placeholder="{{pageTitle}} | Find & Study" className="rounded-xl font-mono text-xs" /></FieldGroup>
            <FieldGroup label="Canonical Base URL" className="sm:col-span-2"><Input value={s.canonicalBaseUrl || ""} onChange={e => updateSettings({ canonicalBaseUrl: e.target.value })} placeholder="https://findandstudy.com" className="rounded-xl" /></FieldGroup>
          </div>
        </Card>

        <Card className="p-4 bg-blue-50 border-blue-200">
          <div className="flex items-start gap-3">
            <Info className="w-5 h-5 text-blue-600 mt-0.5 shrink-0" />
            <p className="text-sm text-blue-800">These are global defaults. Override per page in <button type="button" onClick={() => setLocation("/admin/website/seo")} className="font-semibold underline cursor-pointer">Website &gt; SEO Overrides</button>.</p>
          </div>
        </Card>

        <Card className="border-none shadow-lg shadow-black/5 p-6">
          <SectionHeader title="Default Meta Tags" description="Default SEO metadata used when pages don't specify their own." />
          <div className="space-y-5">
            <FieldGroup label="Meta Title" description={`${titleLen}/60 characters recommended`}>
              <Input value={s.seoMetaTitle || ""} onChange={e => updateSettings({ seoMetaTitle: e.target.value })} maxLength={70} className="rounded-xl" />
            </FieldGroup>
            <FieldGroup label="Meta Description" description={`${descLen}/160 characters recommended`}>
              <Textarea value={s.seoMetaDescription || ""} onChange={e => updateSettings({ seoMetaDescription: e.target.value })} maxLength={200} className="rounded-xl min-h-[70px]" />
            </FieldGroup>
            <FieldGroup label="Keywords" description="Comma-separated keywords">
              <Input value={s.seoKeywords || ""} onChange={e => updateSettings({ seoKeywords: e.target.value })} placeholder="education, consultancy, study abroad" className="rounded-xl" />
            </FieldGroup>
          </div>
        </Card>

        <Card className="border-none shadow-lg shadow-black/5 p-6">
          <SectionHeader title="Robots & Indexing" />
          <div className="space-y-4">
            <div className="flex items-center justify-between p-4 rounded-xl border border-border/50">
              <div><p className="text-sm font-semibold">Allow Search Indexing</p><p className="text-xs text-muted-foreground">Let search engines index your site</p></div>
              <Switch checked={s.robotsIndex !== false} onCheckedChange={v => updateSettings({ robotsIndex: v })} />
            </div>
            <div className="flex items-center justify-between p-4 rounded-xl border border-border/50">
              <div><p className="text-sm font-semibold">Allow Link Following</p><p className="text-xs text-muted-foreground">Let search engines follow links on your pages</p></div>
              <Switch checked={s.robotsFollow !== false} onCheckedChange={v => updateSettings({ robotsFollow: v })} />
            </div>
            <div className="flex items-center justify-between p-4 rounded-xl border border-border/50">
              <div><p className="text-sm font-semibold">Staging Noindex</p><p className="text-xs text-muted-foreground">Block indexing on staging/development environments</p></div>
              <Switch checked={s.stagingNoindex === true} onCheckedChange={v => updateSettings({ stagingNoindex: v })} />
            </div>
          </div>
        </Card>

        <Card className="border-none shadow-lg shadow-black/5 p-6">
          <SectionHeader title="Open Graph / Social Sharing" description="Control how your site appears when shared on social media." />
          <div className="space-y-5">
            <div className="grid sm:grid-cols-2 gap-5">
              <FieldGroup label="OG Title"><Input value={s.ogTitle || ""} onChange={e => updateSettings({ ogTitle: e.target.value })} className="rounded-xl" /></FieldGroup>
              <FieldGroup label="Twitter/X Title"><Input value={s.twitterTitle || ""} onChange={e => updateSettings({ twitterTitle: e.target.value })} className="rounded-xl" /></FieldGroup>
            </div>
            <FieldGroup label="OG Description"><Textarea value={s.ogDescription || ""} onChange={e => updateSettings({ ogDescription: e.target.value })} className="rounded-xl min-h-[60px]" /></FieldGroup>
            <FieldGroup label="Twitter/X Description"><Textarea value={s.twitterDescription || ""} onChange={e => updateSettings({ twitterDescription: e.target.value })} className="rounded-xl min-h-[60px]" /></FieldGroup>
            <div className="grid sm:grid-cols-3 gap-5">
              <LogoUploader label="OG Image" dims="1200x630px" value={s.ogImageUrl || ""} onChange={v => updateSettings({ ogImageUrl: v })} />
              <LogoUploader label="Twitter/X Image" dims="1200x628px" value={s.twitterImageUrl || ""} onChange={v => updateSettings({ twitterImageUrl: v })} />
              <LogoUploader label="Default Share Image" dims="1200x630px" value={s.shareImageUrl || ""} onChange={v => updateSettings({ shareImageUrl: v })} />
            </div>
          </div>
        </Card>

        <Card className="border-none shadow-lg shadow-black/5 p-6">
          <SectionHeader title="Search Preview" description="How your site may appear on Google search results." />
          <div className="p-5 rounded-xl border border-border/50 bg-white dark:bg-gray-950 max-w-lg">
            <p className="text-sm text-blue-700 dark:text-blue-400 truncate">{s.canonicalBaseUrl || "https://yoursite.com"}</p>
            <p className="text-lg text-blue-800 dark:text-blue-300 font-medium truncate hover:underline cursor-pointer mt-0.5">{s.seoMetaTitle || s.siteName || "Your Site Title"}</p>
            <p className="text-sm text-gray-600 dark:text-gray-400 line-clamp-2 mt-1">{s.seoMetaDescription || "Your site description will appear here. Write a compelling description to improve click-through rates."}</p>
          </div>
        </Card>

        <Card className="border-none shadow-lg shadow-black/5 p-6">
          <SectionHeader title="Analytics & Tracking" description="Third-party tracking and verification codes." />
          <div className="grid sm:grid-cols-2 gap-5">
            <FieldGroup label="Google Search Console" description="Verification code"><Input value={s.googleSearchConsoleCode || ""} onChange={e => updateSettings({ googleSearchConsoleCode: e.target.value })} placeholder="google-site-verification=..." className="rounded-xl font-mono text-xs" /></FieldGroup>
            <FieldGroup label="Google Analytics (GA4)" description="Measurement ID"><Input value={s.googleAnalyticsId || ""} onChange={e => updateSettings({ googleAnalyticsId: e.target.value })} placeholder="G-XXXXXXXXXX" className="rounded-xl font-mono text-xs" /></FieldGroup>
            <FieldGroup label="Meta Pixel ID"><Input value={s.metaPixelId || ""} onChange={e => updateSettings({ metaPixelId: e.target.value })} placeholder="123456789012345" className="rounded-xl font-mono text-xs" /></FieldGroup>
            <FieldGroup label="TikTok Pixel ID"><Input value={s.tiktokPixelId || ""} onChange={e => updateSettings({ tiktokPixelId: e.target.value })} className="rounded-xl font-mono text-xs" /></FieldGroup>
          </div>
        </Card>

        <Card className="border-none shadow-lg shadow-black/5 p-6">
          <SectionHeader title="Structured Data (Schema.org)" description="Organization data for rich search results." />
          <div className="grid sm:grid-cols-2 gap-5">
            <FieldGroup label="Organization Name"><Input value={s.orgSchemaName || ""} onChange={e => updateSettings({ orgSchemaName: e.target.value })} className="rounded-xl" /></FieldGroup>
            <FieldGroup label="Website URL"><Input value={s.orgSchemaUrl || ""} onChange={e => updateSettings({ orgSchemaUrl: e.target.value })} className="rounded-xl" /></FieldGroup>
            <FieldGroup label="Logo URL"><Input value={s.orgSchemaLogoUrl || ""} onChange={e => updateSettings({ orgSchemaLogoUrl: e.target.value })} className="rounded-xl" /></FieldGroup>
            <FieldGroup label="Social Profiles" description="Comma-separated URLs"><Input value={s.orgSchemaSocials || ""} onChange={e => updateSettings({ orgSchemaSocials: e.target.value })} className="rounded-xl text-xs" /></FieldGroup>
          </div>
        </Card>

        <SaveButton onClick={() => saveSection("seo", {
          siteName: s.siteName || null, siteTitleTemplate: s.siteTitleTemplate || null,
          seoMetaTitle: s.seoMetaTitle || null, seoMetaDescription: s.seoMetaDescription || null,
          canonicalBaseUrl: s.canonicalBaseUrl || null, seoKeywords: s.seoKeywords || null,
          robotsIndex: s.robotsIndex, robotsFollow: s.robotsFollow, stagingNoindex: s.stagingNoindex,
          ogTitle: s.ogTitle || null, ogDescription: s.ogDescription || null, ogImageUrl: s.ogImageUrl || null,
          twitterTitle: s.twitterTitle || null, twitterDescription: s.twitterDescription || null,
          twitterImageUrl: s.twitterImageUrl || null, shareImageUrl: s.shareImageUrl || null,
          googleSearchConsoleCode: s.googleSearchConsoleCode || null, googleAnalyticsId: s.googleAnalyticsId || null,
          metaPixelId: s.metaPixelId || null, tiktokPixelId: s.tiktokPixelId || null,
          orgSchemaName: s.orgSchemaName || null, orgSchemaUrl: s.orgSchemaUrl || null,
          orgSchemaLogoUrl: s.orgSchemaLogoUrl || null, orgSchemaSocials: s.orgSchemaSocials || null,
        })} saving={sectionSaving === "seo"} label="Save SEO Settings" />
      </div>
    );
  }

  function EmailBrandingTab() {
    const s = settings;
    return (
      <div className="space-y-6">
        <Card className="border-none shadow-lg shadow-black/5 p-6">
          <SectionHeader title="Email Identity" description="Configure the sender details for all outgoing emails." />
          <div className="grid sm:grid-cols-2 gap-5">
            <FieldGroup label="Sender Name" description="Displayed as the 'From' name"><Input value={s.emailSenderName || ""} onChange={e => updateSettings({ emailSenderName: e.target.value })} placeholder="Find & Study" className="rounded-xl" /></FieldGroup>
            <FieldGroup label="Sender Email"><Input value={s.emailSenderEmail || ""} onChange={e => updateSettings({ emailSenderEmail: e.target.value })} type="email" placeholder="info@findandstudy.com" className="rounded-xl" /></FieldGroup>
            <FieldGroup label="Reply-To Email" className="sm:col-span-2"><Input value={s.emailReplyTo || ""} onChange={e => updateSettings({ emailReplyTo: e.target.value })} type="email" className="rounded-xl" /></FieldGroup>
          </div>
        </Card>

        <Card className="border-none shadow-lg shadow-black/5 p-6">
          <SectionHeader title="Email Branding" description="Customize the look of outgoing emails." />
          <div className="space-y-5">
            <LogoUploader label="Email Header Logo" dims="300x80px, PNG" value={s.emailLogoUrl || ""} onChange={v => updateSettings({ emailLogoUrl: v })} />
            <ColorField label="Email Button Color" description="Primary button color in emails" value={s.emailButtonColor || ""} onChange={v => updateSettings({ emailButtonColor: v })} defaultColor="#143591" />
            <FieldGroup label="Email Footer Text" description="Shown at the bottom of every email">
              <Textarea value={s.emailFooterText || ""} onChange={e => updateSettings({ emailFooterText: e.target.value })} className="rounded-xl min-h-[60px]" placeholder="Find & Study Educational Consulting&#10;Istanbul, Turkey" />
            </FieldGroup>
            <FieldGroup label="Email Signature Block" description="Rich signature text appended to emails">
              <Textarea value={s.emailSignatureBlock || ""} onChange={e => updateSettings({ emailSignatureBlock: e.target.value })} className="rounded-xl min-h-[60px]" />
            </FieldGroup>
            <FieldGroup label="Disclaimer Text" description="Legal disclaimer at the bottom of emails">
              <Textarea value={s.emailDisclaimerText || ""} onChange={e => updateSettings({ emailDisclaimerText: e.target.value })} className="rounded-xl min-h-[50px]" placeholder="This email and any attachments are confidential..." />
            </FieldGroup>
          </div>
        </Card>

        <Card className="border-none shadow-lg shadow-black/5 p-6">
          <SectionHeader title="Email Preview" description="How a branded email might look." />
          <div className="max-w-md mx-auto rounded-xl border border-border/50 overflow-hidden bg-white dark:bg-gray-950">
            <div className="px-6 py-4 border-b border-border/30 text-center" style={{ backgroundColor: (s.emailButtonColor || "#143591") + "10" }}>
              {s.emailLogoUrl ? <img src={s.emailLogoUrl} className="max-h-10 mx-auto object-contain" alt="" /> : <p className="font-bold text-lg" style={{ color: s.emailButtonColor || "#143591" }}>{s.emailSenderName || "Your Company"}</p>}
            </div>
            <div className="px-6 py-5">
              <p className="text-sm text-gray-800 dark:text-gray-200 mb-4">Hello,</p>
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">This is a preview of how your branded emails will appear to recipients.</p>
              <div className="text-center my-4">
                <button className="px-6 py-2.5 rounded-lg text-white text-sm font-medium" style={{ backgroundColor: s.emailButtonColor || "#143591" }}>View Details</button>
              </div>
            </div>
            <div className="px-6 py-3 border-t border-border/30 bg-gray-50 dark:bg-gray-900">
              <p className="text-[10px] text-gray-500 text-center whitespace-pre-line">{s.emailFooterText || "Your company footer text"}</p>
              {s.emailDisclaimerText && <p className="text-[9px] text-gray-400 text-center mt-2 italic">{s.emailDisclaimerText}</p>}
            </div>
          </div>
        </Card>

        <SaveButton onClick={() => saveSection("email", {
          emailSenderName: s.emailSenderName || null, emailSenderEmail: s.emailSenderEmail || null,
          emailReplyTo: s.emailReplyTo || null, emailLogoUrl: s.emailLogoUrl || null,
          emailFooterText: s.emailFooterText || null, emailSignatureBlock: s.emailSignatureBlock || null,
          emailButtonColor: s.emailButtonColor || null, emailDisclaimerText: s.emailDisclaimerText || null,
        })} saving={sectionSaving === "email"} label="Save Email Branding" />
      </div>
    );
  }

  function DocumentsTab() {
    const s = settings;
    return (
      <div className="space-y-6">
        <Card className="border-none shadow-lg shadow-black/5 p-6">
          <SectionHeader title="PDF / Document Branding" description="Customize the identity of generated PDFs and documents." />
          <div className="space-y-5">
            <LogoUploader label="PDF Logo" dims="300x80px, PNG/SVG" value={s.pdfLogoUrl || ""} onChange={v => updateSettings({ pdfLogoUrl: v })} />
            <div className="grid sm:grid-cols-2 gap-5">
              <FieldGroup label="Header Text" description="Displayed at the top of PDF documents">
                <Input value={s.pdfHeaderText || ""} onChange={e => updateSettings({ pdfHeaderText: e.target.value })} placeholder="Find & Study Educational Consulting" className="rounded-xl" />
              </FieldGroup>
              <FieldGroup label="Footer Text" description="Displayed at the bottom of every page">
                <Input value={s.pdfFooterText || ""} onChange={e => updateSettings({ pdfFooterText: e.target.value })} placeholder="© 2025 Find & Study. All rights reserved." className="rounded-xl" />
              </FieldGroup>
              <FieldGroup label="Watermark Text" description="Faint text overlaid on document pages">
                <Input value={s.pdfWatermarkText || ""} onChange={e => updateSettings({ pdfWatermarkText: e.target.value })} placeholder="CONFIDENTIAL" className="rounded-xl" />
              </FieldGroup>
              <FieldGroup label="Signature Label" description="Label above the signature line">
                <Input value={s.pdfSignatureLabel || ""} onChange={e => updateSettings({ pdfSignatureLabel: e.target.value })} placeholder="Authorized Representative" className="rounded-xl" />
              </FieldGroup>
            </div>
            <div className="grid sm:grid-cols-2 gap-5">
              <LogoUploader label="Seal / Stamp Image" dims="200x200px, PNG" value={s.pdfSealImageUrl || ""} onChange={v => updateSettings({ pdfSealImageUrl: v })} />
              <div>
                <ColorField label="Document Primary Color" description="Accent color for PDF headers, borders, and highlights" value={s.pdfPrimaryColor || ""} onChange={v => updateSettings({ pdfPrimaryColor: v })} defaultColor="#143591" />
              </div>
              <div>
                <ColorField label="Proposal PDF Accent Color" description="Controls header gradient, card colors, numbered badges, and page number in the program proposal PDF. Falls back to navy/blue if unset." value={s.pdfAccentColor || ""} onChange={v => updateSettings({ pdfAccentColor: v })} defaultColor="#1e40af" />
              </div>
            </div>
          </div>
        </Card>

        <Card className="border-none shadow-lg shadow-black/5 p-6">
          <SectionHeader title="Document Preview" description="How your branded documents may look." />
          <div className="max-w-sm mx-auto">
            <div className="rounded-xl border border-border/50 overflow-hidden bg-white dark:bg-gray-950 shadow-sm">
              <div className="h-2 w-full" style={{ backgroundColor: s.pdfPrimaryColor || "#143591" }} />
              <div className="px-5 py-4 flex items-center justify-between border-b border-border/30">
                {s.pdfLogoUrl ? <img src={s.pdfLogoUrl} className="max-h-8 object-contain" alt="" /> : <p className="text-sm font-bold" style={{ color: s.pdfPrimaryColor || "#143591" }}>Company Logo</p>}
                <p className="text-[10px] text-muted-foreground">{s.pdfHeaderText || "Header Text"}</p>
              </div>
              <div className="px-5 py-6">
                <div className="h-2 bg-gray-200 dark:bg-gray-700 rounded w-3/4 mb-2" />
                <div className="h-2 bg-gray-200 dark:bg-gray-700 rounded w-full mb-2" />
                <div className="h-2 bg-gray-200 dark:bg-gray-700 rounded w-5/6 mb-4" />
                {s.pdfWatermarkText && (
                  <p className="text-center text-2xl font-bold text-gray-100 dark:text-gray-800 my-4 select-none">{s.pdfWatermarkText}</p>
                )}
                <div className="mt-4 pt-3 border-t border-dashed border-border/50 flex items-end justify-between">
                  <div>
                    <p className="text-[9px] text-muted-foreground">{s.pdfSignatureLabel || "Signature"}</p>
                    <div className="h-px w-24 bg-gray-300 mt-3" />
                  </div>
                  {s.pdfSealImageUrl && <img src={s.pdfSealImageUrl} className="w-12 h-12 object-contain opacity-60" alt="" />}
                </div>
              </div>
              <div className="px-5 py-2 border-t border-border/30 bg-gray-50 dark:bg-gray-900">
                <p className="text-[9px] text-gray-500 text-center">{s.pdfFooterText || "Footer text"}</p>
              </div>
            </div>
          </div>
        </Card>

        <SaveButton onClick={() => saveSection("documents", {
          pdfLogoUrl: s.pdfLogoUrl || null, pdfHeaderText: s.pdfHeaderText || null,
          pdfFooterText: s.pdfFooterText || null, pdfWatermarkText: s.pdfWatermarkText || null,
          pdfSignatureLabel: s.pdfSignatureLabel || null, pdfSealImageUrl: s.pdfSealImageUrl || null,
          pdfPrimaryColor: s.pdfPrimaryColor || null,
          pdfAccentColor: s.pdfAccentColor || null,
        })} saving={sectionSaving === "documents"} label="Save Document Settings" />
      </div>
    );
  }

  function IntegrationsTab() {
    return (
      <div className="space-y-8">
        <IntegrationsManager />
        <div className="space-y-4">
          <SectionHeader title={t("apiTokens.title")} description={t("apiTokens.description")} />
          <ApiTokensManager embedded />
        </div>
      </div>
    );
  }

  function AdvancedTab() {
    const s = settings;
    const isSuperAdmin = user?.role === "super_admin";
    return (
      <div className="space-y-6">
        <Card className="border-none shadow-lg shadow-black/5 p-6">
          <SectionHeader title="Site Configuration" description="Domain, sitemap, and robots settings." />
          <div className="grid sm:grid-cols-2 gap-5">
            <FieldGroup label="Canonical Domain"><Input value={s.canonicalBaseUrl || ""} onChange={e => updateSettings({ canonicalBaseUrl: e.target.value })} placeholder="https://findandstudy.com" className="rounded-xl" /></FieldGroup>
            <FieldGroup label="Sitemap URL"><Input value={s.sitemapUrl || ""} onChange={e => updateSettings({ sitemapUrl: e.target.value })} placeholder="/sitemap.xml" className="rounded-xl" /></FieldGroup>
            <FieldGroup label="robots.txt Content" description="Custom robots.txt rules" className="sm:col-span-2">
              <Textarea value={s.robotsTxtContent || ""} onChange={e => updateSettings({ robotsTxtContent: e.target.value })} className="rounded-xl font-mono text-xs min-h-[80px]" placeholder="User-agent: *&#10;Allow: /" />
            </FieldGroup>
          </div>
        </Card>

        <Card className="border-none shadow-lg shadow-black/5 p-6">
          <SectionHeader title="Tracking & Widgets" description="Third-party integrations and widget configurations." />
          <div className="grid sm:grid-cols-2 gap-5">
            <FieldGroup label="LinkedIn Insight Tag"><Input value={s.linkedinInsightTag || ""} onChange={e => updateSettings({ linkedinInsightTag: e.target.value })} className="rounded-xl font-mono text-xs" /></FieldGroup>
            <FieldGroup label="Microsoft Clarity / Hotjar ID"><Input value={s.clarityId || ""} onChange={e => updateSettings({ clarityId: e.target.value })} className="rounded-xl font-mono text-xs" /></FieldGroup>
            <FieldGroup label="reCAPTCHA Site Key"><Input value={s.recaptchaSiteKey || ""} onChange={e => updateSettings({ recaptchaSiteKey: e.target.value })} className="rounded-xl font-mono text-xs" /></FieldGroup>
            <FieldGroup label="WhatsApp Widget Number" description="Floating chat widget"><Input value={s.whatsappWidgetNumber || ""} onChange={e => updateSettings({ whatsappWidgetNumber: e.target.value })} placeholder="+90 555 123 4567" className="rounded-xl" /></FieldGroup>
          </div>
        </Card>

        {isSuperAdmin && (
          <Card className="border-none shadow-lg shadow-black/5 p-6 border-l-4 border-l-amber-400">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
              <div className="flex-1">
                <SectionHeader title="Custom Scripts" description="Inject custom code into the page. Use with caution — incorrect scripts may break the application." />
                <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 mb-4">
                  <p className="text-xs text-amber-700 dark:text-amber-400">Only Super Admins can edit these fields. Malicious or broken scripts can compromise security and functionality.</p>
                </div>
                <div className="space-y-5">
                  <FieldGroup label="Custom Head Script" description="Injected before </head> — for analytics, fonts, etc.">
                    <Textarea value={s.customHeadScript || ""} onChange={e => updateSettings({ customHeadScript: e.target.value })} className="rounded-xl font-mono text-xs min-h-[80px]" placeholder="<!-- Google Tag Manager -->" />
                  </FieldGroup>
                  <FieldGroup label="Custom Body-End Script" description="Injected before </body> — for chat widgets, etc.">
                    <Textarea value={s.customBodyEndScript || ""} onChange={e => updateSettings({ customBodyEndScript: e.target.value })} className="rounded-xl font-mono text-xs min-h-[80px]" placeholder="<!-- Live chat widget -->" />
                  </FieldGroup>
                  <FieldGroup label="Live Chat Script" description="Full live chat embed code">
                    <Textarea value={s.liveChatScript || ""} onChange={e => updateSettings({ liveChatScript: e.target.value })} className="rounded-xl font-mono text-xs min-h-[80px]" />
                  </FieldGroup>
                </div>
              </div>
            </div>
          </Card>
        )}

        <SaveButton onClick={() => {
          const payload: Record<string, any> = {
            canonicalBaseUrl: s.canonicalBaseUrl || null, sitemapUrl: s.sitemapUrl || null,
            robotsTxtContent: s.robotsTxtContent || null,
            linkedinInsightTag: s.linkedinInsightTag || null, clarityId: s.clarityId || null,
            recaptchaSiteKey: s.recaptchaSiteKey || null, whatsappWidgetNumber: s.whatsappWidgetNumber || null,
          };
          if (isSuperAdmin) {
            payload.customHeadScript = s.customHeadScript || null;
            payload.customBodyEndScript = s.customBodyEndScript || null;
            payload.liveChatScript = s.liveChatScript || null;
          }
          saveSection("advanced", payload);
        }} saving={sectionSaving === "advanced"} label="Save Advanced Settings" />
      </div>
    );
  }

  return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-display font-bold text-foreground">{t("settingsPage.settings")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("settingsHeader.subtitle")}</p>
        </div>

        <div className="lg:hidden mb-4">
          <div className="flex flex-wrap gap-1.5 p-1 bg-secondary/50 rounded-xl">
            {visibleNav.map(n => (
              <button key={n.id} onClick={() => setActiveTab(n.id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all
                  ${activeTab === n.id ? "bg-background text-primary shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
                <n.icon className="w-3.5 h-3.5" />
                {t(`settingsPage.${n.navKey}`)}
              </button>
            ))}
          </div>
        </div>

        <div className="flex gap-6 min-h-[600px]">
          <nav className="w-56 shrink-0 hidden lg:block">
            <div className="sticky top-20 space-y-1">
              <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider px-3 py-2">{t("settingsPage.personalGroup")}</p>
              {visibleNav.filter(n => n.group === "personal").map(n => (
                <button key={n.id} onClick={() => setActiveTab(n.id)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-all text-left
                    ${activeTab === n.id ? "bg-primary/10 text-primary font-semibold" : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"}`}>
                  <n.icon className="w-4 h-4 shrink-0" />
                  {t(`settingsPage.${n.navKey}`)}
                </button>
              ))}
              {isManager && (
                <>
                  <div className="h-px bg-border/50 my-3" />
                  <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider px-3 py-2">{t("settingsPage.organizationGroup")}</p>
                  {visibleNav.filter(n => n.group === "organization").map(n => (
                    <button key={n.id} onClick={() => setActiveTab(n.id)}
                      className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-all text-left
                        ${activeTab === n.id ? "bg-primary/10 text-primary font-semibold" : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"}`}>
                      <n.icon className="w-4 h-4 shrink-0" />
                      {t(`settingsPage.${n.navKey}`)}
                    </button>
                  ))}
                </>
              )}
            </div>
          </nav>

          <div className="flex-1 min-w-0 max-w-3xl">
            {renderContent()}
          </div>
        </div>
      </div>
  );
}

function PipelineTab({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
  const leadPipeline = usePipelineStages("lead", true);
  const applicationPipeline = usePipelineStages("application", true);
  const studentPipeline = usePipelineStages("student", true);
  const [editingType, setEditingType] = useState<string | null>(null);
  const { toast } = useToast();

  const { t } = useI18n();
  const [autoConvert, setAutoConvert] = useState<{ enabled: boolean; stageKey: string }>({ enabled: true, stageKey: "active" });
  const [autoConvertLoaded, setAutoConvertLoaded] = useState(false);
  const [savingAutoConvert, setSavingAutoConvert] = useState(false);

  useEffect(() => {
    customFetch("/api/settings").then((data: any) => {
      setAutoConvert({
        enabled: data?.autoConvertLeadEnabled !== false,
        stageKey: data?.autoConvertStudentStageKey || "active",
      });
      setAutoConvertLoaded(true);
    }).catch(() => { setAutoConvertLoaded(true); });
  }, []);

  async function saveAutoConvert(next: { enabled: boolean; stageKey: string }) {
    setSavingAutoConvert(true);
    try {
      await customFetch("/api/settings", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          autoConvertLeadEnabled: next.enabled,
          autoConvertStudentStageKey: next.stageKey,
        }),
      });
      setAutoConvert(next);
      toast({ title: "Auto-convert settings saved" });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally { setSavingAutoConvert(false); }
  }

  const pipelines = [
    { type: "lead", label: "Lead Pipeline", description: "Stages for tracking prospective student leads from initial contact to conversion.", pipeline: leadPipeline },
    { type: "application", label: "Application Pipeline", description: "Stages for tracking university applications from inquiry to enrollment.", pipeline: applicationPipeline },
    { type: "student", label: "Student Pipeline", description: "Stages for tracking student lifecycle from active enrollment to graduation.", pipeline: studentPipeline },
  ];

  const activePipeline = pipelines.find(p => p.type === editingType);

  return (
    <div className="space-y-6">
      <Card className="border-none shadow-lg shadow-black/5 p-6">
        <SectionHeader
          title="Lead → Student Auto-Convert"
          description="Control what happens when an applicant completes the public Apply form or the embed widget. When enabled, the lead is moved to 'converted' and the linked student's status is set to the stage you choose."
        />
        <div className="grid gap-5 sm:grid-cols-[1fr_240px] items-start">
          <div className="flex items-start gap-3 p-4 rounded-xl border border-border/50">
            <Switch
              checked={autoConvert.enabled}
              onCheckedChange={(v) => saveAutoConvert({ ...autoConvert, enabled: !!v })}
              disabled={!autoConvertLoaded || savingAutoConvert}
            />
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-sm">Auto-convert on full submit</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Public Apply and Embed widget submissions automatically convert the lead and create an active student. Disable to keep new submissions in the leads pipeline for manual review.
              </p>
            </div>
          </div>
          <FieldGroup label="Initial student stage" description="Used as the student's status when auto-convert fires.">
            <Select
              value={autoConvert.stageKey}
              onValueChange={(v) => saveAutoConvert({ ...autoConvert, stageKey: v })}
              disabled={!autoConvertLoaded || savingAutoConvert || !autoConvert.enabled || studentPipeline.stages.length === 0}
            >
              <SelectTrigger className="rounded-xl">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {studentPipeline.stages.map(s => (
                  <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldGroup>
        </div>
      </Card>

      <Card className="border-none shadow-lg shadow-black/5 p-6">
        <SectionHeader title="Pipeline Stages" description="Configure the pipeline stages for leads, applications, and students. Changes here apply to all users — staff, agents, and sub-agents. On the Application pipeline you can also map each stage to a student status — when the application reaches that stage, the linked student's status is updated automatically." />
        <div className="space-y-4">
          {pipelines.map(({ type, label, description, pipeline }) => (
            <div key={type} className="flex items-center justify-between p-4 rounded-xl border border-border/50 hover:border-primary/20 transition-colors">
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-sm text-foreground">{label}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {pipeline.stages.map(s => (
                    <span key={s.key} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border ${
                      s.variant === "won" ? "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-400 dark:border-emerald-800" :
                      s.variant === "partial_won" ? "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-400 dark:border-amber-800" :
                      s.variant === "lost" ? "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950 dark:text-rose-400 dark:border-rose-800" :
                      s.variant === "none_finance" ? "bg-gray-50 text-gray-500 border-gray-200 dark:bg-gray-900 dark:text-gray-400 dark:border-gray-700" :
                      "bg-secondary text-muted-foreground border-border/50"
                    }`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${s.variant === "won" ? "bg-emerald-500" : s.variant === "partial_won" ? "bg-amber-500" : s.variant === "lost" ? "bg-rose-500" : s.variant === "none_finance" ? "bg-gray-300" : "bg-muted-foreground/40"}`} />
                      {s.label}
                    </span>
                  ))}
                </div>
              </div>
              <Button variant="outline" size="sm" className="shrink-0 ml-4" onClick={() => setEditingType(type)}>
                <Pencil className="w-3.5 h-3.5 mr-1.5" /> Edit
              </Button>
            </div>
          ))}
        </div>
      </Card>

      {activePipeline && (
        <EditStagesDialog
          open={!!editingType}
          onClose={() => setEditingType(null)}
          stages={activePipeline.pipeline.stages}
          onSave={async (s) => {
            const result = await activePipeline.pipeline.saveStages(s);
            qc.invalidateQueries({ queryKey: ["pipeline-stages"] });
            const warnings = result.warnings;
            if (warnings.length > 0) {
              for (const w of warnings) {
                toast({ title: "Pipeline warning", description: w, variant: "default" });
              }
            } else {
              toast({ title: "Pipeline stages saved" });
            }
          }}
          isSaving={activePipeline.pipeline.isSaving}
          entityLabel={activePipeline.label.replace(" Pipeline", "")}
          studentStages={activePipeline.type === "application" ? studentPipeline.stages : undefined}
        />
      )}
    </div>
  );
}

type YearDetail = { year: number; startDate: string; endDate: string };

function YearsManagement() {
  const { toast } = useToast();
  const [details, setDetails] = useState<YearDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [newYear, setNewYear] = useState("");
  const [newStart, setNewStart] = useState("");
  const [newEnd, setNewEnd] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const data: any = await customFetch("/api/settings/available-years");
        if (Array.isArray(data.details) && data.details.length) {
          setDetails(data.details);
        } else if (Array.isArray(data.years)) {
          setDetails(data.years.map((y: number) => ({ year: y, startDate: `${y}-01-01`, endDate: `${y}-12-31` })));
        }
      } catch {
        const cy = new Date().getFullYear();
        setDetails(Array.from({ length: 6 }, (_, i) => {
          const y = cy - 2 + i;
          return { year: y, startDate: `${y}-01-01`, endDate: `${y}-12-31` };
        }));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function persist(updated: YearDetail[]) {
    const sorted = [...updated].sort((a, b) => a.year - b.year);
    setSaving(true);
    try {
      await customFetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ availableYears: sorted }),
      });
      setDetails(sorted);
      toast({ title: "Academic years updated" });
    } catch (err: any) {
      toast({ title: "Failed to save", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  function isoOk(s: string) { return /^\d{4}-\d{2}-\d{2}$/.test(s); }

  function handleAdd() {
    const y = parseInt(newYear, 10);
    if (isNaN(y) || y < 2000 || y > 2100) {
      toast({ title: "Enter a valid year (2000–2100)", variant: "destructive" });
      return;
    }
    if (details.some(d => d.year === y)) {
      toast({ title: "Year already exists", variant: "destructive" });
      return;
    }
    const start = newStart && isoOk(newStart) ? newStart : `${y}-01-01`;
    const end = newEnd && isoOk(newEnd) ? newEnd : `${y}-12-31`;
    if (start > end) {
      toast({ title: "Start date must be before end date", variant: "destructive" });
      return;
    }
    setNewYear(""); setNewStart(""); setNewEnd("");
    persist([...details, { year: y, startDate: start, endDate: end }]);
  }

  function handleRemove(y: number) {
    if (details.length <= 1) return;
    persist(details.filter(d => d.year !== y));
  }

  function updateDate(y: number, field: "startDate" | "endDate", value: string) {
    if (!isoOk(value)) return;
    const next = details.map(d => d.year === y ? { ...d, [field]: value } : d);
    const target = next.find(d => d.year === y)!;
    if (target.startDate > target.endDate) {
      toast({ title: "Start date must be before end date", variant: "destructive" });
      return;
    }
    persist(next);
  }

  if (loading) {
    return (
      <Card className="border-none shadow-lg shadow-black/5 p-6">
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      </Card>
    );
  }

  return (
    <Card className="border-none shadow-lg shadow-black/5 p-6">
      <SectionHeader
        title="Academic Years"
        description="Define each academic year and its season window (start & end dates). The system uses today's date to decide which year is the active season — so records auto-tag correctly even when the season doesn't start on January 1."
      />

      <div className="rounded-xl border border-dashed border-primary/30 bg-primary/5 p-4 mb-6">
        <p className="text-xs font-semibold text-foreground mb-3 uppercase tracking-wider">Add a new year</p>
        <div className="grid grid-cols-1 md:grid-cols-[140px_1fr_1fr_auto] gap-3 items-end">
          <div>
            <label className="text-[11px] font-medium text-muted-foreground block mb-1">Year</label>
            <Input
              type="number"
              value={newYear}
              onChange={e => setNewYear(e.target.value)}
              placeholder="e.g. 2027"
              className="rounded-xl"
              min={2000}
              max={2100}
            />
          </div>
          <div>
            <label className="text-[11px] font-medium text-muted-foreground block mb-1">Season starts</label>
            <Input
              type="date"
              value={newStart}
              onChange={e => setNewStart(e.target.value)}
              className="rounded-xl"
              placeholder="YYYY-MM-DD"
            />
          </div>
          <div>
            <label className="text-[11px] font-medium text-muted-foreground block mb-1">Season ends</label>
            <Input
              type="date"
              value={newEnd}
              onChange={e => setNewEnd(e.target.value)}
              className="rounded-xl"
              placeholder="YYYY-MM-DD"
            />
          </div>
          <Button onClick={handleAdd} disabled={saving || !newYear.trim()} className="rounded-xl gap-2 shrink-0 h-10">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            Add
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground mt-2">If you leave dates empty we default to Jan 1 → Dec 31 of the year you entered.</p>
      </div>

      <div className="space-y-2">
        {details.map(d => {
          const today = new Date().toISOString().slice(0, 10);
          const isActive = d.startDate <= today && today <= d.endDate;
          return (
            <div key={d.year} className={`grid grid-cols-1 md:grid-cols-[140px_1fr_1fr_auto] gap-3 items-center p-3 rounded-xl border ${isActive ? "border-emerald-300 bg-emerald-50/50 dark:bg-emerald-950/20" : "border-border/50 bg-background"}`}>
              <div className="flex items-center gap-2">
                <CalendarDays className={`w-4 h-4 ${isActive ? "text-emerald-600" : "text-primary"}`} />
                <span className="text-sm font-bold text-foreground">{d.year}</span>
                {isActive && (
                  <Badge className="text-[9px] bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300 border-0 px-1.5 py-0">Active</Badge>
                )}
              </div>
              <Input
                type="date"
                value={d.startDate}
                onChange={e => updateDate(d.year, "startDate", e.target.value)}
                disabled={saving}
                className="rounded-lg h-9 text-sm"
              />
              <Input
                type="date"
                value={d.endDate}
                onChange={e => updateDate(d.year, "endDate", e.target.value)}
                disabled={saving}
                className="rounded-lg h-9 text-sm"
              />
              <button
                onClick={() => handleRemove(d.year)}
                disabled={saving || details.length <= 1}
                className="w-8 h-8 rounded-lg hover:bg-destructive/10 flex items-center justify-center text-muted-foreground hover:text-destructive transition-colors disabled:opacity-30 justify-self-end"
                title="Remove year"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          );
        })}
      </div>
    </Card>
  );
}


const TARGET_LABELS: Record<string, string> = {
  agent: "Agent",
  sub_agent: "Sub Agent",
  staff: "Staff",
  student: "Student",
};

const TARGET_COLORS: Record<string, string> = {
  agent: "bg-blue-500/10 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  sub_agent: "bg-purple-500/10 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
  staff: "bg-emerald-500/10 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
  student: "bg-amber-500/10 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
};

const PRESET_COLORS = [
  "#6366f1", "#8b5cf6", "#ec4899", "#ef4444",
  "#f97316", "#eab308", "#22c55e", "#06b6d4",
  "#3b82f6", "#64748b",
];

function QuickLinksTab() {
  const { t } = useI18n();
  const { toast } = useToast();
  const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

  const [links, setLinks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState({ title: "", url: "", logoUrl: "", color: "#6366f1", target: "agent" as string, sortOrder: 0 });
  const [logoUploading, setLogoUploading] = useState(false);
  const [missingLogoIds, setMissingLogoIds] = useState<Set<number>>(new Set());
  const logoInputRef = useRef<HTMLInputElement>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<number | null>(null);

  const fetchLinks = useCallback(async () => {
    try {
      const res = await fetch(`${BASE}/api/quick-links/admin`, { credentials: "include" });
      const data = await res.json();
      setLinks(data.data || []);
      // Clear stale missing-logo flags; each rendered logo re-checks on load.
      setMissingLogoIds(new Set());
    } catch {} finally {
      setLoading(false);
    }
  }, [BASE]);

  useEffect(() => { fetchLinks(); }, [fetchLinks]);

  const handleSave = async () => {
    if (!form.title.trim() || !form.url.trim()) {
      toast({ title: "Error", description: "Title and URL are required.", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const method = editingId ? "PATCH" : "POST";
      const url = editingId ? `${BASE}/api/quick-links/${editingId}` : `${BASE}/api/quick-links`;
      await customFetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: form.title.trim(),
          url: form.url.trim(),
          logoUrl: form.logoUrl || null,
          color: form.color || null,
          target: form.target,
          sortOrder: form.sortOrder,
        }),
      });
      toast({ title: editingId ? "Updated" : "Created", description: `Quick link "${form.title}" has been ${editingId ? "updated" : "created"}.` });
      setShowForm(false);
      setEditingId(null);
      setForm({ title: "", url: "", logoUrl: "", color: "#6366f1", target: "agent", sortOrder: 0 });
      fetchLinks();
    } catch (e: any) {
      toast({ title: "Error", description: e.message || "Failed to save quick link.", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await customFetch(`${BASE}/api/quick-links/${id}`, { method: "DELETE" });
      toast({ title: "Deleted", description: "Quick link has been removed." });
      fetchLinks();
    } catch (e: any) {
      toast({ title: "Error", description: e.message || "Failed to delete.", variant: "destructive" });
    }
    setDeleteConfirm(null);
  };

  const handleToggle = async (id: number, currentActive: boolean) => {
    try {
      await customFetch(`${BASE}/api/quick-links/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !currentActive }),
      });
      fetchLinks();
    } catch {}
  };

  const uploadLogo = async (file: File) => {
    setLogoUploading(true);
    try {
      const urlRes = await customFetch(`/api/storage/uploads/request-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type, prefix: "branding" }),
      });
      if (!(urlRes as any).uploadURL || !(urlRes as any).objectPath) throw new Error("Failed to get upload URL");
      const putRes = await fetch((urlRes as any).uploadURL, { method: "PUT", body: file, headers: { "Content-Type": file.type } });
      if (!putRes.ok) throw new Error("Upload failed");
      const strippedPath = (urlRes as any).objectPath.replace(/^\/objects/, "");
      const logoPath = `${BASE}/api/storage/objects${strippedPath}`;
      setForm(f => ({ ...f, logoUrl: logoPath }));
      toast({ title: "Logo uploaded" });
    } catch (err: any) {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    } finally {
      setLogoUploading(false);
    }
  };

  const openEdit = (link: any) => {
    setForm({
      title: link.title,
      url: link.url,
      logoUrl: link.logoUrl || "",
      color: link.color || "#6366f1",
      target: link.target,
      sortOrder: link.sortOrder ?? 0,
    });
    setEditingId(link.id);
    setShowForm(true);
  };

  const openNew = () => {
    setForm({ title: "", url: "", logoUrl: "", color: "#6366f1", target: "agent", sortOrder: 0 });
    setEditingId(null);
    setShowForm(true);
  };

  return (
    <div className="space-y-6">
      <Card className="border-none shadow-lg shadow-black/5 p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h3 className="font-display font-bold text-lg">{t("settingsPage.quickLinks")}</h3>
            <p className="text-sm text-muted-foreground mt-1">
              Manage custom shortcut buttons that appear on user dashboards.
            </p>
          </div>
          <Button onClick={openNew} className="gap-2">
            <Plus className="w-4 h-4" /> Add Link
          </Button>
        </div>

        {showForm && (
          <Card className="p-5 mb-6 border-2 border-primary/20 bg-primary/[0.02]">
            <h4 className="font-semibold text-sm mb-4">{editingId ? "Edit Quick Link" : "New Quick Link"}</h4>
            <div className="grid sm:grid-cols-2 gap-4 mb-4">
              <div>
                <Label className="text-xs font-medium mb-1.5">{t("settingsPage.title")}</Label>
                <Input
                  value={form.title}
                  onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                  placeholder="e.g. Dorm Booking"
                />
              </div>
              <div>
                <Label className="text-xs font-medium mb-1.5">{t("settingsPage.url")}</Label>
                <Input
                  value={form.url}
                  onChange={e => setForm(f => ({ ...f, url: e.target.value }))}
                  placeholder="https://dormbooking.com"
                />
              </div>
              <div>
                <Label className="text-xs font-medium mb-1.5">{t("settingsPage.logo")}</Label>
                <div className="relative w-full h-[72px] rounded-xl border-2 border-dashed border-border hover:border-primary/50 transition-colors flex items-center justify-center overflow-hidden bg-secondary/20">
                  {form.logoUrl ? (
                    <>
                      <img src={form.logoUrl} alt="Logo" className="max-h-14 max-w-full object-contain" />
                      <button onClick={() => setForm(f => ({ ...f, logoUrl: "" }))}
                        className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-destructive/90 text-white flex items-center justify-center hover:bg-destructive">
                        <X className="w-3 h-3" />
                      </button>
                    </>
                  ) : (
                    <button onClick={() => logoInputRef.current?.click()} disabled={logoUploading}
                      className="flex items-center gap-2 text-muted-foreground hover:text-primary transition-colors text-xs">
                      {logoUploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                      <span className="font-medium">{logoUploading ? "Uploading..." : "Upload Logo"}</span>
                    </button>
                  )}
                </div>
                <input ref={logoInputRef} type="file" accept="image/*" className="hidden"
                  onChange={e => { const f = e.target.files?.[0]; if (f) uploadLogo(f); e.target.value = ""; }} />
              </div>
              <div>
                <Label className="text-xs font-medium mb-1.5">{t("settingsPage.target")}</Label>
                <div className="flex flex-wrap gap-2 mt-1">
                  {[
                    { value: "agent", label: t("settingsPage.roleAgent") },
                    { value: "sub_agent", label: t("settingsPage.roleSubAgent") },
                    { value: "staff", label: t("settingsPage.roleStaff") },
                    { value: "student", label: t("settingsPage.roleStudent") },
                  ].map(opt => {
                    const targets = form.target.split(",").filter(Boolean);
                    const checked = targets.includes(opt.value);
                    return (
                      <label key={opt.value} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium cursor-pointer transition-all ${checked ? "border-primary bg-primary/10 text-primary" : "border-border bg-background text-muted-foreground hover:border-primary/40"}`}>
                        <input type="checkbox" checked={checked} onChange={() => {
                          setForm(f => {
                            const ts = f.target.split(",").filter(Boolean);
                            const next = checked ? ts.filter(t => t !== opt.value) : [...ts, opt.value];
                            return { ...f, target: next.length > 0 ? next.join(",") : "" };
                          });
                        }} className="sr-only" />
                        {opt.label}
                      </label>
                    );
                  })}
                </div>
              </div>
              <div>
                <Label className="text-xs font-medium mb-1.5">{t("settingsPage.sortOrder")}</Label>
                <Input
                  type="number"
                  value={form.sortOrder}
                  onChange={e => setForm(f => ({ ...f, sortOrder: parseInt(e.target.value) || 0 }))}
                />
              </div>
              <div>
                <Label className="text-xs font-medium mb-1.5">{t("settingsPage.color")}</Label>
                <div className="flex items-center gap-2 flex-wrap">
                  {PRESET_COLORS.map(c => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setForm(f => ({ ...f, color: c }))}
                      className={`w-7 h-7 rounded-lg border-2 transition-all ${form.color === c ? "border-foreground scale-110" : "border-transparent"}`}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2 justify-end">
              <Button variant="ghost" onClick={() => { setShowForm(false); setEditingId(null); }}>Cancel</Button>
              <Button onClick={handleSave} disabled={saving} className="gap-2">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                {editingId ? "Update" : "Create"}
              </Button>
            </div>
          </Card>
        )}

        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3].map(i => <div key={i} className="h-14 bg-secondary animate-pulse rounded-xl" />)}
          </div>
        ) : links.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <LinkIcon className="w-12 h-12 mx-auto mb-3 opacity-20" />
            <p className="font-medium">No quick links yet</p>
            <p className="text-xs mt-1">Add links to external sites like dorm booking, insurance portals, etc.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {links.map(link => (
              <div
                key={link.id}
                className={`flex items-center gap-3 p-3 rounded-xl border transition-colors ${
                  link.isActive ? "bg-background border-border" : "bg-muted/50 border-border/50 opacity-60"
                }`}
              >
                <QuickLinkLogo
                  logoUrl={link.logoUrl}
                  title={link.title}
                  icon={link.icon}
                  color={link.color}
                  className="w-10 h-10"
                  onImageError={() => setMissingLogoIds(prev => (prev.has(link.id) ? prev : new Set(prev).add(link.id)))}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="font-semibold text-sm text-foreground">{link.title}</p>
                    {missingLogoIds.has(link.id) && (
                      <span className="inline-flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-500" title={t("settingsPage.logoMissing")}>
                        <AlertTriangle className="w-3 h-3" />
                        {t("settingsPage.logoMissing")}
                      </span>
                    )}
                    {(link.target || "").split(",").map((t: string) => (
                      <Badge key={t} className={`text-[10px] ${TARGET_COLORS[t] || "bg-gray-100 text-gray-600 dark:bg-gray-800/50 dark:text-gray-300"}`}>
                        {TARGET_LABELS[t] || t}
                      </Badge>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground truncate">{link.url}</p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 w-8 p-0 rounded-lg"
                    onClick={() => openEdit(link)}
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 w-8 p-0 rounded-lg"
                    onClick={() => handleToggle(link.id, link.isActive)}
                    title={link.isActive ? "Deactivate" : "Activate"}
                  >
                    <Power className={`w-3.5 h-3.5 ${link.isActive ? "text-emerald-600" : "text-muted-foreground"}`} />
                  </Button>
                  {deleteConfirm === link.id ? (
                    <div className="flex items-center gap-1">
                      <span className="text-[10px] text-destructive font-medium">Delete?</span>
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive hover:bg-destructive/10" onClick={() => handleDelete(link.id)}>
                        <Check className="w-3 h-3" />
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => setDeleteConfirm(null)}>
                        <X className="w-3 h-3" />
                      </Button>
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 w-8 p-0 rounded-lg text-muted-foreground hover:text-destructive"
                      onClick={() => setDeleteConfirm(link.id)}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="border-none shadow-lg shadow-black/5 p-5">
        <div className="flex items-start gap-3">
          <Info className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
          <div className="text-xs text-muted-foreground space-y-1">
            <p className="font-medium text-foreground text-sm">How quick links work</p>
            <p>Quick links appear as shortcut buttons on user dashboards. Each link opens in a new tab.</p>
            <p>Choose a target to control which users see each link: Agent, Sub Agent, Staff, or Student.</p>
            <p>Changes are reflected immediately on user dashboards — no restart needed.</p>
          </div>
        </div>
      </Card>
    </div>
  );
}




type LeadFormWidget = {
  id: number;
  name: string;
  slug: string;
  mode: string;
  theme: Record<string, any>;
  allowedDomains: string[];
  isActive: boolean;
  createdAt: string;
};

function WebToLeadTab() {
  const { t } = useI18n();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { user } = useAuth(true);
  const isAdmin = ADMIN_ROLES.includes(user?.role ?? "");
  const [editing, setEditing] = useState<LeadFormWidget | null>(null);
  const [creating, setCreating] = useState(false);
  const [codeFor, setCodeFor] = useState<LeadFormWidget | null>(null);

  const { data: list, isLoading } = useQuery<{ data: LeadFormWidget[] }>({
    queryKey: ["lead-form-widgets"],
    queryFn: async () => {
      const res: any = await customFetch(`/api/embed/widgets?limit=100`);
      return { data: (res?.data || []).filter((w: any) => w.mode === "lead_form") };
    },
  });

  const widgets = list?.data || [];

  const deleteWidget = async (id: number) => {
    if (!confirm("Bu form silinsin mi?")) return;
    try {
      await customFetch(`/api/embed/widgets/${id}`, { method: "DELETE" });
      toast({ title: "Form silindi" });
      qc.invalidateQueries({ queryKey: ["lead-form-widgets"] });
    } catch {
      toast({ title: "Silinemedi", variant: "destructive" });
    }
  };

  const toggleActive = async (w: LeadFormWidget) => {
    try {
      await customFetch(`/api/embed/widgets/${w.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !w.isActive }),
      } as any);
      qc.invalidateQueries({ queryKey: ["lead-form-widgets"] });
    } catch {
      toast({ title: "Güncellenemedi", variant: "destructive" });
    }
  };

  return (
    <div className="space-y-6">
      <Card className="border shadow-sm p-6">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h3 className="font-display font-semibold text-base mb-1">Web to Lead Formları</h3>
            <p className="text-sm text-muted-foreground">
              Web sitelerinize gömebileceğiniz form widget'ları oluşturun. Her form için ayrı bir kod parçası alır, hangi sayfadan geldiğini ve UTM bilgilerini lead detayında görürsünüz.
            </p>
          </div>
          {isAdmin && (
            <Button onClick={() => setCreating(true)} className="gap-1.5 shrink-0">
              <Plus className="w-4 h-4" /> {t("websiteForms.newForm")}
            </Button>
          )}
        </div>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
        ) : widgets.length === 0 ? (
          <div className="text-center py-12 border-2 border-dashed rounded-xl">
            <Code className="w-10 h-10 mx-auto text-muted-foreground/40 mb-3" />
            <p className="text-sm font-medium mb-1">{t("websiteForms.noFormsYet")}</p>
            <p className="text-xs text-muted-foreground mb-4">{t("websiteForms.noFormsDesc")}</p>
            {isAdmin && (
              <Button size="sm" onClick={() => setCreating(true)} className="gap-1.5">
                <Plus className="w-3.5 h-3.5" /> {t("websiteForms.createForm")}
              </Button>
            )}
          </div>
        ) : (
          <div className="border rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-secondary/50">
                <tr className="text-left">
                  <th className="px-4 py-2.5 font-semibold">{t("common.name")}</th>
                  <th className="px-4 py-2.5 font-semibold">{t("websiteForms.slug")}</th>
                  <th className="px-4 py-2.5 font-semibold">{t("websiteForms.colAllowedDomains")}</th>
                  <th className="px-4 py-2.5 font-semibold">{t("common.status")}</th>
                  <th className="px-4 py-2.5"></th>
                </tr>
              </thead>
              <tbody>
                {widgets.map(w => (
                  <tr key={w.id} className="border-t">
                    <td className="px-4 py-2.5 font-medium">{w.name}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{w.slug}</td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">
                      {w.allowedDomains?.length ? w.allowedDomains.join(", ") : t("websiteForms.allDomains")}
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge variant={w.isActive ? "default" : "secondary"} className="text-[10px]">
                        {w.isActive ? t("common.active") : t("common.inactive")}
                      </Badge>
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center justify-end gap-1">
                        <Button size="sm" variant="ghost" onClick={() => setCodeFor(w)} title={t("websiteForms.copyCode")}>
                          <Code className="w-3.5 h-3.5" />
                        </Button>
                        {isAdmin && (
                          <>
                            <Button size="sm" variant="ghost" onClick={() => setEditing(w)} title={t("common.edit")}>
                              <Pencil className="w-3.5 h-3.5" />
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => toggleActive(w)} title={w.isActive ? t("websiteForms.disable") : t("websiteForms.enable")}>
                              {w.isActive ? <PowerOff className="w-3.5 h-3.5" /> : <Power className="w-3.5 h-3.5" />}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => deleteWidget(w.id)} title={t("common.delete")}>
                              <Trash2 className="w-3.5 h-3.5 text-red-500" />
                            </Button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {isAdmin && (creating || editing) && (
        <LeadFormWidgetDialog
          widget={editing}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={() => { qc.invalidateQueries({ queryKey: ["lead-form-widgets"] }); }}
        />
      )}
      {codeFor && <LeadFormCodeDialog widget={codeFor} onClose={() => setCodeFor(null)} />}
    </div>
  );
}

function slugify(s: string) {
  return s.toLowerCase()
    .replace(/ı/g, "i").replace(/ğ/g, "g").replace(/ş/g, "s").replace(/ç/g, "c").replace(/ö/g, "o").replace(/ü/g, "u")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

function LeadFormWidgetDialog({ widget, onClose, onSaved }: { widget: LeadFormWidget | null; onClose: () => void; onSaved: () => void }) {
  const { toast } = useToast();
  const isEdit = !!widget;
  const [name, setName] = useState(widget?.name || "");
  const [slug, setSlug] = useState(widget?.slug || "");
  const [primaryColor, setPrimaryColor] = useState((widget?.theme?.primaryColor as string) || "#2563eb");
  const [domains, setDomains] = useState((widget?.allowedDomains || []).join(", "));
  const [saving, setSaving] = useState(false);
  const [slugTouched, setSlugTouched] = useState(isEdit);

  const handleSave = async () => {
    if (!name.trim()) { toast({ title: "Form adı gerekli", variant: "destructive" }); return; }
    const finalSlug = (slug || slugify(name)).trim();
    if (!finalSlug) { toast({ title: "Slug gerekli", variant: "destructive" }); return; }
    setSaving(true);
    const allowedDomains = domains.split(",").map(d => d.trim()).filter(Boolean);
    const payload = {
      name: name.trim(),
      slug: finalSlug,
      mode: "lead_form",
      theme: { primaryColor, secondaryColor: primaryColor, buttonColor: primaryColor, borderRadius: "8px" },
      allowedDomains,
      presetFilters: {},
      lockedFilters: [],
      hiddenFilters: [],
      visibleFilters: [],
      isActive: true,
    };
    try {
      if (isEdit) {
        await customFetch(`/api/embed/widgets/${widget!.id}`, { method: "PATCH", body: JSON.stringify(payload) } as any);
        toast({ title: "Form güncellendi" });
      } else {
        await customFetch(`/api/embed/widgets`, { method: "POST", body: JSON.stringify(payload) } as any);
        toast({ title: "Form oluşturuldu" });
      }
      onSaved();
      onClose();
    } catch (e: any) {
      toast({ title: "Kaydedilemedi", description: e?.message || "Slug benzersiz olmalı.", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={true} onOpenChange={() => onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Formu Düzenle" : "Yeni Form"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div>
            <Label className="text-xs font-semibold mb-1.5 block">Form Adı *</Label>
            <Input
              value={name}
              onChange={e => {
                setName(e.target.value);
                if (!slugTouched) setSlug(slugify(e.target.value));
              }}
              placeholder="Örn: Anasayfa İletişim Formu"
            />
          </div>
          <div>
            <Label className="text-xs font-semibold mb-1.5 block">Slug *</Label>
            <Input
              value={slug}
              onChange={e => { setSlug(e.target.value); setSlugTouched(true); }}
              placeholder="anasayfa-iletisim"
              className="font-mono text-xs"
              disabled={isEdit}
            />
            <p className="text-[11px] text-muted-foreground mt-1">Lead'in source alanı: <code>embed:{slug || "slug"}</code></p>
          </div>
          <div>
            <Label className="text-xs font-semibold mb-1.5 block">Ana Renk</Label>
            <div className="flex gap-2 items-center">
              <input type="color" value={primaryColor} onChange={e => setPrimaryColor(e.target.value)} className="w-10 h-10 rounded cursor-pointer border" />
              <Input value={primaryColor} onChange={e => setPrimaryColor(e.target.value)} className="flex-1 font-mono text-xs" />
            </div>
          </div>
          <div>
            <Label className="text-xs font-semibold mb-1.5 block">İzinli Domainler</Label>
            <Input
              value={domains}
              onChange={e => setDomains(e.target.value)}
              placeholder="örn: example.com, masterstudyinturkey.com"
            />
            <p className="text-[11px] text-muted-foreground mt-1">Virgülle ayırın. Boş bırakırsanız her domainden çalışır.</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>İptal</Button>
          <Button onClick={handleSave} disabled={saving}>{saving ? "Kaydediliyor..." : (isEdit ? "Güncelle" : "Oluştur")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LeadFormCodeDialog({ widget, onClose }: { widget: LeadFormWidget; onClose: () => void }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const apiBase = `${window.location.origin}/api`;
  const scriptCode = `<!-- ${widget.name} -->\n<div data-edcons-widget="${widget.slug}"></div>\n<script src="${apiBase}/public/embed/embed.js"></script>`;
  const iframeCode = `<iframe
  src="${apiBase}/public/embed/${widget.slug}/widget"
  style="width:100%;min-height:520px;border:none;"
  loading="lazy"></iframe>`;

  const copy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    toast({ title: "Kod kopyalandı" });
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Dialog open={true} onOpenChange={() => onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Embed Kodu: {widget.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <Label className="text-xs font-semibold">JavaScript Embed (önerilen — otomatik boyutlanır)</Label>
              <Button size="sm" variant="secondary" onClick={() => copy(scriptCode)} className="gap-1.5 text-xs h-7">
                {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />} Kopyala
              </Button>
            </div>
            <pre className="bg-secondary/50 border rounded-xl p-3 text-xs whitespace-pre-wrap break-all font-mono">{scriptCode}</pre>
          </div>
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <Label className="text-xs font-semibold">Iframe (alternatif)</Label>
              <Button size="sm" variant="secondary" onClick={() => copy(iframeCode)} className="gap-1.5 text-xs h-7">
                <Copy className="w-3 h-3" /> Kopyala
              </Button>
            </div>
            <pre className="bg-secondary/50 border rounded-xl p-3 text-xs whitespace-pre-wrap break-all font-mono">{iframeCode}</pre>
          </div>
          <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 text-xs text-blue-900">
            <p className="font-semibold mb-1">Nasıl çalışır?</p>
            <ul className="list-disc list-inside space-y-0.5 text-blue-800">
              <li>Bu kodu sitenizin herhangi bir sayfasına yapıştırın (WordPress için Custom HTML bloğu).</li>
              <li>Form gönderildiğinde lead otomatik olarak CRM'e düşer ve <code className="bg-white/60 px-1 rounded">embed:{widget.slug}</code> kaynağıyla işaretlenir.</li>
              <li>Sayfa URL'si ve UTM parametreleri (utm_source, utm_medium, utm_campaign, ...) lead detayında görünür.</li>
            </ul>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Kapat</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _DeprecatedWebToLeadTab() {
  const { t } = useI18n();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [copied, setCopied] = useState(false);
  const [formTitle, setFormTitle] = useState("Get in Touch");
  const crossLink = (
    <Card className="p-4 bg-blue-50 border-blue-200 mb-6">
      <div className="flex items-start gap-3">
        <Info className="w-5 h-5 text-blue-600 mt-0.5 shrink-0" />
        <p className="text-sm text-blue-800">Full form management is available in <button type="button" onClick={() => setLocation("/admin/website/forms")} className="font-semibold underline cursor-pointer">Website &gt; Forms</button>. This page provides a quick embed snippet for external sites.</p>
      </div>
    </Card>
  );
  const [formSubtitle, setFormSubtitle] = useState("Fill in your details and we'll contact you shortly.");
  const [btnText, setBtnText] = useState("Submit");
  const [btnColor, setBtnColor] = useState("#2563eb");
  const [bgColor, setBgColor] = useState("#ffffff");
  const [borderColor, setBorderColor] = useState("#e5e7eb");
  const [footerText, setFooterText] = useState("Your information is secure and will not be shared.");

  const apiDomain = window.location.origin;
  const btnColorDark = btnColor + "cc";

  const formCode = `<form action="${apiDomain}/api/public/lead" method="POST" style="max-width:440px;margin:0 auto;font-family:system-ui,-apple-system,sans-serif;padding:32px;border-radius:16px;background:${bgColor};box-shadow:0 4px 24px rgba(0,0,0,0.08);border:1px solid ${borderColor}" onsubmit="var ins=this.querySelectorAll('input[type=text]');for(var i=0;i<ins.length;i++){ins[i].value=ins[i].value.toUpperCase();}">
  <h3 style="margin:0 0 4px;font-size:20px;font-weight:700;color:#111827;text-align:center">${formTitle}</h3>
  <p style="margin:0 0 20px;font-size:13px;color:#6b7280;text-align:center">${formSubtitle}</p>
  <div style="display:flex;gap:10px;margin-bottom:14px">
    <div style="flex:1">
      <label style="display:block;font-size:12px;font-weight:600;color:#374151;margin-bottom:4px">First Name <span style="color:#ef4444">*</span></label>
      <input name="firstName" type="text" required pattern="[A-Za-z\\u00C0-\\u017F\\s'-]+" title="Latin characters only" style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;box-sizing:border-box;outline:none;text-transform:uppercase;transition:border-color 0.2s" onfocus="this.style.borderColor='${btnColor}'" onblur="this.style.borderColor='#d1d5db'" />
    </div>
    <div style="flex:1">
      <label style="display:block;font-size:12px;font-weight:600;color:#374151;margin-bottom:4px">Last Name <span style="color:#ef4444">*</span></label>
      <input name="lastName" type="text" required pattern="[A-Za-z\\u00C0-\\u017F\\s'-]+" title="Latin characters only" style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;box-sizing:border-box;outline:none;text-transform:uppercase;transition:border-color 0.2s" onfocus="this.style.borderColor='${btnColor}'" onblur="this.style.borderColor='#d1d5db'" />
    </div>
  </div>
  <div style="margin-bottom:14px">
    <label style="display:block;font-size:12px;font-weight:600;color:#374151;margin-bottom:4px">Phone <span style="color:#ef4444">*</span></label>
    <div style="display:flex;gap:6px">
      <select name="phoneCode" style="width:90px;padding:10px 6px;border:1px solid #d1d5db;border-radius:8px;font-size:13px;background:#fff;outline:none;cursor:pointer">
        <option value="+90">🇹🇷 +90</option><option value="+1">🇺🇸 +1</option><option value="+44">🇬🇧 +44</option><option value="+49">🇩🇪 +49</option><option value="+33">🇫🇷 +33</option><option value="+39">🇮🇹 +39</option><option value="+34">🇪🇸 +34</option><option value="+31">🇳🇱 +31</option><option value="+46">🇸🇪 +46</option><option value="+41">🇨🇭 +41</option><option value="+7">🇷🇺 +7</option><option value="+380">🇺🇦 +380</option><option value="+86">🇨🇳 +86</option><option value="+91">🇮🇳 +91</option><option value="+92">🇵🇰 +92</option><option value="+93">🇦🇫 +93</option><option value="+966">🇸🇦 +966</option><option value="+971">🇦🇪 +971</option><option value="+964">🇮🇶 +964</option><option value="+98">🇮🇷 +98</option><option value="+962">🇯🇴 +962</option><option value="+961">🇱🇧 +961</option><option value="+20">🇪🇬 +20</option><option value="+212">🇲🇦 +212</option><option value="+234">🇳🇬 +234</option><option value="+55">🇧🇷 +55</option><option value="+61">🇦🇺 +61</option><option value="+81">🇯🇵 +81</option><option value="+82">🇰🇷 +82</option><option value="+60">🇲🇾 +60</option><option value="+65">🇸🇬 +65</option><option value="+880">🇧🇩 +880</option>
      </select>
      <input name="phoneNumber" type="tel" required placeholder="555 000 0000" style="flex:1;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;box-sizing:border-box;outline:none;transition:border-color 0.2s" onfocus="this.style.borderColor='${btnColor}'" onblur="this.style.borderColor='#d1d5db'" />
      <input type="hidden" name="phone" />
    </div>
  </div>
  <div style="margin-bottom:20px">
    <label style="display:block;font-size:12px;font-weight:600;color:#374151;margin-bottom:4px">Email <span style="color:#ef4444">*</span></label>
    <input name="email" type="email" required placeholder="you@example.com" style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;box-sizing:border-box;outline:none;transition:border-color 0.2s" onfocus="this.style.borderColor='${btnColor}'" onblur="this.style.borderColor='#d1d5db'" />
  </div>
  <button type="submit" style="width:100%;padding:12px;background:linear-gradient(135deg,${btnColor},${btnColorDark});color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;transition:opacity 0.2s" onmouseover="this.style.opacity='0.9'" onmouseout="this.style.opacity='1'" onclick="var f=this.closest('form');f.phone.value=f.phoneCode.value+f.phoneNumber.value;">${btnText}</button>
  <p style="margin:12px 0 0;font-size:11px;color:#9ca3af;text-align:center">${footerText}</p>
</form>`;

  const handleCopy = () => {
    navigator.clipboard.writeText(formCode);
    setCopied(true);
    toast({ title: "Copied!", description: "Form code copied to clipboard." });
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-6">
      {crossLink}
      <Card className="border shadow-sm p-6">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center">
            <Code className="w-4 h-4 text-blue-600" />
          </div>
          <h3 className="font-display font-semibold text-base">{t("settingsPage.webToLeadForm")}</h3>
        </div>
        <p className="text-sm text-muted-foreground mb-5">
          Customize the lead capture form for your company website. The generated HTML code can be copied and pasted into any website.
        </p>

        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <Label className="text-xs font-semibold mb-1.5 block">{t("settingsPage.formTitle")}</Label>
            <Input value={formTitle} onChange={e => { setFormTitle(e.target.value); setCopied(false); }} className="rounded-xl" />
          </div>
          <div>
            <Label className="text-xs font-semibold mb-1.5 block">{t("settingsPage.subtitle")}</Label>
            <Input value={formSubtitle} onChange={e => { setFormSubtitle(e.target.value); setCopied(false); }} className="rounded-xl" />
          </div>
          <div>
            <Label className="text-xs font-semibold mb-1.5 block">{t("settingsPage.buttonText")}</Label>
            <Input value={btnText} onChange={e => { setBtnText(e.target.value); setCopied(false); }} className="rounded-xl" />
          </div>
          <div>
            <Label className="text-xs font-semibold mb-1.5 block">{t("settingsPage.footerText")}</Label>
            <Input value={footerText} onChange={e => { setFooterText(e.target.value); setCopied(false); }} className="rounded-xl" />
          </div>
          <div>
            <Label className="text-xs font-semibold mb-1.5 block">{t("settingsPage.buttonColor")}</Label>
            <div className="flex items-center gap-2">
              <input type="color" value={btnColor} onChange={e => { setBtnColor(e.target.value); setCopied(false); }} className="w-9 h-9 rounded-lg border cursor-pointer" />
              <Input value={btnColor} onChange={e => { setBtnColor(e.target.value); setCopied(false); }} className="rounded-xl font-mono text-xs flex-1" />
            </div>
          </div>
          <div>
            <Label className="text-xs font-semibold mb-1.5 block">{t("settingsPage.backgroundColor")}</Label>
            <div className="flex items-center gap-2">
              <input type="color" value={bgColor} onChange={e => { setBgColor(e.target.value); setCopied(false); }} className="w-9 h-9 rounded-lg border cursor-pointer" />
              <Input value={bgColor} onChange={e => { setBgColor(e.target.value); setCopied(false); }} className="rounded-xl font-mono text-xs flex-1" />
            </div>
          </div>
          <div>
            <Label className="text-xs font-semibold mb-1.5 block">{t("settingsPage.borderColor")}</Label>
            <div className="flex items-center gap-2">
              <input type="color" value={borderColor} onChange={e => { setBorderColor(e.target.value); setCopied(false); }} className="w-9 h-9 rounded-lg border cursor-pointer" />
              <Input value={borderColor} onChange={e => { setBorderColor(e.target.value); setCopied(false); }} className="rounded-xl font-mono text-xs flex-1" />
            </div>
          </div>
        </div>
      </Card>

      <Card className="border shadow-sm p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-8 h-8 rounded-lg bg-green-500/10 flex items-center justify-center">
            <Eye className="w-4 h-4 text-green-600" />
          </div>
          <h3 className="font-display font-semibold text-base">{t("settingsPage.formPreview")}</h3>
        </div>
        <div className="bg-secondary/30 rounded-xl p-4">
          <iframe
            title={t("settingsPage.formPreview")}
            srcDoc={formCode}
            sandbox=""
            referrerPolicy="no-referrer"
            className="w-full min-h-[640px] rounded-xl border bg-white"
          />
        </div>
      </Card>

      <Card className="border shadow-sm p-6">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center">
            <Code className="w-4 h-4 text-blue-600" />
          </div>
          <h3 className="font-display font-semibold text-base">{t("settingsPage.generatedCode")}</h3>
        </div>
        <div className="relative">
          <div className="absolute top-3 right-3 z-10">
            <Button size="sm" variant="secondary" onClick={handleCopy} className="gap-1.5 text-xs shadow-sm">
              {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? "Copied" : "Copy Code"}
            </Button>
          </div>
          <pre className="bg-secondary/50 border rounded-xl p-4 pr-28 text-xs text-foreground/80 overflow-x-auto whitespace-pre-wrap break-all max-h-72 overflow-y-auto font-mono leading-relaxed">
            {formCode}
          </pre>
        </div>
      </Card>

      <Card className="border shadow-sm p-6">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center">
            <ExternalLink className="w-4 h-4 text-amber-600" />
          </div>
          <h3 className="font-display font-semibold text-base">{t("settingsPage.howToUse")}</h3>
        </div>
        <ol className="text-sm text-muted-foreground space-y-2 list-decimal list-inside">
          <li>{t("settingsPage.htuStep1")}</li>
          <li>{t("settingsPage.htuStep2")}</li>
          <li>{t("settingsPage.htuStep3")}</li>
          <li>{t("settingsPage.htuStep4")}</li>
          <li>{t("settingsPage.htuStep5")}</li>
          <li>{t("settingsPage.htuStep6")}</li>
        </ol>
      </Card>
    </div>
  );
}

function OfferExpiryThresholdsCard() {
  const { t } = useI18n();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: settings } = useQuery<any>({
    queryKey: ["/api/settings"],
    queryFn: () => customFetch("/api/settings"),
  });

  const initial = (settings?.offerExpiryWarningDays as string) || "30,14,7,1";
  const [value, setValue] = useState<string>(initial);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (settings?.offerExpiryWarningDays !== undefined) {
      setValue(settings.offerExpiryWarningDays || "30,14,7,1");
    }
  }, [settings?.offerExpiryWarningDays]);

  async function handleSave() {
    const parts = value.split(",").map(s => s.trim()).filter(Boolean);
    const nums = parts.map(p => parseInt(p, 10));
    if (nums.some(n => isNaN(n) || n <= 0)) {
      toast({ title: t("settingsPage.invalidValue"), description: t("settingsPage.invalidThresholdsDesc"), variant: "destructive" });
      return;
    }
    const normalized = Array.from(new Set(nums)).sort((a, b) => b - a).join(",");
    setSaving(true);
    try {
      await customFetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offerExpiryWarningDays: normalized }),
      });
      qc.invalidateQueries({ queryKey: ["/api/settings"] });
      toast({ title: t("settingsPage.thresholdsSaved"), description: t("settingsPage.activeColon", { value: normalized }) });
    } catch (err: any) {
      toast({ title: t("settingsPage.saveFailed"), description: err?.message, variant: "destructive" });
    }
    setSaving(false);
  }

  return (
    <Card className="border shadow-sm p-6">
      <div className="mb-4">
        <h3 className="font-display font-semibold text-base">{t("settingsPage.offerExpiryTitle")}</h3>
        <p className="text-sm text-muted-foreground mt-1">
          {t("settingsPage.offerExpiryDesc")} <code className="text-xs px-1 py-0.5 rounded bg-secondary">30,14,7,1</code>).
        </p>
      </div>
      <div className="flex items-end gap-3">
        <div className="flex-1">
          <Label htmlFor="offerExpiryWarningDays" className="text-xs">{t("settingsPage.thresholdsLabel")}</Label>
          <Input
            id="offerExpiryWarningDays"
            value={value}
            onChange={e => setValue(e.target.value)}
            placeholder="30,14,7,1"
            className="mt-1"
          />
        </div>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? t("settingsPage.saving") : t("settingsPage.save")}
        </Button>
      </div>
    </Card>
  );
}

function SigningDeadlineDaysCard() {
  const { t } = useI18n();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: settings } = useQuery<any>({
    queryKey: ["/api/settings"],
    queryFn: () => customFetch("/api/settings"),
  });
  const initial = settings?.defaultSigningDeadlineDays ?? 14;
  const [value, setValue] = useState<string>(String(initial));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (settings?.defaultSigningDeadlineDays !== undefined) {
      setValue(String(settings.defaultSigningDeadlineDays));
    }
  }, [settings?.defaultSigningDeadlineDays]);

  async function handleSave() {
    const n = parseInt(value, 10);
    if (!Number.isInteger(n) || n < 1 || n > 365) {
      toast({ title: t("settingsPage.invalidValue"), description: t("settingsPage.invalidDaysDesc"), variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      await customFetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultSigningDeadlineDays: n }),
      });
      qc.invalidateQueries({ queryKey: ["/api/settings"] });
      toast({ title: t("settingsPage.deadlineSaved"), description: t("settingsPage.newDefaultDays", { n }) });
    } catch (err: any) {
      toast({ title: t("settingsPage.saveFailed"), description: err?.message, variant: "destructive" });
    }
    setSaving(false);
  }

  return (
    <Card className="border shadow-sm p-6">
      <div className="mb-4">
        <h3 className="font-display font-semibold text-base">{t("settingsPage.signingDeadlineTitle")}</h3>
        <p className="text-sm text-muted-foreground mt-1">
          {t("settingsPage.signingDeadlineDesc")}
        </p>
      </div>
      <div className="flex items-end gap-3">
        <div className="flex-1 max-w-[200px]">
          <Label htmlFor="defaultSigningDeadlineDays" className="text-xs">{t("settingsPage.daysLabel")}</Label>
          <Input
            id="defaultSigningDeadlineDays"
            type="number"
            min={1}
            max={365}
            value={value}
            onChange={e => setValue(e.target.value)}
            className="mt-1"
          />
        </div>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? t("settingsPage.saving") : t("settingsPage.save")}
        </Button>
      </div>
    </Card>
  );
}

function SuppressAutomationNotificationsCard() {
  const { t } = useI18n();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: settings } = useQuery<any>({
    queryKey: ["/api/settings"],
    queryFn: () => customFetch("/api/settings"),
  });
  const [value, setValue] = useState<boolean>(true);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (settings !== undefined) {
      setValue(settings?.suppressAutomationAppNotifications !== false);
      setLoaded(true);
    }
  }, [settings?.suppressAutomationAppNotifications, settings]);

  async function handleToggle(next: boolean) {
    setValue(next);
    setSaving(true);
    try {
      await customFetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suppressAutomationAppNotifications: next }),
      });
      qc.invalidateQueries({ queryKey: ["/api/settings"] });
      toast({ title: t("settingsPage.suppressAutomationNotifSaved") });
    } catch (err: any) {
      setValue(!next);
      toast({ title: t("settingsPage.saveFailed"), description: err?.message, variant: "destructive" });
    } finally { setSaving(false); }
  }

  return (
    <Card className="border shadow-sm p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-display font-semibold text-base">{t("settingsPage.suppressAutomationNotifTitle")}</h3>
          <p className="text-sm text-muted-foreground mt-1">{t("settingsPage.suppressAutomationNotifDesc")}</p>
        </div>
        <Switch
          checked={value}
          onCheckedChange={handleToggle}
          disabled={!loaded || saving}
        />
      </div>
    </Card>
  );
}

function AutoAssignStuckConversationsCard() {
  const { t } = useI18n();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: settings } = useQuery<any>({
    queryKey: ["/api/settings"],
    queryFn: () => customFetch("/api/settings"),
  });
  const [value, setValue] = useState<boolean>(false);
  const [considerWorkingHours, setConsiderWorkingHours] = useState<boolean>(true);
  const [considerCountryMatch, setConsiderCountryMatch] = useState<boolean>(true);
  const [offHoursBehavior, setOffHoursBehavior] = useState<string>("assign_anyway");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (settings !== undefined) {
      setValue(settings?.autoAssignStuckConversationsEnabled === true);
      setConsiderWorkingHours(settings?.stuckAssignConsiderWorkingHours !== false);
      setConsiderCountryMatch(settings?.stuckAssignConsiderCountryMatch !== false);
      setOffHoursBehavior(settings?.stuckAssignOffHoursBehavior || "assign_anyway");
      setLoaded(true);
    }
  }, [
    settings?.autoAssignStuckConversationsEnabled,
    settings?.stuckAssignConsiderWorkingHours,
    settings?.stuckAssignConsiderCountryMatch,
    settings?.stuckAssignOffHoursBehavior,
    settings,
  ]);

  async function patchField(field: string, patchValue: unknown, revert: () => void) {
    setSaving(true);
    try {
      await customFetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: patchValue }),
      });
      qc.invalidateQueries({ queryKey: ["/api/settings"] });
      toast({ title: t("settingsPage.autoAssignStuckConvSaved") });
    } catch (err: any) {
      revert();
      toast({ title: t("settingsPage.saveFailed"), description: err?.message, variant: "destructive" });
    } finally { setSaving(false); }
  }

  function handleToggle(next: boolean) {
    setValue(next);
    patchField("autoAssignStuckConversationsEnabled", next, () => setValue(!next));
  }

  function handleWorkingHoursToggle(next: boolean) {
    setConsiderWorkingHours(next);
    patchField("stuckAssignConsiderWorkingHours", next, () => setConsiderWorkingHours(!next));
  }

  function handleCountryMatchToggle(next: boolean) {
    setConsiderCountryMatch(next);
    patchField("stuckAssignConsiderCountryMatch", next, () => setConsiderCountryMatch(!next));
  }

  function handleOffHoursBehaviorChange(next: string) {
    const prev = offHoursBehavior;
    setOffHoursBehavior(next);
    patchField("stuckAssignOffHoursBehavior", next, () => setOffHoursBehavior(prev));
  }

  return (
    <Card className="border shadow-sm p-6 space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-display font-semibold text-base">{t("settingsPage.autoAssignStuckConvTitle")}</h3>
          <p className="text-sm text-muted-foreground mt-1">{t("settingsPage.autoAssignStuckConvDesc")}</p>
        </div>
        <Switch
          checked={value}
          onCheckedChange={handleToggle}
          disabled={!loaded || saving}
        />
      </div>

      {value && (
        <div className="pl-1 space-y-4 border-t pt-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">{t("settingsPage.stuckAssignConsiderWorkingHoursTitle")}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{t("settingsPage.stuckAssignConsiderWorkingHoursDesc")}</p>
            </div>
            <Switch
              checked={considerWorkingHours}
              onCheckedChange={handleWorkingHoursToggle}
              disabled={!loaded || saving}
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">{t("settingsPage.stuckAssignConsiderCountryMatchTitle")}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{t("settingsPage.stuckAssignConsiderCountryMatchDesc")}</p>
            </div>
            <Switch
              checked={considerCountryMatch}
              onCheckedChange={handleCountryMatchToggle}
              disabled={!loaded || saving}
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">{t("settingsPage.stuckAssignOffHoursBehaviorTitle")}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{t("settingsPage.stuckAssignOffHoursBehaviorDesc")}</p>
            </div>
            <Select
              value={offHoursBehavior}
              onValueChange={handleOffHoursBehaviorChange}
              disabled={!loaded || saving || !considerWorkingHours}
            >
              <SelectTrigger className="w-[220px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="assign_anyway">{t("settingsPage.stuckAssignOffHoursAssignAnyway")}</SelectItem>
                <SelectItem value="leave_unassigned">{t("settingsPage.stuckAssignOffHoursLeaveUnassigned")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      )}
    </Card>
  );
}

function ContractExpiryThresholdsCard() {
  const { t } = useI18n();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: settings } = useQuery<any>({
    queryKey: ["/api/settings"],
    queryFn: () => customFetch("/api/settings"),
  });

  const initial = (settings?.contractExpiryReminderDays as string) || "30,14,7,1";
  const [value, setValue] = useState<string>(initial);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (settings?.contractExpiryReminderDays !== undefined) {
      setValue(settings.contractExpiryReminderDays || "30,14,7,1");
    }
  }, [settings?.contractExpiryReminderDays]);

  async function handleSave() {
    const parts = value.split(",").map(s => s.trim()).filter(Boolean);
    const nums = parts.map(p => parseInt(p, 10));
    if (nums.some(n => isNaN(n) || n <= 0)) {
      toast({ title: t("settingsPage.invalidValue"), description: t("settingsPage.invalidThresholdsDesc"), variant: "destructive" });
      return;
    }
    const normalized = Array.from(new Set(nums)).sort((a, b) => b - a).join(",");
    setSaving(true);
    try {
      await customFetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contractExpiryReminderDays: normalized }),
      });
      qc.invalidateQueries({ queryKey: ["/api/settings"] });
      toast({ title: t("settingsPage.thresholdsSaved"), description: t("settingsPage.activeColon", { value: normalized }) });
    } catch (err: any) {
      toast({ title: t("settingsPage.saveFailed"), description: err?.message, variant: "destructive" });
    }
    setSaving(false);
  }

  return (
    <Card className="border shadow-sm p-6">
      <div className="mb-4">
        <h3 className="font-display font-semibold text-base">{t("settingsPage.contractExpiryTitle")}</h3>
        <p className="text-sm text-muted-foreground mt-1">
          {t("settingsPage.contractExpiryDesc")} <code className="text-xs px-1 py-0.5 rounded bg-secondary">30,14,7,1</code>).
        </p>
      </div>
      <div className="flex items-end gap-3">
        <div className="flex-1">
          <Label htmlFor="contractExpiryReminderDays" className="text-xs">{t("settingsPage.thresholdsLabel")}</Label>
          <Input
            id="contractExpiryReminderDays"
            value={value}
            onChange={e => setValue(e.target.value)}
            placeholder="30,14,7,1"
            className="mt-1"
          />
        </div>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? t("settingsPage.saving") : t("settingsPage.save")}
        </Button>
      </div>
    </Card>
  );
}

interface AssignmentRule {
  id: number;
  name: string;
  priority: number;
  isActive: boolean;
  countries: string[];
  universityIds: number[];
  cities: string[];
  phoneCodes: string[];
  sources: string[];
  staffUserIds: number[];
  strategy: "first" | "round_robin";
  lastAssignedIndex: number;
}

interface StaffOption { id: number; firstName: string | null; lastName: string | null; email: string; role: string; }

const STAFF_FILTER_ROLES = ["super_admin", "admin", "manager", "staff", "consultant"];

interface CountryOption { id: number; name: string; code: string; }
interface CityOption { id: number; name: string; }
interface UniversityOption { id: number; name: string; country?: string | null; }

const regionDisplayNames = typeof Intl !== "undefined" && (Intl as any).DisplayNames
  ? new (Intl as any).DisplayNames(["en"], { type: "region" })
  : null;

function isoToCountryName(iso: string): string {
  try { return regionDisplayNames?.of(iso) || iso; } catch { return iso; }
}

const PHONE_CODE_OPTIONS = (() => {
  const byCode = new Map<string, string[]>();
  for (const p of PHONE_CODES_LIB) {
    const arr = byCode.get(p.code) || [];
    arr.push(isoToCountryName(p.country));
    byCode.set(p.code, arr);
  }
  return [...byCode.entries()]
    .map(([code, names]) => ({ value: code, label: `${code} (${names.sort().join(", ")})` }))
    .sort((a, b) => a.label.localeCompare(b.label));
})();

function LeadAssignmentRulesTab() {
  const { toast } = useToast();
  const { t } = useI18n();
  const [rules, setRules] = useState<AssignmentRule[]>([]);
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [countries, setCountries] = useState<CountryOption[]>([]);
  const [cities, setCities] = useState<string[]>([]);
  const [sources, setSources] = useState<{ value: string; label: string; kind: "connected_account" | "lead_form" | "embed" | "other" }[]>([]);
  const [universities, setUniversities] = useState<UniversityOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<number | null>(null);

  const emptyForm = {
    name: "",
    priority: 0,
    isActive: true,
    countries: [] as string[],
    cities: [] as string[],
    phoneCodes: [] as string[],
    sources: [] as string[],
    universityIds: [] as number[],
    staffUserIds: [] as number[],
    strategy: "first" as "first" | "round_robin",
  };
  const [form, setForm] = useState(emptyForm);

  const fetchAll = useCallback(async () => {
    async function fetchAllPages<T>(url: string, pageLimit = 100): Promise<T[]> {
      const out: T[] = [];
      let page = 1;
      while (true) {
        const sep = url.includes("?") ? "&" : "?";
        const res = await customFetch(`${url}${sep}page=${page}&limit=${pageLimit}`) as { data: T[]; meta?: { totalPages?: number; total?: number } };
        const batch = res.data || [];
        out.push(...batch);
        const totalPages = res.meta?.totalPages ?? (res.meta?.total ? Math.ceil(res.meta.total / pageLimit) : 1);
        if (page >= totalPages || batch.length === 0 || page >= 50) break;
        page += 1;
      }
      return out;
    }
    try {
      const [rulesRes, staffAll, countriesAll, citiesAll, sourcesRes, unisAll] = await Promise.all([
        customFetch("/api/settings/lead-assignment-rules") as Promise<{ data: AssignmentRule[] }>,
        fetchAllPages<StaffOption>("/api/users", 100),
        fetchAllPages<CountryOption>("/api/countries", 500),
        fetchAllPages<{ id: number; name: string; countryId?: number }>("/api/cities", 1000),
        customFetch("/api/leads/distinct-sources") as Promise<{ data: { value: string; label: string; kind: "connected_account" | "lead_form" | "embed" | "other" }[] }>,
        fetchAllPages<UniversityOption>("/api/universities", 100),
      ]);
      setRules(rulesRes.data || []);
      setStaff(staffAll.filter(u => STAFF_FILTER_ROLES.includes(u.role)));
      setCountries(countriesAll);
      const cityNames = Array.from(new Set(citiesAll.map(c => c.name).filter((n): n is string => Boolean(n)))).sort((a, b) => a.localeCompare(b));
      setCities(cityNames);
      setSources(sourcesRes.data || []);
      setUniversities(unisAll);
    } catch (err: any) {
      toast({ title: t("leadAssignment.loadFailed"), description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  function staffLabel(id: number) {
    const u = staff.find(s => s.id === id);
    if (!u) return `#${id}`;
    return `${u.firstName || ""} ${u.lastName || ""}`.trim() || u.email;
  }

  function uniLabel(id: number) {
    const u = universities.find(x => x.id === id);
    return u ? `${u.name}${u.country ? ` (${u.country})` : ""}` : `#${id}`;
  }

  function phoneCodeLabel(code: string) {
    const o = PHONE_CODE_OPTIONS.find(x => x.value === code);
    return o ? o.label : code;
  }

  function sourceLabel(value: string) {
    return sources.find(source => source.value === value)?.label || value;
  }

  function openNew() {
    setEditingId(null);
    setForm({ ...emptyForm, priority: rules.length });
    setShowForm(true);
  }

  function openEdit(rule: AssignmentRule) {
    setEditingId(rule.id);
    setForm({
      name: rule.name,
      priority: rule.priority,
      isActive: rule.isActive,
      countries: rule.countries || [],
      cities: rule.cities || [],
      phoneCodes: rule.phoneCodes || [],
      sources: rule.sources || [],
      universityIds: rule.universityIds || [],
      staffUserIds: rule.staffUserIds || [],
      strategy: rule.strategy || "first",
    });
    setShowForm(true);
  }

  async function handleSave() {
    if (!form.name.trim()) {
      toast({ title: t("leadAssignment.nameRequired"), variant: "destructive" });
      return;
    }
    if (form.staffUserIds.length === 0) {
      toast({ title: t("leadAssignment.staffRequired"), variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const body = {
        name: form.name.trim(),
        priority: form.priority,
        isActive: form.isActive,
        countries: form.countries,
        cities: form.cities,
        phoneCodes: form.phoneCodes,
        sources: form.sources,
        universityIds: form.universityIds,
        staffUserIds: form.staffUserIds,
        strategy: form.strategy,
      };
      const url = editingId
        ? `/api/settings/lead-assignment-rules/${editingId}`
        : `/api/settings/lead-assignment-rules`;
      const method = editingId ? "PATCH" : "POST";
      await customFetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      toast({ title: editingId ? t("leadAssignment.ruleUpdated") : t("leadAssignment.ruleCreated") });
      setShowForm(false);
      setEditingId(null);
      setForm(emptyForm);
      fetchAll();
    } catch (err: any) {
      toast({ title: t("leadAssignment.saveFailed"), description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function handleToggle(rule: AssignmentRule) {
    try {
      await customFetch(`/api/settings/lead-assignment-rules/${rule.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !rule.isActive }),
      });
      fetchAll();
    } catch (err: any) {
      toast({ title: t("leadAssignment.error"), description: err.message, variant: "destructive" });
    }
  }

  async function handleDelete(id: number) {
    try {
      await customFetch(`/api/settings/lead-assignment-rules/${id}`, { method: "DELETE" });
      toast({ title: t("leadAssignment.ruleDeleted") });
      fetchAll();
    } catch (err: any) {
      toast({ title: t("leadAssignment.deleteFailed"), description: err.message, variant: "destructive" });
    } finally {
      setDeleteConfirm(null);
    }
  }

  return (
    <div className="space-y-6">
      <Card className="border-none shadow-lg shadow-black/5 p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h3 className="font-display font-bold text-lg">{t("leadAssignment.title")}</h3>
            <p className="text-sm text-muted-foreground mt-1">{t("leadAssignment.description")}</p>
          </div>
          <Button onClick={openNew} className="gap-2">
            <Plus className="w-4 h-4" /> {t("leadAssignment.newRule")}
          </Button>
        </div>

        {showForm && (
          <Card className="p-5 mb-6 border-2 border-primary/20 bg-primary/[0.02] space-y-4">
            <h4 className="font-semibold text-sm">{editingId ? t("leadAssignment.editTitle") : t("leadAssignment.newTitle")}</h4>
            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <Label className="text-xs font-medium mb-1.5">{t("leadAssignment.nameLabel")}</Label>
                <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder={t("leadAssignment.namePlaceholder")} />
              </div>
              <div>
                <Label className="text-xs font-medium mb-1.5">{t("leadAssignment.priorityLabel")}</Label>
                <Input type="number" value={form.priority} onChange={e => setForm(f => ({ ...f, priority: parseInt(e.target.value, 10) || 0 }))} />
              </div>
              <div>
                <Label className="text-xs font-medium mb-1.5">{t("leadAssignment.countriesLabel")}</Label>
                <MultiSelectFilter
                  values={form.countries}
                  onChange={v => setForm(f => ({ ...f, countries: v }))}
                  options={countries.map(c => ({ value: c.name, label: c.name }))}
                  placeholder={t("leadAssignment.allCountries")}
                />
              </div>
              <div>
                <Label className="text-xs font-medium mb-1.5">{t("leadAssignment.sourcesLabel")}</Label>
                <MultiSelectFilter
                  values={form.sources}
                  onChange={v => setForm(f => ({ ...f, sources: v }))}
                  options={sources.map(s => ({ value: s.value, label: s.label }))}
                  placeholder={sources.length === 0 ? t("leadAssignment.noSources") : t("leadAssignment.allSources")}
                />
              </div>
              <div>
                <Label className="text-xs font-medium mb-1.5">{t("leadAssignment.citiesLabel")}</Label>
                <MultiSelectFilter
                  values={form.cities}
                  onChange={v => setForm(f => ({ ...f, cities: v }))}
                  options={cities.map(c => ({ value: c, label: c }))}
                  placeholder={cities.length === 0 ? t("leadAssignment.noCities") : t("leadAssignment.allCities")}
                />
              </div>
              <div>
                <Label className="text-xs font-medium mb-1.5">{t("leadAssignment.universitiesLabel")}</Label>
                <MultiSelectFilter
                  values={form.universityIds.map(String)}
                  onChange={v => setForm(f => ({ ...f, universityIds: v.map(x => parseInt(x, 10)).filter(n => !isNaN(n)) }))}
                  options={universities.map(u => ({ value: String(u.id), label: u.country ? `${u.name} (${u.country})` : u.name }))}
                  placeholder={t("leadAssignment.allUniversities")}
                />
              </div>
              <div className="sm:col-span-2">
                <Label className="text-xs font-medium mb-1.5">{t("leadAssignment.phoneCodesLabel")}</Label>
                <MultiSelectFilter
                  values={form.phoneCodes}
                  onChange={v => setForm(f => ({ ...f, phoneCodes: v }))}
                  options={PHONE_CODE_OPTIONS.map(p => ({ value: p.value, label: p.label }))}
                  placeholder={t("leadAssignment.allPhoneCodes")}
                />
              </div>
              <div>
                <Label className="text-xs font-medium mb-1.5">{t("leadAssignment.strategyLabel")}</Label>
                <select className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={form.strategy} onChange={e => setForm(f => ({ ...f, strategy: e.target.value as any }))}>
                  <option value="first">{t("settings.assignFirstStaff")}</option>
                  <option value="round_robin">{t("settings.assignRoundRobin")}</option>
                </select>
              </div>
              <div className="flex items-center gap-3 pt-5">
                <Switch checked={form.isActive} onCheckedChange={v => setForm(f => ({ ...f, isActive: v }))} />
                <Label className="text-sm">{t("leadAssignment.activeLabel")}</Label>
              </div>
            </div>

            <div>
              <Label className="text-xs font-medium mb-1.5">{t("leadAssignment.staffLabel")}</Label>
              <MultiSelectFilter
                values={form.staffUserIds.map(String)}
                onChange={v => setForm(f => ({ ...f, staffUserIds: v.map(x => parseInt(x, 10)).filter(n => !isNaN(n)) }))}
                options={staff.map(u => {
                  const name = `${u.firstName || ""} ${u.lastName || ""}`.trim() || u.email;
                  return { value: String(u.id), label: `${name} (${u.role})` };
                })}
                placeholder={staff.length === 0 ? t("leadAssignment.noStaff") : t("leadAssignment.selectStaff")}
              />
              {form.staffUserIds.length > 0 && (
                <div className="text-[11px] text-muted-foreground mt-1.5">
                  {t("leadAssignment.selected", { names: form.staffUserIds.map(staffLabel).join(", ") })}
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => { setShowForm(false); setEditingId(null); }}>{t("leadAssignment.cancel")}</Button>
              <Button onClick={handleSave} disabled={saving} className="gap-2">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} {t("leadAssignment.save")}
              </Button>
            </div>
          </Card>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
        ) : rules.length === 0 ? (
          <div className="text-sm text-muted-foreground text-center py-10">
            {t("leadAssignment.noRules")}
          </div>
        ) : (
          <div className="space-y-2">
            {rules.map(rule => (
              <div key={rule.id} className="flex items-start gap-3 p-4 rounded-xl border border-border hover-elevate">
                <div className="text-xs font-mono text-muted-foreground shrink-0 mt-0.5 w-8">#{rule.priority}</div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm">{rule.name}</span>
                    {!rule.isActive && <Badge variant="secondary" className="text-[10px]">{t("leadAssignment.inactive")}</Badge>}
                    <Badge variant="outline" className="text-[10px]">
                      {rule.strategy === "round_robin" ? t("leadAssignment.strategyRoundRobin") : t("leadAssignment.strategyFirst")}
                    </Badge>
                  </div>
                  <div className="text-xs text-muted-foreground mt-1 space-y-0.5">
                    {rule.countries.length > 0 && <div>{t("leadAssignment.filterCountry", { values: rule.countries.join(", ") })}</div>}
                    {rule.cities.length > 0 && <div>{t("leadAssignment.filterCity", { values: rule.cities.join(", ") })}</div>}
                    {(rule.phoneCodes?.length ?? 0) > 0 && <div>{t("leadAssignment.filterPhoneCode", { values: rule.phoneCodes.map(phoneCodeLabel).join(", ") })}</div>}
                    {rule.sources.length > 0 && <div>{t("leadAssignment.filterSource", { values: rule.sources.map(sourceLabel).join(", ") })}</div>}
                    {rule.universityIds.length > 0 && <div>{t("leadAssignment.filterUniversity", { values: rule.universityIds.map(uniLabel).join(", ") })}</div>}
                    {rule.countries.length === 0 && rule.cities.length === 0 && (rule.phoneCodes?.length ?? 0) === 0 && rule.sources.length === 0 && rule.universityIds.length === 0 && <div className="italic">{t("leadAssignment.filterAll")}</div>}
                    <div>{t("leadAssignment.filterStaff", { values: rule.staffUserIds.map(staffLabel).join(", ") })}</div>
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Switch checked={rule.isActive} onCheckedChange={() => handleToggle(rule)} />
                  <Button variant="ghost" size="icon" onClick={() => openEdit(rule)}><Pencil className="w-4 h-4" /></Button>
                  <Button variant="ghost" size="icon" onClick={() => setDeleteConfirm(rule.id)}><Trash2 className="w-4 h-4 text-destructive" /></Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {deleteConfirm !== null && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setDeleteConfirm(null)}>
            <Card className="p-6 max-w-sm w-full mx-4" onClick={e => e.stopPropagation()}>
              <h4 className="font-semibold mb-2">{t("leadAssignment.deleteTitle")}</h4>
              <p className="text-sm text-muted-foreground mb-4">{t("leadAssignment.deleteConfirm")}</p>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setDeleteConfirm(null)}>{t("leadAssignment.deleteCancel")}</Button>
                <Button variant="destructive" onClick={() => handleDelete(deleteConfirm)}>{t("leadAssignment.deleteBtn")}</Button>
              </div>
            </Card>
          </div>
        )}
      </Card>
    </div>
  );
}
