/**
 * PortalUniversitiesTab.tsx — SUB-STEP D
 *
 * Features:
 *  - Paginated university list with search
 *  - isActive toggle per row (PATCH /portal-universities/:id/active)
 *  - hasCredentials badge (green / red) — no actual creds shown
 *  - Test Login button per row (POST /portal-universities/:id/test-login)
 *  - Add University dialog (POST /portal-universities) — adapter is resolved canonically
 *  - Edit Defaults dialog (PATCH /portal-universities/:id) — defaults JSONB
 */

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { customFetch } from "@workspace/api-client-react";
import { useI18n } from "@/hooks/use-i18n";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { runPortalTestLoginJob } from "@/lib/portalWorkerJobs";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Plus,
  Search,
  CheckCircle2,
  XCircle,
  Loader2,
  Settings2,
  FlaskConical,
  KeySquare,
  Eye,
  EyeOff,
  Trash2,
  Network,
  Check,
  X,
  Building2,
  Link2,
  Link2Off,
  RefreshCw,
  AlertTriangle,
  ExternalLink,
} from "lucide-react";
import {
  PortalEmptyState, PortalErrorState,
} from "@/components/admin/PortalTabStates";
import { PortalMembersDialog } from "@/components/admin/PortalMembersDialog";
import ExclusiveRegionsSection from "./ExclusiveRegionsSection";
import { Textarea } from "@/components/ui/textarea";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { PortalSortControl, type PortalSortDir } from "@/components/admin/PortalSortControl";
import { cn } from "@/lib/utils";

type UniversitySortField = "universityName" | "universityKey" | "createdAt";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PortalUniversity {
  id: number;
  universityKey: string;
  universityName: string;
  adapterKey: string;
  portalUrl: string | null;
  defaults: Record<string, unknown> | null;
  isActive: boolean;
  autoProcess: boolean;
  hasCredentials: boolean;
  isMultiPortal: boolean;
  routesVia: string | null;
  crmUniversityId: number | null;
  crmUniversityName: string | null;
  programCount: number;
  linkStatus: "linked" | "stale" | "unlinked";
  createdAt: string;
  fanOutMode: "off" | "manual" | "auto" | null;
  /** Server-authoritative dynamic graduation decision for this exact adapter. */
  experimental?: boolean;
  staticExperimental?: boolean;
  successCount?: number | null;
  graduationThreshold?: number | null;
  graduated?: boolean | null;
  readiness?: {
    configurationReady: boolean;
    activationEligible: boolean;
    manualPilotEligible: boolean;
    automaticEligible: boolean;
    blockers: string[];
    successProofsRemaining: number;
    phase: string;
  } | null;
}

interface RegistryAdapter {
  key: string;
  label: string;
  kind: "code" | "declarative";
  /** Dynamic: static experimental family AND not yet graduated. */
  experimental?: boolean;
  /** Static family flag (true even after graduation). */
  staticExperimental?: boolean;
  successCount?: number | null;
  graduationThreshold?: number | null;
  graduated?: boolean | null;
  hasCredentials: boolean;
  portalUrl?: string | null;
}

interface UniversityListResponse {
  data: PortalUniversity[];
  total: number;
}

interface UniversityDefaults {
  intakeType?: string;
  semester?: string;
  degreeLevel?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/ş/g, "s").replace(/ğ/g, "g").replace(/ü/g, "u")
    .replace(/ö/g, "o").replace(/ı/g, "i").replace(/ç/g, "c")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

// ---------------------------------------------------------------------------
// AddUniversityDialog
// ---------------------------------------------------------------------------

interface AddDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (uni: PortalUniversity) => void;
}

