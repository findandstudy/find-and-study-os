/**
 * queue.ts — portal_submissions queue mechanics
 *
 * claimNext()    — atomically grabs the oldest queued submission using
 *                  FOR UPDATE SKIP LOCKED so concurrent workers never
 *                  double-process the same row.
 *                  Optional `universityKeys` param restricts to specific
 *                  universities (used by auto-drain to honour autoProcess flag).
 *                  Any status='queued' row is claimable regardless of
 *                  attempt count — if it's queued, it was explicitly
 *                  authorised for (re-)processing by admin/reset-stuck.
 *
 * claimById()    — atomically claims a specific submission by id (for
 *                  the manual "process now" endpoint). Returns null if
 *                  the row is not queued or already locked by another worker.
 *
 * releaseStale() — resets submissions that have been running longer than
 *                  thresholdMs back to "queued" (crash-recovery).
 *
 * cancelStaleIneligibleQueued() — terminally reconciles old automatic rows
 *                  whose application has already left the configured trigger
 *                  stages. Manual Run rows are never touched.
 *
 * NOTE: raw pg `SELECT *` returns snake_case column names. All three
 * claim queries use explicit AS aliases to produce camelCase keys that
 * match the ClaimedSubmission TypeScript type.
 */

import { pool } from "@workspace/db";
import { buildStaleIneligibleQueueStatement } from "./queueReconcilePolicy.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClaimedSubmission {
  id: number;
  applicationId: number;
  studentId: number;
  universityKey: string;
  universityName: string;
  adapterKey: string | null;
  mode: "dry" | "real";
  status: string;
  attempts: number;
  maxAttempts: number;
  lockedBy: string | null;
  lockedAt: Date | null;
  enqueuedBy: number | null;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Shared column list (explicit camelCase aliases)
// ---------------------------------------------------------------------------

const CLAIM_COLS = `
  id,
  application_id    AS "applicationId",
  student_id        AS "studentId",
  university_key    AS "universityKey",
  university_name   AS "universityName",
  adapter_key       AS "adapterKey",
  mode,
  status,
  attempts,
  max_attempts      AS "maxAttempts",
  locked_at         AS "lockedAt",
  locked_by         AS "lockedBy",
  enqueued_by       AS "enqueuedBy",
  created_at        AS "createdAt"
`;

const PORTAL_LANE_LOCK_NAMESPACE = 4_602_020;
const PORTAL_LANE_SQL = "LOWER(COALESCE(NULLIF(adapter_key, ''), university_key))";

interface ClaimFilters {
  universityKeys?: string[];
  triggerStages?: string[];
  excludeUniversityKeys?: string[];
  excludeLaneKeys?: string[];
  executionModes?: Array<"dry" | "real">;
  automaticMode?: "dry" | "real";
}

function buildClaimConditions(filters: ClaimFilters): {
  conditions: string[];
  params: unknown[];
} {
  const conditions: string[] = ["status = 'queued'", "deleted_at IS NULL"];
  const params: unknown[] = [];
  const isManualCond = `(meta->>'manual')::boolean IS TRUE`;
  const gatedConditions: string[] = [];

  if (filters.universityKeys !== undefined) {
    params.push(filters.universityKeys);
    gatedConditions.push(`university_key = ANY($${params.length}::text[])`);
  }

  if (filters.triggerStages !== undefined) {
    params.push(filters.triggerStages);
    gatedConditions.push(
      `EXISTS (
        SELECT 1 FROM applications a
        WHERE a.id = portal_submissions.application_id
          AND a.deleted_at IS NULL
          AND a.stage = ANY($${params.length}::text[])
      )`,
    );
  }

  if (filters.excludeUniversityKeys && filters.excludeUniversityKeys.length > 0) {
    params.push(filters.excludeUniversityKeys);
    gatedConditions.push(`university_key <> ALL($${params.length}::text[])`);
  }

  if (filters.automaticMode !== undefined) {
    params.push(filters.automaticMode);
    gatedConditions.push(`mode::text = $${params.length}`);
  }

  if (gatedConditions.length > 0) {
    conditions.push(`(${isManualCond} OR (${gatedConditions.join(" AND ")}))`);
  }

  // Capacity is an execution safety boundary, not an automatic-processing
  // gate. Manual jobs must not bypass it or they could create a second browser
  // session against a portal account whose configured slots are already full.
  if (filters.excludeLaneKeys && filters.excludeLaneKeys.length > 0) {
    params.push(filters.excludeLaneKeys.map((key) => key.toLowerCase()));
    conditions.push(`${PORTAL_LANE_SQL} <> ALL($${params.length}::text[])`);
  }

  // Execution mode is a worker capability boundary and therefore cannot be
  // bypassed by a manually enqueued row. A dry-only worker must never claim a
  // real submission, even when an operator clicked "Run now".
  if (filters.executionModes !== undefined) {
    params.push(filters.executionModes);
    conditions.push(`mode::text = ANY($${params.length}::text[])`);
  }

  // A committed real submission is never claimed again through the generic
  // submit queue, even if a stale/legacy writer inserted another queued row.
  // A deliberate amendment or withdrawal needs its own explicit action.
  conditions.push(`(
    mode <> 'real'
    OR (
      provider_committed_at IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM portal_submissions committed
        WHERE committed.id <> portal_submissions.id
          AND committed.application_id = portal_submissions.application_id
          AND committed.mode = 'real'
          AND committed.submission_action = 'submit'
          AND committed.provider_committed_at IS NOT NULL
          AND committed.deleted_at IS NULL
          AND (
            (
              portal_submissions.target_identity_sha256 IS NOT NULL
              AND committed.target_identity_sha256 = portal_submissions.target_identity_sha256
            )
            OR (
              portal_submissions.target_identity_sha256 IS NULL
              AND committed.target_identity_sha256 IS NULL
              AND committed.university_key = portal_submissions.university_key
            )
          )
      )
    )
  )`);

  return { conditions, params };
}

