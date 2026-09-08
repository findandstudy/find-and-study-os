import assert from "node:assert/strict";
import {
  applicationsTable,
  db,
  portalAdapterSpecsTable,
  portalCredentialsTable,
  portalSubmissionsTable,
  studentsTable,
} from "@workspace/db";
import {
  loadPortalPartnerVerificationBinding,
  recordPortalPartnerVerificationReceipt,
} from "@workspace/portal-runner";

const TEST_RELEASE_ID = "portal-test-runtime-v1";

/**
 * Verification receipts are intentionally immutable. Tests that create them
 * therefore run only against the repository's disposable PostgreSQL target.
 */
export function assertDisposablePortalVerificationTarget(): void {
  const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
  if (
    process.env.ALLOW_DISPOSABLE_PORTAL_VERIFICATION_TEST !== "true" ||
    databaseUrl.hostname !== "127.0.0.1" ||
    databaseUrl.port !== "5433" ||
    databaseUrl.pathname !== "/fasos_apply_local"
  ) {
    throw new Error(
      "Portal verification fixtures require the explicit disposable 127.0.0.1:5433/fasos_apply_local target",
    );
  }
  process.env.RELEASE_ID = TEST_RELEASE_ID;
}

function strictFixtureSpec(adapterKey: string, universityName: string) {
  return {
    specVersion: 2 as const,
    meta: {
      key: adapterKey,
      name: `${universityName} verification fixture`,
      baseUrl: "https://portal.example.com",
      matches: [universityName.toLocaleLowerCase("en-US")],
      dryRunPolicy: "strict" as const,
    },
    auth: {
      loginUrl: "https://portal.example.com/login",
      loginSteps: [
        { action: "fill" as const, selector: "#username", value: "fixture" },
      ],
    },
    steps: [
      {
        action: "fill" as const,
        selector: "#first-name",
        valueFrom: "profile.firstName" as const,
        readback: {
          source: "value" as const,
          comparison: "trimmed" as const,
          rejectAriaInvalid: true,
        },
      },
    ],
    success: { successSelector: "[data-status='submitted']" },
  };
}

/**
 * Seed the same immutable evidence chain required in production:
 * enabled strict v2 spec + encrypted DB credential + Test Login + Strict Dry
 * Run receipts, all bound to the current partner generation and runtime.
 */
export async function seedVerifiedPortalPartnerFixture(input: {
  portalUniversityId: number;
  universityKey: string;
  universityName: string;
  adapterKey: string;
}): Promise<void> {
  assertDisposablePortalVerificationTarget();
  const fixtureKey = `${input.adapterKey}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  await db.insert(portalAdapterSpecsTable).values({
    key: input.adapterKey,
    name: `${input.universityName} verification fixture`,
    spec: strictFixtureSpec(input.adapterKey, input.universityName),
    version: 1,
    enabled: true,
    source: "uploaded",
  });
  await db.insert(portalCredentialsTable).values({
    organizationId: null,
    portalKey: input.adapterKey,
    label: `${input.universityName} verification fixture`,
    usernameEnc: `enc::v1::${fixtureKey}:user`,
    passwordEnc: `enc::v1::${fixtureKey}:password`,
    isActive: true,
  });

  await seedCurrentPortalPartnerReceipts(input);
}

/** Re-verify an existing current spec/credential binding after a mutation. */
export async function seedCurrentPortalPartnerReceipts(input: {
  portalUniversityId: number;
  universityKey: string;
  universityName: string;
  adapterKey: string;
}): Promise<void> {
  assertDisposablePortalVerificationTarget();
  const fixtureKey = `${input.adapterKey}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const binding = await loadPortalPartnerVerificationBinding(input.portalUniversityId);
  assert.ok(binding, "version-bound verification binding should resolve");
  assert.equal(binding.strictDryRunCapable, true, "fixture spec must be strict dry-run capable");

  await recordPortalPartnerVerificationReceipt({
    binding,
    verificationType: "TEST_LOGIN",
    outcome: "PASSED",
    requestKey: `test-login:${fixtureKey}`,
    performedBy: null,
    evidence: { fixture: true, authenticated: true },
  });

  // Strict Dry Run evidence must be tied to a concrete application/submission,
  // never to a free-floating button click or an arbitrary portal URL token.
  const [student] = await db
    .insert(studentsTable)
    .values({
      firstName: "Verification",
      lastName: "Fixture",
      email: `${fixtureKey}@test.local`,
    })
    .returning({ id: studentsTable.id });
  const [application] = await db
    .insert(applicationsTable)
    .values({
      studentId: student.id,
      universityName: input.universityName,
      stage: "inquiry",
    })
    .returning({ id: applicationsTable.id });
  const [submission] = await db
    .insert(portalSubmissionsTable)
    .values({
      applicationId: application.id,
      studentId: student.id,
      universityKey: input.universityKey,
      universityName: input.universityName,
      adapterKey: input.adapterKey,
      mode: "dry",
      status: "dry_run",
      attempts: 1,
      resultJson: { fixture: true, strictDryRun: true },
    })
    .returning({ id: portalSubmissionsTable.id });

  await recordPortalPartnerVerificationReceipt({
    binding,
    verificationType: "STRICT_DRY_RUN",
    outcome: "PASSED",
    requestKey: `strict-dry-run:${fixtureKey}`,
    performedBy: null,
    applicationId: application.id,
    portalSubmissionId: submission.id,
    evidence: { fixture: true, finalMutationBlocked: true },
  });
}
