/**
 * PortalSubmissionsTab.tsx — SUB-STEP G
 *
 * Portal submission tracking board.
 * GET  /api/portal-submissions  (with status/mode filters)
 * POST /api/portal-submissions/:id/retry
 * POST /api/portal-submissions/:id/cancel
 * POST /api/portal-submissions/:id/process       ← A4: manual process
 * POST /api/portal-submissions/process-queued    ← A4: drain all queued
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import { customFetch } from "@workspace/api-client-react";
import { useI18n } from "@/hooks/use-i18n";
import { useToast } from "@/hooks/use-toast";
import { useDebouncedValue } from "@/hooks/use-countries";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { MultiSelectFilter, type MultiSelectOption } from "@/components/admin/MultiSelectFilter";
import { Checkbox } from "@/components/ui/checkbox";
import { PortalSortControl, type PortalSortDir } from "@/components/admin/PortalSortControl";
import { PortalReadinessInlineWarning } from "@/components/PortalReadinessBadge";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  RotateCcw, XCircle, Loader2, RefreshCw, ExternalLink,
  CheckCircle2, Clock, Play, AlertCircle, MinusCircle, SkipForward,
  PlayCircle, ListStart, Eye, Plus, Inbox, Layers, ArrowRight, Globe, UserCheck,
  User, GraduationCap, Search, FilterX, Sparkles, ShieldAlert,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ManualSubmitDialog } from "@/components/admin/ManualSubmitDialog";
import {
  PortalEmptyState, PortalErrorState,
} from "@/components/admin/PortalTabStates";

type SubmissionSortField = "createdAt" | "updatedAt" | "status" | "universityKey";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SubmissionStatus =
  | "queued" | "running" | "submitted" | "already_exists"
  | "program_missing" | "failed" | "canceled" | "dry_run" | "program_full"
  | "exclusive_region";

type SubmissionMode = "dry" | "real";

interface SubmissionResultJson {
  adapterKey?: string;
  dryRun?: boolean;
  filledSlots?: string[];
  missingSlots?: string[];
  result?: {
    submitted?: boolean;
    alreadyExists?: boolean;
    programMissing?: boolean;
    verifiedApplicationNumber?: {
      value: string;
      source: string;
      sourceLabel?: string;
      identityBound: true;
      targetBound: true;
      uniqueMatch: true;
    };
    /** Human-readable skip/failure detail from the adapter. */
    detail?: string;
  };
  aiGuardian?: {
    status?:
      | "processing"
      | "proposed"
      | "staging_failed"
      | "deploy_proposed"
      | "deploy_approved"
      | "deploy_rejected"
      | "proposal_rejected"
      | "error";
    fingerprint?: string;
    diagnosedAt?: string;
    runId?: number;
    actionId?: number;
    deployActionId?: number;
    staging?: {
      status?: "passed" | "failed";
      mode?: "offline_structural";
      reportHash?: string;
      canaryRequired?: boolean;
    };
    error?: string;
    diagnosis?: {
      classification: string;
      confidence: number;
      risk: "low" | "medium" | "high";
      retrySafe: boolean;
      requiresCodeChange: boolean;
      summary: string;
      evidence: string[];
      recommendedAction: string;
      missingDataFields: string[];
      selectorCandidates: unknown[];
      proposedSpecPatch: unknown[];
    };
  };
}

interface PortalSubmission {
  id: number;
  applicationId: number;
  studentId: number;
  universityKey: string;
  universityName: string;
  mode: SubmissionMode;
  status: SubmissionStatus;
  externalRef: string | null;
  error: string | null;
  resultJson: SubmissionResultJson | null;
  attempts: number;
  maxAttempts: number;
  enqueuedBy: number | null;
  createdAt: string;
  updatedAt: string;
  supersededByApplicationId: number | null;
  supersededFromApplicationId: number | null;
  mainApplicationId: number | null;
  studentName: string | null;
  programName: string | null;
  programLanguage: string | null;
  programLevel: string | null;
  /** Program name of the parent (original) application when this is a fallback
   *  child — used to render "applied → submitted" transparency. */
  appliedProgramName: string | null;
  /** Chain step label (X1/X2/X3/Y1/Y2/Y3) — derived server-side for every
   *  attempt; null only for the admin-rule fallback path. */
  fallbackStep: string | null;
  meta: {
    fallbackStep?: string | null;
    fallbackSource?: string | null;
    sameUniversity?: boolean | null;
  } | null;
}

interface UniversityOption { key: string; label: string }

type DatePreset = "all" | "today" | "7days" | "30days" | "custom";

/** Resolve a preset (or custom range) to inclusive ISO from/to bounds. */
function resolveDateRange(
  preset: DatePreset, customFrom: string, customTo: string,
): { from?: string; to?: string } {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  switch (preset) {
    case "today":
      return { from: todayStart.toISOString(), to: now.toISOString() };
    case "7days": {
      const d = new Date(todayStart); d.setDate(d.getDate() - 7);
      return { from: d.toISOString(), to: now.toISOString() };
    }
    case "30days": {
      const d = new Date(todayStart); d.setDate(d.getDate() - 30);
      return { from: d.toISOString(), to: now.toISOString() };
    }
    case "custom": {
      const from = customFrom ? new Date(`${customFrom}T00:00:00`).toISOString() : undefined;
      const to = customTo ? new Date(`${customTo}T23:59:59.999`).toISOString() : undefined;
      return { from, to };
    }
    default:
      return {};
  }
}

