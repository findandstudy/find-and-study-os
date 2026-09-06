import {
  normalizeSocialRuntimeId,
  resolveSocialPublicationGate,
} from "../lib/socialOperationsContract";
import { withSocialOperationsContext } from "../lib/socialOperationsStore";
import {
  claimSocialPublication,
  completeSocialPublication,
} from "../lib/socialPublicationQueue";
import {
  assertSocialPublisherConfiguration,
  publishSocialJob,
} from "../lib/socialPublisherAdapter";

const gate = resolveSocialPublicationGate({
  workerEnabled: process.env.SOCIAL_PUBLICATION_WORKER_ENABLED,
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
let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

while (!stopping) {
  const claim = await withSocialOperationsContext(
    legacyUserId,
    "manage",
    (client, context) => claimSocialPublication(client, context, workerId),
  );
  if (!claim) {
    await delay(2_000);
    continue;
  }
  const result = await publishSocialJob(claim);
  await withSocialOperationsContext(legacyUserId, "manage", (client, context) =>
    completeSocialPublication(
      client,
      context,
      claim,
      workerId,
      runtimeReleaseId,
      result,
    ),
  );
}
