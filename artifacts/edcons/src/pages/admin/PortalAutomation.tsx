/**
 * PortalAutomation.tsx — Admin: Portal Otomasyonu sekmeli yönetim sayfası
 *
 * Tabs:
 *  - Otomasyon Kuralları  (SUB-STEP C — tam uygulama)
 *  - Üniversiteler        (SUB-STEP D skeleton)
 *  - Program Haritalama   (SUB-STEP E skeleton)
 *  - Adapter Yönetimi     (SUB-STEP F skeleton)
 */

import { useState, useEffect, useCallback } from "react";
import { customFetch } from "@workspace/api-client-react";
import { useI18n } from "@/hooks/use-i18n";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { PortalErrorState } from "@/components/admin/PortalTabStates";
import { AlertTriangle, Bot, Construction, GitBranch, Play, RefreshCw, Rocket, Save, Timer } from "lucide-react";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import PortalUniversitiesTab from "./PortalUniversitiesTab";
import PortalProgramMappingTab from "./PortalProgramMappingTab";
import PortalAdaptersTab from "./PortalAdaptersTab";
import PortalSubmissionsTab from "./PortalSubmissionsTab";
import PortalAuditTab from "./PortalAuditTab";
import PortalOperationsTab from "./PortalOperationsTab";
import PortalOnboardingTab from "./PortalOnboardingTab";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PortalSettings {
  id?: number;
  isEnabled: boolean;
  triggerStages: string[];
  mode: "dry" | "real";
  scope: "only_applied" | "selected" | "all";
  selectedUniversityKeys: string[];
  concurrency: number;
  maxRetries: number;
  autoProcessEnabled: boolean;
  autoProcessIntervalMinutes: number;
  fallbackEnabled: boolean;
  fanOutMode: "off" | "manual" | "auto";
}

interface PortalUniversity {
  id: number;
  universityKey: string;
  universityName: string;
  adapterKey: string;
  isActive: boolean;
}

interface PortalTriggerStageOption {
  key: string;
  label: string;
  sortOrder: number;
  variant: string | null;
  isCaseClose: boolean;
  eligible: boolean;
  ineligibleReason: "terminal_stage" | null;
}

interface PortalTriggerStageSnapshot {
  stages: PortalTriggerStageOption[];
  configuredKeys: string[];
  validConfiguredKeys: string[];
  staleConfiguredKeys: string[];
  ineligibleConfiguredKeys: string[];
  syncedAt: string;
}

const DEFAULTS: PortalSettings = {
  isEnabled: false,
  triggerStages: [],
  mode: "dry",
  scope: "only_applied",
  selectedUniversityKeys: [],
  concurrency: 2,
  maxRetries: 2,
  autoProcessEnabled: false,
  autoProcessIntervalMinutes: 20,
  fallbackEnabled: false,
  fanOutMode: "off",
};