interface ListResponse {
  data: PortalSubmission[];
  total: number;
  page: number;
  limit: number;
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

const STATUS_CONFIG: Record<SubmissionStatus, {
  icon: React.ElementType;
  className: string;
}> = {
  queued:          { icon: Clock,       className: "bg-yellow-100 text-yellow-700 border-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-400" },
  running:         { icon: Play,        className: "bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-400" },
  submitted:       { icon: CheckCircle2, className: "bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400" },
  already_exists:  { icon: UserCheck, className: "bg-indigo-100 text-indigo-700 border-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-400" },
  program_missing: { icon: SkipForward, className: "bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-900/30 dark:text-orange-400" },
  failed:          { icon: AlertCircle, className: "bg-red-100 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-400" },
  canceled:        { icon: MinusCircle, className: "bg-muted text-muted-foreground" },
  dry_run:         { icon: Eye, className: "bg-sky-100 text-sky-700 border-sky-200 dark:bg-sky-900/30 dark:text-sky-400" },
  program_full:    { icon: Layers, className: "bg-purple-100 text-purple-700 border-purple-200 dark:bg-purple-900/30 dark:text-purple-400" },
  exclusive_region: { icon: Globe, className: "bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-900/30 dark:text-orange-400" },
};

// Canonical status → i18n label key. SINGLE SOURCE shared by the row badge AND
// the status filter dropdown so the two can never drift.
const STATUS_LABEL_KEYS: Record<SubmissionStatus, string> = {
  queued:           "portalAutomation.submissions.statusPending",
  running:          "portalAutomation.submissions.statusRunning",
  submitted:        "portalAutomation.submissions.statusSubmitted",
  already_exists:   "portalAutomation.submissions.statusAlreadyRegistered",
  program_missing:  "portalAutomation.submissions.statusSkipped",
  failed:           "portalAutomation.submissions.statusFailed",
  canceled:         "portalAutomation.submissions.statusCanceled",
  dry_run:          "portalAutomation.submissions.statusDryRun",
  program_full:     "portalFallback.programFull",
  exclusive_region: "portalAutomation.submissions.statusExclusiveRegion",
};

// All canonical statuses in display order — drives the filter dropdown so any
// new enum value (added to STATUS_CONFIG) is covered automatically. No
// hardcoded subset: dropdown options and row badges share this source.
const ALL_STATUSES = Object.keys(STATUS_CONFIG) as SubmissionStatus[];

const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

// ---------------------------------------------------------------------------
// Expandable error / detail text — truncates long messages with a toggle.
// ---------------------------------------------------------------------------

function ErrorDetail({
  text, prefix, tone = "error",
}: {
  text: string;
  prefix?: string;
  tone?: "error" | "warning";
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const isLong = text.length > 80;
  const toneClass =
    tone === "warning"
      ? "text-orange-600 dark:text-orange-400"
      : "text-destructive";
  return (
    <span className="inline-flex max-w-full items-baseline gap-1">
      <span
        className={cn(
          toneClass,
          "break-words",
          !expanded && isLong && "inline-block max-w-[220px] truncate align-bottom",
        )}
      >
        {prefix ? `${prefix}: ` : ""}{text}
      </span>
      {isLong && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="shrink-0 text-[11px] text-muted-foreground underline hover:text-foreground"
        >
          {expanded
            ? t("portalAutomation.submissions.detailHide")
            : t("portalAutomation.submissions.detailShow")}
        </button>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Submission row
// ---------------------------------------------------------------------------

interface RowProps {
  sub: PortalSubmission;
  onRetry: (id: number) => Promise<void>;
  onCancel: (id: number) => void;
  onProcess: (id: number) => void;
  onDiagnose: (id: number) => Promise<void>;
  retryingId: number | null;
  cancelingId: number | null;
  processingId: number | null;
  diagnosingId: number | null;
  processingAll: boolean;
  selected: boolean;
  onToggleSelect: (id: number) => void;
  bulkBusy: boolean;
}

function SubmissionRow({
  sub, onRetry, onCancel, onProcess, onDiagnose,
  retryingId, cancelingId, processingId, diagnosingId, processingAll,
  selected, onToggleSelect, bulkBusy,
}: RowProps) {
  const { t } = useI18n();
  const cfg = STATUS_CONFIG[sub.status];
  const Icon = cfg.icon;
  const isRetrying   = retryingId  === sub.id;
  const isCanceling  = cancelingId === sub.id;
  const isProcessing = processingId === sub.id;
  const isDiagnosing = diagnosingId === sub.id;

  const canRetry   = sub.status === "failed" || sub.status === "canceled" || sub.status === "dry_run";
  const canCancel  = sub.status === "queued";
  const canProcess = sub.status === "queued";
  const canDiagnose = ["failed", "program_missing", "program_full"].includes(sub.status);
  const guardian = sub.resultJson?.aiGuardian;

  return (
    <Card className={cn("rounded-xl", selected && "ring-1 ring-primary")}>
      <CardContent className="p-4">
        <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
          <Checkbox
            checked={selected}
            onCheckedChange={() => onToggleSelect(sub.id)}
            disabled={bulkBusy}
            aria-label={t("portalAutomation.submissions.selectRow")}
            className="mt-1 sm:mt-0 shrink-0"
          />
          {/* Status + meta */}
          <div className="flex-1 min-w-0 space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge className={cn("gap-1 text-xs py-0", cfg.className)}>
                <Icon className="w-3 h-3" />
                {t(STATUS_LABEL_KEYS[sub.status])}
              </Badge>
              <Badge variant={sub.mode === "real" ? "default" : "secondary"} className="text-xs py-0">
                {sub.mode === "real"
                  ? t("portalAutomation.submissions.modeReal")
                  : t("portalAutomation.submissions.modeDry")}
              </Badge>
              {sub.fallbackStep && (
                <Badge
                  variant="outline"
                  className="gap-1 text-xs py-0 border-purple-300 text-purple-700 dark:border-purple-800 dark:text-purple-300"
                >
                  <Layers className="w-3 h-3" />
                  {t(
                    sub.meta?.fallbackSource === "rule"
                      ? "portalFallback.fallbackStepRule"
                      : "portalFallback.fallbackStepAuto",
                    { step: sub.fallbackStep },
                  )}
                </Badge>
              )}
              {/* Direct / Superseded clarity */}
              {sub.supersededFromApplicationId == null ? (
                <Badge
                  variant="outline"
                  className="text-xs py-0 border-green-300 text-green-700 dark:border-green-800 dark:text-green-400"
                >
                  {t("portalFallback.directLabel")}
                </Badge>
              ) : (
                <Badge
                  variant="outline"
                  className="text-xs py-0 border-orange-300 text-orange-700 dark:border-orange-800 dark:text-orange-400"
                >
                  {sub.fallbackStep?.endsWith("3")
                    ? t("portalFallback.supersededOppLang")
                    : t("portalFallback.supersededSameLang")}
                </Badge>
              )}
              {/* Primary (X = same university) / Fan-out (Y = different university) */}
              {sub.fallbackStep?.startsWith("X") && (
                <Badge
                  variant="outline"
                  className="text-xs py-0 border-blue-300 text-blue-700 dark:border-blue-800 dark:text-blue-400"
                >
                  {t("portalFallback.primaryBadge")}
                </Badge>
              )}
              {sub.fallbackStep?.startsWith("Y") && (
                <Badge
                  variant="outline"
                  className="text-xs py-0 border-amber-400 text-amber-700 dark:border-amber-700 dark:text-amber-400"
                >
                  {t("portalFallback.fanoutBadge")}
                </Badge>
              )}
              <span className="text-xs text-muted-foreground font-medium">
                {sub.universityName}
              </span>
            </div>
            {(sub.studentName || sub.programName) && (
              <div className="flex items-center gap-2 text-sm flex-wrap">
                {sub.studentName && (
                  <span className="inline-flex items-center gap-1 font-medium text-foreground">
                    <User className="w-3.5 h-3.5 text-muted-foreground" />
                    {sub.studentName}
                  </span>
                )}
                {sub.status === "queued" && sub.studentId != null && (
                  <PortalReadinessInlineWarning
                    studentId={sub.studentId}
                    portal={sub.resultJson?.adapterKey ?? sub.universityKey}
                  />
                )}
                {sub.studentName && sub.programName && (
                  <span className="text-muted-foreground">·</span>
                )}
                {sub.programName && (
                  <span className="inline-flex items-center gap-1 text-muted-foreground">
                    <GraduationCap className="w-3.5 h-3.5" />
                    <span className="text-foreground">{sub.programName}</span>
                    {(sub.programLevel || sub.programLanguage) && (
                      <span className="text-muted-foreground">
                        {" ("}
                        {[sub.programLevel, sub.programLanguage].filter(Boolean).join(" · ")}
                        {")"}
                      </span>
                    )}
                  </span>
                )}
              </div>
            )}
            {/* Applied → Submitted program transparency for fallback children */}
            {sub.supersededFromApplicationId != null &&
              sub.appliedProgramName &&
              sub.appliedProgramName !== sub.programName && (
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <span className="line-through opacity-60">{sub.appliedProgramName}</span>
                <ArrowRight className="w-3 h-3 shrink-0" />
                <span>{sub.programName}</span>
              </div>
            )}
            <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
              <span>#{sub.applicationId}</span>
              {sub.supersededByApplicationId != null && (
                <>
                  <span>·</span>
                  <a
                    href={`${BASE_URL}/admin/applications/${sub.supersededByApplicationId}`}
                    className="inline-flex items-center gap-1 text-purple-600 dark:text-purple-400 hover:underline"
                  >
                    <ArrowRight className="w-3 h-3" />
                    {t("portalFallback.supersededTo", { id: sub.supersededByApplicationId })}
                  </a>
                </>
              )}
              {sub.supersededFromApplicationId != null && (
                <>
                  <span>·</span>
                  <a
                    href={`${BASE_URL}/admin/applications/${sub.supersededFromApplicationId}`}
                    className="inline-flex items-center gap-1 text-purple-600 dark:text-purple-400 hover:underline"
                  >
                    <Layers className="w-3 h-3" />
                    {t("portalFallback.supersededFrom", { id: sub.supersededFromApplicationId })}
                  </a>
                </>
              )}
              {sub.externalRef && (
                <>
                  <span>·</span>
                  <span>{t("portalAutomation.submissions.portalLocatorLabel")}:</span>
                  <code className="bg-muted px-1 rounded text-[11px]">{sub.externalRef}</code>
                </>
              )}
              {sub.resultJson?.result?.verifiedApplicationNumber?.value && (
                <>
                  <span>·</span>
                  <span className="inline-flex items-center gap-1 font-medium text-emerald-700 dark:text-emerald-400">
                    <CheckCircle2 className="h-3 w-3" />
                    {t("portalAutomation.submissions.officialApplicationNumberLabel")}:
                    <code className="rounded bg-emerald-50 px-1 text-[11px] dark:bg-emerald-950/40">
                      {sub.resultJson.result.verifiedApplicationNumber.value}
                    </code>
                  </span>
                </>
              )}
              {sub.error && (
                <>
                  <span>·</span>
                  <ErrorDetail text={sub.error} />
                </>
              )}
              {sub.resultJson?.result?.detail && (
                <>
                  <span>·</span>
                  <ErrorDetail
                    text={sub.resultJson.result.detail}
                    prefix={t("portalAutomation.submissions.skipDetailLabel")}
                    tone="warning"
                  />
                </>
              )}
              {sub.resultJson?.missingSlots && sub.resultJson.missingSlots.length > 0 && (
                <>
                  <span>·</span>
                  <span className="text-destructive">
                    {t("portalAutomation.submissions.missingDocSlotsLabel")}: {sub.resultJson.missingSlots.join(", ")}
                  </span>
                </>
              )}
              <span>·</span>
              <span>{new Date(sub.createdAt).toLocaleString()}</span>
              <span>·</span>
              <span>{t("portalAutomation.submissions.attemptsLabel", { current: String(sub.attempts), max: String(sub.maxAttempts) })}</span>
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5"
              asChild
            >
              <a href={`${BASE_URL}/staff/applications/${sub.applicationId}`} target="_blank" rel="noreferrer">
                <ExternalLink className="w-3.5 h-3.5" />
                {t("portalAutomation.submissions.viewApplication")}
              </a>
            </Button>
            {canProcess && (
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 text-primary hover:text-primary"
                onClick={() => onProcess(sub.id)}
                disabled={isProcessing || processingAll || processingId !== null}
              >
                {isProcessing
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <PlayCircle className="w-3.5 h-3.5" />}
                {t("portalAutomation.submissions.processButton")}
              </Button>
            )}
            {canRetry && (
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5"
                onClick={() => onRetry(sub.id)}
                disabled={isRetrying}
              >
                {isRetrying
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <RotateCcw className="w-3.5 h-3.5" />}
                {t("portalAutomation.submissions.retryButton")}
              </Button>
            )}
            {canDiagnose && (
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 border-indigo-300 text-indigo-700 hover:text-indigo-800 dark:border-indigo-800 dark:text-indigo-300"
                onClick={() => void onDiagnose(sub.id)}
                disabled={isDiagnosing || guardian?.status === "processing"}
              >
                {isDiagnosing || guardian?.status === "processing"
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <Sparkles className="w-3.5 h-3.5" />}
                {guardian?.status === "proposed"
                  ? t("portalAutomation.submissions.aiReviewAgain")
                  : t("portalAutomation.submissions.aiDiagnose")}
              </Button>
            )}
            {canCancel && (
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 text-destructive hover:text-destructive"
                onClick={() => onCancel(sub.id)}
                disabled={isCanceling}
              >
                {isCanceling
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <XCircle className="w-3.5 h-3.5" />}
                {t("portalAutomation.submissions.cancelButton")}
              </Button>
            )}
          </div>
        </div>
        {guardian && (
          <div className="mt-3 ml-0 sm:ml-9 rounded-lg border border-indigo-200 bg-indigo-50/50 px-3 py-2 dark:border-indigo-900 dark:bg-indigo-950/20">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <ShieldAlert className="h-4 w-4 text-indigo-600" />
              <span className="font-semibold">
                {t("portalAutomation.submissions.aiGuardian")}
              </span>
              <Badge variant="outline">{guardian.status}</Badge>
              {guardian.diagnosis && (
                <>
                  <Badge variant="secondary">{guardian.diagnosis.classification}</Badge>
                  <span className="text-muted-foreground">
                    {Math.round(guardian.diagnosis.confidence * 100)}%
                  </span>
                  <span className="text-muted-foreground">
                    {t("portalAutomation.submissions.aiRisk")}: {guardian.diagnosis.risk}
                  </span>
                </>
              )}
              {(guardian.deployActionId || guardian.actionId) && (
                <a
                  href={`${BASE_URL}/admin/ai-action-queue`}
                  className="ml-auto text-primary hover:underline"
                >
                  {t("portalAutomation.submissions.aiOpenProposal")}
                </a>
              )}
            </div>
            {guardian.diagnosis && (
              <div className="mt-2 space-y-1 text-xs">
                <p>{guardian.diagnosis.summary}</p>
                <p className="text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {t("portalAutomation.submissions.aiRecommendedAction")}:
                  </span>{" "}
                  {guardian.diagnosis.recommendedAction}
                </p>
                <p className="text-amber-700 dark:text-amber-400">
                  {t("portalAutomation.submissions.aiReviewOnly")}
                </p>
              </div>
            )}
            {guardian.error && guardian.status === "error" && (
              <p className="mt-1 text-xs text-destructive">{guardian.error}</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export default function PortalSubmissionsTab() {
  const { t } = useI18n();
  const { toast } = useToast();

  const [subs, setSubs]       = useState<PortalSubmission[]>([]);
  const [total, setTotal]     = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [page, setPage]       = useState(1);
  const limit                 = 20;

  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [modeFilter, setModeFilter]     = useState<string>("all");
  const [universityKeys, setUniversityKeys] = useState<string[]>([]);
  const [uniOptions, setUniOptions] = useState<UniversityOption[]>([]);
  const [studentName, setStudentName] = useState<string>("");
  const debouncedStudentName = useDebouncedValue(studentName.trim(), 300);
  const [datePreset, setDatePreset] = useState<DatePreset>("all");
  const [customFrom, setCustomFrom] = useState<string>("");
  const [customTo, setCustomTo]     = useState<string>("");

  const [retryingId,   setRetryingId]   = useState<number | null>(null);
  const [cancelingId,  setCancelingId]  = useState<number | null>(null);
  const [processingId, setProcessingId] = useState<number | null>(null);
  const [diagnosingId, setDiagnosingId] = useState<number | null>(null);
  const [processingAll, setProcessingAll] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);

  // Confirmation targets for destructive / live actions.
  const [confirmCancelId, setConfirmCancelId]   = useState<number | null>(null);
  const [confirmProcessId, setConfirmProcessId] = useState<number | null>(null);
  const [confirmProcessAll, setConfirmProcessAll] = useState(false);

  const [sortField, setSortField] = useState<SubmissionSortField>("createdAt");
  const [sortDir, setSortDir]     = useState<PortalSortDir>("desc");

  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [confirmBulkCancel, setConfirmBulkCancel] = useState(false);
  const [confirmBulkProcess, setConfirmBulkProcess] = useState(false);

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectedOnPage = subs.filter((s) => selectedIds.has(s.id));
  const allOnPageSelected = subs.length > 0 && selectedOnPage.length === subs.length;
  const someOnPageSelected = selectedOnPage.length > 0 && !allOnPageSelected;

  const toggleSelectAllOnPage = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) {
        subs.forEach((s) => next.delete(s.id));
      } else {
        subs.forEach((s) => next.add(s.id));
      }
      return next;
    });
  };

  const clearSelection = () => setSelectedIds(new Set());

  const dateRange = useMemo(
    () => resolveDateRange(datePreset, customFrom, customTo),
    [datePreset, customFrom, customTo],
  );

  const hasActiveFilters =
    statusFilter !== "all" || modeFilter !== "all" || universityKeys.length > 0 ||
    debouncedStudentName !== "" || datePreset !== "all";

  const uniFilterOptions: MultiSelectOption[] = useMemo(
    () => uniOptions.map((o) => ({ value: o.key, label: o.label })),
    [uniOptions],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const params = new URLSearchParams({
        page: String(page), limit: String(limit),
        sortField, sortDir,
      });
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (modeFilter   !== "all") params.set("mode",   modeFilter);
      if (universityKeys.length > 0) params.set("universityKeys", universityKeys.join(","));
      if (debouncedStudentName)     params.set("studentName", debouncedStudentName);
      if (dateRange.from)           params.set("dateFrom", dateRange.from);
      if (dateRange.to)             params.set("dateTo", dateRange.to);
      const res = await customFetch<ListResponse>(`/api/portal-submissions?${params}`);
      setSubs(res.data ?? []);
      setTotal(res.total ?? 0);
    } catch {
      setLoadError(true);
      toast({ title: t("portalAutomation.submissions.loadError"), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter, modeFilter, universityKeys, debouncedStudentName, dateRange, sortField, sortDir, t, toast]);

  useEffect(() => { load(); }, [load]);

  // Reset to first page whenever a filter changes.
  useEffect(() => {
    setPage(1);
    setSelectedIds(new Set());
  }, [statusFilter, modeFilter, universityKeys, debouncedStudentName, datePreset, customFrom, customTo]);

  // Load the university options for the multi-select filter once.
  useEffect(() => {
    customFetch<{ data: UniversityOption[] }>("/api/portal-submissions/universities")
      .then((res) => setUniOptions(res.data ?? []))
      .catch(() => setUniOptions([]));
  }, []);

  const clearFilters = () => {
    setStatusFilter("all");
    setModeFilter("all");
    setUniversityKeys([]);
    setStudentName("");
    setDatePreset("all");
    setCustomFrom("");
    setCustomTo("");
  };

  const handleRetry = async (id: number) => {
    setRetryingId(id);
    try {
      await customFetch(`/api/portal-submissions/${id}/retry`, { method: "POST" });
      setSubs((prev) => prev.map((s) => s.id === id ? {
        ...s,
        status: "queued",
        error: null,
        attempts: 0,
        resultJson: s.resultJson
          ? { ...s.resultJson, aiGuardian: undefined }
          : null,
      } : s));
      toast({ title: t("portalAutomation.submissions.retryQueued") });
    } catch {
      toast({ title: t("portalAutomation.submissions.retryError"), variant: "destructive" });
    } finally {
      setRetryingId(null);
    }
  };

  const handleDiagnose = async (id: number) => {
    setDiagnosingId(id);
    try {
      await customFetch(`/api/portal-submissions/${id}/ai-diagnose`, {
        method: "POST",
      });
      toast({ title: t("portalAutomation.submissions.aiDiagnosisReady") });
      await load();
    } catch (error) {
      toast({
        title: t("portalAutomation.submissions.aiDiagnosisError"),
        description: (error as Error).message,
        variant: "destructive",
      });
    } finally {
      setDiagnosingId(null);
    }
  };

  const handleCancel = async (id: number) => {
    setCancelingId(id);
    try {
      await customFetch(`/api/portal-submissions/${id}/cancel`, { method: "POST" });
      setSubs((prev) => prev.map((s) => s.id === id ? { ...s, status: "canceled" } : s));
      toast({ title: t("portalAutomation.submissions.cancelSuccess") });
    } catch {
      toast({ title: t("portalAutomation.submissions.cancelError"), variant: "destructive" });
    } finally {
      setCancelingId(null);
    }
  };

  const handleProcess = async (id: number) => {
    setProcessingId(id);
    try {
      interface ProcessResult {
        accepted: true;
        submissionId: number;
        statusUrl: string;
      }
      await customFetch<ProcessResult>(
        `/api/portal-submissions/${id}/process`,
        { method: "POST" },
      );
      toast({ title: t("portalAutomation.submissions.processSuccess") });
      await load();
    } catch (err: unknown) {
      const body = err && typeof err === "object" && "error" in err
        ? (err as { error: string }).error
        : null;
      if (body === "ALREADY_RUNNING") {
        toast({ title: t("portalAutomation.submissions.alreadyRunning"), variant: "destructive" });
      } else {
        toast({ title: t("portalAutomation.submissions.processError"), variant: "destructive" });
      }
    } finally {
      setProcessingId(null);
    }
  };

  const handleProcessAll = async () => {
    setProcessingAll(true);
    try {
      interface ProcessAllResult {
        accepted: true;
        queued: number;
        statusUrl: string;
      }
      const data = await customFetch<ProcessAllResult>(
        "/api/portal-submissions/process-queued",
        { method: "POST" },
      );
      toast({
        title: t("portalAutomation.submissions.processAllSuccess", { count: String(data.queued) }),
      });
      await load();
    } catch (err: unknown) {
      const body = err && typeof err === "object" && "error" in err
        ? (err as { error: string }).error
        : null;
      if (body === "ALREADY_RUNNING") {
        toast({ title: t("portalAutomation.submissions.alreadyRunning"), variant: "destructive" });
      } else {
        toast({ title: t("portalAutomation.submissions.processAllError"), variant: "destructive" });
      }
    } finally {
      setProcessingAll(false);
      await load();
    }
  };

  const bulkRetryableIds  = selectedOnPage.filter((s) => s.status === "failed" || s.status === "canceled" || s.status === "dry_run").map((s) => s.id);
  const bulkCancelableIds = selectedOnPage.filter((s) => s.status === "queued").map((s) => s.id);
  const bulkProcessableIds = selectedOnPage.filter((s) => s.status === "queued").map((s) => s.id);

  const handleBulkRetry = async () => {
    if (bulkRetryableIds.length === 0) return;
    setBulkBusy(true);
    try {
      interface BulkResult { retried: number; ids: number[] }
      const data = await customFetch<BulkResult>("/api/portal-submissions/bulk-retry", {
        method: "POST",
        body: JSON.stringify({ ids: bulkRetryableIds }),
      });
      toast({ title: t("portalAutomation.submissions.bulkRetrySuccess", { count: String(data.retried) }) });
      clearSelection();
      await load();
    } catch {
      toast({ title: t("portalAutomation.submissions.bulkRetryError"), variant: "destructive" });
    } finally {
      setBulkBusy(false);
    }
  };

  const handleBulkCancel = async () => {
    if (bulkCancelableIds.length === 0) return;
    setBulkBusy(true);
    try {
      interface BulkResult { canceled: number; ids: number[] }
      const data = await customFetch<BulkResult>("/api/portal-submissions/bulk-cancel", {
        method: "POST",
        body: JSON.stringify({ ids: bulkCancelableIds }),
      });
      toast({ title: t("portalAutomation.submissions.bulkCancelSuccess", { count: String(data.canceled) }) });
      clearSelection();
      await load();
    } catch {
      toast({ title: t("portalAutomation.submissions.bulkCancelError"), variant: "destructive" });
    } finally {
      setBulkBusy(false);
    }
  };

  const handleBulkProcess = async () => {
    if (bulkProcessableIds.length === 0) return;
    setBulkBusy(true);
    try {
      interface BulkProcessResult {
        accepted: number;
        ids: number[];
        skipped: number[];
        statusUrl: string;
      }
      const data = await customFetch<BulkProcessResult>("/api/portal-submissions/bulk-process", {
        method: "POST",
        body: JSON.stringify({ ids: bulkProcessableIds }),
      });
      toast({ title: t("portalAutomation.submissions.bulkProcessSuccess", { count: String(data.accepted) }) });
      clearSelection();
      await load();
    } catch (err: unknown) {
      const body = err && typeof err === "object" && "error" in err
        ? (err as { error: string }).error
        : null;
      if (body === "ALREADY_RUNNING") {
        toast({ title: t("portalAutomation.submissions.alreadyRunning"), variant: "destructive" });
      } else {
        toast({ title: t("portalAutomation.submissions.bulkProcessError"), variant: "destructive" });
      }
    } finally {
      setBulkBusy(false);
    }
  };

  const totalPages = Math.ceil(total / limit);
  const hasQueued  = subs.some((s) => s.status === "queued");

  return (
    <div className="space-y-4 py-2">
      {/* Filters + actions */}
      <div className="flex flex-wrap gap-3 items-center justify-between">
        <div className="flex gap-2 flex-wrap items-start">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-40 h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("portalAutomation.submissions.filterAll")}</SelectItem>
              {ALL_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>{t(STATUS_LABEL_KEYS[s])}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={modeFilter} onValueChange={setModeFilter}>
            <SelectTrigger className="w-32 h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("portalAutomation.submissions.filterAll")}</SelectItem>
              <SelectItem value="dry">{t("portalAutomation.submissions.modeDry")}</SelectItem>
              <SelectItem value="real">{t("portalAutomation.submissions.modeReal")}</SelectItem>
            </SelectContent>
          </Select>

          {/* University multi-select (searchable, contained popover) */}
          <MultiSelectFilter
            options={uniFilterOptions}
            value={universityKeys}
            onChange={setUniversityKeys}
            placeholder={t("portalAutomation.submissions.filterUniversity")}
            searchPlaceholder={t("portalAutomation.submissions.filterUniversitySearch")}
            emptyText={t("portalAutomation.submissions.filterUniversityEmpty")}
            selectedText={(n) => t("portalAutomation.submissions.filterUniversityCount", { count: String(n) })}
            className="w-52"
          />

          {/* Student name search */}
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={studentName}
              onChange={(e) => setStudentName(e.target.value)}
              placeholder={t("portalAutomation.submissions.filterStudentName")}
              className="h-9 w-48 pl-8"
            />
          </div>

          {/* Date range */}
          <Select value={datePreset} onValueChange={(v) => setDatePreset(v as DatePreset)}>
            <SelectTrigger className="w-36 h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("portalAutomation.submissions.dateAll")}</SelectItem>
              <SelectItem value="today">{t("portalAutomation.submissions.dateToday")}</SelectItem>
              <SelectItem value="7days">{t("portalAutomation.submissions.date7days")}</SelectItem>
              <SelectItem value="30days">{t("portalAutomation.submissions.date30days")}</SelectItem>
              <SelectItem value="custom">{t("portalAutomation.submissions.dateCustom")}</SelectItem>
            </SelectContent>
          </Select>
          {datePreset === "custom" && (
            <div className="flex items-center gap-1">
              <Input
                type="date"
                value={customFrom}
                max={customTo || undefined}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="h-9 w-[9.5rem]"
              />
              <span className="text-muted-foreground text-sm">–</span>
              <Input
                type="date"
                value={customTo}
                min={customFrom || undefined}
                onChange={(e) => setCustomTo(e.target.value)}
                className="h-9 w-[9.5rem]"
              />
            </div>
          )}

          {hasActiveFilters && (
            <Button
              variant="ghost"
              size="sm"
              className="h-9 gap-1.5 text-muted-foreground"
              onClick={clearFilters}
            >
              <FilterX className="w-3.5 h-3.5" />
              {t("portalAutomation.submissions.clearFilters")}
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          <Button
            variant="default"
            size="sm"
            className="h-9 gap-1.5"
            onClick={() => setManualOpen(true)}
          >
            <Plus className="w-3.5 h-3.5" />
            {t("portalAutomation.manualSubmit.newButton")}
          </Button>
          {hasQueued && (
            <Button
              variant="default"
              size="sm"
              className="h-9 gap-1.5"
              onClick={() => setConfirmProcessAll(true)}
              disabled={processingAll || processingId !== null || loading}
            >
              {processingAll
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <ListStart className="w-3.5 h-3.5" />}
              {t("portalAutomation.submissions.processAllButton")}
            </Button>
          )}
          <Button
            variant="outline" size="sm" className="h-9 gap-1.5"
            onClick={() => load()}
            disabled={loading}
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            {t("portalAutomation.submissions.refreshButton")}
          </Button>
        </div>
      </div>

      {/* Sort + selection toolbar */}
      {subs.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Checkbox
              checked={allOnPageSelected ? true : someOnPageSelected ? "indeterminate" : false}
              onCheckedChange={toggleSelectAllOnPage}
              disabled={bulkBusy}
              aria-label={t("portalAutomation.submissions.selectAllOnPage")}
            />
            <span className="text-xs text-muted-foreground">
              {selectedIds.size > 0
                ? t("portalAutomation.submissions.selectedCount", { count: String(selectedIds.size) })
                : t("portalAutomation.submissions.selectAllOnPage")}
            </span>
          </div>
          <PortalSortControl<SubmissionSortField>
            field={sortField}
            dir={sortDir}
            onFieldChange={setSortField}
            onToggleDir={() => setSortDir((d) => d === "asc" ? "desc" : "asc")}
            options={[
              { value: "createdAt", label: t("portalAutomation.submissions.sortByCreatedAt") },
              { value: "updatedAt", label: t("portalAutomation.submissions.sortByUpdatedAt") },
              { value: "status", label: t("portalAutomation.submissions.sortByStatus") },
              { value: "universityKey", label: t("portalAutomation.submissions.sortByUniversity") },
            ]}
          />
        </div>
      )}

      {/* Bulk action bar */}
      {selectedIds.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2">
          <span className="text-sm font-medium mr-1">
            {t("portalAutomation.submissions.selectedCount", { count: String(selectedIds.size) })}
          </span>
          <Button
            variant="outline" size="sm" className="h-8 gap-1.5"
            onClick={handleBulkRetry}
            disabled={bulkBusy || bulkRetryableIds.length === 0}
          >
            {bulkBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
            {t("portalAutomation.submissions.bulkRetryButton", { count: String(bulkRetryableIds.length) })}
          </Button>
          <Button
            variant="outline" size="sm" className="h-8 gap-1.5"
            onClick={() => setConfirmBulkProcess(true)}
            disabled={bulkBusy || bulkProcessableIds.length === 0}
          >
            {bulkBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PlayCircle className="w-3.5 h-3.5" />}
            {t("portalAutomation.submissions.bulkProcessButton", { count: String(bulkProcessableIds.length) })}
          </Button>
          <Button
            variant="outline" size="sm" className="h-8 gap-1.5 text-destructive hover:text-destructive"
            onClick={() => setConfirmBulkCancel(true)}
            disabled={bulkBusy || bulkCancelableIds.length === 0}
          >
            {bulkBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <XCircle className="w-3.5 h-3.5" />}
            {t("portalAutomation.submissions.bulkCancelButton", { count: String(bulkCancelableIds.length) })}
          </Button>
          <Button
            variant="ghost" size="sm" className="h-8 text-muted-foreground"
            onClick={clearSelection}
            disabled={bulkBusy}
          >
            {t("portalAutomation.submissions.clearSelection")}
          </Button>
        </div>
      )}

      {/* List */}
      {loading ? (
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-20 w-full rounded-xl" />)}
        </div>
      ) : loadError ? (
        <PortalErrorState onRetry={() => load()} retrying={loading} />
      ) : subs.length === 0 ? (
        <PortalEmptyState
          icon={Inbox}
          title={t("portalAutomation.submissions.emptyTitle")}
          description={t("portalAutomation.submissions.emptyDescription")}
          action={
            <Button size="sm" className="gap-1.5" onClick={() => setManualOpen(true)}>
              <Plus className="w-3.5 h-3.5" />
              {t("portalAutomation.manualSubmit.newButton")}
            </Button>
          }
        />
      ) : (
        <div className="space-y-3">
          {subs.map((sub) => (
            <SubmissionRow
              key={sub.id}
              sub={sub}
              onRetry={handleRetry}
              onCancel={(id) => setConfirmCancelId(id)}
              onProcess={(id) => setConfirmProcessId(id)}
              onDiagnose={handleDiagnose}
              retryingId={retryingId}
              cancelingId={cancelingId}
              processingId={processingId}
              diagnosingId={diagnosingId}
              processingAll={processingAll}
              selected={selectedIds.has(sub.id)}
              onToggleSelect={toggleSelect}
              bulkBusy={bulkBusy}
            />
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 pt-2">
          <Button
            variant="outline" size="sm"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1 || loading}
          >
            {t("common.previous")}
          </Button>
          <span className="text-sm text-muted-foreground">
            {page} / {totalPages}
          </span>
          <Button
            variant="outline" size="sm"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages || loading}
          >
            {t("common.next")}
          </Button>
        </div>
      )}

      <ManualSubmitDialog
        open={manualOpen}
        onOpenChange={setManualOpen}
        onQueued={() => { setPage(1); void load(); }}
      />

      {/* Cancel confirmation */}
      <AlertDialog open={confirmCancelId !== null} onOpenChange={(o) => { if (!o) setConfirmCancelId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("portalAutomation.submissions.cancelConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("portalAutomation.submissions.cancelConfirmDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                const id = confirmCancelId;
                setConfirmCancelId(null);
                if (id !== null) void handleCancel(id);
              }}
            >
              {t("portalAutomation.submissions.cancelButton")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Process single confirmation */}
      <AlertDialog open={confirmProcessId !== null} onOpenChange={(o) => { if (!o) setConfirmProcessId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("portalAutomation.submissions.processConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("portalAutomation.submissions.processConfirmDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const id = confirmProcessId;
                setConfirmProcessId(null);
                if (id !== null) void handleProcess(id);
              }}
            >
              {t("portalAutomation.submissions.confirmProcess")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Process all confirmation */}
      <AlertDialog open={confirmProcessAll} onOpenChange={setConfirmProcessAll}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("portalAutomation.submissions.processAllConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("portalAutomation.submissions.processAllConfirmDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmProcessAll(false);
                void handleProcessAll();
              }}
            >
              {t("portalAutomation.submissions.confirmProcess")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk cancel confirmation */}
      <AlertDialog open={confirmBulkCancel} onOpenChange={setConfirmBulkCancel}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("portalAutomation.submissions.bulkCancelConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("portalAutomation.submissions.bulkCancelConfirmDescription", { count: String(bulkCancelableIds.length) })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                setConfirmBulkCancel(false);
                void handleBulkCancel();
              }}
            >
              {t("portalAutomation.submissions.bulkCancelButton", { count: String(bulkCancelableIds.length) })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk process confirmation */}
      <AlertDialog open={confirmBulkProcess} onOpenChange={setConfirmBulkProcess}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("portalAutomation.submissions.bulkProcessConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("portalAutomation.submissions.bulkProcessConfirmDescription", { count: String(bulkProcessableIds.length) })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmBulkProcess(false);
                void handleBulkProcess();
              }}
            >
              {t("portalAutomation.submissions.confirmProcess")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
