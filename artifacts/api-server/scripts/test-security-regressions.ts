import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isCredentialedCorsOriginAllowed } from "../src/lib/requestOrigin";
import { getDatabaseName, isSafeE2eDatabaseUrl } from "./e2e-database-safety";
import { canAssignUserRole, canManageTargetAccount } from "../src/lib/userAccountSecurity";
import { isBlockedOutboundIp, parseSafeOutboundUrl } from "../src/lib/safeOutboundRequest";
import { sanitizeContractTemplateHtml } from "../src/lib/contractHtmlSanitizer";
import { renderTemplate } from "../src/lib/contractRenderer";

const appSource = readFileSync(
  new URL("../src/app.ts", import.meta.url),
  "utf8",
);
const indexSource = readFileSync(
  new URL("../src/index.ts", import.meta.url),
  "utf8",
);
const routesIndexSource = readFileSync(
  new URL("../src/routes/index.ts", import.meta.url),
  "utf8",
);
const lifecycleSource = readFileSync(
  new URL("../src/lib/portalLifecycleContract.ts", import.meta.url),
  "utf8",
);
const staffSettingsSource = readFileSync(
  new URL("../../edcons/src/pages/staff/Settings.tsx", import.meta.url),
  "utf8",
);
const agentAccountSource = readFileSync(
  new URL("../../edcons/src/pages/agent/Account.tsx", import.meta.url),
  "utf8",
);
const inboxRouteSource = readFileSync(
  new URL("../src/routes/inbox.ts", import.meta.url),
  "utf8",
);
const messagesUiSource = readFileSync(
  new URL("../../edcons/src/pages/staff/Messages.tsx", import.meta.url),
  "utf8",
);
const storageRouteSource = readFileSync(
  new URL("../src/routes/storage.ts", import.meta.url),
  "utf8",
);
const objectAuthzSource = readFileSync(
  new URL("../src/lib/objectAuthz.ts", import.meta.url),
  "utf8",
);
const emailVerificationSource = readFileSync(
  new URL("../src/lib/emailVerificationToken.ts", import.meta.url),
  "utf8",
);
const mainAgencySignatureSource = readFileSync(
  new URL("../src/lib/mainAgencySignature.ts", import.meta.url),
  "utf8",
);
const usersRouteSource = readFileSync(
  new URL("../src/routes/users.ts", import.meta.url),
  "utf8",
);
const agentsRouteSource = readFileSync(
  new URL("../src/routes/agents.ts", import.meta.url),
  "utf8",
);
const aiAgentConfigSource = readFileSync(
  new URL("../src/lib/inbox/aiAgentConfig.ts", import.meta.url),
  "utf8",
);
const botAutoReplySource = readFileSync(
  new URL("../src/lib/inbox/botAutoReply.ts", import.meta.url),
  "utf8",
);
const aiBotsRouteSource = readFileSync(
  new URL("../src/routes/aiBots.ts", import.meta.url),
  "utf8",
);
const dormBookingFollowupSource = readFileSync(
  new URL("../src/lib/inbox/dormBookingFollowupWorker.ts", import.meta.url),
  "utf8",
);
const legacyUserManagementPolicySource = readFileSync(
  new URL("../src/lib/legacyUserManagementPolicy.ts", import.meta.url),
  "utf8",
);
const rolesRouteSource = readFileSync(
  new URL("../src/routes/roles.ts", import.meta.url),
  "utf8",
);
const branchesRouteSource = readFileSync(
  new URL("../src/routes/branches.ts", import.meta.url),
  "utf8",
);
const universitiesRouteSource = readFileSync(
  new URL("../src/routes/universities.ts", import.meta.url),
  "utf8",
);
const embedRouteSource = readFileSync(
  new URL("../src/routes/embed.ts", import.meta.url),
  "utf8",
);
const authSource = readFileSync(
  new URL("../src/lib/auth.ts", import.meta.url),
  "utf8",
);
const permissionsSource = readFileSync(
  new URL("../src/lib/permissions.ts", import.meta.url),
  "utf8",
);
const authMiddlewareSource = readFileSync(
  new URL("../src/middlewares/authMiddleware.ts", import.meta.url),
  "utf8",
);
const authHookSource = readFileSync(
  new URL("../../edcons/src/hooks/use-auth.ts", import.meta.url),
  "utf8",
);
const protectedRouteSource = readFileSync(
  new URL("../../edcons/src/components/auth/ProtectedRoute.tsx", import.meta.url),
  "utf8",
);
const safeOutboundSource = readFileSync(
  new URL("../src/lib/safeOutboundRequest.ts", import.meta.url),
  "utf8",
);
const financeRouteSource = readFileSync(
  new URL("../src/routes/finance.ts", import.meta.url),
  "utf8",
);
const financeUiSource = readFileSync(
  new URL("../../edcons/src/pages/staff/Finance.tsx", import.meta.url),
  "utf8",
);
const financeMigrationSource = readFileSync(
  new URL("../../../lib/db/drizzle/0063_finance_mutation_integrity.sql", import.meta.url),
  "utf8",
);
const uploadProcessingSource = readFileSync(
  new URL("../src/lib/uploads/processUpload.ts", import.meta.url),
  "utf8",
);
const authRouteSource = readFileSync(
  new URL("../src/routes/auth.ts", import.meta.url),
  "utf8",
);
const logoutClientSource = readFileSync(
  new URL("../../edcons/src/lib/logout.ts", import.meta.url),
  "utf8",
);
const contractPdfSource = readFileSync(
  new URL("../src/lib/contractPdf.ts", import.meta.url),
  "utf8",
);
const settingsRouteSource = readFileSync(
  new URL("../src/routes/settings.ts", import.meta.url),
  "utf8",
);
const aiExtractRouteSource = readFileSync(
  new URL("../src/routes/ai-extract.ts", import.meta.url),
  "utf8",
);
const sessionSource = readFileSync(
  new URL("../src/lib/replitAuth.ts", import.meta.url),
  "utf8",
);
const assetSigningSource = readFileSync(
  new URL("../../../lib/portal-adapters/src/assetSigningSecret.ts", import.meta.url),
  "utf8",
);
const webhooksSource = readFileSync(
  new URL("../src/routes/webhooks.ts", import.meta.url),
  "utf8",
);
const agentApplicationsSource = readFileSync(
  new URL("../src/routes/agentApplications.ts", import.meta.url),
  "utf8",
);
const activityRouteSource = readFileSync(
  new URL("../src/routes/activity.ts", import.meta.url),
  "utf8",
);
const socialOperationsRouteSource = readFileSync(
  new URL("../src/routes/socialOperations.ts", import.meta.url),
  "utf8",
);
const socialAdvertisingRouteSource = readFileSync(
  new URL("../src/routes/socialAdvertising.ts", import.meta.url),
  "utf8",
);
const socialAdvertisingQueueSource = readFileSync(
  new URL("../src/lib/socialAdvertisingQueue.ts", import.meta.url),
  "utf8",
);
const institutionAdmissionsRouteSource = readFileSync(
  new URL("../src/routes/institutionAdmissions.ts", import.meta.url),
  "utf8",
);
const testEnvRunnerSource = readFileSync(
  new URL("./run-with-env.cjs", import.meta.url),
  "utf8",
);

