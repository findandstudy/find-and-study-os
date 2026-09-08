import { useCallback, useEffect, useState } from "react";
import { customFetch } from "@workspace/api-client-react";
import { useI18n } from "@/hooks/use-i18n";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PortalEmptyState, PortalErrorState, PortalListSkeleton } from "@/components/admin/PortalTabStates";
import { cn } from "@/lib/utils";
import { runPortalTestLoginJob } from "@/lib/portalWorkerJobs";
import {
  Bot,
  Building2,
  CheckCircle2,
  CircleAlert,
  ArrowRight,
  FlaskConical,
  Loader2,
  LogIn,
  RefreshCw,
  Settings2,
  ShieldCheck,
} from "lucide-react";

type Phase =
  | "configuration_required"
  | "test_login_required"
  | "manual_pilot"
  | "strict_dry_run_required"
  | "activation_ready"
  | "automation_ready"
  | "automated";

type Blocker =
  | "ADAPTER_REQUIRED"
  | "SECURE_PORTAL_URL_REQUIRED"
  | "CREDENTIALS_REQUIRED"
  | "CATALOG_LINK_REQUIRED"
  | "ACTIVE_PROGRAM_REQUIRED"
  | "RUNTIME_IDENTITY_REQUIRED"
  | "TEST_LOGIN_REQUIRED"
  | "STRICT_DRY_RUN_ADAPTER_REQUIRED"
  | "STRICT_DRY_RUN_REQUIRED";

interface PartnerReadiness {
  configurationReady: boolean;
  activationEligible: boolean;
  manualPilotEligible: boolean;
  automaticEligible: boolean;
  blockers: Blocker[];
  configurationBlockers: Blocker[];
  activationBlockers: Blocker[];
  executionBlockers: Blocker[];
  successProofsRemaining: number;
  requiredVerifications: ["TEST_LOGIN", "STRICT_DRY_RUN"];
  phase: Phase;
}

interface PartnerRow {
  id: number;
  universityName: string;
  universityKey: string;
  adapterKey: string;
  adapterRegistered: boolean;
  portalUrl: string | null;
  hasCredentials: boolean;
  catalogLinked: boolean;
  activeProgramCount: number;
  targetCount: number;
  isActive: boolean;
  autoProcess: boolean;
  graduationRequired: boolean;
  successCount: number;
  graduationThreshold: number;
  readiness: PartnerReadiness;
  verificationGeneration: number;
  runtimeReleaseId: string | null;
  adapterSpecVersion: number | null;
  adapterSpecSha256: string | null;
  testLoginPassed: boolean;
  testLoginVerifiedAt: string | null;
  strictDryRunCapable: boolean;
  strictDryRunPassed: boolean;
  strictDryRunVerifiedAt: string | null;
}

interface OnboardingSnapshot {
  generatedAt: string;
  globalSafety: {
    pilotSafeDefaults: boolean;
    blockers: string[];
    isEnabled: boolean;
    mode: "dry" | "real";
    autoProcessEnabled: boolean;
    fallbackEnabled: boolean;
    fanOutMode: string;
  };
  summary: {
    total: number;
    configurationReady: number;
    blocked: number;
    manualPilot: number;
    automaticEligible: number;
    automated: number;
  };
  partners: PartnerRow[];
}

function PhaseBadge({ phase }: { phase: Phase }) {
  const { t } = useI18n();
  const ready = phase === "automation_ready" || phase === "automated";
  return (
    <Badge
      variant="outline"
      className={cn(
        "whitespace-nowrap",
        ready
          ? "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300"
          : phase === "configuration_required"
            ? "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300"
            : "border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-300",
      )}
    >
      {t(`portalAutomation.onboarding.phase.${phase}`)}
    </Badge>
  );
}

type PortalSetupTab = "rules" | "operations" | "universities" | "programMapping" | "adapters" | "submissions";

