import { useState, useEffect, useCallback } from "react";
import { customFetch } from "@workspace/api-client-react";
import type {
  AiAgentConfig,
  AiAgentConfigUpdate,
  AiAgentScheduleDay,
  AiAgentTestResult,
  AiAgentTestRequestHistoryItem,
  KnowledgeSourceProgramScope,
  ProgramScope,
} from "@workspace/api-client-react";
import { useI18n } from "@/hooks/use-i18n";
import { getLocale, SUPPORTED_LANGUAGES } from "@/lib/i18n";
import {
  UI_DAY_ORDER,
  type WeekDayKey,
  listTimeZones,
  scheduleStatus,
  currentTimeInZone,
  weekdayLabel,
  weekdayLabelAtOffset,
} from "@/lib/aiSchedule";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useToast } from "@/hooks/use-toast";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { MultiSelectFilter } from "@/components/ui/multi-select-filter";
import KnowledgeSourcesRag from "@/components/admin/KnowledgeSourcesRag";
import CommunicationPipelineManager from "@/components/admin/CommunicationPipelineManager";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Clock,
  MessageSquare,
  Save,
  Play,
  AlertTriangle,
  Plus,
  Trash2,
  Database,
  RefreshCw,
  Bot,
  Copy,
} from "lucide-react";

type HistoryDirection = "inbound" | "outbound";

type EscalationTopicKey = "contract" | "payment" | "commission" | "partner" | "human_request" | "visa_documents" | "supplier";
const ESCALATION_TOPICS: EscalationTopicKey[] = [
  "contract",
  "payment",
  "commission",
  "partner",
  "human_request",
  "visa_documents",
  "supplier",
];
const TEST_LANGUAGES = SUPPORTED_LANGUAGES;
type TestLanguage = (typeof TEST_LANGUAGES)[number];
type AiAgentModelOption = {
  id: string;
  displayName: string;
  createdAt?: string;
  current: boolean;
};

type AiAgentMetrics = {
  days: number;
  handoffs: { total: number; byReason: Record<string, number>; byDay: Record<string, number> };
  promptCache: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    hitRate: number;
  };
  outputValidation: { retries: number };
};

type AiBotSummary = {
  id: number;
  name: string;
  slug: string;
  description?: string | null;
  isDefault: boolean;
  isActive: boolean;
};

