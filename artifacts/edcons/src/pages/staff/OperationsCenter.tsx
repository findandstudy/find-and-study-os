import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  customFetch,
  type PortalOperationsResponse,
} from "@workspace/api-client-react";
import { ADMIN_ROLES } from "@workspace/roles";
import { useAuth } from "@/hooks/use-auth";
import { useI18n } from "@/hooks/use-i18n";
import type { OperationsQueueItem } from "@/lib/operationsQueue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  CheckCircle2,
  Clock3,
  FileCheck2,
  FileWarning,
  GraduationCap,
  Inbox,
  Link2,
  ListChecks,
  MessageCircle,
  RefreshCw,
  Search,
  ShieldCheck,
  UserRoundCheck,
  Users,
} from "lucide-react";

type ApplicationPipelineSummary = {
  meta: {
    stages?: Array<{ stage: string; total: number }>;
  };
};

type Document = {
  id: number;
  name?: string | null;
  type?: string | null;
  status?: string | null;
  applicationId?: number | null;
  studentId?: number | null;
  updatedAt?: string | null;
  createdAt?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
};

type Stage = {
  key: string;
  label: string;
  sortOrder: number;
  isCaseClose: boolean;
};

type OfferDeadline = {
  docId: number;
  applicationId: number;
  universityName?: string | null;
  programName?: string | null;
  studentFirstName?: string | null;
  studentLastName?: string | null;
  validUntil?: string | null;
  daysLeft?: number | null;
};

type Integration = {
  id: number;
  key: string;
  name: string;
  category: string;
  isEnabled: boolean;
  updatedAt?: string | null;
};

type OperationsWorkResponse = {
  schemaVersion: number;
  asOf: string;
  generatedAt: string;
  items: OperationsQueueItem[];
  summary: {
    total: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
    mine: number;
    tasks: number;
    applications: number;
    documents: number;
    portal: number;
    offers: number;
  };
  meta: {
    limit: number;
    total: number;
    hasMore: boolean;
    nextCursor: string | null;
  };
};

function operationsWorkPath(input: {
  scope: "all" | "mine";
  search?: string;
  severity?: "all" | OperationsQueueItem["severity"];
  source?: "all" | OperationsQueueItem["source"];
  cursor?: string | null;
}): string {
  const params = new URLSearchParams({ scope: input.scope, limit: "50" });
  if (input.search?.trim()) params.set("search", input.search.trim());
  if (input.severity && input.severity !== "all")
    params.set("severity", input.severity);
  if (input.source && input.source !== "all")
    params.set("source", input.source);
  if (input.cursor) params.set("cursor", input.cursor);
  return `/api/operations/work-items?${params.toString()}`;
}

const severityClass: Record<OperationsQueueItem["severity"], string> = {
  critical:
    "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300",
  high: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-300",
  medium:
    "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950/50 dark:text-blue-300",
  low: "border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300",
};

const sourceClass: Record<OperationsQueueItem["source"], string> = {
  task: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  application: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  document:
    "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  portal:
    "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300",
  offer: "bg-cyan-100 text-cyan-700 dark:bg-cyan-950 dark:text-cyan-300",
};

const statusClass: Record<string, string> = {
  approved: "bg-emerald-100 text-emerald-700",
  verified: "bg-emerald-100 text-emerald-700",
  accepted: "bg-emerald-100 text-emerald-700",
  rejected: "bg-red-100 text-red-700",
  quarantined: "bg-red-100 text-red-700",
  pending: "bg-amber-100 text-amber-700",
  review_required: "bg-amber-100 text-amber-700",
  needs_review: "bg-amber-100 text-amber-700",
  scanning: "bg-blue-100 text-blue-700",
};

function safeDate(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "—";
}

function countBy<T>(rows: T[], read: (row: T) => string): Map<string, number> {
  const result = new Map<string, number>();
  for (const row of rows)
    result.set(read(row), (result.get(read(row)) ?? 0) + 1);
  return result;
}

