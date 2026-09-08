import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { QuickLinkLogo } from "@/components/QuickLinkLogo";
import { useGetOverviewStats } from "@workspace/api-client-react";
import { useAuth } from "@/hooks/use-auth";
import { useI18n } from "@/hooks/use-i18n";
import { formatTimeAgo, getLocale } from "@/lib/i18n";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useLocation } from "wouter";
import { CreateLeadDialog } from "@/components/agent/CreateLeadDialog";
import { AddStudentModal } from "@/components/agent/AddStudentModal";
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import {
  Users, TrendingUp, Clock, CheckCircle, GraduationCap, Activity, Bell,
  UserPlus, FileText, FileCheck, DollarSign, CreditCard, CalendarClock,
  MessageCircle, Megaphone, AlertCircle, Shield, Mail, Phone,
  ExternalLink, UserPlus as AddStudent, Plus, ArrowUpRight,
  FileSignature, AlertTriangle,
} from "lucide-react";
import { OfferDeadlinesWidget } from "@/components/OfferDeadlinesWidget";
import { useSeason } from "@/contexts/SeasonContext";
import { usePipelineStages } from "@/hooks/use-pipeline-stages";
import SignContract from "@/pages/agent/SignContract";
import { localizeNotification } from "@/lib/notificationLocalization";
import { UpcomingFollowUpsWidget } from "@/components/UpcomingFollowUpsWidget";

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

