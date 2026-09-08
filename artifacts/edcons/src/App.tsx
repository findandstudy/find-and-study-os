import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useCustomBrowserLocation, getSavedNavPath } from "@/lib/navigation";
import { getAuthCache, setAuthCache, clearAuthCache, getStickyUser, setStickyUser } from "@/lib/auth-cache";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { PublicLayout } from "@/components/layout/PublicLayout";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProtectedRoute } from "@/components/auth/ProtectedRoute";
import { EmailVerificationGuard } from "@/components/auth/EmailVerificationGuard";
import { AgentOnboardingGuard } from "@/components/auth/AgentOnboardingGuard";
import { SeasonProvider } from "@/contexts/SeasonContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { ActivityTrackerProvider } from "@/components/ActivityTrackerProvider";
import { PageLoader } from "@/components/ui/page-loader";
import { DashboardSkeleton } from "@/components/ui/page-skeleton";
import { I18nProvider } from "@/lib/i18n/context";
import { useI18nContext } from "@/lib/i18n/use-i18n-context";
import { isValidLanguage, DEFAULT_LANGUAGE, type Language } from "@/lib/i18n/index";
import NotFound from "@/pages/not-found";
import { useGetMe } from "@workspace/api-client-react";
import { useAgencyBranding } from "@/hooks/use-agency-branding";

import Home from "@/pages/public/Home";
import Login from "@/pages/auth/Login";

function lazyRetry<T extends { default: React.ComponentType<any> }>(
  factory: () => Promise<T>,
  retries = 4
): React.LazyExoticComponent<T["default"]> {
  // Retry the dynamic import a few times with a short backoff to ride
  // through transient network blips. If it still fails we throw and let
  // the surrounding ErrorBoundary do its single cache-busted reload.
  return lazy(() => {
    const attempt = (remaining: number): Promise<T> =>
      factory().catch((err: Error) => {
        if (remaining <= 0) throw err;
        return new Promise<T>((resolve) =>
          setTimeout(() => resolve(attempt(remaining - 1)), 800)
        );
      });
    return attempt(retries);
  });
}

if (typeof window !== "undefined") {
  // Strip the cache-buster query param after a successful load so the URL
  // stays clean and we don't pollute share/bookmark links.
  if (window.location.search.includes("_cb=")) {
    const cleaned = new URL(window.location.href);
    cleaned.searchParams.delete("_cb");
    const next = cleaned.pathname + (cleaned.search ? cleaned.search : "") + cleaned.hash;
    window.history.replaceState(null, "", next);
  }
}

const About = lazyRetry(() => import("@/pages/public/About"));
const Countries = lazyRetry(() => import("@/pages/public/Countries"));
const CountryDetail = lazyRetry(() => import("@/pages/public/CountryDetail"));
const Programs = lazyRetry(() => import("@/pages/public/Programs"));
const Blog = lazyRetry(() => import("@/pages/public/Blog"));
const Contact = lazyRetry(() => import("@/pages/public/Contact"));
const AgencyApplication = lazyRetry(() => import("@/pages/public/AgencyApplication"));

const StaffDashboard = lazyRetry(() => import("@/pages/staff/Dashboard"));
const StaffLeads = lazyRetry(() => import("@/pages/staff/Leads"));
const StaffStudents = lazyRetry(() => import("@/pages/staff/Students"));
const StaffApplications = lazyRetry(() => import("@/pages/staff/Applications"));
const StaffFinance = lazyRetry(() => import("@/pages/staff/Finance"));
const StaffSettings = lazyRetry(() => import("@/pages/staff/Settings"));
const LeadDetail = lazyRetry(() => import("@/pages/staff/LeadDetail"));
const StudentDetail = lazyRetry(() => import("@/pages/staff/StudentDetail"));
const ApplicationDetail = lazyRetry(() => import("@/pages/staff/ApplicationDetail"));
const StaffCourseFinder = lazyRetry(() => import("@/pages/staff/CourseFinder"));
const StaffAgents = lazyRetry(() => import("@/pages/staff/Agents"));
const StaffAgencyApplications = lazyRetry(() => import("@/pages/staff/AgencyApplications"));
const StaffAgentDetail = lazyRetry(() => import("@/pages/staff/AgentDetail"));
const StaffMessages = lazyRetry(() => import("@/pages/staff/Messages"));
const StaffTasks = lazyRetry(() => import("@/pages/staff/Tasks"));
const StaffOperationsCenter = lazyRetry(() => import("@/pages/staff/OperationsCenter"));

