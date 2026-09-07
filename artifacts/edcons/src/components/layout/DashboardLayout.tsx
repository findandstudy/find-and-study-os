import { ReactNode, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { useI18n } from "@/hooks/use-i18n";
import { useSeo } from "@/hooks/use-seo";
import { useSeason } from "@/contexts/SeasonContext";
import { useTheme } from "@/contexts/ThemeContext";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { performLogout } from "@/lib/logout";
import { customFetch } from "@workspace/api-client-react";
import { FINANCE_ROLES } from "@workspace/roles";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { 
  SidebarProvider, 
  Sidebar, 
  SidebarContent, 
  SidebarGroup, 
  SidebarGroupContent, 
  SidebarMenu, 
  SidebarMenuItem, 
  SidebarMenuButton,
  SidebarMenuAction,
  SidebarTrigger
} from "@/components/ui/sidebar";
import { 
  LayoutDashboard, 
  Users, 
  GraduationCap, 
  FileText, 
  Briefcase, 
  Settings, 
  Shield,
  ShieldCheck,
  UserCheck,
  DollarSign,
  Activity,
  Link2,
  TrendingUp,
  Library,
  UserCircle,
  CalendarDays,
  Search,
  Sun,
  Moon,
  Handshake,
  MessageCircle,
  Code2,
  Heart,
  MessageSquare,
  ArrowLeftCircle,
  Globe,
  Component,
  Menu,
  BookOpen,
  Layers,
  ClipboardList,
  ClipboardCheck,
  Megaphone,
  Palette,
  Languages,
  History,
  Bell,
  Star,
  Building,
  IdCard,
  Sparkles,
  ListChecks,
  FileSearch,
  KeyRound,
  Bot,
  ExternalLink,
  Gauge,
  HeartPulse,
  Maximize2,
  Minimize2,
  School,
  Inbox,
  Timer,
  BarChart3,
} from "lucide-react";
import { PopupRenderer } from "@/components/PopupRenderer";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { NotificationCenter } from "@/components/NotificationCenter";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LogOut, ChevronUp, ChevronDown, User } from "lucide-react";

type MenuItem = { title: string; icon: typeof LayoutDashboard; url: string; group?: string; permKey?: string; externalHref?: string };
type TFunc = (key: string, params?: Record<string, string | number>) => string;

// Keep the daily workspace immediately visible while the active group opens
// automatically. This prevents the larger administrative IA from becoming one
// long, permanently expanded list.
const DEFAULT_CLOSED_GROUPS = new Set([
  "studentApplications",
  "partnersContracts",
  "catalogAcademy",
  "financePricing",
  "growthContentWeb",
  "analyticsQuality",
  "automationIntegrations",
  "systemManagement",
]);

