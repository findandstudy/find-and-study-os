/**
 * AI Agent admin panel (FAZ 2) — route-level integration test.
 *
 * Covers the admin-only endpoints added to the inbox router:
 *   - GET  /inbox/ai-agent/config
 *   - GET  /inbox/ai-agent/models
 *   - PUT  /inbox/ai-agent/config
 *   - POST /inbox/ai-agent/test
 *
 * Scenarios:
 *   1. non-admin (student/agent/staff) → 403 on all three endpoints.
 *   2. admin GET → 200 with a config payload.
 *   3. admin PUT with an invalid patch (temperature out of range) → 400.
 *   4. admin PUT with a valid patch → 200, persisted + merged.
 *   5. admin POST /test → 200, returns the would-be reply WITHOUT sending
 *      (the bot SEND override is asserted to never be called).
 *
 * The canonical default bot configuration is snapshotted and restored.
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run test:ai-agent-admin
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import express, { type Express, type Request } from "express";
import { eq } from "drizzle-orm";
import { aiBotsTable, db } from "@workspace/db";

import inboxRouter from "../src/routes/inbox.js";
import {
  __setBotReplyOverrideForTests,
  __setBotSendOverrideForTests,
} from "../src/lib/inbox/botAutoReply.js";

const RUN_ID = `aaa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

// Mutable user injected per-request (no real auth stack).
let currentUser: {
  id: number;
  role: string;
  isActive: boolean;
} = { id: 999000, role: "admin", isActive: true };

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: typeof currentUser }).user = currentUser;
    next();
  });
  app.use("/api", inboxRouter);
  return app;
}

const app = buildApp();

async function apiReq(
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  const server = http.createServer(app as unknown as (req: Request, res: unknown) => void);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("listen failed");
  const port = addr.port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { status: res.status, data };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// Snapshot the canonical default bot so test writes cannot leak into another
// suite or a developer's local configuration.
let originalBot: typeof aiBotsTable.$inferSelect | undefined;

after(async () => {
  __setBotReplyOverrideForTests(null);
  __setBotSendOverrideForTests(null);
  if (originalBot) {
    await db
      .update(aiBotsTable)
      .set({
        configEncrypted: originalBot.configEncrypted,
      })
      .where(eq(aiBotsTable.id, originalBot.id));
  }
  setImmediate(() => process.exit(process.exitCode ?? 0));
});

test("snapshot default AI bot configuration", async () => {
  const [row] = await db
    .select()
    .from(aiBotsTable)
    .where(eq(aiBotsTable.isDefault, true))
    .limit(1);
  assert.ok(row, "a canonical default AI bot must exist for route integration tests");
  originalBot = row;
});

// ---------------------------------------------------------------------------
// 1. Non-admins get 403 on every endpoint.
// ---------------------------------------------------------------------------
for (const role of ["student", "agent", "sub_agent", "staff", "agent_staff"]) {
  test(`non-admin (${role}) → 403 on all ai-agent endpoints`, async () => {
    currentUser = { id: 999001, role, isActive: true };
    const get = await apiReq("GET", "/inbox/ai-agent/config");
    assert.equal(get.status, 403, `GET should 403 for ${role}`);
    const models = await apiReq("GET", "/inbox/ai-agent/models");
    assert.equal(models.status, 403, `models GET should 403 for ${role}`);
    const put = await apiReq("PUT", "/inbox/ai-agent/config", { enabled: false });
    assert.equal(put.status, 403, `PUT should 403 for ${role}`);
    const post = await apiReq("POST", "/inbox/ai-agent/test", { message: "hi" });
    assert.equal(post.status, 403, `POST should 403 for ${role}`);
  });
}

// ---------------------------------------------------------------------------
// 2. Admin GET returns the config.
// ---------------------------------------------------------------------------
test("admin GET /inbox/ai-agent/config → 200 with config", async () => {
  currentUser = { id: 999000, role: "admin", isActive: true };
  const res = await apiReq("GET", "/inbox/ai-agent/config");
  assert.equal(res.status, 200);
  assert.ok(res.data.config, "config present");
  assert.equal(typeof res.data.config.enabled, "boolean");
  assert.equal(typeof res.data.config.model, "string");
  assert.ok(res.data.config.escalationKeywords, "escalationKeywords present");
});

// ---------------------------------------------------------------------------
// 3. Admin PUT with an invalid patch → 400 (validation).
// ---------------------------------------------------------------------------
test("admin PUT with invalid patch → 400", async () => {
  currentUser = { id: 999000, role: "admin", isActive: true };
  // temperature is constrained to 0–2; 9 must be rejected.
  const res = await apiReq("PUT", "/inbox/ai-agent/config", { temperature: 9 });
  assert.equal(res.status, 400, "out-of-range temperature should 400");

  // negative maxConsecutiveReplies rejected
  const res2 = await apiReq("PUT", "/inbox/ai-agent/config", { maxConsecutiveReplies: -5 });
  assert.equal(res2.status, 400, "negative threshold should 400");
});

// ---------------------------------------------------------------------------
// 4. Admin PUT with a safe patch → 200 and persists.
// ---------------------------------------------------------------------------
test("admin PUT with valid patch → 200 and persists", async () => {
  currentUser = { id: 999000, role: "admin", isActive: true };
  const customKb = `KB_${RUN_ID} brand brain body`;
  const res = await apiReq("PUT", "/inbox/ai-agent/config", {
    maxConsecutiveReplies: 7,
    knowledgeBase: customKb,
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.config.maxConsecutiveReplies, 7);
  assert.equal(res.data.config.knowledgeBase, customKb);

  // Re-read to confirm persistence.
  const get = await apiReq("GET", "/inbox/ai-agent/config");
  assert.equal(get.data.config.maxConsecutiveReplies, 7);
  assert.equal(get.data.config.knowledgeBase, customKb);
});

// ---------------------------------------------------------------------------
// 5. Enabling automation requires Super Admin; disabling remains available.
// ---------------------------------------------------------------------------
test("AI activation controls require Super Admin", async () => {
  currentUser = { id: 999000, role: "admin", isActive: true };
  const denied = await apiReq("PUT", "/inbox/ai-agent/config", {
    externalAutoReplyEnabled: true,
  });
  assert.equal(denied.status, 403);

  currentUser = { id: 999002, role: "super_admin", isActive: true };
  const approved = await apiReq("PUT", "/inbox/ai-agent/config", {
    externalAutoReplyEnabled: true,
  });
  assert.equal(approved.status, 200);
  assert.equal(approved.data.config.externalAutoReplyEnabled, true);

  currentUser = { id: 999000, role: "admin", isActive: true };
  const stopped = await apiReq("PUT", "/inbox/ai-agent/config", {
    externalAutoReplyEnabled: false,
  });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.data.config.externalAutoReplyEnabled, false);
});

// ---------------------------------------------------------------------------
// 5. Test endpoint returns a reply WITHOUT sending anything.
// ---------------------------------------------------------------------------
test("admin POST /inbox/ai-agent/test → reply, never sends", async () => {
  currentUser = { id: 999000, role: "admin", isActive: true };

  let sendCalled = false;
  __setBotSendOverrideForTests(async () => {
    sendCalled = true;
    return { ok: true, externalMessageId: "should-not-happen" };
  });
  const cannedReply = `CANNED_${RUN_ID}`;
  __setBotReplyOverrideForTests(async () => cannedReply);

  const res = await apiReq("POST", "/inbox/ai-agent/test", {
    message: "Hello, can you tell me about your programs?",
    language: "en",
  });

  assert.equal(res.status, 200);
  assert.equal(res.data.result.reply, cannedReply, "returns the would-be reply");
  assert.equal(res.data.result.language, "en");
  assert.equal(res.data.result.escalation.escalated, false);
  assert.equal(sendCalled, false, "the bot SEND path must NEVER be called by the test endpoint");

  __setBotReplyOverrideForTests(null);
  __setBotSendOverrideForTests(null);
});

// ---------------------------------------------------------------------------
// 5b. Test endpoint accepts optional fake history and still never sends.
// ---------------------------------------------------------------------------
test("admin POST /inbox/ai-agent/test → accepts fake history, never sends", async () => {
  currentUser = { id: 999000, role: "admin", isActive: true };

  let sendCalled = false;
  __setBotSendOverrideForTests(async () => {
    sendCalled = true;
    return { ok: true, externalMessageId: "should-not-happen" };
  });
  const cannedReply = `CANNED_HIST_${RUN_ID}`;
  __setBotReplyOverrideForTests(async () => cannedReply);

  const res = await apiReq("POST", "/inbox/ai-agent/test", {
    message: "Thanks! Can you tell me more about the programs?",
    language: "en",
    history: [
      { direction: "inbound", content: "Hi, tell me about your programs." },
      { direction: "outbound", content: "Sure! We offer many programs." },
    ],
  });

  assert.equal(res.status, 200);
  assert.equal(res.data.result.reply, cannedReply, "returns the would-be reply with history");
  assert.equal(res.data.result.language, "en");
  assert.equal(sendCalled, false, "the test endpoint must NEVER send, even with history");

  // Invalid history (bad direction) must be rejected with 400.
  const bad = await apiReq("POST", "/inbox/ai-agent/test", {
    message: "hi",
    history: [{ direction: "sideways", content: "x" }],
  });
  assert.equal(bad.status, 400, "invalid history direction should 400");

  __setBotReplyOverrideForTests(null);
  __setBotSendOverrideForTests(null);
});

// ---------------------------------------------------------------------------
// 6. Test endpoint reports escalation (and still never sends, reply null).
// ---------------------------------------------------------------------------
test("admin POST /inbox/ai-agent/test → escalation yields null reply, no send", async () => {
  currentUser = { id: 999000, role: "admin", isActive: true };

  // Seed an escalation keyword we can reliably trigger.
  const configWrite = await apiReq("PUT", "/inbox/ai-agent/config", {
    escalationKeywords: {
      contract: [`zzkw_${RUN_ID}`],
      payment: [],
      commission: [],
      partner: [],
      human_request: [],
      visa_documents: [],
      supplier: [],
    },
  });
  assert.equal(configWrite.status, 200, "complete escalation keyword map should persist");
  assert.deepEqual(configWrite.data.config.escalationKeywords.contract, [`zzkw_${RUN_ID}`]);

  let sendCalled = false;
  __setBotSendOverrideForTests(async () => {
    sendCalled = true;
    return { ok: true, externalMessageId: "nope" };
  });
  __setBotReplyOverrideForTests(async () => "should-not-be-used");

  const res = await apiReq("POST", "/inbox/ai-agent/test", {
    message: `I have a question about zzkw_${RUN_ID} please`,
    language: "en",
  });

  assert.equal(res.status, 200);
  assert.equal(res.data.result.escalation.escalated, true);
  assert.equal(res.data.result.escalation.topic, "contract");
  assert.equal(res.data.result.reply, null, "escalated message has no auto-reply");
  assert.equal(sendCalled, false, "escalation path must not send either");

  __setBotReplyOverrideForTests(null);
  __setBotSendOverrideForTests(null);
});
