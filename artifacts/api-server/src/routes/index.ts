import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import usersRouter from "./users";
import leadsRouter from "./leads";
import studentsRouter from "./students";
import agentsRouter from "./agents";
import agentEmbedRouter from "./agentEmbed";
import applicationsRouter from "./applications";
import documentsRouter from "./documents";
import universitiesRouter from "./universities";
import financeRouter from "./finance";
import contentRouter from "./content";
import settingsRouter from "./settings";
import auditRouter from "./audit";
import statsRouter from "./stats";
import catalogRouter from "./catalog";
import aiExtractRouter from "./ai-extract";
import pipelineRouter from "./pipeline";
import courseFinderRouter from "./course-finder";
import storageRouter from "./storage";
import rolesRouter from "./roles";
import messagesRouter from "./messages";
import notificationsRouter from "./notifications";
import integrationsRouter from "./integrations";
import channelAccountsRouter from "./channelAccounts";
import activityRouter from "./activity";
import activityV1Router from "./activityV1";
import applicationStageDocumentsRouter from "./applicationStageDocuments";
import embedRouter from "./embed";
import publicApplyRouter from "./public-apply";
import aiPersonasRouter from "./ai-personas";
import aiExtractorsRouter from "./ai-extractors";
import aiDefaultsRouter from "./ai-defaults";
import destinationsRouter from "./destinations";
import quickLinksRouter from "./quickLinks";
import exportRouter from "./export";
import programDocumentRequirementsRouter from "./programDocumentRequirements";
import degreeDocumentRequirementsRouter from "./degreeDocumentRequirements";
import effectiveDocRequirementsRouter from "./effectiveDocRequirements";
import websiteRouter from "./website";
import tasksRouter from "./tasks";
import followUpsRouter from "./followUps";
import campaignsRouter from "./campaigns";
import inboxRouter from "./inbox";
import popupsRouter from "./popups";
import branchesRouter from "./branches";
import contractTemplatesRouter from "./contractTemplates";
import contractBrandsRouter from "./contractBrands";
import contractsRouter from "./contracts";
import publicSigningRouter from "./publicSigning";
import universityContractsRouter from "./universityContracts";
import companyContractsRouter from "./companyContracts";
import agentOnboardingRouter, { ONBOARDING_HELPERS } from "./agentOnboarding";
import leadAssignmentRulesRouter from "./leadAssignmentRules";
import staffCardsRouter from "./staffCards";
import apiTokensRouter from "./apiTokens";
import cmsRouter from "./cms";
import portalAutomationRouter from "./portalAutomation";
import qualityRouter from "./quality";
import portalMgmtRouter from "./portalMgmt";
import portalProgramFallbacksRouter from "./portalProgramFallbacks";
import portalUniversityExclusionsRouter from "./portalUniversityExclusions";
import personFeedRouter from "./personFeed";
import academySsoRouter from "./academySso";
import educationRecordsRouter from "./education-records";
import messageCampaignsRouter from "./messageCampaigns";
import dataQualityRouter from "./dataQuality";
import aiBotsRouter from "./aiBots";
import agentApplicationsRouter from "./agentApplications";
import institutionAdmissionsRouter from "./institutionAdmissions";
import reportingRouter from "./reporting";
import socialOperationsRouter from "./socialOperations";
import socialAdvertisingRouter from "./socialAdvertising";
import operationsRouter from "./operations";
import { tokenScopeGuard } from "../middlewares/tokenScopeGuard";
import { studentEmailVerificationGate } from "../middlewares/studentEmailVerificationGate";

const router: IRouter = Router();

// Keep unverified student sessions usable for the verification screen, but
// fail closed for all other API access until the address has been confirmed.
router.use(studentEmailVerificationGate);

