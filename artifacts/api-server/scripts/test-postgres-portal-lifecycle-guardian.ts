import assert from "node:assert/strict";
import test, { after } from "node:test";
import { count, eq } from "drizzle-orm";
import {
  aiPersonasTable,
  applicationsTable,
  db,
  pool,
  portalSubmissionsTable,
  portalLifecycleProposalsTable,
  studentsTable,
} from "@workspace/db";
import { queuePortalLifecycleReview } from "../src/lib/portalLifecycleGuardian";
import { PORTAL_GUARDIAN_SLUG } from "../src/lib/portalAiGuardian";
import { normalizePortalLifecycleObservation } from "../src/lib/portalLifecycleObservation";
import { recordPortalLifecycleObservation } from "../src/lib/portalLifecycleObservationStore";

after(async () => {
  await pool.end();
});

test("concurrent lifecycle proposals create one durable approval item", async () => {
  const [persona] = await db.insert(aiPersonasTable).values({
    name: "Portal Guardian Fixture",
    slug: PORTAL_GUARDIAN_SLUG,
    model: "fixture",
    isActive: true,
  }).returning({ id: aiPersonasTable.id });
  const [student] = await db.insert(studentsTable).values({
    firstName: "Guardian",
    lastName: "Fixture",
  }).returning({ id: studentsTable.id });

  try {
    const [application] = await db.insert(applicationsTable).values({
      studentId: student.id,
      stage: "submitted",
    }).returning({ id: applicationsTable.id });
    const [submission] = await db.insert(portalSubmissionsTable).values({
      applicationId: application.id,
      studentId: student.id,
      universityKey: "guardian-fixture",
      universityName: "Guardian Fixture",
      adapterKey: "guardian-fixture",
      externalRef: "guardian-ref",
      status: "submitted",
    }).returning({ id: portalSubmissionsTable.id });
    const observation = normalizePortalLifecycleObservation({
      submissionId: submission.id,
      applicationId: application.id,
      adapterKey: "guardian-fixture",
      result: { status: "Missing Documents" },
    });
    const recorded = await recordPortalLifecycleObservation(observation);
    const calls = Array.from({ length: 8 }, () =>
      queuePortalLifecycleReview({
        submissionId: submission.id,
        applicationId: application.id,
        rawStatus: observation.rawStatus,
        observationId: recorded.id,
        observationHash: observation.observationHash,
        identityVerified: observation.identityVerified,
        missingDocuments: observation.missingDocuments,
        applicationReferenceSync: "invalid",
      }),
    );
    const results = await Promise.all(calls);
    assert.equal(results.filter((result) => result.queued).length, 1);
    assert.equal(new Set(results.map((result) => result.actionId)).size, 1);
    assert.ok(results.every((result) => result.decision?.action === "manual_review"));

    const [stored] = await db
      .select({ value: count() })
      .from(portalLifecycleProposalsTable)
      .where(
        eq(portalLifecycleProposalsTable.status, "pending_review"),
      );
    assert.equal(stored?.value, 1);
  } finally {
    await db.delete(aiPersonasTable).where(eq(aiPersonasTable.id, persona.id));
    await db.delete(studentsTable).where(eq(studentsTable.id, student.id));
  }
});
