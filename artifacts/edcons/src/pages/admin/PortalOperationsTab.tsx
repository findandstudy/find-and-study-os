import { useCallback, useEffect, useState } from "react";
import {
  customFetch,
  type PortalOperationsResponse,
} from "@workspace/api-client-react";
import { useI18n } from "@/hooks/use-i18n";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { PortalEmptyState, PortalErrorState } from "@/components/admin/PortalTabStates";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  FileWarning,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  Rows3,
  ShieldCheck,
} from "lucide-react";

type PortalLifecycleDecision = {
  signal?: string;
  disposition?: string;
  targetStage?: string | null;
  action?: string;
  requiredArtifact?: string | null;
  artifactVerified?: boolean;
  reason?: string;
};

type PortalLifecycleProposal = {
  id: number;
  submissionId: number;
  applicationId: number;
  rawStatus: string;
  currentStage: string;
  decision: PortalLifecycleDecision;
  artifacts: string[];
  missingDocuments: Array<{ code?: string; label: string }>;
  applicationReferenceSync: string | null;
  status: string;
  createdAt: string;
};

type ReviewChoice = {
  proposal: PortalLifecycleProposal;
  decision: "approve" | "reject";
  requestKey: string;
};

function createRequestKey(): string {
  const value = globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `portal-review:${value}`;
}

const number = (value: number | string | undefined): number =>
  Number.isFinite(Number(value)) ? Number(value) : 0;

function time(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "—";
}