const AdminDashboard = lazyRetry(() => import("@/pages/admin/Dashboard"));
const AdminUsers = lazyRetry(() => import("@/pages/admin/Users"));
const AdminBranches = lazyRetry(() => import("@/pages/admin/Branches"));
const AdminCatalog = lazyRetry(() => import("@/pages/admin/Catalog"));
const AdminCampaigns = lazyRetry(() => import("@/pages/admin/Campaigns"));
const AdminAiPersonas = lazyRetry(() => import("@/pages/admin/AiPersonas"));
const AdminAiPersonaDetail = lazyRetry(() => import("@/pages/admin/AiPersonaDetail"));
const AdminAiActionQueue = lazyRetry(() => import("@/pages/admin/AiActionQueue"));
const AdminAiExtractors = lazyRetry(() => import("@/pages/admin/AiExtractors"));
const AdminAiExtractorDetail = lazyRetry(() => import("@/pages/admin/AiExtractorDetail"));
const AdminPopups = lazyRetry(() => import("@/pages/admin/Popups"));
const AdminAuditLog = lazyRetry(() => import("@/pages/admin/AuditLog"));
const AdminApiTokens = lazyRetry(() => import("@/pages/admin/ApiTokens"));
const AdminActivity = lazyRetry(() => import("@/pages/admin/Activity"));
const AdminEmbeds = lazyRetry(() => import("@/pages/admin/Embeds"));
const AdminStaffCards = lazyRetry(() => import("@/pages/admin/StaffCards"));
const AdminQualityReport = lazyRetry(() => import("@/pages/admin/QualityReport"));
const AdminSystemHealth = lazyRetry(() => import("@/pages/admin/SystemHealth"));
const AdminDataQuality = lazyRetry(() => import("@/pages/admin/DataQuality"));
const AdminReports = lazyRetry(() => import("@/pages/admin/Reports"));
const AdminSocialOperations = lazyRetry(() => import("@/pages/admin/SocialOperations"));
const AdminStaffCardDetail = lazyRetry(() => import("@/pages/admin/StaffCardDetail"));
const AdminContractTemplates = lazyRetry(() => import("@/pages/admin/ContractTemplates"));
const AdminContracts = lazyRetry(() => import("@/pages/admin/Contracts"));
const AdminSelfFillLinks = lazyRetry(() => import("@/pages/admin/SelfFillLinks"));
const AdminUniversityContracts = lazyRetry(() => import("@/pages/admin/UniversityContracts"));
const AdminCompanyContracts = lazyRetry(() => import("@/pages/admin/CompanyContracts"));
const AdminPortalAutomation = lazyRetry(() => import("@/pages/admin/PortalAutomation"));
const AdminAiAgent = lazyRetry(() => import("@/pages/admin/AiAgent"));
const AdminPortalCredentials = lazyRetry(() => import("@/pages/admin/PortalCredentials"));
const PublicSignFlow = lazyRetry(() => import("@/pages/sign/SignFlow"));

const WebsitePages = lazyRetry(() => import("@/pages/admin/website/Pages"));
const WebsiteGlobalComponents = lazyRetry(() => import("@/pages/admin/website/GlobalComponents"));
const WebsiteNavigation = lazyRetry(() => import("@/pages/admin/website/Navigation"));
const WebsiteBlog = lazyRetry(() => import("@/pages/admin/website/Blog"));
const WebsiteCollections = lazyRetry(() => import("@/pages/admin/website/Collections"));
const WebsiteForms = lazyRetry(() => import("@/pages/admin/website/Forms"));
const WebsiteSeoOverrides = lazyRetry(() => import("@/pages/admin/website/SeoOverrides"));
const WebsiteThemeBuilder = lazyRetry(() => import("@/pages/admin/website/ThemeBuilder"));
const WebsiteTranslations = lazyRetry(() => import("@/pages/admin/website/Translations"));
const WebsitePublishHistory = lazyRetry(() => import("@/pages/admin/website/PublishHistory"));
const WebsitePageEditor = lazyRetry(() => import("@/pages/admin/website/PageEditor"));

const StudentDashboard = lazyRetry(() => import("@/pages/student/Dashboard"));
const StudentApplications = lazyRetry(() => import("@/pages/student/Applications"));
const StudentWishlist = lazyRetry(() => import("@/pages/student/Wishlist"));
const StudentMessages = lazyRetry(() => import("@/pages/student/Messages"));
const StudentAccount = lazyRetry(() => import("@/pages/student/Account"));

const AgentDashboard = lazyRetry(() => import("@/pages/agent/Dashboard"));
const AgentApps = lazyRetry(() => import("@/pages/agent/AgentApps"));
const AgentLeads = lazyRetry(() => import("@/pages/agent/Leads"));
const AgentStudents = lazyRetry(() => import("@/pages/agent/Students"));
const AgentCommissions = lazyRetry(() => import("@/pages/agent/Commissions"));
const AgentAccount = lazyRetry(() => import("@/pages/agent/Account"));
const AgentSubAgents = lazyRetry(() => import("@/pages/agent/SubAgents"));
const AgentMessages = lazyRetry(() => import("@/pages/agent/Messages"));
const AgentTeam = lazyRetry(() => import("@/pages/agent/Team"));

import { STAFF_ROLES as _SHARED_STAFF_ROLES, ADMIN_ROLES as _SHARED_ADMIN_ROLES, AGENT_ROLES as _SHARED_AGENT_ROLES, STUDENT_ROLES as _SHARED_STUDENT_ROLES } from "@workspace/roles";
const STAFF_ROLES = _SHARED_STAFF_ROLES;
const ADMIN_ROLES = _SHARED_ADMIN_ROLES;
const WEBSITE_ADMIN_ROLES: string[] = ["super_admin", "admin"];
const STUDENT_ROLES = _SHARED_STUDENT_ROLES;
const AGENT_ROLES = _SHARED_AGENT_ROLES;
const INSTITUTION_ROLES: string[] = ["institution_user"];

const InstitutionWorkspace = lazyRetry(() => import("@/pages/institution/Workspace"));

function ShellLoader() {
  return <DashboardSkeleton />;
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5,
      gcTime: 1000 * 60 * 15,
      // Retry transient failures a few times with capped exponential backoff so
      // brief DB blips don't blank lists/logos. Auth / 4xx errors should NOT be
      // retried — they will not succeed on retry and would delay redirects.
      retry: (failureCount, error: unknown) => {
        const status = (error as { status?: number; response?: { status?: number } } | null)
          ?.status ?? (error as { response?: { status?: number } } | null)?.response?.status;
        if (typeof status === "number" && status >= 400 && status < 500) return false;
        return failureCount < 3;
      },
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
      // Keep showing the previous successful data while a refetch is in flight
      // or fails — prevents tables and the brand logo from briefly disappearing.
      placeholderData: (prev: unknown) => prev,
      refetchOnWindowFocus: false,
    },
  },
});