export default function PortalOnboardingTab({
  onNavigate,
}: {
  onNavigate: (tab: PortalSetupTab) => void;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [data, setData] = useState<OnboardingSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      setData(await customFetch<OnboardingSnapshot>("/api/portal-automation/onboarding-readiness"));
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const testLogin = async (partner: PartnerRow) => {
    setBusyAction(`login:${partner.id}`);
    try {
      const outcome = await runPortalTestLoginJob(partner.id);
      if (outcome !== "PASSED") throw new Error("PORTAL_LOGIN_FAILED");
      toast({ title: t("portalAutomation.unis.testLoginSuccess") });
      await load();
    } catch {
      toast({ title: t("portalAutomation.unis.testLoginFailed"), variant: "destructive" });
      await load();
    } finally {
      setBusyAction(null);
    }
  };

  const activate = async (partner: PartnerRow) => {
    setBusyAction(`activate:${partner.id}`);
    try {
      await customFetch(`/api/portal-universities/${partner.id}/active`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ isActive: true }),
      });
      await load();
    } catch {
      toast({ title: t("portalAutomation.onboarding.actionFailed"), variant: "destructive" });
    } finally {
      setBusyAction(null);
    }
  };

  const configurationDestination = (partner: PartnerRow): PortalSetupTab => {
    const blocker = partner.readiness.configurationBlockers[0];
    if (blocker === "ADAPTER_REQUIRED" || blocker === "SECURE_PORTAL_URL_REQUIRED" || blocker === "STRICT_DRY_RUN_ADAPTER_REQUIRED") return "adapters";
    if (blocker === "ACTIVE_PROGRAM_REQUIRED") return "programMapping";
    return "universities";
  };

  if (loading && !data) {
    return <PortalListSkeleton rows={4} rowClassName="h-28" className="py-2" />;
  }
  if (loadError || !data) {
    return <PortalErrorState onRetry={() => void load()} retrying={loading} />;
  }

  const summaryCards = [
    ["total", data.summary.total, Building2],
    ["blocked", data.summary.blocked, CircleAlert],
    ["manualPilot", data.summary.manualPilot, FlaskConical],
    ["automaticEligible", data.summary.automaticEligible, Bot],
  ] as const;

  return (
    <div className="space-y-4 py-2">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">{t("portalAutomation.onboarding.title")}</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            {t("portalAutomation.onboarding.description")}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading} className="gap-1.5">
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          {t("portalAutomation.onboarding.refresh")}
        </Button>
      </div>

      <Card className={cn(
        "border",
        data.globalSafety.pilotSafeDefaults
          ? "border-emerald-200 bg-emerald-50/60 dark:border-emerald-900 dark:bg-emerald-950/20"
          : "border-amber-200 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/20",
      )}>
        <CardContent className="flex items-start gap-3 p-4">
          <ShieldCheck className={cn(
            "mt-0.5 h-5 w-5 shrink-0",
            data.globalSafety.pilotSafeDefaults ? "text-emerald-600" : "text-amber-600",
          )} />
          <div>
            <p className="font-medium">
              {data.globalSafety.pilotSafeDefaults
                ? t("portalAutomation.onboarding.globalSafe")
                : t("portalAutomation.onboarding.globalUnsafe")}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("portalAutomation.onboarding.verificationNote")}
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {summaryCards.map(([key, value, Icon]) => (
          <Card key={key}>
            <CardContent className="flex items-center justify-between p-4">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t(`portalAutomation.onboarding.summary.${key}`)}
                </p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
              </div>
              <Icon className="h-5 w-5 text-primary" />
            </CardContent>
          </Card>
        ))}
      </div>

      {data.partners.length === 0 ? (
        <div className="space-y-3">
          <PortalEmptyState
            icon={Building2}
            title={t("portalAutomation.onboarding.emptyTitle")}
            description={t("portalAutomation.onboarding.emptyDescription")}
          />
          <div className="flex justify-center">
            <Button onClick={() => onNavigate("universities")} className="gap-2">
              {t("portalAutomation.onboarding.addPartner")}
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {data.partners.map((partner) => {
            const completedProofs = partner.graduationRequired
              ? Math.max(0, partner.graduationThreshold - partner.readiness.successProofsRemaining)
              : partner.graduationThreshold;
            const progress = partner.graduationThreshold > 0
              ? Math.min(100, Math.round((completedProofs / partner.graduationThreshold) * 100))
              : 100;
            return (
              <Card key={partner.id}>
                <CardHeader className="pb-3">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <CardTitle className="truncate text-base">{partner.universityName}</CardTitle>
                      <p className="mt-1 text-xs text-muted-foreground">
                        <code>{partner.universityKey}</code> · <code>{partner.adapterKey}</code>
                      </p>
                    </div>
                    <PhaseBadge phase={partner.readiness.phase} />
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid gap-2 text-xs sm:grid-cols-2 xl:grid-cols-4">
                    <span className={partner.adapterRegistered ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300"}>
                      {t("portalAutomation.onboarding.signals.adapter")}: {partner.adapterRegistered ? "✓" : "—"}
                    </span>
                    <span className={partner.portalUrl ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300"}>
                      {t("portalAutomation.onboarding.signals.portalUrl")}: {partner.portalUrl ? "✓" : "—"}
                    </span>
                    <span className={partner.hasCredentials ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300"}>
                      {t("portalAutomation.onboarding.signals.credentials")}: {partner.hasCredentials ? "✓" : "—"}
                    </span>
                    <span className={partner.catalogLinked ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300"}>
                      {t("portalAutomation.onboarding.signals.catalog")}: {partner.catalogLinked ? partner.targetCount : "—"}
                    </span>
                    <span className={partner.activeProgramCount > 0 ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300"}>
                      {t("portalAutomation.onboarding.signals.programs")}: {partner.activeProgramCount}
                    </span>
                    <span className={partner.testLoginPassed ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300"}>
                      {t("portalAutomation.onboarding.signals.testLogin")}: {partner.testLoginPassed ? "✓" : "—"}
                    </span>
                    <span className={partner.strictDryRunCapable ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300"}>
                      {t("portalAutomation.onboarding.signals.strictAdapter")}: {partner.strictDryRunCapable ? "✓" : "—"}
                    </span>
                    <span className={partner.strictDryRunPassed ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300"}>
                      {t("portalAutomation.onboarding.signals.strictDryRun")}: {partner.strictDryRunPassed ? "✓" : "—"}
                    </span>
                    <span className={partner.runtimeReleaseId ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300"}>
                      {t("portalAutomation.onboarding.signals.runtime")}: {partner.runtimeReleaseId ?? "—"}
                    </span>
                  </div>

                  {partner.readiness.blockers.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {partner.readiness.blockers.map((blocker) => (
                        <Badge key={blocker} variant="outline" className="text-[11px]">
                          {t(`portalAutomation.onboarding.blockers.${blocker}`)}
                        </Badge>
                      ))}
                    </div>
                  )}

                  {partner.graduationRequired && (
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>{t("portalAutomation.onboarding.proofs")}</span>
                        <span className="tabular-nums">{completedProofs}/{partner.graduationThreshold}</span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                        <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${progress}%` }} />
                      </div>
                    </div>
                  )}

                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                    <span>{t("portalAutomation.onboarding.requiredChecks")}</span>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 border-t pt-3">
                    {partner.readiness.phase === "configuration_required" && (
                      <Button size="sm" variant="outline" className="gap-2" onClick={() => onNavigate(configurationDestination(partner))}>
                        <Settings2 className="h-3.5 w-3.5" />
                        {t("portalAutomation.onboarding.configure")}
                      </Button>
                    )}
                    {partner.readiness.phase === "test_login_required" && (
                      <Button size="sm" className="gap-2" onClick={() => void testLogin(partner)} disabled={busyAction !== null}>
                        {busyAction === `login:${partner.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <LogIn className="h-3.5 w-3.5" />}
                        {t("portalAutomation.onboarding.runTestLogin")}
                      </Button>
                    )}
                    {partner.readiness.phase === "activation_ready" && (
                      <Button size="sm" onClick={() => void activate(partner)} disabled={busyAction !== null}>
                        {busyAction === `activate:${partner.id}` && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
                        {t("portalAutomation.onboarding.activateForVerification")}
                      </Button>
                    )}
                    {partner.readiness.phase === "strict_dry_run_required" && (
                      <Button size="sm" className="gap-2" onClick={() => onNavigate("submissions")}>
                        <FlaskConical className="h-3.5 w-3.5" />
                        {t("portalAutomation.onboarding.runStrictDry")}
                      </Button>
                    )}
                    {partner.readiness.phase === "manual_pilot" && (
                      <Button size="sm" className="gap-2" onClick={() => onNavigate("submissions")}>
                        {t("portalAutomation.onboarding.openManualPilot")}
                        <ArrowRight className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    {partner.readiness.phase === "automation_ready" && (
                      <Button size="sm" className="gap-2" onClick={() => onNavigate("rules")}>
                        {t("portalAutomation.onboarding.openAutomationRules")}
                        <ArrowRight className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    {partner.readiness.phase === "automated" && (
                      <Button size="sm" variant="outline" className="gap-2" onClick={() => onNavigate("operations")}>
                        {t("portalAutomation.onboarding.openOperations")}
                        <ArrowRight className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    <span className="ml-auto text-[11px] text-muted-foreground">
                      {t("portalAutomation.onboarding.generation", { generation: String(partner.verificationGeneration) })}
                    </span>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