test("authenticated course-finder writes are not exempt from CSRF", () => {
  assert.doesNotMatch(
    appSource,
    /startsWith\(["']\/api\/course-finder["']\)/,
  );
  assert.match(appSource, /const CSRF_SAFE_METHODS/);
  assert.match(appSource, /cookieToken !== headerToken/);
});

test("the SPA fallback does not issue a second conflicting CSRF cookie", () => {
  assert.match(appSource, /csrfCookieIssued/);
  assert.match(indexSource, /cookies\?\.csrf_token/);
  assert.match(indexSource, /csrfCookieIssued\?: boolean/);
});

test("browser permissions keep sensitive sensors blocked", () => {
  // Scan and voice-note are intentional first-party features. They may use
  // same-origin camera/microphone only; geolocation stays unavailable.
  assert.match(appSource, /camera=\(self\)/);
  assert.match(appSource, /geolocation=\(\)/);
  assert.match(appSource, /microphone=\(self\)/);
});

test("database retries never classify a WITH statement as read-only", () => {
  const dbSource = readFileSync(
    new URL("../../../lib/db/src/index.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(dbSource, /\(select\|with\|/i);
  assert.match(dbSource, /\(select\|show\|explain\|values\|table\|fetch\)/i);
});

test("generated widget JavaScript is parsed without dynamic Function compilation", () => {
  const embedSource = readFileSync(
    new URL("../src/routes/embed.ts", import.meta.url),
    "utf8",
  );
  assert.match(embedSource, /parseJavaScript/);
  assert.doesNotMatch(embedSource, /new Function\(/);
});

test("portal diagnostics do not log raw applicant fields or permit production capture", () => {
  const topkapiSource = readFileSync(
    new URL("../../../lib/portal-adapters/src/universities/topkapi/adapter.ts", import.meta.url),
    "utf8",
  );
  const altinbasSource = readFileSync(
    new URL("../../../lib/portal-adapters/src/universities/altinbas/adapter.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(topkapiSource, /field values — email/);
  assert.doesNotMatch(topkapiSource, /request body:/);
  assert.match(altinbasSource, /process\.env\.NODE_ENV !== "production"/);
  assert.match(altinbasSource, /LOCAL_REDACTED_CAPTURE_ONLY/);
  assert.match(altinbasSource, /safeBody = redactAltinbasLog/);
  assert.match(altinbasSource, /bodySha256/);
  assert.doesNotMatch(altinbasSource, /url: safeUrl, body: safeBody/);
  assert.match(altinbasSource, /mode: 0o600/);
});

test("production frontend does not emit source maps into the public root", () => {
  const viteSource = readFileSync(
    new URL("../../edcons/vite.config.ts", import.meta.url),
    "utf8",
  );
  assert.match(viteSource, /sourcemap: !isProd/);
});

test("portal lifecycle planning can never authorize a portal mutation", () => {
  assert.match(lifecycleSource, /allowPortalMutation:\s*false/);
  assert.doesNotMatch(lifecycleSource, /allowPortalMutation:\s*true/);
});

test("credentialed CORS is fail-closed in production", () => {
  assert.match(appSource, /corsError\.status = 403/);
  const sameOrigin = "https://apply.findandstudy.com";
  assert.equal(
    isCredentialedCorsOriginAllowed(undefined, sameOrigin, [], "production"),
    true,
  );
  assert.equal(
    isCredentialedCorsOriginAllowed(sameOrigin, sameOrigin, [], "production"),
    true,
  );
  assert.equal(
    isCredentialedCorsOriginAllowed(
      "https://trusted.example",
      sameOrigin,
      ["https://trusted.example"],
      "production",
    ),
    true,
  );
  assert.equal(
    isCredentialedCorsOriginAllowed("https://evil.example", sameOrigin, [], "production"),
    false,
  );
  assert.equal(
    isCredentialedCorsOriginAllowed("http://localhost:25197", sameOrigin, [], "production"),
    false,
  );
  assert.equal(
    isCredentialedCorsOriginAllowed("http://localhost:25197", sameOrigin, [], "test"),
    true,
  );
});

test("privileged users can manage and grant only lower account tiers", () => {
  assert.equal(canManageTargetAccount("manager", "staff"), true);
  assert.equal(canManageTargetAccount("manager", "manager"), false);
  assert.equal(canManageTargetAccount("manager", "admin"), false);
  assert.equal(canManageTargetAccount("admin", "manager"), true);
  assert.equal(canManageTargetAccount("admin", "admin"), false);
  assert.equal(canManageTargetAccount("admin", "super_admin"), false);
  assert.equal(canManageTargetAccount("super_admin", "super_admin"), true);
  assert.equal(canAssignUserRole("manager", "staff"), true);
  assert.equal(canAssignUserRole("manager", "admin"), false);
  assert.equal(canAssignUserRole("manager", "custom_privileged_role"), false);
  assert.equal(canAssignUserRole("admin", "manager"), true);
  assert.equal(canAssignUserRole("admin", "admin"), false);
  assert.equal(canAssignUserRole("super_admin", "super_admin"), true);
});

test("user and role routes enforce permission and hierarchy boundaries", () => {
  assert.match(usersRouteSource, /requirePermission\("users\.create"\)/);
  assert.match(usersRouteSource, /canAssignUserRole\(req\.user!\.role, role\)/);
  assert.match(usersRouteSource, /You cannot change your own role/);
  assert.match(usersRouteSource, /canManageTargetAccount\(req\.user!\.role, existing\.role\)/);
  assert.match(usersRouteSource, /canManageTargetAccount\(req\.user!\.role, user\.role\)/);
  assert.match(usersRouteSource, /evaluateLegacyUserManagement/);
  assert.match(usersRouteSource, /evaluateLegacyUserImpersonation/);
  assert.match(usersRouteSource, /issued_at: currentSession\.issued_at/);
  assert.match(usersRouteSource, /PERMISSION_OVERRIDE_REQUIRES_SUPER_ADMIN/);
  assert.match(usersRouteSource, /notInArray\(usersTable\.role/);
  assert.match(legacyUserManagementPolicySource, /peer_or_higher_privilege/);
  assert.match(legacyUserManagementPolicySource, /agent_relationship_route_required/);
  assert.match(rolesRouteSource, /requirePermission\("users\.manage_roles"\)/);
  assert.doesNotMatch(rolesRouteSource, /requireRole\(\.\.\.ADMIN_ROLES\)/);
  assert.match(rolesRouteSource, /router\.post\("\/roles", requireAuth, requireRole\("super_admin"\)/);
  assert.match(rolesRouteSource, /router\.patch\("\/roles\/:id", requireAuth, requireRole\("super_admin"\)/);
  assert.match(rolesRouteSource, /router\.delete\("\/roles\/:id", requireAuth, requireRole\("super_admin"\)/);
  assert.doesNotMatch(rolesRouteSource, /seedDefaultRoles/);
  assert.match(authSource, /getEffectivePermissionSet\(req\.user\)/);
  assert.doesNotMatch(authSource, /\.\.\.fromDb, \.\.\.fromDefault/);
  assert.match(permissionsSource, /ALL_PERMISSION_ROLES = new Set\(\["super_admin"\]\)/);
  assert.match(authMiddlewareSource, /ADMINISH_ROLES = new Set\(\["super_admin"\]\)/);
  assert.match(authMiddlewareSource, /new Set\(\[\.\.\.effective, \.\.\.own\]\)/);
  assert.match(authMiddlewareSource, /isAuthoritativeImpersonationParent/);
  assert.match(authMiddlewareSource, /issuedAt: session\.issued_at/);
  assert.match(authMiddlewareSource, /isActive: parentAuthRow\.dbUser\.isActive !== false/);
  assert.doesNotMatch(authHookSource, /role === "super_admin" \|\| role === "admin"/);
  assert.doesNotMatch(protectedRouteSource, /effectiveUser\.role !== "super_admin" && effectiveUser\.role !== "admin"/);
  assert.doesNotMatch(agentsRouteSource, /user\.role === "super_admin" \|\| user\.role === "admin"/);
  assert.equal((agentsRouteSource.match(/issued_at: currentSession\.issued_at/g) ?? []).length, 2);
});

test("external AI delivery fails closed and activation requires Super Admin", () => {
  assert.match(aiAgentConfigSource, /externalAutoReplyEnabled: false/);
  assert.match(aiAgentConfigSource, /aiAgentPatchRequiresSuperAdmin/);
  assert.match(aiAgentConfigSource, /stripAlreadyEnabledAiAgentControls/);
  assert.match(aiAgentConfigSource, /AI_EXTERNAL_AUTO_REPLY_KILL_SWITCH/);
  assert.match(botAutoReplySource, /isExternalAutoReplyEmergencyStopped/);
  assert.match(botAutoReplySource, /reason: "external_delivery_disabled"/);
  assert.match(botAutoReplySource, /getExternalAiDeliveryBlockReason/);
  assert.match(aiBotsRouteSource, /req\.user!\.role === "super_admin"/);
  assert.match(aiBotsRouteSource, /externalAutoReplyEnabled: false/);
  assert.match(aiBotsRouteSource, /stripAlreadyEnabledAiAgentControls/);
  assert.match(inboxRouteSource, /aiAgentPatchRequiresSuperAdmin/);
  assert.match(inboxRouteSource, /stripAlreadyEnabledAiAgentControls/);
  assert.match(dormBookingFollowupSource, /!config\.externalAutoReplyEnabled/);
  assert.match(dormBookingFollowupSource, /isExternalAutoReplyEmergencyStopped/);
});

test("legacy impersonation is branch-scoped and nested sessions are denied", () => {
  assert.match(usersRouteSource, /getVisibleBranchIds/);
  assert.match(usersRouteSource, /currentSession\.originalSid/);
  assert.match(usersRouteSource, /auth\.impersonate\.denied/);
  assert.match(agentsRouteSource, /currentSession\.originalSid/);
  assert.match(agentsRouteSource, /Cannot impersonate an inactive account/);
});

test("outbound URL policy blocks local, metadata and alternate IP notations", () => {
  for (const address of [
    "0.0.0.0",
    "10.0.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "::1",
    "fc00::1",
    "fe80::1",
  ]) assert.equal(isBlockedOutboundIp(address), true, address);
  for (const address of [
    "8.8.8.8",
    "216.150.1.1",
    "2606:4700:4700::1111",
  ]) assert.equal(isBlockedOutboundIp(address), false, address);
  assert.equal(isBlockedOutboundIp("::ffff:8.8.8.8"), true);
  assert.throws(() => parseSafeOutboundUrl("https://169.254.169.254/latest/meta-data"));
  assert.throws(() => parseSafeOutboundUrl("https://[::1]/"));
  assert.throws(() => parseSafeOutboundUrl("https://2130706433/"));
  assert.throws(() => parseSafeOutboundUrl("https://0x7f000001/"));
  assert.throws(() => parseSafeOutboundUrl("https://example.com:8443", { allowedPorts: [443] }));
  assert.equal(parseSafeOutboundUrl("https://example.com/path", { allowedPorts: [443] }).hostname, "example.com");
  assert.throws(() => parseSafeOutboundUrl("https://other.example/path", { allowedHostnames: ["example.com"] }));
  assert.match(safeOutboundSource, /hostname: resolved\.address/);
  assert.match(safeOutboundSource, /servername: isIP\(hostname\)/);
  assert.match(safeOutboundSource, /new URL\(nextUrl\)\.origin !== url\.origin/);
});

test("contract HTML and rendered placeholders cannot persist executable markup", () => {
  const clean = sanitizeContractTemplateHtml(`
    <style>@import url(https://evil.example/a.css); .x{background:url(https://evil.example/a)}</style>
    <script>alert(1)</script><svg onload="alert(2)"></svg>
    <a href="javascript:alert(3)" onclick="alert(4)">link</a>
    <img src="https://cdn.example/logo.png" onerror="alert(5)">
    <table><tr><td>{{intake.name}}</td></tr></table>
  `);
  assert.doesNotMatch(clean, /<script|<svg|onload=|onclick=|onerror=|javascript:|@import|url\s*\(/i);
  assert.match(clean, /<table>/);
  assert.match(clean, /\{\{intake\.name\}\}/);

  const rendered = renderTemplate("<p>{{{intake.name}}}</p><a href=\"{{intake.url}}\">x</a>", {
    intake: { name: "<img src=x onerror=alert(1)>", url: "javascript:alert(2)" },
  });
  assert.match(rendered, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(rendered, /javascript:|href=/i);
});

test("legacy public program routes strip commercial fields for anonymous callers", () => {
  assert.match(universitiesRouteSource, /const visibleRows: any\[\] = req\.user/);
  assert.match(universitiesRouteSource, /sanitizeCourseFinderProgram\(row/);
  assert.match(universitiesRouteSource, /const visibleProgram = req\.user/);
});

test("widget-specific CORS clears permissive headers before applying its allow-list", () => {
  assert.match(embedRouteSource, /res\.removeHeader\("Access-Control-Allow-Origin"\)/);
});

test("generated form previews execute in sandboxed iframes", () => {
  for (const source of [staffSettingsSource, agentAccountSource]) {
    assert.doesNotMatch(source, /dangerouslySetInnerHTML=\{\{\s*__html:\s*formCode/);
    assert.match(source, /sandbox=""/);
    assert.match(source, /referrerPolicy="no-referrer"/);
  }
  assert.match(staffSettingsSource, /srcDoc=\{formCode\}/);
  assert.match(agentAccountSource, /\/api\/agents\/me\/web-to-lead-preview/);
});

test("permanent conversation deletion is admin-only and explicitly confirmed", () => {
  assert.match(inboxRouteSource, /\/inbox\/conversations\/bulk-archive/);
  assert.match(inboxRouteSource, /\/inbox\/conversations\/bulk-unarchive/);
  assert.match(inboxRouteSource, /\/inbox\/conversations\/bulk-delete/);
  assert.match(inboxRouteSource, /requireRole\("super_admin", "admin"\)/);
  assert.match(inboxRouteSource, /z\.literal\("DELETE_CONVERSATIONS"\)/);
  assert.match(inboxRouteSource, /delete_inbox_conversations/);
  assert.match(messagesUiSource, /button-bulk-delete/);
  assert.match(messagesUiSource, /button-internal-bulk-delete/);
  assert.match(messagesUiSource, /confirm: "DELETE_CONVERSATIONS"/);
  assert.match(messagesUiSource, /"delete-final"/);
});

test("E2E database mutations accept only explicit test database names", () => {
  assert.equal(
    isSafeE2eDatabaseUrl("postgresql://user:pass@localhost:5432/fasos_codex_e2e_20260730"),
    true,
  );
  assert.equal(
    isSafeE2eDatabaseUrl("postgresql://user:pass@localhost:5432/findandstudy_test"),
    true,
  );
  assert.equal(
    isSafeE2eDatabaseUrl("postgresql://user:pass@localhost:5432/findandstudy"),
    false,
  );
  assert.equal(
    isSafeE2eDatabaseUrl("postgresql://user:pass@localhost:5432/production"),
    false,
  );
  assert.equal(getDatabaseName("not-a-database-url"), null);
});

test("local uploads are owner-bound, fail closed, and bounded before buffering", () => {
  assert.match(storageRouteSource, /callerOwnsObject\(userId, relPath\)/);
  assert.match(storageRouteSource, /LOCAL_UPLOAD_ABSOLUTE_MAX_BYTES = 25 \* 1024 \* 1024/);
  assert.match(storageRouteSource, /receivedBytes \+= buffer\.length/);
  assert.match(storageRouteSource, /receivedBytes > LOCAL_UPLOAD_ABSOLUTE_MAX_BYTES/);
  assert.match(storageRouteSource, /const ownerRecorded = await recordObjectOwner/);
  assert.match(storageRouteSource, /if \(!ownerRecorded\)/);
  assert.doesNotMatch(storageRouteSource, /processUpload failed, storing original/);
  assert.match(objectAuthzSource, /recordObjectOwner[\s\S]*Promise<boolean>/);
  assert.match(objectAuthzSource, /failed to record object owner:[\s\S]*return false/);
});

test("legacy public-object URLs require a session and object-level authorization", () => {
  assert.match(
    storageRouteSource,
    /router\.get\("\/storage\/public-objects\/\*filePath", requireAuth/,
  );
  assert.match(storageRouteSource, /canonicalizeKey\(filePath\)/);
  assert.match(storageRouteSource, /canAccessGenericObject\([\s\S]*objectKey/);
  assert.doesNotMatch(
    storageRouteSource,
    /storage\/public-objects\/\*filePath[\s\S]{0,1000}searchPublicObject\(filePath\)/,
  );
  assert.match(storageRouteSource, /storage\/public-branding\/\*filePath/);
});

test("finance ledger mutations are serialized, positive, and idempotent", () => {
  assert.match(financeRouteSource, /prepareFinanceMutation/);
  assert.match(financeRouteSource, /persistFinanceMutation/);
  assert.match(financeRouteSource, /pg_advisory_xact_lock/);
  assert.match(financeRouteSource, /finance:university:/);
  assert.match(financeRouteSource, /finance:agent:/);
  assert.match(financeRouteSource, /finance:commission:/);
  assert.match(financeRouteSource, /db\.transaction\(async/);
  assert.match(financeUiSource, /"Idempotency-Key": crypto\.randomUUID\(\)/);
  assert.match(financeMigrationSource, /CHECK \("amount" > 0\) NOT VALID/);
  assert.match(financeMigrationSource, /finance_mutation_requests_key_uidx/);
});

test("untrusted PDF processing is sandboxed and resource-bounded", () => {
  assert.match(uploadProcessingSource, /GHOSTSCRIPT_MAX_CONCURRENCY/);
  assert.match(uploadProcessingSource, /GHOSTSCRIPT_MAX_QUEUE/);
  assert.match(uploadProcessingSource, /withGhostscriptSlot/);
  assert.match(uploadProcessingSource, /"-dSAFER"/);
  assert.match(uploadProcessingSource, /timeout: GHOSTSCRIPT_TIMEOUT_MS/);
  assert.match(uploadProcessingSource, /maxBuffer: GHOSTSCRIPT_MAX_BUFFER_BYTES/);
  assert.match(uploadProcessingSource, /killSignal: "SIGKILL"/);
});

test("email verification links are random, hashed, expiring, and one-time", () => {
  assert.match(emailVerificationSource, /randomBytes\(32\)\.toString\("base64url"\)/);
  assert.match(emailVerificationSource, /createHash\("sha256"\)/);
  assert.match(emailVerificationSource, /EMAIL_VERIFICATION_LINK_TTL_MS = 24 \* 60 \* 60 \* 1000/);
  assert.match(emailVerificationSource, /eq\(emailVerificationCodesTable\.used, false\)/);
  assert.match(emailVerificationSource, /gt\(emailVerificationCodesTable\.expiresAt, new Date\(\)\)/);
  assert.match(emailVerificationSource, /\.set\(\{ used: true \}\)/);
});

test("the reusable main-agency signature is external to source and release artifacts", () => {
  assert.doesNotMatch(mainAgencySignatureSource, /data:image\/(?:png|jpeg);base64,/i);
  assert.match(mainAgencySignatureSource, /MAIN_AGENCY_SIGNATURE_FILE/);
  assert.match(mainAgencySignatureSource, /must be an absolute path/);
  assert.match(mainAgencySignatureSource, /must be outside the runtime release directory/);
  assert.match(mainAgencySignatureSource, /valid PNG or JPEG/);
});

test("logout is a CSRF-protected POST and no longer mutates state through GET", () => {
  assert.match(authRouteSource, /router\.post\("\/auth\/logout", handleLogout\)/);
  assert.doesNotMatch(authRouteSource, /router\.get\("\/auth\/logout"/);
  assert.match(authRouteSource, /res\.status\(204\)\.end\(\)/);
  assert.match(logoutClientSource, /customFetch\("\/api\/auth\/logout", \{ method: "POST" \}\)/);
  assert.match(logoutClientSource, /clearAuthCache\(\)/);
});

test("contract PDF rendering is network-isolated and does not log signer PII", () => {
  assert.match(contractPdfSource, /Contract rendering is intentionally network-isolated/);
  assert.match(contractPdfSource, /return route\.abort\(\)/);
  assert.doesNotMatch(contractPdfSource, /route\.continue\(\);\s*\n\s*\}\);/);
  assert.doesNotMatch(contractPdfSource, /render start signer=/);
});

test("activity PDF rendering blocks network access and returns generic errors", () => {
  assert.match(activityRouteSource, /await page\.route\("\*\*\/\*"/);
  assert.match(activityRouteSource, /return route\.abort\(\)/);
  assert.match(activityRouteSource, /res\.status\(500\)\.json\(\{ error: "Failed to generate PDF" \}\)/);
  assert.doesNotMatch(activityRouteSource, /Failed to generate PDF", detail:/);
  assert.match(activityRouteSource, /chromiumPathResolved/);
});

test("activity telemetry is owner-bound, input-bounded and coordinator-managed", () => {
  assert.match(
    activityRouteSource,
    /validate\(\{ body: heartbeatBodySchema \}\)/,
  );
  assert.match(
    activityRouteSource,
    /validate\(\{ body: pageVisitBodySchema \}\)/,
  );
  assert.match(activityRouteSource, /eq\(userSessionsTable\.userId, userId\)/);
  assert.match(
    activityRouteSource,
    /eq\(userPageVisitsTable\.userId, userId\)/,
  );
  assert.match(activityRouteSource, /wallClockSeconds/);
  assert.match(activityRouteSource, /MAX_TRACKED_SESSION_SECONDS/);
  assert.match(activityRouteSource, /isValidActivityReportRange/);
  assert.match(
    activityRouteSource,
    /export function startActivityStaleSessionCleanup/,
  );
  assert.match(activityRouteSource, /\.limit\(500\)/);
  assert.doesNotMatch(activityRouteSource, /^setInterval\(/m);
});

test("social advertising revalidates target identity and hides infrastructure failures", () => {
  assert.match(
    socialAdvertisingQueueSource,
    /SOCIAL_AD_PROVIDER_CAMPAIGN_MISMATCH/,
  );
  assert.match(socialAdvertisingQueueSource, /integration_enabled !== true/);
  assert.match(socialAdvertisingQueueSource, /integration_category/);
  assert.match(
    socialAdvertisingRouteSource,
    /status === 500 \? "SOCIAL_AD_FAILED" : code/,
  );
  assert.match(
    socialOperationsRouteSource,
    /status === 500 \? "SOCIAL_OPERATIONS_FAILED" : code/,
  );
  assert.match(socialAdvertisingRouteSource, /allowSocialAdMutation/);
});

test("institution admissions hides unexpected infrastructure failures", () => {
  assert.match(
    institutionAdmissionsRouteSource,
    /\^institution_\[a-z0-9_\]\{2,96\}\$/,
  );
  assert.match(
    institutionAdmissionsRouteSource,
    /status === 500 \? "institution_request_failed" : code/,
  );
  assert.doesNotMatch(
    institutionAdmissionsRouteSource,
    /console\.error\("\[institution-admissions\]", error\)/,
  );
});

test("cross-platform test environment runner has no shell or arbitrary command surface", () => {
  assert.match(testEnvRunnerSource, /requested === "node"/);
  assert.match(testEnvRunnerSource, /requested === "tsx"/);
  assert.match(testEnvRunnerSource, /throw new Error\("unsupported_command"\)/);
  assert.match(testEnvRunnerSource, /shell: false/);
  assert.match(testEnvRunnerSource, /\^\[A-Z\]\[A-Z0-9_\]\*\$/);
});

test("public embed output sanitizes URLs and escapes visitor-controlled attributes", () => {
  assert.match(embedRouteSource, /universityLogoUrl: publicUniversityLogoPath\(row\.universityId, row\.universityLogoUrl\)/);
  assert.match(embedRouteSource, /return `\/api\/universities\/\$\{id\}\/logo`/);
  assert.match(embedRouteSource, /universityWebsite: sanitizePublicUrl\(row\.universityWebsite\)/);
  assert.match(embedRouteSource, /value="'\+esc\(userFilters\.search\|\|''\)\+'"/);
  assert.match(embedRouteSource, /'\+esc\(nextLabel\)\+'<\/button>'/);
});

test("sensitive settings, AI work, sessions, assets and webhooks fail closed", () => {
  assert.match(routesIndexSource, /code: "AGENT_ONBOARDING_UNAVAILABLE"/);
  assert.doesNotMatch(
    routesIndexSource,
    /catch \(err\) \{\s*console\.error\("\[agent-onboarding-gate\]", err\);\s*next\(\);/,
  );
  assert.match(settingsRouteSource, /router\.get\("\/settings\/client", requireAuth/);
  assert.match(settingsRouteSource, /router\.get\("\/settings", requireAuth, requireRole\(\.\.\.MANAGER_ROLES\)/);
  assert.match(settingsRouteSource, /router\.patch\("\/settings", requireAuth, requireRole\("super_admin"\)/);
  assert.match(settingsRouteSource, /CREDENTIAL_FIELDS = \["smtpPassword", "whatsappToken", "n8nWebhookUrl"\]/);
  assert.match(settingsRouteSource, /Read paths must never bootstrap mutable platform configuration/);
  assert.match(settingsRouteSource, /platform_config\.settings\.update/);
  assert.match(settingsRouteSource, /"\/settings\/admin\/backfill-assignments", requireAuth, requireRole\("super_admin"\)/);
  assert.match(branchesRouteSource, /platform_config\.branch\.create/);
  assert.match(branchesRouteSource, /platform_config\.branch\.update/);
  assert.match(branchesRouteSource, /platform_config\.branch\.archive/);
  assert.match(branchesRouteSource, /platform_config\.branch\.unarchive/);
  assert.match(aiExtractRouteSource, /requireRole\(\.\.\.STAFF_ROLES, \.\.\.AGENT_ROLES\)/);
  assert.match(aiExtractRouteSource, /new PgRateLimitStore\(AI_RATE_WINDOW_MS, bucket\)/);
  assert.match(sessionSource, /getBoundedSessionExpiry/);
  assert.match(sessionSource, /const current = await getSession\(sid\)/);
  assert.match(sessionSource, /data\.issued_at \?\? current\.issued_at/);
  assert.match(assetSigningSource, /NODE_ENV === "production"\) return ""/);
  assert.match(webhooksSource, /cfg\.secret\.length < 16/);
  assert.match(webhooksSource, /status\(503\)\.json\(\{ error: "Webhook authentication is not configured" \}\)/);
  assert.match(agentApplicationsSource, /gt\(agentApplicationsTable\.accessTokenExpiresAt, new Date\(\)\)/);
});