function LanguageRedirect() {
  const [, setLocation] = useLocation();
  const { lang } = useI18nContext();
  useEffect(() => {
    setLocation(`/${lang}`, { replace: true });
  }, [lang, setLocation]);
  return <PageLoader />;
}

function LoginRedirect() {
  const [, setLocation] = useLocation();
  const { lang } = useI18nContext();
  useEffect(() => {
    const search = window.location.search;
    setLocation(`/${lang}/login${search}`, { replace: true });
  }, [lang, setLocation]);
  return <PageLoader />;
}

function InvalidLangRedirect({ segment, rest }: { segment: string; rest: string }) {
  const [, setLocation] = useLocation();
  useEffect(() => {
    const path = rest ? `/en/${rest}` : `/en`;
    setLocation(path, { replace: true });
  }, [segment, rest, setLocation]);
  return <PageLoader />;
}

function LanguageSync({ lang }: { lang: string }) {
  const { setLang } = useI18nContext();
  useEffect(() => {
    if (isValidLanguage(lang)) {
      setLang(lang as Language);
    }
  }, [lang, setLang]);
  return null;
}

function UserLanguageSyncer() {
  const { data: me } = useGetMe({ query: { staleTime: 30_000 } } as any);
  const { lang, setLang } = useI18nContext();
  const appliedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const userId = (me as any)?.id as number | undefined;
    const serverLang = (me as any)?.language as string | undefined;
    if (!userId || !serverLang) return;
    if (!isValidLanguage(serverLang)) return;
    // Compose a key so we re-apply when the server language changes for the
    // same user (e.g. post-login PATCH resolves and updates the cache).
    const key = `${userId}:${serverLang}`;
    if (appliedKeyRef.current === key) return;
    appliedKeyRef.current = key;
    if (serverLang !== lang) {
      setLang(serverLang as Language);
    }
  }, [(me as any)?.id, (me as any)?.language, lang, setLang]);
  return null;
}

/**
 * Catch-all for unrecognised public paths (e.g. /en/dashboard when the canvas
 * loads at that URL).  Checks the React Query cache (already populated by
 * AuthPrefetch) and redirects logged-in users to their portal immediately.
 * Falls back to the real 404 page only when we're certain the user is not
 * authenticated.
 */
function AuthFallback() {
  const [, setLocation] = useLocation();
  const { data: me, isLoading } = useGetMe();

  useEffect(() => {
    if (isLoading || !me) return;
    const role = (me as { role?: string }).role;
    if (!role || role === "pending") return;
    if (STAFF_ROLES.includes(role)) { setLocation("/admin"); return; }
    if (STUDENT_ROLES.includes(role)) { setLocation("/student"); return; }
    if (AGENT_ROLES.includes(role)) { setLocation("/agent"); return; }
    if (INSTITUTION_ROLES.includes(role)) { setLocation("/institution"); return; }
  }, [me, isLoading, setLocation]);

  // Use cached auth (localStorage) for a synchronous signal while the API
  // call is in-flight — avoids flashing the 404 page for logged-in users.
  const cached = getStickyUser() ?? getAuthCache();
  const cachedRole = cached ? (cached as { role?: string }).role : undefined;
  const hasPortalRole =
    cachedRole &&
    cachedRole !== "pending" &&
    (STAFF_ROLES.includes(cachedRole) ||
      STUDENT_ROLES.includes(cachedRole) ||
      AGENT_ROLES.includes(cachedRole) ||
      INSTITUTION_ROLES.includes(cachedRole));

  if (hasPortalRole || isLoading) return <PageLoader />;
  return <NotFound />;
}

function PublicRoutes({ lang }: { lang: string }) {
  const [location] = useLocation();
  const isLoginPage = location === `/${lang}/login`;
  return (
    <>
      <LanguageSync lang={lang} />
      {isLoginPage ? (
        <Login />
      ) : (
        <PublicLayout>
          <Switch>
            <Route path={`/${lang}`} component={Home} />
            <Route path={`/${lang}/about`} component={About} />
            <Route path={`/${lang}/countries`} component={Countries} />
            <Route path={`/${lang}/countries/:slug`}>
              {(params) => <CountryDetail slug={params.slug} />}
            </Route>
            <Route path={`/${lang}/programs`} component={Programs} />
            <Route path={`/${lang}/blog`} component={Blog} />
            <Route path={`/${lang}/contact`} component={Contact} />
            <Route path={`/${lang}/agency/apply`} component={AgencyApplication} />
            <Route path={`/${lang}/agency-application`} component={AgencyApplication} />
            <Route component={AuthFallback} />
          </Switch>
        </PublicLayout>
      )}
    </>
  );
}

