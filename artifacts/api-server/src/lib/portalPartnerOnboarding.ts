import { and, asc, count, eq, inArray, isNull } from "drizzle-orm";
import {
  db,
  portalAccountUniversitiesTable,
  portalAutomationSettingsTable,
  portalUniversitiesTable,
  programsTable,
  universitiesTable,
} from "@workspace/db";
import {
  isExperimentalAdapterKey,
  resolveAdapterByKey,
} from "@workspace/portal-adapters";
import {
  getSuccessCounts,
  GRADUATION_THRESHOLD,
} from "./adapterGraduation.js";
import { loadPortalPartnerVerificationStates } from "@workspace/portal-runner";
import {
  computePortalPartnerReadiness,
  safePortalHttpsUrl,
  type PortalPartnerReadiness,
} from "./portalPartnerReadinessPolicy.js";

export interface PortalPartnerOnboardingRow {
  id: number;
  universityKey: string;
  universityName: string;
  adapterKey: string;
  adapterRegistered: boolean;
  portalUrl: string | null;
  hasCredentials: boolean;
  catalogLinked: boolean;
  activeProgramCount: number;
  targetCount: number;
  isMultiPortal: boolean;
  isActive: boolean;
  autoProcess: boolean;
  fanOutMode: string | null;
  verificationGeneration: number;
  runtimeReleaseId: string | null;
  adapterSpecVersion: number | null;
  adapterSpecSha256: string | null;
  testLoginPassed: boolean;
  testLoginVerifiedAt: string | null;
  strictDryRunCapable: boolean;
  strictDryRunPassed: boolean;
  strictDryRunVerifiedAt: string | null;
  graduationRequired: boolean;
  successCount: number;
  graduationThreshold: number;
  graduated: boolean;
  readiness: PortalPartnerReadiness;
}

export interface PortalPartnerOnboardingSnapshot {
  generatedAt: string;
  globalSafety: {
    pilotSafeDefaults: boolean;
    blockers: string[];
    isEnabled: boolean;
    mode: "dry" | "real";
    autoProcessEnabled: boolean;
    fallbackEnabled: boolean;
    fanOutMode: string;
  };
  summary: {
    total: number;
    configurationReady: number;
    blocked: number;
    manualPilot: number;
    automaticEligible: number;
    automated: number;
  };
  partners: PortalPartnerOnboardingRow[];
}