// ────────────────────────────────────────────────────────────────────────────
// Agent onboarding gate. Runs after the global authMiddleware. For users in
// AGENT_ROLES, blocks all but the allow-listed endpoints until the user has
// (a) verified their email, AND (b) signed their primary onboarding contract.
// Returns 403 with an explicit code so the client can render the right lock
// screen (verify-email, sign-contract, contract-expired).
// ────────────────────────────────────────────────────────────────────────────
const AGENT_ROLES = new Set(["agent", "sub_agent", "agent_staff"]);
const ALLOWLIST_EXACT = new Set([
  "/auth/me", "/auth/logout",
  "/agents/me/onboarding-status",
  "/agents/me/resend-verification",
  "/agents/me/verify-email",
  // Set-password is part of the pre-contract onboarding flow: a freshly
  // verified agent must be able to choose a password before they can sign
  // their contract. Without this, the contract gate would 403 the request.
  "/agents/me/set-password",
  // Public onboarding endpoints. They're intended to be hit without a
  // session, but a user who already token-verified earlier still has a
  // session cookie on subsequent calls (manual fallback form, resend) —
  // the contract gate would otherwise 403 those calls.
  "/agents/onboarding/verify-with-link",
  "/agents/onboarding/resend-public",
  "/contracts/me",
  "/contracts/me/intake",
  "/contracts/me/sign",
  "/contracts/me/pending",
  "/settings/branding",
  "/settings/branding/logo",
  "/settings/available-years",
  "/health",
]);
const ALLOWLIST_PREFIX = [
  "/storage/public-objects/",
  "/storage/public-branding/",
  "/auth/",
  "/contracts/me/session/",
];
// Provisional agents may explore their portal in read-only mode while staff
// review the application. Commercial data and organisation-management tools
// remain hidden until approval activates the account.
const PROVISIONAL_COMMERCIAL_EXACT = new Set([
  "/agents/me/embed-token",
  "/academy-sso",
]);
const PROVISIONAL_COMMERCIAL_PREFIX = [
  "/commissions",
  "/finance",
  "/academy",
  "/agents/me/sub-agents",
  "/agents/me/staff",
];
const PROVISIONAL_WRITE_EXACT = new Set(["/storage/uploads/request-url"]);
const PROVISIONAL_WRITE_PREFIX = ["/storage/local-upload/"];

router.use(async (req, res, next) => {
  // Public/unauth endpoints just pass through.
  if (!req.user || !AGENT_ROLES.has(req.user.role)) { next(); return; }
  const path = req.path;
  if (ALLOWLIST_EXACT.has(path)) { next(); return; }
  for (const p of ALLOWLIST_PREFIX) { if (path.startsWith(p)) { next(); return; } }
  // Email gate.
  if (!req.user.emailVerified) {
    res.status(403).json({ error: "Email verification required", code: "EMAIL_VERIFICATION_REQUIRED" });
    return;
  }
  // Contract gate (primary onboarding only).
  try {
    const agent = await ONBOARDING_HELPERS.loadAgentForUser(req.user.id, req.user.role);
    if (!agent) { next(); return; }
    const provisionalCommercialRequest = PROVISIONAL_COMMERCIAL_EXACT.has(path)
      || PROVISIONAL_COMMERCIAL_PREFIX.some((prefix) => path.startsWith(prefix));
    const provisionalReadOnlyRequest = req.method === "GET" && !provisionalCommercialRequest;
    const provisionalProfileUpdate = req.method === "PATCH" && path === "/agents/me";
    const provisionalContractUploadRequest = (
      (req.method === "POST" && PROVISIONAL_WRITE_EXACT.has(path))
      || (req.method === "PUT" && PROVISIONAL_WRITE_PREFIX.some((prefix) => path.startsWith(prefix)))
    );
    if (
      provisionalContractUploadRequest
      || (agent.accessTier === "provisional" && (provisionalReadOnlyRequest || provisionalProfileUpdate))
    ) {
      next();
      return;
    }
    if (agent.accessTier !== "full") {
      res.status(403).json({
        error: agent.accessTier === "restricted" ? "Agency portal access is restricted" : "Agency application is awaiting approval",
        code: agent.accessTier === "restricted" ? "AGENT_PORTAL_RESTRICTED" : "AGENT_COMMERCIAL_ACCESS_RESTRICTED",
        accessTier: agent.accessTier,
      });
      return;
    }
    let session = await ONBOARDING_HELPERS.loadOnboardingSession(agent.id);
    if (!session) { next(); return; }
    session = await ONBOARDING_HELPERS.lazyExpire(session);
    if (session.status === "signed") { next(); return; }
    if (session.status === "expired") {
      res.status(403).json({ error: "Onboarding contract expired", code: "CONTRACT_EXPIRED" });
      return;
    }
    if (session.status === "revoked") {
      res.status(403).json({ error: "Onboarding contract revoked", code: "CONTRACT_EXPIRED" });
      return;
    }
    // Before the deadline day the agent may postpone signing and keep using the
    // portal (the frontend shows a dismissible reminder). On/after the deadline
    // day the contract becomes mandatory and the portal is blocked until signed.
    if (ONBOARDING_HELPERS.isOnboardingContractMandatory(session)) {
      res.status(403).json({ error: "Contract signature required", code: "CONTRACT_SIGNATURE_REQUIRED" });
      return;
    }
    next();
  } catch (err) {
    console.error("[agent-onboarding-gate]", err);
    res.status(503).json({
      error: "Agent onboarding state unavailable",
      code: "AGENT_ONBOARDING_UNAVAILABLE",
    });
  }
});

