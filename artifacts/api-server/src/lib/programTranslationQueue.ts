import { pool } from "@workspace/db";
import {
  PROGRAM_TARGET_LOCALES,
  isProgramTargetLocale,
  normalizeProgramSourceContent,
  type ProgramLocalizedContent,
  type ProgramSourceContent,
  type ProgramTargetLocale,
} from "./programTranslationContract";

export type ClaimedProgramTranslation = {
  programId: number;
  locale: ProgramTargetLocale;
  sourceHash: string;
  attempts: number;
  source: ProgramSourceContent;
};

type ClaimRow = {
  program_id: number;
  locale: string;
  source_hash: string;
  attempts: number;
  name: string;
  description: string | null;
  field: string | null;
  duration: string | null;
  intakes: string | null;
  requirements: string | null;
};

export async function claimProgramTranslation(
  workerId: string,
  leaseSeconds = 120,
): Promise<ClaimedProgramTranslation | null> {
  const result = await pool.query<ClaimRow>(`
    WITH candidate AS (
      SELECT translation.program_id, translation.locale
      FROM program_translations translation
      WHERE translation.is_manual = false
        AND translation.attempts < 5
        AND (
          (translation.status IN ('queued','retrying') AND translation.next_attempt_at <= now())
          OR
          (translation.status = 'processing' AND translation.lease_expires_at <= now())
        )
      ORDER BY
        CASE WHEN translation.status = 'processing' THEN 0 ELSE 1 END,
        translation.next_attempt_at,
        translation.program_id,
        translation.locale
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE program_translations translation
    SET status = 'processing',
        attempts = translation.attempts + 1,
        leased_at = now(),
        lease_expires_at = now() + make_interval(secs => $2),
        worker_id = $1,
        error_code = NULL,
        updated_at = now()
    FROM candidate, programs program
    WHERE translation.program_id = candidate.program_id
      AND translation.locale = candidate.locale
      AND program.id = translation.program_id
    RETURNING translation.program_id, translation.locale, translation.source_hash,
              translation.attempts, program.name, program.description, program.field,
              program.duration, program.intakes, program.requirements
  `, [workerId, leaseSeconds]);
  const row = result.rows[0];
  if (!row || !isProgramTargetLocale(row.locale)) return null;
  return {
    programId: row.program_id,
    locale: row.locale,
    sourceHash: row.source_hash,
    attempts: row.attempts,
    source: normalizeProgramSourceContent(row),
  };
}

export async function completeProgramTranslation(
  job: ClaimedProgramTranslation,
  workerId: string,
  content: ProgramLocalizedContent,
  provider: { provider: string; model: string },
): Promise<boolean> {
  const result = await pool.query<{ program_id: number }>(`
    UPDATE program_translations
    SET name = $5,
        description = $6,
        field = $7,
        duration = $8,
        intakes = $9,
        requirements = $10,
        status = 'published',
        provider = $11,
        model = $12,
        error_code = NULL,
        translated_at = now(),
        leased_at = NULL,
        lease_expires_at = NULL,
        worker_id = NULL,
        updated_at = now()
    WHERE program_id = $1
      AND locale = $2
      AND source_hash = $3
      AND status = 'processing'
      AND worker_id = $4
      AND is_manual = false
    RETURNING program_id
  `, [
    job.programId, job.locale, job.sourceHash, workerId,
    content.name, content.description, content.field, content.duration,
    content.intakes, content.requirements, provider.provider, provider.model,
  ]);
  return result.rowCount === 1;
}

export async function failProgramTranslation(
  job: ClaimedProgramTranslation,
  workerId: string,
  errorCode: string,
  retryable: boolean,
): Promise<void> {
  const retryDelays = [30, 120, 600, 1_800, 7_200];
  const delaySeconds = retryDelays[Math.min(Math.max(job.attempts - 1, 0), retryDelays.length - 1)];
  const nextStatus = retryable && job.attempts < 5 ? "retrying" : "failed";
  await pool.query(`
    UPDATE program_translations
    SET status = $5,
        error_code = $6,
        next_attempt_at = CASE WHEN $5 = 'retrying'
          THEN now() + make_interval(secs => $7)
          ELSE next_attempt_at
        END,
        leased_at = NULL,
        lease_expires_at = NULL,
        worker_id = NULL,
        updated_at = now()
    WHERE program_id = $1
      AND locale = $2
      AND source_hash = $3
      AND status = 'processing'
      AND worker_id = $4
  `, [job.programId, job.locale, job.sourceHash, workerId, nextStatus, errorCode, delaySeconds]);
}