export async function loadPortalPartnerOnboardingSnapshot(
  ids?: readonly number[],
): Promise<PortalPartnerOnboardingSnapshot> {
  const universityWhere = ids && ids.length > 0
    ? and(
        inArray(portalUniversitiesTable.id, [...ids]),
        isNull(portalUniversitiesTable.deletedAt),
      )
    : isNull(portalUniversitiesTable.deletedAt);

  const [partners, settingsRows] = await Promise.all([
    db
      .select()
      .from(portalUniversitiesTable)
      .where(universityWhere)
      .orderBy(asc(portalUniversitiesTable.universityName), asc(portalUniversitiesTable.id)),
    db
      .select()
      .from(portalAutomationSettingsTable)
      .orderBy(asc(portalAutomationSettingsTable.id))
      .limit(1),
  ]);
  const verificationByPartner = await loadPortalPartnerVerificationStates(
    partners.map((partner) => ({
      id: partner.id,
      universityKey: partner.universityKey,
      adapterKey: partner.adapterKey,
      verificationGeneration: partner.verificationGeneration,
    })),
  );

  const adapterKeys = [...new Set(partners.map((row) => row.adapterKey))];
  const adapterEntries = await Promise.all(
    adapterKeys.map(async (key) => [key, await resolveAdapterByKey(key)] as const),
  );
  const adapters = new Map(adapterEntries);
  const graduationKeys = adapterKeys.filter(isExperimentalAdapterKey);
  const successCounts = await getSuccessCounts(graduationKeys);

  const directCatalogIds = partners
    .filter((row) => !row.isMultiPortal && row.crmUniversityId != null)
    .map((row) => row.crmUniversityId as number);
  const portalKeys = partners.map((row) => row.universityKey);
  const memberships = portalKeys.length === 0
    ? []
    : await db
        .select({
          portalKey: portalAccountUniversitiesTable.portalKey,
          catalogUniversityId: portalAccountUniversitiesTable.catalogUniversityId,
        })
        .from(portalAccountUniversitiesTable)
        .where(and(
          inArray(portalAccountUniversitiesTable.portalKey, portalKeys),
          eq(portalAccountUniversitiesTable.enabled, true),
        ));
  const memberCatalogIds = memberships.map((row) => row.catalogUniversityId);
  const allCatalogIds = [...new Set([...directCatalogIds, ...memberCatalogIds])];

  const [catalogRows, programCounts] = allCatalogIds.length === 0
    ? [[], []] as const
    : await Promise.all([
        db
          .select({ id: universitiesTable.id })
          .from(universitiesTable)
          .where(inArray(universitiesTable.id, allCatalogIds)),
        db
          .select({
            universityId: programsTable.universityId,
            total: count(programsTable.id),
          })
          .from(programsTable)
          .where(and(
            inArray(programsTable.universityId, allCatalogIds),
            eq(programsTable.isActive, true),
          ))
          .groupBy(programsTable.universityId),
      ]);

  const catalogIds = new Set(catalogRows.map((row) => row.id));
  const programCountByCatalogId = new Map(
    programCounts.map((row) => [row.universityId, Number(row.total) || 0]),
  );
  const membersByPortal = new Map<string, Set<number>>();
  for (const membership of memberships) {
    const current = membersByPortal.get(membership.portalKey) ?? new Set<number>();
    current.add(membership.catalogUniversityId);
    membersByPortal.set(membership.portalKey, current);
  }

  const projected = partners.map((row): PortalPartnerOnboardingRow => {
    const adapter = adapters.get(row.adapterKey) ?? null;
    const portalUrl = safePortalHttpsUrl(adapter?.portalUrl);
    const memberIds = membersByPortal.get(row.universityKey) ?? new Set<number>();
    const directCatalogLinked = row.crmUniversityId != null && catalogIds.has(row.crmUniversityId);
    const catalogLinked = row.isMultiPortal ? memberIds.size > 0 : directCatalogLinked;
    const activeProgramCount = row.isMultiPortal
      ? [...memberIds].reduce(
          (total, catalogId) => total + (programCountByCatalogId.get(catalogId) ?? 0),
          0,
        )
      : row.crmUniversityId == null
        ? 0
        : (programCountByCatalogId.get(row.crmUniversityId) ?? 0);
    const targetCount = row.isMultiPortal ? memberIds.size : (catalogLinked ? 1 : 0);
    const verification = verificationByPartner.get(row.id);
    const hasCredentials = verification?.encryptedCredentialsReady ?? false;
    const graduationRequired = isExperimentalAdapterKey(row.adapterKey);
    const successCount = graduationRequired
      ? (successCounts.get(row.adapterKey) ?? 0)
      : 0;
    const readiness = computePortalPartnerReadiness({
      adapterRegistered: adapter !== null,
      portalUrl,
      hasCredentials,
      catalogLinked,
      activeProgramCount,
      graduationRequired,
      successCount,
      graduationThreshold: GRADUATION_THRESHOLD,
      runtimeIdentityReady: verification?.runtimeIdentityReady ?? false,
      testLoginPassed: verification?.testLoginPassed ?? false,
      strictDryRunCapable: verification?.binding?.strictDryRunCapable ?? false,
      strictDryRunPassed: verification?.strictDryRunPassed ?? false,
      isActive: row.isActive,
      autoProcess: row.autoProcess,
    });

    return {
      id: row.id,
      universityKey: row.universityKey,
      universityName: row.universityName,
      adapterKey: row.adapterKey,
      adapterRegistered: adapter !== null,
      portalUrl,
      hasCredentials,
      catalogLinked,
      activeProgramCount,
      targetCount,
      isMultiPortal: row.isMultiPortal,
      isActive: row.isActive,
      autoProcess: row.autoProcess,
      fanOutMode: row.fanOutMode,
      verificationGeneration: row.verificationGeneration,
      runtimeReleaseId: verification?.binding?.runtimeReleaseId ?? null,
      adapterSpecVersion: verification?.binding?.adapterSpecVersion ?? null,
      adapterSpecSha256: verification?.binding?.adapterSpecSha256 ?? null,
      testLoginPassed: verification?.testLoginPassed ?? false,
      testLoginVerifiedAt: verification?.testLoginVerifiedAt?.toISOString() ?? null,
      strictDryRunCapable: verification?.binding?.strictDryRunCapable ?? false,
      strictDryRunPassed: verification?.strictDryRunPassed ?? false,
      strictDryRunVerifiedAt: verification?.strictDryRunVerifiedAt?.toISOString() ?? null,
      graduationRequired,
      successCount,
      graduationThreshold: GRADUATION_THRESHOLD,
      graduated: graduationRequired && readiness.successProofsRemaining === 0,
      readiness,
    };
  });

  const settings = settingsRows[0];
  const globalBlockers: string[] = [];
  if (settings?.isEnabled) globalBlockers.push("GLOBAL_AUTOMATION_ENABLED");
  if (settings?.mode === "real") globalBlockers.push("LIVE_MODE_SELECTED");
  if (settings?.autoProcessEnabled) globalBlockers.push("SCHEDULER_ENABLED");
  if (settings?.fallbackEnabled) globalBlockers.push("FALLBACK_ENABLED");
  if (settings?.fanOutMode && settings.fanOutMode !== "off") {
    globalBlockers.push("FAN_OUT_ENABLED");
  }

  return {
    generatedAt: new Date().toISOString(),
    globalSafety: {
      pilotSafeDefaults: globalBlockers.length === 0,
      blockers: globalBlockers,
      isEnabled: settings?.isEnabled ?? false,
      mode: settings?.mode === "real" ? "real" : "dry",
      autoProcessEnabled: settings?.autoProcessEnabled ?? false,
      fallbackEnabled: settings?.fallbackEnabled ?? false,
      fanOutMode: settings?.fanOutMode ?? "off",
    },
    summary: {
      total: projected.length,
      configurationReady: projected.filter((row) => row.readiness.configurationReady).length,
      blocked: projected.filter((row) => !row.readiness.configurationReady).length,
      manualPilot: projected.filter((row) => row.readiness.phase === "manual_pilot").length,
      automaticEligible: projected.filter((row) => row.readiness.automaticEligible).length,
      automated: projected.filter((row) => row.readiness.phase === "automated").length,
    },
    partners: projected,
  };
}
