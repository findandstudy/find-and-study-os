import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import {
  applicationsTable,
  db,
  portalSubmissionsTable,
  type PortalUniversity,
} from "@workspace/db";

export type PortalSubmissionTargetIdentityV1 = {
  schemaVersion: 1;
  applicationId: number;
  catalogUniversityId: number | null;
  catalogProgramId: number | null;
  intake: string | null;
  season: string;
  partner: {
    portalUniversityId: number;
    universityKey: string;
    adapterKey: string;
    verificationGeneration: number;
  };
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
    .join(",")}}`;
}

export function createPortalSubmissionIntentFromSnapshot(input: {
  application: {
    id: number;
    universityId: number | null;
    programId: number | null;
    intake: string | null;
    season: string;
  };
  portalUniversity: Pick<
    PortalUniversity,
    "id" | "universityKey" | "adapterKey" | "verificationGeneration"
  >;
  targetCatalogUniversityId?: number | null;
  source: "manual" | "automatic" | "fanout" | "fallback";
  requestKey?: string;
}): {
  submitIntentKey: string;
  targetIdentitySha256: string;
  targetIdentity: PortalSubmissionTargetIdentityV1;
} {
  const application = input.application;
  const targetIdentity: PortalSubmissionTargetIdentityV1 = {
    schemaVersion: 1,
    applicationId: application.id,
    catalogUniversityId:
      input.targetCatalogUniversityId ?? application.universityId ?? null,
    catalogProgramId: application.programId ?? null,
    intake: application.intake?.trim() || null,
    season: application.season,
    partner: {
      portalUniversityId: input.portalUniversity.id,
      universityKey: input.portalUniversity.universityKey,
      adapterKey: input.portalUniversity.adapterKey,
      verificationGeneration: input.portalUniversity.verificationGeneration,
    },
  };
  const targetIdentitySha256 = createHash("sha256")
    .update(canonicalJson(targetIdentity), "utf8")
    .digest("hex");
  const commandKey = input.requestKey ?? randomUUID();
  const submitIntentKey = `${input.source}:${application.id}:${targetIdentitySha256.slice(0, 24)}:${commandKey}`;
  if (submitIntentKey.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(submitIntentKey)) {
    throw new Error("PORTAL_SUBMIT_INTENT_KEY_INVALID");
  }
  return { submitIntentKey, targetIdentitySha256, targetIdentity };
}

export async function buildPortalSubmissionIntent(input: {
  applicationId: number;
  portalUniversity: Pick<
    PortalUniversity,
    "id" | "universityKey" | "adapterKey" | "verificationGeneration"
  >;
  targetCatalogUniversityId?: number | null;
  source: "manual" | "automatic" | "fanout" | "fallback";
  requestKey?: string;
}): Promise<{
  submitIntentKey: string;
  targetIdentitySha256: string;
  targetIdentity: PortalSubmissionTargetIdentityV1;
}> {
  const [application] = await db
    .select({
      id: applicationsTable.id,
      universityId: applicationsTable.universityId,
      programId: applicationsTable.programId,
      intake: applicationsTable.intake,
      season: applicationsTable.season,
    })
    .from(applicationsTable)
    .where(and(
      eq(applicationsTable.id, input.applicationId),
      isNull(applicationsTable.deletedAt),
    ))
    .limit(1);
  if (!application) throw new Error("PORTAL_INTENT_APPLICATION_NOT_FOUND");
  return createPortalSubmissionIntentFromSnapshot({ ...input, application });
}

export async function findPortalSubmissionReconciliationConflict(input: {
  applicationId: number;
  targetIdentitySha256: string;
}): Promise<{ id: number; externalRef: string | null; status: string } | null> {
  const [existing] = await db
    .select({
      id: portalSubmissionsTable.id,
      externalRef: portalSubmissionsTable.externalRef,
      status: portalSubmissionsTable.status,
    })
    .from(portalSubmissionsTable)
    .where(and(
      eq(portalSubmissionsTable.applicationId, input.applicationId),
      eq(portalSubmissionsTable.targetIdentitySha256, input.targetIdentitySha256),
      eq(portalSubmissionsTable.mode, "real"),
      eq(portalSubmissionsTable.submissionAction, "submit"),
      isNull(portalSubmissionsTable.deletedAt),
      isNotNull(portalSubmissionsTable.providerCommittedAt),
    ))
    .limit(1);
  return existing ?? null;
}