function getMenuForRole(
  role: string,
  t: TFunc,
  agentStaffPerms?: string[],
  hasPermFn?: (key: string) => boolean,
  agentAccessTier?: string,
  agentFeatures?: Record<string, boolean>,
  institutionCapabilities?: string[],
): { groups: { id?: string; label: string; items: MenuItem[] }[] } {
  const showFinance = (FINANCE_ROLES as readonly string[]).includes(role);

  if (role === "institution_user") {
    const allowed = new Set(institutionCapabilities ?? []);
    const groups = [
        {
          label: t("institution.nav.workspace"),
          items: [
            { title: t("institution.nav.home"), icon: LayoutDashboard, url: "/institution" },
            { title: t("institution.nav.reviewQueue"), icon: Inbox, url: "/institution/review-queue", permKey: "institution.applications.review" },
            { title: t("institution.nav.applications"), icon: FileSearch, url: "/institution/applications", permKey: "institution.applications.review|institution.audit.read" },
            { title: t("institution.nav.decisions"), icon: ClipboardCheck, url: "/institution/decisions", permKey: "institution.decisions.draft|institution.decisions.approve|institution.audit.read" },
            { title: t("institution.nav.offers"), icon: FileText, url: "/institution/offers", permKey: "institution.offers.issue|institution.enrolment.confirm|institution.audit.read" },
          ],
        },
        {
          label: t("institution.nav.configuration"),
          items: [
            { title: t("institution.nav.programsIntakes"), icon: School, url: "/institution/programs-intakes", permKey: "institution.catalog.manage" },
            { title: t("institution.nav.requirements"), icon: ListChecks, url: "/institution/requirements", permKey: "institution.requirements.manage" },
            { title: t("institution.nav.sla"), icon: Timer, url: "/institution/sla", permKey: "institution.sla.manage" },
            { title: t("institution.nav.integrations"), icon: Link2, url: "/institution/integrations", permKey: "institution.integrations.manage" },
          ],
        },
        {
          label: t("institution.nav.governance"),
          items: [
            { title: t("institution.nav.analytics"), icon: BarChart3, url: "/institution/analytics", permKey: "institution.analytics.read" },
            { title: t("institution.nav.team"), icon: Users, url: "/institution/team", permKey: "institution.team.manage" },
            { title: t("institution.nav.audit"), icon: ShieldCheck, url: "/institution/audit", permKey: "institution.audit.read" },
          ],
        },
      ];
    return {
      groups: groups
        .map((group) => ({ ...group, items: group.items.filter((item) => !item.permKey || item.permKey.split("|").some((capability) => allowed.has(capability))) }))
        .filter((group) => group.items.length > 0),
    };
  }

  if (role === 'super_admin' || role === 'admin' || role === 'manager') {
    const isAdmin = role === 'super_admin' || role === 'admin';
    const canSee = (perm: string) => isAdmin || (agentStaffPerms || []).includes(perm);

    const primaryWorkItems: MenuItem[] = [
      { title: t("dashboard.dashboard"), icon: LayoutDashboard, url: '/admin' },
      { title: t("dashboard.operations"), icon: ListChecks, url: '/admin/operations' },
      { title: t("dashboard.tasks"), icon: ClipboardList, url: '/staff/tasks' },
      { title: t("dashboard.messages"), icon: MessageCircle, url: '/staff/messages' },
    ];

    const studentApplicationItems: MenuItem[] = [
      { title: t("dashboard.leads"), icon: Users, url: '/staff/leads' },
      { title: t("dashboard.students"), icon: GraduationCap, url: '/staff/students' },
      { title: t("dashboard.applications"), icon: FileText, url: '/staff/applications' },
      { title: t("dashboard.courseFinder"), icon: Search, url: '/staff/course-finder' },
    ];

    const partnersContractsItems: MenuItem[] = [
      { title: t("dashboard.agents"), icon: Handshake, url: '/staff/agents' },
      { title: t("staffAgents.agencyApplications"), icon: ClipboardCheck, url: '/staff/agency-applications' },
      ...(canSee('contracts.view') ? [{ title: t("dashboard.contracts"), icon: FileText, url: '/admin/contracts', permKey: 'contracts.view' }] : []),
      ...(canSee('contract_templates.view') ? [{ title: t("dashboard.contractTemplates"), icon: FileText, url: '/admin/contract-templates', permKey: 'contract_templates.view' }] : []),
      ...(canSee('university_contracts.view') ? [{ title: t("dashboard.universityContracts"), icon: GraduationCap, url: '/admin/university-contracts', permKey: 'university_contracts.view' }] : []),
      ...(canSee('company_contracts.view') ? [{ title: t("dashboard.companyContracts"), icon: Building, url: '/admin/company-contracts', permKey: 'company_contracts.view' }] : []),
      ...(canSee('self_fill_links.view') ? [{ title: t("dashboard.selfFillLinks"), icon: Link2, url: '/admin/self-fill-links', permKey: 'self_fill_links.view' }] : []),
    ];

    const catalogAcademyItems: MenuItem[] = [
      { title: t("dashboard.catalog"), icon: Library, url: '/admin/catalog' },
      ...(hasPermFn?.('academy.access') ? [{
        title: t("dashboard.academy"),
        icon: ExternalLink,
        url: '/admin/__academy__',
        externalHref: '/api/academy-sso',
      }] : []),
    ];

    const financeItems: MenuItem[] = [
      ...(showFinance ? [{ title: t("dashboard.finance"), icon: DollarSign, url: '/staff/finance' }] : []),
      { title: t("dashboard.campaigns"), icon: Megaphone, url: '/admin/campaigns' },
    ];

    const insightsItems: MenuItem[] = [
      ...(hasPermFn?.('reporting.view') ? [{ title: t("dashboard.reports"), icon: BarChart3, url: '/admin/reports', permKey: 'reporting.view' }] : []),
      { title: t("dashboard.userActivity"), icon: Activity, url: '/admin/activity' },
      ...(isAdmin || role === 'manager' ? [{ title: t("dashboard.qualityReport"), icon: Gauge, url: '/admin/quality-report' }] : []),
      ...(isAdmin ? [{ title: t("dashboard.dataQuality"), icon: ShieldCheck, url: '/admin/data-quality' }] : []),
    ];

    const aiItems: MenuItem[] = isAdmin ? [
      { title: t('dashboard.aiPersonas'), icon: Sparkles, url: '/admin/ai-personas' },
      { title: t('dashboard.aiActionQueue'), icon: ListChecks, url: '/admin/ai-action-queue' },
      { title: t('aiExtractor.sidebar'), icon: FileSearch, url: '/admin/ai-extractors' },
      { title: t('aiAgentAdmin.sidebar'), icon: MessageSquare, url: '/admin/ai-agent' },
    ] : [];

    const websiteItems: MenuItem[] = isAdmin ? [
      { title: t("dashboard.websitePages"), icon: FileText, url: '/admin/website/pages' },
      { title: t("dashboard.websiteGlobalComponents"), icon: Component, url: '/admin/website/global-components' },
      { title: t("dashboard.websiteNavigation"), icon: Menu, url: '/admin/website/navigation' },
      { title: t("dashboard.websiteBlog"), icon: BookOpen, url: '/admin/website/blog' },
      { title: t("dashboard.websiteCollections"), icon: Layers, url: '/admin/website/collections' },
      { title: t("dashboard.websiteForms"), icon: ClipboardList, url: '/admin/website/forms' },
      { title: t("dashboard.websiteSeoOverrides"), icon: Search, url: '/admin/website/seo' },
      { title: t("dashboard.websiteThemeBuilder"), icon: Palette, url: '/admin/website/theme' },
      { title: t("dashboard.websiteTranslations"), icon: Languages, url: '/admin/website/translations' },
      { title: t("dashboard.websitePublishHistory"), icon: History, url: '/admin/website/publish-history' },
    ] : [];

    const growthContentWebItems: MenuItem[] = [
      ...(hasPermFn?.('social.view') ? [{ title: t("dashboard.socialOperations"), icon: Megaphone, url: '/admin/social', permKey: 'social.view' }] : []),
      { title: t("dashboard.popupAds"), icon: Bell, url: '/admin/popups' },
      { title: t("dashboard.embeds"), icon: Code2, url: '/admin/embeds' },
      ...websiteItems,
    ];

    const automationIntegrationItems: MenuItem[] = [
      ...(isAdmin ? [{ title: t("dashboard.portalAutomation"), icon: Bot, url: '/admin/portal-automation' }] : []),
      ...(isAdmin ? [{ title: t("dashboard.portalCredentials"), icon: KeyRound, url: '/admin/portal-credentials' }] : []),
      ...aiItems,
    ];

    const systemItems: MenuItem[] = [
      { title: t("dashboard.users"), icon: UserCheck, url: '/admin/users' },
      ...(isAdmin ? [{ title: t("dashboard.staffCards"), icon: IdCard, url: '/admin/staff-cards' }] : []),
      ...(role === 'super_admin' ? [{ title: t("dashboard.branches"), icon: Building, url: '/admin/branches' }] : []),
      { title: t("dashboard.auditLog"), icon: Activity, url: '/admin/audit' },
      ...(isAdmin ? [{ title: t("dashboard.systemHealth"), icon: HeartPulse, url: '/admin/system-health' }] : []),
      ...(isAdmin ? [{ title: t("dashboard.apiTokens"), icon: KeyRound, url: '/admin/api-tokens' }] : []),
      { title: t("dashboard.settings"), icon: Settings, url: '/admin/settings' },
    ];

    const groups = [
      { id: 'primaryWork', label: t("dashboard.groupPrimaryWork"), items: primaryWorkItems },
      { id: 'studentApplications', label: t("dashboard.groupStudentApplications"), items: studentApplicationItems },
      { id: 'partnersContracts', label: t("dashboard.groupPartnersContracts"), items: partnersContractsItems },
      { id: 'catalogAcademy', label: t("dashboard.groupCatalogAcademy"), items: catalogAcademyItems },
      { id: 'financePricing', label: t("dashboard.groupFinancePricing"), items: financeItems },
      { id: 'growthContentWeb', label: t("dashboard.groupGrowthContentWeb"), items: growthContentWebItems },
      { id: 'analyticsQuality', label: t("dashboard.groupAnalyticsQuality"), items: insightsItems },
      { id: 'automationIntegrations', label: t("dashboard.groupAutomationIntegrations"), items: automationIntegrationItems },
      { id: 'systemManagement', label: t("dashboard.groupSystemManagement"), items: systemItems },
    ].filter(g => g.items.length > 0);

    return { groups };
  }

  if (role === 'staff' || role === 'consultant' || role === 'accountant' || role === 'editor') {
    const workItems: MenuItem[] = [
      { title: t("dashboard.operations"), icon: ListChecks, url: '/staff/work' },
      { title: t("dashboard.leads"), icon: Users, url: '/staff/leads' },
      { title: t("dashboard.students"), icon: GraduationCap, url: '/staff/students' },
      { title: t("dashboard.applications"), icon: FileText, url: '/staff/applications' },
      { title: t("dashboard.courseFinder"), icon: Search, url: '/staff/course-finder' },
      { title: t("dashboard.messages"), icon: MessageCircle, url: '/staff/messages' },
      { title: t("dashboard.tasks"), icon: ClipboardList, url: '/staff/tasks' },
    ];
    if (showFinance) workItems.push({ title: t("dashboard.finance"), icon: Briefcase, url: '/staff/finance' });
    if (hasPermFn?.('academy.access')) workItems.push({ title: t("dashboard.academy"), icon: ExternalLink, url: '/staff/__academy__', externalHref: '/api/academy-sso' });
    return {
      groups: [
        {
          label: t("dashboard.overview"),
          items: [
            { title: t("dashboard.dashboard"), icon: LayoutDashboard, url: '/staff' },
          ]
        },
        {
          label: t("dashboard.work"),
          items: workItems
        },
        ...(hasPermFn?.('reporting.view') ? [{
          label: t("reporting.insights"),
          items: [{ title: t("dashboard.reports"), icon: BarChart3, url: '/admin/reports', permKey: 'reporting.view' }],
        }] : []),
        ...(() => {
          const contractItems: MenuItem[] = [
            ...(hasPermFn?.('contracts.view') ? [{ title: t("dashboard.contracts"), icon: FileText, url: '/admin/contracts', permKey: 'contracts.view' }] : []),
            ...(hasPermFn?.('contract_templates.view') ? [{ title: t("dashboard.contractTemplates"), icon: FileText, url: '/admin/contract-templates', permKey: 'contract_templates.view' }] : []),
            ...(hasPermFn?.('university_contracts.view') ? [{ title: t("dashboard.universityContracts"), icon: GraduationCap, url: '/admin/university-contracts', permKey: 'university_contracts.view' }] : []),
            ...(hasPermFn?.('company_contracts.view') ? [{ title: t("dashboard.companyContracts"), icon: Building, url: '/admin/company-contracts', permKey: 'company_contracts.view' }] : []),
            ...(hasPermFn?.('self_fill_links.view') ? [{ title: t("dashboard.selfFillLinks"), icon: Link2, url: '/admin/self-fill-links', permKey: 'self_fill_links.view' }] : []),
          ];
          return contractItems.length ? [{ label: t("dashboard.groupAgentNetwork"), items: contractItems }] : [];
        })(),
        {
          label: t("dashboard.system"),
          items: [
            { title: t("dashboard.settings"), icon: Settings, url: '/staff/settings' },
          ]
        }
      ]
    };
  }

  if (role === 'student') {
    return {
      groups: [
        {
          label: t("dashboard.myPortal"),
          items: [
            { title: t("dashboard.dashboard"),       icon: LayoutDashboard, url: '/student' },
            { title: t("dashboard.wishlist"),        icon: Heart,           url: '/student/wishlist' },
            { title: t("dashboard.myApplications"), icon: FileText,        url: '/student/applications' },
            { title: t("dashboard.messages"),        icon: MessageSquare,   url: '/student/messages' },
            { title: t("dashboard.courseFinder"),   icon: Search,          url: '/student/course-finder' },
          ]
        },
        {
          label: t("dashboard.account"),
          items: [
            { title: t("dashboard.myAccount"), icon: UserCircle, url: '/student/account' },
          ]
        }
      ]
    };
  }

  if (role === 'agent' || role === 'sub_agent' || role === 'agent_staff') {
    const commercialAccess = agentAccessTier === "full";
    const academyAvailable = agentFeatures?.academy !== false;
    let agentItems: MenuItem[] = [
      { title: t("dashboard.dashboard"),    icon: LayoutDashboard, url: '/agent' },
      { title: t("dashboard.leads"),        icon: UserCheck,       url: '/agent/leads',         permKey: 'leads' },
      { title: t("dashboard.students"),     icon: GraduationCap,   url: '/agent/students',      permKey: 'students' },
      { title: t("dashboard.applications"), icon: FileText,        url: '/agent/applications',  permKey: 'applications' },
      { title: t("dashboard.courseFinder"), icon: Search,          url: '/agent/course-finder', permKey: 'course_finder' },
      { title: t("dashboard.messages"),     icon: MessageSquare,   url: '/agent/messages',      permKey: 'messages' },
      ...(commercialAccess ? [{ title: t("dashboard.commissions"), icon: TrendingUp, url: '/agent/commissions', permKey: 'commissions' }] : []),
      ...(
        !commercialAccess || !academyAvailable
          ? []
          : role === 'agent_staff'
          ? [{ title: t("dashboard.academy"), icon: ExternalLink, url: '/agent/__academy__', externalHref: '/api/academy-sso', permKey: 'academy' }]
          : hasPermFn?.('academy.access')
            ? [{ title: t("dashboard.academy"), icon: ExternalLink, url: '/agent/__academy__', externalHref: '/api/academy-sso' }]
            : []
      ),
    ];
    if (role === 'agent_staff' && agentStaffPerms) {
      agentItems = agentItems.filter(item => !item.permKey || agentStaffPerms.includes(item.permKey));
    }
    const accountItems: MenuItem[] = [
      { title: t("dashboard.myAccount"), icon: UserCircle, url: '/agent/account' },
    ];
    if (commercialAccess && role === 'agent') {
      accountItems.push({ title: t("dashboard.subAgents"), icon: Users, url: '/agent/sub-agents' });
    }
    if (commercialAccess && (role === 'agent' || role === 'sub_agent')) {
      accountItems.push({ title: t("dashboard.myTeam"), icon: Briefcase, url: '/agent/team' });
    }
    return {
      groups: [
        { label: t("dashboard.agentPortal"), items: agentItems },
        { label: t("dashboard.account"), items: accountItems },
      ]
    };
  }

  return { groups: [] };
}