export async function requeueProgramTranslations(
  programId: number,
  locales?: ProgramTargetLocale[],
): Promise<number> {
  const targetLocales = locales?.length ? locales : [...PROGRAM_TARGET_LOCALES];
  // Existing catalogue rows predate the translation table. A retry must also
  // create any missing target rows; this operation is bounded to one program
  // and at most PROGRAM_TARGET_LOCALES.length inserts.
  await pool.query(`
    INSERT INTO program_translations (
      program_id, locale, source_hash, status, next_attempt_at, updated_at
    )
    SELECT program.id, locale,
           fas_program_content_source_hash(
             program.name, program.description, program.field, program.duration,
             program.intakes, program.requirements
           ),
           'queued', now(), now()
      FROM programs program
      CROSS JOIN unnest($2::text[]) AS locale
     WHERE program.id = $1
    ON CONFLICT (program_id, locale) DO NOTHING
  `, [programId, targetLocales]);
  const result = await pool.query(`
    UPDATE program_translations
    SET status = CASE WHEN is_manual THEN 'stale_manual' ELSE 'queued' END,
        attempts = CASE WHEN is_manual THEN attempts ELSE 0 END,
        error_code = NULL,
        next_attempt_at = now(),
        leased_at = NULL,
        lease_expires_at = NULL,
        worker_id = NULL,
        updated_at = now()
    WHERE program_id = $1
      AND locale = ANY($2::text[])
      AND status <> 'processing'
  `, [programId, targetLocales]);
  return result.rowCount || 0;
}

export type ProgramTranslationReconcileResult = {
  scanned: number;
  queued: number;
  nextCursor: number;
  hasMore: boolean;
};

/**
 * Add missing translation jobs for historical programmes in a strictly
 * cursor-bound batch. Callers must persist/use nextCursor; a migration or API
 * request must never attempt an unbounded full-catalogue cross join.
 */
export async function reconcileMissingProgramTranslations(
  afterProgramId: number,
  limit: number,
): Promise<ProgramTranslationReconcileResult> {
  const result = await pool.query<{
    scanned: number;
    queued: number;
    next_cursor: number;
    has_more: boolean;
  }>(`
    WITH batch AS MATERIALIZED (
      SELECT program.id, program.name, program.description, program.field,
             program.duration, program.intakes, program.requirements
        FROM programs program
       WHERE program.id > $1
       ORDER BY program.id
       LIMIT $2
    ), inserted AS (
      INSERT INTO program_translations (
        program_id, locale, source_hash, status, next_attempt_at, updated_at
      )
      SELECT batch.id, locale,
             fas_program_content_source_hash(
               batch.name, batch.description, batch.field, batch.duration,
               batch.intakes, batch.requirements
             ),
             'queued', now(), now()
        FROM batch
        CROSS JOIN unnest($3::text[]) AS locale
      ON CONFLICT (program_id, locale) DO NOTHING
      RETURNING program_id
    ), summary AS (
      SELECT count(*)::int AS scanned,
             coalesce(max(id), $1)::int AS next_cursor
        FROM batch
    )
    SELECT summary.scanned,
           (SELECT count(*)::int FROM inserted) AS queued,
           summary.next_cursor,
           EXISTS (
             SELECT 1 FROM programs program WHERE program.id > summary.next_cursor
           ) AS has_more
      FROM summary
  `, [afterProgramId, limit, [...PROGRAM_TARGET_LOCALES]]);
  const row = result.rows[0];
  return {
    scanned: Number(row?.scanned ?? 0),
    queued: Number(row?.queued ?? 0),
    nextCursor: Number(row?.next_cursor ?? afterProgramId),
    hasMore: Boolean(row?.has_more),
  };
}

export async function requeueAllFailedProgramTranslations(): Promise<number> {
  const result = await pool.query(`
    UPDATE program_translations
    SET status = 'queued', attempts = 0, error_code = NULL,
        next_attempt_at = now(), updated_at = now()
    WHERE is_manual = false AND status IN ('failed','retrying')
  `);
  return result.rowCount || 0;
}
