export type PortalPartnerBlockerCode =
  | "ADAPTER_REQUIRED"
  | "SECURE_PORTAL_URL_REQUIRED"
  | "CREDENTIALS_REQUIRED"
  | "CATALOG_LINK_REQUIRED"
  | "ACTIVE_PROGRAM_REQUIRED"
  | "RUNTIME_IDENTITY_REQUIRED"
  | "TEST_LOGIN_REQUIRED"
  | "STRICT_DRY_RUN_ADAPTER_REQUIRED"
  | "STRICT_DRY_RUN_REQUIRED";

export type PortalPartnerPhase =
  | "configuration_required"
  | "test_login_required"
  | "manual_pilot"
  | "strict_dry_run_required"
  | "activation_ready"
  | "automation_ready"
  | "automated";

export interface PortalPartnerReadinessInput {
  adapterRegistered: boolean;
  portalUrl: string | null;
  hasCredentials: boolean;
  catalogLinked: boolean;
  activeProgramCount: number;
  graduationRequired: boolean;
  successCount: number;
  graduationThreshold: number;
  runtimeIdentityReady: boolean;
  testLoginPassed: boolean;
  strictDryRunCapable: boolean;
  strictDryRunPassed: boolean;
  isActive: boolean;
  autoProcess: boolean;
}

export interface PortalPartnerReadiness {
  configurationReady: boolean;
  activationEligible: boolean;
  manualPilotEligible: boolean;
  automaticEligible: boolean;
  blockers: PortalPartnerBlockerCode[];
  configurationBlockers: PortalPartnerBlockerCode[];
  activationBlockers: PortalPartnerBlockerCode[];
  executionBlockers: PortalPartnerBlockerCode[];
  successProofsRemaining: number;
  requiredVerifications: readonly ["TEST_LOGIN", "STRICT_DRY_RUN"];
  phase: PortalPartnerPhase;
}

export function safePortalHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Pure, fail-closed partner onboarding projection.
 *
 * Login and strict dry-run are separate, version-bound execution receipts.
 * Configuration alone may never unlock a real submission, automatic work or
 * fan-out. Durable real-submission proofs remain the graduation authority.
 */
export function computePortalPartnerReadiness(
  input: PortalPartnerReadinessInput,
): PortalPartnerReadiness {
  const configurationBlockers: PortalPartnerBlockerCode[] = [];
  if (!input.adapterRegistered) configurationBlockers.push("ADAPTER_REQUIRED");
  if (!safePortalHttpsUrl(input.portalUrl)) configurationBlockers.push("SECURE_PORTAL_URL_REQUIRED");
  if (!input.hasCredentials) configurationBlockers.push("CREDENTIALS_REQUIRED");
  if (!input.catalogLinked) configurationBlockers.push("CATALOG_LINK_REQUIRED");
  if (input.activeProgramCount < 1) configurationBlockers.push("ACTIVE_PROGRAM_REQUIRED");
  if (!input.runtimeIdentityReady) configurationBlockers.push("RUNTIME_IDENTITY_REQUIRED");

  const configurationReady = configurationBlockers.length === 0;
  const activationBlockers = [
    ...configurationBlockers,
    ...(!input.testLoginPassed ? ["TEST_LOGIN_REQUIRED" as const] : []),
  ];
  const activationEligible = activationBlockers.length === 0;
  const executionBlockers = [
    ...activationBlockers,
    ...(!input.strictDryRunCapable
      ? ["STRICT_DRY_RUN_ADAPTER_REQUIRED" as const]
      : !input.strictDryRunPassed
        ? ["STRICT_DRY_RUN_REQUIRED" as const]
        : []),
  ];
  const successProofsRemaining = input.graduationRequired
    ? Math.max(0, input.graduationThreshold - Math.max(0, input.successCount))
    : 0;
  const automaticEligible = executionBlockers.length === 0 && successProofsRemaining === 0;
  const manualPilotEligible = executionBlockers.length === 0 && input.isActive;

  let phase: PortalPartnerPhase;
  if (!configurationReady) phase = "configuration_required";
  else if (!input.testLoginPassed) phase = "test_login_required";
  else if (!input.isActive) phase = "activation_ready";
  else if (!input.strictDryRunCapable || !input.strictDryRunPassed) phase = "strict_dry_run_required";
  else if (successProofsRemaining > 0) phase = "manual_pilot";
  else if (!input.autoProcess) phase = "automation_ready";
  else phase = "automated";

  return {
    configurationReady,
    activationEligible,
    manualPilotEligible,
    automaticEligible,
    blockers: executionBlockers,
    configurationBlockers,
    activationBlockers,
    executionBlockers,
    successProofsRemaining,
    requiredVerifications: ["TEST_LOGIN", "STRICT_DRY_RUN"],
    phase,
  };
}