// ---------------------------------------------------------------------------
// ComingSoon placeholder
// ---------------------------------------------------------------------------
function ComingSoon() {
  const { t } = useI18n();
  return (
    <div className="flex flex-col items-center justify-center py-20 gap-4 text-muted-foreground">
      <Construction className="w-12 h-12 opacity-40" />
      <p className="text-lg font-medium">{t("portalAutomation.comingSoon")}</p>
      <p className="text-sm">{t("portalAutomation.comingSoonHint")}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Otomasyon Kuralları tab
// ---------------------------------------------------------------------------
function AutomationRulesTab() {
  const { t } = useI18n();
  const { toast } = useToast();

  const [settings, setSettings] = useState<PortalSettings>(DEFAULTS);
  const [universities, setUniversities] = useState<PortalUniversity[]>([]);
  const [stageSnapshot, setStageSnapshot] = useState<PortalTriggerStageSnapshot | null>(null);
  const [stagesLoading, setStagesLoading] = useState(false);
  const [stagesLoadError, setStagesLoadError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [confirmRunOpen, setConfirmRunOpen] = useState(false);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [confirmBulkOpen, setConfirmBulkOpen] = useState(false);
  const [bulkCount, setBulkCount] = useState<{ applications: number; universities: number } | null>(null);
  const [bulkCountLoading, setBulkCountLoading] = useState(false);
  const [bulkResult, setBulkResult] = useState<{
    applications: number;
    universities: number;
    counts: { queued: number; excluded: number; noProgram: number; duplicate: number; failed: number };
  } | null>(null);

  const refreshTriggerStages = useCallback(async () => {
    setStagesLoading(true);
    setStagesLoadError(false);
    try {
      const snapshot = await customFetch<PortalTriggerStageSnapshot>(
        "/api/portal-automation/stage-options",
      );
      setStageSnapshot(snapshot);
      const eligibleKeys = new Set(
        snapshot.stages.filter((stage) => stage.eligible).map((stage) => stage.key),
      );
      setSettings((previous) => ({
        ...previous,
        triggerStages: previous.triggerStages.filter((key) => eligibleKeys.has(key)),
      }));
    } catch {
      setStagesLoadError(true);
    } finally {
      setStagesLoading(false);
    }
  }, []);

  // Load settings, universities and the authoritative Application Pipeline.
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    setStagesLoadError(false);
    try {
      const [settingsData, uniData, stageResult] = await Promise.all([
        customFetch<PortalSettings>("/api/portal-automation/settings"),
        customFetch<{ data: PortalUniversity[]; total: number }>(
          "/api/portal-universities?limit=200&onlyActive=true",
        ).catch(() => ({ data: [] as PortalUniversity[], total: 0 })),
        customFetch<PortalTriggerStageSnapshot>(
          "/api/portal-automation/stage-options",
        ).then(
          (snapshot) => ({ snapshot, failed: false as const }),
          () => ({ snapshot: null, failed: true as const }),
        ),
      ]);
      setStageSnapshot(stageResult.snapshot);
      setStagesLoadError(stageResult.failed);
      setSettings({
        ...DEFAULTS,
        ...settingsData,
        triggerStages: stageResult.snapshot
          ? stageResult.snapshot.validConfiguredKeys
          : settingsData.triggerStages,
      });
      setUniversities(uniData.data ?? []);
    } catch {
      setLoadError(true);
      toast({
        title: t("portalAutomation.rules.loadError"),
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [t, toast]);

  useEffect(() => { load(); }, [load]);

  // Save settings
  const save = async () => {
    setSaving(true);
    try {
      const saved = await customFetch<PortalSettings>("/api/portal-automation/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          isEnabled: settings.isEnabled,
          triggerStages: settings.triggerStages,
          mode: settings.mode,
          scope: settings.scope,
          selectedUniversityKeys: settings.selectedUniversityKeys,
          concurrency: settings.concurrency,
          maxRetries: settings.maxRetries,
          autoProcessEnabled: settings.autoProcessEnabled,
          autoProcessIntervalMinutes: settings.autoProcessIntervalMinutes,
          fallbackEnabled: settings.fallbackEnabled,
          fanOutMode: settings.fanOutMode,
        }),
      });
      setSettings({ ...DEFAULTS, ...saved });
      await refreshTriggerStages();
      toast({ title: t("portalAutomation.rules.saveSuccess") });
    } catch {
      toast({ title: t("portalAutomation.rules.saveError"), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  // Run Now — enqueue + immediately process eligible trigger-stage applications.
  const runNow = async () => {
    setConfirmRunOpen(false);
    setRunning(true);
    try {
      const res = await customFetch<{ scanned: number; queued: number; skipped: number }>(
        "/api/portal-automation/run-now",
        { method: "POST" },
      );
      toast({
        title: t("portalAutomation.runNow.resultTitle"),
        description: t("portalAutomation.runNow.resultBody", {
          queued: String(res.queued),
          skipped: String(res.skipped),
        }),
      });
    } catch {
      toast({ title: t("portalAutomation.runNow.errorToast"), variant: "destructive" });
    } finally {
      setRunning(false);
    }
  };

  // Bulk apply-to-all — fan out every trigger-stage application to all
  // credential-ready universities (reuses the shared backend fan-out core).
  const openBulkConfirm = async () => {
    setConfirmBulkOpen(true);
    setBulkCount(null);
    setBulkCountLoading(true);
    try {
      const c = await customFetch<{ applications: number; universities: number }>(
        "/api/portal-automation/apply-to-all-bulk/count",
      );
      setBulkCount(c);
    } catch {
      setBulkCount(null);
    } finally {
      setBulkCountLoading(false);
    }
  };

  const runBulk = async () => {
    setConfirmBulkOpen(false);
    setBulkRunning(true);
    setBulkResult(null);
    try {
      const res = await customFetch<{
        mode: "dry" | "real";
        applications: number;
        universities: number;
        counts: { queued: number; excluded: number; noProgram: number; duplicate: number; failed: number };
      }>("/api/portal-automation/apply-to-all-bulk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: settings.mode,
          confirm: settings.mode === "real" ? true : undefined,
        }),
      });
      setBulkResult(res);
      toast({
        title: t("portalAutomation.applyAllBulk.resultTitle"),
        description: t("portalAutomation.applyAllBulk.resultBody", {
          applications: String(res.applications),
          queued: String(res.counts.queued),
          duplicate: String(res.counts.duplicate),
          noProgram: String(res.counts.noProgram),
          excluded: String(res.counts.excluded),
          failed: String(res.counts.failed),
        }),
      });
    } catch {
      toast({ title: t("portalAutomation.applyAllBulk.errorToast"), variant: "destructive" });
    } finally {
      setBulkRunning(false);
    }
  };

  const toggleStage = (key: string, checked: boolean) => {
    setSettings((prev) => ({
      ...prev,
      triggerStages: checked
        ? [...prev.triggerStages, key]
        : prev.triggerStages.filter((s) => s !== key),
    }));
  };

  const toggleUniversity = (key: string, checked: boolean) => {
    setSettings((prev) => ({
      ...prev,
      selectedUniversityKeys: checked
        ? [...prev.selectedUniversityKeys, key]
        : prev.selectedUniversityKeys.filter((k) => k !== key),
    }));
  };

  if (loading) {
    return (
      <div className="space-y-4 py-4">
        {[...Array(4)].map((_, i) => (
          <Skeleton key={i} className="h-16 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="py-6">
        <PortalErrorState onRetry={load} retrying={loading} />
      </div>
    );
  }

  return (
    <div className="space-y-6 py-2">

      {/* ── isEnabled ───────────────────────────────────────────────────── */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="font-medium">{t("portalAutomation.rules.enabledLabel")}</p>
              <p className="text-sm text-muted-foreground mt-0.5">
                {t("portalAutomation.rules.enabledDescription")}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Switch
                id="pa-enabled"
                checked={settings.isEnabled}
                onCheckedChange={(v) => setSettings((p) => ({ ...p, isEnabled: v }))}
              />
              <Badge
                variant={settings.isEnabled ? "default" : "secondary"}
                className="text-xs"
              >
                {settings.isEnabled
                  ? t("portalAutomation.states.on")
                  : t("portalAutomation.states.off")}
              </Badge>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── fallbackEnabled (global kill-switch) ────────────────────────── */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="font-medium">{t("portalFallback.globalToggle")}</p>
              <p className="text-sm text-muted-foreground mt-0.5">
                {t("portalFallback.globalToggleDescription")}
              </p>
              {!settings.fallbackEnabled && (
                <p className="text-sm text-amber-600 dark:text-amber-500 mt-1">
                  {t("portalFallback.globalToggleWarning")}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Switch
                id="pa-fallback-enabled"
                checked={settings.fallbackEnabled}
                onCheckedChange={(v) => setSettings((p) => ({ ...p, fallbackEnabled: v }))}
              />
              <Badge
                variant={settings.fallbackEnabled ? "default" : "secondary"}
                className="text-xs"
              >
                {settings.fallbackEnabled
                  ? t("portalAutomation.states.on")
                  : t("portalAutomation.states.off")}
              </Badge>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Fan-out mode (global default) ───────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t("portalAutomation.fanOut.title")}</CardTitle>
          <CardDescription>{t("portalAutomation.fanOut.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Select
            value={settings.fanOutMode}
            onValueChange={(v) => setSettings((p) => ({ ...p, fanOutMode: v as "off" | "manual" | "auto" }))}
          >
            <SelectTrigger className="w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(["off", "manual", "auto"] as const).map((m) => (
                <SelectItem key={m} value={m}>
                  {t(`portalAutomation.fanOut.mode_${m}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {settings.fanOutMode === "off" && (
            <p className="text-sm text-muted-foreground mt-2">
              {t("portalAutomation.fanOut.offHint")}
            </p>
          )}
          {settings.fanOutMode === "manual" && (
            <p className="text-sm text-muted-foreground mt-2">
              {t("portalAutomation.fanOut.manualHint")}
            </p>
          )}
          {settings.fanOutMode === "auto" && (
            <p className="text-sm text-amber-600 dark:text-amber-500 mt-2">
              {t("portalAutomation.fanOut.autoHint")}
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── Trigger Stages ──────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-1.5">
              <CardTitle className="flex items-center gap-2 text-base">
                <GitBranch className="h-4 w-4 text-primary" />
                {t("portalAutomation.rules.triggerStagesLabel")}
              </CardTitle>
              <CardDescription>{t("portalAutomation.rules.triggerStagesHint")}</CardDescription>
              <p className="text-xs text-muted-foreground">
                {t("portalAutomation.rules.triggerStagesSource")}
                {stageSnapshot?.syncedAt
                  ? ` · ${t("portalAutomation.rules.triggerStagesSynced", {
                      time: new Date(stageSnapshot.syncedAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      }),
                    })}`
                  : ""}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={refreshTriggerStages}
              disabled={stagesLoading}
              className="shrink-0"
            >
              <RefreshCw className={`mr-2 h-4 w-4 ${stagesLoading ? "animate-spin" : ""}`} />
              {t("portalAutomation.rules.triggerStagesRefresh")}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {(stageSnapshot?.staleConfiguredKeys.length ?? 0) > 0 ||
          (stageSnapshot?.ineligibleConfiguredKeys.length ?? 0) > 0 ? (
            <div className="flex gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <p>
                {t("portalAutomation.rules.triggerStagesDrift", {
                  stages: [
                    ...(stageSnapshot?.staleConfiguredKeys ?? []),
                    ...(stageSnapshot?.ineligibleConfiguredKeys ?? []),
                  ].join(", "),
                })}
              </p>
            </div>
          ) : null}
          {stagesLoading ? (
            <div className="space-y-2">
              {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-8 w-48" />)}
            </div>
          ) : stagesLoadError ? (
            <div className="flex flex-col items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
              <p className="text-sm text-destructive">
                {t("portalAutomation.rules.triggerStagesLoadError")}
              </p>
              <Button type="button" variant="outline" size="sm" onClick={refreshTriggerStages}>
                <RefreshCw className="mr-2 h-4 w-4" />
                {t("portalAutomation.states.retry")}
              </Button>
            </div>
          ) : !stageSnapshot || stageSnapshot.stages.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("portalAutomation.rules.triggerStagesEmpty")}
            </p>
          ) : (
            <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {stageSnapshot.stages.map((stage) => (
                <div
                  key={stage.key}
                  className={`flex items-center justify-between gap-3 rounded-lg border p-3 ${
                    stage.eligible ? "bg-background" : "bg-muted/40 text-muted-foreground"
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                  <Checkbox
                    id={`stage-${stage.key}`}
                    checked={settings.triggerStages.includes(stage.key)}
                    onCheckedChange={(c) => toggleStage(stage.key, c === true)}
                    disabled={!stage.eligible}
                  />
                  <Label
                    htmlFor={`stage-${stage.key}`}
                    className={`truncate text-sm select-none ${
                      stage.eligible ? "cursor-pointer" : "cursor-not-allowed"
                    }`}
                  >
                    {stage.label}
                  </Label>
                  </div>
                  {!stage.eligible ? (
                    <Badge variant="outline" className="shrink-0 text-[10px]">
                      {t("portalAutomation.rules.triggerStageTerminal")}
                    </Badge>
                  ) : null}
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {t("portalAutomation.rules.triggerStagesSelected", {
                count: String(settings.triggerStages.length),
              })}
            </p>
            </>
          )}
        </CardContent>
      </Card>

      {/* ── Submission Mode ─────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t("portalAutomation.rules.modeLabel")}</CardTitle>
        </CardHeader>
        <CardContent>
          <RadioGroup
            value={settings.mode}
            onValueChange={(v) => setSettings((p) => ({ ...p, mode: v as "dry" | "real" }))}
            className="space-y-3"
          >
            {(["dry", "real"] as const).map((m) => (
              <div key={m} className="flex items-start gap-3">
                <RadioGroupItem value={m} id={`mode-${m}`} className="mt-0.5" />
                <Label htmlFor={`mode-${m}`} className="cursor-pointer">
                  <span className="font-medium text-sm">
                    {t(`portalAutomation.rules.mode${m === "dry" ? "Dry" : "Real"}`)}
                  </span>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {t(`portalAutomation.rules.mode${m === "dry" ? "Dry" : "Real"}Hint`)}
                  </p>
                </Label>
              </div>
            ))}
          </RadioGroup>
        </CardContent>
      </Card>

      {/* ── Target Scope ────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t("portalAutomation.rules.scopeLabel")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <RadioGroup
            value={settings.scope}
            onValueChange={(v) =>
              setSettings((p) => ({ ...p, scope: v as PortalSettings["scope"] }))
            }
            className="space-y-3"
          >
            {(
              [
                ["only_applied", "scopeOnlyApplied"],
                ["selected",     "scopeSelected"],
                ["all",          "scopeAll"],
              ] as const
            ).map(([val, tKey]) => (
              <div key={val} className="flex items-center gap-3">
                <RadioGroupItem value={val} id={`scope-${val}`} />
                <Label htmlFor={`scope-${val}`} className="text-sm cursor-pointer">
                  {t(`portalAutomation.rules.${tKey}`)}
                </Label>
              </div>
            ))}
          </RadioGroup>

          {/* University picker — visible only when scope=selected */}
          {settings.scope === "selected" && (
            <>
              <Separator />
              <div>
                <p className="text-sm font-medium mb-1">
                  {t("portalAutomation.rules.selectedUniversitiesLabel")}
                </p>
                <p className="text-xs text-muted-foreground mb-3">
                  {t("portalAutomation.rules.selectedUniversitiesHint")}
                </p>
                {universities.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {t("portalAutomation.rules.noUniversities")}
                  </p>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-64 overflow-y-auto pr-1">
                    {universities.map((uni) => (
                      <div key={uni.universityKey} className="flex items-center gap-2.5">
                        <Checkbox
                          id={`uni-${uni.universityKey}`}
                          checked={settings.selectedUniversityKeys.includes(uni.universityKey)}
                          onCheckedChange={(c) =>
                            toggleUniversity(uni.universityKey, c === true)
                          }
                        />
                        <Label
                          htmlFor={`uni-${uni.universityKey}`}
                          className="text-sm cursor-pointer select-none leading-tight"
                        >
                          {uni.universityName}
                          <span className="ml-1 text-xs text-muted-foreground font-mono">
                            ({uni.universityKey})
                          </span>
                        </Label>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* ── Scheduled Auto-Process ──────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Timer className="w-4 h-4 text-muted-foreground" />
            {t("portalAutomation.rules.autoProcess.title")}
          </CardTitle>
          <CardDescription>
            {t("portalAutomation.rules.autoProcess.description")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Enable toggle */}
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="font-medium text-sm">{t("portalAutomation.rules.autoProcess.enabledLabel")}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t("portalAutomation.rules.autoProcess.enabledDescription")}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Switch
                id="pa-auto-process-enabled"
                checked={settings.autoProcessEnabled}
                onCheckedChange={(v) => setSettings((p) => ({ ...p, autoProcessEnabled: v }))}
              />
              <Badge
                variant={settings.autoProcessEnabled ? "default" : "secondary"}
                className="text-xs"
              >
                {settings.autoProcessEnabled
                  ? t("portalAutomation.states.on")
                  : t("portalAutomation.states.off")}
              </Badge>
            </div>
          </div>

          {/* Interval dropdown — only meaningful when enabled */}
          <div className="flex items-center gap-3 flex-wrap">
            <Label htmlFor="pa-auto-interval" className="text-sm font-medium shrink-0">
              {t("portalAutomation.rules.autoProcess.intervalLabel")}
            </Label>
            <Select
              value={String(settings.autoProcessIntervalMinutes)}
              onValueChange={(v) =>
                setSettings((p) => ({ ...p, autoProcessIntervalMinutes: Number(v) }))
              }
            >
              <SelectTrigger id="pa-auto-interval" className="w-48 h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="10">{t("portalAutomation.rules.autoProcess.interval10")}</SelectItem>
                <SelectItem value="20">{t("portalAutomation.rules.autoProcess.interval20")}</SelectItem>
                <SelectItem value="30">{t("portalAutomation.rules.autoProcess.interval30")}</SelectItem>
                <SelectItem value="60">{t("portalAutomation.rules.autoProcess.interval60")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* ── Actions ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap justify-end gap-3">
        <Button
          variant="outline"
          onClick={openBulkConfirm}
          disabled={bulkRunning || running || saving || stagesLoading || stagesLoadError}
          className="gap-2"
        >
          <Rocket className="w-4 h-4" />
          {bulkRunning
            ? t("portalAutomation.applyAllBulk.running")
            : t("portalAutomation.applyAllBulk.button")}
        </Button>
        <Button
          variant="outline"
          onClick={() => setConfirmRunOpen(true)}
          disabled={running || saving || stagesLoading || stagesLoadError || !settings.isEnabled}
          className="gap-2"
          title={!settings.isEnabled ? t("portalAutomation.runNow.disabled") : undefined}
        >
          <Play className="w-4 h-4" />
          {running
            ? t("portalAutomation.runNow.running")
            : t("portalAutomation.runNow.button")}
        </Button>
        <Button
          onClick={save}
          disabled={saving || stagesLoading || stagesLoadError || !stageSnapshot}
          className="gap-2"
        >
          <Save className="w-4 h-4" />
          {saving
            ? t("portalAutomation.rules.saving")
            : t("portalAutomation.rules.saveButton")}
        </Button>
      </div>

      {/* ── Bulk apply-to-all result panel ──────────────────────────────── */}
      {bulkResult && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              {t("portalAutomation.applyAllBulk.resultPanelTitle")}
            </CardTitle>
            <CardDescription>
              {t("portalAutomation.applyAllBulk.resultPanelHint")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {([
                ["statApplications", bulkResult.applications],
                ["statQueued",       bulkResult.counts.queued],
                ["statDuplicate",    bulkResult.counts.duplicate],
                ["statNoProgram",    bulkResult.counts.noProgram],
                ["statExcluded",     bulkResult.counts.excluded],
                ["statFailed",       bulkResult.counts.failed],
              ] as const).map(([key, value]) => (
                <div key={key} className="rounded-lg border p-3">
                  <p className="text-2xl font-semibold tabular-nums">{value}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {t(`portalAutomation.applyAllBulk.${key}`)}
                  </p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <AlertDialog open={confirmRunOpen} onOpenChange={setConfirmRunOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("portalAutomation.runNow.confirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {settings.mode === "real"
                ? t("portalAutomation.runNow.liveWarning")
                : t("portalAutomation.runNow.confirmBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={runNow}>
              {t("portalAutomation.runNow.confirmAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmBulkOpen} onOpenChange={setConfirmBulkOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("portalAutomation.applyAllBulk.confirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                {bulkCountLoading ? (
                  <span>{t("portalAutomation.applyAllBulk.counting")}</span>
                ) : bulkCount && bulkCount.applications > 0 ? (
                  <>
                    <span>
                      {t("portalAutomation.applyAllBulk.confirmBody", {
                        applications: String(bulkCount.applications),
                        universities: String(bulkCount.universities),
                        mode:
                          settings.mode === "real"
                            ? t("portalAutomation.applyAllBulk.modeLive")
                            : t("portalAutomation.applyAllBulk.modeTest"),
                      })}
                    </span>
                    {settings.mode === "real" && (
                      <span className="block mt-2 font-medium text-destructive">
                        {t("portalAutomation.applyAllBulk.liveWarning")}
                      </span>
                    )}
                  </>
                ) : (
                  <span>{t("portalAutomation.applyAllBulk.noApplications")}</span>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={runBulk}
              disabled={bulkCountLoading || !bulkCount || bulkCount.applications === 0}
            >
              {t("portalAutomation.applyAllBulk.confirmAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page root
// ---------------------------------------------------------------------------
export default function PortalAutomation() {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState("onboarding");

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center gap-3">
        <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-primary/10">
          <Bot className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-display font-bold text-foreground">
            {t("portalAutomation.pageTitle")}
          </h1>
        </div>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <div className="-mx-1 overflow-x-auto px-1 [scrollbar-width:thin]">
          <TabsList className="inline-flex w-max justify-start gap-1">
            <TabsTrigger value="onboarding" className="shrink-0">{t("portalAutomation.tabs.onboarding")}</TabsTrigger>
            <TabsTrigger value="rules" className="shrink-0">{t("portalAutomation.tabs.rules")}</TabsTrigger>
            <TabsTrigger value="operations" className="shrink-0">{t("portalAutomation.tabs.operations")}</TabsTrigger>
            <TabsTrigger value="universities" className="shrink-0">{t("portalAutomation.tabs.universities")}</TabsTrigger>
            <TabsTrigger value="programMapping" className="shrink-0">{t("portalAutomation.tabs.programMapping")}</TabsTrigger>
            <TabsTrigger value="adapters" className="shrink-0">{t("portalAutomation.tabs.adapters")}</TabsTrigger>
            <TabsTrigger value="submissions" className="shrink-0">{t("portalAutomation.tabs.submissions")}</TabsTrigger>
            <TabsTrigger value="auditLog" className="shrink-0">{t("portalAutomation.tabs.auditLog")}</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="onboarding">
          <PortalOnboardingTab onNavigate={setActiveTab} />
        </TabsContent>

        <TabsContent value="rules">
          <AutomationRulesTab />
        </TabsContent>

        <TabsContent value="operations">
          <PortalOperationsTab />
        </TabsContent>

        <TabsContent value="universities">
          <PortalUniversitiesTab />
        </TabsContent>

        <TabsContent value="programMapping">
          <PortalProgramMappingTab />
        </TabsContent>

        <TabsContent value="adapters">
          <PortalAdaptersTab />
        </TabsContent>

        <TabsContent value="submissions">
          <PortalSubmissionsTab />
        </TabsContent>

        <TabsContent value="auditLog">
          <PortalAuditTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
