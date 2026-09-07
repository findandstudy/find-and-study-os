/**
 * Inbox invariant test suite.
 *
 * Companion to test-webhook-dedup.ts (which covers the *concurrent* dedup
 * race). This suite locks down the remaining inbox guarantees that are easy
 * to silently regress:
 *
 *   (a) duplicate webhook delivery (sequential) returns the same
 *       conversation/message ids and reports `duplicate: true`.
 *   (c) identityResolver returns:
 *         - "strong"    when exactly one lead/student/agent matches by
 *           normalized phone or email.
 *         - "ambiguous" when multiple matches exist.
 *         - "none"      when no candidate is found.
 *   (d) verifyWhatsAppSignature rejects unsigned, missing-secret, and
 *       tampered HMAC payloads (timing-safe), and accepts a valid one.
 *       The webhooks route is also exercised end-to-end through Express
 *       to confirm a bad signature returns HTTP 401.
 *   (e) verifyWebFormSignature rejects bad/missing signatures when a
 *       secret is configured, and the webhooks route returns HTTP 401
 *       for posts missing both the X-Webform-Signature header and the
 *       secret_token body field.
 *
 * Pure unit checks run with no DB writes; route-level checks set up and
 * tear down their own integration rows so the test is safe to run against
 * a shared dev database.
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run test:inbox-suite
 *   # or:
 *   pnpm --filter @workspace/api-server exec tsx ./scripts/test-inbox-suite.ts
 */
import crypto from "crypto";
import http from "http";
import express, { type Express } from "express";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import {
  db,
  leadsTable,
  externalContactsTable,
  conversationsTable,
  messagesTable,
  channelAccountsTable,
  integrationsTable,
  notificationsTable,
} from "@workspace/db";

import {
  processInboundMessage,
  type InboundResult,
} from "../src/lib/inbox/processInbound";
import { resolveIdentity } from "../src/lib/inbox/identityResolver";
import { verifyWhatsAppSignature } from "../src/lib/inbox/channels/whatsapp";
import { verifyWebFormSignature } from "../src/lib/inbox/channels/webForm";
import { encryptConfig } from "../src/lib/encryption";
import { ensureRateLimitsTable } from "../src/lib/pgRateLimiter";
import webhooksRouter from "../src/routes/webhooks";

const RUN_ID = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

interface Section {
  name: string;
  ok: boolean;
  details: string[];
}

function assert(cond: boolean, msg: string, details: string[]): boolean {
  details.push(`${cond ? "OK   " : "FAIL "} ${msg}`);
  return cond;
}

// ---------------------------------------------------------------------------
// (a) Duplicate sequential webhook delivery
// ---------------------------------------------------------------------------

async function ensureChannelAccount(
  channel: string,
  displayName: string,
  externalAccountId: string,
): Promise<{ id: number; created: boolean }> {
  const [existing] = await db
    .select()
    .from(channelAccountsTable)
    .where(
      and(
        eq(channelAccountsTable.channel, channel),
        eq(channelAccountsTable.externalAccountId, externalAccountId),
      ),
    );
  if (existing) return { id: existing.id, created: false };
  const [created] = await db
    .insert(channelAccountsTable)
    .values({ channel, displayName, externalAccountId, status: "active" })
    .returning();
  return { id: created.id, created: true };
}