function StaffAdminShell() {
  return (
    <ProtectedRoute allowedRoles={STAFF_ROLES}>
      <DashboardLayout>
        <Suspense fallback={<ShellLoader />}>
        <Switch>
          {/* Admin routes */}
          <Route path="/admin" component={AdminDashboard} />
          <Route path="/admin/dashboard" component={AdminDashboard} />
          <Route path="/admin/users">
            <ProtectedRoute allowedRoles={ADMIN_ROLES}><AdminUsers /></ProtectedRoute>
          </Route>
          <Route path="/admin/branches">
            <ProtectedRoute allowedRoles={["super_admin"]}><AdminBranches /></ProtectedRoute>
          </Route>
          <Route path="/admin/catalog">
            <ProtectedRoute allowedRoles={ADMIN_ROLES}><AdminCatalog /></ProtectedRoute>
          </Route>
          <Route path="/admin/campaigns">
            <ProtectedRoute allowedRoles={ADMIN_ROLES}><AdminCampaigns /></ProtectedRoute>
          </Route>
          <Route path="/admin/ai-personas/new">
            <ProtectedRoute allowedRoles={ADMIN_ROLES}><AdminAiPersonaDetail /></ProtectedRoute>
          </Route>
          <Route path="/admin/ai-personas/:id">
            <ProtectedRoute allowedRoles={ADMIN_ROLES}><AdminAiPersonaDetail /></ProtectedRoute>
          </Route>
          <Route path="/admin/ai-personas">
            <ProtectedRoute allowedRoles={ADMIN_ROLES}><AdminAiPersonas /></ProtectedRoute>
          </Route>
          <Route path="/admin/ai-action-queue">
            <ProtectedRoute allowedRoles={ADMIN_ROLES}><AdminAiActionQueue /></ProtectedRoute>
          </Route>
          <Route path="/admin/ai-extractors/new">
            <ProtectedRoute allowedRoles={ADMIN_ROLES}><AdminAiExtractorDetail /></ProtectedRoute>
          </Route>
          <Route path="/admin/ai-extractors/:id">
            <ProtectedRoute allowedRoles={ADMIN_ROLES}><AdminAiExtractorDetail /></ProtectedRoute>
          </Route>
          <Route path="/admin/ai-extractors">
            <ProtectedRoute allowedRoles={ADMIN_ROLES}><AdminAiExtractors /></ProtectedRoute>
          </Route>
          <Route path="/admin/popups">
            <ProtectedRoute allowedRoles={ADMIN_ROLES}><AdminPopups /></ProtectedRoute>
          </Route>
          <Route path="/admin/audit">
            <ProtectedRoute allowedRoles={ADMIN_ROLES}><AdminAuditLog /></ProtectedRoute>
          </Route>
          <Route path="/admin/settings" component={StaffSettings} />
          <Route path="/admin/activity/:userId">
            {(params) => <ProtectedRoute allowedRoles={ADMIN_ROLES}><AdminActivity userId={Number(params.userId)} /></ProtectedRoute>}
          </Route>
          <Route path="/admin/activity">
            <ProtectedRoute allowedRoles={ADMIN_ROLES}><AdminActivity /></ProtectedRoute>
          </Route>
          <Route path="/admin/embeds">
            <ProtectedRoute allowedRoles={ADMIN_ROLES}><AdminEmbeds /></ProtectedRoute>
          </Route>
          <Route path="/admin/api-tokens">
            <ProtectedRoute allowedRoles={ADMIN_ROLES}><AdminApiTokens /></ProtectedRoute>
          </Route>
          <Route path="/admin/staff-cards/:userId">
            {(params) => <ProtectedRoute allowedRoles={["super_admin","admin"]}><AdminStaffCardDetail userId={Number(params.userId)} /></ProtectedRoute>}
          </Route>
          <Route path="/admin/staff-cards">
            <ProtectedRoute allowedRoles={["super_admin","admin"]}><AdminStaffCards /></ProtectedRoute>
          </Route>
          <Route path="/admin/quality-report">
            <ProtectedRoute allowedRoles={ADMIN_ROLES}><AdminQualityReport /></ProtectedRoute>
          </Route>
          <Route path="/admin/system-health">
            <ProtectedRoute allowedRoles={ADMIN_ROLES}><AdminSystemHealth /></ProtectedRoute>
          </Route>
          <Route path="/admin/data-quality">
            <ProtectedRoute allowedRoles={ADMIN_ROLES}><AdminDataQuality /></ProtectedRoute>
          </Route>
          <Route path="/admin/reports">
            <ProtectedRoute requiredPermission="reporting.view"><AdminReports /></ProtectedRoute>
          </Route>
          <Route path="/admin/operations">
            <ProtectedRoute allowedRoles={ADMIN_ROLES}><StaffOperationsCenter /></ProtectedRoute>
          </Route>
          <Route path="/admin/social">
            <ProtectedRoute requiredPermission="social.view"><AdminSocialOperations /></ProtectedRoute>
          </Route>
          <Route path="/admin/contract-templates">
            <ProtectedRoute allowedRoles={[...ADMIN_ROLES, "staff", "consultant", "accountant", "editor", "agent_staff"]} requiredPermission="contract_templates.view"><AdminContractTemplates /></ProtectedRoute>
          </Route>
          <Route path="/admin/contracts">
            <ProtectedRoute allowedRoles={[...ADMIN_ROLES, "staff", "consultant", "accountant", "editor", "agent_staff"]} requiredPermission="contracts.view"><AdminContracts /></ProtectedRoute>
          </Route>
          <Route path="/admin/self-fill-links">
            <ProtectedRoute allowedRoles={[...ADMIN_ROLES, "staff", "consultant", "accountant", "editor", "agent_staff"]} requiredPermission="self_fill_links.view"><AdminSelfFillLinks /></ProtectedRoute>
          </Route>
          <Route path="/admin/university-contracts/:id">
            {(params) => <ProtectedRoute allowedRoles={[...ADMIN_ROLES, "staff", "consultant", "accountant", "editor", "agent_staff"]} requiredPermission="university_contracts.view"><AdminUniversityContracts openId={Number(params.id)} /></ProtectedRoute>}
          </Route>
          <Route path="/admin/university-contracts">
            <ProtectedRoute allowedRoles={[...ADMIN_ROLES, "staff", "consultant", "accountant", "editor", "agent_staff"]} requiredPermission="university_contracts.view"><AdminUniversityContracts /></ProtectedRoute>
          </Route>
          <Route path="/admin/company-contracts/:id">
            {(params) => <ProtectedRoute allowedRoles={[...ADMIN_ROLES, "staff", "consultant", "accountant", "editor", "agent_staff"]} requiredPermission="company_contracts.view"><AdminCompanyContracts openId={Number(params.id)} /></ProtectedRoute>}
          </Route>
          <Route path="/admin/company-contracts">
            <ProtectedRoute allowedRoles={[...ADMIN_ROLES, "staff", "consultant", "accountant", "editor", "agent_staff"]} requiredPermission="company_contracts.view"><AdminCompanyContracts /></ProtectedRoute>
          </Route>
          <Route path="/admin/portal-automation">
            <ProtectedRoute allowedRoles={ADMIN_ROLES}><AdminPortalAutomation /></ProtectedRoute>
          </Route>
          <Route path="/admin/ai-agent">
            <ProtectedRoute allowedRoles={ADMIN_ROLES}><AdminAiAgent /></ProtectedRoute>
          </Route>
          <Route path="/admin/portal-credentials">
            <ProtectedRoute allowedRoles={ADMIN_ROLES}><AdminPortalCredentials /></ProtectedRoute>
          </Route>
          <Route path="/admin/website/pages/:id/edit">
            {(params) => <ProtectedRoute allowedRoles={WEBSITE_ADMIN_ROLES}><WebsitePageEditor id={Number(params.id)} /></ProtectedRoute>}
          </Route>
          <Route path="/admin/website/pages">
            <ProtectedRoute allowedRoles={WEBSITE_ADMIN_ROLES}><WebsitePages /></ProtectedRoute>
          </Route>
          <Route path="/admin/website/global-components">
            <ProtectedRoute allowedRoles={WEBSITE_ADMIN_ROLES}><WebsiteGlobalComponents /></ProtectedRoute>
          </Route>
          <Route path="/admin/website/navigation">
            <ProtectedRoute allowedRoles={WEBSITE_ADMIN_ROLES}><WebsiteNavigation /></ProtectedRoute>
          </Route>
          <Route path="/admin/website/blog">
            <ProtectedRoute allowedRoles={WEBSITE_ADMIN_ROLES}><WebsiteBlog /></ProtectedRoute>
          </Route>
          <Route path="/admin/website/collections">
            <ProtectedRoute allowedRoles={WEBSITE_ADMIN_ROLES}><WebsiteCollections /></ProtectedRoute>
          </Route>
          <Route path="/admin/website/forms">
            <ProtectedRoute allowedRoles={WEBSITE_ADMIN_ROLES}><WebsiteForms /></ProtectedRoute>
          </Route>
          <Route path="/admin/website/seo">
            <ProtectedRoute allowedRoles={WEBSITE_ADMIN_ROLES}><WebsiteSeoOverrides /></ProtectedRoute>
          </Route>
          <Route path="/admin/website/theme">
            <ProtectedRoute allowedRoles={WEBSITE_ADMIN_ROLES}><WebsiteThemeBuilder /></ProtectedRoute>
          </Route>
          <Route path="/admin/website/translations">
            <ProtectedRoute allowedRoles={WEBSITE_ADMIN_ROLES}><WebsiteTranslations /></ProtectedRoute>
          </Route>
          <Route path="/admin/website/publish-history">
            <ProtectedRoute allowedRoles={WEBSITE_ADMIN_ROLES}><WebsitePublishHistory /></ProtectedRoute>
          </Route>
          {/* Staff routes */}
          <Route path="/staff" component={StaffDashboard} />
          <Route path="/staff/dashboard" component={StaffDashboard} />
          <Route path="/staff/leads/:id">
            {(params) => <LeadDetail id={Number(params.id)} />}
          </Route>
          <Route path="/staff/leads" component={StaffLeads} />
          <Route path="/staff/students/:id">
            {(params) => <StudentDetail id={Number(params.id)} />}
          </Route>
          <Route path="/staff/students" component={StaffStudents} />
          <Route path="/staff/applications/:id">
            {(params) => <ApplicationDetail id={Number(params.id)} />}
          </Route>
          <Route path="/staff/applications" component={StaffApplications} />
          <Route path="/staff/course-finder" component={StaffCourseFinder} />
          <Route path="/staff/agents/:id" component={StaffAgentDetail} />
          <Route path="/staff/agency-applications">
            <ProtectedRoute allowedRoles={["super_admin", "admin", "manager"]}><StaffAgencyApplications /></ProtectedRoute>
          </Route>
          <Route path="/staff/agents">
            <ProtectedRoute allowedRoles={["super_admin", "admin", "manager"]}><StaffAgents /></ProtectedRoute>
          </Route>
          <Route path="/staff/messages" component={StaffMessages} />
          <Route path="/staff/finance">
            <ProtectedRoute allowedRoles={["super_admin", "admin", "accountant"]}><StaffFinance /></ProtectedRoute>
          </Route>
          <Route path="/staff/settings" component={StaffSettings} />
          <Route path="/staff/tasks" component={StaffTasks} />
          <Route path="/staff/work" component={StaffOperationsCenter} />
          <Route component={NotFound} />
        </Switch>
        </Suspense>
      </DashboardLayout>
    </ProtectedRoute>
  );
}