function getRoleLabel(role: string, t: TFunc): string {
  const roleKeyMap: Record<string, string> = {
    super_admin: "dashboard.superAdmin", admin: "dashboard.admin", manager: "dashboard.manager",
    staff: "dashboard.staff", consultant: "dashboard.consultant", accountant: "dashboard.accountant", editor: "dashboard.editor",
    student: "dashboard.student", agent: "dashboard.agent", sub_agent: "dashboard.subAgent", agent_staff: "dashboard.staff",
    institution_user: "institution.role.portalUser",
  };
  return roleKeyMap[role] ? t(roleKeyMap[role]) : role;
}

const ROLE_COLORS: Record<string, string> = {
  super_admin: "bg-rose-500/12 text-rose-700 dark:bg-rose-400/15 dark:text-rose-300", admin: "bg-red-500/12 text-red-700 dark:bg-red-400/15 dark:text-red-300",
  manager: "bg-orange-500/12 text-orange-700 dark:bg-orange-400/15 dark:text-orange-300", staff: "bg-blue-500/12 text-blue-700 dark:bg-blue-400/15 dark:text-blue-300",
  consultant: "bg-indigo-500/12 text-indigo-700 dark:bg-indigo-400/15 dark:text-indigo-300", accountant: "bg-purple-500/12 text-purple-700 dark:bg-purple-400/15 dark:text-purple-300",
  student: "bg-green-500/12 text-green-700 dark:bg-green-400/15 dark:text-green-300", agent: "bg-amber-500/12 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300",
  agent_staff: "bg-teal-500/12 text-teal-700 dark:bg-teal-400/15 dark:text-teal-300",
  institution_user: "bg-cyan-500/12 text-cyan-700 dark:bg-cyan-400/15 dark:text-cyan-300",
};