export function executionLaneKey(submission: Pick<ClaimedSubmission, "adapterKey" | "universityKey">): string {
  return (submission.adapterKey?.trim() || submission.universityKey.trim()).toLowerCase();
}

// ---------------------------------------------------------------------------
// claimNext
// ---------------------------------------------------------------------------

/**
 * Atomically claims the next queued submission for this worker instance.
 *
 * Uses BEGIN / SELECT ... FOR UPDATE SKIP LOCKED / UPDATE / COMMIT
 * so concurrent workers never attempt the same row.
 *
 * @param universityKeys  Optional allowlist of university_key values.
 *   When provided (non-empty), only submissions belonging to these
 *   universities are considered. Used by auto-drain to respect the
 *   per-university `autoProcess` flag.
 * @param triggerStages  Optional list of application stages that gate which
 *   submissions may be claimed. When provided (an array, even empty), only
 *   submissions whose application is currently in one of these stages are
 *   claimed — an empty array matches nothing, mirroring the enqueue-time
 *   candidate selection. `undefined` skips the stage filter entirely (used by
 *   the manual "process all queued" path, which must not be stage-gated).
 *
 * Manual bypass: rows enqueued via the user-facing "Run" action (Applications
 * bulk Run / admin Manual Submit dialog) are marked `meta.manual = true` at
 * enqueue time (see portalManualEnqueue.ts). Such rows are ALWAYS claimable —
 * both the `universityKeys` (autoProcess) and `triggerStages` gates are
 * bypassed for them, because the user already made an explicit, one-off
 * decision to submit that application regardless of its current stage or the
 * university's autoProcess toggle. The gates still apply in full to every
 * other (automatic/scheduled) row.
 *
 * Returns null when the queue is empty or all rows are locked by other workers.
 */
