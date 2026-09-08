export type DuplicateReportingScope = "global" | "reporting";

export const DUPLICATE_MATCH_FAMILIES = [
  "student.email",
  "student.phone",
  "student.passport",
  "lead.email",
  "lead.phone",
] as const;

/**
 * One canonical duplicate-candidate definition shared by Reporting and the
 * detailed Data Quality screen. The only variants are fixed, source-owned
 * branch predicates; no caller or request text is interpolated into SQL.
 */
export function duplicateCandidatesCte(
  scope: DuplicateReportingScope,
): string {
  const studentBranch =
    scope === "reporting"
      ? "AND ($4::int[] IS NULL OR branch_id = ANY($4::int[]))"
      : "";
  const leadBranch = studentBranch;

  return `duplicate_candidates AS (
    SELECT 'student'::text AS entity, 'email'::text AS match_key,
           lower(trim(email)) AS normalized_value,
           array_agg(id ORDER BY id) AS record_ids,
           count(*)::int AS record_count
    FROM students
    WHERE deleted_at IS NULL
      AND nullif(lower(trim(email)), '') IS NOT NULL
      ${studentBranch}
    GROUP BY lower(trim(email)) HAVING count(*) > 1
    UNION ALL
    SELECT 'student', 'phone',
           coalesce(nullif(trim(phone_e164), ''), regexp_replace(coalesce(phone, ''), '[^0-9]+', '', 'g')),
           array_agg(id ORDER BY id), count(*)::int
    FROM students
    WHERE deleted_at IS NULL
      AND nullif(coalesce(nullif(trim(phone_e164), ''), regexp_replace(coalesce(phone, ''), '[^0-9]+', '', 'g')), '') IS NOT NULL
      ${studentBranch}
    GROUP BY coalesce(nullif(trim(phone_e164), ''), regexp_replace(coalesce(phone, ''), '[^0-9]+', '', 'g'))
    HAVING count(*) > 1
    UNION ALL
    SELECT 'student', 'passport',
           upper(regexp_replace(trim(passport_number), '[^A-Za-z0-9]+', '', 'g')),
           array_agg(id ORDER BY id), count(*)::int
    FROM students
    WHERE deleted_at IS NULL
      AND nullif(regexp_replace(trim(coalesce(passport_number, '')), '[^A-Za-z0-9]+', '', 'g'), '') IS NOT NULL
      ${studentBranch}
    GROUP BY upper(regexp_replace(trim(passport_number), '[^A-Za-z0-9]+', '', 'g'))
    HAVING count(*) > 1
    UNION ALL
    SELECT 'lead', 'email', lower(trim(email)),
           array_agg(id ORDER BY id), count(*)::int
    FROM leads
    WHERE deleted_at IS NULL
      AND nullif(lower(trim(email)), '') IS NOT NULL
      ${leadBranch}
    GROUP BY lower(trim(email)) HAVING count(*) > 1
    UNION ALL
    SELECT 'lead', 'phone',
           coalesce(nullif(trim(phone_e164), ''), regexp_replace(coalesce(phone, ''), '[^0-9]+', '', 'g')),
           array_agg(id ORDER BY id), count(*)::int
    FROM leads
    WHERE deleted_at IS NULL
      AND nullif(coalesce(nullif(trim(phone_e164), ''), regexp_replace(coalesce(phone, ''), '[^0-9]+', '', 'g')), '') IS NOT NULL
      ${leadBranch}
    GROUP BY coalesce(nullif(trim(phone_e164), ''), regexp_replace(coalesce(phone, ''), '[^0-9]+', '', 'g'))
    HAVING count(*) > 1
  )`;
}
