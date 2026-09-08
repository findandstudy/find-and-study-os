import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { useAuth } from "@/hooks/use-auth";
import { useI18n } from "@/hooks/use-i18n";
import { useToast } from "@/hooks/use-toast";
import {
  uploadSocialMediaFile,
  type SocialMediaAsset,
} from "@/lib/uploadSocialMediaFile";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CalendarDays,
  CheckCircle2,
  Clock3,
  ExternalLink,
  FileText,
  Link2,
  Loader2,
  Paperclip,
  Plus,
  Send,
  Settings,
  ShieldCheck,
  Target,
  Trash2,
  Upload,
  Users,
  WandSparkles,
  WalletCards,
} from "lucide-react";
import SocialAdvertisingPanel from "./SocialAdvertisingPanel";

type SocialContext = {
  enabled: boolean;
  mode: "off" | "read" | "manage";
  reason?: string | null;
  publishingEnabled: boolean;
  publicationGate?: { reason: string | null; allowedProviders: string[] };
  performanceGate?: {
    enabled: boolean;
    workerEnabled: boolean;
    reason: string | null;
    allowedProviders: string[];
  };
  creativeGate?: {
    enabled: boolean;
    workerEnabled: boolean;
    generationEnabled: boolean;
    reason: string | null;
    allowedProviders: string[];
  };
  advertisingGate?: {
    enabled: boolean;
    workerEnabled: boolean;
    connectivityEnabled: boolean;
    providerAdvertisingEnabled: boolean;
    reason: string | null;
    allowedProviders: string[];
    maximumCampaignBudgetMinor: number | null;
  };
  providerConnectionGate?: {
    enabled: boolean;
    reason: string | null;
    allowedProviders: string[];
  };
  tenantId?: string;
  organizationId?: string;
};

type SocialBrief = {
  id: string;
  title: string;
  content_kind: string;
  channels: string[];
  locales: string[];
  media_refs: Array<{ kind: "image" | "video"; ref: string }>;
  tracking_key: string;
  status: "DRAFT" | "IN_REVIEW" | "APPROVED" | "REJECTED" | "ARCHIVED";
  scheduled_for: string | null;
  created_by_legacy_user_id: number;
  reviewed_by_legacy_user_id: number | null;
  created_at: string;
  updated_at: string;
};

type SocialOverview = {
  briefCounts: Array<{ status: string; count: number | string }>;
  accountCounts: Array<{ status: string; count: number | string }>;
  publicationCounts: Array<{ status: string; count: number | string }>;
  briefs: SocialBrief[];
  publishingEnabled: boolean;
  workerHealth: Array<{
    kind: "publication" | "performance" | "creative" | "advertising";
    expected: boolean;
    status: "DISABLED" | "READY" | "RELEASE_MISMATCH" | "STALE";
    activeWorkers: number;
    currentReleaseWorkers: number;
    lastSeenAt: string | null;
    reason: string | null;
  }>;
};

type SocialAccount = {
  id: string;
  provider: string;
  account_key: string;
  display_name: string;
  account_kind: "PROFILE" | "PAGE" | "CHANNEL" | "AD_ACCOUNT";
  currency_code: string | null;
  integration_key: string | null;
  status: string;
  verified_at: string | null;
  last_verification_at: string | null;
  last_verification_error_code: string | null;
  created_at: string;
  updated_at: string;
};

type SocialMetrics = Partial<
  Record<
    | "impressions"
    | "reach"
    | "views"
    | "engagements"
    | "reactions"
    | "comments"
    | "shares"
    | "saves"
    | "clicks"
    | "linkClicks"
    | "videoViews"
    | "watchTimeSeconds"
    | "followersGained"
    | "spendMinor"
    | "conversions"
    | "leads",
    number
  >
>;

type SocialPerformanceItem = {
  publication_id: string;
  title: string;
  provider: string;
  account_name: string;
  published_at: string;
  sync_status: string | null;
  next_sync_at: string | null;
  last_success_at: string | null;
  last_error_code: string | null;
  consecutive_failure_count: number | null;
  metrics: SocialMetrics | null;
  observed_at: string | null;
};

type SocialPerformanceResponse = {
  data: SocialPerformanceItem[];
  performanceWorkerEnabled: boolean;
  performanceGate?: {
    enabled: boolean;
    workerEnabled: boolean;
    reason: string | null;
    allowedProviders: string[];
  };
  providerConnectionGate: {
    enabled: boolean;
    reason: string | null;
    allowedProviders: string[];
  };
};

type SocialAttributionResponse = {
  period: { from: string; to: string };
  summary: {
    tracked_leads: number;
    converted_students: number;
    applications: number;
  };
  providerMetrics: {
    provider_clicks: string;
    provider_leads: string;
    provider_conversions: string;
  };
  applicationStages: Array<{ application_stage: string; count: number }>;
  spendByCurrency: Array<{ currency_code: string; spend_minor: string }>;
  briefs: Array<{
    brief_id: string;
    title: string;
    campaign_key: string | null;
    tracking_key: string;
    tracked_leads: number;
    converted_students: number;
    applications: number;
  }>;
};

type SocialCreativeRequest = {
  id: string;
  brief_id: string;
  brief_title: string;
  output_kind: "CAPTION" | "IMAGE" | "VIDEO";
  provider: string;
  integration_key: string;
  model: string | null;
  locale: string;
  prompt: string;
  negative_prompt: string | null;
  aspect_ratio: string | null;
  duration_seconds: number | null;
  max_cost_minor: number;
  currency_code: string;
  status: string;
  attempt_count: number;
  failure_count: number;
  max_attempts: number;
  next_attempt_at: string | null;
  result_caption: string | null;
  generated_asset_id: string | null;
  generated_asset_path: string | null;
  generated_asset_kind: "image" | "video" | null;
  resolved_model: string | null;
  usage: Record<string, number | string> | null;
  applied_at: string | null;
  last_error_code: string | null;
  created_by_legacy_user_id: number;
  approved_by_legacy_user_id: number | null;
  approved_at: string | null;
  rejection_reason: string | null;
  created_at: string;
  updated_at: string;
};

type SocialCreativeResponse = {
  data: SocialCreativeRequest[];
  creativeGate: NonNullable<SocialContext["creativeGate"]>;
};

type SocialPublication = {
  id: string;
  brief_id: string;
  account_id: string;
  title: string;
  content_kind: string;
  provider: string;
  account_name: string;
  scheduled_for: string;
  status: string;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string | null;
  last_error_code: string | null;
  published_at: string | null;
  created_by_legacy_user_id: number;
  approved_by_legacy_user_id: number | null;
};

type Integration = {
  key: string;
  name: string;
  category: string;
};

const CHANNELS = [
  "instagram",
  "facebook",
  "linkedin",
  "youtube",
  "tiktok",
  "x",
  "blog",
] as const;
const CONTENT_KINDS = [
  "POST",
  "STORY",
  "REEL",
  "VIDEO",
  "ARTICLE",
  "AD_CREATIVE",
] as const;

function numericCounts(
  rows: Array<{ status: string; count: number | string }>,
): Record<string, number> {
  return Object.fromEntries(
    rows.map((row) => [row.status, Number(row.count) || 0]),
  );
}

function statusTone(status: string): string {
  if (
    status === "APPROVED" ||
    status === "VERIFIED" ||
    status === "PUBLISHED" ||
    status === "GENERATED"
  )
    return "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300";
  if (
    status === "REJECTED" ||
    status === "FAILED" ||
    status === "DEAD_LETTER" ||
    status === "REAUTH_REQUIRED"
  )
    return "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300";
  if (status === "IN_REVIEW" || status === "PENDING_APPROVAL")
    return "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300";
  return "bg-slate-100 text-slate-700 dark:bg-slate-900 dark:text-slate-300";
}

function date(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString() : "—";
}

function metric(value: number | undefined): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(
    value ?? 0,
  );
}

