import type { PoolClient } from "pg";
import {
  normalizeSocialRuntimeId,
  socialWorkerHeartbeatIntervalMs,
} from "./socialOperationsContract";
import type { SocialOperationsContext } from "./socialOperationsStore";

export type SocialWorkerKind =
  | "publication"
  | "performance"
  | "creative"
  | "advertising";

export type SocialWorkerHeartbeatState = {
  workerKind: SocialWorkerKind;
  workerId: string;
  runtimeReleaseId: string;
  startedAt: Date;
  nextHeartbeatAt: number;
};

export function createSocialWorkerHeartbeatState(input: {
  workerKind: SocialWorkerKind;
  workerId: string;
  runtimeReleaseId: string;
  observedAt?: Date;
}): SocialWorkerHeartbeatState {
  return {
    workerKind: input.workerKind,
    workerId: normalizeSocialRuntimeId(input.workerId),
    runtimeReleaseId: normalizeSocialRuntimeId(input.runtimeReleaseId),
    startedAt: input.observedAt ?? new Date(),
    nextHeartbeatAt: 0,
  };
}

export async function recordSocialWorkerHeartbeat(
  client: PoolClient,
  context: SocialOperationsContext,
  state: SocialWorkerHeartbeatState,
  observedAt = new Date(),
): Promise<void> {
  if (!Number.isFinite(observedAt.getTime()))
    throw new Error("SOCIAL_WORKER_HEARTBEAT_TIME_INVALID");
  await client.query(
    `INSERT INTO social_worker_heartbeats
       (tenant_id,organization_id,worker_kind,worker_id,runtime_release_id,started_at,last_seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (tenant_id,organization_id,worker_kind,worker_id)
     DO UPDATE SET
       runtime_release_id=EXCLUDED.runtime_release_id,
       started_at=CASE
         WHEN social_worker_heartbeats.runtime_release_id<>EXCLUDED.runtime_release_id
           THEN EXCLUDED.started_at
         ELSE social_worker_heartbeats.started_at
       END,
       last_seen_at=EXCLUDED.last_seen_at`,
    [
      context.tenantId,
      context.organizationId,
      state.workerKind,
      state.workerId,
      state.runtimeReleaseId,
      state.startedAt,
      observedAt,
    ],
  );
}

export function isSocialWorkerHeartbeatDue(
  state: SocialWorkerHeartbeatState,
  observedAt = new Date(),
): boolean {
  const observedAtMs = observedAt.getTime();
  if (!Number.isFinite(observedAtMs))
    throw new Error("SOCIAL_WORKER_HEARTBEAT_TIME_INVALID");
  return observedAtMs >= state.nextHeartbeatAt;
}

export function scheduleNextSocialWorkerHeartbeat(
  state: SocialWorkerHeartbeatState,
  intervalValue?: string,
  observedAt = new Date(),
): void {
  const observedAtMs = observedAt.getTime();
  if (!Number.isFinite(observedAtMs))
    throw new Error("SOCIAL_WORKER_HEARTBEAT_TIME_INVALID");
  state.nextHeartbeatAt =
    observedAtMs + socialWorkerHeartbeatIntervalMs(intervalValue);
}
