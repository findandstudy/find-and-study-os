import test from "node:test";
import assert from "node:assert/strict";
import { buildOperationsQueue } from "../src/lib/operationsQueue";

const NOW = new Date("2026-09-05T12:00:00.000Z");

test("critical exceptions sort before stale informational work", () => {
  const rows = buildOperationsQueue({
    currentUserId: 9,
    applications: [{ id: 2, stage: "submitted", assignedToId: 9, updatedAt: "2026-08-20T12:00:00.000Z" }],
    tasks: [{ id: 1, title: "Call student", status: "todo", dueDate: "2026-09-01", assignedTo: 9 }],
    documents: [],
  }, NOW);
  assert.equal(rows[0]?.reasonCode, "TASK_OVERDUE");
  assert.equal(rows.some((row) => row.reasonCode === "APPLICATION_STALE"), true);
  assert.equal(rows.every((row) => row.isMine), true);
});

test("terminal applications never produce deadline, owner, or stale exceptions", () => {
  const rows = buildOperationsQueue({
    applications: [{ id: 4, stage: "won", assignedToId: null, deadline: "2026-08-01", updatedAt: "2026-01-01" }],
    tasks: [],
    documents: [],
    terminalStageKeys: ["won"],
  }, NOW);
  assert.deepEqual(rows, []);
});

test("unverified portal observations are deduplicated per submission", () => {
  const rows = buildOperationsQueue({
    applications: [{ id: 7, stage: "submitted" }], tasks: [], documents: [],
    portal: { recentObservations: [
      { id: 2, submissionId: 70, applicationId: 7, universityKey: "demo", disposition: "UNDER_REVIEW", identityVerified: false, observedAt: "2026-09-05T11:00:00Z" },
      { id: 1, submissionId: 70, applicationId: 7, universityKey: "demo", disposition: "UNDER_REVIEW", identityVerified: false, observedAt: "2026-09-05T10:00:00Z" },
    ] },
  }, NOW);
  assert.equal(rows.filter((row) => row.reasonCode === "PORTAL_IDENTITY_UNVERIFIED").length, 1);
});

test("document and offer evidence create explicit next actions", () => {
  const rows = buildOperationsQueue({
    applications: [{ id: 8, stage: "offer_received", assignedToId: 3 }], tasks: [],
    documents: [{ id: 11, applicationId: 8, status: "rejected", name: "Passport" }],
    offerDeadlines: [{ docId: 12, applicationId: 8, daysLeft: 5, validUntil: "2026-09-10", universityName: "Example U" }],
  }, NOW);
  assert.equal(rows.some((row) => row.reasonCode === "DOCUMENT_REJECTED"), true);
  assert.equal(rows.some((row) => row.reasonCode === "OFFER_EXPIRING"), true);
});