async function testDuplicateDelivery(): Promise<Section> {
  const details: string[] = [];
  let ok = true;
  const channel = "whatsapp";
  const externalAccountId = `wa_phoneid_dup_${RUN_ID}`;
  const externalMessageId = `wamid.DUP_${RUN_ID}`;
  const phone = `+15555${RUN_ID.slice(0, 6).replace(/[^0-9]/g, "0").padEnd(6, "0")}`;
  const externalThreadId = phone;
  const externalContactId = phone;

  let acctId = 0;
  let acctCreated = false;
  let convIdsToClean: number[] = [];
  try {
    const acct = await ensureChannelAccount(
      channel,
      "WhatsApp Business (sequential dup test)",
      externalAccountId,
    );
    acctId = acct.id;
    acctCreated = acct.created;

    const payload = {
      channel,
      channelAccountId: acctId,
      contact: {
        externalId: externalContactId,
        displayName: `Dup Test ${RUN_ID}`,
        phone,
      },
      message: {
        externalMessageId,
        text: "duplicate-delivery test message",
        externalThreadId,
        receivedAt: new Date(),
      },
    };

    const first = (await processInboundMessage(payload)) as InboundResult;
    const second = (await processInboundMessage(payload)) as InboundResult;

    convIdsToClean = [first.conversationId, second.conversationId].filter(
      (n, i, a) => n > 0 && a.indexOf(n) === i,
    );

    ok =
      assert(
        first.duplicate === false,
        `first delivery reports duplicate=false (got ${first.duplicate})`,
        details,
      ) && ok;
    ok =
      assert(
        second.duplicate === true,
        `second (sequential) delivery reports duplicate=true (got ${second.duplicate})`,
        details,
      ) && ok;
    ok =
      assert(
        first.conversationId === second.conversationId && first.conversationId > 0,
        `both deliveries return the same conversationId (a=${first.conversationId}, b=${second.conversationId})`,
        details,
      ) && ok;
    ok =
      assert(
        first.messageId === second.messageId && first.messageId > 0,
        `both deliveries return the same messageId (a=${first.messageId}, b=${second.messageId})`,
        details,
      ) && ok;
    ok =
      assert(
        first.externalContactId === second.externalContactId &&
          first.externalContactId > 0,
        `both deliveries return the same externalContactId (a=${first.externalContactId}, b=${second.externalContactId})`,
        details,
      ) && ok;

    const msgRows = await db
      .select({ id: messagesTable.id })
      .from(messagesTable)
      .where(
        and(
          eq(messagesTable.channel, channel),
          eq(messagesTable.externalMessageId, externalMessageId),
        ),
      );
    ok =
      assert(
        msgRows.length === 1,
        `messages table has exactly 1 row for dedup key — found ${msgRows.length}`,
        details,
      ) && ok;
  } catch (err) {
    ok = false;
    details.push(
      `FAIL  scenario threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    try {
      if (convIdsToClean.length > 0) {
        for (const t of ["inbox.new_message", "inbox.unmatched"] as const) {
          await db
            .delete(notificationsTable)
            .where(
              and(
                eq(notificationsTable.type, t),
                inArray(
                  sql`(${notificationsTable.data}->>'conversationId')::int`,
                  convIdsToClean,
                ),
              ),
            );
        }
      }
      await db
        .delete(messagesTable)
        .where(
          and(
            eq(messagesTable.channel, channel),
            eq(messagesTable.externalMessageId, externalMessageId),
          ),
        );
      if (convIdsToClean.length > 0) {
        await db
          .delete(conversationsTable)
          .where(inArray(conversationsTable.id, convIdsToClean));
      }
      await db
        .delete(externalContactsTable)
        .where(
          and(
            eq(externalContactsTable.channel, channel),
            eq(externalContactsTable.externalId, externalContactId),
          ),
        );
      if (acctCreated && acctId > 0) {
        await db
          .delete(channelAccountsTable)
          .where(eq(channelAccountsTable.id, acctId));
      }
    } catch (cleanupErr) {
      details.push(
        `WARN cleanup error (non-fatal): ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
      );
    }
  }

  return { name: "(a) duplicate sequential webhook delivery", ok, details };
}

// ---------------------------------------------------------------------------
// (c) identityResolver outcomes
// ---------------------------------------------------------------------------

