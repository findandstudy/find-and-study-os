import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import {
  OperationsWorkQueryError,
  decodeOperationsWorkCursor,
  encodeOperationsWorkCursor,
  parseOperationsWorkQuery,
  readOperationsWorkPage,
  type OperationsWorkQuery,
} from "../src/lib/operationsWorkReadModel";

const NOW = new Date("2026-09-05T12:00:00.000Z");

test("query parsing is bounded and rejects unknown filters", () => {
  assert.deepEqual(parseOperationsWorkQuery({}), {
    limit: 50,
    search: null,
    severity: null,
    source: null,
    scope: "all",
    cursor: null,
  });
  assert.deepEqual(
    parseOperationsWorkQuery({
      limit: "25",
      search: "  missing offer  ",
      severity: "critical",
      source: "portal",
      scope: "mine",
    }),
    {
      limit: 25,
      search: "missing offer",
      severity: "critical",
      source: "portal",
      scope: "mine",
      cursor: null,
    },
  );
  assert.throws(
    () => parseOperationsWorkQuery({ limit: "101" }),
    OperationsWorkQueryError,
  );
  assert.throws(
    () => parseOperationsWorkQuery({ source: "finance" }),
    OperationsWorkQueryError,
  );
});

test("cursor is bound to filters, bounded values and a one-hour snapshot", () => {
  const query = parseOperationsWorkQuery({
    severity: "high",
    scope: "mine",
  });
  const encoded = encodeOperationsWorkCursor(
    {
      asOf: NOW.toISOString(),
      score: 3_079_739_099,
      itemKey: "application:42:stale",
    },
    query,
  );
  assert.deepEqual(decodeOperationsWorkCursor(encoded, query, NOW), {
    asOf: NOW.toISOString(),
    score: 3_079_739_099,
    itemKey: "application:42:stale",
  });
  assert.throws(
    () =>
      decodeOperationsWorkCursor(
        encoded,
        parseOperationsWorkQuery({ severity: "critical", scope: "mine" }),
        NOW,
      ),
    /invalid or expired/,
  );
  assert.throws(
    () =>
      decodeOperationsWorkCursor(
        encoded,
        query,
        new Date(NOW.getTime() + 60 * 60_000 + 1),
      ),
    /invalid or expired/,
  );
});

test("read model uses parameterized scope and emits a stable next cursor", async () => {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const fakeClient = {
    async query(text: string, values: unknown[]) {
      calls.push({ text, values });
      if (calls.length === 1) {
        return {
          rows: [
            {
              total: 8,
              filteredTotal: 3,
              critical: 2,
              high: 3,
              medium: 2,
              low: 1,
              mine: 4,
              tasks: 2,
              applications: 2,
              documents: 1,
              portal: 2,
              offers: 1,
            },
          ],
        };
      }
      return {
        rows: [
          {
            itemKey: "portal:9:suspended",
            source: "portal",
            severity: "critical",
            reasonCode: "PORTAL_STATUS_SUSPENDED",
            identity: "Student — University",
            state: "suspended",
            nextAction: "Inspect",
            owner: "Operations queue",
            dueAt: null,
            blocker: "portal_drift",
            lastActivityAt: NOW.toISOString(),
            href: "/admin/portal-automation",
            applicationId: 7,
            isMine: false,
            score: "4079739099",
          },
          {
            itemKey: "application:7:deadline-soon",
            source: "application",
            severity: "critical",
            reasonCode: "APPLICATION_DEADLINE_SOON",
            identity: "Student — University",
            state: "submitted",
            nextAction: "Confirm readiness",
            owner: "User #4",
            dueAt: "2026-09-06",
            blocker: "Deadline is near",
            lastActivityAt: NOW.toISOString(),
            href: "/staff/applications/7",
            applicationId: 7,
            isMine: true,
            score: "4079739094",
          },
          {
            itemKey: "application:8:deadline-soon",
            source: "application",
            severity: "critical",
            reasonCode: "APPLICATION_DEADLINE_SOON",
            identity: "Another student",
            state: "submitted",
            nextAction: "Confirm readiness",
            owner: "User #4",
            dueAt: "2026-09-07",
            blocker: "Deadline is near",
            lastActivityAt: NOW.toISOString(),
            href: "/staff/applications/8",
            applicationId: 8,
            isMine: true,
            score: "4079739093",
          },
        ],
      };
    },
  } as unknown as PoolClient;

  const query: OperationsWorkQuery = {
    limit: 2,
    search: "student",
    severity: null,
    source: null,
    scope: "all",
    cursor: null,
  };
  const page = await readOperationsWorkPage(
    fakeClient,
    {
      actorUserId: 4,
      actorRole: "manager",
      visibleBranchIds: [2, 3],
    },
    query,
    NOW,
  );

  assert.equal(page.items.length, 2);
  assert.equal(page.meta.total, 3);
  assert.equal(page.meta.hasMore, true);
  assert.ok(page.meta.nextCursor);
  assert.equal(page.summary.total, 8);
  assert.deepEqual(calls[0]?.values.slice(0, 4), [
    4,
    "manager",
    [2, 3],
    NOW.toISOString(),
  ]);
  assert.equal(calls[1]?.values[8], null);
  assert.equal(calls[1]?.values[10], 3);

  const decoded = decodeOperationsWorkCursor(
    page.meta.nextCursor!,
    { ...query, cursor: page.meta.nextCursor },
    NOW,
  );
  assert.equal(decoded.itemKey, "application:7:deadline-soon");
  assert.equal(decoded.score, 4_079_739_094);
});
