import { DashboardSkeleton } from "@/components/ui/page-skeleton";
import { useGetOverviewStats } from "@workspace/api-client-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { QuickLinkLogo } from "@/components/QuickLinkLogo";
import { Users, FileText, GraduationCap, ArrowUpRight, Clock, CalendarClock, ExternalLink, Activity, Bell, UserPlus, FileCheck, CreditCard, DollarSign, MessageCircle, Megaphone, AlertCircle, AlertTriangle, Shield, Link as LinkIcon, ClipboardList, CheckCheck, Play, CheckCircle2 } from "lucide-react";
import { formatMoney } from "@/lib/currency";
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import { Link } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { useI18n } from "@/hooks/use-i18n";
import { useToast } from "@/hooks/use-toast";
import { formatTimeAgo, getLocale } from "@/lib/i18n";
import { OfferDeadlinesWidget } from "@/components/OfferDeadlinesWidget";
import { useSeason } from "@/contexts/SeasonContext";
import { localizeNotification } from "@/lib/notificationLocalization";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

const AVATAR_COLORS = [
  "bg-blue-500/15 text-blue-600",
  "bg-purple-500/15 text-purple-600",
  "bg-emerald-500/15 text-emerald-600",
  "bg-amber-500/15 text-amber-600",
  "bg-rose-500/15 text-rose-600",
  "bg-cyan-500/15 text-cyan-600",
];

function getInitials(firstName?: string, lastName?: string) {
  return `${(firstName || "?")[0]}${(lastName || "?")[0]}`.toUpperCase();
}

const NOTIFICATION_ICONS: Record<string, typeof Bell> = {
  "lead.created": UserPlus,
  "lead.assigned": Users,
  "lead.stage_changed": Activity,
  "lead.follow_up_due": CalendarClock,
  "application.created": FileText,
  "application.stage_changed": FileCheck,
  "application.offer_received": GraduationCap,
  "application.visa_update": FileCheck,
  "student.created": GraduationCap,
  "student.document_uploaded": FileText,
  "student.status_changed": Activity,
  "finance.commission_confirmed": CreditCard,
  "finance.payment_received": DollarSign,
  "finance.payment_due": AlertCircle,
  "finance.agent_payout": CreditCard,
  "agent.new_registration": UserPlus,
  "agent.sub_agent_added": Users,
  "system.user_activated": Shield,
  "system.broadcast": Megaphone,
  "system.announcement": Megaphone,
  "message.new": MessageCircle,
  "message.mention": MessageCircle,
};


function isOverdue(d: string) { return new Date(d) < new Date(); }