export async function claimNext(workerId: string, universityKeys?: string[], triggerStages?: string[], excludeUniversityKeys?: string[], executionModes?: Array<"dry" | "real">): Promise<ClaimedSubmission | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // NOTE: deliberately NO "attempts < max_attempts" condition here. attempts
    // increments at claim time and a failed run parks the row in 'failed'
    // permanently — there is no per-row auto-retry loop to guard against. The
    // manual Retry button re-queues WITHOUT resetting attempts, so gating on
    // attempts would silently dead-lock retried rows (see TAP4). The infinite
    // auto-retry loop is instead capped at the enqueue side (max_failures gate
    // in enqueueIfEligible / aggregator fan-out) — new rows stop being created
    // after MAX_AUTO_FAILED_SUBMISSIONS failures per application × university.
    const { conditions, params } = buildClaimConditions({
      universityKeys,
      triggerStages,
      excludeUniversityKeys,
      executionModes,
    });

    const sel = await client.query<ClaimedSubmission>(
      `SELECT ${CLAIM_COLS}
       FROM portal_submissions
       WHERE ${conditions.join("\n         AND ")}
       ORDER BY created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      params,
    );

    if (sel.rows.length === 0) {
      await client.query("COMMIT");
      return null;
    }

    const row = sel.rows[0];

    await client.query(
      `UPDATE portal_submissions
       SET status     = 'running',
           locked_at  = NOW(),
           locked_by  = $1,
           attempts   = attempts + 1,
           updated_at = NOW()
       WHERE id = $2`,
      [workerId, row.id],
    );

    await client.query("COMMIT");
    return row;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// claimNextWithLaneLease
// ---------------------------------------------------------------------------

export interface PortalLaneClaimOptions {
  universityKeys?: string[];
  triggerStages?: string[];
  excludeUniversityKeys?: string[];
  defaultLaneConcurrency: number;
  laneConcurrency?: ReadonlyMap<string, number>;
  executionModes?: Array<"dry" | "real">;
  automaticMode?: "dry" | "real";
}

export interface ClaimedSubmissionLease {
  submission: ClaimedSubmission;
  laneKey: string;
  slot: number;
  heartbeat(): Promise<boolean>;
  release(): Promise<void>;
}

function laneSlotCount(laneKey: string, options: PortalLaneClaimOptions): number {
  const configured = options.laneConcurrency?.get(laneKey) ?? options.defaultLaneConcurrency;
  if (!Number.isSafeInteger(configured) || configured < 1 || configured > 8) {
    throw new Error(`Invalid concurrency ${configured} for portal lane ${laneKey}`);
  }
  return configured;
}

/**
 * Claims the oldest runnable row whose portal-account lane has an available
 * distributed slot. The slot is a PostgreSQL session advisory lock held on a
 * dedicated pool client until release() is called. This keeps lane capacity
 * safe even if an accidental second worker process starts.
 *
 * Rows belonging to a full lane are skipped without changing their status or
 * attempt counter; the function can therefore continue to a different portal
 * instead of allowing a long SIT queue to block every other university.
 */
export async function claimNextWithLaneLease(workerId: string, options: PortalLaneClaimOptions): Promise<ClaimedSubmissionLease | null> {
  const client = await pool.connect();
  const excludedLaneKeys: string[] = [];
  let heldLockKey: string | null = null;
  let clientReleased = false;

  const releaseClient = (error?: Error): void => {
    if (clientReleased) return;
    clientReleased = true;
    client.release(error);
  };

  try {
    while (true) {
      await client.query("BEGIN");
      const { conditions, params } = buildClaimConditions({
        universityKeys: options.universityKeys,
        triggerStages: options.triggerStages,
        excludeUniversityKeys: options.excludeUniversityKeys,
        excludeLaneKeys: excludedLaneKeys,
        executionModes: options.executionModes,
        automaticMode: options.automaticMode,
      });

      const selected = await client.query<ClaimedSubmission>(
        `SELECT ${CLAIM_COLS}
         FROM portal_submissions
         WHERE ${conditions.join("\n           AND ")}
         ORDER BY created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
        params,
      );

      if (selected.rows.length === 0) {
        await client.query("COMMIT");
        releaseClient();
        return null;
      }

      const submission = selected.rows[0];
      const laneKey = executionLaneKey(submission);
      const slots = laneSlotCount(laneKey, options);
      let acquiredSlot: number | null = null;

      for (let slot = 1; slot <= slots; slot += 1) {
        const lockKey = `${laneKey}:${slot}`;
        const lockResult = await client.query<{ acquired: boolean }>(`SELECT pg_try_advisory_lock($1::int, hashtext($2)) AS acquired`, [PORTAL_LANE_LOCK_NAMESPACE, lockKey]);
        if (lockResult.rows[0]?.acquired) {
          acquiredSlot = slot;
          heldLockKey = lockKey;
          break;
        }
      }

      if (acquiredSlot === null) {
        await client.query("ROLLBACK");
        excludedLaneKeys.push(laneKey);
        continue;
      }
      if (!heldLockKey) {
        throw new Error(`Portal lane slot acquired without a lock key: ${laneKey}`);
      }
      const leaseLockKey = heldLockKey;

      await client.query(
        `UPDATE portal_submissions
         SET status     = 'running',
             locked_at  = NOW(),
             locked_by  = $1,
             attempts   = attempts + 1,
             updated_at = NOW()
         WHERE id = $2`,
        [workerId, submission.id],
      );
      await client.query("COMMIT");

      let released = false;
      return {
        submission,
        laneKey,
        slot: acquiredSlot,
        async heartbeat(): Promise<boolean> {
          if (released) return false;
          const result = await client.query(
            `UPDATE portal_submissions
             SET locked_at = NOW(), updated_at = NOW()
             WHERE id = $1
               AND status = 'running'
               AND locked_by = $2`,
            [submission.id, workerId],
          );
          return (result.rowCount ?? 0) === 1;
        },
        async release(): Promise<void> {
          if (released) return;
          released = true;
          let releaseError: Error | undefined;
          try {
            const result = await client.query<{ released: boolean }>(`SELECT pg_advisory_unlock($1::int, hashtext($2)) AS released`, [PORTAL_LANE_LOCK_NAMESPACE, leaseLockKey]);
            if (!result.rows[0]?.released) {
              throw new Error(`Portal lane advisory lock was not held: ${leaseLockKey}`);
            }
          } catch (error) {
            releaseError = error instanceof Error ? error : new Error(String(error));
            throw releaseError;
          } finally {
            releaseClient(releaseError);
          }
        },
      };
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (heldLockKey) {
      await client.query(`SELECT pg_advisory_unlock($1::int, hashtext($2))`, [PORTAL_LANE_LOCK_NAMESPACE, heldLockKey]).catch(() => {});
    }
    const claimError = error instanceof Error ? error : new Error(String(error));
    releaseClient(claimError);
    throw claimError;
  }
}

