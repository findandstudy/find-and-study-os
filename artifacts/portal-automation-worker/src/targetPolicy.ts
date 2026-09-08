export type PortalWorkerTarget = {
  universityKey: string;
  adapterKey: string;
  autoProcess: boolean;
  isActive: boolean;
  verificationReady: boolean;
};

/**
 * Separates executable targets from queue-hygiene targets.
 *
 * Claims remain strictly limited to active, auto-process-enabled, graduated
 * adapters. Reconciliation intentionally covers every non-deleted portal row:
 * otherwise a queued automatic job can remain forever after an administrator
 * disables auto-processing or the adapter loses graduation.
 */
export function buildPortalWorkerTargetSets(
  portals: readonly PortalWorkerTarget[],
  nonGraduatedAdapterKeys: ReadonlySet<string>,
): { claimKeys: string[]; reconcileKeys: string[] } {
  const eligible = portals.filter(
    (portal) =>
      portal.isActive &&
      portal.autoProcess &&
      portal.verificationReady &&
      !nonGraduatedAdapterKeys.has(portal.adapterKey),
  );

  return {
    claimKeys: [...new Set(eligible.map((portal) => portal.universityKey))],
    // Legacy queue rows sometimes stored the adapter alias as university_key.
    // Reconciliation may retire those rows, but claiming stays canonical.
    reconcileKeys: [
      ...new Set(
        portals.flatMap((portal) => [portal.universityKey, portal.adapterKey]),
      ),
    ],
  };
}