function StudentShell() {
  return (
    <ProtectedRoute allowedRoles={STUDENT_ROLES}>
      <EmailVerificationGuard>
        <DashboardLayout>
          <Suspense fallback={<ShellLoader />}>
          <Switch>
            <Route path="/student" component={StudentDashboard} />
            <Route path="/student/wishlist" component={StudentWishlist} />
            <Route path="/student/messages" component={StudentMessages} />
            <Route path="/student/applications" component={StudentApplications} />
            <Route path="/student/course-finder" component={StaffCourseFinder} />
            <Route path="/student/account" component={StudentAccount} />
            <Route component={NotFound} />
          </Switch>
          </Suspense>
        </DashboardLayout>
      </EmailVerificationGuard>
    </ProtectedRoute>
  );
}

const AgentMyContract = lazy(() => import("@/pages/agent/MyContract"));
const AgentOnboardingPublic = lazy(() => import("@/pages/agent/Onboarding"));

function AgentShell() {
  return (
    <ProtectedRoute allowedRoles={AGENT_ROLES}>
      <AgentOnboardingGuard>
      <DashboardLayout>
        <Suspense fallback={<ShellLoader />}>
        <Switch>
          <Route path="/agent" component={AgentDashboard} />
          <Route path="/agent/sozlesmem" component={AgentMyContract} />
          <Route path="/agent/my-contract" component={AgentMyContract} />
          <Route path="/agent/leads/:id">
            {(params) => <ProtectedRoute allowedRoles={AGENT_ROLES} requiredPermission="leads"><LeadDetail id={Number(params.id)} basePath="/agent" /></ProtectedRoute>}
          </Route>
          <Route path="/agent/leads">
            <ProtectedRoute allowedRoles={AGENT_ROLES} requiredPermission="leads"><AgentLeads /></ProtectedRoute>
          </Route>
          <Route path="/agent/students/:id">
            {(params) => <ProtectedRoute allowedRoles={AGENT_ROLES} requiredPermission="students"><StudentDetail id={Number(params.id)} basePath="/agent" /></ProtectedRoute>}
          </Route>
          <Route path="/agent/students">
            <ProtectedRoute allowedRoles={AGENT_ROLES} requiredPermission="students"><AgentStudents /></ProtectedRoute>
          </Route>
          <Route path="/agent/applications/:id">
            {(params) => <ProtectedRoute allowedRoles={AGENT_ROLES} requiredPermission="applications"><ApplicationDetail id={Number(params.id)} basePath="/agent" /></ProtectedRoute>}
          </Route>
          <Route path="/agent/applications">
            <ProtectedRoute allowedRoles={AGENT_ROLES} requiredPermission="applications"><AgentApps /></ProtectedRoute>
          </Route>
          <Route path="/agent/messages">
            <ProtectedRoute allowedRoles={AGENT_ROLES} requiredPermission="messages"><AgentMessages /></ProtectedRoute>
          </Route>
          <Route path="/agent/commissions">
            <ProtectedRoute allowedRoles={AGENT_ROLES} requiredPermission="commissions"><AgentCommissions /></ProtectedRoute>
          </Route>
          <Route path="/agent/course-finder">
            <ProtectedRoute allowedRoles={AGENT_ROLES} requiredPermission="course_finder"><StaffCourseFinder /></ProtectedRoute>
          </Route>
          <Route path="/agent/account" component={AgentAccount} />
          <Route path="/agent/sub-agents">
            <ProtectedRoute allowedRoles={["agent"]}><AgentSubAgents /></ProtectedRoute>
          </Route>
          <Route path="/agent/team">
            <ProtectedRoute allowedRoles={["agent", "sub_agent"]}><AgentTeam /></ProtectedRoute>
          </Route>
          <Route component={NotFound} />
        </Switch>
        </Suspense>
      </DashboardLayout>
      </AgentOnboardingGuard>
    </ProtectedRoute>
  );
}