// ---------------------------------------------------------------------------
// claimById
// ---------------------------------------------------------------------------

/**
 * Atomically claims a specific submission by id.
 *
 * Returns null if the row:
 *   - doesn't exist or is soft-deleted
 *   - is not in 'queued' status
 *   - is already locked by another worker (SKIP LOCKED)
 *
 * Note: attempt count is NOT checked — any queued row is claimable.
 * If status='queued' it was explicitly authorised for (re-)processing.
 */
export async function claimById(id: number, workerId: string): Promise<ClaimedSubmission | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const sel = await client.query<ClaimedSubmission>(
      `
      SELECT ${CLAIM_COLS}
      FROM portal_submissions
      WHERE id = $1
        AND status = 'queued'
        AND deleted_at IS NULL
        AND (
          mode <> 'real'
          OR (
            provider_committed_at IS NULL
            AND NOT EXISTS (
              SELECT 1
              FROM portal_submissions committed
              WHERE committed.id <> portal_submissions.id
                AND committed.application_id = portal_submissions.application_id
                AND committed.mode = 'real'
                AND committed.submission_action = 'submit'
                AND committed.provider_committed_at IS NOT NULL
                AND committed.deleted_at IS NULL
                AND (
                  (
                    portal_submissions.target_identity_sha256 IS NOT NULL
                    AND committed.target_identity_sha256 = portal_submissions.target_identity_sha256
                  )
                  OR (
                    portal_submissions.target_identity_sha256 IS NULL
                    AND committed.target_identity_sha256 IS NULL
                    AND committed.university_key = portal_submissions.university_key
                  )
                )
            )
          )
        )
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `,
      [id],
    );

    if (sel.rows.length === 0) {
      await client.query("COMMIT");
      return null;
    }

    const row = sel.rows[0];

    await client.query(
      `UPDATE portal_submissions
       SET status     = 'running',
           locked_at  = NOW(),
           locked_by  = $1,
           attempts   = attempts + 1,
           updated_at = NOW()
       WHERE id = $2`,
      [workerId, row.id],
    );

    await client.query("COMMIT");
    return row;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// cancelStaleIneligibleQueued
// ---------------------------------------------------------------------------

/**
 * Cancels old AUTOMATIC queue rows that can no longer be claimed because the
 * application has moved beyond the configured trigger stages.
 *
 * This is queue hygiene, not a portal action: no browser is opened and no
 * application stage is changed. The age threshold prevents a concurrent stage
 * transition from immediately cancelling a freshly-enqueued row. Explicit
 * user Run rows (`meta.manual=true`) are permanently excluded.
 *
 * `universityKeys` may include both canonical portal keys and legacy adapter
 * aliases. Including aliases lets the reconciler retire historical rows that
 * were enqueued before canonical portal-key enforcement was added.
 */
export async function cancelStaleIneligibleQueued(universityKeys: string[], triggerStages: string[], thresholdMs: number): Promise<number[]> {
  const statement = buildStaleIneligibleQueueStatement(universityKeys, triggerStages, thresholdMs);
  if (!statement) return [];

  const res = await pool.query<{ id: number }>(statement.text, statement.values);

  return (res.rows ?? []).map((row) => row.id);
}

// ---------------------------------------------------------------------------
// releaseStale
// ---------------------------------------------------------------------------

