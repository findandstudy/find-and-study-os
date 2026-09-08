import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Pause,
  Play,
  Plus,
  Square,
  WalletCards,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";

type AdvertisingGate = {
  enabled: boolean;
  workerEnabled: boolean;
  connectivityEnabled: boolean;
  providerAdvertisingEnabled: boolean;
  allowedProviders: string[];
  maximumCampaignBudgetMinor: number | null;
  reason: string | null;
};

type AdCampaign = {
  id: string;
  account_id: string;
  brief_id: string;
  account_name: string;
  provider: string;
  name: string;
  objective: string;
  destination_url: string;
  country_codes: string[];
  language_codes: string[];
  age_min: number;
  age_max: number;
  currency_code: string;
  current_daily_budget_minor: string | number;
  current_lifetime_budget_minor: string | number;
  starts_at: string;
  ends_at: string;
  status: string;
  last_error_code: string | null;
  created_by_legacy_user_id: number;
  approved_by_legacy_user_id: number | null;
  latest_operation_id: string;
  latest_operation_type: string;
  latest_operation_status: string;
  latest_operation_creator: number;
  created_at: string;
  updated_at: string;
};

type SocialAccountOption = {
  id: string;
  provider: string;
  display_name: string;
  account_kind: string;
  currency_code: string | null;
  status: string;
};

type SocialBriefOption = {
  id: string;
  title: string;
  content_kind: string;
  status: string;
};

