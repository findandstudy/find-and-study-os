import type { PoolClient } from "pg";
import { pool } from "@workspace/db";
import {
  resolveSocialOperationsConfiguration,
  type SocialOperationsMode,
} from "./socialOperationsContract";

export { nextSocialId, socialHash } from "./socialOperationsContract";
import { nextSocialId, socialHash } from "./socialOperationsContract";

const ROLE_RE = /^[a-z_][a-z0-9_]{0,62}$/;

export type SocialOperationsContext = {
  tenantId: string;
  organizationId: string;
  legacyUserId: number;
  mode: Exclude<SocialOperationsMode, "off">;
};

export type SocialReceiptResult = Record<string, unknown>;

export async function findSocialOperationReplay(
  client: PoolClient,
  context: SocialOperationsContext,
  requestKey: string,
  payload: unknown,
): Promise<SocialReceiptResult | null> {
  const receipt = await client.query<{
    payload_sha256: string;
    result: SocialReceiptResult;
  }>(
    `SELECT payload_sha256,result FROM social_operation_receipts
     WHERE tenant_id=$1 AND organization_id=$2 AND request_key=$3`,
    [context.tenantId, context.organizationId, requestKey],
  );
  if (receipt.rowCount !== 1) return null;
  if (receipt.rows[0].payload_sha256 !== socialHash(payload))
    throw new Error("SOCIAL_IDEMPOTENCY_CONFLICT");
  return { ...receipt.rows[0].result, replay: true };
}

export async function appendSocialOperationReceipt(
  client: PoolClient,
  context: SocialOperationsContext,
  input: {
    operation: string;
    entityType: string;
    entityId: string;
    requestKey: string;
    payload: unknown;
    result: SocialReceiptResult;
  },
): Promise<void> {
  const serializedResult = JSON.stringify(input.result);
  if (Buffer.byteLength(serializedResult, "utf8") > 30_000)
    throw new Error("SOCIAL_RECEIPT_RESULT_TOO_LARGE");
  await client.query(
    `INSERT INTO social_operation_receipts
       (id,tenant_id,organization_id,actor_legacy_user_id,operation,entity_type,entity_id,request_key,payload_sha256,result,result_sha256)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,
    [
      nextSocialId(),
      context.tenantId,
      context.organizationId,
      context.legacyUserId,
      input.operation,
      input.entityType,
      input.entityId,
      input.requestKey,
      socialHash(input.payload),
      serializedResult,
      socialHash(input.result),
    ],
  );
}

export function socialOperationsConfiguration(): {
  enabled: boolean;
  mode: SocialOperationsMode;
  reason: string | null;
} {
  return resolveSocialOperationsConfiguration({
    configuredMode: process.env.SOCIAL_OPERATIONS_V1_MODE,
    nodeEnv: process.env.NODE_ENV,
    tenantId: process.env.SOCIAL_OPERATIONS_TENANT_ID,
    organizationId: process.env.SOCIAL_OPERATIONS_ORGANIZATION_ID,
  });
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {}
}

export async function withSocialOperationsContext<T>(
  legacyUserId: number,
  requiredMode: "read" | "manage",
  operation: (
    client: PoolClient,
    context: SocialOperationsContext,
  ) => Promise<T>,
): Promise<T> {
  if (!Number.isSafeInteger(legacyUserId) || legacyUserId <= 0)
    throw new Error("social_user_invalid");
  const state = socialOperationsConfiguration();
  if (!state.enabled || state.mode === "off")
    throw new Error(state.reason ?? "SOCIAL_OPERATIONS_DISABLED");
  if (requiredMode === "manage" && state.mode !== "manage")
    throw new Error("SOCIAL_OPERATIONS_READ_ONLY");
  const tenantId = process.env.SOCIAL_OPERATIONS_TENANT_ID!.toLowerCase();
  const organizationId =
    process.env.SOCIAL_OPERATIONS_ORGANIZATION_ID!.toLowerCase();
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query("SET LOCAL statement_timeout = '8000ms'");
    await client.query("SET LOCAL lock_timeout = '2500ms'");
    await client.query(
      "SET LOCAL idle_in_transaction_session_timeout = '12000ms'",
    );
    if (process.env.NODE_ENV === "production") {
      const expectedRole = process.env.SOCIAL_OPERATIONS_DB_EXECUTOR_ROLE;
      if (!expectedRole || !ROLE_RE.test(expectedRole))
        throw new Error("SOCIAL_OPERATIONS_EXECUTOR_CONFIGURATION_MISSING");
      const identity = await client.query<{
        current_user: string;
        rolsuper: boolean;
        rolbypassrls: boolean;
      }>(`
        SELECT current_user, rol.rolsuper, rol.rolbypassrls FROM pg_roles rol WHERE rol.rolname = current_user
      `);
      if (
        identity.rowCount !== 1 ||
        identity.rows[0].current_user !== expectedRole ||
        identity.rows[0].rolsuper ||
        identity.rows[0].rolbypassrls
      ) {
        throw new Error("SOCIAL_OPERATIONS_EXECUTOR_IDENTITY_INVALID");
      }
    }
    const settings = await client.query<{
      tenant_id: string;
      organization_id: string;
      legacy_user_id: string;
    }>(
      `
      SELECT set_config('app.tenant_id', $1, true) AS tenant_id,
             set_config('app.organization_id', $2, true) AS organization_id,
             set_config('app.legacy_user_id', $3, true) AS legacy_user_id
    `,
      [tenantId, organizationId, String(legacyUserId)],
    );
    if (
      settings.rowCount !== 1 ||
      settings.rows[0].tenant_id !== tenantId ||
      settings.rows[0].organization_id !== organizationId ||
      settings.rows[0].legacy_user_id !== String(legacyUserId)
    ) {
      throw new Error("SOCIAL_OPERATIONS_CONTEXT_NOT_SET");
    }
    const authority = await client.query(
      `
      SELECT 1
      FROM organizations organization
      JOIN tenants tenant ON tenant.id = organization.tenant_id
      JOIN users actor ON actor.id = $3 AND actor.is_active = true AND actor.deleted_at IS NULL
      WHERE organization.tenant_id = $1 AND organization.id = $2
        AND organization.status = 'ACTIVE' AND tenant.status = 'ACTIVE'
    `,
      [tenantId, organizationId, legacyUserId],
    );
    if (authority.rowCount !== 1)
      throw new Error("SOCIAL_OPERATIONS_SCOPE_UNAVAILABLE");
    const context: SocialOperationsContext = {
      tenantId,
      organizationId,
      legacyUserId,
      mode: state.mode,
    };
    const result = await operation(client, context);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}
