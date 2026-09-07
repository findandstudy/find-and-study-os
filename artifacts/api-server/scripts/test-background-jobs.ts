import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  BackgroundJobCoordinator,
  backgroundJobsEnabled,
  type BackgroundJobDefinition,
} from "../src/lib/backgroundJobs.js";

class FakeAdvisoryDatabase {
  owner: symbol | null = null;
  pool() {
    const id = Symbol("client");
    const thisDb = this;
    return {
      async connect() {
        return {
          async query<T>(sql: string) {
            if (sql.includes("pg_try_advisory_lock")) {
              const locked = thisDb.owner === null;
              if (locked) thisDb.owner = id;
              return { rows: [{ locked }] as T[] };
            }
            if (sql.includes("pg_advisory_unlock") && thisDb.owner === id)
              thisDb.owner = null;
            return { rows: [] as T[] };
          },
          release() {},
        };
      },
    };
  }
}

function fakeTimers() {
  const pending = new Set<{
    callback: () => void;
    cleared: boolean;
    unref(): void;
  }>();
  const schedule = ((callback: () => void) => {
    const timer = { callback, cleared: false, unref() {} };
    pending.add(timer);
    return timer;
  }) as unknown as typeof setTimeout;
  const cancel = ((timer: { cleared: boolean }) => {
    timer.cleared = true;
  }) as unknown as typeof clearTimeout;
  return { pending, schedule, cancel };
}

test("missing or invalid production config is disabled; development remains compatible", () => {
  assert.equal(backgroundJobsEnabled(undefined, "production"), false);
  assert.equal(backgroundJobsEnabled(undefined, "staging"), false);
  assert.equal(backgroundJobsEnabled("invalid", "production"), false);
  assert.equal(backgroundJobsEnabled("false", "development"), false);
  assert.equal(backgroundJobsEnabled("true", "production"), true);
  assert.equal(backgroundJobsEnabled(undefined, "development"), true);
});

test("disabled coordinator does not connect and HTTP boot may continue", async () => {
  let connects = 0;
  const coordinator = new BackgroundJobCoordinator(
    {
      async connect() {
        connects += 1;
        throw new Error("must not connect");
      },
    },
    [],
  );
  assert.equal(await coordinator.start(false), false);
  assert.equal(connects, 0);
});

test("only one scheduler set owns the advisory lock and ownership transfers after shutdown", async () => {
  const database = new FakeAdvisoryDatabase();
  let starts = 0;
  let stops = 0;
  const jobs: BackgroundJobDefinition[] = [
    {
      name: "fixture",
      offsetMs: 1,
      start: () => {
        starts += 1;
        return () => {
          stops += 1;
        };
      },
    },
  ];
  const timersA = fakeTimers();
  const timersB = fakeTimers();
  const first = new BackgroundJobCoordinator(
    database.pool(),
    jobs,
    timersA.schedule,
    timersA.cancel,
  );
  const second = new BackgroundJobCoordinator(
    database.pool(),
    jobs,
    timersB.schedule,
    timersB.cancel,
  );

  assert.equal(await first.start(true), true);
  assert.equal(await second.start(true), false);
  assert.equal(timersA.pending.size, 1);
  for (const timer of timersA.pending) timer.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts, 1);

  await first.shutdown();
  assert.equal(stops, 1);
  assert.equal(await second.start(true), true);
  await second.shutdown();
});

test("shutdown clears pending starts before releasing the lock", async () => {
  const database = new FakeAdvisoryDatabase();
  const timers = fakeTimers();
  let starts = 0;
  const coordinator = new BackgroundJobCoordinator(
    database.pool(),
    [
      {
        name: "pending",
        offsetMs: 100,
        start: () => {
          starts += 1;
        },
      },
    ],
    timers.schedule,
    timers.cancel,
  );
  await coordinator.start(true);
  await coordinator.shutdown();
  for (const timer of timers.pending) {
    assert.equal(timer.cleared, true);
    timer.callback();
  }
  assert.equal(starts, 0);
});

test("API boot does not start the dedicated portal automation worker or auto-drain", () => {
  const index = readFileSync(
    new URL("../src/index.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(index, /startPortalAutoDrain/);
  assert.doesNotMatch(index, /portal-automation-worker\/src\/worker/);
});

test("every API background registration returns a shutdown contract", () => {
  const index = readFileSync(
    new URL("../src/index.ts", import.meta.url),
    "utf8",
  );
  for (const starter of [
    "startEmailWorker",
    "startContractChecker",
    "startOfferExpiryChecker",
    "startUniversityContractChecker",
    "startCompanyContractChecker",
    "startSignedContractDeliveryWorker",
    "startAssignmentConsistencyChecker",
    "startFollowUpChecker",
    "startPortalUniversityLinker",
    "startStuckConversationSweep",
    "startQualityScoringWorker",
    "startPortalAiGuardianScanner",
    "startAcademyKnowledgeSync",
    "startMessageCampaignWorker",
    "startActivityStaleSessionCleanup",
  ]) {
    assert.match(index, new RegExp(`return ${starter}\\(\\)`), starter);
  }
});

test("dedicated portal worker drains an active claim and exits on fatal process errors", () => {
  const worker = readFileSync(
    new URL("../../portal-automation-worker/src/worker.ts", import.meta.url),
    "utf8",
  );
  assert.match(worker, /while \(!stopping\)/);
  assert.match(worker, /schedulerTick/);
  assert.match(worker, /activeJobs/);
  assert.match(worker, /Promise\.allSettled/);
  assert.match(worker, /SHUTDOWN_TIMEOUT_MS/);
  assert.match(worker, /pool\.end\(\)/);
  assert.match(worker, /beginShutdown\("uncaughtException", 1\)/);
  assert.doesNotMatch(worker, /contained — worker stays up/);
});

test("dedicated social workers heartbeat, contain transient ticks and close their pools", () => {
  for (const file of [
    "../src/workers/socialPublicationWorker.ts",
    "../src/workers/socialPerformanceWorker.ts",
    "../src/workers/socialCreativeWorker.ts",
    "../src/workers/socialAdvertisingWorker.ts",
  ]) {
    const worker = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(worker, /recordSocialWorkerHeartbeat/);
    assert.match(worker, /scheduleNextSocialWorkerHeartbeat/);
    assert.match(worker, /while \(!stopping\)/);
    assert.match(worker, /socialWorkerRetryDelayMs/);
    assert.match(worker, /socialWorkerFailureCode/);
    assert.match(worker, /await pool\.end\(\)/);
    assert.doesNotMatch(worker, /console\.error\([^\n]*error\)/);
    if (file.includes("Publication"))
      assert.match(worker, /verifyStoredSocialMediaRefs/);
    if (file.includes("Creative")) {
      assert.match(worker, /materializeSocialCreativeResult/);
      assert.match(worker, /resolveSocialCreativeGate/);
    }
  }
});