export default function StaffDashboard() {
  const { user } = useAuth(true);
  const { t, lang } = useI18n();
  const { toast } = useToast();
  const dateLoc = getLocale(lang);
  const showOfferDeadlines = user?.role !== "super_admin";
  const { season } = useSeason();
  const { data: stats, isLoading } = useGetOverviewStats({ season });

  const { data: revenueMonth } = useQuery<any>({
    queryKey: ["/api/staff-cards/me/revenue-month"],
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/staff-cards/me/revenue-month`, { credentials: "include" });
      if (!r.ok) return null;
      return r.json();
    },
  });

  const { data: growthData = [] } = useQuery<any[]>({
    queryKey: ["/api/stats/growth", season],
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/stats/growth?season=${encodeURIComponent(season)}`, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      return Array.isArray(j) ? j : [];
    },
  });

  const { data: upcomingFollowUps = [] } = useQuery<any[]>({
    queryKey: ["/api/follow-ups/upcoming"],
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/follow-ups/upcoming`, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      return Array.isArray(j) ? j : [];
    },
    staleTime: 0,
    refetchOnMount: "always",
  });

  const staffDashboardRecentLimit = 20;
  const { data: latestStudentsData } = useQuery<any>({
    queryKey: ["/api/students", "staff-dashboard-latest", staffDashboardRecentLimit],
    queryFn: ({ signal }) => fetch(`${BASE}/api/students?limit=${staffDashboardRecentLimit}&page=1`, { credentials: "include", signal }).then(r => r.json()),
  });
  const latestStudents: any[] = latestStudentsData?.data || [];

  const { data: latestAuditData, isLoading: latestAuditLoading, isError: latestAuditError } = useQuery<any>({
    queryKey: ["/api/audit/dashboard", "staff-dashboard-latest", staffDashboardRecentLimit],
    queryFn: async ({ signal }) => {
      const r = await fetch(`${BASE}/api/audit/dashboard?limit=${staffDashboardRecentLimit}`, { credentials: "include", signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
  });
  const latestUpdates: any[] = latestAuditData?.data || [];

  const { data: notificationsData } = useQuery<any>({
    queryKey: ["/api/notifications", "staff-dashboard-latest"],
    queryFn: () => fetch(`${BASE}/api/notifications?limit=5`, { credentials: "include" }).then(r => r.json()),
  });
  const latestNotifications: any[] = notificationsData?.data || [];

  const { data: quickLinksData } = useQuery<any>({
    queryKey: ["/api/quick-links"],
    queryFn: () => fetch(`${BASE}/api/quick-links`, { credentials: "include" }).then(r => r.json()),
  });
  const quickLinks: any[] = quickLinksData?.data || [];

  const { data: contractAgents = [] } = useQuery<any[]>({
    queryKey: ["/api/agents/contract-alerts"],
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/agents/contract-alerts`, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      return Array.isArray(j) ? j : [];
    },
  });

  const queryClient = useQueryClient();

  const { data: myTasksData } = useQuery<{ data: any[] }>({
    queryKey: ["/api/tasks", "dashboard-mine"],
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/tasks?limit=5&archived=false&assignedTo=me`, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    enabled: !!user,
  });
  const myTasks: any[] = myTasksData?.data || [];

  async function updateTaskStatus(taskId: number, status: string) {
    try {
      const r = await fetch(`${BASE}/api/tasks/${taskId}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        toast({ title: t("common.error"), description: (body as any).error || `HTTP ${r.status}`, variant: "destructive" });
        return;
      }
      queryClient.invalidateQueries({ queryKey: ["/api/tasks", "dashboard-mine"] });
    } catch (err) {
      toast({ title: t("common.error"), description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    }
  }

  if (isLoading) {
    return (
        <DashboardSkeleton />
    );
  }

  return (
      <div className="space-y-8">
        <div>
          <h1 className="text-3xl font-display font-bold text-foreground">{t("staffDash.welcomeBack")}</h1>
          <p className="text-muted-foreground mt-1">{t("staffDash.welcomeSubtitle")}</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
          {[
            { label: t("staffDash.totalLeads"), value: stats?.totalLeads || 0, icon: Users, color: "text-blue-500", bg: "bg-blue-500/10", href: "/staff/leads" },
            { label: t("staffDash.activeApplications"), value: stats?.activeApplications || 0, icon: FileText, color: "text-purple-500", bg: "bg-purple-500/10", href: "/staff/applications" },
            { label: t("staffDash.studentsEnrolled"), value: (stats as any)?.enrolledStudents || 0, icon: GraduationCap, color: "text-green-500", bg: "bg-green-500/10", href: "/staff/students" },
            { label: t("staffDash.revenueMonth"), value: (() => { if (!revenueMonth) return (stats as any)?.monthlyRevenueByCurrency || { USD: (stats as any)?.monthlyRevenue || 0 }; const combined: Record<string, number> = { ...((revenueMonth.pendingSalaryByCurrency as Record<string, number>) || {}) }; combined["USD"] = (combined["USD"] || 0) + (revenueMonth.potentialBonus || 0); return combined; })(), icon: DollarSign, color: "text-emerald-500", bg: "bg-emerald-500/10", isMoney: true, href: "/staff/finance" },
          ].map((stat: any, i) => (
            <Link key={i} href={stat.href}>
              <Card className="p-6 border-none shadow-lg shadow-black/5 hover:-translate-y-1 hover:shadow-xl hover:shadow-black/10 transition-all duration-300 cursor-pointer">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-sm font-medium text-muted-foreground mb-1">{stat.label}</p>
                    {stat.isMoney ? (
                      <div className="space-y-0.5">
                        {(() => {
                          const entries = Object.entries(stat.value as Record<string, number>).filter(([, v]) => v !== 0);
                          if (entries.length === 0) entries.push(["USD", 0]);
                          return entries.map(([cur, v]) => (
                            <h3 key={cur} className="text-2xl font-display font-bold text-foreground leading-tight">{isLoading ? "..." : formatMoney(v as number, cur)}</h3>
                          ));
                        })()}
                      </div>
                    ) : (
                      <h3 className="text-3xl font-display font-bold text-foreground">{isLoading ? "..." : stat.value}</h3>
                    )}
                  </div>
                  <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${stat.bg}`}>
                    <stat.icon className={`w-6 h-6 ${stat.color}`} />
                  </div>
                </div>
              </Card>
            </Link>
          ))}
        </div>

        {contractAgents.length > 0 && (
          <Card className="p-5 border-none shadow-lg shadow-black/5 bg-gradient-to-r from-orange-50 to-red-50 dark:from-orange-950/20 dark:to-red-950/20">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-xl bg-orange-500/10 flex items-center justify-center">
                <AlertTriangle className="w-5 h-5 text-orange-500" />
              </div>
              <div>
                <h3 className="font-display font-bold text-sm">{t("staffDash.contractAlerts")}</h3>
                <p className="text-xs text-muted-foreground">{t("staffDash.agentsNeedAttention", { count: contractAgents.length })}</p>
              </div>
              <Link href="/staff/agents" className="ml-auto">
                <Badge variant="outline" className="text-xs cursor-pointer hover:bg-primary/10 gap-1">
                  {t("staffDash.viewAll")} <ArrowUpRight className="w-3 h-3" />
                </Badge>
              </Link>
            </div>
            <div className="space-y-2">
              {contractAgents.slice(0, 4).map((a: any) => {
                const daysLeft = Math.ceil((new Date(a.contractEndDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
                const isExpired = daysLeft <= 0;
                return (
                  <div key={a.id} className="flex items-center justify-between p-2.5 rounded-lg bg-white/60 dark:bg-card/40 border border-border/50">
                    <div className="flex items-center gap-2">
                      <div className={`w-2 h-2 rounded-full ${isExpired ? "bg-red-500" : "bg-orange-500 animate-pulse"}`} />
                      <span className="text-sm font-medium">{a.firstName} {a.lastName}</span>
                      {a.companyName && <span className="text-xs text-muted-foreground">({a.companyName})</span>}
                    </div>
                    <Badge variant="outline" className={`text-xs ${isExpired ? "bg-red-500/10 text-red-600 border-red-200" : "bg-orange-500/10 text-orange-600 border-orange-200"}`}>
                      {isExpired ? t("common.expiredAgo", { n: Math.abs(daysLeft) }) : t("common.daysLeft", { n: daysLeft })}
                    </Badge>
                  </div>
                );
              })}
            </div>
          </Card>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <Card className="p-6 border-none shadow-lg shadow-black/5">
            <div className="flex items-center gap-2 mb-5">
              <div className="w-8 h-8 rounded-lg bg-green-500/10 flex items-center justify-center">
                <GraduationCap className="w-4 h-4 text-green-500" />
              </div>
              <h3 className="font-display font-bold text-base">{t("staffDash.latestStudents")}</h3>
            </div>
            <div className="space-y-3 max-h-[320px] overflow-y-auto">
              {latestStudents.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("staffDash.noStudents")}</p>
              ) : (
                latestStudents.map((s: any, i: number) => (
                  <Link key={s.id} href={`/staff/students/${s.id}`}>
                    <div className="flex items-center gap-3 p-2.5 rounded-xl hover:bg-secondary/50 transition-colors cursor-pointer group">
                      <div className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold shrink-0 overflow-hidden ${AVATAR_COLORS[i % AVATAR_COLORS.length]}`}>
                        <img
                          src={s.photoUrl || `${BASE}/api/students/${s.id}/photo/thumbnail`}
                          alt={`${s.firstName} ${s.lastName}`}
                          loading="lazy"
                          decoding="async"
                          className="w-full h-full object-cover"
                          onError={(e) => {
                            const el = e.target as HTMLImageElement;
                            el.style.display = "none";
                            el.parentElement!.textContent = getInitials(s.firstName, s.lastName);
                          }}
                        />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-foreground truncate uppercase">
                          {s.firstName} {s.lastName}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {new Date(s.createdAt).toLocaleDateString(dateLoc, { day: "numeric", month: "short", year: "numeric" })}{", "}
                          {new Date(s.createdAt).toLocaleTimeString(dateLoc, { hour: "numeric", minute: "2-digit" })}
                        </p>
                      </div>
                      <Badge variant="secondary" className="text-[10px] w-6 h-6 rounded-full p-0 flex items-center justify-center shrink-0 bg-primary/10 text-primary font-bold">
                        {i + 1}
                      </Badge>
                    </div>
                  </Link>
                ))
              )}
            </div>
          </Card>

          <Card className="p-6 border-none shadow-lg shadow-black/5">
            <div className="flex items-center gap-2 mb-5">
              <div className="w-8 h-8 rounded-lg bg-purple-500/10 flex items-center justify-center">
                <Activity className="w-4 h-4 text-purple-500" />
              </div>
              <h3 className="font-display font-bold text-base">{t("staffDash.latestUpdates")}</h3>
            </div>
            <div className="space-y-3 max-h-[320px] overflow-y-auto">
              {latestAuditLoading ? (
                <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
              ) : latestAuditError ? (
                <p className="text-sm text-destructive">{t("common.error")}</p>
              ) : latestUpdates.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("staffDash.noUpdates")}</p>
              ) : (
                latestUpdates.map((u: any, i: number) => {
                  const detailCollection = u.resource === "application" ? "applications"
                    : u.resource === "student" ? "students"
                    : u.resource === "lead" ? "leads"
                    : null;
                  const detailHref = detailCollection && u.resourceId
                    ? `/staff/${detailCollection}/${u.resourceId}`
                    : null;
                  const actionLabel = (u.action || "").replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
                  const resourceLabel = (u.resource || "").replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
                  const changes = u.changes && typeof u.changes === "object"
                    ? Object.entries(u.changes)
                        .filter(([k]) => !["id", "updatedAt"].includes(k))
                        .slice(0, 2)
                        .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)
                        .join(", ")
                    : "";
                  const Wrapper = detailHref ? Link : "div" as any;
                  const wrapperProps = detailHref ? { href: detailHref } : {};
                  return (
                    <Wrapper key={u.id} {...wrapperProps}>
                      <div className={`flex items-start gap-3 p-2.5 rounded-xl hover:bg-secondary/50 transition-colors ${detailHref ? "cursor-pointer" : ""}`}>
                        <div className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold shrink-0 mt-0.5 ${AVATAR_COLORS[(i + 2) % AVATAR_COLORS.length]}`}>
                          {u.userName ? u.userName.split(" ").map((n: string) => n[0]).join("").slice(0, 2).toUpperCase() : "SY"}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold text-foreground truncate">
                            {u.userName || t("common.system")}
                          </p>
                          <p className="text-xs text-foreground/80 font-medium mt-0.5">
                            {actionLabel}{resourceLabel ? ` — ${resourceLabel}` : ""}
                            {u.resourceId ? ` #${u.resourceId}` : ""}
                          </p>
                          {changes && (
                            <p className="text-[11px] text-muted-foreground line-clamp-1 mt-0.5">{changes}</p>
                          )}
                        </div>
                        <div className="flex flex-col items-end shrink-0 mt-1">
                          <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                            {formatTimeAgo(lang, u.createdAt)}
                          </span>
                          {detailHref && <ArrowUpRight className="w-3 h-3 text-muted-foreground mt-1" />}
                        </div>
                      </div>
                    </Wrapper>
                  );
                })
              )}
            </div>
          </Card>

          <Card className="p-6 border-none shadow-lg shadow-black/5">
            <div className="flex items-center gap-2 mb-5">
              <div className="w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center">
                <Bell className="w-4 h-4 text-amber-500" />
              </div>
              <h3 className="font-display font-bold text-base">{t("staffDash.notifications")}</h3>
            </div>
            <div className="space-y-3 max-h-[320px] overflow-y-auto">
              {latestNotifications.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("staffDash.noNotifications")}</p>
              ) : (
                latestNotifications.map((n: any) => {
                  const NIcon = NOTIFICATION_ICONS[n.type] || Bell;
                  const localized = localizeNotification(n, lang);
                  return (
                    <div key={n.id} className={`p-3 rounded-xl border transition-colors ${n.isRead ? "bg-secondary/20 border-border/50" : "bg-primary/5 border-primary/20"}`}>
                      <div className="flex items-start gap-2.5">
                        <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${n.isRead ? "bg-muted/50" : "bg-primary/10"}`}>
                          <NIcon className={`w-3.5 h-3.5 ${n.isRead ? "text-muted-foreground" : "text-primary"}`} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className={`text-sm font-medium line-clamp-1 ${n.isRead ? "text-muted-foreground" : "text-foreground"}`}>
                            {localized.title}
                          </p>
                          {localized.body && (
                            <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{localized.body}</p>
                          )}
                        </div>
                        <span className="text-[10px] text-muted-foreground whitespace-nowrap shrink-0 mt-0.5">
                          {formatTimeAgo(lang, n.createdAt)}
                        </span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </Card>
        </div>

        <div className="grid lg:grid-cols-3 gap-6">
          <Card className="p-6 border-none shadow-lg shadow-black/5">
            <h3 className="font-display font-bold text-base mb-4">{t("staffDash.growthOverview")}</h3>
            <div className="h-[200px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={growthData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorLeads" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3}/>
                      <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                  <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{fill: 'hsl(var(--muted-foreground))', fontSize: 11}} dy={10} />
                  <YAxis axisLine={false} tickLine={false} tick={{fill: 'hsl(var(--muted-foreground))', fontSize: 11}} />
                  <Tooltip
                    contentStyle={{ backgroundColor: 'hsl(var(--card))', borderRadius: '8px', border: '1px solid hsl(var(--border))', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                    itemStyle={{ color: 'hsl(var(--foreground))' }}
                  />
                  <Area type="monotone" dataKey="leads" stroke="hsl(var(--primary))" strokeWidth={2} fillOpacity={1} fill="url(#colorLeads)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Card>

          <Card className="p-6 border-none shadow-lg shadow-black/5">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center">
                <ClipboardList className="w-4 h-4 text-blue-500" />
              </div>
              <h3 className="font-display font-bold text-base flex-1">{t("staffDash.myTasks")}</h3>
              <Link href="/staff/tasks">
                <Badge variant="outline" className="text-xs cursor-pointer hover:bg-primary/10 gap-1">
                  {t("staffDash.viewAllTasks")} <ArrowUpRight className="w-3 h-3" />
                </Badge>
              </Link>
            </div>
            <div className="space-y-2 max-h-[260px] overflow-y-auto">
              {myTasks.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("staffDash.noMyTasks")}</p>
              ) : (
                myTasks.map((tk: any) => {
                  const priorityClass = tk.priority === "high"
                    ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"
                    : tk.priority === "medium"
                    ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300"
                    : "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300";
                  const isDone = tk.status === "done";
                  const isInProgress = tk.status === "in_progress";
                  return (
                    <Link key={tk.id} href="/staff/tasks">
                      <div className="flex items-center gap-2 p-2.5 rounded-xl hover:bg-secondary/50 transition-colors cursor-pointer group">
                        <div className="min-w-0 flex-1">
                          <p className={`text-sm font-medium truncate ${isDone ? "line-through text-muted-foreground" : "text-foreground"}`}>
                            {tk.title}
                          </p>
                          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                            <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${priorityClass}`}>
                              {tk.priority}
                            </span>
                            {tk.dueDate && (
                              <span className={`text-[10px] ${new Date(tk.dueDate) < new Date() && !isDone ? "text-red-500 font-semibold" : "text-muted-foreground"}`}>
                                {new Date(tk.dueDate).toLocaleDateString(dateLoc, { day: "2-digit", month: "2-digit" })}
                              </span>
                            )}
                          </div>
                        </div>
                        {isDone ? (
                          <CheckCircle2 className="w-5 h-5 text-green-500 shrink-0" />
                        ) : (
                          <button
                            onClick={(e) => { e.preventDefault(); e.stopPropagation(); void updateTaskStatus(tk.id, isInProgress ? "done" : "in_progress"); }}
                            className={`shrink-0 flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-lg border transition-colors ${
                              isInProgress
                                ? "border-green-300 text-green-700 hover:bg-green-50 dark:border-green-700 dark:text-green-400 dark:hover:bg-green-950/30"
                                : "border-blue-300 text-blue-700 hover:bg-blue-50 dark:border-blue-700 dark:text-blue-400 dark:hover:bg-blue-950/30"
                            }`}
                          >
                            {isInProgress ? (
                              <><CheckCheck className="w-3 h-3" />{t("staffDash.taskDone")}</>
                            ) : (
                              <><Play className="w-3 h-3" />{t("staffDash.taskStart")}</>
                            )}
                          </button>
                        )}
                      </div>
                    </Link>
                  );
                })
              )}
            </div>
          </Card>

          <Card className="p-6 border-none shadow-lg shadow-black/5">
            <div className="flex items-center gap-2 mb-6">
              <CalendarClock className="w-5 h-5 text-primary" />
              <h3 className="font-display font-bold text-lg">{t("staffDash.upcomingFollowUps")}</h3>
            </div>
            <div className="space-y-3">
              {(upcomingFollowUps as any[]).length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("staffDash.noFollowUps")}</p>
              ) : (
                (upcomingFollowUps as any[]).slice(0, 6).map((fu: any) => (
                  <Link key={fu.id} href={fu.leadId ? `/staff/leads/${fu.leadId}` : fu.studentId ? `/staff/students/${fu.studentId}` : "#"}>
                    <div className={`p-3 rounded-xl border cursor-pointer hover:scale-[1.02] transition-transform ${
                      isOverdue(fu.scheduledAt) ? "bg-red-50 border-red-200" : "bg-secondary/30 border-border"
                    }`}>
                      <div className="flex items-start justify-between">
                        <p className="text-sm font-medium text-foreground line-clamp-1">{fu.title}</p>
                        <ExternalLink className="w-3 h-3 text-muted-foreground shrink-0 mt-0.5" />
                      </div>
                      {fu.leadName && (
                        <p className="text-xs text-primary mt-0.5">{fu.leadName}</p>
                      )}
                      <p className={`text-xs mt-1 ${isOverdue(fu.scheduledAt) ? "text-red-600 font-semibold" : "text-muted-foreground"}`}>
                        {new Date(fu.scheduledAt).toLocaleDateString(dateLoc, { day: "2-digit", month: "2-digit", year: "numeric" })}
                        {" "}
                        {new Date(fu.scheduledAt).toLocaleTimeString(dateLoc, { hour: "2-digit", minute: "2-digit" })}
                        {isOverdue(fu.scheduledAt) && ` — ${t("common.overdue")}`}
                      </p>
                      {(fu.updatedByName ?? fu.createdByName) && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {fu.updatedByName ? t("staffDash.followUpLastEditedBy", { name: fu.updatedByName }) : t("staffDash.followUpCreatedBy", { name: fu.createdByName })}
                        </p>
                      )}
                    </div>
                  </Link>
                ))
              )}
            </div>
          </Card>
        </div>

        {quickLinks.length > 0 && (
          <Card className="p-6 border-none shadow-lg shadow-black/5">
            <div className="flex items-center gap-2 mb-5">
              <div className="w-8 h-8 rounded-lg bg-violet-500/10 flex items-center justify-center">
                <LinkIcon className="w-4 h-4 text-violet-500" />
              </div>
              <h3 className="font-display font-bold text-base">{t("staffDash.quickLinks")}</h3>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {quickLinks.map((link: any) => (
                <a
                  key={link.id}
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 p-3 rounded-xl border border-border/60 hover:bg-primary/5 hover:border-primary/30 transition-all group"
                >
                  <QuickLinkLogo logoUrl={link.logoUrl} title={link.title} icon={link.icon} color={link.color} className="w-9 h-9" />
                  <span className="text-sm font-medium text-foreground truncate group-hover:text-primary transition-colors">{link.title}</span>
                </a>
              ))}
            </div>
          </Card>
        )}

        {showOfferDeadlines && (
          <OfferDeadlinesWidget detailHrefPrefix="/staff/applications" />
        )}

      </div>
  );
}