export default function AgentDashboard() {
  const { user } = useAuth(true);
  const { t, lang } = useI18n();
  const dateLoc = getLocale(lang);
  const [, setLocation] = useLocation();
  const [showAddLead, setShowAddLead] = useState(false);
  const [showAddStudent, setShowAddStudent] = useState(false);
  const { stages: pipelineStages } = usePipelineStages("student");
  const { season } = useSeason();
  const { data: stats, isLoading: statsLoading } = useGetOverviewStats({ season });

  const { data: growthData = [] } = useQuery<any[]>({
    queryKey: ["/api/stats/growth", season],
    queryFn: () => fetch(`${BASE}/api/stats/growth?season=${encodeURIComponent(season)}`, { credentials: "include" }).then(r => r.json()),
  });

  const { data: agentProfile } = useQuery<any>({
    queryKey: ["/api/agents/me"],
    queryFn: () => fetch(`${BASE}/api/agents/me`, { credentials: "include" }).then(r => r.json()),
    enabled: !!user,
  });

  const { data: latestStudentsData } = useQuery<any>({
    queryKey: ["/api/students", "agent-dashboard-latest"],
    queryFn: () => fetch(`${BASE}/api/students?limit=5&page=1`, { credentials: "include" }).then(r => r.json()),
  });
  const latestStudents: any[] = latestStudentsData?.data || [];

  const { data: latestAuditData } = useQuery<any>({
    queryKey: ["/api/audit", "agent-dashboard-latest"],
    queryFn: () => fetch(`${BASE}/api/audit?limit=5&page=1`, { credentials: "include" }).then(r => r.json()),
  });
  const latestUpdates: any[] = latestAuditData?.data || [];

  const { data: notificationsData } = useQuery<any>({
    queryKey: ["/api/notifications", "agent-dashboard-latest"],
    queryFn: () => fetch(`${BASE}/api/notifications?limit=5`, { credentials: "include" }).then(r => r.json()),
  });
  const latestNotifications: any[] = notificationsData?.data || [];

  const { data: quickLinksData } = useQuery<any>({
    queryKey: ["/api/quick-links"],
    queryFn: () => fetch(`${BASE}/api/quick-links`, { credentials: "include" }).then(r => r.json()),
    enabled: !!user,
  });
  const quickLinks: any[] = quickLinksData?.data || [];

  const s: any = stats || {};
  const assignedStaff = agentProfile?.assignedStaff;
  const parentAgent = agentProfile?.parentAgent;
  const contactPerson = user?.role === "sub_agent" ? parentAgent : assignedStaff;
  const commercialAccess = agentProfile?.accessTier === "full";

  return (
    <>
      <div className="space-y-8">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-display font-bold text-foreground">{t("agentDash.title")}</h1>
            <p className="text-muted-foreground mt-1">{t("agentDash.subtitle")}</p>
          </div>
        </div>

        <OnboardingContractBanner />
        <PendingContractsCard />

        {agentProfile?.accessTier === "provisional" && (
          <Card className="p-5 border border-blue-500/30 bg-blue-500/5 shadow-md shadow-black/5">
            <div className="flex items-start gap-3">
              <Shield className="mt-0.5 h-5 w-5 shrink-0 text-blue-600" />
              <div>
                <p className="font-display font-bold text-foreground">{t("agentDash.provisionalAccess.title")}</p>
                <p className="mt-1 text-sm text-muted-foreground">{t("agentDash.provisionalAccess.body")}</p>
              </div>
            </div>
          </Card>
        )}

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[
            { label: t("agentDash.totalStudents"), value: s.totalStudents || 0, icon: Users, color: "text-blue-500", bg: "bg-blue-500/10", href: "/agent/students" },
            { label: t("agentDash.activeApplications"), value: s.activeApplications || 0, icon: Clock, color: "text-amber-500", bg: "bg-amber-500/10", href: "/agent/applications" },
            { label: t("agentDash.enrolled"), value: s.enrolledStudents || 0, icon: CheckCircle, color: "text-green-500", bg: "bg-green-500/10", href: "/agent/students" },
            { label: t("agentDash.totalLeads"), value: s.totalLeads || 0, icon: TrendingUp, color: "text-purple-500", bg: "bg-purple-500/10", href: "/agent/leads" },
          ].map((st, i) => (
            <Card key={i} className="p-5 border-none shadow-md shadow-black/5 hover:-translate-y-1 transition-transform cursor-pointer" onClick={() => setLocation(st.href)}>
              <div className={`w-10 h-10 rounded-xl ${st.bg} flex items-center justify-center mb-3`}>
                <st.icon className={`w-5 h-5 ${st.color}`} />
              </div>
              <p className="text-xs text-muted-foreground font-medium">{st.label}</p>
              <p className="text-2xl font-display font-bold text-foreground mt-1">{statsLoading ? "..." : st.value}</p>
            </Card>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <Card className="p-6 border-none shadow-lg shadow-black/5">
            <div className="flex items-center gap-2 mb-5">
              <div className="w-8 h-8 rounded-lg bg-green-500/10 flex items-center justify-center">
                <GraduationCap className="w-4 h-4 text-green-500" />
              </div>
              <h3 className="font-display font-bold text-base">{t("agentDash.latestStudents")}</h3>
            </div>
            <div className="space-y-3 max-h-[320px] overflow-y-auto">
              {latestStudents.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("agentDash.noStudents")}</p>
              ) : (
                latestStudents.map((st2: any, i: number) => (
                  <Link key={st2.id} href="/agent/students">
                    <div className="flex items-center gap-3 p-2.5 rounded-xl hover:bg-secondary/50 transition-colors cursor-pointer">
                      <div className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold shrink-0 overflow-hidden ${AVATAR_COLORS[i % AVATAR_COLORS.length]}`}>
                        <img
                          src={st2.photoUrl || `${BASE}/api/students/${st2.id}/photo/thumbnail`}
                          alt={`${st2.firstName} ${st2.lastName}`}
                          className="w-full h-full object-cover"
                          onError={(e) => {
                            const el = e.target as HTMLImageElement;
                            el.style.display = "none";
                            el.parentElement!.textContent = getInitials(st2.firstName, st2.lastName);
                          }}
                        />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-foreground truncate uppercase">
                          {st2.firstName} {st2.lastName}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {new Date(st2.createdAt).toLocaleDateString(dateLoc, { day: "numeric", month: "short", year: "numeric" })}{", "}
                          {new Date(st2.createdAt).toLocaleTimeString(dateLoc, { hour: "numeric", minute: "2-digit" })}
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
              <h3 className="font-display font-bold text-base">{t("agentDash.latestUpdates")}</h3>
            </div>
            <div className="space-y-3 max-h-[320px] overflow-y-auto">
              {latestUpdates.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("agentDash.noUpdates")}</p>
              ) : (
                latestUpdates.map((u: any, i: number) => {
                  const detailHref = u.resource && u.resourceId
                    ? `/agent/${u.resource === "application" ? "applications" : u.resource === "student" ? "students" : u.resource === "lead" ? "leads" : ""}/${u.resourceId}`
                    : null;
                  const actionLabel = (u.action || "").replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
                  const resourceLabel = (u.resource || "").replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
                  const changes = u.data ? Object.entries(u.data).filter(([k]) => !["id", "updatedAt"].includes(k)).slice(0, 2).map(([k, v]) => `${k}: ${v}`).join(", ") : "";
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
              <h3 className="font-display font-bold text-base">{t("agentDash.notifications")}</h3>
            </div>
            <div className="space-y-3 max-h-[320px] overflow-y-auto">
              {latestNotifications.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("agentDash.noNotifications")}</p>
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

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {contactPerson && (
            <Card className="p-6 border-none shadow-lg shadow-black/5">
              <div className="flex items-center gap-2 mb-5">
                <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center">
                  <Users className="w-4 h-4 text-blue-500" />
                </div>
                <h3 className="font-display font-bold text-base">{t("agentDash.yourContactPerson")}</h3>
              </div>
              <div className="flex items-center gap-4 mb-4">
                <div className="w-14 h-14 rounded-full bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center text-lg font-bold text-primary shrink-0 overflow-hidden">
                  {contactPerson.avatarUrl ? (
                    <img src={contactPerson.avatarUrl} alt="" className="w-full h-full object-cover" />
                  ) : (
                    getInitials(contactPerson.firstName, contactPerson.lastName)
                  )}
                </div>
                <div className="min-w-0">
                  <p className="font-semibold text-foreground">{contactPerson.firstName} {contactPerson.lastName}</p>
                  <p className="text-xs text-muted-foreground capitalize">{(contactPerson.role || "").replace(/_/g, " ")}</p>
                </div>
              </div>
              <div className="space-y-2 mb-4">
                {contactPerson.email && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Mail className="w-3.5 h-3.5 shrink-0" />
                    <a href={`mailto:${contactPerson.email}`} className="hover:text-primary truncate">{contactPerson.email}</a>
                  </div>
                )}
                {contactPerson.phone && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Phone className="w-3.5 h-3.5 shrink-0" />
                    <a href={`tel:${contactPerson.phone}`} className="hover:text-primary">{contactPerson.phone}</a>
                  </div>
                )}
              </div>
              <Button
                size="sm"
                className="w-full gap-2"
                onClick={() => setLocation(`/agent/messages?recipient=${contactPerson.id}`)}
              >
                <MessageCircle className="w-4 h-4" /> {t("agentDash.sendMessage")}
              </Button>
            </Card>
          )}

          {commercialAccess && <Card className={`p-6 border-none shadow-lg shadow-black/5 ${!contactPerson ? "lg:col-span-1" : ""}`}>
            <div className="flex items-center gap-2 mb-5">
              <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center">
                <Plus className="w-4 h-4 text-emerald-500" />
              </div>
              <h3 className="font-display font-bold text-base">{t("agentDash.quickActions")}</h3>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Button
                variant="outline"
                className="h-auto py-4 flex flex-col items-center gap-2 hover:bg-primary/5 hover:border-primary/30"
                onClick={() => setShowAddLead(true)}
              >
                <div className="w-10 h-10 rounded-xl bg-blue-500/10 flex items-center justify-center">
                  <UserPlus className="w-5 h-5 text-blue-500" />
                </div>
                <span className="text-xs font-medium">{t("agentDash.addLead")}</span>
              </Button>
              <Button
                variant="outline"
                className="h-auto py-4 flex flex-col items-center gap-2 hover:bg-primary/5 hover:border-primary/30"
                onClick={() => setShowAddStudent(true)}
              >
                <div className="w-10 h-10 rounded-xl bg-green-500/10 flex items-center justify-center">
                  <GraduationCap className="w-5 h-5 text-green-500" />
                </div>
                <span className="text-xs font-medium">{t("agentDash.addStudent")}</span>
              </Button>
            </div>
          </Card>}

          {quickLinks.length > 0 && (
            <Card className="p-6 border-none shadow-lg shadow-black/5">
              <div className="flex items-center gap-2 mb-5">
                <div className="w-8 h-8 rounded-lg bg-violet-500/10 flex items-center justify-center">
                  <ExternalLink className="w-4 h-4 text-violet-500" />
                </div>
                <h3 className="font-display font-bold text-base">{t("agentDash.quickLinks")}</h3>
              </div>
              <div className="grid grid-cols-2 gap-3">
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
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <OfferDeadlinesWidget detailHrefPrefix="/agent/applications" />
          <UpcomingFollowUpsWidget detailHrefPrefix="/agent" />
        </div>

        <Card className="p-6 border-none shadow-lg shadow-black/5">
          <h3 className="font-display font-bold text-lg mb-6">{t("agentDash.growthOverview")}</h3>
          <div className="h-[250px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={growthData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="agentLeads" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0}/>
                  </linearGradient>
                  <linearGradient id="agentStudents" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#22c55e" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="#22c55e" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{fill: 'hsl(var(--muted-foreground))', fontSize: 12}} dy={10} />
                <YAxis axisLine={false} tickLine={false} tick={{fill: 'hsl(var(--muted-foreground))', fontSize: 12}} />
                <Tooltip contentStyle={{ backgroundColor: 'hsl(var(--card))', borderRadius: '8px', border: '1px solid hsl(var(--border))' }} />
                <Area type="monotone" dataKey="students" name={t("agentDash.totalStudents")} stroke="#22c55e" strokeWidth={2.5} fillOpacity={1} fill="url(#agentStudents)" />
                <Area type="monotone" dataKey="applications" name={t("agentDash.activeApplications")} stroke="hsl(var(--primary))" strokeWidth={2.5} fillOpacity={1} fill="url(#agentLeads)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Card>

      </div>

      {commercialAccess && (
        <>
          <CreateLeadDialog open={showAddLead} onOpenChange={setShowAddLead} />
          <AddStudentModal
            open={showAddStudent}
            onClose={() => setShowAddStudent(false)}
            onSuccess={() => setShowAddStudent(false)}
            defaultStatus={pipelineStages[0]?.key}
          />
        </>
      )}
    </>
  );
}

interface PendingContract {
  sessionId: number;
  status: string;
  expiresAt: string;
  templateName: string | null;
}

/**
 * Presentational reminder banner (the amber "Contract awaiting your signature"
 * card). Self-contained live countdown. Reused by both the admin-sent contracts
 * card and the primary onboarding reminder so they stay visually identical.
 */
function ContractReminderCard({ templateName, expiresAt, onSign }: { templateName: string | null; expiresAt: string; onSign: () => void; }) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  function countdown() {
    const diff = new Date(expiresAt).getTime() - now;
    if (diff <= 0) return t("agentDash.pendingContract.expired") || "Expired";
    const days = Math.floor(diff / 86_400_000);
    const hours = Math.floor((diff % 86_400_000) / 3_600_000);
    const minutes = Math.floor((diff % 3_600_000) / 60_000);
    const parts: string[] = [];
    if (days > 0) parts.push(`${days} ${t("agentDash.pendingContract.unitDay") || "d"}`);
    parts.push(`${hours} ${t("agentDash.pendingContract.unitHour") || "h"}`);
    parts.push(`${minutes} ${t("agentDash.pendingContract.unitMinute") || "m"}`);
    return parts.join(" ");
  }

  const dateLabel = new Date(expiresAt).toLocaleString();
  return (
    <Card className="p-5 border border-amber-500/30 bg-amber-500/5 shadow-md shadow-black/5">
      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
        <div className="w-10 h-10 rounded-xl bg-amber-500/15 flex items-center justify-center shrink-0">
          <AlertTriangle className="w-5 h-5 text-amber-600" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-display font-bold text-foreground">{t("agentDash.pendingContract.title")}</p>
          <p className="text-sm text-muted-foreground mt-0.5">
            {t("agentDash.pendingContract.body")}
            {templateName ? ` — ${templateName}` : ""}
          </p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-xs">
            <span className="text-muted-foreground">
              {t("agentDash.pendingContract.deadlineLabel")}: <strong className="text-foreground">{dateLabel}</strong>
            </span>
            <span className="inline-flex items-center gap-1 text-amber-700 font-semibold">
              <Clock className="w-3.5 h-3.5" /> {countdown()}
            </span>
          </div>
          <p className="text-[11px] text-amber-700/80 mt-1">{t("agentDash.pendingContract.warning")}</p>
        </div>
        <Button className="shrink-0 gap-2" onClick={onSign}>
          <FileSignature className="w-4 h-4" /> {t("agentDash.pendingContract.signNow")}
        </Button>
      </div>
    </Card>
  );
}

/**
 * Reminder for the agent's PRIMARY onboarding contract. The onboarding modal is
 * dismissible ("Later") before the deadline day; once dismissed the dashboard
 * is shown, so this banner keeps the contract visible with a "Sign now" action.
 * The signing flow is opened WITHOUT a sessionId so the onboarding intake step
 * ("Agency Information") is collected, mirroring AgentOnboardingGuard.
 */
function OnboardingContractBanner() {
  const qc = useQueryClient();
  const [signing, setSigning] = useState(false);

  // Authoritative gate: onboarding-status resolves "signed" across ALL sessions
  // (including resends) and is immune to PDF-cache regenerates, so a signed
  // agent is never nagged even if /api/contracts/me momentarily reports the
  // primary session as pending.
  const { data: onboarding } = useQuery<{ contractStatus: string }>({
    queryKey: ["/api/agents/me/onboarding-status"],
    queryFn: () => fetch(`${BASE}/api/agents/me/onboarding-status`, { credentials: "include" }).then(r => r.json()),
  });

  const { data } = useQuery<{ data: { status: string; expiresAt: string; template: { name: string | null } | null } | null }>({
    queryKey: ["/api/contracts/me"],
    queryFn: () => fetch(`${BASE}/api/contracts/me`, { credentials: "include" }).then(r => r.json()),
  });
  const sess = data?.data || null;
  const pending = onboarding?.contractStatus === "pending"
    && !!sess && (sess.status === "intake_pending" || sess.status === "review_pending");

  if (!pending || !sess) return null;

  return (
    <>
      <ContractReminderCard
        templateName={sess.template?.name ?? null}
        expiresAt={sess.expiresAt}
        onSign={() => setSigning(true)}
      />
      {signing && (
        <SignContract
          asModal
          onClose={() => setSigning(false)}
          onSigned={() => {
            setSigning(false);
            void qc.invalidateQueries({ queryKey: ["/api/contracts/me"] });
            // Reload so AgentOnboardingGuard (which caches onboarding-status per
            // mount, outside react-query) re-evaluates and clears any stale
            // pending state after the primary onboarding contract is signed.
            window.location.reload();
          }}
        />
      )}
    </>
  );
}

/**
 * Non-blocking warning cards for admin-sent contracts the agent still needs to
 * sign. Shows a live countdown to the signing deadline and a "Sign now" action
 * that opens the in-panel signing flow. After the deadline the backend suspends
 * the account, so these cards remind on every dashboard visit.
 */
function PendingContractsCard() {
  const qc = useQueryClient();
  const [signing, setSigning] = useState<number | null>(null);

  const { data } = useQuery<{ data: PendingContract[] }>({
    queryKey: ["/api/contracts/me/pending"],
    queryFn: () => fetch(`${BASE}/api/contracts/me/pending`, { credentials: "include" }).then(r => r.json()),
  });
  const pending = data?.data || [];

  if (pending.length === 0) return null;

  return (
    <>
      {pending.map((c) => (
        <ContractReminderCard
          key={c.sessionId}
          templateName={c.templateName}
          expiresAt={c.expiresAt}
          onSign={() => setSigning(c.sessionId)}
        />
      ))}
      {signing !== null && (
        <SignContract
          asModal
          sessionId={signing}
          onClose={() => setSigning(null)}
          onSigned={() => {
            setSigning(null);
            void qc.invalidateQueries({ queryKey: ["/api/contracts/me/pending"] });
          }}
        />
      )}
    </>
  );
}
