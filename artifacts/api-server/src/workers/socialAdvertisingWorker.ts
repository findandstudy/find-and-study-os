import { pool } from "@workspace/db";
import {
  normalizeSocialRuntimeId,
  resolveSocialAdvertisingGate,
  socialWorkerFailureCode,
  socialWorkerRetryDelayMs,
} from "../lib/socialOperationsContract";
import { withSocialOperationsContext } from "../lib/socialOperationsStore";
import {
  claimSocialAdOperation,
  completeSocialAdOperation,
} from "../lib/socialAdvertisingQueue";
import {
  assertSocialPublisherConfiguration,
  executeSocialAdOperation,
  socialPublisherFailureFromThrown,
} from "../lib/socialPublisherAdapter";
import {
  createSocialWorkerHeartbeatState,
  isSocialWorkerHeartbeatDue,
  recordSocialWorkerHeartbeat,
  scheduleNextSocialWorkerHeartbeat,
} from "../lib/socialWorkerRuntime";

const gate = resolveSocialAdvertisingGate({
  workerEnabled: process.env.SOCIAL_AD_WORKER_ENABLED,
  connectivityEnabled: process.env.SOCIAL_PROVIDER_CONNECTIVITY_ENABLED,
  providerAdvertisingEnabled: process.env.SOCIAL_PROVIDER_ADVERTISING_ENABLED,
  allowLiveIntegrations: process.env.ALLOW_LIVE_INTEGRATIONS,
  providerAllowlist: process.env.SOCIAL_AD_PROVIDER_ALLOWLIST,
  maximumCampaignBudgetMinor: process.env.SOCIAL_AD_MAX_CAMPAIGN_BUDGET_MINOR,
});
if (!gate.enabled) throw new Error(gate.reason ?? "SOCIAL_AD_WORKER_DISABLED");
assertSocialPublisherConfiguration();

const legacyUserId = Number(process.env.SOCIAL_AD_WORKER_LEGACY_USER_ID);
if (!Number.isSafeInteger(legacyUserId) || legacyUserId <= 0)
  throw new Error("SOCIAL_AD_WORKER_USER_INVALID");
const workerId = normalizeSocialRuntimeId(
  process.env.SOCIAL_AD_WORKER_ID ?? "",
);
const runtimeReleaseId = normalizeSocialRuntimeId(
  process.env.RELEASE_ID ?? process.env.GIT_COMMIT ?? "",
);
const heartbeat = createSocialWorkerHeartbeatState({
  workerKind: "advertising",
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
  while (!stopping && Date.now() < deadline) {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(250, deadline - Date.now())),
    );
  }
}

let consecutiveInfrastructureFailures = 0;
while (!stopping) {
  try {
    const heartbeatObservedAt = new Date();
    const heartbeatDue = isSocialWorkerHeartbeatDue(
      heartbeat,
      heartbeatObservedAt,
    );
    const claim = await withSocialOperationsContext(
      legacyUserId,
      "manage",
      async (client, context) => {
        if (heartbeatDue)
          await recordSocialWorkerHeartbeat(
            client,
            context,
            heartbeat,
            heartbeatObservedAt,
          );
        return claimSocialAdOperation(
          client,
          context,
          workerId,
          gate.maximumCampaignBudgetMinor,
        );
      },
    );
    if (heartbeatDue)
      scheduleNextSocialWorkerHeartbeat(
        heartbeat,
        process.env.SOCIAL_WORKER_HEARTBEAT_INTERVAL_SECONDS,
        heartbeatObservedAt,
      );
    consecutiveInfrastructureFailures = 0;
    if (!claim) {
      await delay(2_000);
      continue;
    }
    const result = await executeSocialAdOperation(claim).catch(
      socialPublisherFailureFromThrown,
    );
    await withSocialOperationsContext(
      legacyUserId,
      "manage",
      (client, context) =>
        completeSocialAdOperation(
          client,
          context,
          claim,
          workerId,
          runtimeReleaseId,
          result,
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
      `[social-advertising-worker] tick_failed code=${socialWorkerFailureCode(error)} retryInMs=${retryInMs}`,
    );
    await delay(retryInMs);
  }
}
await pool.end();