async function testIdentityResolver(): Promise<Section> {
  const details: string[] = [];
  let ok = true;

  // Use unique phones/emails namespaced to RUN_ID so we don't collide with
  // any existing seed/dev data. We pick Turkish mobile numbers (+90 53x ...)
  // because libphonenumber-js considers them valid and the inbox phone
  // helper defaults to country=TR; synthetic NANP/UK numbers in fictional
  // ranges are flagged invalid by libphonenumber and would silently
  // short-circuit the resolver to "none".
  const hashDigits = (input: string, n: number): string => {
    const hex = crypto.createHash("sha256").update(input).digest("hex");
    let out = "";
    for (const ch of hex) {
      if (out.length >= n) break;
      if (/[0-9]/.test(ch)) out += ch;
    }
    return out.padEnd(n, "0");
  };
  // TR mobile: +90 5XX XXX XXXX -> 10 digits after +90 starting with 5.
  const tag = hashDigits(RUN_ID, 7);
  const strongPhone = `+90531${tag}`;
  const ambigPhone = `+90532${tag}`;
  const nonePhone = `+90533${tag}`;
  const strongEmail = `strong_${RUN_ID}@inbox.test`;
  const noneEmail = `none_${RUN_ID}@inbox.test`;

  const createdLeadIds: number[] = [];
  try {
    // Strong: exactly one lead with this phone.
    const [strongLead] = await db
      .insert(leadsTable)
      .values({
        firstName: "Strong",
        lastName: `Match_${RUN_ID}`,
        email: strongEmail,
        phone: strongPhone,
        phoneE164: strongPhone,
        status: "new",
        source: "inbox-test",
      })
      .returning({ id: leadsTable.id });
    if (strongLead) createdLeadIds.push(strongLead.id);

    // Ambiguous: two leads sharing the same phone.
    const ambig = await db
      .insert(leadsTable)
      .values([
        {
          firstName: "Ambig1",
          lastName: `Match_${RUN_ID}`,
          phone: ambigPhone,
          phoneE164: ambigPhone,
          status: "new",
          source: "inbox-test",
        },
        {
          firstName: "Ambig2",
          lastName: `Match_${RUN_ID}`,
          phone: ambigPhone,
          phoneE164: ambigPhone,
          status: "new",
          source: "inbox-test",
        },
      ])
      .returning({ id: leadsTable.id });
    for (const r of ambig) createdLeadIds.push(r.id);

    const strongRes = await resolveIdentity({ phone: strongPhone });
    ok =
      assert(
        strongRes.outcome === "strong" && strongRes.candidates.length === 1,
        `strong: outcome=strong with 1 candidate (got ${strongRes.outcome}, n=${strongRes.candidates.length})`,
        details,
      ) && ok;
    if (strongRes.outcome === "strong") {
      const c = strongRes.candidates[0];
      ok =
        assert(
          c.type === "lead" && c.id === createdLeadIds[0],
          `strong candidate matches inserted lead (type=${c.type}, id=${c.id})`,
          details,
        ) && ok;
    }

    const ambigRes = await resolveIdentity({ phone: ambigPhone });
    ok =
      assert(
        ambigRes.outcome === "ambiguous" && ambigRes.candidates.length >= 2,
        `ambiguous: outcome=ambiguous with >=2 candidates (got ${ambigRes.outcome}, n=${ambigRes.candidates.length})`,
        details,
      ) && ok;

    const noneRes = await resolveIdentity({
      phone: nonePhone,
      email: noneEmail,
    });
    ok =
      assert(
        noneRes.outcome === "none" && noneRes.candidates.length === 0,
        `none: outcome=none with 0 candidates (got ${noneRes.outcome}, n=${noneRes.candidates.length})`,
        details,
      ) && ok;

    // Empty inputs short-circuit to "none" without DB queries.
    const emptyRes = await resolveIdentity({ phone: null, email: null });
    ok =
      assert(
        emptyRes.outcome === "none" && emptyRes.candidates.length === 0,
        `empty: outcome=none with 0 candidates (got ${emptyRes.outcome}, n=${emptyRes.candidates.length})`,
        details,
      ) && ok;

    // Email-based strong resolution exercises the email branch.
    const emailStrongRes = await resolveIdentity({ email: strongEmail });
    ok =
      assert(
        emailStrongRes.outcome === "strong" &&
          emailStrongRes.candidates.length === 1 &&
          emailStrongRes.candidates[0].id === createdLeadIds[0],
        `strong (email): outcome=strong matching the inserted lead (got ${emailStrongRes.outcome}, n=${emailStrongRes.candidates.length})`,
        details,
      ) && ok;
  } catch (err) {
    ok = false;
    details.push(
      `FAIL  scenario threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    try {
      if (createdLeadIds.length > 0) {
        await db
          .delete(leadsTable)
          .where(inArray(leadsTable.id, createdLeadIds));
      }
      // Defensive: clean any leads tagged with this RUN_ID even if returning
      // didn't capture them (e.g., partial insert failure).
      await db
        .delete(leadsTable)
        .where(like(leadsTable.lastName, `Match_${RUN_ID}`));
    } catch (cleanupErr) {
      details.push(
        `WARN cleanup error (non-fatal): ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
      );
    }
  }

  return { name: "(c) identity resolver outcomes", ok, details };
}