function QueueTable({
  rows,
  empty,
}: {
  rows: OperationsQueueItem[];
  empty: string;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-dashed p-10 text-center">
        <CheckCircle2 className="mx-auto size-8 text-emerald-500" />
        <p className="mt-3 text-sm font-medium">{empty}</p>
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-xl border">
      <table className="w-full min-w-[1080px] text-sm">
        <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2.5 font-medium">Kimlik / kayıt</th>
            <th className="px-3 py-2.5 font-medium">Durum</th>
            <th className="px-3 py-2.5 font-medium">Sonraki aksiyon</th>
            <th className="px-3 py-2.5 font-medium">Sahip / kuyruk</th>
            <th className="px-3 py-2.5 font-medium">Tarih</th>
            <th className="px-3 py-2.5 font-medium">Risk / engel</th>
            <th className="px-3 py-2.5 font-medium">Son hareket</th>
            <th className="w-10 px-3 py-2.5" />
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((row) => (
            <tr key={row.id} className="align-top hover:bg-muted/25">
              <td className="px-3 py-3">
                <p className="max-w-[260px] font-medium">{row.identity}</p>
                <div className="mt-1 flex gap-1.5">
                  <Badge
                    className={`border-0 text-[10px] ${sourceClass[row.source]}`}
                  >
                    {row.source}
                  </Badge>
                  <Badge
                    variant="outline"
                    className={`text-[10px] ${severityClass[row.severity]}`}
                  >
                    {row.severity}
                  </Badge>
                </div>
              </td>
              <td className="px-3 py-3">
                <Badge variant="outline">{row.state}</Badge>
              </td>
              <td className="max-w-[230px] px-3 py-3 font-medium">
                {row.nextAction}
              </td>
              <td className="px-3 py-3">{row.owner}</td>
              <td className="whitespace-nowrap px-3 py-3 text-xs">
                {safeDate(row.dueAt)}
              </td>
              <td className="max-w-[220px] px-3 py-3 text-xs text-muted-foreground">
                {row.blocker}
              </td>
              <td className="whitespace-nowrap px-3 py-3 text-xs text-muted-foreground">
                {safeDate(row.lastActivityAt)}
              </td>
              <td className="px-3 py-3 text-right">
                <a
                  href={row.href}
                  aria-label="Kaydı aç"
                  className="inline-flex rounded-md p-2 text-primary hover:bg-primary/10"
                >
                  <ArrowRight className="size-4" />
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function OperationsCenter() {
  const { user } = useAuth(true);
  const { lang } = useI18n();
  const tr = lang === "tr";
  const isAdmin = Boolean(user?.role && ADMIN_ROLES.includes(user.role));
  const [search, setSearch] = useState("");
  const [severity, setSeverity] = useState<
    "all" | OperationsQueueItem["severity"]
  >("all");
  const [source, setSource] = useState<"all" | OperationsQueueItem["source"]>(
    "all",
  );
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(
      () => setDebouncedSearch(search.trim()),
      300,
    );
    return () => window.clearTimeout(timer);
  }, [search]);

  const work = useInfiniteQuery<OperationsWorkResponse>({
    queryKey: ["operations-center", "work-items", "mine"],
    queryFn: ({ pageParam }) =>
      customFetch(
        operationsWorkPath({
          scope: "mine",
          cursor: typeof pageParam === "string" ? pageParam : null,
        }),
      ),
    initialPageParam: null,
    getNextPageParam: (lastPage) => lastPage.meta.nextCursor ?? undefined,
    retry: false,
  });

  const exceptions = useInfiniteQuery<OperationsWorkResponse>({
    queryKey: [
      "operations-center",
      "work-items",
      "all",
      debouncedSearch,
      severity,
      source,
    ],
    queryFn: ({ pageParam }) =>
      customFetch(
        operationsWorkPath({
          scope: "all",
          search: debouncedSearch,
          severity,
          source,
          cursor: typeof pageParam === "string" ? pageParam : null,
        }),
      ),
    initialPageParam: null,
    getNextPageParam: (lastPage) => lastPage.meta.nextCursor ?? undefined,
    retry: false,
  });

  const applications = useQuery<ApplicationPipelineSummary>({
    queryKey: ["operations-center", "application-stage-summary"],
    queryFn: () =>
      customFetch(
        "/api/applications?pipelineSummary=1&includeFacets=0&includeTotals=0",
      ),
    retry: false,
  });
  const documents = useQuery<Document[]>({
    queryKey: ["operations-center", "documents"],
    queryFn: () => customFetch("/api/documents?limit=1000"),
    retry: false,
  });
  const stages = useQuery<{ stages: Stage[] }>({
    queryKey: ["operations-center", "stages"],
    queryFn: () => customFetch("/api/portal-automation/stage-options"),
    retry: false,
  });
  const offers = useQuery<{ data: OfferDeadline[] }>({
    queryKey: ["operations-center", "offers"],
    queryFn: () => customFetch("/api/applications/offer-letter-deadlines"),
    retry: false,
  });
  const portal = useQuery<PortalOperationsResponse>({
    queryKey: ["operations-center", "portal"],
    queryFn: () => customFetch("/api/portal-automation/operations"),
    enabled: isAdmin,
    retry: false,
  });
  const integrations = useQuery<{ data: Integration[] }>({
    queryKey: ["operations-center", "integrations"],
    queryFn: () => customFetch("/api/integrations"),
    enabled: isAdmin,
    retry: false,
  });

  const documentRows = documents.data ?? [];
  const stageRows = stages.data?.stages ?? [];
  const offerRows = offers.data?.data ?? [];
  const myRows = work.data?.pages.flatMap((page) => page.items) ?? [];
  const exceptionRows =
    exceptions.data?.pages.flatMap((page) => page.items) ?? [];
  const workSummary = exceptions.data?.pages[0]?.summary ?? {
    total: 0,
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    mine: 0,
    tasks: 0,
    applications: 0,
    documents: 0,
    portal: 0,
    offers: 0,
  };
  const documentStatusCounts = countBy(documentRows, (row) =>
    (row.status ?? "pending").toLowerCase(),
  );
  const stageCounts = new Map(
    (applications.data?.meta.stages ?? []).map((row) => [row.stage, row.total]),
  );
  const loading =
    work.isLoading ||
    exceptions.isLoading ||
    applications.isLoading ||
    documents.isLoading ||
    stages.isLoading ||
    offers.isLoading;
  const partialErrors = [
    work,
    exceptions,
    applications,
    documents,
    stages,
    offers,
    ...(isAdmin ? [portal, integrations] : []),
  ].filter((query) => query.isError).length;

  const refreshAll = () => {
    void work.refetch();
    void exceptions.refetch();
    void applications.refetch();
    void documents.refetch();
    void stages.refetch();
    void offers.refetch();
    if (isAdmin) {
      void portal.refetch();
      void integrations.refetch();
    }
  };

  if (loading && myRows.length === 0 && exceptionRows.length === 0) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {tr ? "İş & İstisna Merkezi" : "Work & Exception Center"}
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            {tr
              ? "Görev, başvuru, belge, offer ve portal sinyallerini mevcut yetki sınırları içinde tek öncelikli iş kuyruğunda birleştirir."
              : "Combines tasks, applications, evidence, offers and portal signals into one prioritized queue within existing access boundaries."}
          </p>
        </div>
        <Button
          variant="outline"
          onClick={refreshAll}
          className="gap-2"
          disabled={loading}
        >
          <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
          {tr ? "Yenile" : "Refresh"}
        </Button>
      </div>

      {partialErrors > 0 && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            {tr
              ? `${partialErrors} veri kaynağı yüklenemedi; görünüm yalnız doğrulanabilen kaynakları gösteriyor.`
              : `${partialErrors} data source(s) failed; this view shows only successfully loaded sources.`}
          </span>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {[
          {
            label: tr ? "Kritik" : "Critical",
            value: workSummary.critical,
            icon: AlertTriangle,
            tone: "text-red-600 bg-red-500/10",
          },
          {
            label: tr ? "Yüksek" : "High",
            value: workSummary.high,
            icon: Clock3,
            tone: "text-amber-600 bg-amber-500/10",
          },
          {
            label: tr ? "Benim işlerim" : "My work",
            value: workSummary.mine,
            icon: UserRoundCheck,
            tone: "text-blue-600 bg-blue-500/10",
          },
          {
            label: tr ? "Belge inceleme" : "Evidence review",
            value: workSummary.documents,
            icon: FileCheck2,
            tone: "text-emerald-600 bg-emerald-500/10",
          },
          {
            label: tr ? "Portal istisnası" : "Portal exceptions",
            value: workSummary.portal,
            icon: Bot,
            tone: "text-orange-600 bg-orange-500/10",
          },
        ].map(({ label, value, icon: Icon, tone }) => (
          <Card key={label}>
            <CardContent className="flex items-center justify-between p-4">
              <div>
                <p className="text-xs font-medium text-muted-foreground">
                  {label}
                </p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">
                  {value}
                </p>
              </div>
              <div className={`rounded-xl p-2.5 ${tone}`}>
                <Icon className="size-5" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Tabs defaultValue="work" className="space-y-4">
        <TabsList className="h-auto w-full justify-start overflow-x-auto rounded-xl bg-muted/60 p-1">
          <TabsTrigger value="work">{tr ? "İşim" : "My Work"}</TabsTrigger>
          <TabsTrigger value="exceptions">
            {tr ? "İstisnalar" : "Exceptions"}
          </TabsTrigger>
          <TabsTrigger value="evidence">
            {tr ? "Belge Merkezi" : "Evidence Center"}
          </TabsTrigger>
          <TabsTrigger value="integrations">
            {tr ? "Entegrasyonlar" : "Integrations"}
          </TabsTrigger>
          <TabsTrigger value="journey">
            {tr ? "Offer / Vize / Kayıt" : "Offer / Visa / Enrolment"}
          </TabsTrigger>
          <TabsTrigger value="communication">
            {tr ? "İletişim & Onay" : "Communication & Consent"}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="work" className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">
                {tr ? "Birleşik iş kuyruğum" : "Unified My Work"}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <QueueTable
                rows={myRows}
                empty={
                  tr
                    ? "Şu anda size atanmış acil bir iş yok."
                    : "There is no urgent work assigned to you."
                }
              />
              {work.hasNextPage && (
                <div className="mt-4 flex justify-center">
                  <Button
                    variant="outline"
                    onClick={() => void work.fetchNextPage()}
                    disabled={work.isFetchingNextPage}
                  >
                    {work.isFetchingNextPage
                      ? tr
                        ? "Yükleniyor…"
                        : "Loading…"
                      : tr
                        ? "Daha fazla iş yükle"
                        : "Load more work"}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="exceptions" className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <CardTitle className="text-base">
                    {tr
                      ? "Case Orchestration & Exception Center"
                      : "Case Orchestration & Exception Center"}
                  </CardTitle>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {tr
                      ? "Öncelik açıklanabilir kurallarla hesaplanır; bu ekran iş akışı durumunu kendiliğinden değiştirmez."
                      : "Priority is calculated with explainable rules; this view never mutates workflow state by itself."}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <div className="relative">
                    <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
                    <Input
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder={tr ? "Kuyrukta ara" : "Search queue"}
                      className="w-[220px] pl-8"
                    />
                  </div>
                  <select
                    value={severity}
                    onChange={(event) =>
                      setSeverity(event.target.value as typeof severity)
                    }
                    className="h-9 rounded-md border bg-background px-3 text-sm"
                  >
                    <option value="all">
                      {tr ? "Tüm önemler" : "All severities"}
                    </option>
                    <option value="critical">Critical</option>
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                  </select>
                  <select
                    value={source}
                    onChange={(event) =>
                      setSource(event.target.value as typeof source)
                    }
                    className="h-9 rounded-md border bg-background px-3 text-sm"
                  >
                    <option value="all">
                      {tr ? "Tüm kaynaklar" : "All sources"}
                    </option>
                    <option value="application">Application</option>
                    <option value="task">Task</option>
                    <option value="document">Document</option>
                    <option value="portal">Portal</option>
                    <option value="offer">Offer</option>
                  </select>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <QueueTable
                rows={exceptionRows}
                empty={
                  tr
                    ? "Seçili filtrelerde açık istisna yok."
                    : "No open exceptions match these filters."
                }
              />
              <div className="mt-4 flex flex-col items-center gap-2 text-xs text-muted-foreground">
                <span>
                  {tr
                    ? `${exceptionRows.length} / ${exceptions.data?.pages[0]?.meta.total ?? 0} kayıt gösteriliyor`
                    : `${exceptionRows.length} of ${exceptions.data?.pages[0]?.meta.total ?? 0} records shown`}
                </span>
                {exceptions.hasNextPage && (
                  <Button
                    variant="outline"
                    onClick={() => void exceptions.fetchNextPage()}
                    disabled={exceptions.isFetchingNextPage}
                  >
                    {exceptions.isFetchingNextPage
                      ? tr
                        ? "Yükleniyor…"
                        : "Loading…"
                      : tr
                        ? "Daha fazla istisna yükle"
                        : "Load more exceptions"}
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="evidence" className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {["pending", "review_required", "verified", "rejected"].map(
              (key) => (
                <Card key={key}>
                  <CardContent className="p-4">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">
                      {key.replaceAll("_", " ")}
                    </p>
                    <p className="mt-2 text-2xl font-semibold">
                      {documentStatusCounts.get(key) ?? 0}
                    </p>
                  </CardContent>
                </Card>
              ),
            )}
          </div>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <FileCheck2 className="size-4 text-primary" />
                {tr
                  ? "Evidence & Document Center"
                  : "Evidence & Document Center"}
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                {tr
                  ? "Gerçek belge kayıtlarının doğrulama durumunu ve bağlı case'i gösterir; dosya içeriğini bu listeye taşımaz."
                  : "Shows verification state and linked case for real document records without bringing file contents into this list."}
              </p>
            </CardHeader>
            <CardContent>
              {documentRows.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  {tr ? "Görüntülenebilir belge yok." : "No visible documents."}
                </p>
              ) : (
                <div className="overflow-x-auto rounded-xl border">
                  <table className="w-full min-w-[760px] text-sm">
                    <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2.5">
                          {tr ? "Belge" : "Document"}
                        </th>
                        <th className="px-3 py-2.5">
                          {tr ? "Durum" : "Status"}
                        </th>
                        <th className="px-3 py-2.5">Case</th>
                        <th className="px-3 py-2.5">
                          {tr ? "Güncellendi" : "Updated"}
                        </th>
                        <th />
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {documentRows.slice(0, 100).map((document) => (
                        <tr key={document.id}>
                          <td className="px-3 py-3">
                            <p className="font-medium">
                              {document.name ||
                                document.type ||
                                `#${document.id}`}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {document.type || "—"}
                            </p>
                          </td>
                          <td className="px-3 py-3">
                            <Badge
                              className={`border-0 ${statusClass[(document.status ?? "pending").toLowerCase()] ?? "bg-slate-100 text-slate-700"}`}
                            >
                              {document.status || "pending"}
                            </Badge>
                          </td>
                          <td className="px-3 py-3">
                            {document.applicationId
                              ? `Application #${document.applicationId}`
                              : document.studentId
                                ? `Student #${document.studentId}`
                                : "—"}
                          </td>
                          <td className="px-3 py-3 text-xs text-muted-foreground">
                            {safeDate(document.updatedAt ?? document.createdAt)}
                          </td>
                          <td className="px-3 py-3 text-right">
                            {(document.applicationId || document.studentId) && (
                              <a
                                href={
                                  document.applicationId
                                    ? `/staff/applications/${document.applicationId}`
                                    : `/staff/students/${document.studentId}`
                                }
                                className="text-primary"
                              >
                                <ArrowRight className="size-4" />
                              </a>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="integrations" className="space-y-4">
          {!isAdmin ? (
            <Card>
              <CardContent className="py-10 text-center text-sm text-muted-foreground">
                {tr
                  ? "Entegrasyon sağlık görünümü yönetici yetkisi gerektirir."
                  : "Integration health requires administrator access."}
              </CardContent>
            </Card>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <Card>
                  <CardContent className="p-4">
                    <p className="text-xs text-muted-foreground">
                      {tr ? "İzlenen portal işi" : "Tracked portal work"}
                    </p>
                    <p className="mt-2 text-2xl font-semibold">
                      {Number(portal.data?.summary.tracked ?? 0)}
                    </p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <p className="text-xs text-muted-foreground">
                      {tr ? "Kontrol zamanı gelen" : "Due for check"}
                    </p>
                    <p className="mt-2 text-2xl font-semibold">
                      {Number(portal.data?.summary.due ?? 0)}
                    </p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <p className="text-xs text-muted-foreground">
                      {tr ? "Askıya alınan" : "Suspended"}
                    </p>
                    <p className="mt-2 text-2xl font-semibold">
                      {Number(portal.data?.summary.suspended ?? 0)}
                    </p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <p className="text-xs text-muted-foreground">
                      {tr ? "Onay bekleyen" : "Pending review"}
                    </p>
                    <p className="mt-2 text-2xl font-semibold">
                      {Number(portal.data?.summary.pendingReviews ?? 0)}
                    </p>
                  </CardContent>
                </Card>
              </div>
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Link2 className="size-4 text-primary" />
                    {tr
                      ? "Integration Control Tower"
                      : "Integration Control Tower"}
                  </CardTitle>
                  <p className="text-sm text-muted-foreground">
                    {tr
                      ? "Etkinlik durumu sağlık kanıtı değildir. Sonuç kaydı olmayan bağlantı 'doğrulanmadı' olarak gösterilir."
                      : "Enabled does not mean healthy. Connections without a recorded real test remain unverified."}
                  </p>
                </CardHeader>
                <CardContent>
                  <div className="overflow-x-auto rounded-xl border">
                    <table className="w-full min-w-[720px] text-sm">
                      <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                        <tr>
                          <th className="px-3 py-2.5">
                            {tr ? "Bağlantı" : "Connection"}
                          </th>
                          <th className="px-3 py-2.5">
                            {tr ? "Kategori" : "Category"}
                          </th>
                          <th className="px-3 py-2.5">Config</th>
                          <th className="px-3 py-2.5">Health</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {(integrations.data?.data ?? []).map((integration) => (
                          <tr key={integration.id}>
                            <td className="px-3 py-3">
                              <p className="font-medium">{integration.name}</p>
                              <p className="text-xs text-muted-foreground">
                                {integration.key}
                              </p>
                            </td>
                            <td className="px-3 py-3">
                              {integration.category}
                            </td>
                            <td className="px-3 py-3">
                              <Badge
                                variant={
                                  integration.isEnabled
                                    ? "default"
                                    : "secondary"
                                }
                              >
                                {integration.isEnabled
                                  ? tr
                                    ? "Etkin"
                                    : "Enabled"
                                  : tr
                                    ? "Kapalı"
                                    : "Disabled"}
                              </Badge>
                            </td>
                            <td className="px-3 py-3">
                              <Badge variant="outline">
                                {tr ? "Doğrulanmadı" : "Unverified"}
                              </Badge>
                            </td>
                            <td className="px-3 py-3 text-right">
                              <a
                                href="/admin/settings"
                                className="text-primary"
                              >
                                <ArrowRight className="size-4" />
                              </a>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">
                    {tr ? "İzole portal sıraları" : "Isolated portal lanes"}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {(portal.data?.lanes ?? []).length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {tr ? "Aktif sıra yok." : "No active lanes."}
                    </p>
                  ) : (
                    <div className="grid gap-2 md:grid-cols-2">
                      {portal.data!.lanes.map((lane) => (
                        <div
                          key={lane.laneKey}
                          className="rounded-xl border p-3"
                        >
                          <div className="flex items-center justify-between">
                            <p className="font-medium">{lane.universityKey}</p>
                            {Number(lane.suspended) > 0 && (
                              <Badge variant="destructive">
                                {lane.suspended} suspended
                              </Badge>
                            )}
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {lane.adapterKey} · {lane.due} due · {lane.retrying}{" "}
                            retrying
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </TabsContent>

        <TabsContent value="journey" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <GraduationCap className="size-4 text-primary" />
                {tr
                  ? "Offer, Visa & Enrolment Journey"
                  : "Offer, Visa & Enrolment Journey"}
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                {tr
                  ? "Mevcut dinamik application stage'lerini ve offer kanıtlarını aynı case yolculuğunda görünür kılar. State değişikliği yine kanıtlı akış üzerinden yapılır."
                  : "Projects dynamic application stages and offer evidence into one case journey. State changes still use the evidence-bound workflow."}
              </p>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {stageRows.map((stage) => (
                  <div key={stage.key} className="rounded-xl border p-3">
                    <p className="text-sm font-medium">{stage.label}</p>
                    <p className="mt-2 text-2xl font-semibold">
                      {stageCounts.get(stage.key) ?? 0}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {stage.isCaseClose
                        ? tr
                          ? "Kapanış durumu"
                          : "Closing state"
                        : stage.key}
                    </p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {tr ? "Offer son tarihleri" : "Offer deadlines"}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {offerRows.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {tr
                    ? "Yaklaşan offer son tarihi yok."
                    : "No upcoming offer deadline."}
                </p>
              ) : (
                <div className="space-y-2">
                  {offerRows.slice(0, 50).map((offer) => (
                    <a
                      key={offer.docId}
                      href={`/staff/applications/${offer.applicationId}`}
                      className="flex items-center justify-between rounded-xl border p-3 hover:bg-muted/40"
                    >
                      <div>
                        <p className="font-medium">
                          {offer.universityName ||
                            `Application #${offer.applicationId}`}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {offer.programName || "—"}
                        </p>
                      </div>
                      <Badge
                        variant={
                          (offer.daysLeft ?? 999) <= 7
                            ? "destructive"
                            : "secondary"
                        }
                      >
                        {offer.daysLeft == null
                          ? "—"
                          : `${offer.daysLeft} days`}
                      </Badge>
                    </a>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="communication" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <MessageCircle className="size-4 text-primary" />
                {tr
                  ? "Communication, Consent & Guardian/Sponsor"
                  : "Communication, Consent & Guardian/Sponsor"}
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                {tr
                  ? "Mevcut inbox ve bildirim altyapısını kullanır; onay, tercih ve temsil yetkisi birbirinin yerine geçmez."
                  : "Uses the existing inbox and notification foundation; consent, preference and relationship authority remain separate."}
              </p>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <a
                  href="/staff/messages"
                  className="rounded-xl border p-4 hover:bg-muted/40"
                >
                  <Inbox className="size-5 text-primary" />
                  <p className="mt-3 font-medium">
                    {tr ? "Birleşik Inbox" : "Unified Inbox"}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    WhatsApp, Messenger, Instagram
                  </p>
                </a>
                <a
                  href="/admin/settings"
                  className="rounded-xl border p-4 hover:bg-muted/40"
                >
                  <ShieldCheck className="size-5 text-primary" />
                  <p className="mt-3 font-medium">
                    {tr ? "İletişim tercihleri" : "Communication preferences"}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {tr
                      ? "Kanal ve kategori bazlı kontrol"
                      : "Channel and category controls"}
                  </p>
                </a>
                <div className="rounded-xl border p-4">
                  <Users className="size-5 text-primary" />
                  <p className="mt-3 font-medium">Guardian / Sponsor</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {tr
                      ? "Purpose-limited ilişki ve paylaşım kapsamı foundation üzerinde; mutating UI henüz kapalı."
                      : "Purpose-limited relationship foundation exists; mutating UI remains closed."}
                  </p>
                </div>
                <div className="rounded-xl border p-4">
                  <ListChecks className="size-5 text-primary" />
                  <p className="mt-3 font-medium">
                    {tr ? "Karar izi" : "Decision receipt"}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {tr
                      ? "Gönderim öncesi consent, suppression ve quiet-hours değerlendirmesi."
                      : "Consent, suppression and quiet-hours evaluation before sending."}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
          <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-800 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200">
            <FileWarning className="mr-2 inline size-4" />
            {tr
              ? "Bu dilim consent veya guardian yetkisi üretmez; yalnız mevcut güvenli altyapıyı doğru operasyon alanına bağlar. Yazma akışları ayrı maker-checker ve hukuk kapısından geçecek."
              : "This slice does not mint consent or guardian authority; it only places the existing safe foundation in the right workspace. Write flows remain behind maker-checker and legal gates."}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
