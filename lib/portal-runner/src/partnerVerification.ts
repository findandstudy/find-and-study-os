import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  db,
  portalAdapterSpecsTable,
  portalAdaptersTable,
  portalCredentialsTable,
  portalPartnerVerificationReceiptsTable,
  portalUniversitiesTable,
} from "@workspace/db";
import {
  adapterByKey,
  parseAdapterSpec,
  specRowAllowsOverride,
} from "@workspace/portal-adapters";

export type PortalPartnerVerificationType = "TEST_LOGIN" | "STRICT_DRY_RUN";
export type PortalPartnerVerificationOutcome = "PASSED" | "FAILED";

export class PortalVerificationIdempotencyConflictError extends Error {
  constructor() {
    super("Portal verification request key was already used for different evidence");
    this.name = "PortalVerificationIdempotencyConflictError";
  }
}

export interface PortalPartnerVerificationBinding {
  portalUniversityId: number;
  universityKey: string;
  adapterKey: string;
  verificationGeneration: number;
  runtimeReleaseId: string;
  credentialId: number;
  credentialUpdatedAt: Date;
  adapterSpecId: number | null;
  adapterSpecVersion: number | null;
  adapterSpecSha256: string | null;
  strictDryRunCapable: boolean;
  bindingSha256: string;
}

export interface PortalPartnerVerificationState {
  binding: PortalPartnerVerificationBinding | null;
  runtimeIdentityReady: boolean;
  encryptedCredentialsReady: boolean;
  testLoginPassed: boolean;
  strictDryRunPassed: boolean;
  testLoginVerifiedAt: Date | null;
  strictDryRunVerifiedAt: Date | null;
}

export function latestPortalPartnerReceiptPassed(
  receiptsNewestFirst: readonly {
    verificationType: string;
    outcome: string;
  }[],
  verificationType: PortalPartnerVerificationType,
): boolean {
  return receiptsNewestFirst.find(
    (receipt) => receipt.verificationType === verificationType,
  )?.outcome === "PASSED";
}

type PartnerCandidate = {
  id: number;
  universityKey: string;
  adapterKey: string;
  verificationGeneration: number;
};

const RELEASE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,80}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableValue(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableValue(nested)}`)
    .join(",")}}`;
}

export function currentPortalRuntimeReleaseId(): string | null {
  const value = process.env.RELEASE_ID?.trim() ?? "";
  return RELEASE_ID_PATTERN.test(value) ? value : null;
}

function specSha256(spec: unknown): string {
  return sha256(stableValue(spec));
}

function buildBindingHash(input: Omit<PortalPartnerVerificationBinding, "bindingSha256" | "strictDryRunCapable">): string {
  return sha256(stableValue({
    portalUniversityId: input.portalUniversityId,
    universityKey: input.universityKey,
    adapterKey: input.adapterKey,
    verificationGeneration: input.verificationGeneration,
    runtimeReleaseId: input.runtimeReleaseId,
    credentialId: input.credentialId,
    credentialUpdatedAt: input.credentialUpdatedAt.toISOString(),
    adapterSpecId: input.adapterSpecId,
    adapterSpecVersion: input.adapterSpecVersion,
    adapterSpecSha256: input.adapterSpecSha256,
  }));
}

function isStrictEffectiveSpec(input: {
  adapterKey: string;
  spec: typeof portalAdapterSpecsTable.$inferSelect | undefined;
  hasLegacyDbAdapter: boolean;
}): boolean {
  if (!input.spec) return false;
  const parsed = parseAdapterSpec(input.spec.spec);
  if (!parsed.ok || parsed.spec.specVersion !== 2) return false;
  if ((parsed.spec.meta.dryRunPolicy ?? "strict") !== "strict") return false;

  const shadowed = adapterByKey(input.adapterKey) !== null || input.hasLegacyDbAdapter;
  if (!shadowed) return true;
  return specRowAllowsOverride(input.spec);
}