// ---------------------------------------------------------------------------
// (d) WhatsApp HMAC verification — unit + route
// ---------------------------------------------------------------------------

function testWhatsAppSignatureUnit(): Section {
  const details: string[] = [];
  let ok = true;

  const secret = "wa_app_secret_for_test";
  const body = Buffer.from(JSON.stringify({ entry: [{ id: "test" }] }), "utf8");
  const validSig =
    "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");

  ok =
    assert(
      verifyWhatsAppSignature(body, validSig, secret) === true,
      "valid sha256 signature with matching secret accepted",
      details,
    ) && ok;
  ok =
    assert(
      verifyWhatsAppSignature(body, undefined, secret) === false,
      "missing signature header rejected",
      details,
    ) && ok;
  ok =
    assert(
      verifyWhatsAppSignature(body, validSig, undefined) === false,
      "missing app secret rejected (defense in depth)",
      details,
    ) && ok;

  // Tampering: same length but different hex.
  const tampered = "sha256=" + "0".repeat(validSig.length - "sha256=".length);
  ok =
    assert(
      verifyWhatsAppSignature(body, tampered, secret) === false,
      "tampered signature (same length, wrong hex) rejected",
      details,
    ) && ok;

  // Wrong-length signatures must not throw — timingSafeEqual would otherwise.
  ok =
    assert(
      verifyWhatsAppSignature(body, "sha256=deadbeef", secret) === false,
      "short/garbage signature rejected without throwing",
      details,
    ) && ok;

  // Body-level tampering invalidates an otherwise-valid header.
  const tamperedBody = Buffer.from(body.toString("utf8") + " ", "utf8");
  ok =
    assert(
      verifyWhatsAppSignature(tamperedBody, validSig, secret) === false,
      "modified body rejected (header was for original body)",
      details,
    ) && ok;

  return { name: "(d) WhatsApp HMAC verifier (unit)", ok, details };
}

// ---------------------------------------------------------------------------
// (e) Web Form signature/secret_token — unit
// ---------------------------------------------------------------------------

function testWebFormSignatureUnit(): Section {
  const details: string[] = [];
  let ok = true;

  const secret = "wf_shared_secret_for_test";
  const body = Buffer.from('{"name":"x","message":"y"}', "utf8");
  const validSig = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("hex");

  ok =
    assert(
      verifyWebFormSignature(body, validSig, secret) === true,
      "valid sha256 signature with matching secret accepted",
      details,
    ) && ok;
  ok =
    assert(
      verifyWebFormSignature(body, undefined, secret) === false,
      "missing signature header rejected when secret is configured",
      details,
    ) && ok;
  ok =
    assert(
      verifyWebFormSignature(body, "not_a_real_sig", secret) === false,
      "garbage signature rejected without throwing",
      details,
    ) && ok;
  // The reusable verifier must fail closed on its own; callers must not need a
  // second route-level guard to make an unconfigured secret safe.
  ok =
    assert(
      verifyWebFormSignature(body, undefined, undefined) === false,
      "no secret configured -> verifier fails closed",
      details,
    ) && ok;

  return { name: "(e) Web Form signature verifier (unit)", ok, details };
}

// ---------------------------------------------------------------------------
// Route-level integration tests for (d) and (e).
// We stand up a tiny Express app that mounts the same webhooksRouter used
// in production, with a temporary integrations row holding our test secret.
// ---------------------------------------------------------------------------

interface RouteServer {
  url: string;
  close: () => Promise<void>;
}

async function startRouteServer(): Promise<RouteServer> {
  await ensureRateLimitsTable();
  const app: Express = express();
  app.use("/api", webhooksRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Could not bind test server");
  }
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve) =>
        server.close(() => resolve()),
      ),
  };
}