function requestKey(prefix: string): string {
  return `${prefix}:${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

export default function SocialOperations() {
  const { user, hasPermission } = useAuth(true);
  const { lang } = useI18n();
  const tr = lang === "tr";
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [briefOpen, setBriefOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [publicationOpen, setPublicationOpen] = useState(false);
  const [creativeOpen, setCreativeOpen] = useState(false);
  const [briefMediaAssets, setBriefMediaAssets] = useState<SocialMediaAsset[]>(
    [],
  );
  const [mediaUploading, setMediaUploading] = useState(false);
  const [briefForm, setBriefForm] = useState({
    title: "",
    objective: "",
    audience: "",
    contentKind: "POST",
    locales: "tr,en",
    channels: ["instagram"] as string[],
    campaignKey: "",
    caption: "",
    scheduledFor: "",
    utmCampaign: "",
  });
  const [accountForm, setAccountForm] = useState({
    provider: "meta",
    accountKey: "",
    displayName: "",
    accountKind: "PROFILE" as
      | "PROFILE"
      | "PAGE"
      | "CHANNEL"
      | "AD_ACCOUNT",
    currencyCode: "",
    integrationKey: "",
    externalAccountRef: "",
  });
  const [publicationForm, setPublicationForm] = useState({
    briefId: "",
    accountId: "",
    scheduledFor: "",
    maxAttempts: 5,
  });
  const [creativeForm, setCreativeForm] = useState({
    briefId: "",
    outputKind: "CAPTION" as "CAPTION" | "IMAGE" | "VIDEO",
    provider: "anthropic",
    integrationKey: "",
    model: "",
    locale: "tr",
    prompt: "",
    negativePrompt: "",
    aspectRatio: "1:1" as "1:1" | "4:5" | "9:16" | "16:9",
    durationSeconds: 10,
    maxCostMinor: 100,
    currencyCode: "USD",
    maxAttempts: 3,
  });

  const context = useQuery<SocialContext>({
    queryKey: ["social-operations", "context"],
    queryFn: () => customFetch("/api/social/context"),
    retry: false,
  });
  const enabled = context.data?.enabled === true;
  const overview = useQuery<SocialOverview>({
    queryKey: ["social-operations", "overview"],
    queryFn: () => customFetch("/api/social/overview"),
    enabled,
    retry: false,
  });
  const accounts = useQuery<{ data: SocialAccount[] }>({
    queryKey: ["social-operations", "accounts"],
    queryFn: () => customFetch("/api/social/accounts"),
    enabled,
    retry: false,
  });
  const publications = useQuery<{ data: SocialPublication[] }>({
    queryKey: ["social-operations", "publications"],
    queryFn: () => customFetch("/api/social/publications?limit=100"),
    enabled,
    retry: false,
  });
  const performance = useQuery<SocialPerformanceResponse>({
    queryKey: ["social-operations", "performance"],
    queryFn: () => customFetch("/api/social/performance?limit=100"),
    enabled,
    retry: false,
  });
  const attribution = useQuery<SocialAttributionResponse>({
    queryKey: ["social-operations", "attribution"],
    queryFn: () => customFetch("/api/social/attribution?limit=100"),
    enabled,
    retry: false,
  });
  const creatives = useQuery<SocialCreativeResponse>({
    queryKey: ["social-operations", "creative-requests"],
    queryFn: () => customFetch("/api/social/creative-requests?limit=100"),
    enabled,
    retry: false,
  });
  const creativeIntegrations = useQuery<{ data: Integration[] }>({
    queryKey: ["social-operations", "creative-integrations"],
    queryFn: () => customFetch("/api/social/creative-integrations"),
    enabled,
    retry: false,
  });
  const accountIntegrations = useQuery<{ data: Integration[] }>({
    queryKey: ["social-operations", "account-integrations"],
    queryFn: () => customFetch("/api/social/account-integrations"),
    enabled,
    retry: false,
  });

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ["social-operations", "overview"],
      }),
      queryClient.invalidateQueries({
        queryKey: ["social-operations", "accounts"],
      }),
      queryClient.invalidateQueries({
        queryKey: ["social-operations", "publications"],
      }),
      queryClient.invalidateQueries({
        queryKey: ["social-operations", "performance"],
      }),
      queryClient.invalidateQueries({
        queryKey: ["social-operations", "attribution"],
      }),
      queryClient.invalidateQueries({
        queryKey: ["social-operations", "creative-requests"],
      }),
    ]);
  };

  const createBrief = useMutation({
    mutationFn: () =>
      customFetch("/api/social/briefs", {
        method: "POST",
        body: JSON.stringify({
          requestKey: requestKey("social-brief-create"),
          title: briefForm.title,
          objective: briefForm.objective,
          audience: briefForm.audience,
          contentKind: briefForm.contentKind,
          locales: briefForm.locales
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
          channels: briefForm.channels,
          campaignKey: briefForm.campaignKey.trim() || undefined,
          caption: briefForm.caption || undefined,
          mediaAssetIds: briefMediaAssets.map((asset) => asset.id),
          scheduledFor: briefForm.scheduledFor
            ? new Date(briefForm.scheduledFor).toISOString()
            : undefined,
          utm: {
            source: briefForm.channels[0] || "social",
            medium: "social",
            campaign: briefForm.utmCampaign.trim() || undefined,
          },
        }),
      }),
    onSuccess: async () => {
      setBriefOpen(false);
      setBriefMediaAssets([]);
      setBriefForm((current) => ({
        ...current,
        title: "",
        objective: "",
        audience: "",
        caption: "",
        campaignKey: "",
        scheduledFor: "",
        utmCampaign: "",
      }));
      await invalidate();
      toast({
        title: tr ? "İçerik brief'i oluşturuldu" : "Content brief created",
      });
    },
    onError: (error) =>
      toast({
        title: tr ? "Brief oluşturulamadı" : "Brief could not be created",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      }),
  });

  const uploadBriefMedia = async (files: FileList | null) => {
    if (!files?.length) return;
    const available = 10 - briefMediaAssets.length;
    if (files.length > available) {
      toast({
        title: tr ? "En fazla 10 medya dosyası" : "Maximum 10 media files",
        variant: "destructive",
      });
      return;
    }
    setMediaUploading(true);
    const uploaded = [...briefMediaAssets];
    try {
      for (const file of Array.from(files)) {
        const asset = await uploadSocialMediaFile(
          file,
          requestKey("social-media-register"),
        );
        uploaded.push(asset);
        setBriefMediaAssets([...uploaded]);
      }
      toast({
        title: tr ? "Medya güvenle eklendi" : "Media attached securely",
      });
    } catch (error) {
      toast({
        title: tr ? "Medya yüklenemedi" : "Media upload failed",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    } finally {
      setMediaUploading(false);
    }
  };

  const createAccount = useMutation({
    mutationFn: () =>
      customFetch("/api/social/accounts", {
        method: "POST",
        body: JSON.stringify({
          requestKey: requestKey("social-account-create"),
          provider: accountForm.provider,
          accountKey: accountForm.accountKey,
          displayName: accountForm.displayName,
          accountKind: accountForm.accountKind,
          currencyCode:
            accountForm.accountKind === "AD_ACCOUNT"
              ? accountForm.currencyCode.toUpperCase()
              : undefined,
          integrationKey: accountForm.integrationKey || undefined,
          externalAccountRef: accountForm.externalAccountRef || undefined,
        }),
      }),
    onSuccess: async () => {
      setAccountOpen(false);
      setAccountForm({
        provider: "meta",
        accountKey: "",
        displayName: "",
        accountKind: "PROFILE",
        currencyCode: "",
        integrationKey: "",
        externalAccountRef: "",
      });
      await invalidate();
      toast({
        title: tr
          ? "Hesap kaydı eklendi; doğrulama bekliyor"
          : "Account registered; verification is pending",
      });
    },
    onError: (error) =>
      toast({
        title: tr ? "Hesap eklenemedi" : "Account could not be added",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      }),
  });

  const verifyAccount = useMutation({
    mutationFn: (id: string) =>
      customFetch(`/api/social/accounts/${id}/verify`, {
        method: "POST",
        body: JSON.stringify({
          requestKey: requestKey("social-account-verify"),
        }),
      }),
    onSuccess: async () => {
      await invalidate();
      toast({
        title: tr
          ? "Hesap bağlantı doğrulaması tamamlandı"
          : "Account connection verification completed",
      });
    },
    onError: (error) =>
      toast({
        title: tr
          ? "Hesap bağlantısı doğrulanamadı"
          : "Account connection could not be verified",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      }),
  });

  const submitBrief = useMutation({
    mutationFn: (id: string) =>
      customFetch(`/api/social/briefs/${id}/submit`, {
        method: "POST",
        body: JSON.stringify({ requestKey: requestKey("social-brief-submit") }),
      }),
    onSuccess: invalidate,
    onError: (error) =>
      toast({
        title: tr ? "Onaya gönderilemedi" : "Could not submit for review",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      }),
  });

  const createPublication = useMutation({
    mutationFn: () =>
      customFetch("/api/social/publications", {
        method: "POST",
        body: JSON.stringify({
          briefId: publicationForm.briefId,
          accountId: publicationForm.accountId,
          scheduledFor: publicationForm.scheduledFor
            ? new Date(publicationForm.scheduledFor).toISOString()
            : new Date().toISOString(),
          maxAttempts: publicationForm.maxAttempts,
          requestKey: requestKey("social-publication-create"),
        }),
      }),
    onSuccess: async () => {
      setPublicationOpen(false);
      setPublicationForm({
        briefId: "",
        accountId: "",
        scheduledFor: "",
        maxAttempts: 5,
      });
      await invalidate();
      toast({
        title: tr ? "Yayın taslağı oluşturuldu" : "Publication draft created",
      });
    },
    onError: (error) =>
      toast({
        title: tr
          ? "Yayın taslağı oluşturulamadı"
          : "Publication draft could not be created",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      }),
  });

  const submitPublication = useMutation({
    mutationFn: (id: string) =>
      customFetch(`/api/social/publications/${id}/submit`, {
        method: "POST",
        body: JSON.stringify({
          requestKey: requestKey("social-publication-submit"),
        }),
      }),
    onSuccess: invalidate,
    onError: (error) =>
      toast({
        title: tr
          ? "Yayın onaya gönderilemedi"
          : "Publication could not be submitted",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      }),
  });

  const reviewPublication = useMutation({
    mutationFn: ({
      id,
      decision,
    }: {
      id: string;
      decision: "APPROVE" | "REJECT";
    }) =>
      customFetch(`/api/social/publications/${id}/review`, {
        method: "POST",
        body: JSON.stringify({
          decision,
          requestKey: requestKey("social-publication-review"),
        }),
      }),
    onSuccess: invalidate,
    onError: (error) =>
      toast({
        title: tr
          ? "Yayın kararı kaydedilemedi"
          : "Publication decision could not be saved",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      }),
  });

  const cancelPublication = useMutation({
    mutationFn: (id: string) =>
      customFetch(`/api/social/publications/${id}/cancel`, {
        method: "POST",
        body: JSON.stringify({
          requestKey: requestKey("social-publication-cancel"),
        }),
      }),
    onSuccess: invalidate,
    onError: (error) =>
      toast({
        title: tr
          ? "Yayın iptal edilemedi"
          : "Publication could not be canceled",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      }),
  });

  const requestPerformanceSync = useMutation({
    mutationFn: (id: string) =>
      customFetch(`/api/social/performance/${id}/sync`, {
        method: "POST",
        body: JSON.stringify({
          requestKey: requestKey("social-performance-sync"),
        }),
      }),
    onSuccess: async () => {
      await invalidate();
      toast({
        title: tr
          ? "Performans yenileme kuyruğa alındı"
          : "Performance refresh queued",
      });
    },
    onError: (error) =>
      toast({
        title: tr
          ? "Performans yenileme başlatılamadı"
          : "Performance refresh could not be started",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      }),
  });

  const reviewBrief = useMutation({
    mutationFn: ({
      id,
      decision,
    }: {
      id: string;
      decision: "APPROVE" | "REJECT";
    }) =>
      customFetch(`/api/social/briefs/${id}/review`, {
        method: "POST",
        body: JSON.stringify({
          decision,
          requestKey: requestKey("social-review"),
        }),
      }),
    onSuccess: invalidate,
    onError: (error) =>
      toast({
        title: tr ? "İnceleme kaydedilemedi" : "Review could not be saved",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      }),
  });

  const createCreative = useMutation({
    mutationFn: () =>
      customFetch("/api/social/creative-requests", {
        method: "POST",
        body: JSON.stringify({
          requestKey: requestKey("social-creative-create"),
          briefId: creativeForm.briefId,
          outputKind: creativeForm.outputKind,
          provider: creativeForm.provider,
          integrationKey: creativeForm.integrationKey,
          model: creativeForm.model.trim() || undefined,
          locale: creativeForm.locale,
          prompt: creativeForm.prompt,
          negativePrompt:
            creativeForm.outputKind === "CAPTION"
              ? undefined
              : creativeForm.negativePrompt.trim() || undefined,
          aspectRatio:
            creativeForm.outputKind === "CAPTION"
              ? undefined
              : creativeForm.aspectRatio,
          durationSeconds:
            creativeForm.outputKind === "VIDEO"
              ? creativeForm.durationSeconds
              : undefined,
          maxCostMinor: creativeForm.maxCostMinor,
          currencyCode: creativeForm.currencyCode.toUpperCase(),
          maxAttempts: creativeForm.maxAttempts,
        }),
      }),
    onSuccess: async () => {
      setCreativeOpen(false);
      setCreativeForm((current) => ({
        ...current,
        briefId: "",
        prompt: "",
        negativePrompt: "",
      }));
      await invalidate();
      toast({
        title: tr
          ? "AI üretim isteği onaya gönderildi"
          : "AI generation request sent for approval",
      });
    },
    onError: (error) =>
      toast({
        title: tr
          ? "AI üretim isteği oluşturulamadı"
          : "AI generation request could not be created",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      }),
  });

  const reviewCreative = useMutation({
    mutationFn: ({
      id,
      decision,
      reason,
    }: {
      id: string;
      decision: "APPROVE" | "REJECT";
      reason?: string;
    }) =>
      customFetch(`/api/social/creative-requests/${id}/review`, {
        method: "POST",
        body: JSON.stringify({
          decision,
          reason,
          requestKey: requestKey("social-creative-review"),
        }),
      }),
    onSuccess: invalidate,
    onError: (error) =>
      toast({
        title: tr
          ? "AI üretim kararı kaydedilemedi"
          : "AI generation decision could not be saved",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      }),
  });

  const briefs = overview.data?.briefs ?? [];
  const calendar = useMemo(
    () =>
      [...briefs]
        .filter((brief) => brief.scheduled_for)
        .sort(
          (left, right) =>
            new Date(left.scheduled_for!).getTime() -
            new Date(right.scheduled_for!).getTime(),
        ),
    [briefs],
  );
  const briefCounts = numericCounts(overview.data?.briefCounts ?? []);
  const accountCounts = numericCounts(overview.data?.accountCounts ?? []);
  const publicationCounts = numericCounts(
    overview.data?.publicationCounts ?? [],
  );
  const verifiedAccounts = (accounts.data?.data ?? []).filter(
    (account) => account.status === "VERIFIED",
  );
  const performanceTotals = useMemo(() => {
    const totals: SocialMetrics = {};
    for (const item of performance.data?.data ?? []) {
      for (const [key, value] of Object.entries(item.metrics ?? {})) {
        if (typeof value === "number" && Number.isFinite(value)) {
          const metric = key as keyof SocialMetrics;
          totals[metric] = (totals[metric] ?? 0) + value;
        }
      }
    }
    return totals;
  }, [performance.data?.data]);
  const canManage =
    context.data?.mode === "manage" && hasPermission("social.manage");
  const canApprove = hasPermission("social.approve");
  const briefMediaValid = useMemo(() => {
    const videos = briefMediaAssets.filter(
      (asset) => asset.media_kind === "video",
    ).length;
    const images = briefMediaAssets.length - videos;
    if (["REEL", "VIDEO"].includes(briefForm.contentKind))
      return videos === 1 && images === 0;
    if (briefForm.contentKind === "STORY")
      return (
        briefMediaAssets.length > 0 &&
        (videos === 0 || briefMediaAssets.length === 1)
      );
    if (briefForm.contentKind === "AD_CREATIVE")
      return briefMediaAssets.length > 0;
    return true;
  }, [briefForm.contentKind, briefMediaAssets]);

  if (context.isLoading)
    return (
      <div className="space-y-4">
        <div className="h-16 animate-pulse rounded-xl bg-muted" />
        <div className="h-96 animate-pulse rounded-xl bg-muted" />
      </div>
    );

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {tr ? "Sosyal Medya Operasyonları" : "Social Media Operations"}
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            {tr
              ? "Çoklu hesap, içerik brief'i, maker-checker onayı, yayın takvimi, UTM ve performans kanıtını tek alanda yönetir."
              : "Manages multi-account registry, content briefs, maker-checker approval, publishing calendar, UTM and performance evidence in one place."}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <a href="/admin/settings">
              <Settings className="mr-2 size-4" />
              {tr ? "Bağlantılar" : "Connections"}
            </a>
          </Button>
          <Button onClick={() => setBriefOpen(true)} disabled={!canManage}>
            <Plus className="mr-2 size-4" />
            {tr ? "Yeni brief" : "New brief"}
          </Button>
        </div>
      </div>

      {!enabled && (
        <Card className="border-amber-300 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/30">
          <CardContent className="flex items-start gap-3 p-5">
            <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-600" />
            <div>
              <p className="font-semibold">
                {tr
                  ? "Tenant kapsamı henüz bağlanmadı"
                  : "Tenant scope is not configured"}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {tr
                  ? "Güvensiz tek-tenant varsayımı yapılmadı. Yerel ortamda SOCIAL_OPERATIONS_TENANT_ID ve SOCIAL_OPERATIONS_ORGANIZATION_ID açıkça tanımlanınca planlama ve onay akışları açılır."
                  : "No unsafe single-tenant assumption was made. Planning and approvals become available after explicitly setting SOCIAL_OPERATIONS_TENANT_ID and SOCIAL_OPERATIONS_ORGANIZATION_ID locally."}
              </p>
              <Badge variant="outline" className="mt-3">
                {context.data?.reason ??
                  "SOCIAL_OPERATIONS_CONFIGURATION_REQUIRED"}
              </Badge>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {[
          {
            label: tr ? "Taslak" : "Draft",
            value: briefCounts.DRAFT ?? 0,
            icon: FileText,
          },
          {
            label: tr ? "Onay bekliyor" : "In review",
            value: briefCounts.IN_REVIEW ?? 0,
            icon: Clock3,
          },
          {
            label: tr ? "Onaylandı" : "Approved",
            value: briefCounts.APPROVED ?? 0,
            icon: CheckCircle2,
          },
          {
            label: tr ? "Bağlı hesap" : "Registered accounts",
            value: Object.values(accountCounts).reduce(
              (sum, value) => sum + value,
              0,
            ),
            icon: Users,
          },
          {
            label: tr ? "Yayın kuyruğu" : "Publishing queue",
            value:
              (publicationCounts.APPROVED ?? 0) +
              (publicationCounts.QUEUED ?? 0) +
              (publicationCounts.RUNNING ?? 0),
            icon: Send,
          },
        ].map(({ label, value, icon: Icon }) => (
          <Card key={label}>
            <CardContent className="flex items-center justify-between p-4">
              <div>
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="mt-1 text-2xl font-semibold">{value}</p>
              </div>
              <div className="rounded-xl bg-primary/10 p-2.5 text-primary">
                <Icon className="size-5" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="flex items-start gap-2 rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-200">
        <ShieldCheck className="mt-0.5 size-4 shrink-0" />
        <span>
          {tr
            ? context.data?.publishingEnabled
              ? "Yayın worker'ı yalnız ikinci onaydan sonra çalışır; başarı ancak provider receipt ve post referansı doğrulanınca kaydedilir."
              : `Gerçek provider yayını güvenlik kapısında kapalıdır (${context.data?.publicationGate?.reason ?? "SOCIAL_PROVIDER_PUBLISHING_DISABLED"}). İçerik ve yayın onayı birbirinden ayrıdır.`
            : context.data?.publishingEnabled
              ? "The publishing worker runs only after a second approval; success is recorded only with verified provider receipt and post references."
              : `Real provider publishing is safety-gated (${context.data?.publicationGate?.reason ?? "SOCIAL_PROVIDER_PUBLISHING_DISABLED"}). Content and publication approvals are separate.`}
        </span>
      </div>

      {enabled && (
        <div className="grid gap-3 md:grid-cols-2">
          {(overview.data?.workerHealth ?? []).map((worker) => {
            const ready = worker.status === "READY";
            const disabled = worker.status === "DISABLED";
            return (
              <Card
                key={worker.kind}
                className={
                  ready
                    ? "border-emerald-200 dark:border-emerald-900"
                    : disabled
                      ? "border-border"
                      : "border-amber-300 dark:border-amber-900"
                }
              >
                <CardContent className="flex items-start justify-between gap-4 p-4">
                  <div className="flex min-w-0 items-start gap-3">
                    <div
                      className={`rounded-xl p-2.5 ${
                        ready
                          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                          : disabled
                            ? "bg-muted text-muted-foreground"
                            : "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
                      }`}
                    >
                      <Activity className="size-5" />
                    </div>
                    <div className="min-w-0">
                      <p className="font-medium">
                        {worker.kind === "publication"
                          ? tr
                            ? "Yayın worker'ı"
                            : "Publication worker"
                          : worker.kind === "performance"
                            ? tr
                              ? "Performans worker'ı"
                              : "Performance worker"
                            : worker.kind === "creative"
                              ? tr
                                ? "AI üretim worker'ı"
                                : "AI creative worker"
                              : tr
                                ? "Reklam worker'ı"
                                : "Advertising worker"}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {disabled
                          ? tr
                            ? `Güvenlik kapısında kapalı (${worker.reason ?? "DISABLED"}).`
                            : `Disabled by safety gate (${worker.reason ?? "DISABLED"}).`
                          : ready
                            ? tr
                              ? `${worker.currentReleaseWorkers} güncel release worker'ı canlı.`
                              : `${worker.currentReleaseWorkers} current-release worker(s) are live.`
                            : tr
                              ? "Worker bekleniyor fakat güncel release heartbeat'i alınamıyor."
                              : "Worker is expected but no current-release heartbeat is available."}
                      </p>
                      {!disabled && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          {tr ? "Son sinyal" : "Last signal"}:{" "}
                          {date(worker.lastSeenAt)}
                        </p>
                      )}
                    </div>
                  </div>
                  <Badge
                    variant="outline"
                    className={
                      ready
                        ? "border-emerald-300 text-emerald-700 dark:text-emerald-300"
                        : disabled
                          ? "text-muted-foreground"
                          : "border-amber-300 text-amber-700 dark:text-amber-300"
                    }
                  >
                    {worker.status}
                  </Badge>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Tabs defaultValue="calendar" className="space-y-4">
        <TabsList className="h-auto w-full justify-start overflow-x-auto rounded-xl bg-muted/60 p-1">
          <TabsTrigger value="calendar">
            <CalendarDays className="mr-2 size-4" />
            {tr ? "Takvim" : "Calendar"}
          </TabsTrigger>
          <TabsTrigger value="briefs">
            <FileText className="mr-2 size-4" />
            {tr ? "İçerikler" : "Content"}
          </TabsTrigger>
          <TabsTrigger value="creative">
            <WandSparkles className="mr-2 size-4" />
            {tr ? "AI stüdyo" : "AI studio"}
          </TabsTrigger>
          <TabsTrigger value="accounts">
            <Link2 className="mr-2 size-4" />
            {tr ? "Hesaplar" : "Accounts"}
          </TabsTrigger>
          <TabsTrigger value="publications">
            <Send className="mr-2 size-4" />
            {tr ? "Yayın kuyruğu" : "Publishing queue"}
          </TabsTrigger>
          <TabsTrigger value="performance">
            <BarChart3 className="mr-2 size-4" />
            {tr ? "Performans" : "Performance"}
          </TabsTrigger>
          <TabsTrigger value="attribution">
            <Target className="mr-2 size-4" />
            {tr ? "CRM katkısı" : "CRM attribution"}
          </TabsTrigger>
          <TabsTrigger value="advertising">
            <WalletCards className="mr-2 size-4" />
            {tr ? "Reklam yönetimi" : "Advertising"}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="calendar">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {tr ? "Yayın takvimi" : "Publishing calendar"}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {calendar.length === 0 ? (
                <div className="py-12 text-center">
                  <CalendarDays className="mx-auto size-8 text-muted-foreground" />
                  <p className="mt-3 text-sm text-muted-foreground">
                    {tr ? "Planlanmış içerik yok." : "No scheduled content."}
                  </p>
                </div>
              ) : (
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {calendar.map((brief) => (
                    <div key={brief.id} className="rounded-xl border p-4">
                      <div className="flex items-start justify-between gap-2">
                        <p className="font-medium">{brief.title}</p>
                        <Badge
                          className={`border-0 ${statusTone(brief.status)}`}
                        >
                          {brief.status}
                        </Badge>
                      </div>
                      <p className="mt-3 text-sm font-medium">
                        {date(brief.scheduled_for)}
                      </p>
                      <div className="mt-3 flex flex-wrap gap-1">
                        {brief.channels.map((channel) => (
                          <Badge key={channel} variant="outline">
                            {channel}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="briefs">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base">
                    {tr
                      ? "İçerik üretim ve onay kuyruğu"
                      : "Content production and approval queue"}
                  </CardTitle>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {tr
                      ? "AI üretimi daha sonra aynı brief'e taslak öneri olarak bağlanacak; kendiliğinden onay veya yayın yapamaz."
                      : "AI generation will attach as a draft suggestion to the same brief; it cannot approve or publish itself."}
                  </p>
                </div>
                <Button
                  size="sm"
                  onClick={() => setBriefOpen(true)}
                  disabled={!canManage}
                >
                  <Plus className="mr-2 size-4" />
                  {tr ? "Brief" : "Brief"}
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {briefs.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  {tr ? "Henüz brief yok." : "No briefs yet."}
                </p>
              ) : (
                <div className="space-y-3">
                  {briefs.map((brief) => (
                    <div key={brief.id} className="rounded-xl border p-4">
                      <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="font-medium">{brief.title}</p>
                            <Badge
                              className={`border-0 ${statusTone(brief.status)}`}
                            >
                              {brief.status}
                            </Badge>
                            <Badge variant="outline">
                              {brief.content_kind}
                            </Badge>
                            {brief.media_refs.length > 0 && (
                              <Badge variant="outline">
                                <Paperclip className="mr-1 size-3" />
                                {brief.media_refs.length}
                              </Badge>
                            )}
                          </div>
                          <p className="mt-2 text-xs text-muted-foreground">
                            {brief.channels.join(" · ")} ·{" "}
                            {brief.locales.join(" · ")} ·{" "}
                            {date(brief.scheduled_for)}
                          </p>
                        </div>
                        <div className="flex gap-2">
                          {brief.status === "DRAFT" && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={!canManage || submitBrief.isPending}
                              onClick={() => submitBrief.mutate(brief.id)}
                            >
                              {tr ? "Onaya gönder" : "Submit"}
                            </Button>
                          )}
                          {brief.status === "IN_REVIEW" &&
                            canApprove &&
                            brief.created_by_legacy_user_id !== user?.id && (
                              <>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={reviewBrief.isPending}
                                  onClick={() =>
                                    reviewBrief.mutate({
                                      id: brief.id,
                                      decision: "REJECT",
                                    })
                                  }
                                >
                                  {tr ? "Reddet" : "Reject"}
                                </Button>
                                <Button
                                  size="sm"
                                  disabled={reviewBrief.isPending}
                                  onClick={() =>
                                    reviewBrief.mutate({
                                      id: brief.id,
                                      decision: "APPROVE",
                                    })
                                  }
                                >
                                  {tr ? "Onayla" : "Approve"}
                                </Button>
                              </>
                            )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="creative">
          <Card>
            <CardHeader>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <CardTitle className="text-base">
                    {tr ? "AI içerik ve video stüdyosu" : "AI content and video studio"}
                  </CardTitle>
                  <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
                    {tr
                      ? "Caption, görsel ve video üretimi ayrı maliyet onayından geçer. Üretilen çıktı yalnız taslak brief'e eklenir; içerik ve yayın maker-checker onaylarını atlayamaz."
                      : "Caption, image and video generation has a separate spend approval. Output is attached only to a draft brief and cannot bypass content or publication maker-checker review."}
                  </p>
                </div>
                <Button
                  size="sm"
                  onClick={() => setCreativeOpen(true)}
                  disabled={
                    !canManage ||
                    briefs.every((brief) => brief.status !== "DRAFT")
                  }
                >
                  <WandSparkles className="mr-2 size-4" />
                  {tr ? "Üretim isteği" : "Generation request"}
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {creatives.data?.creativeGate.enabled !== true && (
                <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                  {tr
                    ? `Harici AI üretimi güvenlik kapısında kapalıdır (${creatives.data?.creativeGate.reason ?? context.data?.creativeGate?.reason ?? "SOCIAL_CREATIVE_WORKER_DISABLED"}). İstek ve onay kuyruğu kullanılabilir; dış maliyet oluşmaz.`
                    : `External AI generation is safety-gated (${creatives.data?.creativeGate.reason ?? context.data?.creativeGate?.reason ?? "SOCIAL_CREATIVE_WORKER_DISABLED"}). Requests and approvals remain available without external spend.`}
                </div>
              )}
              {(creatives.data?.data ?? []).length === 0 ? (
                <div className="py-12 text-center">
                  <WandSparkles className="mx-auto size-8 text-muted-foreground" />
                  <p className="mt-3 text-sm text-muted-foreground">
                    {tr
                      ? "Henüz AI üretim isteği yok. Önce bir taslak brief oluşturun."
                      : "No AI generation requests yet. Create a draft brief first."}
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {creatives.data!.data.map((creative) => (
                    <div key={creative.id} className="rounded-xl border p-4">
                      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="font-medium">{creative.brief_title}</p>
                            <Badge className={`border-0 ${statusTone(creative.status)}`}>
                              {creative.status}
                            </Badge>
                            <Badge variant="outline">{creative.output_kind}</Badge>
                            <Badge variant="outline">{creative.provider}</Badge>
                          </div>
                          <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
                            {creative.prompt}
                          </p>
                          <p className="mt-2 text-xs text-muted-foreground">
                            {creative.locale} · {creative.integration_key}
                            {creative.resolved_model
                              ? ` · ${creative.resolved_model}`
                              : creative.model
                                ? ` · ${creative.model}`
                                : ""}
                            {` · ${tr ? "çağrı" : "calls"} ${creative.attempt_count}/120`}
                            {` · ${tr ? "hata" : "failures"} ${creative.failure_count}/${creative.max_attempts}`}
                            {` · ${tr ? "tavan" : "cap"} ${creative.max_cost_minor} ${creative.currency_code}`}
                          </p>
                          {creative.usage?.estimatedCostMinor !== undefined && (
                            <p className="mt-1 text-xs text-muted-foreground">
                              {tr ? "Kaydedilen maliyet" : "Recorded cost"}: {creative.usage.estimatedCostMinor}{" "}
                              {String(creative.usage.currencyCode ?? creative.currency_code)}
                            </p>
                          )}
                          {creative.result_caption && (
                            <div className="mt-3 rounded-lg bg-muted/60 p-3 text-sm whitespace-pre-wrap">
                              {creative.result_caption}
                            </div>
                          )}
                          {creative.generated_asset_id && (
                            <Button variant="link" asChild className="mt-2 h-auto px-0">
                              <a
                                href={`/api/social/media/${creative.generated_asset_id}/content`}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {tr ? "Üretilen medyayı aç" : "Open generated media"}
                                <ExternalLink className="ml-2 size-3" />
                              </a>
                            </Button>
                          )}
                          {creative.status === "GENERATED" && !creative.applied_at && (
                            <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                              {tr
                                ? "Çıktı üretildi fakat brief üretim sırasında taslak olmadığı veya medya kuralıyla çakıştığı için otomatik eklenmedi."
                                : "Output was generated but not auto-applied because the brief was no longer a draft or its media contract had changed."}
                            </p>
                          )}
                          {creative.last_error_code && (
                            <p className="mt-2 text-xs text-red-600">
                              {creative.last_error_code}
                            </p>
                          )}
                        </div>
                        {creative.status === "PENDING_APPROVAL" &&
                          canApprove &&
                          creative.created_by_legacy_user_id !== user?.id && (
                            <div className="flex gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={reviewCreative.isPending}
                                onClick={() => {
                                  const reason = window.prompt(
                                    tr ? "Ret nedeni" : "Rejection reason",
                                  );
                                  if (reason?.trim())
                                    reviewCreative.mutate({
                                      id: creative.id,
                                      decision: "REJECT",
                                      reason: reason.trim(),
                                    });
                                }}
                              >
                                {tr ? "Reddet" : "Reject"}
                              </Button>
                              <Button
                                size="sm"
                                disabled={reviewCreative.isPending}
                                onClick={() =>
                                  reviewCreative.mutate({
                                    id: creative.id,
                                    decision: "APPROVE",
                                  })
                                }
                              >
                                {tr ? "Maliyeti onayla" : "Approve spend"}
                              </Button>
                            </div>
                          )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="accounts">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base">
                    {tr ? "Çoklu sosyal hesap kaydı" : "Multi-account registry"}
                  </CardTitle>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {tr
                      ? "Secret değerleri burada tutulmaz; mevcut entegrasyon kasasına yalnız anahtar referansı bağlanır."
                      : "Secrets are never stored here; only a key reference to the existing integration vault is linked."}
                  </p>
                </div>
                <Button
                  size="sm"
                  onClick={() => setAccountOpen(true)}
                  disabled={!canManage}
                >
                  <Plus className="mr-2 size-4" />
                  {tr ? "Hesap" : "Account"}
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {(accounts.data?.data ?? []).length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  {tr
                    ? "Kayıtlı sosyal hesap yok."
                    : "No registered social accounts."}
                </p>
              ) : (
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {accounts.data!.data.map((account) => (
                    <div key={account.id} className="rounded-xl border p-4">
                      <div className="flex items-start justify-between">
                        <div>
                          <p className="font-medium">{account.display_name}</p>
                          <p className="text-xs text-muted-foreground">
                            {account.provider} · {account.account_key}
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {account.account_kind}
                            {account.currency_code
                              ? ` · ${account.currency_code}`
                              : ""}
                          </p>
                        </div>
                        <Badge
                          className={`border-0 ${statusTone(account.status)}`}
                        >
                          {account.status}
                        </Badge>
                      </div>
                      <p className="mt-3 text-xs text-muted-foreground">
                        {account.integration_key ||
                          (tr ? "Kasa referansı yok" : "No vault reference")}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {tr ? "Son doğrulama" : "Last verification"}:{" "}
                        {date(account.last_verification_at)}
                      </p>
                      {account.last_verification_error_code && (
                        <p className="mt-1 text-xs text-red-600">
                          {account.last_verification_error_code}
                        </p>
                      )}
                      {account.integration_key &&
                        account.status !== "DISABLED" && (
                          <Button
                            className="mt-3"
                            size="sm"
                            variant="outline"
                            disabled={
                              !canManage ||
                              verifyAccount.isPending ||
                              context.data?.providerConnectionGate?.enabled !==
                                true
                            }
                            onClick={() => verifyAccount.mutate(account.id)}
                          >
                            {verifyAccount.isPending ? (
                              <Loader2 className="mr-2 size-4 animate-spin" />
                            ) : (
                              <ShieldCheck className="mr-2 size-4" />
                            )}
                            {tr ? "Bağlantıyı doğrula" : "Verify connection"}
                          </Button>
                        )}
                    </div>
                  ))}
                </div>
              )}
              {context.data?.providerConnectionGate?.enabled !== true && (
                <p className="mt-4 text-xs text-amber-700 dark:text-amber-300">
                  {tr
                    ? `Sağlayıcı bağlantı testi güvenlik kapısında kapalıdır (${context.data?.providerConnectionGate?.reason ?? "SOCIAL_PROVIDER_CONNECTIVITY_DISABLED"}).`
                    : `Provider connection testing is safety-gated (${context.data?.providerConnectionGate?.reason ?? "SOCIAL_PROVIDER_CONNECTIVITY_DISABLED"}).`}
                </p>
              )}
              <Button variant="link" asChild className="mt-4 px-0">
                <a href="/admin/settings">
                  {tr
                    ? "Entegrasyon bağlantılarını yönet"
                    : "Manage integration connections"}
                  <ExternalLink className="ml-2 size-3" />
                </a>
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="publications">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <CardTitle className="text-base">
                    {tr
                      ? "Onaylı yayın orkestrasyonu"
                      : "Approved publication orchestration"}
                  </CardTitle>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {tr
                      ? "Her yayın ayrı onaylanır; retry ve dead-letter kayıtları diğer hesapların akışını durdurmaz."
                      : "Every publication is approved separately; retries and dead letters do not block other accounts."}
                  </p>
                </div>
                <Button
                  size="sm"
                  disabled={
                    !canManage ||
                    verifiedAccounts.length === 0 ||
                    briefCounts.APPROVED === 0
                  }
                  onClick={() => setPublicationOpen(true)}
                >
                  <Plus className="mr-2 size-4" />
                  {tr ? "Yayın taslağı" : "Publication draft"}
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {verifiedAccounts.length === 0 && (
                <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                  {tr
                    ? "Yayın oluşturmak için en az bir hesabın bağlantı testiyle VERIFIED olması gerekir."
                    : "At least one account must be VERIFIED by a connection test before creating a publication."}
                </div>
              )}
              {(publications.data?.data ?? []).length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  {tr
                    ? "Henüz yayın niyeti yok."
                    : "No publication intents yet."}
                </p>
              ) : (
                <div className="space-y-3">
                  {publications.data!.data.map((publication) => (
                    <div key={publication.id} className="rounded-xl border p-4">
                      <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="font-medium">{publication.title}</p>
                            <Badge
                              className={`border-0 ${statusTone(publication.status)}`}
                            >
                              {publication.status}
                            </Badge>
                            <Badge variant="outline">
                              {publication.provider}
                            </Badge>
                          </div>
                          <p className="mt-2 text-xs text-muted-foreground">
                            {publication.account_name} ·{" "}
                            {date(publication.scheduled_for)} ·{" "}
                            {tr ? "deneme" : "attempt"}{" "}
                            {publication.attempt_count}/
                            {publication.max_attempts}
                          </p>
                          {publication.last_error_code && (
                            <p className="mt-1 text-xs text-red-600">
                              {publication.last_error_code}
                            </p>
                          )}
                        </div>
                        <div className="flex gap-2">
                          {publication.status === "DRAFT" && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={
                                !canManage || submitPublication.isPending
                              }
                              onClick={() =>
                                submitPublication.mutate(publication.id)
                              }
                            >
                              {tr
                                ? "Yayın onayına gönder"
                                : "Submit publication"}
                            </Button>
                          )}
                          {publication.status === "PENDING_APPROVAL" &&
                            canApprove &&
                            publication.created_by_legacy_user_id !==
                              user?.id && (
                              <>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={reviewPublication.isPending}
                                  onClick={() =>
                                    reviewPublication.mutate({
                                      id: publication.id,
                                      decision: "REJECT",
                                    })
                                  }
                                >
                                  {tr ? "Reddet" : "Reject"}
                                </Button>
                                <Button
                                  size="sm"
                                  disabled={reviewPublication.isPending}
                                  onClick={() =>
                                    reviewPublication.mutate({
                                      id: publication.id,
                                      decision: "APPROVE",
                                    })
                                  }
                                >
                                  {tr ? "Yayını onayla" : "Approve publication"}
                                </Button>
                              </>
                            )}
                          {[
                            "DRAFT",
                            "PENDING_APPROVAL",
                            "APPROVED",
                            "QUEUED",
                            "FAILED",
                          ].includes(publication.status) && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={
                                !canManage || cancelPublication.isPending
                              }
                              onClick={() =>
                                cancelPublication.mutate(publication.id)
                              }
                            >
                              {tr ? "İptal" : "Cancel"}
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="performance">
          <Card>
            <CardHeader>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <CardTitle className="text-base">
                    {tr
                      ? "Doğrulanmış yayın performansı"
                      : "Verified publication performance"}
                  </CardTitle>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {tr
                      ? "Her kart yalnız sağlayıcı receipt'ine bağlı en güncel snapshot'ı kullanır."
                      : "Each card uses only the latest snapshot bound to a provider receipt."}
                  </p>
                </div>
                <Badge
                  variant={
                    performance.data?.performanceWorkerEnabled
                      ? "default"
                      : "outline"
                  }
                >
                  {performance.data?.performanceWorkerEnabled
                    ? tr
                      ? "Toplayıcı aktif"
                      : "Collector active"
                    : tr
                      ? "Toplayıcı kapalı"
                      : "Collector disabled"}
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
                {[
                  [
                    tr ? "Gösterim" : "Impressions",
                    performanceTotals.impressions,
                  ],
                  [tr ? "Erişim" : "Reach", performanceTotals.reach],
                  [
                    tr ? "Etkileşim" : "Engagements",
                    performanceTotals.engagements,
                  ],
                  [tr ? "Tıklama" : "Clicks", performanceTotals.clicks],
                  [
                    tr ? "Dönüşüm" : "Conversions",
                    performanceTotals.conversions,
                  ],
                  [tr ? "Lead" : "Leads", performanceTotals.leads],
                ].map(([label, value]) => (
                  <div key={String(label)} className="rounded-xl border p-4">
                    <p className="text-xs text-muted-foreground">{label}</p>
                    <p className="mt-2 text-2xl font-semibold">
                      {metric(value as number | undefined)}
                    </p>
                  </div>
                ))}
              </div>
              {(performance.data?.data ?? []).length === 0 ? (
                <div className="mt-4 rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
                  {tr
                    ? "Henüz receipt-bound performans snapshot'ı yok; oran veya ROI uydurulmuyor."
                    : "There is no receipt-bound performance snapshot yet; no rates or ROI are fabricated."}
                </div>
              ) : (
                <div className="mt-4 space-y-3">
                  {performance.data!.data.map((item) => (
                    <div
                      key={item.publication_id}
                      className="flex flex-col gap-3 rounded-xl border p-4 lg:flex-row lg:items-center"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-medium">{item.title}</p>
                          <Badge variant="outline">{item.provider}</Badge>
                          <Badge
                            className={`border-0 ${statusTone(item.sync_status ?? "PENDING")}`}
                          >
                            {item.sync_status ?? "PENDING"}
                          </Badge>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {item.account_name} · {tr ? "Gözlem" : "Observed"}:{" "}
                          {date(item.observed_at)}
                        </p>
                        <p className="mt-2 text-xs text-muted-foreground">
                          {tr ? "Gösterim" : "Impressions"}:{" "}
                          {metric(item.metrics?.impressions)} ·{" "}
                          {tr ? "Etkileşim" : "Engagements"}:{" "}
                          {metric(item.metrics?.engagements)} ·{" "}
                          {tr ? "Tıklama" : "Clicks"}:{" "}
                          {metric(item.metrics?.clicks)} ·{" "}
                          {tr ? "Lead" : "Leads"}: {metric(item.metrics?.leads)}
                        </p>
                        {item.last_error_code && (
                          <p className="mt-1 text-xs text-red-600">
                            {item.last_error_code}
                          </p>
                        )}
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={
                          !canManage ||
                          requestPerformanceSync.isPending ||
                          item.sync_status === "RUNNING"
                        }
                        onClick={() =>
                          requestPerformanceSync.mutate(item.publication_id)
                        }
                      >
                        {requestPerformanceSync.isPending && (
                          <Loader2 className="mr-2 size-4 animate-spin" />
                        )}
                        {tr ? "Yenilemeyi sırala" : "Queue refresh"}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              {performance.data?.providerConnectionGate.enabled !== true && (
                <p className="mt-4 text-xs text-amber-700 dark:text-amber-300">
                  {tr
                    ? `Gerçek metrik toplama güvenlik kapısında kapalıdır (${performance.data?.providerConnectionGate.reason ?? "SOCIAL_PROVIDER_CONNECTIVITY_DISABLED"}).`
                    : `Real metric collection is safety-gated (${performance.data?.providerConnectionGate.reason ?? "SOCIAL_PROVIDER_CONNECTIVITY_DISABLED"}).`}
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="attribution">
          <div className="space-y-4">
            <Card>
              <CardHeader>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <CardTitle className="text-base">
                      {tr
                        ? "Sosyal medya → CRM sonuçları"
                        : "Social media → CRM outcomes"}
                    </CardTitle>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {tr
                        ? "Provider metriklerini, sistem tarafından üretilen değişmez takip anahtarıyla CRM lead ve başvurularından ayrı gösterir."
                        : "Shows provider metrics separately from CRM leads and applications matched through an immutable system tracking key."}
                    </p>
                  </div>
                  <Badge variant="outline">
                    {attribution.data
                      ? `${attribution.data.period.from} → ${attribution.data.period.to}`
                      : tr
                        ? "Son 30 gün"
                        : "Last 30 days"}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent>
                {attribution.isLoading ? (
                  <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
                    <Loader2 className="mr-2 size-4 animate-spin" />
                    {tr ? "Katkı modeli hesaplanıyor" : "Calculating attribution"}
                  </div>
                ) : attribution.isError ? (
                  <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
                    {tr
                      ? "CRM katkı görünümü yüklenemedi."
                      : "CRM attribution view could not be loaded."}
                  </div>
                ) : (
                  <>
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
                      {[
                        [
                          tr ? "Takipli lead" : "Tracked leads",
                          attribution.data?.summary.tracked_leads ?? 0,
                        ],
                        [
                          tr ? "Öğrenciye dönüşen" : "Converted students",
                          attribution.data?.summary.converted_students ?? 0,
                        ],
                        [
                          tr ? "CRM başvurusu" : "CRM applications",
                          attribution.data?.summary.applications ?? 0,
                        ],
                        [
                          tr ? "Lead dönüşümü" : "Lead conversion",
                          `${
                            attribution.data?.summary.tracked_leads
                              ? Math.round(
                                  ((attribution.data?.summary.converted_students ?? 0) /
                                    attribution.data.summary.tracked_leads) *
                                    1000,
                                ) / 10
                              : 0
                          }%`,
                        ],
                        [
                          tr ? "Provider tıklaması" : "Provider clicks",
                          metric(
                            Number(
                              attribution.data?.providerMetrics.provider_clicks ?? 0,
                            ),
                          ),
                        ],
                        [
                          tr ? "Provider lead" : "Provider leads",
                          metric(
                            Number(
                              attribution.data?.providerMetrics.provider_leads ?? 0,
                            ),
                          ),
                        ],
                      ].map(([label, value]) => (
                        <div key={String(label)} className="rounded-xl border p-4">
                          <p className="text-xs text-muted-foreground">{label}</p>
                          <p className="mt-1 text-xl font-semibold">{value}</p>
                        </div>
                      ))}
                    </div>

                    {(attribution.data?.spendByCurrency.length ?? 0) > 0 && (
                      <div className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border p-3">
                        <span className="text-sm font-medium">
                          {tr ? "Doğrulanmış reklam harcaması" : "Verified ad spend"}
                        </span>
                        {attribution.data!.spendByCurrency.map((item) => (
                          <Badge key={item.currency_code} variant="outline">
                            {item.currency_code}{" "}
                            {metric(Number(item.spend_minor) / 100)}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </CardContent>
            </Card>

            <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">
                    {tr ? "İçerik bazında gerçek sonuç" : "Actual outcome by content"}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {(attribution.data?.briefs ?? []).length === 0 ? (
                    <p className="py-10 text-center text-sm text-muted-foreground">
                      {tr
                        ? "Bu dönemde takip anahtarıyla eşleşen CRM sonucu yok."
                        : "No CRM outcome matched a tracking key in this period."}
                    </p>
                  ) : (
                    <div className="space-y-3">
                      {attribution.data!.briefs.map((brief) => (
                        <div key={brief.brief_id} className="rounded-xl border p-4">
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <div className="min-w-0">
                              <p className="font-medium">{brief.title}</p>
                              <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                                {brief.tracking_key}
                              </p>
                            </div>
                            {brief.campaign_key && (
                              <Badge variant="outline">{brief.campaign_key}</Badge>
                            )}
                          </div>
                          <div className="mt-3 grid grid-cols-3 gap-2 text-center text-sm">
                            <div className="rounded-lg bg-muted/60 p-2">
                              <p className="font-semibold">{brief.tracked_leads}</p>
                              <p className="text-[11px] text-muted-foreground">Lead</p>
                            </div>
                            <div className="rounded-lg bg-muted/60 p-2">
                              <p className="font-semibold">
                                {brief.converted_students}
                              </p>
                              <p className="text-[11px] text-muted-foreground">
                                {tr ? "Öğrenci" : "Student"}
                              </p>
                            </div>
                            <div className="rounded-lg bg-muted/60 p-2">
                              <p className="font-semibold">{brief.applications}</p>
                              <p className="text-[11px] text-muted-foreground">
                                {tr ? "Başvuru" : "Application"}
                              </p>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">
                    {tr ? "Başvuru aşamaları" : "Application stages"}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {(attribution.data?.applicationStages ?? []).length === 0 ? (
                    <p className="py-8 text-center text-sm text-muted-foreground">—</p>
                  ) : (
                    <div className="space-y-2">
                      {attribution.data!.applicationStages.map((stage) => (
                        <div
                          key={stage.application_stage}
                          className="flex items-center justify-between rounded-lg border px-3 py-2"
                        >
                          <span className="text-sm">{stage.application_stage}</span>
                          <Badge variant="outline">{stage.count}</Badge>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            <div className="flex items-start gap-2 rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-200">
              <ShieldCheck className="mt-0.5 size-4 shrink-0" />
              <span>
                {tr
                  ? "CRM sayıları first-touch takip anahtarından üretilir; provider'ın bildirdiği lead/conversion değerleriyle birleştirilmez ve farklar gizlenmez."
                  : "CRM counts use first-touch tracking keys; they are not merged with provider-reported lead/conversion values, so discrepancies stay visible."}
              </span>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="advertising">
          <SocialAdvertisingPanel
            tr={tr}
            canManage={canManage}
            canApprove={canApprove}
            userId={user?.id ?? 0}
            accounts={accounts.data?.data ?? []}
            briefs={overview.data?.briefs ?? []}
          />
        </TabsContent>
      </Tabs>

      <Dialog open={creativeOpen} onOpenChange={setCreativeOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {tr ? "AI üretim isteği" : "AI generation request"}
            </DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-2 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Label>{tr ? "Taslak brief" : "Draft brief"}</Label>
              <select
                className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={creativeForm.briefId}
                onChange={(event) => {
                  const selected = briefs.find(
                    (brief) => brief.id === event.target.value,
                  );
                  setCreativeForm({
                    ...creativeForm,
                    briefId: event.target.value,
                    locale: selected?.locales[0] ?? creativeForm.locale,
                  });
                }}
              >
                <option value="">—</option>
                {briefs
                  .filter(
                    (brief) =>
                      brief.status === "DRAFT" &&
                      (creativeForm.outputKind === "CAPTION" ||
                        (creativeForm.outputKind === "IMAGE" &&
                          !["REEL", "VIDEO"].includes(brief.content_kind)) ||
                        (creativeForm.outputKind === "VIDEO" &&
                          brief.content_kind !== "ARTICLE")),
                  )
                  .map((brief) => (
                    <option key={brief.id} value={brief.id}>
                      {brief.title} · {brief.content_kind}
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <Label>{tr ? "Çıktı türü" : "Output kind"}</Label>
              <select
                className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={creativeForm.outputKind}
                onChange={(event) =>
                  setCreativeForm({
                    ...creativeForm,
                    briefId: "",
                    outputKind: event.target
                      .value as typeof creativeForm.outputKind,
                  })
                }
              >
                <option value="CAPTION">Caption / copy</option>
                <option value="IMAGE">Image</option>
                <option value="VIDEO">Video</option>
              </select>
            </div>
            <div>
              <Label>{tr ? "Dil" : "Locale"}</Label>
              <Input
                className="mt-1"
                value={creativeForm.locale}
                onChange={(event) =>
                  setCreativeForm({
                    ...creativeForm,
                    locale: event.target.value,
                  })
                }
              />
            </div>
            <div>
              <Label>Provider</Label>
              <Input
                className="mt-1"
                placeholder="anthropic / openai / runway"
                value={creativeForm.provider}
                onChange={(event) =>
                  setCreativeForm({
                    ...creativeForm,
                    provider: event.target.value.toLowerCase(),
                  })
                }
              />
            </div>
            <div>
              <Label>{tr ? "Entegrasyon kasa anahtarı" : "Integration vault key"}</Label>
              <select
                className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={creativeForm.integrationKey}
                onChange={(event) =>
                  setCreativeForm({
                    ...creativeForm,
                    integrationKey: event.target.value,
                  })
                }
              >
                <option value="">—</option>
                {(creativeIntegrations.data?.data ?? [])
                  .filter(
                    (item) =>
                      item.category.toLowerCase() === "ai" ||
                      ["openai", "claude", "anthropic", "runway"].includes(
                        item.key,
                      ) ||
                      item.key.startsWith("claude:") ||
                      item.key.startsWith("anthropic:"),
                  )
                  .map((item) => (
                    <option key={item.key} value={item.key}>
                      {item.name} ({item.key})
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <Label>{tr ? "Model (isteğe bağlı)" : "Model (optional)"}</Label>
              <Input
                className="mt-1"
                value={creativeForm.model}
                onChange={(event) =>
                  setCreativeForm({ ...creativeForm, model: event.target.value })
                }
              />
            </div>
            {creativeForm.outputKind !== "CAPTION" && (
              <div>
                <Label>{tr ? "En-boy oranı" : "Aspect ratio"}</Label>
                <select
                  className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
                  value={creativeForm.aspectRatio}
                  onChange={(event) =>
                    setCreativeForm({
                      ...creativeForm,
                      aspectRatio: event.target
                        .value as typeof creativeForm.aspectRatio,
                    })
                  }
                >
                  {(["1:1", "4:5", "9:16", "16:9"] as const).map(
                    (ratio) => (
                      <option key={ratio}>{ratio}</option>
                    ),
                  )}
                </select>
              </div>
            )}
            {creativeForm.outputKind === "VIDEO" && (
              <div>
                <Label>{tr ? "Süre (saniye)" : "Duration (seconds)"}</Label>
                <Input
                  className="mt-1"
                  type="number"
                  min={1}
                  max={60}
                  value={creativeForm.durationSeconds}
                  onChange={(event) =>
                    setCreativeForm({
                      ...creativeForm,
                      durationSeconds: Math.max(
                        1,
                        Math.min(60, Number(event.target.value) || 1),
                      ),
                    })
                  }
                />
              </div>
            )}
            <div className="sm:col-span-2">
              <Label>Prompt</Label>
              <Textarea
                className="mt-1 min-h-32"
                maxLength={12_000}
                value={creativeForm.prompt}
                onChange={(event) =>
                  setCreativeForm({ ...creativeForm, prompt: event.target.value })
                }
              />
            </div>
            {creativeForm.outputKind !== "CAPTION" && (
              <div className="sm:col-span-2">
                <Label>{tr ? "Negatif prompt" : "Negative prompt"}</Label>
                <Textarea
                  className="mt-1"
                  maxLength={4_000}
                  value={creativeForm.negativePrompt}
                  onChange={(event) =>
                    setCreativeForm({
                      ...creativeForm,
                      negativePrompt: event.target.value,
                    })
                  }
                />
              </div>
            )}
            <div>
              <Label>{tr ? "Azami hata denemesi" : "Maximum failure attempts"}</Label>
              <Input
                className="mt-1"
                type="number"
                min={1}
                max={5}
                value={creativeForm.maxAttempts}
                onChange={(event) =>
                  setCreativeForm({
                    ...creativeForm,
                    maxAttempts: Math.max(
                      1,
                      Math.min(5, Number(event.target.value) || 1),
                    ),
                  })
                }
              />
            </div>
            <div className="grid grid-cols-[1fr_96px] gap-2">
              <div>
                <Label>
                  {tr ? "Maliyet tavanı (minor birim)" : "Cost cap (minor unit)"}
                </Label>
                <Input
                  className="mt-1"
                  type="number"
                  min={1}
                  max={100_000_000}
                  value={creativeForm.maxCostMinor}
                  onChange={(event) =>
                    setCreativeForm({
                      ...creativeForm,
                      maxCostMinor: Math.max(
                        1,
                        Math.min(100_000_000, Number(event.target.value) || 1),
                      ),
                    })
                  }
                />
              </div>
              <div>
                <Label>{tr ? "Para" : "Currency"}</Label>
                <Input
                  className="mt-1 uppercase"
                  maxLength={3}
                  value={creativeForm.currencyCode}
                  onChange={(event) =>
                    setCreativeForm({
                      ...creativeForm,
                      currencyCode: event.target.value.toUpperCase(),
                    })
                  }
                />
              </div>
            </div>
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-200">
              {tr
                ? "Bu onay yalnız AI maliyetini açar. Çıktı taslakta kalır ve ayrıca içerik/yayın onayı ister."
                : "This approval authorizes only AI spend. Output remains a draft and still needs content and publication approval."}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreativeOpen(false)}>
              {tr ? "İptal" : "Cancel"}
            </Button>
            <Button
              disabled={
                createCreative.isPending ||
                !creativeForm.briefId ||
                !creativeForm.provider ||
                !creativeForm.integrationKey ||
                !creativeForm.prompt.trim() ||
                creativeForm.currencyCode.length !== 3
              }
              onClick={() => createCreative.mutate()}
            >
              {createCreative.isPending && (
                <Loader2 className="mr-2 size-4 animate-spin" />
              )}
              {tr ? "Onaya gönder" : "Submit for approval"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={publicationOpen} onOpenChange={setPublicationOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {tr ? "Yeni yayın taslağı" : "New publication draft"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label>{tr ? "Onaylı içerik" : "Approved content"}</Label>
              <select
                className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={publicationForm.briefId}
                onChange={(event) =>
                  setPublicationForm({
                    ...publicationForm,
                    briefId: event.target.value,
                  })
                }
              >
                <option value="">—</option>
                {briefs
                  .filter((brief) => brief.status === "APPROVED")
                  .map((brief) => (
                    <option key={brief.id} value={brief.id}>
                      {brief.title}
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <Label>{tr ? "Doğrulanmış hesap" : "Verified account"}</Label>
              <select
                className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={publicationForm.accountId}
                onChange={(event) =>
                  setPublicationForm({
                    ...publicationForm,
                    accountId: event.target.value,
                  })
                }
              >
                <option value="">—</option>
                {verifiedAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.display_name} ({account.provider})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label>
                {tr ? "Planlanan yayın zamanı" : "Scheduled publication time"}
              </Label>
              <Input
                type="datetime-local"
                className="mt-1"
                value={publicationForm.scheduledFor}
                onChange={(event) =>
                  setPublicationForm({
                    ...publicationForm,
                    scheduledFor: event.target.value,
                  })
                }
              />
            </div>
            <div>
              <Label>{tr ? "Azami deneme" : "Maximum attempts"}</Label>
              <Input
                type="number"
                min={1}
                max={12}
                className="mt-1"
                value={publicationForm.maxAttempts}
                onChange={(event) =>
                  setPublicationForm({
                    ...publicationForm,
                    maxAttempts: Math.max(
                      1,
                      Math.min(12, Number(event.target.value) || 1),
                    ),
                  })
                }
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPublicationOpen(false)}>
              {tr ? "İptal" : "Cancel"}
            </Button>
            <Button
              disabled={
                createPublication.isPending ||
                !publicationForm.briefId ||
                !publicationForm.accountId
              }
              onClick={() => createPublication.mutate()}
            >
              {createPublication.isPending && (
                <Loader2 className="mr-2 size-4 animate-spin" />
              )}
              {tr ? "Taslak oluştur" : "Create draft"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={briefOpen} onOpenChange={setBriefOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {tr ? "Yeni içerik brief'i" : "New content brief"}
            </DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-2 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Label>{tr ? "Başlık" : "Title"}</Label>
              <Input
                className="mt-1"
                value={briefForm.title}
                onChange={(event) =>
                  setBriefForm({ ...briefForm, title: event.target.value })
                }
              />
            </div>
            <div>
              <Label>{tr ? "Hedef" : "Objective"}</Label>
              <Textarea
                className="mt-1"
                value={briefForm.objective}
                onChange={(event) =>
                  setBriefForm({ ...briefForm, objective: event.target.value })
                }
              />
            </div>
            <div>
              <Label>{tr ? "Hedef kitle" : "Audience"}</Label>
              <Textarea
                className="mt-1"
                value={briefForm.audience}
                onChange={(event) =>
                  setBriefForm({ ...briefForm, audience: event.target.value })
                }
              />
            </div>
            <div>
              <Label>{tr ? "İçerik türü" : "Content kind"}</Label>
              <select
                className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={briefForm.contentKind}
                onChange={(event) =>
                  setBriefForm({
                    ...briefForm,
                    contentKind: event.target.value,
                  })
                }
              >
                {CONTENT_KINDS.map((kind) => (
                  <option key={kind}>{kind}</option>
                ))}
              </select>
            </div>
            <div>
              <Label>
                {tr ? "Diller (virgülle)" : "Locales (comma separated)"}
              </Label>
              <Input
                className="mt-1"
                value={briefForm.locales}
                onChange={(event) =>
                  setBriefForm({ ...briefForm, locales: event.target.value })
                }
              />
            </div>
            <div className="sm:col-span-2">
              <Label>{tr ? "Kanallar" : "Channels"}</Label>
              <div className="mt-2 flex flex-wrap gap-2">
                {CHANNELS.map((channel) => (
                  <button
                    type="button"
                    key={channel}
                    onClick={() =>
                      setBriefForm((current) => ({
                        ...current,
                        channels: current.channels.includes(channel)
                          ? current.channels.filter(
                              (value) => value !== channel,
                            )
                          : [...current.channels, channel],
                      }))
                    }
                    className={`rounded-full border px-3 py-1.5 text-xs ${briefForm.channels.includes(channel) ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground"}`}
                  >
                    {channel}
                  </button>
                ))}
              </div>
            </div>
            <div className="sm:col-span-2">
              <Label>{tr ? "Medya dosyaları" : "Media files"}</Label>
              <div className="mt-2 rounded-xl border border-dashed p-4">
                <label className="flex cursor-pointer items-center justify-center gap-2 rounded-lg bg-muted/60 px-4 py-3 text-sm font-medium hover:bg-muted">
                  {mediaUploading ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Upload className="size-4" />
                  )}
                  {mediaUploading
                    ? tr
                      ? "Yükleniyor…"
                      : "Uploading…"
                    : tr
                      ? "Görsel veya MP4 seç"
                      : "Choose images or MP4"}
                  <input
                    className="sr-only"
                    type="file"
                    multiple
                    disabled={mediaUploading || briefMediaAssets.length >= 10}
                    accept="image/jpeg,image/png,image/webp,video/mp4"
                    onChange={(event) => {
                      void uploadBriefMedia(event.target.files);
                      event.target.value = "";
                    }}
                  />
                </label>
                <p className="mt-2 text-xs text-muted-foreground">
                  {tr
                    ? "En fazla 10 dosya. Görseller 15 MB, MP4 videolar 25 MB. Reel ve video için tek MP4 zorunludur."
                    : "Up to 10 files. Images 15 MB, MP4 videos 25 MB. Reels and videos require exactly one MP4."}
                </p>
                {briefMediaAssets.length > 0 && (
                  <div className="mt-3 space-y-2">
                    {briefMediaAssets.map((asset) => (
                      <div
                        key={asset.id}
                        className="flex items-center justify-between gap-3 rounded-lg border bg-background px-3 py-2"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">
                            {asset.original_file_name}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {asset.media_kind} ·{" "}
                            {(asset.size_bytes / 1024 / 1024).toFixed(1)} MB
                          </p>
                        </div>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          aria-label={tr ? "Medyayı kaldır" : "Remove media"}
                          onClick={() =>
                            setBriefMediaAssets((current) =>
                              current.filter((item) => item.id !== asset.id),
                            )
                          }
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div>
              <Label>{tr ? "Planlanan zaman" : "Scheduled time"}</Label>
              <Input
                type="datetime-local"
                className="mt-1"
                value={briefForm.scheduledFor}
                onChange={(event) =>
                  setBriefForm({
                    ...briefForm,
                    scheduledFor: event.target.value,
                  })
                }
              />
            </div>
            <div>
              <Label>Campaign key</Label>
              <Input
                className="mt-1"
                value={briefForm.campaignKey}
                onChange={(event) =>
                  setBriefForm({
                    ...briefForm,
                    campaignKey: event.target.value,
                  })
                }
              />
            </div>
            <div>
              <Label>utm_campaign</Label>
              <Input
                className="mt-1"
                value={briefForm.utmCampaign}
                onChange={(event) =>
                  setBriefForm({
                    ...briefForm,
                    utmCampaign: event.target.value,
                  })
                }
              />
            </div>
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-200">
              {tr
                ? "utm_content sistem tarafından değişmez bir takip anahtarı olarak üretilecek. Böylece provider lead sayısı ile gerçek CRM sonucu ayrı ayrı doğrulanabilir."
                : "utm_content is generated as an immutable system tracking key so provider leads and actual CRM outcomes can be verified separately."}
            </div>
            <div className="sm:col-span-2">
              <Label>Caption / copy</Label>
              <Textarea
                className="mt-1 min-h-28"
                value={briefForm.caption}
                onChange={(event) =>
                  setBriefForm({ ...briefForm, caption: event.target.value })
                }
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBriefOpen(false)}>
              {tr ? "İptal" : "Cancel"}
            </Button>
            <Button
              disabled={
                createBrief.isPending ||
                mediaUploading ||
                !briefForm.title ||
                !briefForm.objective ||
                !briefForm.audience ||
                briefForm.channels.length === 0 ||
                !briefMediaValid
              }
              onClick={() => createBrief.mutate()}
            >
              {createBrief.isPending && (
                <Loader2 className="mr-2 size-4 animate-spin" />
              )}
              {tr ? "Taslak oluştur" : "Create draft"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={accountOpen} onOpenChange={setAccountOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {tr ? "Sosyal hesap kaydı" : "Register social account"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label>Provider</Label>
              <Input
                className="mt-1"
                value={accountForm.provider}
                onChange={(event) =>
                  setAccountForm({
                    ...accountForm,
                    provider: event.target.value.toLowerCase(),
                  })
                }
              />
            </div>
            <div>
              <Label>Account key</Label>
              <Input
                className="mt-1"
                placeholder="instagram:main"
                value={accountForm.accountKey}
                onChange={(event) =>
                  setAccountForm({
                    ...accountForm,
                    accountKey: event.target.value.toLowerCase(),
                  })
                }
              />
            </div>
            <div>
              <Label>{tr ? "Görünen ad" : "Display name"}</Label>
              <Input
                className="mt-1"
                value={accountForm.displayName}
                onChange={(event) =>
                  setAccountForm({
                    ...accountForm,
                    displayName: event.target.value,
                  })
                }
              />
            </div>
            <div>
              <Label>{tr ? "Hesap türü" : "Account type"}</Label>
              <select
                className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={accountForm.accountKind}
                onChange={(event) =>
                  setAccountForm({
                    ...accountForm,
                    accountKind: event.target.value as typeof accountForm.accountKind,
                    currencyCode:
                      event.target.value === "AD_ACCOUNT"
                        ? accountForm.currencyCode
                        : "",
                  })
                }
              >
                <option value="PROFILE">Profile</option>
                <option value="PAGE">Page</option>
                <option value="CHANNEL">Channel</option>
                <option value="AD_ACCOUNT">Ad account</option>
              </select>
            </div>
            {accountForm.accountKind === "AD_ACCOUNT" && (
              <div>
                <Label>{tr ? "Hesap para birimi" : "Account currency"}</Label>
                <Input
                  className="mt-1 uppercase"
                  maxLength={3}
                  placeholder="USD"
                  value={accountForm.currencyCode}
                  onChange={(event) =>
                    setAccountForm({
                      ...accountForm,
                      currencyCode: event.target.value
                        .toUpperCase()
                        .replace(/[^A-Z]/g, ""),
                    })
                  }
                />
              </div>
            )}
            <div>
              <Label>
                {tr ? "Entegrasyon kasa anahtarı" : "Integration vault key"}
              </Label>
              <select
                className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={accountForm.integrationKey}
                onChange={(event) =>
                  setAccountForm({
                    ...accountForm,
                    integrationKey: event.target.value,
                  })
                }
              >
                <option value="">—</option>
                {(accountIntegrations.data?.data ?? [])
                  .filter(
                    (item) =>
                      ["social", "social_media"].includes(
                        item.category.toLowerCase(),
                      ) ||
                      ["instagram", "facebook_messenger"].includes(item.key),
                  )
                  .map((item) => (
                    <option key={item.key} value={item.key}>
                      {item.name} ({item.key})
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <Label>
                {tr ? "Harici hesap referansı" : "External account reference"}
              </Label>
              <Input
                className="mt-1"
                value={accountForm.externalAccountRef}
                onChange={(event) =>
                  setAccountForm({
                    ...accountForm,
                    externalAccountRef: event.target.value,
                  })
                }
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {tr
                  ? "Ham değer saklanmaz; yalnız SHA-256 özeti tutulur."
                  : "The raw value is not stored; only its SHA-256 digest is retained."}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAccountOpen(false)}>
              {tr ? "İptal" : "Cancel"}
            </Button>
            <Button
              disabled={
                createAccount.isPending ||
                !accountForm.provider ||
                !accountForm.accountKey ||
                !accountForm.displayName ||
                (accountForm.accountKind === "AD_ACCOUNT" &&
                  accountForm.currencyCode.length !== 3)
              }
              onClick={() => createAccount.mutate()}
            >
              {createAccount.isPending && (
                <Loader2 className="mr-2 size-4 animate-spin" />
              )}
              {tr ? "Kaydet" : "Register"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