async function loadBindings(
  partners: readonly PartnerCandidate[],
): Promise<Map<number, PortalPartnerVerificationBinding>> {
  const releaseId = currentPortalRuntimeReleaseId();
  if (!releaseId || partners.length === 0) return new Map();

  const adapterKeys = [...new Set(partners.map((partner) => partner.adapterKey))];
  const credentialKeys = [
    ...new Set(partners.flatMap((partner) => [partner.adapterKey, partner.universityKey])),
  ];
  const [specRows, credentialRows, legacyAdapterRows] = await Promise.all([
    db
      .select()
      .from(portalAdapterSpecsTable)
      .where(and(
        inArray(portalAdapterSpecsTable.key, adapterKeys),
        eq(portalAdapterSpecsTable.enabled, true),
      )),
    db
      .select({
        id: portalCredentialsTable.id,
        portalKey: portalCredentialsTable.portalKey,
        updatedAt: portalCredentialsTable.updatedAt,
      })
      .from(portalCredentialsTable)
      .where(and(
        inArray(portalCredentialsTable.portalKey, credentialKeys),
        isNull(portalCredentialsTable.organizationId),
        eq(portalCredentialsTable.isActive, true),
        isNull(portalCredentialsTable.deletedAt),
      ))
      .orderBy(desc(portalCredentialsTable.updatedAt), desc(portalCredentialsTable.id)),
    db
      .select({ key: portalAdaptersTable.key })
      .from(portalAdaptersTable)
      .where(and(
        inArray(portalAdaptersTable.key, adapterKeys),
        eq(portalAdaptersTable.isActive, true),
        isNull(portalAdaptersTable.deletedAt),
      )),
  ]);

  const specByKey = new Map(specRows.map((row) => [row.key, row]));
  const legacyAdapterKeys = new Set(legacyAdapterRows.map((row) => row.key));
  const credentialByKey = new Map<string, (typeof credentialRows)[number]>();
  for (const row of credentialRows) {
    if (!credentialByKey.has(row.portalKey)) credentialByKey.set(row.portalKey, row);
  }

  const result = new Map<number, PortalPartnerVerificationBinding>();
  for (const partner of partners) {
    const credential =
      credentialByKey.get(partner.adapterKey) ??
      credentialByKey.get(partner.universityKey);
    if (!credential) continue;

    const spec = specByKey.get(partner.adapterKey);
    const base = {
      portalUniversityId: partner.id,
      universityKey: partner.universityKey,
      adapterKey: partner.adapterKey,
      verificationGeneration: partner.verificationGeneration,
      runtimeReleaseId: releaseId,
      credentialId: credential.id,
      credentialUpdatedAt: credential.updatedAt,
      adapterSpecId: spec?.id ?? null,
      adapterSpecVersion: spec?.version ?? null,
      adapterSpecSha256: spec ? specSha256(spec.spec) : null,
    };
    result.set(partner.id, {
      ...base,
      strictDryRunCapable: isStrictEffectiveSpec({
        adapterKey: partner.adapterKey,
        spec,
        hasLegacyDbAdapter: legacyAdapterKeys.has(partner.adapterKey),
      }),
      bindingSha256: buildBindingHash(base),
    });
  }

  return result;
}

export async function loadPortalPartnerVerificationStates(
  partners: readonly PartnerCandidate[],
): Promise<Map<number, PortalPartnerVerificationState>> {
  const bindings = await loadBindings(partners);
  const ids = partners.map((partner) => partner.id);
  const receipts = ids.length === 0
    ? []
    : await db
        .select()
        .from(portalPartnerVerificationReceiptsTable)
        .where(
          inArray(portalPartnerVerificationReceiptsTable.portalUniversityId, ids),
        )
        .orderBy(
          desc(portalPartnerVerificationReceiptsTable.createdAt),
          desc(portalPartnerVerificationReceiptsTable.id),
        );

  const state = new Map<number, PortalPartnerVerificationState>();
  for (const partner of partners) {
    const binding = bindings.get(partner.id) ?? null;
    const current = binding
      ? receipts.filter(
          (receipt) =>
            receipt.portalUniversityId === partner.id &&
            receipt.verificationGeneration === binding.verificationGeneration &&
            receipt.runtimeReleaseId === binding.runtimeReleaseId &&
            receipt.bindingSha256 === binding.bindingSha256,
        )
      : [];
    // Latest current-binding outcome wins. A failed re-check must immediately
    // revoke an older pass instead of leaving automation unlocked.
    const testLogin = current.find((receipt) => receipt.verificationType === "TEST_LOGIN") ?? null;
    const strictDryRun = current.find((receipt) => receipt.verificationType === "STRICT_DRY_RUN") ?? null;
    state.set(partner.id, {
      binding,
      runtimeIdentityReady: currentPortalRuntimeReleaseId() !== null,
      encryptedCredentialsReady: binding !== null,
      testLoginPassed: latestPortalPartnerReceiptPassed(current, "TEST_LOGIN"),
      strictDryRunPassed: latestPortalPartnerReceiptPassed(current, "STRICT_DRY_RUN"),
      testLoginVerifiedAt: testLogin?.createdAt ?? null,
      strictDryRunVerifiedAt: strictDryRun?.createdAt ?? null,
    });
  }
  return state;
}

export async function loadPortalPartnerVerificationBinding(
  portalUniversityId: number,
): Promise<PortalPartnerVerificationBinding | null> {
  const [partner] = await db
    .select({
      id: portalUniversitiesTable.id,
      universityKey: portalUniversitiesTable.universityKey,
      adapterKey: portalUniversitiesTable.adapterKey,
      verificationGeneration: portalUniversitiesTable.verificationGeneration,
    })
    .from(portalUniversitiesTable)
    .where(and(
      eq(portalUniversitiesTable.id, portalUniversityId),
      isNull(portalUniversitiesTable.deletedAt),
    ))
    .limit(1);
  if (!partner) return null;
  return (await loadBindings([partner])).get(partner.id) ?? null;
}