function InstitutionShell() {
  return (
    <ProtectedRoute allowedRoles={INSTITUTION_ROLES}>
      <DashboardLayout>
        <Suspense fallback={<ShellLoader />}>
          <Switch>
            <Route path="/institution/applications/:id">
              {(params) => <InstitutionWorkspace view="application" applicationId={params.id} />}
            </Route>
            <Route path="/institution/review-queue"><InstitutionWorkspace view="review-queue" /></Route>
            <Route path="/institution/applications"><InstitutionWorkspace view="applications" /></Route>
            <Route path="/institution/decisions"><InstitutionWorkspace view="decisions" /></Route>
            <Route path="/institution/offers"><InstitutionWorkspace view="offers" /></Route>
            <Route path="/institution/programs-intakes"><InstitutionWorkspace view="programs-intakes" /></Route>
            <Route path="/institution/requirements"><InstitutionWorkspace view="requirements" /></Route>
            <Route path="/institution/sla"><InstitutionWorkspace view="sla" /></Route>
            <Route path="/institution/integrations"><InstitutionWorkspace view="integrations" /></Route>
            <Route path="/institution/analytics"><InstitutionWorkspace view="analytics" /></Route>
            <Route path="/institution/team"><InstitutionWorkspace view="team" /></Route>
            <Route path="/institution/audit"><InstitutionWorkspace view="audit" /></Route>
            <Route path="/institution"><InstitutionWorkspace view="home" /></Route>
            <Route component={NotFound} />
          </Switch>
        </Suspense>
      </DashboardLayout>
    </ProtectedRoute>
  );
}

