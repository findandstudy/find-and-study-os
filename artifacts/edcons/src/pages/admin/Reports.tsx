import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Link } from "wouter";
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  BookOpenCheck,
  CalendarRange,
  CheckCircle2,
  CircleDollarSign,
  Database,
  FileSearch,
  Filter,
  GraduationCap,
  RefreshCw,
  ShieldCheck,
  Target,
  Users,
} from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useAuth } from "@/hooks/use-auth";
import { useI18n } from "@/hooks/use-i18n";
import { useSeason } from "@/contexts/SeasonContext";
import { getLocale } from "@/lib/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type ReportMeta = {
  schemaVersion: number;
  metricVersion: string;
  asOf: string;
  filters: {
    from: string;
    to: string;
    season: string | null;
    branchId: number | null;
    timezone: string;
  };
  freshness: { status: "live"; source: string; cacheAgeSeconds: number };
  latencyMs: number;
  warnings: string[];
};

type ReportResponse<T> = { meta: ReportMeta; data: T };

type ReportingMeta = {
  metricVersion: string;
  generatedAt: string;
  timezone: string;
  maximumRangeDays: number;
  currencyPolicy: string;
  exportPolicy: string;
  branches: Array<{
    id: number;
    name: string;
    country: string | null;
    city: string | null;
  }>;
  metrics: Array<{
    key: string;
    label: string;
    description: string;
    timeSemantics: string;
    denominator?: string;
  }>;
};

type CommandCenterData = {
  cards: {
    leadsCreated: number;
    leadsChangePercent: number | null;
    leadConversionRate: number | null;
    studentsCreated: number;
    studentsChangePercent: number | null;
    applicationsCreated: number;
    applicationsChangePercent: number | null;
    applicationWinRate: number | null;
    activeApplications: number;
    staleApplications: number;
  };
  trendBucket: "day" | "week" | "month";
  trend: Array<{
    bucket: string;
    leads: number;
    students: number;
    applications: number;
  }>;
};

type FunnelData = {
  stages: Array<{
    key: string;
    value: number;
    rateFromPrevious: number | null;
  }>;
  lost: number;
  sources: Array<{
    source: string;
    leads: number;
    converted: number;
    applications: number;
    won: number;
    leadConversionRate: number | null;
    applicationWinRate: number | null;
  }>;
};

type ApplicationData = {
  totals: { inventory: number; createdCohort: number };
  stages: Array<{
    key: string;
    label: string;
    variant: string;
    inventory: number;
    cohort: number;
  }>;
  lastUpdatedAging: Array<{ bucket: string; value: number }>;
  destinations: Array<{
    destination: string;
    applications: number;
    won: number;
    winRate: number | null;
  }>;
};

type FinanceData = {
  currencyPolicy: string;
  commissions: Array<{
    currency: string;
    records: number;
    grossCommission: number;
    agentLiability: number;
    netCommission: number;
    collected: number;
    outstanding: number;
  }>;
  serviceFees: Array<{
    currency: string;
    records: number;
    billed: number;
    collected: number;
    outstanding: number;
  }>;
  transactions: Array<{
    currency: string;
    type: string;
    records: number;
    amount: number;
  }>;
};

type DataQualityData = {
  coverage: {
    leadSourcePercent: number | null;
    applicationLeadLineagePercent: number | null;
    applicationCatalogLinkPercent: number | null;
  };
  summary: { critical: number; warning: number };
  checks: Array<{
    key: string;
    label: string;
    severity: "critical" | "warning";
    count: number;
    affectedRecords?: number;
    scope: string;
  }>;
  mutationAvailable: false;
};

