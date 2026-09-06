import assert from "node:assert/strict";
import test, { after } from "node:test";
import { eq } from "drizzle-orm";
import {
  applicationsTable,
  db,
  pool,
  portalSubmissionsTable,
  studentsTable,
} from "@workspace/db";
import {
  acquirePortalStatusLaneLease,
  claimDuePortalStatusChecks,
  completePortalStatusCheck,
  failPortalStatusCheck,
} from "@workspace/portal-runner";

after(async () => {
  await pool.end();
});

test("lane advisory lease permits one distributed browser session at a time", async () => {
  const first = await acquirePortalStatusLaneLease({ laneKey: "adapter-a:portal-a" });
  assert.ok(first);
  try {
    const competing = await acquirePortalStatusLaneLease({ laneKey: "ADAPTER-A:PORTAL-A" });
    assert.equal(competing, null);
  } finally {
    await first.release();
  }

  const next = await acquirePortalStatusLaneLease({ laneKey: "adapter-a:portal-a" });
  assert.ok(next);
  await next.release();
  await next.release();
});

test("status claims are fair by lane, mutually exclusive and suspend poison rows", async () => {
  const [student] = await db
    .insert(studentsTable)
    .values({ firstName: "Status", lastName: "Queue Fixture" })
    .returning({ id: studentsTable.id });
  assert.ok(student);

  try {
    const applications = await db
      .insert(applicationsTable)
      .values(Array.from({ length: 6 }, () => ({
        studentId: student.id,
        stage: "submitted",
      })))
      .returning({ id: applicationsTable.id });
    assert.equal(applications.length, 6);

    await db.insert(portalSubmissionsTable).values(
      applications.map((application, index) => ({
        applicationId: application.id,
        studentId: student.id,
        universityKey: index < 3 ? "portal-a" : "portal-b",
        universityName: index < 3 ? "Portal A" : "Portal B",
        adapterKey: index < 3 ? "adapter-a" : "adapter-b",
        externalRef: `ref-${index}`,
        status: "submitted" as const,
        statusCheckNextAt: new Date("2026-09-04T00:00:00.000Z"),
      })),
    );

    const first = await claimDuePortalStatusChecks({
      workerId: "status-worker-one",
      maxLanes: 2,
      rowsPerLane: 1,
    });
    assert.equal(first.length, 2);
    assert.equal(new Set(first.map((row) => row.laneKey)).size, 2);

    const second = await claimDuePortalStatusChecks({
      workerId: "status-worker-two",
      maxLanes: 2,
      rowsPerLane: 1,
    });
    assert.equal(second.length, 2);
    assert.equal(new Set(second.map((row) => row.laneKey)).size, 2);
    assert.equal(
      second.some((row) => first.some((claimed) => claimed.id === row.id)),
      false,
    );

    assert.equal(
      await completePortalStatusCheck({
        submissionId: first[0]!.id,
        workerId: "status-worker-one",
        nextCheckAt: new Date("2099-09-05T00:00:00.000Z"),
      }),
      true,
    );
    const retry = await failPortalStatusCheck({
      submissionId: first[1]!.id,
      workerId: "status-worker-one",
      currentFailedAttempts: 0,
      error: "temporary portal error",
      now: new Date("2099-09-04T12:00:00.000Z"),
    });
    assert.equal(retry.updated, true);
    assert.equal(retry.suspended, false);
    assert.equal(retry.errorCode, "STATUS_CHECK_FAILED");

    await db
      .update(portalSubmissionsTable)
      .set({ statusCheckAttempts: 7 })
      .where(eq(portalSubmissionsTable.id, second[0]!.id));
    const poison = await failPortalStatusCheck({
      submissionId: second[0]!.id,
      workerId: "status-worker-two",
      currentFailedAttempts: 7,
      error: "repeated adapter drift",
      now: new Date("2026-09-04T12:00:00.000Z"),
    });
    assert.equal(poison.updated, true);
    assert.equal(poison.suspended, true);
    assert.equal(poison.errorCode, "STATUS_CHECK_PORTAL_DRIFT");
    const [poisonRow] = await db
      .select({ error: portalSubmissionsTable.statusCheckError })
      .from(portalSubmissionsTable)
      .where(eq(portalSubmissionsTable.id, second[0]!.id));
    assert.equal(poisonRow?.error, "STATUS_CHECK_PORTAL_DRIFT");
    assert.equal(
      await completePortalStatusCheck({
        submissionId: second[1]!.id,
        workerId: "status-worker-two",
        nextCheckAt: new Date("2099-09-05T00:00:00.000Z"),
      }),
      true,
    );

    const remaining = await claimDuePortalStatusChecks({
      workerId: "status-worker-three",
      maxLanes: 2,
      rowsPerLane: 10,
    });
    assert.equal(remaining.length, 2);
    assert.equal(remaining.some((row) => row.id === second[0]!.id), false);
    await Promise.all(
      remaining.map((row) =>
        completePortalStatusCheck({
          submissionId: row.id,
          workerId: "status-worker-three",
          nextCheckAt: new Date("2099-09-05T00:00:00.000Z"),
        }),
      ),
    );
  } finally {
    await db.delete(studentsTable).where(eq(studentsTable.id, student.id));
  }
});