export default function PortalOperationsTab() {
  const { t } = useI18n();
  const { toast } = useToast();
  const [data, setData] = useState<PortalOperationsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [running, setRunning] = useState(false);
  const [resuming, setResuming] = useState<Set<number>>(new Set());
  const [proposals, setProposals] = useState<PortalLifecycleProposal[]>([]);
  const [reviewChoice, setReviewChoice] = useState<ReviewChoice | null>(null);
  const [reviewReason, setReviewReason] = useState("");
  const [reviewing, setReviewing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const [operations, proposalResponse] = await Promise.all([
        customFetch<PortalOperationsResponse>("/api/portal-automation/operations"),
        customFetch<{ items: PortalLifecycleProposal[] }>(
          "/api/portal-lifecycle-proposals?status=pending_review&limit=50",
        ),
      ]);
      setData(operations);
      setProposals(proposalResponse.items);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runStatusSync = async () => {
    setRunning(true);
    try {
      await customFetch("/api/portal-automation/status-sync/run", { method: "POST" });
      toast({ title: t("portalAutomation.operations.runStarted") });
      window.setTimeout(() => void load(), 1_500);
    } catch {
      toast({ title: t("portalAutomation.operations.runError"), variant: "destructive" });
    } finally {
      setRunning(false);
    }
  };

  const openReview = (proposal: PortalLifecycleProposal, decision: "approve" | "reject") => {
    setReviewReason("");
    setReviewChoice({ proposal, decision, requestKey: createRequestKey() });
  };

  const submitReview = async () => {
    if (!reviewChoice) return;
    setReviewing(true);
    try {
      const result = await customFetch<{
        executionQueued: boolean;
        executionReason?: string;
      }>(`/api/portal-lifecycle-proposals/${reviewChoice.proposal.id}/review`, {
        method: "POST",
        body: JSON.stringify({
          decision: reviewChoice.decision,
          reason: reviewReason.trim() || undefined,
          requestKey: reviewChoice.requestKey,
        }),
      });
      toast({
        title: reviewChoice.decision === "approve"
          ? t("portalAutomation.operations.reviewApproved")
          : t("portalAutomation.operations.reviewRejected"),
        description: reviewChoice.decision === "approve" && !result.executionQueued
          ? t("portalAutomation.operations.reviewSavedNotQueued", {
              reason: result.executionReason ?? "MANUAL_ACTION_REQUIRED",
            })
          : undefined,
      });
      setReviewChoice(null);
      await load();
    } catch {
      toast({ title: t("portalAutomation.operations.reviewError"), variant: "destructive" });
    } finally {
      setReviewing(false);
    }
  };

  const resume = async (submissionId: number) => {
    setResuming((current) => new Set(current).add(submissionId));
    try {
      await customFetch(`/api/portal-submissions/${submissionId}/status-check/resume`, {
        method: "POST",
      });
      toast({ title: t("portalAutomation.operations.resumeSuccess") });
      await load();
    } catch {
      toast({ title: t("portalAutomation.operations.resumeError"), variant: "destructive" });
    } finally {
      setResuming((current) => {
        const next = new Set(current);
        next.delete(submissionId);
        return next;
      });
    }
  };

  if (loading && !data) {
    return (
      <div className="space-y-4 py-2">
        <Skeleton className="h-10 w-full" />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {Array.from({ length: 5 }, (_, index) => (
            <Skeleton key={index} className="h-28 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-72 rounded-xl" />
      </div>
    );
  }
  if (loadError || !data) {
    return <PortalErrorState onRetry={load} retrying={loading} />;
  }

  const summary = data.summary;
  const metrics = [
    {
      label: t("portalAutomation.operations.tracked"),
      value: number(summary.tracked),
      hint: t("portalAutomation.operations.trackedHint"),
      icon: Rows3,
    },
    {
      label: t("portalAutomation.operations.due"),
      value: number(summary.due),
      hint: t("portalAutomation.operations.checkingHint", { count: String(number(summary.checking)) }),
      icon: Clock3,
    },
    {
      label: t("portalAutomation.operations.retrying"),
      value: number(summary.retrying),
      hint: t("portalAutomation.operations.suspendedHint", { count: String(number(summary.suspended)) }),
      icon: AlertTriangle,
    },
    {
      label: t("portalAutomation.operations.observations"),
      value: number(summary.observations24h),
      hint: t("portalAutomation.operations.unverifiedHint", { count: String(number(summary.unverified24h)) }),
      icon: Activity,
    },
    {
      label: t("portalAutomation.operations.pendingReviews"),
      value: number(summary.pendingReviews),
      hint: t("portalAutomation.operations.decisionsHint", { count: String(number(summary.decisions24h)) }),
      icon: ShieldCheck,
    },
  ];

  return (
    <div className="space-y-5 py-2">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">{t("portalAutomation.operations.title")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("portalAutomation.operations.description")}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={load} disabled={loading} className="gap-1.5">
            {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            {t("portalAutomation.operations.refresh")}
          </Button>
          <Button size="sm" onClick={runStatusSync} disabled={running} className="gap-1.5">
            {running ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
            {t("portalAutomation.operations.runCheck")}
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {metrics.map(({ label, value, hint, icon: Icon }) => (
          <Card key={label}>
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
                  <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
                </div>
                <div className="rounded-lg bg-primary/10 p-2 text-primary"><Icon className="size-4" /></div>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">{hint}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t("portalAutomation.operations.lanesTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          {data.lanes.length === 0 ? (
            <PortalEmptyState icon={Rows3} title={t("portalAutomation.operations.emptyLanes")} />
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full min-w-[760px] text-sm">
                <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">{t("portalAutomation.operations.lane")}</th>
                    <th className="px-3 py-2 font-medium">{t("portalAutomation.operations.tracked")}</th>
                    <th className="px-3 py-2 font-medium">{t("portalAutomation.operations.due")}</th>
                    <th className="px-3 py-2 font-medium">{t("portalAutomation.operations.retrying")}</th>
                    <th className="px-3 py-2 font-medium">{t("portalAutomation.operations.suspended")}</th>
                    <th className="px-3 py-2 font-medium">{t("portalAutomation.operations.lastChecked")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {data.lanes.map((lane) => (
                    <tr key={lane.laneKey}>
                      <td className="px-3 py-3">
                        <p className="font-medium">{lane.universityKey}</p>
                        <p className="text-xs text-muted-foreground">{lane.adapterKey}</p>
                      </td>
                      <td className="px-3 py-3 tabular-nums">{number(lane.tracked)}</td>
                      <td className="px-3 py-3 tabular-nums">{number(lane.due)}{number(lane.checking) > 0 ? ` · ${number(lane.checking)} ${t("portalAutomation.operations.checking")}` : ""}</td>
                      <td className="px-3 py-3 tabular-nums">{number(lane.retrying)}</td>
                      <td className="px-3 py-3">
                        {number(lane.suspended) > 0 ? <Badge variant="destructive">{number(lane.suspended)}</Badge> : "0"}
                      </td>
                      <td className="px-3 py-3 text-xs text-muted-foreground">{time(lane.lastCheckedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {data.suspended.length > 0 && (
        <Card className="border-destructive/30">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="size-4 text-destructive" />
              {t("portalAutomation.operations.quarantineTitle")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {data.suspended.map((item) => (
              <div key={item.submissionId} className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">#{item.submissionId} · {item.universityKey}</p>
                  <p className="text-xs text-muted-foreground">
                    {item.errorCategory} · {item.attempts} {t("portalAutomation.operations.attempts")} · {time(item.suspendedAt)}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  disabled={resuming.has(item.submissionId)}
                  onClick={() => void resume(item.submissionId)}
                >
                  {resuming.has(item.submissionId) ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
                  {t("portalAutomation.operations.resume")}
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="size-4 text-primary" />
            {t("portalAutomation.operations.reviewQueueTitle")}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {t("portalAutomation.operations.reviewQueueDescription")}
          </p>
        </CardHeader>
        <CardContent>
          {proposals.length === 0 ? (
            <PortalEmptyState icon={ShieldCheck} title={t("portalAutomation.operations.emptyReviews")} />
          ) : (
            <div className="space-y-3">
              {proposals.map((proposal) => {
                const decision = proposal.decision ?? {};
                return (
                  <div key={proposal.id} className="rounded-lg border p-4">
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
                      <div className="min-w-0 flex-1 space-y-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">
                            {t("portalAutomation.operations.applicationLabel")} #{proposal.applicationId}
                          </span>
                          <Badge variant="outline">{decision.disposition ?? decision.signal ?? "UNKNOWN"}</Badge>
                          <Badge variant="secondary">{decision.action ?? "manual_review"}</Badge>
                          {decision.requiredArtifact && (
                            <Badge variant={decision.artifactVerified ? "secondary" : "destructive"}>
                              {decision.requiredArtifact}
                            </Badge>
                          )}
                        </div>
                        <div className="grid gap-2 text-sm sm:grid-cols-2 xl:grid-cols-4">
                          <div>
                            <p className="text-xs text-muted-foreground">{t("portalAutomation.operations.portalStatus")}</p>
                            <p className="font-medium">{proposal.rawStatus}</p>
                          </div>
                          <div>
                            <p className="text-xs text-muted-foreground">{t("portalAutomation.operations.stageChange")}</p>
                            <p className="font-medium">{proposal.currentStage} → {decision.targetStage ?? "—"}</p>
                          </div>
                          <div>
                            <p className="text-xs text-muted-foreground">{t("portalAutomation.operations.missingDocuments")}</p>
                            <p className="font-medium">{proposal.missingDocuments?.length ?? 0}</p>
                          </div>
                          <div>
                            <p className="text-xs text-muted-foreground">{t("portalAutomation.operations.createdAt")}</p>
                            <p className="font-medium">{time(proposal.createdAt)}</p>
                          </div>
                        </div>
                        <p className="text-sm text-muted-foreground">{decision.reason ?? "—"}</p>
                        {proposal.missingDocuments?.length > 0 && (
                          <div className="flex flex-wrap gap-1.5">
                            {proposal.missingDocuments.map((document, index) => (
                              <Badge key={`${document.code ?? document.label}-${index}`} variant="outline" className="gap-1">
                                <FileWarning className="size-3" />{document.label}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="flex shrink-0 gap-2">
                        <Button variant="outline" size="sm" onClick={() => openReview(proposal, "reject")}>
                          {t("portalAutomation.operations.reject")}
                        </Button>
                        <Button size="sm" onClick={() => openReview(proposal, "approve")}>
                          {t("portalAutomation.operations.approve")}
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t("portalAutomation.operations.observationsTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          {data.recentObservations.length === 0 ? (
            <PortalEmptyState icon={Activity} title={t("portalAutomation.operations.emptyObservations")} />
          ) : (
            <div className="space-y-2">
              {data.recentObservations.map((observation) => (
                <div key={observation.id} className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">#{observation.applicationId} · {observation.universityKey}</span>
                      <Badge variant="outline">{observation.disposition}</Badge>
                      {observation.identityVerified ? (
                        <Badge className="gap-1 bg-emerald-100 text-emerald-700 hover:bg-emerald-100"><CheckCircle2 className="size-3" />{t("portalAutomation.operations.verified")}</Badge>
                      ) : (
                        <Badge variant="destructive" className="gap-1"><AlertTriangle className="size-3" />{t("portalAutomation.operations.unverified")}</Badge>
                      )}
                      {number(observation.missingDocumentCount) > 0 && (
                        <Badge variant="secondary" className="gap-1"><FileWarning className="size-3" />{observation.missingDocumentCount}</Badge>
                      )}
                    </div>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">{time(observation.observedAt)}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={reviewChoice !== null}
        onOpenChange={(open) => {
          if (!open && !reviewing) setReviewChoice(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {reviewChoice?.decision === "approve"
                ? t("portalAutomation.operations.approveTitle")
                : t("portalAutomation.operations.rejectTitle")}
            </DialogTitle>
            <DialogDescription>
              {t("portalAutomation.operations.reviewConfirmation", {
                applicationId: String(reviewChoice?.proposal.applicationId ?? ""),
              })}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={reviewReason}
            onChange={(event) => setReviewReason(event.target.value)}
            maxLength={1000}
            rows={4}
            placeholder={t("portalAutomation.operations.reviewReasonPlaceholder")}
            disabled={reviewing}
          />
          <p className="text-xs text-muted-foreground">
            {t("portalAutomation.operations.reviewSafetyNote")}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReviewChoice(null)} disabled={reviewing}>
              {t("portalAutomation.operations.reviewCancel")}
            </Button>
            <Button
              variant={reviewChoice?.decision === "reject" ? "destructive" : "default"}
              onClick={() => void submitReview()}
              disabled={reviewing}
              className="gap-1.5"
            >
              {reviewing && <Loader2 className="size-4 animate-spin" />}
              {reviewChoice?.decision === "approve"
                ? t("portalAutomation.operations.approve")
                : t("portalAutomation.operations.reject")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