/**
 * Recovers submissions that have been in "running" state longer than
 * `thresholdMs` milliseconds. Dry runs may be requeued; real runs become a
 * reconciliation-required failure because the provider outcome is unknown.
 *
 * Retryable dry rows reset attempts so they are immediately claimable again.
 * A real row never resets its attempts and is never automatically requeued:
 * losing its worker lease makes the provider outcome ambiguous, so an
 * operator must reconcile the provider portal before any deliberate action.
 *
 * Returns the IDs of rows whose stale lease was resolved (requeued or moved
 * to the reconciliation-required failure state).
 */
export async function releaseStale(thresholdMs: number): Promise<number[]> {
  // FIX-CRASHLOOP: a submission that deterministically crashes the worker
  // process (e.g. a native SIGBUS in a downstream dependency) used to be
  // forgiven forever - attempts was unconditionally reset to 0 on every
  // crash-recovery, so claimNext kept reclaiming it and it kept crashing
  // the worker, taking the whole queue hostage. We still forgive normal
  // crash-recovery (attempts=0, so app-level retry budget is untouched),
  // but we now track how many times THIS row has come back from a stale
  // "running" lock via meta.crash_recoveries. Once that exceeds
  // MAX_CRASH_RECOVERIES we quarantine the row as 'failed' instead of
  // requeueing it, so one poison-pill submission can no longer crash-loop
  // the daemon or block the rest of the batch.
  const res = await pool.query<{ id: number }>(
    `UPDATE portal_submissions
     SET status     = CASE
                         WHEN mode = 'real'
                           THEN 'failed'::portal_submission_status
                         WHEN COALESCE((meta->>'crash_recoveries')::int, 0) + 1 >= 3
                           THEN 'failed'::portal_submission_status
                         ELSE 'queued'::portal_submission_status
                       END,
         attempts   = CASE
                         WHEN mode = 'real'
                           THEN attempts
                         WHEN COALESCE((meta->>'crash_recoveries')::int, 0) + 1 >= 3
                           THEN attempts
                         ELSE 0
                       END,
         locked_at  = NULL,
         locked_by  = NULL,
         error      = CASE
                         WHEN mode = 'real'
                           THEN 'PROVIDER_OUTCOME_UNKNOWN: real portal execution lost its worker lease; reconcile portal state before any retry.'
                         WHEN COALESCE((meta->>'crash_recoveries')::int, 0) + 1 >= 3
                           THEN 'WORKER CRASH LOOP - bu basvuru worker surecini ust uste 3+ kez cokerterek (SIGBUS/anormal exit) durdurdu. Otomatik izole edildi (failed); manuel inceleme gerekiyor.'
                         ELSE error
                       END,
         meta       = jsonb_set(
                         jsonb_set(
                           COALESCE(meta, '{}'::jsonb),
                           '{crash_recoveries}',
                           to_jsonb(COALESCE((meta->>'crash_recoveries')::int, 0) + 1)
                         ),
                         '{recoveryDisposition}',
                         to_jsonb(CASE WHEN mode = 'real' THEN 'reconciliation_required' ELSE 'retryable' END::text)
                       ),
         updated_at = NOW()
     WHERE status = 'running'
       AND locked_at < NOW() - ($1 || ' milliseconds')::interval
       AND deleted_at IS NULL
     RETURNING id`,
    [thresholdMs],
  );
  return (res.rows ?? []).map((r) => r.id);
}

// ---------------------------------------------------------------------------
// heartbeat
// ---------------------------------------------------------------------------

/**
 * Refreshes locked_at for an active running submission.
 * Call periodically while processing to prevent stuck-reset from firing.
 * Guards on locked_by when workerId is provided so only the owning worker
 * can extend the lease.
 */
export async function heartbeat(id: number, workerId?: string): Promise<void> {
  if (workerId) {
    await pool.query(
      `UPDATE portal_submissions
       SET locked_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'running' AND locked_by = $2`,
      [id, workerId],
    );
  } else {
    await pool.query(
      `UPDATE portal_submissions
       SET locked_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'running'`,
      [id],
    );
  }
}

// ---------------------------------------------------------------------------
// requeueStuck
// ---------------------------------------------------------------------------

/**
 * Atomically requeues a specific running submission back to "queued".
 * Only acts if the row is still owned by `workerId` (locked_by guard).
 * Returns true if the row was actually reset.
 */
export async function requeueStuck(id: number, workerId: string): Promise<boolean> {
  const res = await pool.query<{ id: number }>(
    `UPDATE portal_submissions
     SET status     = 'queued',
         locked_at  = NULL,
         locked_by  = NULL,
         updated_at = NOW()
     WHERE id = $1
       AND status   = 'running'
       AND locked_by = $2
       AND deleted_at IS NULL
     RETURNING id`,
    [id, workerId],
  );
  return (res.rowCount ?? 0) > 0;
}
