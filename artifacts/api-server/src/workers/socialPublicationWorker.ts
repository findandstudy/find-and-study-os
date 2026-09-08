import {
  normalizeSocialRuntimeId,
  resolveSocialPublicationGate,
  socialWorkerFailureCode,
  socialWorkerRetryDelayMs,
} from "../lib/socialOperationsContract";
import { pool } from "@workspace/db";
import { withSocialOperationsContext } from "../lib/socialOperationsStore";
import {
  claimSocialPublication,
  completeSocialPublication,
} from "../lib/socialPublicationQueue";
import {
  assertSocialPublisherConfiguration,
  publishSocialJob,
  socialPublisherFailureFromThrown,
} from "../lib/socialPublisherAdapter";
import {
  createSocialWorkerHeartbeatState,
  isSocialWorkerHeartbeatDue,
  recordSocialWorkerHeartbeat,
  scheduleNextSocialWorkerHeartbeat,
} from "../lib/socialWorkerRuntime";
import { verifyStoredSocialMediaRefs } from "../lib/socialMediaAssets";

const gate = resolveSocialPublicationGate({
  workerEnabled: process.env.SOCIAL_PUBLICATION_WORKER_ENABLED,
  connectivityEnabled: process.env.SOCIAL_PROVIDER_CONNECTIVITY_ENABLED,
  providerPublishingEnabled: process.env.SOCIAL_PROVIDER_PUBLISHING_ENABLED,
  allowLiveIntegrations: process.env.ALLOW_LIVE_INTEGRATIONS,
  providerAllowlist: process.env.SOCIAL_PUBLICATION_PROVIDER_ALLOWLIST,
});
if (!gate.enabled)
  throw new Error(gate.reason ?? "SOCIAL_PUBLICATION_WORKER_DISABLED");
assertSocialPublisherConfiguration();

const legacyUserId = Number(
  process.env.SOCIAL_PUBLICATION_WORKER_LEGACY_USER_ID,
);
if (!Number.isSafeInteger(legacyUserId) || legacyUserId <= 0)
  throw new Error("SOCIAL_PUBLICATION_WORKER_USER_INVALID");
const workerId = normalizeSocialRuntimeId(
  process.env.SOCIAL_PUBLICATION_WORKER_ID ?? "",
);
const runtimeReleaseId = normalizeSocialRuntimeId(
  process.env.RELEASE_ID ?? process.env.GIT_COMMIT ?? "",
);
const heartbeat = createSocialWorkerHeartbeatState({
  workerKind: "publication",
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
        return claimSocialPublication(client, context, workerId);
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
    const result = await (async () => {
      await verifyStoredSocialMediaRefs(claim.mediaRefs);
      return publishSocialJob(claim);
    })().catch(socialPublisherFailureFromThrown);
    await withSocialOperationsContext(
      legacyUserId,
      "manage",
      (client, context) =>
        completeSocialPublication(
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
      `[social-publication-worker] tick_failed code=${socialWorkerFailureCode(error)} retryInMs=${retryInMs}`,
    );
    await delay(retryInMs);
  }
}
await pool.end();