async function withIntegration<T>(
  key: string,
  name: string,
  category: string,
  config: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  // Snapshot any existing row so we restore it byte-for-byte on teardown.
  const [existing] = await db
    .select()
    .from(integrationsTable)
    .where(eq(integrationsTable.key, key));
  if (existing) {
    await db
      .update(integrationsTable)
      .set({ isEnabled: true, config: encryptConfig(config) })
      .where(eq(integrationsTable.id, existing.id));
  } else {
    await db.insert(integrationsTable).values({
      key,
      name,
      category,
      isEnabled: true,
      config: encryptConfig(config),
    });
  }
  try {
    return await fn();
  } finally {
    if (existing) {
      await db
        .update(integrationsTable)
        .set({ isEnabled: existing.isEnabled, config: existing.config })
        .where(eq(integrationsTable.id, existing.id));
    } else {
      await db.delete(integrationsTable).where(eq(integrationsTable.key, key));
    }
  }
}

async function testWhatsAppRouteRejectsBadSignature(
  url: string,
): Promise<Section> {
  const details: string[] = [];
  let ok = true;
  const secret = `wa_app_secret_${RUN_ID}`;
  await withIntegration(
    "whatsapp",
    "WhatsApp",
    "communication",
    {
      phoneNumberId: `wa_pnid_${RUN_ID}`,
      accessToken: "test-access-token",
      appSecret: secret,
    },
    async () => {
      const body = JSON.stringify({ entry: [{ changes: [] }] });

      // No signature header -> 401.
      const noSigRes = await fetch(`${url}/api/webhooks/whatsapp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      ok =
        assert(
          noSigRes.status === 401,
          `POST without signature returns 401 (got ${noSigRes.status})`,
          details,
        ) && ok;

      // Bad signature -> 401.
      const badRes = await fetch(`${url}/api/webhooks/whatsapp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Hub-Signature-256": "sha256=" + "0".repeat(64),
        },
        body,
      });
      ok =
        assert(
          badRes.status === 401,
          `POST with bad signature returns 401 (got ${badRes.status})`,
          details,
        ) && ok;

      // Valid signature -> 200 (no messages, processed=0).
      const validSig =
        "sha256=" +
        crypto.createHmac("sha256", secret).update(body).digest("hex");
      const okRes = await fetch(`${url}/api/webhooks/whatsapp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Hub-Signature-256": validSig,
        },
        body,
      });
      ok =
        assert(
          okRes.status === 200,
          `POST with valid signature returns 200 (got ${okRes.status})`,
          details,
        ) && ok;
    },
  );
  return { name: "(d) WhatsApp webhook route signature gate", ok, details };
}

async function testMetaRoute(url: string): Promise<Section> {
  const details: string[] = [];
  let ok = true;
  const secret = `meta_app_secret_${RUN_ID}`;
  const verifyToken = `meta_verify_${RUN_ID}`;
  const psid = `psid_${RUN_ID}`;
  const igsid = `igsid_${RUN_ID}`;
  const createdConvIds: number[] = [];

  const sign = (body: string) =>
    "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");

  await withIntegration(
    "facebook_messenger",
    "Facebook Messenger",
    "communication",
    { pageId: `page_${RUN_ID}`, appSecret: secret, webhookVerifyToken: verifyToken },
    async () => {
      await withIntegration(
        "instagram",
        "Instagram",
        "communication",
        { igBusinessAccountId: `ig_${RUN_ID}`, appSecret: secret, webhookVerifyToken: verifyToken },
        async () => {
          // (1) GET verify handshake — correct token echoes the challenge.
          const goodVerify = await fetch(
            `${url}/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(verifyToken)}&hub.challenge=meta_challenge_123`,
          );
          const challengeBody = await goodVerify.text();
          ok = assert(goodVerify.status === 200 && challengeBody === "meta_challenge_123",
            `GET verify with correct token returns challenge (got ${goodVerify.status}, body="${challengeBody}")`, details) && ok;

          // (2) GET verify handshake — wrong token is rejected.
          const badVerify = await fetch(
            `${url}/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x`,
          );
          ok = assert(badVerify.status === 403,
            `GET verify with wrong token returns 403 (got ${badVerify.status})`, details) && ok;

          // (3) POST without signature -> 401.
          const noSigBody = JSON.stringify({ object: "page", entry: [] });
          const noSig = await fetch(`${url}/api/webhooks/meta`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: noSigBody,
          });
          ok = assert(noSig.status === 401,
            `POST without signature returns 401 (got ${noSig.status})`, details) && ok;

          // (4) POST with bad signature -> 401.
          const badSig = await fetch(`${url}/api/webhooks/meta`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Hub-Signature-256": "sha256=" + "0".repeat(64) },
            body: noSigBody,
          });
          ok = assert(badSig.status === 401,
            `POST with bad signature returns 401 (got ${badSig.status})`, details) && ok;

          // (5) POST valid sig, empty entries -> 200 processed=0.
          const emptyOk = await fetch(`${url}/api/webhooks/meta`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sign(noSigBody) },
            body: noSigBody,
          });
          ok = assert(emptyOk.status === 200,
            `POST valid sig with empty entries returns 200 (got ${emptyOk.status})`, details) && ok;

          // (6) Messenger inbound creates a conversation under "messenger".
          const msgrMid = `m_mid_${RUN_ID}`;
          const messengerBody = JSON.stringify({
            object: "page",
            entry: [{
              id: `page_${RUN_ID}`,
              time: Date.now(),
              messaging: [{
                sender: { id: psid },
                recipient: { id: `page_${RUN_ID}` },
                timestamp: Date.now(),
                message: { mid: msgrMid, text: "hello from messenger" },
              }],
            }],
          });
          const msgrRes = await fetch(`${url}/api/webhooks/meta`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sign(messengerBody) },
            body: messengerBody,
          });
          const msgrJson = (await msgrRes.json().catch(() => ({}))) as { processed?: number };
          ok = assert(msgrRes.status === 200 && msgrJson.processed === 1,
            `Messenger inbound processed=1 (got ${msgrRes.status}, processed=${msgrJson.processed})`, details) && ok;

          // Verify the message landed under the messenger channel.
          const [msgrMsg] = await db.select().from(messagesTable)
            .where(and(eq(messagesTable.channel, "messenger"), eq(messagesTable.externalMessageId, msgrMid)));
          ok = assert(Boolean(msgrMsg),
            `Messenger message persisted under channel=messenger`, details) && ok;
          if (msgrMsg) createdConvIds.push(msgrMsg.conversationId);

          // (7) Re-post the same Messenger message id -> idempotent (no new row).
          await fetch(`${url}/api/webhooks/meta`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sign(messengerBody) },
            body: messengerBody,
          });
          const msgrRows = await db.select().from(messagesTable)
            .where(and(eq(messagesTable.channel, "messenger"), eq(messagesTable.externalMessageId, msgrMid)));
          ok = assert(msgrRows.length === 1,
            `Duplicate Messenger delivery does not create a second row (count=${msgrRows.length})`, details) && ok;

          // (8) Instagram inbound creates a conversation under "instagram".
          const igMid = `ig_mid_${RUN_ID}`;
          const instagramBody = JSON.stringify({
            object: "instagram",
            entry: [{
              id: `ig_${RUN_ID}`,
              time: Date.now(),
              messaging: [{
                sender: { id: igsid },
                recipient: { id: `ig_${RUN_ID}` },
                timestamp: Date.now(),
                message: { mid: igMid, text: "hi from instagram" },
              }],
            }],
          });
          const igRes = await fetch(`${url}/api/webhooks/meta`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sign(instagramBody) },
            body: instagramBody,
          });
          const igJson = (await igRes.json().catch(() => ({}))) as { processed?: number };
          ok = assert(igRes.status === 200 && igJson.processed === 1,
            `Instagram inbound processed=1 (got ${igRes.status}, processed=${igJson.processed})`, details) && ok;
          const [igMsg] = await db.select().from(messagesTable)
            .where(and(eq(messagesTable.channel, "instagram"), eq(messagesTable.externalMessageId, igMid)));
          ok = assert(Boolean(igMsg),
            `Instagram message persisted under channel=instagram`, details) && ok;
          if (igMsg) createdConvIds.push(igMsg.conversationId);

          // (9) Unknown object type is acknowledged and skipped.
          const unknownBody = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
          const unknownRes = await fetch(`${url}/api/webhooks/meta`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sign(unknownBody) },
            body: unknownBody,
          });
          ok = assert(unknownRes.status === 200,
            `Unknown object type returns 200 and skips (got ${unknownRes.status})`, details) && ok;

          // Cleanup rows created by this test.
          try {
            const convIds = createdConvIds.filter((n) => n > 0);
            if (convIds.length > 0) {
              for (const t of ["inbox.new_message", "inbox.unmatched"] as const) {
                await db.delete(notificationsTable).where(and(
                  eq(notificationsTable.type, t),
                  inArray(sql`(${notificationsTable.data}->>'conversationId')::int`, convIds),
                ));
              }
              await db.delete(messagesTable).where(inArray(messagesTable.conversationId, convIds));
              await db.delete(conversationsTable).where(inArray(conversationsTable.id, convIds));
            }
            await db.delete(externalContactsTable).where(and(
              eq(externalContactsTable.channel, "messenger"), eq(externalContactsTable.externalId, psid)));
            await db.delete(externalContactsTable).where(and(
              eq(externalContactsTable.channel, "instagram"), eq(externalContactsTable.externalId, igsid)));
            await db.delete(channelAccountsTable).where(and(
              eq(channelAccountsTable.channel, "messenger"), eq(channelAccountsTable.externalAccountId, `page_${RUN_ID}`)));
            await db.delete(channelAccountsTable).where(and(
              eq(channelAccountsTable.channel, "instagram"), eq(channelAccountsTable.externalAccountId, `ig_${RUN_ID}`)));
          } catch (cleanupErr) {
            details.push(`WARN cleanup error (non-fatal): ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
          }
        },
      );
    },
  );
  return { name: "(f) Meta webhook route (Messenger + Instagram)", ok, details };
}