function Router() {
  const [location] = useLocation();

  const isStaffAdminPath = location === "/admin" || location.startsWith("/admin/") ||
                            location === "/staff" || location.startsWith("/staff/");
  const isStudentPath = location === "/student" || location.startsWith("/student/");
  const isAgentPath = location === "/agent" || location.startsWith("/agent/");
  const isInstitutionPath = location === "/institution" || location.startsWith("/institution/");
  const isAgencyApplicationPublic = location === "/agent/apply";
  const isPublicSignPath = location.startsWith("/sign/");
  const isAgentOnboardingPublic = location === "/agent/onboarding" || location.startsWith("/agent/onboarding?");

  // All hooks MUST be declared above any conditional return so hook order stays
  // stable across navigations between /sign/* and other branches.
  const prevBranch = useRef<string | null>(null);

  if (isPublicSignPath) {
    const token = location.slice("/sign/".length).split("/")[0] || "";
    return (
      <ErrorBoundary>
        <Suspense fallback={<PageLoader />}>
          <PublicSignFlow token={token} />
        </Suspense>
      </ErrorBoundary>
    );
  }

  if (isAgentOnboardingPublic) {
    return (
      <ErrorBoundary>
        <Suspense fallback={<PageLoader />}>
          <AgentOnboardingPublic />
        </Suspense>
      </ErrorBoundary>
    );
  }

  if (isAgencyApplicationPublic) {
    return (
      <ErrorBoundary>
        <Suspense fallback={<PageLoader />}>
          <PublicLayout><AgencyApplication /></PublicLayout>
        </Suspense>
      </ErrorBoundary>
    );
  }

  const branch = isStaffAdminPath ? "staff" : isStudentPath ? "student" : isAgentPath ? "agent" : isInstitutionPath ? "institution" : "public";
  if (prevBranch.current !== branch) {
    prevBranch.current = branch;
  }

  if (isStaffAdminPath) {
    return <ErrorBoundary><StaffAdminShell /></ErrorBoundary>;
  }

  if (isStudentPath) {
    return <ErrorBoundary><StudentShell /></ErrorBoundary>;
  }

  if (isAgentPath) {
    return <ErrorBoundary><AgentShell /></ErrorBoundary>;
  }

  if (isInstitutionPath) {
    return <ErrorBoundary><InstitutionShell /></ErrorBoundary>;
  }

  // ── Public branch ────────────────────────────────────────────────────────────
  // We intentionally do NOT use Wouter <Switch>/<Route> here.  The old approach
  // had two separate Route entries — `/:lang` (matches `/en`) and `/:lang/:rest*`
  // (matches `/en/about`).  When navigating between different path depths, Wouter
  // would match a DIFFERENT Route element each time, so React would unmount and
  // remount PublicRoutes (and everything inside it — PublicLayout, header, footer)
  // on every nav.  That was the "reload on every route change" the user saw.
  //
  // Fix: inspect the path directly and render from a SINGLE stable JSX position
  // so React reconciles without remounting, regardless of path depth.

  if (location === "/" || location === "") {
    return (
      <ErrorBoundary>
        <Suspense fallback={<PageLoader />}>
          <LanguageRedirect />
        </Suspense>
      </ErrorBoundary>
    );
  }

  if (location === "/login") {
    return (
      <ErrorBoundary>
        <Suspense fallback={<PageLoader />}>
          <LoginRedirect />
        </Suspense>
      </ErrorBoundary>
    );
  }

  // Extract first path segment (language code or unrecognised slug)
  const firstSegment = location.split("/").filter(Boolean)[0] ?? "";
  const rest = location.split("/").filter(Boolean).slice(1).join("/");

  if (isValidLanguage(firstSegment)) {
    // Stable branch: always renders PublicRoutes at the same tree position,
    // regardless of whether location is `/en`, `/en/about`, or `/en/countries/uk`.
    return (
      <ErrorBoundary>
        <Suspense fallback={<PageLoader />}>
          <PublicRoutes lang={firstSegment} />
        </Suspense>
      </ErrorBoundary>
    );
  }

  if (firstSegment) {
    return (
      <ErrorBoundary>
        <Suspense fallback={<PageLoader />}>
          <InvalidLangRedirect segment={firstSegment} rest={rest} />
        </Suspense>
      </ErrorBoundary>
    );
  }

  return <ErrorBoundary><NotFound /></ErrorBoundary>;
}

