export const SMALL_COHORT_THRESHOLD = 20;

export function reportingScopeWarnings(
  allowedBranchIds: readonly number[] | null,
): string[] {
  return allowedBranchIds === null
    ? []
    : [
        "Branch-scoped results exclude records whose branch_id is NULL; review Data Quality before interpreting branch comparisons.",
      ];
}

export function reportingSmallCohortWarnings(
  denominators: ReadonlyArray<{ label: string; value: number }>,
): string[] {
  const small = denominators.filter(
    ({ value }) => value > 0 && value < SMALL_COHORT_THRESHOLD,
  );
  if (small.length === 0) return [];
  return [
    `Small-cohort caution (n < ${SMALL_COHORT_THRESHOLD}): ${small
      .map(({ label, value }) => `${label}=${value}`)
      .join(", ")}. Rates and period comparisons may be unstable.`,
  ];
}
