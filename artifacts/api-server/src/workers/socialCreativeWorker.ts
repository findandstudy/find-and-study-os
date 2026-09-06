import { pool } from "@workspace/db";
import {
  normalizeSocialRuntimeId,
  resolveSocialCreativeGate,
  socialWorkerFailureCode,
  socialWorkerRetryDelayMs,
} from "../lib/socialOperationsContract";
import { withSocialOperationsContext } from "../lib/socialOperationsStore";
import {
  claimSocialCreative,
  completeSocialCreative,
  materializeSocialCreativeResult,
} from "../lib/socialCreativeQueue";
import {
  assertSocialCreativeConfiguration,
  generateSocialCreative,
  socialCreativeFailureFromThrown,
} from "../lib/socialCreativeAdapter";
import {
  createSocialWorkerHeartbeatState,
  isSocialWorkerHeartbeatDue,
  recordSocialWorkerHeartbeat,
  scheduleNextSocialWorkerHeartbeat,
} from "../lib/socialWorkerRuntime";

const gate = resolveSocialCreativeGate({
  workerEnabled: process.env.SOCIAL_CREATIVE_WORKER_ENABLED,
  generationEnabled: process.env.SOCIAL_CREATIVE_GENERATION_ENABLED,
  allowLiveIntegrations: process.env.ALLOW_LIVE_INTEGRATIONS,
  providerAllowlist: process.env.SOCIAL_CREATIVE_PROVIDER_ALLOWLIST,
});
if (!gate.enabled)
  throw new Error(gate.reason ?? "SOCIAL_CREATIVE_WORKER_DISABLED");
assertSocialCreativeConfiguration();

const legacyUserId = Number(process.env.SOCIAL_CREATIVE_WORKER_LEGACY_USER_ID);
if (!Number.isSafeInteger(legacyUserId) || legacyUserId <= 0)
  throw new Error("SOCIAL_CREATIVE_WORKER_USER_INVALID");
const workerId = normalizeSocialRuntimeId(
  process.env.SOCIAL_CREATIVE_WORKER_ID ?? "",
);
const runtimeReleaseId = normalizeSocialRuntimeId(
  process.env.RELEASE_ID ?? process.env.GIT_COMMIT ?? "",
);
const heartbeat = createSocialWorkerHeartbeatState({
  workerKind: "creative",
  workerId,
  runtimeReleaseId,
});
let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});

async function delay(milliseconds: number): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (!stopping && Date.now() < deadline)
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(250, deadline - Date.now())),
    );
}

let consecutiveInfrastructureFailures = 0;
while (!stopping) {
  try {
    const observedAt = new Date();
    const heartbeatDue = isSocialWorkerHeartbeatDue(heartbeat, observedAt);
    const claim = await withSocialOperationsContext(
      legacyUserId,
      "manage",
      async (client, context) => {
        if (heartbeatDue)
          await recordSocialWorkerHeartbeat(
            client,
            context,
            heartbeat,
            observedAt,
          );
        return claimSocialCreative(client, context, workerId);
      },
    );
    if (heartbeatDue)
      scheduleNextSocialWorkerHeartbeat(
        heartbeat,
        process.env.SOCIAL_WORKER_HEARTBEAT_INTERVAL_SECONDS,
        observedAt,
      );
    consecutiveInfrastructureFailures = 0;
    if (!claim) {
      await delay(2_000);
      continue;
    }
    const providerResult = await generateSocialCreative(claim).catch(
      socialCreativeFailureFromThrown,
    );
    const materialized = await materializeSocialCreativeResult(
      claim,
      providerResult,
    ).catch(socialCreativeFailureFromThrown);
    await withSocialOperationsContext(
      legacyUserId,
      "manage",
      (client, context) =>
        completeSocialCreative(
          client,
          context,
          claim,
          workerId,
          runtimeReleaseId,
          materialized,
        ),
    );
  } catch (error) {
    consecutiveInfrastructureFailures = Math.min(
      12,
      consecutiveInfrastructureFailures + 1,
    );
    const retryInMs = socialWorkerRetryDelayMs(
      consecutiveInfrastructureFailures,
    );
    console.error(
      `[social-creative-worker] tick_failed code=${socialWorkerFailureCode(error)} retryInMs=${retryInMs}`,
    );
    await delay(retryInMs);
  }
}
await pool.end();