function AddUniversityDialog({ open, onClose, onCreated }: AddDialogProps) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [key, setKey]   = useState("");
  const [saving, setSaving]     = useState(false);
  const [keyEdited, setKeyEdited] = useState(false);

  // Reset on open
  useEffect(() => {
    if (open) { setName(""); setKey(""); setKeyEdited(false); }
  }, [open]);

  // Auto-slug key from name unless user edited it manually
  useEffect(() => {
    if (!keyEdited) setKey(slugify(name));
  }, [name, keyEdited]);

  const submit = async () => {
    if (!name.trim() || !key.trim()) return;
    setSaving(true);
    try {
      const uni = await customFetch<PortalUniversity>("/api/portal-universities", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ universityName: name.trim(), universityKey: key.trim(), isActive: false }),
      });
      toast({ title: t("portalAutomation.unis.addDialog.saveSuccess") });
      onCreated(uni);
      onClose();
    } catch (err: unknown) {
      const body = (err as any)?.body;
      if (body?.error === "DUPLICATE_KEY") {
        toast({ title: t("portalAutomation.unis.addDialog.duplicateKey"), variant: "destructive" });
      } else if (body?.error === "NO_MATCHING_ADAPTER" || body?.error === "ADAPTER_NOT_FOUND") {
        toast({
          title: t("portalAutomation.unis.addDialog.noAdapters"),
          description: typeof body?.message === "string" ? body.message : undefined,
          variant: "destructive",
        });
      } else {
        toast({ title: t("portalAutomation.unis.addDialog.saveError"), variant: "destructive" });
      }
    } finally {
      setSaving(false);
    }
  };

  const canSubmit = name.trim() && key.trim() && !saving;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("portalAutomation.unis.addDialog.title")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* University name */}
          <div className="space-y-1.5">
            <Label htmlFor="uni-name">{t("portalAutomation.unis.addDialog.nameLabel")}</Label>
            <Input
              id="uni-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="İstanbul Üniversitesi"
              autoFocus
            />
          </div>

          {/* University key */}
          <div className="space-y-1.5">
            <Label htmlFor="uni-key">{t("portalAutomation.unis.addDialog.keyLabel")}</Label>
            <Input
              id="uni-key"
              value={key}
              onChange={(e) => { setKey(e.target.value); setKeyEdited(true); }}
              placeholder="istanbul_universitesi"
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              {t("portalAutomation.unis.addDialog.keyHint")}
            </p>
          </div>

          {/* Adapter resolution is intentionally automatic. The backend uses
              the same canonical resolver as the automation worker, including
              DB-backed custom adapters. */}
          <div className="flex items-start gap-3 rounded-lg border bg-muted/40 p-3">
            <Settings2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <p className="text-sm text-muted-foreground">
              {t("portalAutomation.unis.addDialog.adapterHint")}
            </p>
          </div>

          <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50/60 p-3 dark:border-amber-900 dark:bg-amber-950/20">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <p className="text-sm text-muted-foreground">
              {t("portalAutomation.unis.addDialog.isActiveLabel")}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            {saving
              ? t("portalAutomation.unis.addDialog.saving")
              : t("portalAutomation.unis.addDialog.saveButton")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// EditDefaultsDialog
// ---------------------------------------------------------------------------

interface EditDefaultsDialogProps {
  uni: PortalUniversity | null;
  onClose: () => void;
  onSaved: (updated: PortalUniversity) => void;
  registryAdapters: RegistryAdapter[];
}

const INTAKE_OPTIONS = ["fall", "spring", "summer", "rolling"] as const;
const DEGREE_OPTIONS = ["bachelor", "master", "phd"] as const;

function EditDefaultsDialog({ uni, onClose, onSaved, registryAdapters }: EditDefaultsDialogProps) {
  const { t } = useI18n();
  const { toast } = useToast();
  const defaults = (uni?.defaults ?? {}) as UniversityDefaults;

  const [name,        setName]        = useState(uni?.universityName ?? "");
  const [adapterKey,  setAdapterKey]  = useState(uni?.adapterKey     ?? "");
  const [intakeType,  setIntakeType]  = useState(defaults.intakeType  ?? "");
  const [semester,    setSemester]    = useState(defaults.semester     ?? "");
  const [degreeLevel, setDegreeLevel] = useState(defaults.degreeLevel  ?? "");
  const [isMultiPortal, setIsMultiPortal] = useState(uni?.isMultiPortal ?? false);
  const [saving, setSaving] = useState(false);

  // Sync when uni changes
  useEffect(() => {
    const d = (uni?.defaults ?? {}) as UniversityDefaults;
    setName(uni?.universityName ?? "");
    setAdapterKey(uni?.adapterKey ?? "");
    setIntakeType(d.intakeType ?? "");
    setSemester(d.semester ?? "");
    setDegreeLevel(d.degreeLevel ?? "");
    setIsMultiPortal(uni?.isMultiPortal ?? false);
  }, [uni]);

  // The stored adapter may not be present in the live registry — keep it
  // selectable so editing other fields never silently drops the binding.
  const adapterOptions = useMemo(() => {
    const list = registryAdapters.map((a) => ({ key: a.key, label: a.label, kind: a.kind }));
    if (adapterKey && !list.some((a) => a.key === adapterKey)) {
      list.unshift({ key: adapterKey, label: adapterKey, kind: "code" });
    }
    return list;
  }, [registryAdapters, adapterKey]);

  const save = async () => {
    if (!uni || !name.trim() || !adapterKey) return;
    setSaving(true);
    const newDefaults: UniversityDefaults = {};
    if (intakeType)  newDefaults.intakeType  = intakeType;
    if (semester)    newDefaults.semester    = semester;
    if (degreeLevel) newDefaults.degreeLevel = degreeLevel;

    try {
      const updated = await customFetch<PortalUniversity>(`/api/portal-universities/${uni.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          universityName: name.trim(),
          adapterKey,
          defaults: Object.keys(newDefaults).length ? newDefaults : null,
          isMultiPortal,
        }),
      });
      toast({ title: t("portalAutomation.unis.defaultsDialog.saveSuccess") });
      onSaved(updated);
      onClose();
    } catch {
      toast({ title: t("portalAutomation.unis.defaultsDialog.saveError"), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const intakeLabel = (val: string) => {
    const map: Record<string, string> = {
      fall: t("portalAutomation.unis.defaultsDialog.intakeFall"),
      spring: t("portalAutomation.unis.defaultsDialog.intakeSpring"),
      summer: t("portalAutomation.unis.defaultsDialog.intakeSummer"),
      rolling: t("portalAutomation.unis.defaultsDialog.intakeRolling"),
    };
    return map[val] ?? val;
  };

  const degreeLabel = (val: string) => {
    const map: Record<string, string> = {
      bachelor: t("portalAutomation.unis.defaultsDialog.degreeBachelor"),
      master: t("portalAutomation.unis.defaultsDialog.degreeMaster"),
      phd: t("portalAutomation.unis.defaultsDialog.degreePhd"),
    };
    return map[val] ?? val;
  };

  return (
    <Dialog open={!!uni} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t("portalAutomation.unis.defaultsDialog.editTitle")}
            {uni && (
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                — {uni.universityName}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* University name */}
          <div className="space-y-1.5">
            <Label htmlFor="edit-uni-name">{t("portalAutomation.unis.defaultsDialog.nameLabel")}</Label>
            <Input
              id="edit-uni-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="İstanbul Üniversitesi"
            />
          </div>

          {/* Adapter */}
          <div className="space-y-1.5">
            <Label>{t("portalAutomation.unis.defaultsDialog.adapterLabel")}</Label>
            <Select value={adapterKey} onValueChange={setAdapterKey}>
              <SelectTrigger>
                <SelectValue placeholder={t("portalAutomation.unis.defaultsDialog.adapterLabel")} />
              </SelectTrigger>
              <SelectContent>
                {adapterOptions.map((a) => (
                  <SelectItem key={a.key} value={a.key}>
                    <span className="font-medium">{a.label}</span>
                    <span className="ml-2 text-xs text-muted-foreground font-mono">({a.key})</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Portal URL is owned by the adapter and intentionally read-only. */}
          <div className="space-y-1.5">
            <Label>{t("portalAutomation.unis.defaultsDialog.portalUrlLabel")}</Label>
            {uni?.portalUrl ? (
              <div className="flex gap-2">
                <Input value={uni.portalUrl} readOnly className="font-mono text-xs" />
                <Button variant="outline" size="icon" asChild>
                  <a
                    href={uni.portalUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={t("portalAutomation.unis.openPortal")}
                  >
                    <ExternalLink className="h-4 w-4" />
                  </a>
                </Button>
              </div>
            ) : (
              <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
                {t("portalAutomation.unis.defaultsDialog.portalUrlUnavailable")}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              {t("portalAutomation.unis.defaultsDialog.portalUrlHint")}
            </p>
          </div>

          {/* Multi-portal company toggle */}
          <div className="flex items-start justify-between gap-3 rounded-lg border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="edit-uni-multiportal" className="flex items-center gap-1.5">
                <Network className="w-3.5 h-3.5" />
                {t("portalAutomation.multiPortal.toggleLabel")}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t("portalAutomation.multiPortal.toggleDescription")}
              </p>
            </div>
            <Switch
              id="edit-uni-multiportal"
              checked={isMultiPortal}
              onCheckedChange={setIsMultiPortal}
            />
          </div>

          <div className="border-t pt-3">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              {t("portalAutomation.unis.defaultsDialog.defaultsHeading")}
            </p>
            <p className="text-sm text-muted-foreground mt-1">
              {t("portalAutomation.unis.defaultsDialog.description")}
            </p>
          </div>

          {/* Intake type */}
          <div className="space-y-1.5">
            <Label>{t("portalAutomation.unis.defaultsDialog.intakeLabel")}</Label>
            <Select value={intakeType || "__none__"} onValueChange={(v) => setIntakeType(v === "__none__" ? "" : v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">
                  {t("portalAutomation.unis.defaultsDialog.intakeNone")}
                </SelectItem>
                {INTAKE_OPTIONS.map((o) => (
                  <SelectItem key={o} value={o}>{intakeLabel(o)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Semester */}
          <div className="space-y-1.5">
            <Label htmlFor="def-semester">{t("portalAutomation.unis.defaultsDialog.semesterLabel")}</Label>
            <Input
              id="def-semester"
              value={semester}
              onChange={(e) => setSemester(e.target.value)}
              placeholder={t("portalAutomation.unis.defaultsDialog.semesterPlaceholder")}
            />
          </div>

          {/* Degree level */}
          <div className="space-y-1.5">
            <Label>{t("portalAutomation.unis.defaultsDialog.degreeLevelLabel")}</Label>
            <Select value={degreeLevel || "__none__"} onValueChange={(v) => setDegreeLevel(v === "__none__" ? "" : v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">
                  {t("portalAutomation.unis.defaultsDialog.degreeLevelNone")}
                </SelectItem>
                {DEGREE_OPTIONS.map((o) => (
                  <SelectItem key={o} value={o}>{degreeLabel(o)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button onClick={save} disabled={saving || !name.trim() || !adapterKey}>
            {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            {saving
              ? t("portalAutomation.unis.defaultsDialog.saving")
              : t("portalAutomation.unis.defaultsDialog.saveButton")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// CredentialsDialog — write-only; never shows plaintext credentials
// ---------------------------------------------------------------------------

interface CredentialsDialogProps {
  uni: PortalUniversity | null;
  onClose: () => void;
  onSaved:  (portalKey: string) => void;
  onCleared:(portalKey: string) => void;
}

function CredentialsDialog({ uni, onClose, onSaved, onCleared }: CredentialsDialogProps) {
  const { t } = useI18n();
  const { toast } = useToast();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPw,   setShowPw]   = useState(false);
  const [extra,    setExtra]    = useState("");
  const [saving,   setSaving]   = useState(false);
  const [clearing, setClearing] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [extraError, setExtraError] = useState("");

  useEffect(() => {
    if (uni) {
      setUsername("");
      setPassword("");
      setShowPw(false);
      setExtra("");
      setExtraError("");
      setConfirmClear(false);
    }
  }, [uni]);

  const validateExtra = (v: string): boolean => {
    if (!v.trim()) { setExtraError(""); return true; }
    try { JSON.parse(v); setExtraError(""); return true; }
    catch { setExtraError(t("portalAutomation.unis.credsDialog.extraInvalidJson")); return false; }
  };

  const handleSave = async () => {
    if (!uni || !username.trim() || !password.trim()) return;
    if (!validateExtra(extra)) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = { username: username.trim(), password: password.trim() };
      if (extra.trim()) body.extra = JSON.parse(extra.trim());
      await customFetch(`/api/portal-universities/${uni.universityKey}/credentials`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      toast({ title: t("portalAutomation.unis.credsDialog.saveSuccess") });
      onSaved(uni.universityKey);
      onClose();
    } catch {
      toast({ title: t("portalAutomation.unis.credsDialog.saveError"), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    if (!uni || !confirmClear) { setConfirmClear(true); return; }
    setClearing(true);
    try {
      await customFetch(`/api/portal-universities/${uni.universityKey}/credentials`, {
        method: "DELETE",
      });
      toast({ title: t("portalAutomation.unis.credsDialog.clearSuccess") });
      onCleared(uni.universityKey);
      onClose();
    } catch {
      toast({ title: t("portalAutomation.unis.credsDialog.clearError"), variant: "destructive" });
    } finally {
      setClearing(false);
      setConfirmClear(false);
    }
  };

  const canSave = username.trim() && password.trim() && !saving && !clearing;

  return (
    <Dialog open={!!uni} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t("portalAutomation.unis.credsDialog.title")}
            {uni && (
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                — {uni.universityName}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        <p className="text-sm text-muted-foreground">
          {t("portalAutomation.unis.credsDialog.description")}
        </p>

        <div className="space-y-4 py-1">
          {/* Username */}
          <div className="space-y-1.5">
            <Label htmlFor="cred-username">
              {t("portalAutomation.unis.credsDialog.usernameLabel")}
            </Label>
            <Input
              id="cred-username"
              autoComplete="off"
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="portal@example.com"
            />
          </div>

          {/* Password */}
          <div className="space-y-1.5">
            <Label htmlFor="cred-password">
              {t("portalAutomation.unis.credsDialog.passwordLabel")}
            </Label>
            <div className="relative">
              <Input
                id="cred-password"
                type={showPw ? "text" : "password"}
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="pr-10"
              />
              <button
                type="button"
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => setShowPw((v) => !v)}
                tabIndex={-1}
              >
                {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {/* Extra JSON (optional) */}
          <div className="space-y-1.5">
            <Label htmlFor="cred-extra">
              {t("portalAutomation.unis.credsDialog.extraLabel")}
            </Label>
            <Textarea
              id="cred-extra"
              value={extra}
              onChange={(e) => { setExtra(e.target.value); validateExtra(e.target.value); }}
              placeholder='{"token": "..."}'
              rows={3}
              className="font-mono text-xs resize-none"
            />
            {extraError ? (
              <p className="text-xs text-destructive">{extraError}</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                {t("portalAutomation.unis.credsDialog.extraHint")}
              </p>
            )}
          </div>
        </div>

        <DialogFooter className="flex-col sm:flex-row gap-2">
          {/* Clear credentials (only when creds exist) */}
          {uni?.hasCredentials && (
            <Button
              variant={confirmClear ? "destructive" : "outline"}
              size="sm"
              disabled={saving || clearing}
              onClick={handleClear}
              className="sm:mr-auto gap-1.5"
            >
              {clearing
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <Trash2 className="w-3.5 h-3.5" />}
              {clearing
                ? t("portalAutomation.unis.credsDialog.clearing")
                : confirmClear
                  ? t("portalAutomation.unis.credsDialog.clearConfirm")
                  : t("portalAutomation.unis.credsDialog.clearButton")}
            </Button>
          )}

          <Button variant="outline" onClick={onClose} disabled={saving || clearing}>
            {t("common.cancel")}
          </Button>
          <Button onClick={handleSave} disabled={!canSave}>
            {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            {saving
              ? t("portalAutomation.unis.credsDialog.saving")
              : t("portalAutomation.unis.credsDialog.saveButton")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// UniversityRow
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// LinkStatusBadge — CRM ⇄ portal link state per row (backend linkStatus)
//   linked   : crm_university_id set AND resolves to a CRM university w/ programs
//   stale    : crm_university_id set BUT CRM missing OR has 0 active programs
//   unlinked : crm_university_id NULL (excluded from fan-out until linked)
// ---------------------------------------------------------------------------
function LinkStatusBadge({ uni }: { uni: PortalUniversity }) {
  const { t } = useI18n();

  if (uni.linkStatus === "unlinked") {
    return (
      <Badge
        variant="outline"
        className="gap-1 text-[11px] py-0 h-4 border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-400"
      >
        <Link2Off className="w-2.5 h-2.5" />
        {t("portalAutomation.unis.link.unlinked")}
      </Badge>
    );
  }

  if (uni.linkStatus === "stale") {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge
              variant="outline"
              className="gap-1 text-[11px] py-0 h-4 border-red-300 text-red-700 dark:border-red-800 dark:text-red-400"
            >
              <AlertTriangle className="w-2.5 h-2.5" />
              {t("portalAutomation.unis.link.stale")}
            </Badge>
          </TooltipTrigger>
          <TooltipContent>{t("portalAutomation.unis.link.staleHint")}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge className="gap-1 text-[11px] py-0 h-4 bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400">
            <Link2 className="w-2.5 h-2.5" />
            {t("portalAutomation.unis.link.linked", { count: uni.programCount })}
          </Badge>
        </TooltipTrigger>
        <TooltipContent>{uni.crmUniversityName}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

interface RowProps {
  uni: PortalUniversity;
  onToggle: (id: number, active: boolean) => Promise<void>;
  onToggleAutoProcess: (id: number, autoProcess: boolean) => Promise<void>;
  onSetFanOutMode: (id: number, mode: "off" | "manual" | "auto") => Promise<void>;
  onTestLogin: (id: number) => Promise<void>;
  onEditDefaults: (uni: PortalUniversity) => void;
  onManageCreds: (uni: PortalUniversity) => void;
  onManageMembers: (uni: PortalUniversity) => void;
  onDelete: (uni: PortalUniversity) => void;
  experimental:           boolean;
  graduationInfo:         { successCount: number; threshold: number } | null;
  togglingId:             number | null;
  togglingAutoProcessId:  number | null;
  settingFanOutModeId:    number | null;
  testingId:              number | null;
  selected: boolean;
  onToggleSelect: (id: number) => void;
  bulkBusy: boolean;
}

function UniversityRow({ uni, onToggle, onToggleAutoProcess, onSetFanOutMode, onTestLogin, onEditDefaults, onManageCreds, onManageMembers, onDelete, experimental, graduationInfo, togglingId, togglingAutoProcessId, settingFanOutModeId, testingId, selected, onToggleSelect, bulkBusy }: RowProps) {
  const { t } = useI18n();
  const isToggling            = togglingId            === uni.id;
  const isTogglingAutoProcess = togglingAutoProcessId === uni.id;
  const isSettingFanOutMode   = settingFanOutModeId   === uni.id;
  const isTesting             = testingId             === uni.id;
  const defaults   = (uni.defaults ?? {}) as UniversityDefaults;
  const hasDefaults = !!(defaults.intakeType || defaults.semester || defaults.degreeLevel);
  const activationEligible = uni.readiness?.activationEligible === true;
  const manualPilotEligible = uni.readiness?.manualPilotEligible === true;
  const automaticEligible = uni.readiness?.automaticEligible === true;
  const activationEnableBlocked = !uni.isActive && !activationEligible;
  const autoProcessEnableBlocked = !uni.autoProcess && (!uni.isActive || !automaticEligible);

  return (
    <Card className={cn("rounded-xl overflow-hidden", selected && "ring-1 ring-primary")}>
      <CardContent className="p-4">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <Checkbox
            checked={selected}
            onCheckedChange={() => onToggleSelect(uni.id)}
            disabled={bulkBusy}
            aria-label={t("portalAutomation.unis.selectRow")}
            className="mt-1 sm:mt-0 shrink-0"
          />

          {/* Info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-sm text-foreground truncate">
                {uni.universityName}
              </span>
              {/* Credentials badge */}
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span>
                      {uni.hasCredentials ? (
                        <Badge className="gap-1 bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400 text-xs py-0">
                          <CheckCircle2 className="w-3 h-3" />
                          {t("portalAutomation.unis.credentialsOk")}
                        </Badge>
                      ) : (
                        <Badge className="gap-1 bg-red-100 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-400 text-xs py-0">
                          <XCircle className="w-3 h-3" />
                          {t("portalAutomation.unis.credentialsMissing")}
                        </Badge>
                      )}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    {uni.hasCredentials
                      ? t("portalAutomation.unis.credentialsOk")
                      : t("portalAutomation.unis.credentialsMissing")}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              {/* Multi-portal company badge */}
              {uni.isMultiPortal && (
                <Badge className="gap-1 bg-violet-100 text-violet-700 border-violet-200 dark:bg-violet-900/30 dark:text-violet-400 text-xs py-0">
                  <Network className="w-3 h-3" />
                  {t("portalAutomation.multiPortal.badge")}
                </Badge>
              )}
              {/* Routed-via badge (member of a multi-portal company) */}
              {uni.routesVia && (
                <Badge variant="outline" className="gap-1 text-[11px] py-0 h-4">
                  <Network className="w-2.5 h-2.5" />
                  {t("portalAutomation.multiPortal.routedVia", { portal: uni.routesVia })}
                </Badge>
              )}
            </div>
            {/* Sub-info */}
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <code className="text-[11px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                {uni.universityKey}
              </code>
              <span className="text-[11px] text-muted-foreground">·</span>
              <Badge variant="outline" className="text-[11px] py-0 h-4 gap-1">
                <KeySquare className="w-2.5 h-2.5" />
                {uni.adapterKey}
              </Badge>
              <span className="text-[11px] text-muted-foreground">·</span>
              <LinkStatusBadge uni={uni} />
              {hasDefaults && (
                <>
                  <span className="text-[11px] text-muted-foreground">·</span>
                  <span className="text-[11px] text-muted-foreground">
                    {[defaults.intakeType, defaults.semester, defaults.degreeLevel]
                      .filter(Boolean)
                      .join(" / ")}
                  </span>
                </>
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 shrink-0 flex-wrap">
            {/* isActive toggle */}
            <div className="flex items-center gap-1.5">
              {isToggling
                ? <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                : (
                  <Switch
                    checked={uni.isActive}
                    onCheckedChange={(v) => onToggle(uni.id, v)}
                    disabled={activationEnableBlocked}
                    aria-label={t("portalAutomation.unis.activeLabel")}
                  />
                )}
              <span className="text-xs text-muted-foreground">
                {t("portalAutomation.unis.activeLabel")}
              </span>
            </div>

            {/* fanOutMode selector */}
            <div className="flex items-center gap-1.5">
              {isSettingFanOutMode
                ? <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                : (
                  <Select
                    value={uni.fanOutMode ?? "off"}
                    onValueChange={(v) => onSetFanOutMode(uni.id, v as "off" | "manual" | "auto")}
                  >
                    <SelectTrigger className="h-6 text-xs px-2 w-[86px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(["off", "manual", "auto"] as const).map((m) => (
                        <SelectItem
                          key={m}
                          value={m}
                          className="text-xs"
                          disabled={
                            m === "manual"
                              ? !uni.isActive || !manualPilotEligible
                              : m === "auto"
                                ? !uni.isActive || !automaticEligible
                                : false
                          }
                        >
                          {t(`portalAutomation.unis.fanOutMode_${m}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              <span className="text-xs text-muted-foreground">
                {t("portalAutomation.unis.fanOutModeLabel")}
              </span>
            </div>

            {/* autoProcess toggle */}
            <div className="flex items-center gap-1.5">
              {isTogglingAutoProcess
                ? <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                : autoProcessEnableBlocked ? (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="inline-flex">
                          <Switch
                            checked={uni.autoProcess}
                            disabled
                            aria-label={t("portalAutomation.unis.autoProcessLabel")}
                          />
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        {experimental
                          ? t("portalAutomation.unis.autoProcessExperimentalBlocked")
                          : t("portalAutomation.unis.autoProcessReadinessBlocked")}
                        {experimental && graduationInfo && (
                          <>
                            {" "}
                            {t("portalAutomation.unis.autoProcessGraduationHint", {
                              count: graduationInfo.successCount,
                              threshold: graduationInfo.threshold,
                            })}
                          </>
                        )}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                ) : (
                  <Switch
                    checked={uni.autoProcess}
                    onCheckedChange={(v) => onToggleAutoProcess(uni.id, v)}
                    aria-label={t("portalAutomation.unis.autoProcessLabel")}
                  />
                )}
              <span className="text-xs text-muted-foreground">
                {t("portalAutomation.unis.autoProcessLabel")}
              </span>
            </div>

            {/* Defaults button */}
            {uni.portalUrl && (
              <Button variant="outline" size="sm" className="h-8 gap-1.5" asChild>
                <a href={uni.portalUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="w-3.5 h-3.5" />
                  {t("portalAutomation.unis.openPortal")}
                </a>
              </Button>
            )}

            {/* Defaults button */}
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 gap-1.5"
                    onClick={() => onEditDefaults(uni)}
                  >
                    <Settings2 className="w-3.5 h-3.5" />
                    {t("portalAutomation.unis.defaultsButton")}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {t("portalAutomation.unis.defaultsDialog.description")}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>

            {/* Manage Members button — only for multi-portal companies */}
            {uni.isMultiPortal && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 gap-1.5"
                      onClick={() => onManageMembers(uni)}
                    >
                      <Network className="w-3.5 h-3.5" />
                      {t("portalAutomation.multiPortal.manageButton")}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {t("portalAutomation.multiPortal.membersDescription")}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}

            {/* Credentials button */}
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className={`h-8 gap-1.5 ${!uni.hasCredentials ? "border-red-300 text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950" : ""}`}
                    onClick={() => onManageCreds(uni)}
                  >
                    <KeySquare className="w-3.5 h-3.5" />
                    {t("portalAutomation.unis.credsButton")}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {t("portalAutomation.unis.credsDialog.description")}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>

            {/* Test Login button */}
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5"
              onClick={() => onTestLogin(uni.id)}
              disabled={isTesting}
            >
              {isTesting
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <FlaskConical className="w-3.5 h-3.5" />}
              {isTesting
                ? t("portalAutomation.unis.testLoginTesting")
                : t("portalAutomation.unis.testLoginButton")}
            </Button>

            {/* Delete button */}
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                    onClick={() => onDelete(uni)}
                    aria-label={t("portalAutomation.unis.deleteButton")}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {t("portalAutomation.unis.deleteButton")}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export default function PortalUniversitiesTab() {
  const { t } = useI18n();
  const { toast } = useToast();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin" || user?.role === "super_admin";

  const [unis, setUnis]       = useState<PortalUniversity[]>([]);
  const [relinking, setRelinking] = useState(false);
  const [total, setTotal]     = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [search, setSearch]   = useState("");
  const searchTimer           = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [togglingId, setTogglingId]                         = useState<number | null>(null);
  const [togglingAutoProcessId, setTogglingAutoProcessId]   = useState<number | null>(null);
  const [settingFanOutModeId, setSettingFanOutModeId]       = useState<number | null>(null);
  const [testingId,  setTestingId]  = useState<number | null>(null);

  const [addOpen, setAddOpen]         = useState(false);
  const [editTarget, setEditTarget]   = useState<PortalUniversity | null>(null);
  const [credsTarget, setCredsTarget] = useState<PortalUniversity | null>(null);
  const [membersTarget, setMembersTarget] = useState<PortalUniversity | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PortalUniversity | null>(null);
  const [deletingId, setDeletingId]   = useState<number | null>(null);
  const [registryAdapters, setRegistryAdapters] = useState<RegistryAdapter[]>([]);

  const [sortField, setSortField] = useState<UniversitySortField>("universityName");
  const [sortDir, setSortDir]     = useState<PortalSortDir>("asc");

  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const allSelected = unis.length > 0 && unis.every((u) => selectedIds.has(u.id));
  const someSelected = unis.some((u) => selectedIds.has(u.id)) && !allSelected;

  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        unis.forEach((u) => next.delete(u.id));
      } else {
        unis.forEach((u) => next.add(u.id));
      }
      return next;
    });
  };

  const clearSelection = () => setSelectedIds(new Set());

  const experimentalKeys = useMemo(
    () => new Set(registryAdapters.filter((a) => a.experimental).map((a) => a.key)),
    [registryAdapters],
  );
  const registryAdapterKeys = useMemo(
    () => new Set(registryAdapters.map((a) => a.key)),
    [registryAdapters],
  );

  // Graduation progress per still-experimental adapter key (tooltip detail).
  const graduationInfoByKey = useMemo(() => {
    const map = new Map<string, { successCount: number; threshold: number }>();
    for (const a of registryAdapters) {
      if (a.experimental && a.graduationThreshold != null) {
        map.set(a.key, {
          successCount: a.successCount ?? 0,
          threshold: a.graduationThreshold,
        });
      }
    }
    return map;
  }, [registryAdapters]);

  // Load universities
  const load = useCallback(async (q: string) => {
    setLoading(true);
    setLoadError(false);
    try {
      const params = new URLSearchParams({ limit: "100", sortField, sortDir });
      if (q.trim()) params.set("search", q.trim());
      const res = await customFetch<UniversityListResponse>(
        `/api/portal-universities?${params}`,
      );
      setUnis(res.data ?? []);
      setTotal(res.total ?? 0);
    } catch {
      setLoadError(true);
      toast({ title: t("portalAutomation.unis.loadError"), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [t, toast, sortField, sortDir]);

  // Load registry adapters (for Add dialog)
  const loadAdapters = useCallback(async () => {
    try {
      const res = await customFetch<{ registry: RegistryAdapter[]; db: unknown[] }>(
        "/api/portal-adapters",
      );
      setRegistryAdapters(res.registry ?? []);
    } catch {
      // Non-fatal — adapter list just won't populate the select
    }
  }, []);

  useEffect(() => { loadAdapters(); }, [loadAdapters]);
  useEffect(() => { load(search); }, [load]);

  // Debounced search
  const handleSearch = (q: string) => {
    setSearch(q);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => load(q), 350);
  };

  // Toggle isActive
  const handleToggle = async (id: number, active: boolean) => {
    setTogglingId(id);
    try {
      const updated = await customFetch<PortalUniversity>(
        `/api/portal-universities/${id}/active`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ isActive: active }),
        },
      );
      setUnis((prev) => prev.map((u) => (u.id === id ? { ...u, ...updated } : u)));
      toast({ title: t("portalAutomation.unis.toggleSuccess") });
    } catch {
      toast({ title: t("portalAutomation.unis.toggleError"), variant: "destructive" });
    } finally {
      setTogglingId(null);
    }
  };

  // Toggle autoProcess
  const handleToggleAutoProcess = async (id: number, autoProcess: boolean) => {
    setTogglingAutoProcessId(id);
    try {
      const updated = await customFetch<PortalUniversity>(
        `/api/portal-universities/${id}/auto-process`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ autoProcess }),
        },
      );
      setUnis((prev) => prev.map((u) => (u.id === id ? { ...u, ...updated } : u)));
      toast({ title: t("portalAutomation.unis.toggleSuccess") });
    } catch {
      toast({ title: t("portalAutomation.unis.toggleError"), variant: "destructive" });
    } finally {
      setTogglingAutoProcessId(null);
    }
  };

  // Set fan-out mode override for a university
  const handleSetFanOutMode = async (id: number, mode: "off" | "manual" | "auto") => {
    setSettingFanOutModeId(id);
    try {
      const updated = await customFetch<PortalUniversity>(
        `/api/portal-universities/${id}/fan-out-mode`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ fanOutMode: mode }),
        },
      );
      setUnis((prev) => prev.map((u) => (u.id === id ? { ...u, ...updated } : u)));
      toast({ title: t("portalAutomation.unis.fanOutModeSuccess") });
    } catch {
      toast({ title: t("portalAutomation.unis.fanOutModeError"), variant: "destructive" });
    } finally {
      setSettingFanOutModeId(null);
    }
  };

  // Test login
  const handleTestLogin = async (id: number) => {
    setTestingId(id);
    try {
      const outcome = await runPortalTestLoginJob(id);
      if (outcome !== "PASSED") throw new Error("PORTAL_LOGIN_FAILED");
      toast({ title: t("portalAutomation.unis.testLoginSuccess") });
    } catch {
      toast({ title: t("portalAutomation.unis.testLoginFailed"), variant: "destructive" });
    } finally {
      setTestingId(null);
    }
  };

  // Soft-delete a university
  const handleDelete = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeletingId(target.id);
    try {
      await customFetch(`/api/portal-universities/${target.id}`, { method: "DELETE" });
      setUnis((prev) => prev.filter((u) => u.id !== target.id));
      setTotal((n) => Math.max(0, n - 1));
      toast({ title: t("portalAutomation.unis.deleteSuccess") });
      setDeleteTarget(null);
    } catch {
      toast({ title: t("portalAutomation.unis.deleteError"), variant: "destructive" });
    } finally {
      setDeletingId(null);
    }
  };

  // After creation — prepend to list
  const handleCreated = (uni: PortalUniversity) => {
    setUnis((prev) => [uni, ...prev]);
    setTotal((n) => n + 1);
  };

  // After defaults saved — merge into list
  const handleDefaultsSaved = (updated: PortalUniversity) => {
    setUnis((prev) => prev.map((u) => (u.id === updated.id ? { ...u, ...updated } : u)));
  };

  // After credentials saved — mark hasCredentials=true
  const handleCredsSaved = (portalKey: string) => {
    setUnis((prev) => prev.map((u) => u.universityKey === portalKey ? { ...u, hasCredentials: true } : u));
  };

  // After credentials cleared — mark hasCredentials=false
  const handleCredsCleared = (portalKey: string) => {
    setUnis((prev) => prev.map((u) => u.universityKey === portalKey ? { ...u, hasCredentials: false } : u));
  };

  // Re-link portal ⇄ CRM universities (admin only) — fills crm_university_id by
  // Turkish-aware name matching, then reloads so link badges refresh.
  const handleRelink = async () => {
    setRelinking(true);
    try {
      const res = await customFetch<{
        linked: unknown[];
        alreadyLinked: number;
        unmatched: unknown[];
        stale: unknown[];
      }>("/api/portal-automation/relink-universities", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      toast({
        title: t("portalAutomation.unis.link.relinkSuccess"),
        description: t("portalAutomation.unis.link.relinkSummary", {
          linked: res.linked.length,
          alreadyLinked: res.alreadyLinked,
          unmatched: res.unmatched.length,
          stale: res.stale.length,
        }),
      });
      await load(search);
    } catch {
      toast({ title: t("portalAutomation.unis.link.relinkError"), variant: "destructive" });
    } finally {
      setRelinking(false);
    }
  };

  const handleBulkActive = async (isActive: boolean) => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setBulkBusy(true);
    try {
      interface BulkResult { updated: number; ids: number[] }
      const data = await customFetch<BulkResult>("/api/portal-universities/bulk-active", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids, isActive }),
      });
      toast({ title: t("portalAutomation.unis.bulkActiveSuccess", { count: String(data.updated) }) });
      clearSelection();
      await load(search);
    } catch {
      toast({ title: t("portalAutomation.unis.bulkActiveError"), variant: "destructive" });
    } finally {
      setBulkBusy(false);
    }
  };

  const handleBulkAutoProcess = async (autoProcess: boolean) => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setBulkBusy(true);
    try {
      interface BulkResult { updated: number; ids: number[] }
      const data = await customFetch<BulkResult>("/api/portal-universities/bulk-auto-process", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids, autoProcess }),
      });
      toast({ title: t("portalAutomation.unis.bulkAutoProcessSuccess", { count: String(data.updated) }) });
      clearSelection();
      await load(search);
    } catch {
      toast({ title: t("portalAutomation.unis.bulkAutoProcessError"), variant: "destructive" });
    } finally {
      setBulkBusy(false);
    }
  };

  const handleBulkDelete = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setBulkBusy(true);
    try {
      interface BulkResult { deleted: number; ids: number[] }
      const data = await customFetch<BulkResult>("/api/portal-universities/bulk-delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      toast({ title: t("portalAutomation.unis.bulkDeleteSuccess", { count: String(data.deleted) }) });
      clearSelection();
      await load(search);
    } catch {
      toast({ title: t("portalAutomation.unis.bulkDeleteError"), variant: "destructive" });
    } finally {
      setBulkBusy(false);
    }
  };

  return (
    <div className="space-y-4 py-2">
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder={t("portalAutomation.unis.searchPlaceholder")}
            value={search}
            onChange={(e) => handleSearch(e.target.value)}
          />
        </div>
        <div className="flex gap-2 shrink-0">
          {isAdmin && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    className="gap-2"
                    onClick={handleRelink}
                    disabled={relinking}
                  >
                    {relinking
                      ? <Loader2 className="w-4 h-4 animate-spin" />
                      : <RefreshCw className="w-4 h-4" />}
                    {relinking
                      ? t("portalAutomation.unis.link.relinking")
                      : t("portalAutomation.unis.link.relinkButton")}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t("portalAutomation.unis.link.relinkHint")}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          <Button
            className="gap-2"
            onClick={() => setAddOpen(true)}
          >
            <Plus className="w-4 h-4" />
            {t("portalAutomation.unis.addButton")}
          </Button>
        </div>
      </div>

      {/* Sort + selection toolbar */}
      {!loading && !loadError && unis.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Checkbox
              checked={allSelected ? true : someSelected ? "indeterminate" : false}
              onCheckedChange={toggleSelectAll}
              disabled={bulkBusy}
              aria-label={t("portalAutomation.unis.selectAllOnPage")}
            />
            <span className="text-xs text-muted-foreground">
              {selectedIds.size > 0
                ? t("portalAutomation.unis.selectedCount", { count: String(selectedIds.size) })
                : t("portalAutomation.unis.selectAllOnPage")}
            </span>
          </div>
          <PortalSortControl<UniversitySortField>
            field={sortField}
            dir={sortDir}
            onFieldChange={setSortField}
            onToggleDir={() => setSortDir((d) => d === "asc" ? "desc" : "asc")}
            options={[
              { value: "universityName", label: t("portalAutomation.unis.sortByName") },
              { value: "universityKey", label: t("portalAutomation.unis.sortByKey") },
              { value: "createdAt", label: t("portalAutomation.unis.sortByCreatedAt") },
            ]}
          />
        </div>
      )}

      {/* Bulk action bar */}
      {selectedIds.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2">
          <span className="text-sm font-medium mr-1">
            {t("portalAutomation.unis.selectedCount", { count: String(selectedIds.size) })}
          </span>
          <Button
            variant="outline" size="sm" className="h-8 gap-1.5"
            onClick={() => void handleBulkActive(true)}
            disabled={bulkBusy}
          >
            {bulkBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
            {t("portalAutomation.unis.bulkActivateButton")}
          </Button>
          <Button
            variant="outline" size="sm" className="h-8 gap-1.5"
            onClick={() => void handleBulkActive(false)}
            disabled={bulkBusy}
          >
            {bulkBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <XCircle className="w-3.5 h-3.5" />}
            {t("portalAutomation.unis.bulkDeactivateButton")}
          </Button>
          <Button
            variant="outline" size="sm" className="h-8 gap-1.5"
            onClick={() => void handleBulkAutoProcess(true)}
            disabled={bulkBusy}
          >
            {bulkBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Network className="w-3.5 h-3.5" />}
            {t("portalAutomation.unis.bulkEnableAutoProcessButton")}
          </Button>
          <Button
            variant="outline" size="sm" className="h-8 gap-1.5"
            onClick={() => void handleBulkAutoProcess(false)}
            disabled={bulkBusy}
          >
            {bulkBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Network className="w-3.5 h-3.5" />}
            {t("portalAutomation.unis.bulkDisableAutoProcessButton")}
          </Button>
          <Button
            variant="outline" size="sm" className="h-8 gap-1.5 text-destructive hover:text-destructive"
            onClick={() => setConfirmBulkDelete(true)}
            disabled={bulkBusy}
          >
            {bulkBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
            {t("portalAutomation.unis.bulkDeleteButton")}
          </Button>
          <Button
            variant="ghost" size="sm" className="h-8 text-muted-foreground"
            onClick={clearSelection}
            disabled={bulkBusy}
          >
            {t("portalAutomation.unis.clearSelection")}
          </Button>
        </div>
      )}

      {/* List */}
      {loading ? (
        <div className="space-y-3">
          {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-20 w-full rounded-xl" />)}
        </div>
      ) : loadError ? (
        <PortalErrorState onRetry={() => load(search)} retrying={loading} />
      ) : unis.length === 0 ? (
        <PortalEmptyState
          icon={Building2}
          title={t("portalAutomation.unis.emptyTitle")}
          description={t("portalAutomation.unis.noData")}
          action={
            <Button size="sm" className="gap-1.5" onClick={() => setAddOpen(true)}>
              <Plus className="w-3.5 h-3.5" />
              {t("portalAutomation.unis.addButton")}
            </Button>
          }
        />
      ) : (
        <div className="space-y-3">
          {unis.map((uni) => {
            // Prefer the row-level server decision. A just-created custom key
            // may predate the next list refresh, so absence from the known
            // registry is a conservative manual-only fallback.
            const experimental = uni.experimental ?? (
              experimentalKeys.has(uni.adapterKey) ||
              !registryAdapterKeys.has(uni.adapterKey)
            );
            const graduationInfo =
              experimental && uni.graduationThreshold != null
                ? {
                    successCount: uni.successCount ?? 0,
                    threshold: uni.graduationThreshold,
                  }
                : (graduationInfoByKey.get(uni.adapterKey) ?? null);
            return (
              <UniversityRow
                key={uni.id}
                uni={uni}
                onToggle={handleToggle}
                onToggleAutoProcess={handleToggleAutoProcess}
                onSetFanOutMode={handleSetFanOutMode}
                onTestLogin={handleTestLogin}
                onEditDefaults={setEditTarget}
                onManageCreds={setCredsTarget}
                onManageMembers={setMembersTarget}
                onDelete={setDeleteTarget}
                experimental={experimental}
                graduationInfo={graduationInfo}
                togglingId={togglingId}
                togglingAutoProcessId={togglingAutoProcessId}
                settingFanOutModeId={settingFanOutModeId}
                testingId={testingId}
                selected={selectedIds.has(uni.id)}
                onToggleSelect={toggleSelect}
                bulkBusy={bulkBusy}
              />
            );
          })}
          {total > unis.length && (
            <p className="text-xs text-center text-muted-foreground pt-1">
              {unis.length} / {total}
            </p>
          )}
        </div>
      )}

      {/* Add University dialog */}
      <AddUniversityDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={handleCreated}
      />

      {/* Edit Defaults dialog */}
      <EditDefaultsDialog
        uni={editTarget}
        onClose={() => setEditTarget(null)}
        onSaved={handleDefaultsSaved}
        registryAdapters={registryAdapters}
      />

      {/* Credentials dialog */}
      <CredentialsDialog
        uni={credsTarget}
        onClose={() => setCredsTarget(null)}
        onSaved={handleCredsSaved}
        onCleared={handleCredsCleared}
      />

      {/* Exclusive Bölgeler — university nationality exclusions */}
      <ExclusiveRegionsSection />

      {/* Multi-portal members dialog (Phase 3 catalog-keyed) */}
      <PortalMembersDialog
        portal={membersTarget}
        onClose={() => setMembersTarget(null)}
        onSaved={() => load(search)}
      />

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => { if (!o && deletingId === null) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("portalAutomation.unis.deleteConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("portalAutomation.unis.deleteConfirmDescription", { name: deleteTarget?.universityName ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingId !== null}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); void handleDelete(); }}
              disabled={deletingId !== null}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deletingId !== null && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {deletingId !== null
                ? t("portalAutomation.unis.deleting")
                : t("portalAutomation.unis.deleteConfirmButton")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmBulkDelete} onOpenChange={(o) => { if (!o && !bulkBusy) setConfirmBulkDelete(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("portalAutomation.unis.bulkDeleteConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("portalAutomation.unis.bulkDeleteConfirmDescription", { count: String(selectedIds.size) })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkBusy}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); setConfirmBulkDelete(false); void handleBulkDelete(); }}
              disabled={bulkBusy}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {bulkBusy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {t("portalAutomation.unis.bulkDeleteConfirmButton")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