export function samePortalPartnerVerificationBinding(
  left: PortalPartnerVerificationBinding | null,
  right: PortalPartnerVerificationBinding | null,
): boolean {
  return left !== null && right !== null && left.bindingSha256 === right.bindingSha256;
}

export async function recordPortalPartnerVerificationReceipt(input: {
  binding: PortalPartnerVerificationBinding;
  verificationType: PortalPartnerVerificationType;
  outcome: PortalPartnerVerificationOutcome;
  requestKey: string;
  performedBy: number | null;
  failureCode?: string;
  applicationId?: number;
  portalSubmissionId?: number;
  evidence?: Record<string, unknown>;
}): Promise<void> {
  const evidence = input.evidence ?? {};
  const evidenceSha256 = sha256(stableValue({
    bindingSha256: input.binding.bindingSha256,
    verificationType: input.verificationType,
    outcome: input.outcome,
    requestKey: input.requestKey,
    failureCode: input.failureCode ?? null,
    applicationId: input.applicationId ?? null,
    portalSubmissionId: input.portalSubmissionId ?? null,
    performedBy: input.performedBy,
    evidence,
  }));
  if (!HASH_PATTERN.test(evidenceSha256)) throw new Error("Invalid verification evidence hash");

  const inserted = await db
    .insert(portalPartnerVerificationReceiptsTable)
    .values({
      portalUniversityId: input.binding.portalUniversityId,
      verificationGeneration: input.binding.verificationGeneration,
      verificationType: input.verificationType,
      outcome: input.outcome,
      adapterKey: input.binding.adapterKey,
      adapterSpecId: input.binding.adapterSpecId,
      adapterSpecVersion: input.binding.adapterSpecVersion,
      adapterSpecSha256: input.binding.adapterSpecSha256,
      credentialId: input.binding.credentialId,
      credentialUpdatedAt: input.binding.credentialUpdatedAt,
      runtimeReleaseId: input.binding.runtimeReleaseId,
      bindingSha256: input.binding.bindingSha256,
      evidenceSha256,
      requestKey: input.requestKey,
      applicationId: input.applicationId,
      portalSubmissionId: input.portalSubmissionId,
      performedBy: input.performedBy,
      failureCode: input.outcome === "FAILED" ? input.failureCode : undefined,
      evidence,
    })
    .onConflictDoNothing()
    .returning({ id: portalPartnerVerificationReceiptsTable.id });
  if (inserted.length > 0) return;

  // The request key is an idempotency boundary, not a last-write-wins key.
  // Exact replay is safe; reusing it for another result or evidence bundle is
  // an explicit conflict so a failed check can never be hidden by an old pass.
  const [existing] = await db
    .select({
      bindingSha256: portalPartnerVerificationReceiptsTable.bindingSha256,
      evidenceSha256: portalPartnerVerificationReceiptsTable.evidenceSha256,
    })
    .from(portalPartnerVerificationReceiptsTable)
    .where(and(
      eq(
        portalPartnerVerificationReceiptsTable.portalUniversityId,
        input.binding.portalUniversityId,
      ),
      eq(
        portalPartnerVerificationReceiptsTable.verificationGeneration,
        input.binding.verificationGeneration,
      ),
      eq(
        portalPartnerVerificationReceiptsTable.verificationType,
        input.verificationType,
      ),
      eq(portalPartnerVerificationReceiptsTable.requestKey, input.requestKey),
    ))
    .limit(1);
  if (
    !existing ||
    existing.bindingSha256 !== input.binding.bindingSha256 ||
    existing.evidenceSha256 !== evidenceSha256
  ) {
    throw new PortalVerificationIdempotencyConflictError();
  }
}

export async function getPortalExecutionVerification(input: {
  universityKey: string;
  adapterKey?: string | null;
}): Promise<PortalPartnerVerificationState | null> {
  const [partner] = await db
    .select({
      id: portalUniversitiesTable.id,
      universityKey: portalUniversitiesTable.universityKey,
      adapterKey: portalUniversitiesTable.adapterKey,
      verificationGeneration: portalUniversitiesTable.verificationGeneration,
    })
    .from(portalUniversitiesTable)
    .where(and(
      eq(portalUniversitiesTable.universityKey, input.universityKey),
      isNull(portalUniversitiesTable.deletedAt),
    ))
    .limit(1);
  if (!partner || (input.adapterKey && partner.adapterKey !== input.adapterKey)) return null;
  return (await loadPortalPartnerVerificationStates([partner])).get(partner.id) ?? null;
}