const COPY_KEYS = {
  title: "reporting.title",
  description: "reporting.description",
  overview: "reporting.overview",
  funnel: "reporting.funnel",
  applications: "reporting.applications",
  finance: "reporting.finance",
  quality: "reporting.quality",
  apply: "reporting.apply",
  refresh: "reporting.refresh",
  allBranches: "reporting.allBranches",
  from: "reporting.from",
  to: "reporting.to",
  season: "reporting.season",
  branch: "reporting.branch",
  live: "reporting.live",
  failed: "reporting.failed",
  retry: "reporting.retry",
  leads: "reporting.leads",
  students: "reporting.students",
  apps: "reporting.apps",
  activeApps: "reporting.activeApps",
  staleApps: "reporting.staleApps",
  conversion: "reporting.conversion",
  winRate: "reporting.winRate",
  periodComparison: "reporting.periodComparison",
  noBaseline: "reporting.noBaseline",
  trend: "reporting.trend",
  cohort: "reporting.cohort",
  inventory: "reporting.inventory",
  sourcePerformance: "reporting.sourcePerformance",
  source: "reporting.source",
  converted: "reporting.converted",
  submitted: "reporting.submitted",
  won: "reporting.won",
  lost: "reporting.lost",
  stageDistribution: "reporting.stageDistribution",
  aging: "reporting.aging",
  destinations: "reporting.destinations",
  destination: "reporting.destination",
  gross: "reporting.gross",
  liability: "reporting.liability",
  net: "reporting.net",
  collected: "reporting.collected",
  outstanding: "reporting.outstanding",
  billed: "reporting.billed",
  serviceFees: "reporting.serviceFees",
  transactions: "reporting.transactions",
  transactionType: "reporting.transactionType",
  currencyRule: "reporting.currencyRule",
  coverage: "reporting.coverage",
  checks: "reporting.checks",
  critical: "reporting.critical",
  warnings: "reporting.warnings",
  metricDictionary: "reporting.metricDictionary",
  metricVersion: "reporting.metricVersion",
  calculatedAt: "reporting.calculatedAt",
  semantics: "reporting.semantics",
  exportDisabled: "reporting.exportDisabled",
  openRecords: "reporting.openRecords",
  noData: "reporting.noData",
  affectedRecords: "reporting.affectedRecords",
  denominator: "reporting.denominator",
  leadSource: "reporting.leadSource",
  applicationLead: "reporting.applicationLead",
  applicationCatalog: "reporting.applicationCatalog",
} as const;

type ReportingCopy = Record<keyof typeof COPY_KEYS, string>;

function buildCopy(translate: (key: string) => string): ReportingCopy {
  return Object.fromEntries(
    Object.entries(COPY_KEYS).map(([key, translationKey]) => [
      key,
      translate(translationKey),
    ]),
  ) as ReportingCopy;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function defaultDates() {
  const to = new Date();
  const from = new Date();
  from.setUTCDate(from.getUTCDate() - 29);
  return { from: isoDate(from), to: isoDate(to) };
}

function percent(value: number | null): string {
  return value === null
    ? "—"
    : `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
}

function Change({
  value,
  copy,
}: {
  value: number | null;
  copy: ReportingCopy;
}) {
  if (value === null)
    return (
      <span className="text-xs text-muted-foreground">{copy.noBaseline}</span>
    );
  const positive = value >= 0;
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs font-medium ${positive ? "text-emerald-600" : "text-rose-600"}`}
    >
      {positive ? (
        <ArrowUpRight className="h-3.5 w-3.5" />
      ) : (
        <ArrowDownRight className="h-3.5 w-3.5" />
      )}
      {Math.abs(value).toLocaleString(undefined, { maximumFractionDigits: 1 })}%{" "}
      {copy.periodComparison}
    </span>
  );
}

function MetricCard({
  title,
  value,
  detail,
  icon: Icon,
  accent = "blue",
}: {
  title: string;
  value: string | number;
  detail?: React.ReactNode;
  icon: typeof Users;
  accent?: "blue" | "violet" | "emerald" | "amber" | "rose";
}) {
  const colors = {
    blue: "bg-blue-500/10 text-blue-600",
    violet: "bg-violet-500/10 text-violet-600",
    emerald: "bg-emerald-500/10 text-emerald-600",
    amber: "bg-amber-500/10 text-amber-600",
    rose: "bg-rose-500/10 text-rose-600",
  };
  return (
    <Card className="border-border/60 shadow-sm">
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {title}
            </p>
            <p className="mt-2 text-3xl font-bold tabular-nums">{value}</p>
          </div>
          <div className={`rounded-xl p-2.5 ${colors[accent]}`}>
            <Icon className="h-5 w-5" />
          </div>
        </div>
        {detail && <div className="mt-3">{detail}</div>}
      </CardContent>
    </Card>
  );
}