// Central API-token scope enforcement (default-deny). Runs before all route
// handlers. No-op for cookie/session requests; enforces least-privilege on
// Bearer-token requests.
router.use(tokenScopeGuard);

router.use(institutionAdmissionsRouter);
router.use(reportingRouter);
router.use(socialOperationsRouter);
router.use(socialAdvertisingRouter);
router.use(operationsRouter);

router.use(healthRouter);
router.use(storageRouter);
router.use(authRouter);
router.use(usersRouter);
router.use(leadsRouter);
router.use(studentsRouter);
router.use(agentsRouter);
router.use(agentEmbedRouter);
router.use(applicationsRouter);
router.use(documentsRouter);
router.use(universitiesRouter);
router.use(financeRouter);
router.use(contentRouter);
router.use(settingsRouter);
router.use(auditRouter);
router.use(statsRouter);
router.use(catalogRouter);
router.use(aiExtractRouter);
router.use(pipelineRouter);
router.use(courseFinderRouter);
router.use(rolesRouter);
router.use(messagesRouter);
router.use(messageCampaignsRouter);
router.use(notificationsRouter);
router.use(integrationsRouter);
router.use(channelAccountsRouter);
router.use(activityRouter);
router.use(activityV1Router);
router.use(applicationStageDocumentsRouter);
router.use(embedRouter);
router.use(publicApplyRouter);
router.use(destinationsRouter);
router.use(quickLinksRouter);
router.use(exportRouter);
router.use(programDocumentRequirementsRouter);
router.use(degreeDocumentRequirementsRouter);
router.use(effectiveDocRequirementsRouter);
router.use(websiteRouter);
router.use(tasksRouter);
router.use(followUpsRouter);
router.use(campaignsRouter);
router.use(inboxRouter);
router.use(popupsRouter);
router.use(branchesRouter);
router.use(contractTemplatesRouter);
router.use(contractBrandsRouter);
router.use(contractsRouter);
router.use(publicSigningRouter);
router.use(universityContractsRouter);
router.use(companyContractsRouter);
router.use(agentOnboardingRouter);
router.use(leadAssignmentRulesRouter);
router.use(staffCardsRouter);
router.use(aiPersonasRouter);
router.use(aiExtractorsRouter);
router.use(aiDefaultsRouter);
router.use(apiTokensRouter);
router.use(cmsRouter);
router.use(portalAutomationRouter);
router.use(portalMgmtRouter);
router.use(portalProgramFallbacksRouter);
router.use(portalUniversityExclusionsRouter);
router.use(personFeedRouter);
router.use(qualityRouter);
router.use(academySsoRouter);
router.use(educationRecordsRouter);
router.use(dataQualityRouter);
router.use(aiBotsRouter);
router.use(agentApplicationsRouter);

export default router;