async function testWebFormRouteRejectsBadToken(
  url: string,
): Promise<Section> {
  const details: string[] = [];
  let ok = true;
  const secret = `wf_secret_${RUN_ID}`;
  const formId = `form_${RUN_ID}`;
  await withIntegration(
    "web_form",
    "Web Form",
    "communication",
    { secret, formId },
    async () => {
      const submission = {
        name: "Sig Test",
        email: `sigtest_${RUN_ID}@inbox.test`,
        message: "hello",
      };
      const body = JSON.stringify(submission);

      // No token, no signature -> 401.
      const noAuth = await fetch(`${url}/api/webhooks/web-form`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      ok =
        assert(
          noAuth.status === 401,
          `POST without token/signature returns 401 (got ${noAuth.status})`,
          details,
        ) && ok;

      // Wrong token -> 401.
      const wrongTok = await fetch(`${url}/api/webhooks/web-form`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webform-Token": "definitely-not-the-secret",
        },
        body,
      });
      ok =
        assert(
          wrongTok.status === 401,
          `POST with wrong token returns 401 (got ${wrongTok.status})`,
          details,
        ) && ok;

      // Bad signature -> 401.
      const badSig = await fetch(`${url}/api/webhooks/web-form`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webform-Signature": "0".repeat(64),
        },
        body,
      });
      ok =
        assert(
          badSig.status === 401,
          `POST with bad HMAC signature returns 401 (got ${badSig.status})`,
          details,
        ) && ok;

      // Body-field secret_token is NO LONGER accepted as an authenticator
      // (it ships inside public HTML and provides no real authentication) -> 401.
      const tokenInBody = JSON.stringify({ ...submission, secret_token: secret });
      const bodyTokRes = await fetch(`${url}/api/webhooks/web-form`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: tokenInBody,
      });
      ok =
        assert(
          bodyTokRes.status === 401,
          `POST with secret_token in body returns 401 (got ${bodyTokRes.status})`,
          details,
        ) && ok;

      // Valid X-Webform-Token header (server-to-server credential) -> 200.
      const okRes = await fetch(`${url}/api/webhooks/web-form`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Webform-Token": secret },
        body,
      });
      let okResStatusOk = okRes.status === 200;
      ok =
        assert(
          okResStatusOk,
          `POST with valid X-Webform-Token header returns 200 (got ${okRes.status})`,
          details,
        ) && ok;
      let createdConvId = 0;
      if (okResStatusOk) {
        try {
          const json = (await okRes.json()) as { conversationId?: number };
          if (typeof json.conversationId === "number") {
            createdConvId = json.conversationId;
          }
        } catch {
          // ignore
        }
      }

      // Valid HMAC header -> 200. We use a different message body so it
      // doesn't collide on the same web_form dedup hash bucket.
      const submission2 = { ...submission, message: "second test" };
      const body2 = JSON.stringify(submission2);
      const validSig = crypto
        .createHmac("sha256", secret)
        .update(body2)
        .digest("hex");
      const okSig = await fetch(`${url}/api/webhooks/web-form`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webform-Signature": validSig,
        },
        body: body2,
      });
      let okSigStatusOk = okSig.status === 200;
      ok =
        assert(
          okSigStatusOk,
          `POST with valid HMAC signature returns 200 (got ${okSig.status})`,
          details,
        ) && ok;
      let createdConvId2 = 0;
      if (okSigStatusOk) {
        try {
          const json = (await okSig.json()) as { conversationId?: number };
          if (typeof json.conversationId === "number") {
            createdConvId2 = json.conversationId;
          }
        } catch {
          // ignore
        }
      }

      // Cleanup the rows our successful posts created so the test is
      // idempotent against repeated runs.
      try {
        const convIds = [createdConvId, createdConvId2].filter((n) => n > 0);
        if (convIds.length > 0) {
          for (const t of ["inbox.new_message", "inbox.unmatched"] as const) {
            await db
              .delete(notificationsTable)
              .where(
                and(
                  eq(notificationsTable.type, t),
                  inArray(
                    sql`(${notificationsTable.data}->>'conversationId')::int`,
                    convIds,
                  ),
                ),
              );
          }
          await db
            .delete(messagesTable)
            .where(inArray(messagesTable.conversationId, convIds));
          await db
            .delete(conversationsTable)
            .where(inArray(conversationsTable.id, convIds));
        }
        await db
          .delete(externalContactsTable)
          .where(
            and(
              eq(externalContactsTable.channel, "web_form"),
              eq(externalContactsTable.email, submission.email),
            ),
          );
        await db
          .delete(channelAccountsTable)
          .where(
            and(
              eq(channelAccountsTable.channel, "web_form"),
              eq(channelAccountsTable.externalAccountId, formId),
            ),
          );
      } catch (cleanupErr) {
        details.push(
          `WARN cleanup error (non-fatal): ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
        );
      }
    },
  );
  return { name: "(e) Web Form webhook route secret/token gate", ok, details };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`[inbox-suite] starting run ${RUN_ID}`);

  const sections: Section[] = [];

  // Pure unit checks first — fast, no DB.
  sections.push(testWhatsAppSignatureUnit());
  sections.push(testWebFormSignatureUnit());

  // DB-backed scenarios.
  sections.push(await testDuplicateDelivery());
  sections.push(await testIdentityResolver());

  // Route-level checks share one ephemeral server.
  const server = await startRouteServer();
  try {
    sections.push(await testWhatsAppRouteRejectsBadSignature(server.url));
    sections.push(await testMetaRoute(server.url));
    sections.push(await testWebFormRouteRejectsBadToken(server.url));
  } finally {
    await server.close();
  }

  let allOk = true;
  for (const s of sections) {
    console.log(`\n=== ${s.name} ${s.ok ? "PASS" : "FAIL"} ===`);
    for (const d of s.details) console.log("  " + d);
    if (!s.ok) allOk = false;
  }

  console.log(`\n[inbox-suite] ${allOk ? "PASS" : "FAIL"} (run ${RUN_ID})`);
  // pool.end() would hang because eventBus holds an open LISTEN client for
  // the lifetime of the process; process.exit() tears everything down cleanly.
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error("[inbox-suite] unexpected error:", err);
  process.exit(1);
});