function ReportLoading() {
  return (
    <div
      className="grid gap-4 md:grid-cols-2 xl:grid-cols-4"
      aria-label="Loading report"
    >
      {[0, 1, 2, 3].map((key) => (
        <Skeleton key={key} className="h-36 rounded-xl" />
      ))}
      <Skeleton className="h-80 rounded-xl md:col-span-2 xl:col-span-4" />
    </div>
  );
}

function ReportError({
  retry,
  copy,
}: {
  retry: () => void;
  copy: ReportingCopy;
}) {
  return (
    <Card className="border-destructive/40">
      <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
        <AlertTriangle className="h-8 w-8 text-destructive" />
        <p className="max-w-xl font-medium">{copy.failed}</p>
        <Button variant="outline" onClick={retry}>
          <RefreshCw className="mr-2 h-4 w-4" />
          {copy.retry}
        </Button>
      </CardContent>
    </Card>
  );
}

function ReportWarnings({ meta }: { meta?: ReportMeta }) {
  if (!meta?.warnings?.length) return null;
  return (
    <Card className="border-amber-500/30 bg-amber-500/[0.04]">
      <CardContent className="space-y-1.5 py-4 text-xs text-muted-foreground">
        {meta.warnings.map((warning) => (
          <div key={warning} className="flex gap-2">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
            <span>{warning}</span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function OverviewPanel({
  report,
  copy,
  locale,
  retry,
}: {
  report?: ReportResponse<CommandCenterData>;
  copy: ReportingCopy;
  locale: string;
  retry: () => void;
}) {
  if (!report) return <ReportError retry={retry} copy={copy} />;
  const { cards, trend } = report.data;
  return (
    <div className="space-y-5">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          title={copy.leads}
          value={cards.leadsCreated.toLocaleString(locale)}
          icon={Users}
          detail={<Change value={cards.leadsChangePercent} copy={copy} />}
        />
        <MetricCard
          title={copy.students}
          value={cards.studentsCreated.toLocaleString(locale)}
          icon={GraduationCap}
          accent="violet"
          detail={<Change value={cards.studentsChangePercent} copy={copy} />}
        />
        <MetricCard
          title={copy.apps}
          value={cards.applicationsCreated.toLocaleString(locale)}
          icon={FileSearch}
          accent="emerald"
          detail={
            <Change value={cards.applicationsChangePercent} copy={copy} />
          }
        />
        <MetricCard
          title={copy.activeApps}
          value={cards.activeApplications.toLocaleString(locale)}
          icon={Activity}
          accent={cards.staleApplications > 0 ? "amber" : "blue"}
          detail={
            <span className="text-xs text-muted-foreground">
              {cards.staleApplications} {copy.staleApps.toLocaleLowerCase()}
            </span>
          }
        />
        <MetricCard
          title={copy.conversion}
          value={percent(cards.leadConversionRate)}
          icon={Target}
          accent="emerald"
          detail={
            <span className="text-xs text-muted-foreground">{copy.cohort}</span>
          }
        />
        <MetricCard
          title={copy.winRate}
          value={percent(cards.applicationWinRate)}
          icon={CheckCircle2}
          accent="violet"
          detail={
            <span className="text-xs text-muted-foreground">{copy.cohort}</span>
          }
        />
        <MetricCard
          title={copy.staleApps}
          value={cards.staleApplications.toLocaleString(locale)}
          icon={AlertTriangle}
          accent={cards.staleApplications > 0 ? "rose" : "emerald"}
          detail={
            <Link
              href="/staff/applications"
              className="text-xs font-medium text-primary hover:underline"
            >
              {copy.openRecords} →
            </Link>
          }
        />
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <BarChart3 className="h-4 w-4 text-primary" />
            {copy.trend}
          </CardTitle>
        </CardHeader>
        <CardContent className="h-80">
          {trend.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {copy.noData}
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={trend} margin={{ left: -14, right: 8 }}>
                <defs>
                  <linearGradient id="leadFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#2563eb" stopOpacity={0.28} />
                    <stop offset="95%" stopColor="#2563eb" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="appFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.22} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  strokeDasharray="3 3"
                  vertical={false}
                  opacity={0.25}
                />
                <XAxis
                  dataKey="bucket"
                  tickFormatter={(v) =>
                    new Date(v).toLocaleDateString(locale, {
                      day: "2-digit",
                      month: "short",
                    })
                  }
                  fontSize={11}
                />
                <YAxis allowDecimals={false} fontSize={11} />
                <RechartsTooltip
                  labelFormatter={(v) =>
                    new Date(String(v)).toLocaleDateString(locale)
                  }
                />
                <Legend />
                <Area
                  type="monotone"
                  dataKey="leads"
                  name={copy.leads}
                  stroke="#2563eb"
                  fill="url(#leadFill)"
                  strokeWidth={2}
                />
                <Area
                  type="monotone"
                  dataKey="students"
                  name={copy.students}
                  stroke="#8b5cf6"
                  fill="transparent"
                  strokeWidth={2}
                />
                <Area
                  type="monotone"
                  dataKey="applications"
                  name={copy.applications}
                  stroke="#10b981"
                  fill="url(#appFill)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>
      <ReportWarnings meta={report.meta} />
    </div>
  );
}

function FunnelPanel({
  report,
  copy,
  locale,
  retry,
}: {
  report?: ReportResponse<FunnelData>;
  copy: ReportingCopy;
  locale: string;
  retry: () => void;
}) {
  if (!report) return <ReportError retry={retry} copy={copy} />;
  const labels: Record<string, string> = {
    leads: copy.leads,
    converted: copy.converted,
    students: copy.students,
    applications: copy.applications,
    submitted: copy.submitted,
    won: copy.won,
  };
  return (
    <div className="space-y-5">
      <Card>
        <CardContent className="p-5">
          <div className="grid gap-2 lg:grid-cols-6">
            {report.data.stages.map((stage, index) => (
              <div
                key={stage.key}
                className="relative rounded-xl border bg-card p-4"
              >
                <p className="text-xs font-semibold text-muted-foreground">
                  {labels[stage.key] ?? stage.key}
                </p>
                <p className="mt-2 text-2xl font-bold tabular-nums">
                  {stage.value.toLocaleString(locale)}
                </p>
                <p className="mt-1 text-xs text-primary">
                  {index === 0
                    ? copy.cohort
                    : `${percent(stage.rateFromPrevious)} ↓`}
                </p>
                {index < report.data.stages.length - 1 && (
                  <ArrowRight className="absolute -right-3 top-1/2 z-10 hidden h-5 w-5 -translate-y-1/2 text-muted-foreground lg:block" />
                )}
              </div>
            ))}
          </div>
          <div className="mt-3 text-right text-xs text-muted-foreground">
            {copy.lost}:{" "}
            <span className="font-semibold text-rose-600">
              {report.data.lost.toLocaleString(locale)}
            </span>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{copy.sourcePerformance}</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="py-3">{copy.source}</th>
                <th>{copy.leads}</th>
                <th>{copy.converted}</th>
                <th>{copy.applications}</th>
                <th>{copy.won}</th>
                <th>{copy.conversion}</th>
                <th>{copy.winRate}</th>
              </tr>
            </thead>
            <tbody>
              {report.data.sources.map((row) => (
                <tr key={row.source} className="border-b last:border-0">
                  <td className="py-3 font-medium">{row.source}</td>
                  <td>{row.leads.toLocaleString(locale)}</td>
                  <td>{row.converted.toLocaleString(locale)}</td>
                  <td>{row.applications.toLocaleString(locale)}</td>
                  <td>{row.won.toLocaleString(locale)}</td>
                  <td>{percent(row.leadConversionRate)}</td>
                  <td>{percent(row.applicationWinRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
      <ReportWarnings meta={report.meta} />
    </div>
  );
}

function ApplicationsPanel({
  report,
  copy,
  locale,
  retry,
}: {
  report?: ReportResponse<ApplicationData>;
  copy: ReportingCopy;
  locale: string;
  retry: () => void;
}) {
  if (!report) return <ReportError retry={retry} copy={copy} />;
  const agingOrder = ["0-2d", "3-7d", "8-14d", "15-30d", "31d+"];
  const aging = agingOrder.map((bucket) => ({
    bucket,
    value:
      report.data.lastUpdatedAging.find((row) => row.bucket === bucket)
        ?.value ?? 0,
  }));
  return (
    <div className="space-y-5">
      <div className="grid gap-4 md:grid-cols-2">
        <MetricCard
          title={`${copy.applications} · ${copy.inventory}`}
          value={report.data.totals.inventory.toLocaleString(locale)}
          icon={FileSearch}
          accent="blue"
        />
        <MetricCard
          title={`${copy.applications} · ${copy.cohort}`}
          value={report.data.totals.createdCohort.toLocaleString(locale)}
          icon={CalendarRange}
          accent="emerald"
        />
      </div>
      <div className="grid gap-5 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {copy.stageDistribution}
            </CardTitle>
          </CardHeader>
          <CardContent className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={report.data.stages}
                layout="vertical"
                margin={{ left: 18, right: 12 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  horizontal={false}
                  opacity={0.25}
                />
                <XAxis type="number" allowDecimals={false} />
                <YAxis
                  dataKey="label"
                  type="category"
                  width={105}
                  fontSize={11}
                />
                <RechartsTooltip />
                <Legend />
                <Bar
                  dataKey="inventory"
                  name={copy.inventory}
                  fill="#2563eb"
                  radius={[0, 4, 4, 0]}
                />
                <Bar
                  dataKey="cohort"
                  name={copy.cohort}
                  fill="#10b981"
                  radius={[0, 4, 4, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{copy.aging}</CardTitle>
          </CardHeader>
          <CardContent className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={aging}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  vertical={false}
                  opacity={0.25}
                />
                <XAxis dataKey="bucket" />
                <YAxis allowDecimals={false} />
                <RechartsTooltip />
                <Bar
                  dataKey="value"
                  name={copy.activeApps}
                  fill="#f59e0b"
                  radius={[5, 5, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{copy.destinations}</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="py-3">{copy.destination}</th>
                <th>{copy.applications}</th>
                <th>{copy.won}</th>
                <th>{copy.winRate}</th>
              </tr>
            </thead>
            <tbody>
              {report.data.destinations.map((row) => (
                <tr key={row.destination} className="border-b last:border-0">
                  <td className="py-3 font-medium">{row.destination}</td>
                  <td>{row.applications.toLocaleString(locale)}</td>
                  <td>{row.won.toLocaleString(locale)}</td>
                  <td>{percent(row.winRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
      <ReportWarnings meta={report.meta} />
    </div>
  );
}

function FinancePanel({
  report,
  copy,
  locale,
  retry,
}: {
  report?: ReportResponse<FinanceData>;
  copy: ReportingCopy;
  locale: string;
  retry: () => void;
}) {
  if (!report) return <ReportError retry={retry} copy={copy} />;
  const money = (amount: number, currency: string) => {
    try {
      return new Intl.NumberFormat(locale, {
        style: "currency",
        currency,
        maximumFractionDigits: 2,
      }).format(amount);
    } catch {
      return `${amount.toLocaleString(locale, { maximumFractionDigits: 2 })} ${currency}`;
    }
  };
  return (
    <div className="space-y-5">
      <Card className="border-blue-500/30 bg-blue-500/[0.04]">
        <CardContent className="flex gap-3 py-4 text-sm">
          <CircleDollarSign className="h-5 w-5 shrink-0 text-blue-600" />
          <span>{copy.currencyRule}</span>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{copy.net}</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="py-3">Currency</th>
                <th>{copy.gross}</th>
                <th>{copy.liability}</th>
                <th>{copy.net}</th>
                <th>{copy.collected}</th>
                <th>{copy.outstanding}</th>
              </tr>
            </thead>
            <tbody>
              {report.data.commissions.map((row) => (
                <tr key={row.currency} className="border-b last:border-0">
                  <td className="py-3">
                    <Badge variant="outline">{row.currency}</Badge>
                  </td>
                  <td>{money(row.grossCommission, row.currency)}</td>
                  <td>{money(row.agentLiability, row.currency)}</td>
                  <td className="font-semibold">
                    {money(row.netCommission, row.currency)}
                  </td>
                  <td className="text-emerald-600">
                    {money(row.collected, row.currency)}
                  </td>
                  <td className="text-amber-600">
                    {money(row.outstanding, row.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
      <div className="grid gap-5 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{copy.serviceFees}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {report.data.serviceFees.map((row) => (
              <div key={row.currency} className="rounded-xl border p-4">
                <div className="mb-3 flex justify-between">
                  <Badge variant="outline">{row.currency}</Badge>
                  <span className="text-xs text-muted-foreground">
                    {row.records} records
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <p className="text-muted-foreground">{copy.billed}</p>
                    <p className="mt-1 font-semibold">
                      {money(row.billed, row.currency)}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">{copy.collected}</p>
                    <p className="mt-1 font-semibold text-emerald-600">
                      {money(row.collected, row.currency)}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">{copy.outstanding}</p>
                    <p className="mt-1 font-semibold text-amber-600">
                      {money(row.outstanding, row.currency)}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{copy.transactions}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {report.data.transactions.map((row) => (
              <div
                key={`${row.currency}-${row.type}`}
                className="flex items-center justify-between rounded-lg border px-4 py-3 text-sm"
              >
                <div>
                  <p className="font-medium capitalize">
                    {row.type.replaceAll("_", " ")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {row.records} records · {row.currency}
                  </p>
                </div>
                <p className="font-semibold">
                  {money(row.amount, row.currency)}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
      <ReportWarnings meta={report.meta} />
    </div>
  );
}

function DataQualityPanel({
  report,
  copy,
  retry,
}: {
  report?: ReportResponse<DataQualityData>;
  copy: ReportingCopy;
  retry: () => void;
}) {
  if (!report) return <ReportError retry={retry} copy={copy} />;
  const coverage = [
    { label: copy.leadSource, value: report.data.coverage.leadSourcePercent },
    {
      label: copy.applicationLead,
      value: report.data.coverage.applicationLeadLineagePercent,
    },
    {
      label: copy.applicationCatalog,
      value: report.data.coverage.applicationCatalogLinkPercent,
    },
  ];
  return (
    <div className="space-y-5">
      <div className="grid gap-4 md:grid-cols-3">
        {coverage.map((item) => (
          <MetricCard
            key={item.label}
            title={item.label}
            value={percent(item.value)}
            icon={ShieldCheck}
            accent={(item.value ?? 0) >= 95 ? "emerald" : "amber"}
          />
        ))}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <MetricCard
          title={copy.critical}
          value={report.data.summary.critical}
          icon={AlertTriangle}
          accent={report.data.summary.critical ? "rose" : "emerald"}
        />
        <MetricCard
          title={copy.warnings}
          value={report.data.summary.warning}
          icon={Database}
          accent={report.data.summary.warning ? "amber" : "emerald"}
        />
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{copy.checks}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {report.data.checks.map((check) => (
            <div
              key={check.key}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4"
            >
              <div className="flex items-center gap-3">
                {check.severity === "critical" ? (
                  <AlertTriangle className="h-5 w-5 text-rose-600" />
                ) : (
                  <ShieldCheck className="h-5 w-5 text-amber-600" />
                )}
                <div>
                  <p className="text-sm font-medium">{check.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {check.scope.replaceAll("_", " ")}
                    {check.affectedRecords !== undefined
                      ? ` · ${check.affectedRecords} ${copy.affectedRecords}`
                      : ""}
                  </p>
                </div>
              </div>
              <Badge variant={check.count > 0 ? "destructive" : "secondary"}>
                {check.count}
              </Badge>
            </div>
          ))}
        </CardContent>
      </Card>
      <ReportWarnings meta={report.meta} />
    </div>
  );
}

export default function ReportsPage() {
  const { lang, t } = useI18n();
  const { hasPermission } = useAuth(true);
  const { season, setSeason, availableYears } = useSeason();
  const queryClient = useQueryClient();
  const copy = useMemo(() => buildCopy(t), [lang, t]);
  const locale = getLocale(lang);
  const initial = useMemo(defaultDates, []);
  const [draft, setDraft] = useState({ ...initial, branchId: "all", season });
  const [filters, setFilters] = useState({
    ...initial,
    branchId: "all",
    season,
  });
  const [tab, setTab] = useState("overview");
  const canOperations = hasPermission("reporting.operations");
  const canFinance =
    hasPermission("reporting.finance") && hasPermission("finance.view");

  const params = useMemo(() => {
    const value = new URLSearchParams({
      from: filters.from,
      to: filters.to,
      season: filters.season,
    });
    if (filters.branchId !== "all") value.set("branchId", filters.branchId);
    return value.toString();
  }, [filters]);

  const meta = useQuery<ReportingMeta>({
    queryKey: ["reporting", "meta"],
    queryFn: () => customFetch("/api/reporting/meta"),
    staleTime: 5 * 60_000,
  });
  const overview = useQuery<ReportResponse<CommandCenterData>>({
    queryKey: ["reporting", "command-center", params],
    queryFn: () => customFetch(`/api/reporting/command-center?${params}`),
  });
  const funnel = useQuery<ReportResponse<FunnelData>>({
    queryKey: ["reporting", "funnel", params],
    queryFn: () => customFetch(`/api/reporting/funnel?${params}`),
    enabled: canOperations && tab === "funnel",
  });
  const applications = useQuery<ReportResponse<ApplicationData>>({
    queryKey: ["reporting", "applications", params],
    queryFn: () => customFetch(`/api/reporting/applications?${params}`),
    enabled: canOperations && tab === "applications",
  });
  const finance = useQuery<ReportResponse<FinanceData>>({
    queryKey: ["reporting", "finance", params],
    queryFn: () => customFetch(`/api/reporting/finance?${params}`),
    enabled: canFinance && tab === "finance",
  });
  const quality = useQuery<ReportResponse<DataQualityData>>({
    queryKey: ["reporting", "data-quality", params],
    queryFn: () => customFetch(`/api/reporting/data-quality?${params}`),
    enabled: canOperations && tab === "quality",
  });

  const applyFilters = () => {
    setFilters(draft);
    setSeason(draft.season);
  };
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ["reporting"] });
  const activeMeta =
    overview.data?.meta ??
    funnel.data?.meta ??
    applications.data?.meta ??
    finance.data?.meta ??
    quality.data?.meta;

  return (
    <div className="space-y-6" data-testid="page-reporting-center">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10">
            <BarChart3 className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-display font-bold text-foreground">
              {copy.title}
            </h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {copy.description}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          <Badge
            variant="outline"
            className="gap-1.5 border-primary/20 bg-primary/10 px-3 py-1.5 text-primary"
          >
            <BarChart3 className="h-3.5 w-3.5" />
            {copy.live}
          </Badge>
          <div className="rounded-lg border bg-card px-3 py-1.5 text-xs text-muted-foreground shadow-sm">
            <span>{copy.metricVersion}: </span>
            <span className="font-mono font-medium text-foreground">
              {meta.data?.metricVersion ?? "…"}
            </span>
          </div>
          <div className="rounded-lg border bg-card px-3 py-1.5 text-xs text-muted-foreground shadow-sm">
            <span>{copy.calculatedAt}: </span>
            <span className="font-medium text-foreground">
              {activeMeta
                ? new Date(activeMeta.asOf).toLocaleString(locale)
                : "—"}
            </span>
          </div>
        </div>
      </div>

      <Card>
        <CardContent className="p-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_1.4fr_auto_auto] lg:items-end">
            <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
              <span>{copy.from}</span>
              <Input
                type="date"
                value={draft.from}
                max={draft.to}
                onChange={(e) =>
                  setDraft((v) => ({ ...v, from: e.target.value }))
                }
              />
            </label>
            <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
              <span>{copy.to}</span>
              <Input
                type="date"
                value={draft.to}
                min={draft.from}
                onChange={(e) =>
                  setDraft((v) => ({ ...v, to: e.target.value }))
                }
              />
            </label>
            <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
              <span>{copy.season}</span>
              <Select
                value={draft.season}
                onValueChange={(value) =>
                  setDraft((v) => ({ ...v, season: value }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {availableYears.map((year) => (
                    <SelectItem key={year} value={year}>
                      {year}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
              <span>{copy.branch}</span>
              <Select
                value={draft.branchId}
                onValueChange={(value) =>
                  setDraft((v) => ({ ...v, branchId: value }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{copy.allBranches}</SelectItem>
                  {meta.data?.branches.map((branch) => (
                    <SelectItem key={branch.id} value={String(branch.id)}>
                      {branch.name}
                      {branch.city ? ` · ${branch.city}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <Button onClick={applyFilters}>
              <Filter className="mr-2 h-4 w-4" />
              {copy.apply}
            </Button>
            <Button variant="outline" onClick={refresh}>
              <RefreshCw className="mr-2 h-4 w-4" />
              {copy.refresh}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Tabs value={tab} onValueChange={setTab} className="space-y-5">
        <TabsList className="h-auto flex-wrap justify-start gap-1 bg-muted/60 p-1">
          <TabsTrigger value="overview">{copy.overview}</TabsTrigger>
          {canOperations && (
            <TabsTrigger value="funnel">{copy.funnel}</TabsTrigger>
          )}
          {canOperations && (
            <TabsTrigger value="applications">{copy.applications}</TabsTrigger>
          )}
          {canFinance && (
            <TabsTrigger value="finance">{copy.finance}</TabsTrigger>
          )}
          {canOperations && (
            <TabsTrigger value="quality">{copy.quality}</TabsTrigger>
          )}
        </TabsList>
        <TabsContent value="overview">
          {overview.isLoading ? (
            <ReportLoading />
          ) : (
            <OverviewPanel
              report={overview.data}
              copy={copy}
              locale={locale}
              retry={() => void overview.refetch()}
            />
          )}
        </TabsContent>
        {canOperations && (
          <TabsContent value="funnel">
            {funnel.isLoading ? (
              <ReportLoading />
            ) : (
              <FunnelPanel
                report={funnel.data}
                copy={copy}
                locale={locale}
                retry={() => void funnel.refetch()}
              />
            )}
          </TabsContent>
        )}
        {canOperations && (
          <TabsContent value="applications">
            {applications.isLoading ? (
              <ReportLoading />
            ) : (
              <ApplicationsPanel
                report={applications.data}
                copy={copy}
                locale={locale}
                retry={() => void applications.refetch()}
              />
            )}
          </TabsContent>
        )}
        {canFinance && (
          <TabsContent value="finance">
            {finance.isLoading ? (
              <ReportLoading />
            ) : (
              <FinancePanel
                report={finance.data}
                copy={copy}
                locale={locale}
                retry={() => void finance.refetch()}
              />
            )}
          </TabsContent>
        )}
        {canOperations && (
          <TabsContent value="quality">
            {quality.isLoading ? (
              <ReportLoading />
            ) : (
              <DataQualityPanel
                report={quality.data}
                copy={copy}
                retry={() => void quality.refetch()}
              />
            )}
          </TabsContent>
        )}
      </Tabs>

      <Card className="border-dashed">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <BookOpenCheck className="h-4 w-4 text-primary" />
            {copy.metricDictionary}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 lg:grid-cols-2">
            {meta.data?.metrics.map((metric) => (
              <div
                key={metric.key}
                className="rounded-xl border bg-muted/20 p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold">{metric.label}</p>
                  <code className="rounded bg-muted px-2 py-0.5 text-[10px]">
                    {metric.key}
                  </code>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  {metric.description}
                </p>
                <p className="mt-2 text-[10px] uppercase tracking-wide text-muted-foreground">
                  {copy.semantics}: {metric.timeSemantics.replaceAll("_", " ")}
                  {metric.denominator
                    ? ` · ${copy.denominator}: ${metric.denominator}`
                    : ""}
                </p>
              </div>
            ))}
          </div>
          <div className="mt-4 flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            <ShieldCheck className="h-4 w-4 shrink-0" />
            {copy.exportDisabled}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