function requestKey(prefix: string): string {
  return `${prefix}:${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

function isoFromLocal(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("invalid date");
  return date.toISOString();
}

function formattedDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "—";
}

function money(minor: string | number, currency: string): string {
  const amount = Number(minor) / 100;
  if (!Number.isFinite(amount)) return "—";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function tone(status: string): string {
  if (["ACTIVE", "APPLIED"].includes(status))
    return "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300";
  if (["FAILED", "DEAD_LETTER", "REJECTED"].includes(status))
    return "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300";
  if (["PENDING_APPROVAL", "APPROVED", "PROVISIONING"].includes(status))
    return "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300";
  return "bg-slate-100 text-slate-700 dark:bg-slate-900 dark:text-slate-300";
}

export default function SocialAdvertisingPanel({
  tr,
  canManage,
  canApprove,
  userId,
  accounts,
  briefs,
}: {
  tr: boolean;
  canManage: boolean;
  canApprove: boolean;
  userId: number;
  accounts: SocialAccountOption[];
  briefs: SocialBriefOption[];
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [budgetCampaign, setBudgetCampaign] = useState<AdCampaign | null>(null);
  const [rejectOperation, setRejectOperation] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState("");
  const [form, setForm] = useState({
    accountId: "",
    briefId: "",
    name: "",
    objective: "LEADS",
    destinationUrl: "https://findandstudy.com/",
    countryCodes: "TR",
    languageCodes: "tr",
    ageMin: 18,
    ageMax: 45,
    dailyBudgetMinor: 1000,
    lifetimeBudgetMinor: 10000,
    startsAt: "",
    endsAt: "",
  });
  const [budgetForm, setBudgetForm] = useState({
    dailyBudgetMinor: 1000,
    lifetimeBudgetMinor: 10000,
  });

  const eligibleAccounts = useMemo(
    () =>
      accounts.filter(
        (account) =>
          account.account_kind === "AD_ACCOUNT" &&
          account.status === "VERIFIED" &&
          account.currency_code,
      ),
    [accounts],
  );
  const eligibleBriefs = useMemo(
    () =>
      briefs.filter(
        (brief) =>
          brief.content_kind === "AD_CREATIVE" && brief.status === "APPROVED",
      ),
    [briefs],
  );
  const campaigns = useQuery<{
    data: AdCampaign[];
    advertisingGate: AdvertisingGate;
  }>({
    queryKey: ["social-operations", "ad-campaigns"],
    queryFn: () => customFetch("/api/social/ad-campaigns?limit=100"),
    retry: false,
  });

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ["social-operations", "ad-campaigns"],
      }),
      queryClient.invalidateQueries({
        queryKey: ["social-operations", "overview"],
      }),
    ]);
  };

  const createCampaign = useMutation({
    mutationFn: () =>
      customFetch("/api/social/ad-campaigns", {
        method: "POST",
        body: JSON.stringify({
          requestKey: requestKey("social-ad-create"),
          accountId: form.accountId,
          briefId: form.briefId,
          name: form.name,
          objective: form.objective,
          destinationUrl: form.destinationUrl,
          countryCodes: form.countryCodes
            .split(",")
            .map((value) => value.trim().toUpperCase())
            .filter(Boolean),
          languageCodes: form.languageCodes
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
          ageMin: Number(form.ageMin),
          ageMax: Number(form.ageMax),
          currencyCode:
            eligibleAccounts.find((account) => account.id === form.accountId)
              ?.currency_code ?? "",
          dailyBudgetMinor: Number(form.dailyBudgetMinor),
          lifetimeBudgetMinor: Number(form.lifetimeBudgetMinor),
          startsAt: isoFromLocal(form.startsAt),
          endsAt: isoFromLocal(form.endsAt),
          maxAttempts: 5,
        }),
      }),
    onSuccess: async () => {
      setCreateOpen(false);
      await invalidate();
      toast({
        title: tr ? "Kampanya onaya gönderildi" : "Campaign sent for approval",
        description: tr
          ? "İlk çalıştırma kampanyayı PAUSED olarak oluşturur; harcama için ayrıca RESUME onayı gerekir."
          : "The first execution creates the campaign PAUSED; spending requires a separate RESUME approval.",
      });
    },
    onError: (error) =>
      toast({
        variant: "destructive",
        title: tr ? "Kampanya oluşturulamadı" : "Campaign could not be created",
        description: error instanceof Error ? error.message : undefined,
      }),
  });

  const createAction = useMutation({
    mutationFn: ({
      campaignId,
      action,
      dailyBudgetMinor,
      lifetimeBudgetMinor,
    }: {
      campaignId: string;
      action: "PAUSE" | "RESUME" | "UPDATE_BUDGET" | "END";
      dailyBudgetMinor?: number;
      lifetimeBudgetMinor?: number;
    }) =>
      customFetch(`/api/social/ad-campaigns/${campaignId}/actions`, {
        method: "POST",
        body: JSON.stringify({
          requestKey: requestKey(`social-ad-${action.toLowerCase()}`),
          action,
          dailyBudgetMinor,
          lifetimeBudgetMinor,
          maxAttempts: 5,
        }),
      }),
    onSuccess: async () => {
      setBudgetCampaign(null);
      await invalidate();
      toast({
        title: tr ? "İşlem onaya gönderildi" : "Operation sent for approval",
      });
    },
    onError: (error) =>
      toast({
        variant: "destructive",
        title: tr ? "İşlem oluşturulamadı" : "Operation could not be created",
        description: error instanceof Error ? error.message : undefined,
      }),
  });

  const review = useMutation({
    mutationFn: ({
      operationId,
      decision,
      reason,
    }: {
      operationId: string;
      decision: "APPROVE" | "REJECT";
      reason?: string;
    }) =>
      customFetch(`/api/social/ad-operations/${operationId}/review`, {
        method: "POST",
        body: JSON.stringify({
          requestKey: requestKey("social-ad-review"),
          decision,
          reason,
        }),
      }),
    onSuccess: async () => {
      setRejectOperation(null);
      setRejectionReason("");
      await invalidate();
      toast({ title: tr ? "Karar kaydedildi" : "Decision recorded" });
    },
    onError: (error) =>
      toast({
        variant: "destructive",
        title: tr ? "Karar kaydedilemedi" : "Decision could not be recorded",
        description: error instanceof Error ? error.message : undefined,
      }),
  });

  const gate = campaigns.data?.advertisingGate;
  const selectedAccount = eligibleAccounts.find(
    (account) => account.id === form.accountId,
  );
  const maximumBudget = gate?.maximumCampaignBudgetMinor ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">
            {tr ? "Reklam Kontrol Merkezi" : "Advertising Control Center"}
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            {tr
              ? "Kampanya oluşturma, bütçe değişikliği, durdurma ve yeniden başlatma işlemlerini iki aşamalı onay ve sağlayıcı makbuzuyla yönetir."
              : "Manages campaign creation, budget changes, pause and resume with two-person approval and provider receipts."}
          </p>
        </div>
        <Button
          onClick={() => {
            setForm((current) => ({
              ...current,
              accountId: current.accountId || eligibleAccounts[0]?.id || "",
              briefId: current.briefId || eligibleBriefs[0]?.id || "",
            }));
            setCreateOpen(true);
          }}
          disabled={
            !canManage ||
            eligibleAccounts.length === 0 ||
            eligibleBriefs.length === 0
          }
        >
          <Plus className="mr-2 size-4" />
          {tr ? "Yeni reklam kampanyası" : "New ad campaign"}
        </Button>
      </div>

      <div className="flex items-start gap-2 rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-200">
        <WalletCards className="mt-0.5 size-4 shrink-0" />
        <span>
          {gate?.enabled
            ? tr
              ? `Dış reklam işlemleri açık. Kampanya başına hard üst sınır ${maximumBudget} minor unit.`
              : `External ad execution is enabled. Hard per-campaign cap: ${maximumBudget} minor units.`
            : tr
              ? `Dış reklam işlemleri kapalı (${gate?.reason ?? "SOCIAL_AD_WORKER_DISABLED"}). Plan ve onay kayıtları oluşturulabilir; provider çağrısı yapılmaz.`
              : `External ad execution is disabled (${gate?.reason ?? "SOCIAL_AD_WORKER_DISABLED"}). Plans and approvals can be recorded without provider calls.`}
        </span>
      </div>

      {(eligibleAccounts.length === 0 || eligibleBriefs.length === 0) && (
        <Card className="border-amber-300 dark:border-amber-900">
          <CardContent className="flex items-start gap-3 p-4">
            <AlertTriangle className="mt-0.5 size-5 text-amber-600" />
            <p className="text-sm">
              {tr
                ? "Kampanya için VERIFIED bir AD_ACCOUNT ve onaylanmış AD_CREATIVE brief gerekir."
                : "Campaigns require a VERIFIED AD_ACCOUNT and an approved AD_CREATIVE brief."}
            </p>
          </CardContent>
        </Card>
      )}

      {campaigns.isLoading ? (
        <div className="h-48 animate-pulse rounded-xl bg-muted" />
      ) : campaigns.isError ? (
        <Card>
          <CardContent className="p-5 text-sm text-destructive">
            {tr
              ? "Reklam kampanyaları yüklenemedi."
              : "Ad campaigns could not be loaded."}
          </CardContent>
        </Card>
      ) : (campaigns.data?.data ?? []).length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            {tr ? "Henüz reklam kampanyası yok." : "No ad campaigns yet."}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 xl:grid-cols-2">
          {(campaigns.data?.data ?? []).map((campaign) => {
            const pendingReview =
              campaign.latest_operation_status === "PENDING_APPROVAL";
            const canReview =
              canApprove &&
              pendingReview &&
              campaign.latest_operation_creator !== userId;
            return (
              <Card key={campaign.id}>
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <CardTitle className="text-base">
                        {campaign.name}
                      </CardTitle>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {campaign.provider} · {campaign.account_name} ·{" "}
                        {campaign.objective}
                      </p>
                    </div>
                    <Badge className={tone(campaign.status)}>
                      {campaign.status}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <div className="grid grid-cols-2 gap-2 rounded-lg bg-muted/50 p-3">
                    <div>
                      <p className="text-xs text-muted-foreground">
                        {tr ? "Günlük" : "Daily"}
                      </p>
                      <p className="font-medium">
                        {money(
                          campaign.current_daily_budget_minor,
                          campaign.currency_code,
                        )}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">
                        {tr ? "Toplam sınır" : "Lifetime cap"}
                      </p>
                      <p className="font-medium">
                        {money(
                          campaign.current_lifetime_budget_minor,
                          campaign.currency_code,
                        )}
                      </p>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {campaign.country_codes.join(", ")} · {campaign.age_min}–
                    {campaign.age_max} · {formattedDate(campaign.starts_at)} →{" "}
                    {formattedDate(campaign.ends_at)}
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">
                      {campaign.latest_operation_type}:{" "}
                      {campaign.latest_operation_status}
                    </Badge>
                    {canReview && (
                      <>
                        <Button
                          size="sm"
                          onClick={() =>
                            review.mutate({
                              operationId: campaign.latest_operation_id,
                              decision: "APPROVE",
                            })
                          }
                          disabled={review.isPending}
                        >
                          <CheckCircle2 className="mr-1 size-3.5" />
                          {tr ? "Onayla" : "Approve"}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            setRejectOperation(campaign.latest_operation_id)
                          }
                        >
                          {tr ? "Reddet" : "Reject"}
                        </Button>
                      </>
                    )}
                    {!pendingReview &&
                      canManage &&
                      campaign.status === "ACTIVE" && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            createAction.mutate({
                              campaignId: campaign.id,
                              action: "PAUSE",
                            })
                          }
                        >
                          <Pause className="mr-1 size-3.5" />{" "}
                          {tr ? "Durdur" : "Pause"}
                        </Button>
                      )}
                    {!pendingReview &&
                      canManage &&
                      campaign.status === "PAUSED" && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            createAction.mutate({
                              campaignId: campaign.id,
                              action: "RESUME",
                            })
                          }
                        >
                          <Play className="mr-1 size-3.5" />{" "}
                          {tr ? "Başlat" : "Resume"}
                        </Button>
                      )}
                    {!pendingReview &&
                      canManage &&
                      ["ACTIVE", "PAUSED"].includes(campaign.status) && (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setBudgetForm({
                                dailyBudgetMinor: Number(
                                  campaign.current_daily_budget_minor,
                                ),
                                lifetimeBudgetMinor: Number(
                                  campaign.current_lifetime_budget_minor,
                                ),
                              });
                              setBudgetCampaign(campaign);
                            }}
                          >
                            <WalletCards className="mr-1 size-3.5" />{" "}
                            {tr ? "Bütçe" : "Budget"}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              createAction.mutate({
                                campaignId: campaign.id,
                                action: "END",
                              })
                            }
                          >
                            <Square className="mr-1 size-3.5" />{" "}
                            {tr ? "Sonlandır" : "End"}
                          </Button>
                        </>
                      )}
                  </div>
                  {campaign.last_error_code && (
                    <p className="text-xs text-destructive">
                      {campaign.last_error_code}
                    </p>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {tr ? "Reklam kampanyası oluştur" : "Create ad campaign"}
            </DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-2 sm:grid-cols-2">
            <div>
              <Label>{tr ? "Reklam hesabı" : "Ad account"}</Label>
              <select
                className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={form.accountId}
                onChange={(event) =>
                  setForm({ ...form, accountId: event.target.value })
                }
              >
                <option value="">—</option>
                {eligibleAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.display_name} ({account.currency_code})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label>AD_CREATIVE</Label>
              <select
                className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={form.briefId}
                onChange={(event) =>
                  setForm({ ...form, briefId: event.target.value })
                }
              >
                <option value="">—</option>
                {eligibleBriefs.map((brief) => (
                  <option key={brief.id} value={brief.id}>
                    {brief.title}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label>{tr ? "Kampanya adı" : "Campaign name"}</Label>
              <Input
                className="mt-1"
                value={form.name}
                onChange={(event) =>
                  setForm({ ...form, name: event.target.value })
                }
              />
            </div>
            <div>
              <Label>{tr ? "Amaç" : "Objective"}</Label>
              <select
                className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={form.objective}
                onChange={(event) =>
                  setForm({ ...form, objective: event.target.value })
                }
              >
                {[
                  "AWARENESS",
                  "TRAFFIC",
                  "LEADS",
                  "CONVERSIONS",
                  "VIDEO_VIEWS",
                ].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-2">
              <Label>{tr ? "Hedef bağlantı" : "Destination URL"}</Label>
              <Input
                className="mt-1"
                type="url"
                value={form.destinationUrl}
                onChange={(event) =>
                  setForm({ ...form, destinationUrl: event.target.value })
                }
              />
            </div>
            <div>
              <Label>{tr ? "Ülkeler" : "Countries"}</Label>
              <Input
                className="mt-1"
                value={form.countryCodes}
                onChange={(event) =>
                  setForm({ ...form, countryCodes: event.target.value })
                }
                placeholder="TR, DE"
              />
            </div>
            <div>
              <Label>{tr ? "Diller" : "Languages"}</Label>
              <Input
                className="mt-1"
                value={form.languageCodes}
                onChange={(event) =>
                  setForm({ ...form, languageCodes: event.target.value })
                }
                placeholder="tr, en"
              />
            </div>
            <div>
              <Label>{tr ? "Minimum yaş" : "Minimum age"}</Label>
              <Input
                className="mt-1"
                type="number"
                min={18}
                max={65}
                value={form.ageMin}
                onChange={(event) =>
                  setForm({ ...form, ageMin: Number(event.target.value) })
                }
              />
            </div>
            <div>
              <Label>{tr ? "Maksimum yaş" : "Maximum age"}</Label>
              <Input
                className="mt-1"
                type="number"
                min={18}
                max={65}
                value={form.ageMax}
                onChange={(event) =>
                  setForm({ ...form, ageMax: Number(event.target.value) })
                }
              />
            </div>
            <div>
              <Label>
                {tr ? "Günlük bütçe (minor unit)" : "Daily budget (minor unit)"}
              </Label>
              <Input
                className="mt-1"
                type="number"
                min={1}
                value={form.dailyBudgetMinor}
                onChange={(event) =>
                  setForm({
                    ...form,
                    dailyBudgetMinor: Number(event.target.value),
                  })
                }
              />
            </div>
            <div>
              <Label>
                {tr
                  ? "Toplam bütçe (minor unit)"
                  : "Lifetime budget (minor unit)"}
              </Label>
              <Input
                className="mt-1"
                type="number"
                min={1}
                max={maximumBudget || undefined}
                value={form.lifetimeBudgetMinor}
                onChange={(event) =>
                  setForm({
                    ...form,
                    lifetimeBudgetMinor: Number(event.target.value),
                  })
                }
              />
            </div>
            <div>
              <Label>{tr ? "Başlangıç" : "Starts at"}</Label>
              <Input
                className="mt-1"
                type="datetime-local"
                value={form.startsAt}
                onChange={(event) =>
                  setForm({ ...form, startsAt: event.target.value })
                }
              />
            </div>
            <div>
              <Label>{tr ? "Bitiş" : "Ends at"}</Label>
              <Input
                className="mt-1"
                type="datetime-local"
                value={form.endsAt}
                onChange={(event) =>
                  setForm({ ...form, endsAt: event.target.value })
                }
              />
            </div>
            <p className="sm:col-span-2 text-xs text-muted-foreground">
              {tr
                ? `Para birimi reklam hesabından gelir: ${selectedAccount?.currency_code ?? "—"}. CREATE işlemi harcama başlatmaz; kampanya sağlayıcıda PAUSED açılır.`
                : `Currency comes from the ad account: ${selectedAccount?.currency_code ?? "—"}. CREATE never starts spending; the provider campaign is provisioned PAUSED.`}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              {tr ? "İptal" : "Cancel"}
            </Button>
            <Button
              disabled={
                createCampaign.isPending ||
                !form.accountId ||
                !form.briefId ||
                !form.name ||
                !form.startsAt ||
                !form.endsAt
              }
              onClick={() => createCampaign.mutate()}
            >
              {createCampaign.isPending && (
                <Loader2 className="mr-2 size-4 animate-spin" />
              )}
              {tr ? "Onaya gönder" : "Send for approval"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(budgetCampaign)}
        onOpenChange={(open) => !open && setBudgetCampaign(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {tr ? "Bütçe değişikliği" : "Budget change"}
            </DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-2 sm:grid-cols-2">
            <div>
              <Label>{tr ? "Günlük minor unit" : "Daily minor units"}</Label>
              <Input
                className="mt-1"
                type="number"
                min={1}
                value={budgetForm.dailyBudgetMinor}
                onChange={(event) =>
                  setBudgetForm({
                    ...budgetForm,
                    dailyBudgetMinor: Number(event.target.value),
                  })
                }
              />
            </div>
            <div>
              <Label>{tr ? "Toplam minor unit" : "Lifetime minor units"}</Label>
              <Input
                className="mt-1"
                type="number"
                min={1}
                max={maximumBudget || undefined}
                value={budgetForm.lifetimeBudgetMinor}
                onChange={(event) =>
                  setBudgetForm({
                    ...budgetForm,
                    lifetimeBudgetMinor: Number(event.target.value),
                  })
                }
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBudgetCampaign(null)}>
              {tr ? "İptal" : "Cancel"}
            </Button>
            <Button
              disabled={
                createAction.isPending ||
                budgetForm.lifetimeBudgetMinor < budgetForm.dailyBudgetMinor
              }
              onClick={() =>
                budgetCampaign &&
                createAction.mutate({
                  campaignId: budgetCampaign.id,
                  action: "UPDATE_BUDGET",
                  ...budgetForm,
                })
              }
            >
              {tr ? "Onaya gönder" : "Send for approval"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(rejectOperation)}
        onOpenChange={(open) => !open && setRejectOperation(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {tr ? "İşlemi reddet" : "Reject operation"}
            </DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <Label>{tr ? "Gerekçe" : "Reason"}</Label>
            <Textarea
              className="mt-1"
              value={rejectionReason}
              onChange={(event) => setRejectionReason(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectOperation(null)}>
              {tr ? "İptal" : "Cancel"}
            </Button>
            <Button
              variant="destructive"
              disabled={!rejectionReason.trim() || review.isPending}
              onClick={() =>
                rejectOperation &&
                review.mutate({
                  operationId: rejectOperation,
                  decision: "REJECT",
                  reason: rejectionReason.trim(),
                })
              }
            >
              {tr ? "Reddet" : "Reject"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