function AuthPrefetch() {
  const [initialUser] = useState(() => getStickyUser() ?? getAuthCache());
  const result = useGetMe({
    query: {
      retry: false,
      staleTime: 30_000,
      ...(initialUser !== undefined
        ? {
            initialData: initialUser as any,
            // Mark initial data as fresh so TanStack Query doesn't
            // immediately schedule a background refetch on mount.
            initialDataUpdatedAt: Date.now() - 60_000, // stale so role/permission changes reflect on reload without re-login
          }
        : {}),
    } as any,
  });
  useEffect(() => {
    if (result.data) {
      setAuthCache(result.data);
      setStickyUser(result.data);
    } else if (result.error) {
      // Only clear the auth cache (and sticky user) on confirmed auth errors.
      // Do NOT clear on transient network errors — that would wipe the
      // sticky user and cause white flashes on the next navigation.
      const status = (result.error as any)?.status as number | undefined;
      if (status === 401 || status === 403) {
        clearAuthCache();
      }
    }
  }, [result.data, result.error]);

  useEffect(() => {
    const role = (result.data as { role?: string } | null | undefined)?.role;
    if (!role) return;

    // Do not eagerly download the whole application after login. The previous
    // implementation imported every staff, admin, website, student and agent
    // route at once. That defeated route-level lazy loading and pulled large
    // PDF/Excel/chart chunks into the network and JS heap even when the user
    // could never visit those routes.
    //
    // Warm only the small, high-frequency routes for the authenticated role,
    // and do it while the browser is idle. All other routes remain true lazy
    // imports and are fetched on navigation.
    const prefetchForRole = async (): Promise<void> => {
      if (STUDENT_ROLES.includes(role)) {
        await Promise.allSettled([
          import("@/pages/student/Dashboard"),
          import("@/pages/student/Applications"),
          import("@/pages/student/Messages"),
        ]);
        return;
      }
      if (AGENT_ROLES.includes(role)) {
        await Promise.allSettled([
          import("@/pages/agent/Dashboard"),
          import("@/pages/agent/AgentApps"),
          import("@/pages/agent/Messages"),
        ]);
        return;
      }
      if (INSTITUTION_ROLES.includes(role)) {
        await import("@/pages/institution/Workspace");
        return;
      }
      if (STAFF_ROLES.includes(role)) {
        await Promise.allSettled([
          import("@/pages/staff/Dashboard"),
          import("@/pages/staff/Applications"),
          import("@/pages/staff/Messages"),
        ]);
      }
    };

    let cancelled = false;
    const run = () => {
      if (!cancelled) void prefetchForRole();
    };
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const idleHandle = idleWindow.requestIdleCallback?.(run, { timeout: 4000 });
    const timeoutHandle =
      idleHandle === undefined ? window.setTimeout(run, 2500) : undefined;

    return () => {
      cancelled = true;
      if (idleHandle !== undefined) idleWindow.cancelIdleCallback?.(idleHandle);
      if (timeoutHandle !== undefined) window.clearTimeout(timeoutHandle);
    };
  }, [result.data]);

  return null;
}

// Listen for 401 responses from the shared API client. When the server
// reports the session is gone (e.g. cookie expired, deploy invalidated
// sessions, manual signout in another tab), wipe local cached user state
// and bounce the user to the login page so they don't get stuck looking
// at stale UI with broken images and confusing "Authentication required"
// toasts. Preserve where they were so login can return them after auth.
function setupUnauthorizedHandler() {
  if (typeof window === "undefined") return;
  if ((window as any).__unauthorizedHandlerInstalled) return;
  (window as any).__unauthorizedHandlerInstalled = true;

  let redirecting = false;
  window.addEventListener("api:unauthorized", () => {
    if (redirecting) return;

    const { pathname, search } = window.location;
    // The SPA uses in-memory routing so window.location.pathname is always
    // "/" in the Replit preview. Read the real SPA path from the localStorage
    // nav session (written by useCustomBrowserLocation on every navigation).
    // Fall back to window.location.pathname for normal deployments where the
    // URL does reflect the SPA route.
    const spaPath = getSavedNavPath() ?? pathname;

    // Don't redirect away from the login page or the public site.
    const langSegment = pathname.split("/")[1] || DEFAULT_LANGUAGE;
    const isOnLogin = /\/login(\/|$|\?)/.test(spaPath);
    const isOnPublic = !/\/(admin|agent|student|staff)(\/|$)/.test(spaPath);
    // Public agent flows: the email-verification page is reachable BEFORE
    // login (the user has only clicked the link in their inbox), and the
    // public sign flow obviously can't require an active session either.
    // Without these exemptions the first /api/auth/me 401 yanks the user
    // to /login?returnTo=... and they never see the verification screen.
    // Anchor at the language-prefixed root so an unrelated "/.../sign/" or
    // "/.../agent/onboarding-..." segment can't accidentally bypass the
    // login redirect in the future.
    const isOnAgentOnboarding = /^\/[a-z]{2}\/agent\/onboarding(?:\/|$)/.test(spaPath)
      || /^\/agent\/onboarding(?:\/|$)/.test(spaPath);
    const isOnPublicSign = /^\/[a-z]{2}\/sign\//.test(spaPath)
      || spaPath.startsWith("/sign/");
    if (isOnLogin || isOnPublic || isOnAgentOnboarding || isOnPublicSign) return;

    redirecting = true;

    // Wipe the in-memory + localStorage user cache so the next page render
    // doesn't show a stale "logged in" header.
    try { clearAuthCache(); } catch {}
    try { queryClient.clear(); } catch {}

    const lang = isValidLanguage(langSegment) ? langSegment : DEFAULT_LANGUAGE;
    const returnTo = encodeURIComponent(spaPath + search);
    window.location.replace(`/${lang}/login?returnTo=${returnTo}`);
  });
}

if (typeof window !== "undefined") {
  setupUnauthorizedHandler();
}

function AgencyBrandingApplier() {
  useAgencyBranding();
  return null;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthPrefetch />
      <AgencyBrandingApplier />
      <ThemeProvider>
        <SeasonProvider>
          <I18nProvider>
            <UserLanguageSyncer />
            <TooltipProvider>
              <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")} hook={useCustomBrowserLocation as any}>
                <ActivityTrackerProvider>
                  <Router />
                </ActivityTrackerProvider>
              </WouterRouter>
              <Toaster />
            </TooltipProvider>
          </I18nProvider>
        </SeasonProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