type PanelDensity = "compact" | "comfortable";
const PANEL_DENSITY_STORAGE_KEY = "edcons:panel-density";

function getInitialPanelDensity(): PanelDensity {
  if (typeof window === "undefined") return "compact";
  return window.localStorage.getItem(PANEL_DENSITY_STORAGE_KEY) === "comfortable"
    ? "comfortable"
    : "compact";
}

export function DashboardLayout({ children }: { children: ReactNode }) {
  // useAuth returns liveUser ?? getStickyUser() — never undefined after first
  // authentication. prevUserRef adds one more layer of defense.
  const { user: liveUser, isLoading, hasPermission } = useAuth(true);
  const prevUserRef = useRef(liveUser);
  if (liveUser) prevUserRef.current = liveUser;
  const user = prevUserRef.current ?? liveUser;

  const [location, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const pendingNavigationRef = useRef<{ from: string; to: string; startedAt: number } | null>(null);
  const [navPending, setNavPending] = useState(false);
  const [panelDensity, setPanelDensity] = useState<PanelDensity>(getInitialPanelDensity);
  const navigate = (url: string) => {
    if (url === location) return;

    pendingNavigationRef.current = {
      from: location,
      to: url,
      startedAt: performance.now(),
    };
    setNavPending(true);

    // Applications is the only route that fans out into many pipeline queries.
    // Cancel that outgoing route explicitly; mounted layout queries (auth,
    // notifications, unread counts) must survive navigation.
    if (location.startsWith("/staff/applications")) {
      void queryClient.cancelQueries({ queryKey: ["applications"] });
    }
    setLocation(url);
  };
  const handleNavClick = (url: string) => (e: React.MouseEvent<HTMLAnchorElement>) => {
    // Allow native middle-click / ctrl+click / cmd+click / shift / alt to open in new tab/window.
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(url);
  };
  const { t, localePath } = useI18n();
  const { season, setSeason, availableYears } = useSeason();
  const { mode, setMode, resolvedTheme, settings: themeSettings } = useTheme();
  const isAgentRole = !!user && (user.role === "agent" || user.role === "sub_agent" || user.role === "agent_staff");
  const isInstitutionRole = user?.role === "institution_user";

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.panelDensity = panelDensity;
    window.localStorage.setItem(PANEL_DENSITY_STORAGE_KEY, panelDensity);
    return () => {
      delete root.dataset.panelDensity;
    };
  }, [panelDensity]);

  const { data: agentProfile } = useQuery({
    queryKey: ["agent-me"],
    enabled: isAgentRole,
    queryFn: () => customFetch<any>("/api/agents/me"),
    staleTime: 5 * 60 * 1000,
  });

  const { data: institutionContext } = useQuery<{ capabilities?: string[] }>({
    queryKey: ["institution-context"],
    enabled: isInstitutionRole,
    queryFn: () => customFetch("/api/institution/me/context"),
    staleTime: 60_000,
    retry: false,
  });

  // For agents/sub-agents/agent staff, use their business name as the tab
  // title so it matches the agency-branding hook (otherwise useSeo would
  // overwrite the tab title with the generic "Portal" string).
  const agentBusinessName = (agentProfile as any)?.businessName?.trim?.() || "";
  const seoTitle = isAgentRole && agentBusinessName ? agentBusinessName : t("dashboard.portal");
  useSeo({ title: seoTitle, noindex: true });

  const isStaff = ["super_admin","admin","manager","staff","consultant","editor","accountant"].includes(user?.role || "");
  const isStudent = user?.role === "student";

  useEffect(() => {
    const pending = pendingNavigationRef.current;
    if (!pending || pending.to !== location) return;

    const frame = window.requestAnimationFrame(() => {
      try {
        performance.measure("fasos:route-commit", {
          start: pending.startedAt,
          end: performance.now(),
          detail: { from: pending.from, to: pending.to },
        });
      } catch {
        // User Timing options are diagnostic only; older browsers must still
        // complete navigation even if they do not support the options object.
      } finally {
        pendingNavigationRef.current = null;
        setNavPending(false);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [location]);

  const { data: unreadMsgData } = useQuery<{ total: number; mine: number }>({
    queryKey: ["unread-messages-count"],
    enabled: isStaff,
    queryFn: async () => {
      const res = await customFetch<{ data: any[] }>("/api/conversations");
      const convs = (res as any)?.data || res || [];
      const total = convs.reduce((sum: number, c: any) => sum + (c.unreadCount || 0), 0);
      const mine = convs.reduce(
        (sum: number, c: any) =>
          sum + (c.assignedToId === user?.id ? c.unreadCount || 0 : 0),
        0,
      );
      return { total, mine };
    },
    refetchInterval: 60000,
    staleTime: 45000,
    refetchOnWindowFocus: true,
  });

  // Subscribe to the same SSE inbox stream that powers /staff/messages so the
  // unread badge in the side-nav reflects new inbound messages and assignments
  // within ~1s, even when staff are on other pages. The EventSource auto-
  // reconnects; we just need to invalidate the cached count on each event so
  // the next render picks up the fresh number from /api/conversations.
  useEffect(() => {
    if (!isStaff) return;
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;
    const es = new EventSource("/api/inbox/events", { withCredentials: true });
    const refresh = () => {
      queryClient.invalidateQueries({ queryKey: ["unread-messages-count"] });
      queryClient.invalidateQueries({ queryKey: ["notification-section-counts"] });
    };
    es.addEventListener("inbox_message", refresh);
    es.addEventListener("inbox_assigned", refresh);
    es.addEventListener("inbox_read_state", refresh);
    return () => {
      es.removeEventListener("inbox_message", refresh);
      es.removeEventListener("inbox_assigned", refresh);
      es.removeEventListener("inbox_read_state", refresh);
      es.close();
    };
  }, [isStaff, queryClient]);

  const { data: studentUnreadData } = useQuery({
    queryKey: ["student-unread-messages"],
    enabled: isStudent,
    queryFn: async () => {
      const res = await customFetch<{ data: any[] }>("/api/student/conversations");
      const convs = (res as any)?.data || res || [];
      const total = convs.reduce((sum: number, c: any) => sum + (c.unreadCount || 0), 0);
      return total;
    },
    refetchInterval: 60000,
    staleTime: 45000,
    refetchOnWindowFocus: true,
  });

  const staffUnreadTotal = isStaff ? unreadMsgData?.total || 0 : 0;
  const staffUnreadMine = isStaff ? unreadMsgData?.mine || 0 : 0;
  const totalUnreadMessages = staffUnreadTotal + (isStudent ? studentUnreadData || 0 : 0);

  const { data: sectionCounts } = useQuery<Record<string, number>>({
    queryKey: ["notification-section-counts"],
    enabled: isStaff || isAgentRole,
    queryFn: async () => {
      const res = await customFetch<Record<string, number>>("/api/notifications/section-counts");
      return (res as any) || {};
    },
    refetchInterval: 60000,
    staleTime: 45000,
    refetchOnWindowFocus: true,
  });

  // Clear a section's sidebar badge when the user visits that section (its list
  // page or any detail page under it). The badges are driven by unread
  // notifications, so marking them read on visit is what removes the red count
  // next to Leads/Students/Applications/Tasks. A ref guards against duplicate
  // POSTs while the section count is still showing a stale positive value.
  const clearedSectionRef = useRef<string | null>(null);
  useEffect(() => {
    if (!(isStaff || isAgentRole)) return;
    const path = location.split(/[?#]/)[0];
    const match = path.match(/\/(leads|students|applications|tasks)(?:\/|$)/);
    const section = match ? match[1] : null;
    if (!section) {
      clearedSectionRef.current = null;
      return;
    }
    if (!sectionCounts || (sectionCounts[section] || 0) <= 0) return;
    if (clearedSectionRef.current === section) return;
    clearedSectionRef.current = section;
    customFetch(`/api/notifications/section/${section}/read`, { method: "POST" })
      .then(() => {
        queryClient.invalidateQueries({ queryKey: ["notification-section-counts"] });
      })
      .catch(() => { clearedSectionRef.current = null; /* allow retry */ });
  }, [location, isStaff, isAgentRole, sectionCounts, queryClient]);

  // Sidebar favorites — persisted per user so each account keeps its own pins.
  // These hooks MUST run before every early return to comply with Rules of Hooks.
  const pinnedStorageKey = `edcons:sidebarPinned:${user?.id ?? user?.email ?? "anon"}`;
  const [pinnedUrls, setPinnedUrls] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = window.localStorage.getItem(pinnedStorageKey);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.filter(v => typeof v === "string") : [];
    } catch { return []; }
  });
  useEffect(() => {
    try { window.localStorage.setItem(pinnedStorageKey, JSON.stringify(pinnedUrls)); } catch { /* ignore quota errors */ }
  }, [pinnedStorageKey, pinnedUrls]);

  const groupStorageKey = `edcons:sidebarGroups:${user?.id ?? user?.email ?? "anon"}`;
  const [groupOpen, setGroupOpen] = useState<Record<string, boolean>>(() => {
    if (typeof window === "undefined") return {};
    try {
      const raw = window.localStorage.getItem(groupStorageKey);
      const obj = raw ? JSON.parse(raw) : {};
      return obj && typeof obj === "object" ? obj : {};
    } catch { return {}; }
  });
  useEffect(() => {
    try { window.localStorage.setItem(groupStorageKey, JSON.stringify(groupOpen)); } catch { /* ignore quota errors */ }
  }, [groupStorageKey, groupOpen]);

  if (!user && isLoading) {
    // Still resolving auth — show a blank bg so there's no white flash
    return <div className="min-h-screen bg-secondary/20" />;
  }
  if (!user) {
    // useAuth's effect will redirect to /login; show nothing in the meantime
    return <div className="min-h-screen bg-secondary/20" />;
  }

  const staffPerms = (user as unknown as Record<string, unknown>).agentStaffPermissions as string[] | undefined;
  const { groups } = getMenuForRole(
    user.role,
    t,
    staffPerms,
    hasPermission,
    (agentProfile as any)?.accessTier,
    (agentProfile as any)?.effectiveFeatures,
    institutionContext?.capabilities,
  );
  const allItems = groups.flatMap(g => g.items);

  const togglePin = (url: string) => {
    setPinnedUrls(prev => prev.includes(url) ? prev.filter(u => u !== url) : [...prev, url]);
  };
  const pinnedSet = new Set(pinnedUrls);

  const toggleGroup = (key: string, defaultOpen: boolean) => {
    setGroupOpen(prev => {
      const cur = prev[key] !== undefined ? prev[key] : defaultOpen;
      return { ...prev, [key]: !cur };
    });
  };

  const isItemActive = (item: MenuItem) =>
    item.url === location ||
    (item.url !== '/staff' && item.url !== '/admin' && item.url !== '/student' && item.url !== '/agent' && item.url !== '/institution' && location.startsWith(item.url));
  // Preserve the order in which the user pinned each item (most recent last).
  const favoriteItems = pinnedUrls
    .map(u => allItems.find(i => i.url === u))
    .filter((i): i is MenuItem => !!i);
  const activeItem = allItems.find(isItemActive);
  const roleBadgeColor = ROLE_COLORS[user.role] || "bg-secondary text-muted-foreground";
  const initials = `${user.firstName?.[0] || ''}${user.lastName?.[0] || user.email?.[0] || '?'}`.toUpperCase();
  const isOperationalRole = ["super_admin","admin","manager","staff","consultant","accountant","editor","agent","sub_agent"].includes(user.role);

  const LOGO_BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";
  // Resolve a stored asset URL into something an <img> can load in any
  // environment: absolute URLs pass through; root-relative API paths get the
  // artifact base-path prefix so they don't escape the deployment sub-path.
  const resolveAssetSrc = (u?: string | null) =>
    !u ? null : /^https?:\/\//.test(u) ? u : `${LOGO_BASE_URL}${u.startsWith("/") ? "" : "/"}${u}`;

  // Tenant brand logo is served through the PUBLIC, base-prefixed branding
  // proxy (same pattern as PublicLayout) so it renders without an auth cookie
  // and under any base path. Agent white-label logos fall back to the
  // base-prefixed stored URL (agent dashboards are always authenticated).
  const hasSystemLogo = resolvedTheme === "dark" && themeSettings.logoDarkUrl
    ? themeSettings.logoDarkUrl
    : themeSettings.logoUrl || null;
  const tenantLogoSrc = hasSystemLogo
    ? `${LOGO_BASE_URL}/api/settings/branding/logo${resolvedTheme === "dark" && themeSettings.logoDarkUrl ? "?variant=dark" : ""}`
    : null;
  // Prefer the dedicated square asset; otherwise fall back to the (dark-aware)
  // tenant logo so dark-only branding setups don't show the wrong asset.
  const tenantSquareLogoSrc = themeSettings.logoSquareUrl
    ? `${LOGO_BASE_URL}/api/settings/branding/logo?variant=square`
    : tenantLogoSrc;
  const agentLogoSrc = (isAgentRole && agentProfile?.logoUrl) ? resolveAssetSrc(agentProfile.logoUrl) : null;

  const sidebarLogo = agentLogoSrc ?? tenantLogoSrc;
  const sidebarSquareLogo = agentLogoSrc ?? tenantSquareLogoSrc;

  return (
    <SidebarProvider
      data-panel-density={panelDensity}
      style={{ "--sidebar-width": panelDensity === "compact" ? "15rem" : "16rem" } as React.CSSProperties}
    >
      <div className="flex min-h-screen w-full bg-secondary/20">
        <Sidebar collapsible="icon" className="border-r border-border/60 shadow-sm">
          <SidebarContent className="bg-sidebar text-sidebar-foreground">
            {/* Logo */}
            <div className="px-5 py-4 border-b border-border/40 group-data-[collapsible=icon]:px-0 group-data-[collapsible=icon]:py-3 group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:justify-center">
              <button
                type="button"
                onClick={() => navigate(localePath("/"))}
                className="flex w-full items-center justify-center gap-2.5 group/logo group-data-[collapsible=icon]:justify-center"
                title={t("dashboard.homeTooltip")}
              >
                {/* Expanded: full logo (image or icon+wordmark) */}
                <span className="flex w-full items-center justify-center gap-2.5 group-data-[collapsible=icon]:hidden">
                  {sidebarLogo ? (
                    <img src={sidebarLogo} alt="Logo" decoding="async" fetchPriority="high" className="h-[2.6rem] max-w-[138px] object-contain group-hover/logo:scale-105 transition-transform" />
                  ) : (
                    <>
                      <span className="w-9 h-9 rounded-xl bg-gradient-to-br from-primary to-accent flex items-center justify-center text-white shadow-md group-hover/logo:scale-105 transition-transform">
                        <GraduationCap className="w-5 h-5" />
                      </span>
                      <span className="font-display font-bold text-lg tracking-tight text-foreground leading-none">{themeSettings.companyName || "Find And Study OS"}</span>
                    </>
                  )}
                </span>
                {/* Collapsed: compact mark only — uses Square Logo if configured */}
                {sidebarSquareLogo ? (
                  <span className="hidden group-data-[collapsible=icon]:flex w-9 h-9 rounded-xl overflow-hidden items-center justify-center bg-card group-hover/logo:scale-105 transition-transform">
                    <img src={sidebarSquareLogo} alt="Logo" decoding="async" fetchPriority="high" className="w-full h-full object-contain" />
                  </span>
                ) : (
                  <span className="hidden group-data-[collapsible=icon]:flex w-9 h-9 rounded-xl bg-gradient-to-br from-primary to-accent items-center justify-center text-white shadow-md group-hover/logo:scale-105 transition-transform">
                    <GraduationCap className="w-5 h-5" />
                  </span>
                )}
              </button>
            </div>

            {/* Navigation */}
            <div className="px-3 pt-4 pb-4 flex-1 overflow-y-auto group-data-[collapsible=icon]:overflow-hidden space-y-4 group-data-[collapsible=icon]:px-0 group-data-[collapsible=icon]:space-y-2 group-data-[collapsible=icon]:[&_[data-sidebar=group-content]_ul]:items-center group-data-[collapsible=icon]:[&_[data-sidebar=group-content]_ul]:flex group-data-[collapsible=icon]:[&_[data-sidebar=group-content]_ul]:flex-col">
              {(() => {
                const renderItem = (item: MenuItem, keyPrefix = "") => {
                  const isActive = isItemActive(item);
                  const isPinned = pinnedSet.has(item.url);
                  return (
                          <SidebarMenuItem key={`${keyPrefix}${item.title}`}>
                            <SidebarMenuButton
                              asChild
                              data-active={isActive}
                              tooltip={item.title}
                              className="w-full justify-start gap-3 px-3 py-2.5 rounded-xl transition-all duration-150 hover:bg-primary/5 data-[active=true]:bg-primary/10 data-[active=true]:text-primary font-medium text-sidebar-foreground/80 dark:text-sidebar-foreground/85 hover:text-foreground data-[active=true]:font-semibold text-sm group-data-[collapsible=icon]:!w-10 group-data-[collapsible=icon]:!h-10 group-data-[collapsible=icon]:!p-0 group-data-[collapsible=icon]:!justify-center group-data-[collapsible=icon]:!rounded-xl group-data-[collapsible=icon]:!gap-0 relative"
                            >
                              <a
                                href={item.externalHref ?? item.url}
                                {...(item.externalHref
                                  ? { target: "_blank", rel: "noopener noreferrer" }
                                  : {
                                      onClick: handleNavClick(item.url),
                                      onAuxClick: (e: React.MouseEvent) => {
                                        if (e.button === 1) e.stopPropagation();
                                      },
                                    })}
                              >
                              <item.icon className={`w-[18px] h-[18px] shrink-0 ${isActive ? 'text-primary' : ''}`} />
                              <span className="flex-1 group-data-[collapsible=icon]:hidden">{item.title}</span>
                              {item.url.endsWith("/messages") && totalUnreadMessages > 0 && (
                                <>
                                  <TooltipProvider delayDuration={200}>
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <span
                                          className="ml-auto flex items-center gap-1 shrink-0 group-data-[collapsible=icon]:hidden"
                                          data-testid="badge-messages-counts"
                                        >
                                          {isStaff && staffUnreadMine > 0 && (
                                            <span
                                              className="min-w-5 h-5 px-1 bg-blue-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center"
                                              data-testid="badge-messages-mine"
                                            >
                                              {staffUnreadMine > 99 ? "99+" : staffUnreadMine}
                                            </span>
                                          )}
                                          <span
                                            className="min-w-5 h-5 px-1 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center"
                                            data-testid="badge-messages-total"
                                          >
                                            {totalUnreadMessages > 99 ? "99+" : totalUnreadMessages}
                                          </span>
                                        </span>
                                      </TooltipTrigger>
                                      <TooltipContent side="right" className="text-xs">
                                        {isStaff && staffUnreadMine > 0 ? (
                                          <div className="space-y-1">
                                            <div>
                                              <span className="inline-block w-2 h-2 rounded-full bg-blue-500 mr-1.5 align-middle" />
                                              {t("dashboard.assignedToYou", { n: staffUnreadMine })}
                                            </div>
                                            <div>
                                              <span className="inline-block w-2 h-2 rounded-full bg-red-500 mr-1.5 align-middle" />
                                              {t("dashboard.totalUnread", { n: totalUnreadMessages })}
                                            </div>
                                          </div>
                                        ) : (
                                          <div>
                                            <span className="inline-block w-2 h-2 rounded-full bg-red-500 mr-1.5 align-middle" />
                                            {t("dashboard.totalUnread", { n: totalUnreadMessages })}
                                          </div>
                                        )}
                                      </TooltipContent>
                                    </Tooltip>
                                  </TooltipProvider>
                                  <span className="hidden group-data-[collapsible=icon]:block absolute top-1 right-1 w-2 h-2 rounded-full bg-red-500 ring-2 ring-card" />
                                </>
                              )}
                              {item.url.endsWith("/leads") && (sectionCounts?.leads || 0) > 0 && (
                                <>
                                  <span className="ml-auto w-5 h-5 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center shrink-0 group-data-[collapsible=icon]:hidden">
                                    {(sectionCounts?.leads || 0) > 99 ? "99+" : sectionCounts?.leads}
                                  </span>
                                  <span className="hidden group-data-[collapsible=icon]:block absolute top-1 right-1 w-2 h-2 rounded-full bg-red-500 ring-2 ring-card" />
                                </>
                              )}
                              {item.url.endsWith("/students") && (sectionCounts?.students || 0) > 0 && (
                                <>
                                  <span className="ml-auto w-5 h-5 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center shrink-0 group-data-[collapsible=icon]:hidden">
                                    {(sectionCounts?.students || 0) > 99 ? "99+" : sectionCounts?.students}
                                  </span>
                                  <span className="hidden group-data-[collapsible=icon]:block absolute top-1 right-1 w-2 h-2 rounded-full bg-red-500 ring-2 ring-card" />
                                </>
                              )}
                              {item.url.endsWith("/applications") && (sectionCounts?.applications || 0) > 0 && (
                                <>
                                  <span className="ml-auto w-5 h-5 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center shrink-0 group-data-[collapsible=icon]:hidden">
                                    {(sectionCounts?.applications || 0) > 99 ? "99+" : sectionCounts?.applications}
                                  </span>
                                  <span className="hidden group-data-[collapsible=icon]:block absolute top-1 right-1 w-2 h-2 rounded-full bg-red-500 ring-2 ring-card" />
                                </>
                              )}
                              {item.url.endsWith("/tasks") && (sectionCounts?.tasks || 0) > 0 && (
                                <>
                                  <span className="ml-auto w-5 h-5 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center shrink-0 group-data-[collapsible=icon]:hidden">
                                    {(sectionCounts?.tasks || 0) > 99 ? "99+" : sectionCounts?.tasks}
                                  </span>
                                  <span className="hidden group-data-[collapsible=icon]:block absolute top-1 right-1 w-2 h-2 rounded-full bg-red-500 ring-2 ring-card" />
                                </>
                              )}
                              </a>
                            </SidebarMenuButton>
                            <SidebarMenuAction
                              onClick={(e) => { e.stopPropagation(); e.preventDefault(); togglePin(item.url); }}
                              showOnHover={!isPinned}
                              title={isPinned ? t("dashboard.removeFromFavorites") : t("dashboard.addToFavorites")}
                              aria-label={isPinned ? t("dashboard.removeFromFavorites") : t("dashboard.addToFavorites")}
                              className={isPinned ? "text-amber-500 hover:text-amber-600" : "text-muted-foreground hover:text-amber-500"}
                            >
                              <Star className={`w-3.5 h-3.5 ${isPinned ? "fill-amber-400" : ""}`} />
                            </SidebarMenuAction>
                          </SidebarMenuItem>
                  );
                };

                return (
                  <>
                    {favoriteItems.length > 0 && (
                      <SidebarGroup className="p-0">
                        <div className="text-[10px] font-bold text-amber-600 uppercase tracking-widest mb-1 px-3 flex items-center gap-1.5 group-data-[collapsible=icon]:opacity-0 group-data-[collapsible=icon]:-mt-6">
                          <Star className="w-3 h-3 fill-amber-400" /> {t("dashboard.favorites")}
                        </div>
                        <SidebarGroupContent>
                          <SidebarMenu className="space-y-0.5">
                            {favoriteItems.map(item => renderItem(item, "fav-"))}
                          </SidebarMenu>
                        </SidebarGroupContent>
                      </SidebarGroup>
                    )}
                    {groups.map(group => {
                      const groupKey = group.id ?? group.label;
                      const isActiveGroup = group.items.some(isItemActive);
                      const defaultOpen = !DEFAULT_CLOSED_GROUPS.has(groupKey);
                      const userState = groupOpen[groupKey];
                      const expanded = (userState !== undefined ? userState : defaultOpen) || isActiveGroup;
                      return (
                      <SidebarGroup key={groupKey} className="p-0">
                        <button
                          type="button"
                          onClick={() => toggleGroup(groupKey, defaultOpen)}
                          className="w-full flex items-center justify-between text-[10px] font-bold text-sidebar-foreground/70 dark:text-sidebar-foreground/75 uppercase tracking-widest mb-1 px-3 hover:text-foreground transition-colors cursor-pointer group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:opacity-0"
                        >
                          <span>{group.label}</span>
                          <ChevronDown className={`w-3.5 h-3.5 shrink-0 transition-transform duration-200 ${expanded ? "" : "-rotate-90"}`} />
                        </button>
                        <SidebarGroupContent className={expanded ? "" : "hidden group-data-[collapsible=icon]:!block"}>
                          <SidebarMenu className="space-y-0.5">
                            {group.items.map(item => renderItem(item))}
                          </SidebarMenu>
                        </SidebarGroupContent>
                      </SidebarGroup>
                      );
                    })}
                  </>
                );
              })()}
            </div>

            {/* User Bottom */}
            <div className="p-3 border-t border-border/40 group-data-[collapsible=icon]:p-2 group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:justify-center">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    className="w-full flex items-center gap-3 p-3 rounded-xl hover:bg-secondary/50 transition-colors cursor-pointer text-left group-data-[collapsible=icon]:w-10 group-data-[collapsible=icon]:h-10 group-data-[collapsible=icon]:p-0 group-data-[collapsible=icon]:justify-center"
                    title={`${user.firstName} ${user.lastName}`}
                  >
                    {user.avatarUrl ? (
                      <img src={user.avatarUrl} alt="" className="w-9 h-9 rounded-full object-cover ring-2 ring-primary/20 shrink-0" />
                    ) : (
                      <div className="w-9 h-9 rounded-full bg-gradient-to-tr from-primary/30 to-accent/30 flex items-center justify-center font-bold text-sm text-primary ring-2 ring-primary/20 shrink-0">
                        {initials}
                      </div>
                    )}
                    <div className="flex-1 min-w-0 group-data-[collapsible=icon]:hidden">
                      <p className="text-sm font-semibold text-foreground truncate">{user.firstName} {user.lastName}</p>
                      <p className="text-xs text-muted-foreground truncate">{user.email || `ID #${user.id}`}</p>
                    </div>
                    <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0 group-data-[collapsible=icon]:hidden" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="start" className="w-56 mb-1">
                  <DropdownMenuItem
                    onClick={() => {
                      const url = ['super_admin','admin','manager'].includes(user.role) ? '/admin/settings' : ['agent','sub_agent'].includes(user.role) ? '/agent/account' : user.role === 'student' ? '/student/account' : '/staff/settings';
                      navigate(url);
                    }}
                  >
                    <User className="w-4 h-4 mr-2" />
                    {t("dashboard.profileSettings")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive cursor-pointer"
                    onSelect={() => {
                      queryClient.clear();
                      void performLogout();
                    }}
                  >
                    <LogOut className="w-4 h-4 mr-2" />
                    {t("dashboard.signOut")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </SidebarContent>
        </Sidebar>

        {/* Main Content */}
        <div className="flex flex-col flex-1 overflow-hidden min-w-0">
          <div
            className="fixed top-0 left-0 right-0 z-[100000] h-[2px] pointer-events-none"
            style={{ opacity: navPending ? 1 : 0, transition: 'opacity 0.15s ease' }}
          >
            <div
              className="h-full bg-primary"
              style={{
                width: navPending ? '85%' : '0%',
                transition: navPending ? 'width 1.2s cubic-bezier(0.1,0.8,0.2,1)' : 'none',
              }}
            />
          </div>
          <header className="h-14 flex items-center justify-between px-5 bg-card/95 backdrop-blur-sm border-b border-border sticky top-0 z-30">
            <div className="flex items-center gap-3">
              <SidebarTrigger className="text-foreground/70 hover:bg-secondary hover:text-foreground transition-colors" />
              <div className="h-5 w-px bg-border" />
              <h1 className="font-display font-bold text-base text-foreground hidden sm:block">
                {activeItem?.title || t("dashboard.portal")}
              </h1>
            </div>
            <div className="flex items-center gap-3">
              {isOperationalRole && (
                <div className="flex items-center gap-1.5 bg-primary/10 dark:bg-primary/15 border border-primary/25 dark:border-primary/35 rounded-lg px-2 py-1">
                  <CalendarDays className="w-3.5 h-3.5 text-primary shrink-0" />
                  <Select value={season} onValueChange={setSeason}>
                    <SelectTrigger className="h-6 border-0 bg-transparent p-0 text-xs font-bold text-primary shadow-none focus:ring-0 w-[52px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent align="end">
                      {availableYears.map(y => (
                        <SelectItem key={y} value={y} className="text-sm font-medium">{y}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <NotificationCenter />
              <Button
                size="icon"
                variant="ghost"
                className="w-8 h-8 rounded-lg text-foreground/75 hover:bg-secondary hover:text-foreground"
                onClick={() => setPanelDensity(current => current === "compact" ? "comfortable" : "compact")}
                title={panelDensity === "compact" ? "Switch to comfortable view" : "Switch to compact view"}
                aria-label="Compact panel view"
                aria-pressed={panelDensity === "compact"}
                data-testid="panel-density-toggle"
              >
                {panelDensity === "compact" ? <Maximize2 className="w-4 h-4" /> : <Minimize2 className="w-4 h-4" />}
              </Button>
              <Button size="icon" variant="ghost" className="w-8 h-8 rounded-lg text-foreground/75 hover:bg-secondary hover:text-foreground"
                onClick={() => setMode(resolvedTheme === "dark" ? "light" : "dark")}
                title={resolvedTheme === "dark" ? t("dashboard.switchToLight") : t("dashboard.switchToDark")}>
                {resolvedTheme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
              </Button>
              <Badge className={`hidden sm:flex text-xs font-semibold border-0 ${roleBadgeColor}`}>
                <Shield className="w-3 h-3 mr-1" />
                {getRoleLabel(user.role, t)}
              </Badge>
            </div>
          </header>

          {(user as any).isImpersonating && (
            <div className="bg-amber-500 text-white px-4 py-2 flex items-center justify-between text-sm font-medium">
              <span>{t("dashboard.impersonating", { name: `${user.firstName} ${user.lastName}`, role: getRoleLabel(user.role, t) })}</span>
              <Button
                size="sm"
                variant="ghost"
                className="text-white hover:bg-amber-600 h-7 gap-1.5"
                onClick={async () => {
                  try {
                    await customFetch("/api/agents/me/return-to-agent", { method: "POST", headers: { "Content-Type": "application/json" } });
                    window.location.href = `${import.meta.env.BASE_URL?.replace(/\/$/, "") || ""}/`;
                  } catch {
                    window.location.href = `${import.meta.env.BASE_URL?.replace(/\/$/, "") || ""}/login`;
                  }
                }}
              >
                <ArrowLeftCircle className="w-4 h-4" />
                {t("dashboard.returnToAgent")}
              </Button>
            </div>
          )}

          <main className="flex-1 overflow-y-auto p-4 lg:p-6">
            <div className="max-w-[1800px] mx-auto">
              {children}
            </div>
          </main>
        </div>
      </div>
      <PopupRenderer />
    </SidebarProvider>
  );
}