function toBotSlug(value: string) {
  return value
    .toLocaleLowerCase("en-US")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

// Parse a textarea of comma/newline-separated keywords into a clean array.
function parseKeywords(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export default function AiAgent() {
  const { t, lang } = useI18n();
  const { toast } = useToast();

  const [bots, setBots] = useState<AiBotSummary[]>([]);
  const [selectedBotId, setSelectedBotId] = useState<number | null>(null);
  const [botsLoading, setBotsLoading] = useState(true);
  const [creatingBot, setCreatingBot] = useState(false);
  const [newBotName, setNewBotName] = useState("");
  const [newBotSlug, setNewBotSlug] = useState("");

  const [config, setConfig] = useState<AiAgentConfig | null>(null);
  const [keywordText, setKeywordText] = useState<Record<EscalationTopicKey, string>>({
    contract: "",
    payment: "",
    commission: "",
    partner: "",
    human_request: "",
    visa_documents: "",
    supplier: "",
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [modelOptions, setModelOptions] = useState<AiAgentModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsFallback, setModelsFallback] = useState(false);
  const [metrics, setMetrics] = useState<AiAgentMetrics | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(false);

  // Knowledge Sources — program_scope (FAZ 1 scaffold).
  const [programScopeSource, setProgramScopeSource] =
    useState<KnowledgeSourceProgramScope | null>(null);
  const [scopeLoading, setScopeLoading] = useState(true);
  const [scopeSaving, setScopeSaving] = useState(false);
  const [filterOptions, setFilterOptions] = useState<{
    countries: string[];
    universityTypes: string[];
  }>({ countries: [], universityTypes: [] });

  // Test console state.
  const [testMessage, setTestMessage] = useState("");
  const [testLanguage, setTestLanguage] = useState<TestLanguage | "auto">("auto");
  const [testHistory, setTestHistory] = useState<AiAgentTestRequestHistoryItem[]>([]);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<AiAgentTestResult | null>(null);

  const addHistoryTurn = () =>
    setTestHistory((prev) => [...prev, { direction: "inbound", content: "" }]);
  const updateHistoryTurn = (
    index: number,
    patch: Partial<AiAgentTestRequestHistoryItem>,
  ) =>
    setTestHistory((prev) =>
      prev.map((turn, i) => (i === index ? { ...turn, ...patch } : turn)),
    );
  const removeHistoryTurn = (index: number) =>
    setTestHistory((prev) => prev.filter((_, i) => i !== index));

  const loadBots = useCallback(async () => {
    setBotsLoading(true);
    try {
      const { bots: rows } = await customFetch<{ bots: AiBotSummary[] }>("/api/ai-bots");
      setBots(rows);
      setSelectedBotId((current) => {
        if (current && rows.some((bot) => bot.id === current)) return current;
        return rows.find((bot) => bot.isDefault)?.id ?? rows.find((bot) => bot.isActive)?.id ?? rows[0]?.id ?? null;
      });
    } catch {
      toast({ title: t("aiAgentAdmin.botManagement.loadError"), variant: "destructive" });
    } finally {
      setBotsLoading(false);
    }
  }, [t, toast]);

  const load = useCallback(async () => {
    if (!selectedBotId) return;
    setLoading(true);
    try {
      const { config: cfg } = await customFetch<{ config: AiAgentConfig }>(
        `/api/ai-bots/${selectedBotId}/config`,
      );
      setConfig(cfg);
      setKeywordText({
        contract: (cfg.escalationKeywords.contract ?? []).join(", "),
        payment: (cfg.escalationKeywords.payment ?? []).join(", "),
        commission: (cfg.escalationKeywords.commission ?? []).join(", "),
        partner: (cfg.escalationKeywords.partner ?? []).join(", "),
        human_request: (cfg.escalationKeywords.human_request ?? []).join(", "),
        visa_documents: (cfg.escalationKeywords.visa_documents ?? []).join(", "),
        supplier: (cfg.escalationKeywords.supplier ?? []).join(", "),
      });
    } catch {
      toast({ title: t("aiAgentAdmin.loadError"), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [selectedBotId, t, toast]);

  const loadProgramScope = useCallback(async () => {
    if (!selectedBotId) return;
    setScopeLoading(true);
    try {
      const [{ source }, filters] = await Promise.all([
        customFetch<{ source: KnowledgeSourceProgramScope }>(
          `/api/inbox/knowledge-sources/program-scope?aiBotId=${selectedBotId}`,
        ),
        customFetch<{ countries?: string[]; universityTypes?: string[] }>(
          "/api/course-finder/filters",
        ).catch(() => ({ countries: [], universityTypes: [] })),
      ]);
      setProgramScopeSource(source);
      setFilterOptions({
        countries: filters.countries ?? [],
        universityTypes: filters.universityTypes ?? [],
      });
    } catch {
      toast({ title: t("aiAgentAdmin.knowledgeSources.loadError"), variant: "destructive" });
    } finally {
      setScopeLoading(false);
    }
  }, [selectedBotId, t, toast]);

  const loadModels = useCallback(async () => {
    setModelsLoading(true);
    try {
      const result = await customFetch<{
        source: "provider" | "current_config";
        models: AiAgentModelOption[];
      }>("/api/inbox/ai-agent/models");
      setModelOptions(result.models);
      setModelsFallback(result.source !== "provider");
    } catch {
      // The current configured model is injected below as a local fallback, so
      // a transient provider/list request failure can never clear the setting.
      setModelOptions([]);
      setModelsFallback(true);
    } finally {
      setModelsLoading(false);
    }
  }, []);

  const loadMetrics = useCallback(async () => {
    if (!selectedBotId) return;
    setMetricsLoading(true);
    try {
      const result = await customFetch<{ metrics: AiAgentMetrics }>(
        `/api/inbox/ai-agent/metrics?aiBotId=${selectedBotId}&days=30`,
      );
      setMetrics(result.metrics);
    } catch {
      setMetrics(null);
    } finally {
      setMetricsLoading(false);
    }
  }, [selectedBotId]);

  useEffect(() => {
    loadBots();
    loadModels();
  }, [loadBots, loadModels]);

  useEffect(() => {
    if (!selectedBotId) return;
    setConfig(null);
    setProgramScopeSource(null);
    setTestResult(null);
    setTestHistory([]);
    load();
    loadProgramScope();
    loadMetrics();
  }, [load, loadMetrics, loadProgramScope, selectedBotId]);

  const patch = (p: Partial<AiAgentConfig>) =>
    setConfig((prev) => (prev ? { ...prev, ...p } : prev));

  // Working-hours schedule helpers -----------------------------------------
  const locale = getLocale(lang);
  const timeZoneOptions = listTimeZones().map((tz) => ({ value: tz, label: tz }));

  // Live clock tick so the "current time in timezone" preview and the
  // ACTIVE/PASSIVE badge stay fresh without a reload.
  const [nowTick, setNowTick] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNowTick(new Date()), 15000);
    return () => clearInterval(id);
  }, []);

  const patchScheduleDay = (day: WeekDayKey, p: Partial<AiAgentScheduleDay>) =>
    setConfig((prev) =>
      prev
        ? {
            ...prev,
            schedule: { ...prev.schedule, [day]: { ...prev.schedule[day], ...p } },
          }
        : prev,
    );

  // "Apply Monday to all days" convenience.
  const applyMondayToAll = () =>
    setConfig((prev) => {
      if (!prev) return prev;
      const src = prev.schedule.mon;
      const next = { ...prev.schedule };
      for (const k of UI_DAY_ORDER) next[k] = { ...src };
      return { ...prev, schedule: next };
    });

  const scheduleInvalidDays = config
    ? UI_DAY_ORDER.filter(
        (k) => config.schedule[k].enabled && config.schedule[k].start === config.schedule[k].end,
      )
    : [];

  const status =
    config && config.scheduleEnabled
      ? scheduleStatus(config.schedule, config.timezone, nowTick)
      : null;

  const nextChangeLabel = (() => {
    if (!status || !status.next || !config) return null;
    const time = status.next.time;
    if (status.next.dayOffset === 0) return t("aiAgentAdmin.schedule.whenToday", { time });
    if (status.next.dayOffset === 1) return t("aiAgentAdmin.schedule.whenTomorrow", { time });
    return t("aiAgentAdmin.schedule.whenOnDay", {
      day: weekdayLabelAtOffset(config.timezone, status.next.dayOffset, locale, nowTick),
      time,
    });
  })();

  const patchScope = (p: Partial<ProgramScope>) =>
    setProgramScopeSource((prev) =>
      prev ? { ...prev, scope: { ...prev.scope, ...p } } : prev,
    );

  const saveProgramScope = async () => {
    if (!programScopeSource) return;
    setScopeSaving(true);
    try {
      const { source } = await customFetch<{ source: KnowledgeSourceProgramScope }>(
        `/api/inbox/knowledge-sources/program-scope?aiBotId=${selectedBotId}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            isActive: programScopeSource.isActive,
            scope: programScopeSource.scope,
          }),
        },
      );
      setProgramScopeSource(source);
      toast({ title: t("aiAgentAdmin.knowledgeSources.saveSuccess") });
    } catch {
      toast({ title: t("aiAgentAdmin.knowledgeSources.saveError"), variant: "destructive" });
    } finally {
      setScopeSaving(false);
    }
  };

  const save = async () => {
    if (!config || !selectedBotId) return;
    if (config.scheduleEnabled && scheduleInvalidDays.length > 0) {
      toast({
        title: t("aiAgentAdmin.schedule.invalidRange"),
        variant: "destructive",
      });
      return;
    }
    setSaving(true);
    try {
      const body: AiAgentConfigUpdate = {
        enabled: config.enabled,
        defaultOnForNew: config.defaultOnForNew,
        model: config.model,
        temperature: config.temperature,
        maxConsecutiveReplies: config.maxConsecutiveReplies,
        handoffMessage: config.handoffMessage,
        handoffMessages: config.handoffMessages,
        knowledgeBase: config.knowledgeBase,
        scheduleEnabled: config.scheduleEnabled,
        timezone: config.timezone,
        schedule: config.schedule,
        escalationKeywords: {
          contract: parseKeywords(keywordText.contract),
          payment: parseKeywords(keywordText.payment),
          commission: parseKeywords(keywordText.commission),
          partner: parseKeywords(keywordText.partner),
          human_request: parseKeywords(keywordText.human_request),
          visa_documents: parseKeywords(keywordText.visa_documents),
          supplier: parseKeywords(keywordText.supplier),
        },
      };
      const { config: cfg } = await customFetch<{ config: AiAgentConfig }>(
        `/api/ai-bots/${selectedBotId}/config`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      setConfig(cfg);
      toast({ title: t("aiAgentAdmin.saveSuccess") });
    } catch {
      toast({ title: t("aiAgentAdmin.saveError"), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    if (!testMessage.trim()) return;
    setTesting(true);
    setTestResult(null);
    try {
      const body: {
        message: string;
        language?: TestLanguage;
        history?: AiAgentTestRequestHistoryItem[];
      } = {
        message: testMessage.trim(),
      };
      if (testLanguage !== "auto") body.language = testLanguage;
      const cleanHistory = testHistory
        .map((turn) => ({ ...turn, content: turn.content.trim() }))
        .filter((turn) => turn.content.length > 0);
      if (cleanHistory.length > 0) body.history = cleanHistory;
      const { result } = await customFetch<{ result: AiAgentTestResult }>(
        `/api/inbox/ai-agent/test?aiBotId=${selectedBotId}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      setTestResult(result);
    } catch {
      toast({ title: t("aiAgentAdmin.testError"), variant: "destructive" });
    } finally {
      setTesting(false);
    }
  };

  const createBot = async () => {
    if (newBotName.trim().length < 2 || newBotSlug.trim().length < 2) return;
    setCreatingBot(true);
    try {
      const { bot } = await customFetch<{ bot: AiBotSummary }>("/api/ai-bots", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: newBotName.trim(),
          slug: newBotSlug.trim(),
          ...(selectedBotId ? { cloneFromBotId: selectedBotId } : {}),
        }),
      });
      setNewBotName("");
      setNewBotSlug("");
      await loadBots();
      setSelectedBotId(bot.id);
      toast({
        title: t("aiAgentAdmin.botManagement.createSuccess", { name: bot.name }),
        description: selectedBotId
          ? t("aiAgentAdmin.botManagement.cloneSuccessDescription")
          : t("aiAgentAdmin.botManagement.firstBotSuccessDescription"),
      });
    } catch (error) {
      toast({
        title: t("aiAgentAdmin.botManagement.createError"),
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    } finally {
      setCreatingBot(false);
    }
  };

  const updateBot = async (botId: number, update: Partial<AiBotSummary>) => {
    try {
      await customFetch(`/api/ai-bots/${botId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(update),
      });
      await loadBots();
      toast({ title: t("aiAgentAdmin.botManagement.updateSuccess") });
    } catch (error) {
      toast({
        title: t("aiAgentAdmin.botManagement.updateError"),
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    }
  };

  if (botsLoading) {
    return (
      <div className="space-y-4 py-4">
        {[...Array(4)].map((_, i) => (
          <Skeleton key={i} className="h-24 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  if (!selectedBotId) {
    return (
      <div className="space-y-6 py-2 max-w-4xl">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-primary/10 p-2.5">
            <Bot className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">{t("aiAgentAdmin.botManagement.emptyTitle")}</h1>
            <p className="text-sm text-muted-foreground">
              {t("aiAgentAdmin.botManagement.emptySubtitle")}
            </p>
          </div>
        </div>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("aiAgentAdmin.botManagement.firstBotTitle")}</CardTitle>
            <CardDescription>
              {t("aiAgentAdmin.botManagement.firstBotDescription")}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
            <Input
              value={newBotName}
              onChange={(event) => {
                setNewBotName(event.target.value);
                setNewBotSlug(toBotSlug(event.target.value));
              }}
              placeholder={t("aiAgentAdmin.botManagement.namePlaceholder")}
            />
            <Input
              value={newBotSlug}
              onChange={(event) => setNewBotSlug(toBotSlug(event.target.value))}
              placeholder="dorm-booking"
            />
            <Button onClick={createBot} disabled={creatingBot || newBotName.trim().length < 2}>
              <Plus className="mr-2 h-4 w-4" />
              {t("aiAgentAdmin.botManagement.create")}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (loading || !config) {
    return (
      <div className="space-y-4 py-4">
        {[...Array(4)].map((_, i) => (
          <Skeleton key={i} className="h-24 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  const selectedBot = bots.find((bot) => bot.id === selectedBotId)!;

  const selectableModels = modelOptions.some((model) => model.id === config.model)
    ? modelOptions
    : [
        {
          id: config.model,
          displayName: config.model,
          current: true,
        },
        ...modelOptions,
      ];

  return (
    <div className="space-y-6 py-2 max-w-4xl">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-primary/10 p-2.5">
            <MessageSquare className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">{t("aiAgentAdmin.title")}</h1>
            <p className="text-sm text-muted-foreground">
              {t("aiAgentAdmin.subtitle")}
            </p>
          </div>
        </div>
        <Button onClick={save} disabled={saving} className="shrink-0">
          <Save className="h-4 w-4 mr-2" />
          {saving ? t("aiAgentAdmin.saving") : t("aiAgentAdmin.save")}
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Bot className="h-4 w-4" />
            {t("aiAgentAdmin.botManagement.title")}
          </CardTitle>
          <CardDescription>
            {t("aiAgentAdmin.botManagement.description")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
            <Select
              value={String(selectedBotId)}
              onValueChange={(value) => setSelectedBotId(Number(value))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {bots.map((bot) => (
                  <SelectItem key={bot.id} value={String(bot.id)}>
                    {bot.name}{bot.isDefault ? ` · ${t("aiAgentAdmin.botManagement.defaultBadge")}` : ""}{!bot.isActive ? ` · ${t("aiAgentAdmin.botManagement.inactive")}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="outline"
              disabled={selectedBot.isDefault}
              onClick={() => updateBot(selectedBot.id, { isDefault: true })}
            >
              {t("aiAgentAdmin.botManagement.makeDefault")}
            </Button>
            <div className="flex items-center gap-2 rounded-md border px-3">
              <Switch
                checked={selectedBot.isActive}
                onCheckedChange={(isActive) => updateBot(selectedBot.id, { isActive })}
              />
              <span className="text-sm">
                {selectedBot.isActive
                  ? t("aiAgentAdmin.botManagement.active")
                  : t("aiAgentAdmin.botManagement.inactive")}
              </span>
            </div>
          </div>

          <Separator />

          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Copy className="h-4 w-4" />
              {t("aiAgentAdmin.botManagement.cloneTitle")}
            </div>
            <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
              <Input
                value={newBotName}
                onChange={(event) => {
                  setNewBotName(event.target.value);
                  setNewBotSlug(toBotSlug(event.target.value));
                }}
                placeholder={t("aiAgentAdmin.botManagement.namePlaceholder")}
              />
              <Input
                value={newBotSlug}
                onChange={(event) => setNewBotSlug(toBotSlug(event.target.value))}
                placeholder="dorm-booking"
              />
              <Button
                type="button"
                onClick={createBot}
                disabled={creatingBot || newBotName.trim().length < 2 || newBotSlug.trim().length < 2}
              >
                <Plus className="mr-2 h-4 w-4" />
                {t("aiAgentAdmin.botManagement.cloneAndCreate")}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">{t("aiAgentAdmin.metrics.title")}</CardTitle>
              <CardDescription>{t("aiAgentAdmin.metrics.description")}</CardDescription>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={loadMetrics} disabled={metricsLoading}>
              <RefreshCw className={`mr-2 h-4 w-4 ${metricsLoading ? "animate-spin" : ""}`} />
              {t("aiAgentAdmin.metrics.refresh")}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">{t("aiAgentAdmin.metrics.handoffs")}</p>
              <p className="mt-1 text-2xl font-semibold">{metrics?.handoffs.total ?? "—"}</p>
            </div>
            <div className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">{t("aiAgentAdmin.metrics.cacheHitRate")}</p>
              <p className="mt-1 text-2xl font-semibold">
                {metrics ? `${(metrics.promptCache.hitRate * 100).toFixed(1)}%` : "—"}
              </p>
            </div>
            <div className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">{t("aiAgentAdmin.metrics.validationRetries")}</p>
              <p className="mt-1 text-2xl font-semibold">{metrics?.outputValidation.retries ?? "—"}</p>
            </div>
          </div>
          {metrics && Object.keys(metrics.handoffs.byReason).length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {Object.entries(metrics.handoffs.byReason)
                .sort((a, b) => b[1] - a[1])
                .map(([reason, count]) => <Badge key={reason} variant="secondary">{reason}: {count}</Badge>)}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t("aiAgentAdmin.metrics.noHandoffs")}</p>
          )}
        </CardContent>
      </Card>

      {/* Global settings */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            {t("aiAgentAdmin.globalTitle")}
          </CardTitle>
          <CardDescription>{t("aiAgentAdmin.globalHint")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="font-medium">{t("aiAgentAdmin.enabledLabel")}</p>
              <p className="text-sm text-muted-foreground mt-0.5">
                {t("aiAgentAdmin.enabledHint")}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Switch
                checked={config.enabled}
                onCheckedChange={(v) => patch({ enabled: v })}
              />
              <Badge variant={config.enabled ? "default" : "secondary"}>
                {config.enabled ? t("aiAgentAdmin.statusOn") : t("aiAgentAdmin.statusOff")}
              </Badge>
            </div>
          </div>

          <Separator />

          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="font-medium">
                {t("aiAgentAdmin.defaultOnForNewLabel")}
              </p>
              <p className="text-sm text-muted-foreground mt-0.5">
                {t("aiAgentAdmin.defaultOnForNewHint")}
              </p>
            </div>
            <Switch
              checked={config.defaultOnForNew}
              onCheckedChange={(v) => patch({ defaultOnForNew: v })}
            />
          </div>

          <Separator />

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="model">{t("aiAgentAdmin.modelLabel")}</Label>
              <div className="flex gap-2">
                <Select
                  value={config.model}
                  onValueChange={(model) => patch({ model })}
                  disabled={modelsLoading}
                >
                  <SelectTrigger id="model" className="min-w-0">
                    <SelectValue
                      placeholder={modelsLoading ? "Loading models..." : "Select a model"}
                    />
                  </SelectTrigger>
                  <SelectContent className="max-h-80">
                    {selectableModels.map((model) => (
                      <SelectItem key={model.id} value={model.id}>
                        {model.displayName === model.id
                          ? model.id
                          : `${model.displayName} — ${model.id}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="shrink-0"
                  onClick={loadModels}
                  disabled={modelsLoading}
                  title="Refresh available models"
                  aria-label="Refresh available models"
                >
                  <RefreshCw
                    className={`h-4 w-4 ${modelsLoading ? "animate-spin" : ""}`}
                  />
                </Button>
              </div>
              {modelsFallback && (
                <p className="text-xs text-amber-700">
                  Live model list is unavailable; the saved model remains selected.
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="temperature">
                {t("aiAgentAdmin.temperatureLabel")}
              </Label>
              <Input
                id="temperature"
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={config.temperature}
                onChange={(e) =>
                  patch({ temperature: Number(e.target.value) })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="maxReplies">
                {t("aiAgentAdmin.maxConsecutiveRepliesLabel")}
              </Label>
              <Input
                id="maxReplies"
                type="number"
                min={0}
                max={100}
                step={1}
                value={config.maxConsecutiveReplies}
                onChange={(e) =>
                  patch({
                    maxConsecutiveReplies: Math.trunc(Number(e.target.value)),
                  })
                }
              />
            </div>
          </div>

          <div className="space-y-3">
            <Label>{t("aiAgentAdmin.handoffMessageLabel")}</Label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {TEST_LANGUAGES.map((language) => (
                <div key={language} className="space-y-1">
                  <Label htmlFor={`handoff-${language}`} className="uppercase text-xs text-muted-foreground">{language}</Label>
                  <Textarea
                    id={`handoff-${language}`}
                    rows={2}
                    dir={["ar", "fa"].includes(language) ? "rtl" : "ltr"}
                    value={config.handoffMessages[language]}
                    onChange={(e) => patch({
                      handoffMessages: { ...config.handoffMessages, [language]: e.target.value },
                      ...(language === "en" ? { handoffMessage: e.target.value } : {}),
                    })}
                  />
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {t("aiAgentAdmin.handoffMessageHint")}
            </p>
          </div>

          <Separator />

          {/* Working-hours schedule */}
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="font-medium flex items-center gap-2">
                  <Clock className="h-4 w-4 text-muted-foreground" />
                  {t("aiAgentAdmin.schedule.title")}
                </p>
                <p className="text-sm text-muted-foreground mt-0.5">
                  {t("aiAgentAdmin.schedule.hint")}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {config.scheduleEnabled && status && (
                  <Badge variant={status.active ? "default" : "secondary"}>
                    {status.active
                      ? t("aiAgentAdmin.schedule.statusActive")
                      : t("aiAgentAdmin.schedule.statusInactive")}
                  </Badge>
                )}
                <Switch
                  checked={config.scheduleEnabled}
                  onCheckedChange={(v) => patch({ scheduleEnabled: v })}
                />
              </div>
            </div>

            {config.scheduleEnabled && (
              <>
                {status && nextChangeLabel && (
                  <p className="text-sm text-muted-foreground">
                    {status.active
                      ? t("aiAgentAdmin.schedule.nextOff", { when: nextChangeLabel })
                      : t("aiAgentAdmin.schedule.nextOn", { when: nextChangeLabel })}
                  </p>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-end">
                  <div className="space-y-1.5">
                    <Label>{t("aiAgentAdmin.schedule.timezoneLabel")}</Label>
                    <SearchableSelect
                      value={config.timezone}
                      onChange={(v) => v && patch({ timezone: v })}
                      options={timeZoneOptions}
                      placeholder={t("aiAgentAdmin.schedule.timezoneLabel")}
                      searchPlaceholder={t("aiAgentAdmin.schedule.timezoneSearch")}
                    />
                    <p className="text-xs text-muted-foreground">
                      {t("aiAgentAdmin.schedule.nowInTz", {
                        time: currentTimeInZone(config.timezone, locale, nowTick),
                      })}
                    </p>
                  </div>
                  <div className="flex sm:justify-end">
                    <Button type="button" variant="outline" size="sm" onClick={applyMondayToAll}>
                      {t("aiAgentAdmin.schedule.applyToAll")}
                    </Button>
                  </div>
                </div>

                <div className="space-y-2">
                  {UI_DAY_ORDER.map((day) => {
                    const row = config.schedule[day];
                    const invalid = row.enabled && row.start === row.end;
                    return (
                      <div
                        key={day}
                        className="flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2"
                      >
                        <Switch
                          checked={row.enabled}
                          onCheckedChange={(v) => patchScheduleDay(day, { enabled: v })}
                        />
                        <span className="w-28 text-sm font-medium capitalize">
                          {weekdayLabel(day, locale)}
                        </span>
                        {row.enabled ? (
                          <div className="flex items-center gap-2">
                            <Input
                              type="time"
                              className="w-28"
                              value={row.start}
                              onChange={(e) =>
                                patchScheduleDay(day, { start: e.target.value })
                              }
                            />
                            <span className="text-muted-foreground">–</span>
                            <Input
                              type="time"
                              className="w-28"
                              value={row.end}
                              onChange={(e) =>
                                patchScheduleDay(day, { end: e.target.value })
                              }
                            />
                            {invalid && (
                              <span className="text-xs text-destructive">
                                {t("aiAgentAdmin.schedule.invalidRange")}
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-sm text-muted-foreground">
                            {t("aiAgentAdmin.schedule.closed")}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>

                <p className="text-xs text-muted-foreground">
                  {t("aiAgentAdmin.schedule.overnightHint")}
                </p>
              </>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Knowledge base */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            {t("aiAgentAdmin.knowledgeBaseTitle")}
          </CardTitle>
          <CardDescription>
            {t("aiAgentAdmin.knowledgeBaseHint")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Textarea
            rows={14}
            className="font-mono text-sm"
            value={config.knowledgeBase}
            onChange={(e) => patch({ knowledgeBase: e.target.value })}
            placeholder={t("aiAgentAdmin.knowledgeBasePlaceholder")}
          />
          <p className="text-xs text-muted-foreground mt-1.5">
            {config.knowledgeBase.length} / 200000
          </p>
        </CardContent>
      </Card>

      {/* Knowledge Sources — program_scope (FAZ 1 scaffold) */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Database className="h-4 w-4 text-primary" />
            <CardTitle className="text-base">
              {t("aiAgentAdmin.knowledgeSources.title")}
            </CardTitle>
          </div>
          <CardDescription>
            {t("aiAgentAdmin.knowledgeSources.hint")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {scopeLoading || !programScopeSource ? (
            <Skeleton className="h-32 w-full rounded-xl" />
          ) : (
            <>
              <div className="flex items-center justify-between gap-4 rounded-xl border p-3">
                <div>
                  <p className="font-medium text-sm">
                    {t("aiAgentAdmin.knowledgeSources.programScopeLabel")}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {t("aiAgentAdmin.knowledgeSources.programScopeHint")}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Switch
                    checked={programScopeSource.isActive && programScopeSource.scope.enabled}
                    onCheckedChange={(v) => {
                      setProgramScopeSource((prev) =>
                        prev
                          ? { ...prev, isActive: v, scope: { ...prev.scope, enabled: v } }
                          : prev,
                      );
                    }}
                  />
                  <Badge
                    variant={
                      programScopeSource.isActive && programScopeSource.scope.enabled
                        ? "default"
                        : "secondary"
                    }
                  >
                    {programScopeSource.isActive && programScopeSource.scope.enabled
                      ? t("aiAgentAdmin.statusOn")
                      : t("aiAgentAdmin.statusOff")}
                  </Badge>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>{t("aiAgentAdmin.knowledgeSources.countriesLabel")}</Label>
                  <MultiSelectFilter
                    values={
                      programScopeSource.scope.countries === "all"
                        ? []
                        : programScopeSource.scope.countries
                    }
                    onChange={(vals) =>
                      patchScope({ countries: vals.length ? vals : "all" })
                    }
                    options={filterOptions.countries.map((c) => ({ value: c, label: c }))}
                    placeholder={t("aiAgentAdmin.knowledgeSources.allCountries")}
                  />
                  <p className="text-xs text-muted-foreground">
                    {programScopeSource.scope.countries === "all"
                      ? t("aiAgentAdmin.knowledgeSources.allCountries")
                      : t("aiAgentAdmin.knowledgeSources.selectedCount", {
                          count: programScopeSource.scope.countries.length,
                        })}
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label>{t("aiAgentAdmin.knowledgeSources.universityTypesLabel")}</Label>
                  <MultiSelectFilter
                    values={
                      programScopeSource.scope.universityTypes === "all"
                        ? []
                        : programScopeSource.scope.universityTypes
                    }
                    onChange={(vals) =>
                      patchScope({ universityTypes: vals.length ? vals : "all" })
                    }
                    options={filterOptions.universityTypes.map((c) => ({ value: c, label: c }))}
                    placeholder={t("aiAgentAdmin.knowledgeSources.allUniversityTypes")}
                  />
                  <p className="text-xs text-muted-foreground">
                    {programScopeSource.scope.universityTypes === "all"
                      ? t("aiAgentAdmin.knowledgeSources.allUniversityTypes")
                      : t("aiAgentAdmin.knowledgeSources.selectedCount", {
                          count: programScopeSource.scope.universityTypes.length,
                        })}
                  </p>
                </div>
              </div>

              {programScopeSource.lastSyncedAt && (
                <p className="text-xs text-muted-foreground">
                  {t("aiAgentAdmin.knowledgeSources.lastSyncedAt", {
                    date: new Date(programScopeSource.lastSyncedAt).toLocaleString(),
                  })}
                </p>
              )}

              <div className="flex justify-end">
                <Button onClick={saveProgramScope} disabled={scopeSaving} size="sm">
                  <Save className="h-4 w-4 mr-2" />
                  {scopeSaving
                    ? t("aiAgentAdmin.saving")
                    : t("aiAgentAdmin.knowledgeSources.save")}
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Knowledge Sources — external RAG (FAZ 2) */}
      <KnowledgeSourcesRag aiBotId={selectedBotId} />

      <CommunicationPipelineManager aiBotId={selectedBotId} />

      {/* Escalation keywords */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            {t("aiAgentAdmin.escalationTitle")}
          </CardTitle>
          <CardDescription>
            {t("aiAgentAdmin.escalationHint")}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {ESCALATION_TOPICS.map((topic) => (
            <div key={topic} className="space-y-1.5">
              <Label htmlFor={`kw-${topic}`}>
                {t(`aiAgentAdmin.topic.${topic}`)}
              </Label>
              <Textarea
                id={`kw-${topic}`}
                rows={3}
                value={keywordText[topic]}
                onChange={(e) =>
                  setKeywordText((prev) => ({ ...prev, [topic]: e.target.value }))
                }
                placeholder={t("aiAgentAdmin.escalationPlaceholder")}
              />
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Test console */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            {t("aiAgentAdmin.testTitle")}
          </CardTitle>
          <CardDescription>{t("aiAgentAdmin.testHint")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div>
                <Label>{t("aiAgentAdmin.testHistoryLabel")}</Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {t("aiAgentAdmin.testHistoryHint")}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addHistoryTurn}
                className="shrink-0"
              >
                <Plus className="h-4 w-4 mr-1.5" />
                {t("aiAgentAdmin.testHistoryAdd")}
              </Button>
            </div>
            {testHistory.length === 0 ? (
              <p className="text-xs italic text-muted-foreground">
                {t("aiAgentAdmin.testHistoryEmpty")}
              </p>
            ) : (
              <div className="space-y-2">
                {testHistory.map((turn, index) => (
                  <div key={index} className="flex items-start gap-2">
                    <Select
                      value={turn.direction}
                      onValueChange={(v) =>
                        updateHistoryTurn(index, {
                          direction: v as HistoryDirection,
                        })
                      }
                    >
                      <SelectTrigger className="w-32 shrink-0">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="inbound">
                          {t("aiAgentAdmin.testHistoryInbound")}
                        </SelectItem>
                        <SelectItem value="outbound">
                          {t("aiAgentAdmin.testHistoryOutbound")}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <Input
                      value={turn.content}
                      onChange={(e) =>
                        updateHistoryTurn(index, { content: e.target.value })
                      }
                      placeholder={t("aiAgentAdmin.testHistoryContentPlaceholder")}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => removeHistoryTurn(index)}
                      className="shrink-0"
                      aria-label={t("aiAgentAdmin.testHistoryRemove")}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="testMessage">
              {t("aiAgentAdmin.testMessageLabel")}
            </Label>
            <Textarea
              id="testMessage"
              rows={3}
              value={testMessage}
              onChange={(e) => setTestMessage(e.target.value)}
              placeholder={t("aiAgentAdmin.testMessagePlaceholder")}
            />
          </div>
          <div className="flex items-end gap-3">
            <div className="space-y-1.5 w-40">
              <Label>{t("aiAgentAdmin.testLanguageLabel")}</Label>
              <Select
                value={testLanguage}
                onValueChange={(v) => setTestLanguage(v as TestLanguage | "auto")}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">
                    {t("aiAgentAdmin.testLanguageAuto")}
                  </SelectItem>
                  {TEST_LANGUAGES.map((lang) => (
                    <SelectItem key={lang} value={lang}>
                      {lang.toUpperCase()}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              onClick={runTest}
              disabled={testing || !testMessage.trim()}
              variant="secondary"
            >
              <Play className="h-4 w-4 mr-2" />
              {testing ? t("aiAgentAdmin.testRunning") : t("aiAgentAdmin.testRun")}
            </Button>
          </div>

          {testResult && (
            <div className="rounded-xl border bg-muted/30 p-4 space-y-3">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant="outline">
                  {t("aiAgentAdmin.testDetectedLanguage")}:{" "}
                  {testResult.language.toUpperCase()}
                </Badge>
                {testResult.escalation.escalated ? (
                  <Badge variant="destructive" className="gap-1">
                    <AlertTriangle className="h-3 w-3" />
                    {t("aiAgentAdmin.testEscalated")}
                    {testResult.escalation.topic
                      ? `: ${t(`aiAgentAdmin.topic.${testResult.escalation.topic}` as string)}`
                      : ""}
                  </Badge>
                ) : (
                  <Badge variant="secondary">
                    {t("aiAgentAdmin.testNoEscalation")}
                  </Badge>
                )}
                <Badge variant="outline">{testResult.model}</Badge>
              </div>
              <Separator />
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">
                  {t("aiAgentAdmin.testReplyLabel")}
                </p>
                {testResult.reply ? (
                  <p className="text-sm whitespace-pre-wrap">{testResult.reply}</p>
                ) : (
                  <p className="text-sm italic text-muted-foreground">
                    {t("aiAgentAdmin.testNoReply")}
                  </p>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {t("aiAgentAdmin.testNoSendNote")}
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
