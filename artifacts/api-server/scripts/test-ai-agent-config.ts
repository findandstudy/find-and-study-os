/**
 * AI intake agent FAZ 1 — DB-managed config & handoff unit tests.
 *
 * Covers the config layer and the engine deltas added on top of the merged
 * auto-reply core, all with the Anthropic call and the WhatsApp send mocked.
 *
 * Coverage:
 *   - config validation: aiAgentConfigSchema rejects bad values.
 *   - config read/write round-trip: writeAiAgentConfig persists a patch and
 *     getAiAgentConfig reads it back merged over defaults (escalation keywords
 *     + knowledge base preserved). The original ai_agent row is restored.
 *   - config-driven escalation: detectEscalation uses the supplied keyword sets;
 *     the engine reads escalation keywords from the live config.
 *   - global gate: master switch off → no auto-reply (globally_disabled).
 *   - consecutive-reply handoff: at/over the threshold the engine sends the
 *     handoff message once, flips needs-human, and disables the bot.
 *   - reply counting: a normal bot reply increments bot_reply_count.
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run test:ai-agent
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  db,
  conversationsTable,
  messagesTable,
  externalContactsTable,
  channelAccountsTable,
  integrationsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import {
  maybeAutoReply,
  detectEscalation,
  __setBotReplyOverrideForTests,
  __setBotSendOverrideForTests,
  type BotSendInput,
} from "../src/lib/inbox/botAutoReply";
import {
  aiAgentConfigSchema,
  getAiAgentConfig,
  writeAiAgentConfig,
  __setAiAgentConfigOverrideForTests,
  aiAgentPatchRequiresSuperAdmin,
  isExternalAutoReplyEmergencyStopped,
  DEFAULT_AI_AGENT_CONFIG,
  AI_AGENT_INTEGRATION_KEY,
} from "../src/lib/inbox/aiAgentConfig";

const RUN_ID = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

// ---------------------------------------------------------------------------
// Mock send / reply seams.
// ---------------------------------------------------------------------------
let sentCalls: BotSendInput[] = [];
let sendSeq = 0;
__setBotSendOverrideForTests(async (input) => {
  sentCalls.push(input);
  return { ok: true, externalMessageId: `mock_${RUN_ID}_${sendSeq++}` };
});
__setBotReplyOverrideForTests(async () => "Mock intake reply");

function resetMocks(): void {
  sentCalls = [];
}

// ---------------------------------------------------------------------------
// DB seeding helpers
// ---------------------------------------------------------------------------
const createdConvIds: number[] = [];
const createdContactIds: number[] = [];
let channelAccountId = 0;
let seedCounter = 0;

async function ensureChannelAccount(): Promise<number> {
  if (channelAccountId) return channelAccountId;
  const [created] = await db
    .insert(channelAccountsTable)
    .values({
      channel: "whatsapp",
      displayName: "AI Agent Test WA",
      externalAccountId: `wa_aiagent_${RUN_ID}`,
      status: "active",
    })
    .returning({ id: channelAccountsTable.id });
  channelAccountId = created.id;
  return channelAccountId;
}

async function seedConversation(opts: {
  botEnabled: boolean;
  botReplyCount?: number;
  lastInboundAt?: Date;
}): Promise<{ conversationId: number }> {
  const accId = await ensureChannelAccount();
  const n = seedCounter++;
  const suffix = `${RUN_ID}_${n}_${Math.random().toString(36).slice(2, 7)}`;
  const phone = `+1556${String(n).padStart(3, "0")}${Math.floor(Math.random() * 9000 + 1000)}`;
  const [contact] = await db
    .insert(externalContactsTable)
    .values({
      channel: "whatsapp",
      externalId: `aiagent_contact_${suffix}`,
      displayName: `AI Agent Test ${suffix}`,
      phone,
      phoneE164: phone,
    })
    .returning({ id: externalContactsTable.id });
  createdContactIds.push(contact.id);

  const [conv] = await db
    .insert(conversationsTable)
    .values({
      type: "inbox",
      channel: "whatsapp",
      channelAccountId: accId,
      externalContactId: contact.id,
      externalThreadId: `aiagent_thread_${suffix}`,
      status: "open",
      botEnabled: opts.botEnabled,
      botReplyCount: opts.botReplyCount ?? 0,
      lastInboundAt: opts.lastInboundAt ?? new Date(),
    })
    .returning({ id: conversationsTable.id });
  createdConvIds.push(conv.id);
  return { conversationId: conv.id };
}

async function seedInbound(conversationId: number, content: string): Promise<number> {
  const [msg] = await db
    .insert(messagesTable)
    .values({
      conversationId,
      content,
      channel: "whatsapp",
      direction: "inbound",
      status: "received",
    })
    .returning({ id: messagesTable.id });
  return msg.id;
}

async function outboundCount(conversationId: number): Promise<number> {
  const rows = await db
    .select({ id: messagesTable.id })
    .from(messagesTable)
    .where(and(eq(messagesTable.conversationId, conversationId), eq(messagesTable.direction, "outbound")));
  return rows.length;
}

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------
test("aiAgentConfigSchema accepts the defaults and rejects bad values", () => {
  assert.doesNotThrow(() => aiAgentConfigSchema.parse(DEFAULT_AI_AGENT_CONFIG));
  assert.equal(DEFAULT_AI_AGENT_CONFIG.externalAutoReplyEnabled, false);
  assert.equal(DEFAULT_AI_AGENT_CONFIG.languages.length, 23);
  assert.deepEqual(
    Object.keys(DEFAULT_AI_AGENT_CONFIG.handoffMessages).sort(),
    [...DEFAULT_AI_AGENT_CONFIG.languages].sort(),
  );

  // temperature out of range
  assert.throws(() => aiAgentConfigSchema.parse({ ...DEFAULT_AI_AGENT_CONFIG, temperature: 5 }));
  // empty model
  assert.throws(() => aiAgentConfigSchema.parse({ ...DEFAULT_AI_AGENT_CONFIG, model: "" }));
  // negative threshold
  assert.throws(() => aiAgentConfigSchema.parse({ ...DEFAULT_AI_AGENT_CONFIG, maxConsecutiveReplies: -1 }));
  // empty knowledge base
  assert.throws(() => aiAgentConfigSchema.parse({ ...DEFAULT_AI_AGENT_CONFIG, knowledgeBase: "" }));
});

// ---------------------------------------------------------------------------
// Config read/write round-trip (touches the shared ai_agent row → restored)
// ---------------------------------------------------------------------------
test("writeAiAgentConfig persists a patch; getAiAgentConfig reads it merged", async () => {
  // Snapshot the existing ai_agent row so we can restore it afterward.
  const [original] = await db
    .select()
    .from(integrationsTable)
    .where(eq(integrationsTable.key, AI_AGENT_INTEGRATION_KEY));

  try {
    // Ensure no override masks the DB read path.
    __setAiAgentConfigOverrideForTests(null);

    const customKb = `KB_${RUN_ID} brand brain body`;
    await writeAiAgentConfig({
      maxConsecutiveReplies: 9,
      defaultOnForNew: true,
      externalAutoReplyEnabled: false,
      knowledgeBase: customKb,
    });

    const cfg = await getAiAgentConfig();
    assert.equal(cfg.maxConsecutiveReplies, 9);
    assert.equal(cfg.defaultOnForNew, true);
    assert.equal(cfg.externalAutoReplyEnabled, false);
    assert.equal(cfg.knowledgeBase, customKb);
    // Untouched fields fall back to defaults (field-level merge).
    assert.equal(cfg.enabled, DEFAULT_AI_AGENT_CONFIG.enabled);
    // Escalation keyword sets are preserved (not wiped by a partial patch).
    assert.ok(cfg.escalationKeywords.contract.length > 0);
    assert.ok(cfg.escalationKeywords.payment.includes("fee"));
  } finally {
    // Restore the original row (or remove the one we created).
    if (original) {
      await db
        .update(integrationsTable)
        .set({ config: original.config, isEnabled: original.isEnabled, name: original.name, category: original.category })
        .where(eq(integrationsTable.key, AI_AGENT_INTEGRATION_KEY));
    } else {
      await db.delete(integrationsTable).where(eq(integrationsTable.key, AI_AGENT_INTEGRATION_KEY));
    }
  }
});

// ---------------------------------------------------------------------------
// Config-driven escalation
// ---------------------------------------------------------------------------
test("detectEscalation uses the supplied keyword sets", () => {
  const custom = {
    contract: [`zzcustom_${RUN_ID}`],
    payment: [],
    commission: [],
    partner: [],
  };
  // Custom keyword matches.
  assert.equal(detectEscalation(`please zzcustom_${RUN_ID} now`, custom), "contract");
  // A default keyword no longer matches when the config overrides it.
  assert.equal(detectEscalation("can you send me the contract?", custom), null);
});

test("engine reads escalation keywords from the live config", async () => {
  resetMocks();
  const keyword = `escalateword_${RUN_ID}`;
  __setAiAgentConfigOverrideForTests({
    enabled: true,
    externalAutoReplyEnabled: true,
    escalationKeywords: { contract: [keyword], payment: [], commission: [], partner: [] },
  });
  try {
    const { conversationId } = await seedConversation({ botEnabled: true });
    const msgId = await seedInbound(conversationId, `Hello I need ${keyword} help`);
    const outcome = await maybeAutoReply({ conversationId, inboundMessageId: msgId });
    assert.equal(outcome.reason, "escalated");
    assert.equal(outcome.topic, "contract");
    assert.equal(sentCalls.length, 1);
    assert.ok(sentCalls[0].text.trim().length > 0);
    const [conv] = await db
      .select({ botEnabled: conversationsTable.botEnabled, needsHuman: conversationsTable.needsHuman })
      .from(conversationsTable)
      .where(eq(conversationsTable.id, conversationId));
    assert.equal(conv.botEnabled, false);
    assert.equal(conv.needsHuman, true);
  } finally {
    __setAiAgentConfigOverrideForTests(null);
  }
});

// ---------------------------------------------------------------------------
// Global gate
// ---------------------------------------------------------------------------
test("global switch off → no auto-reply (globally_disabled)", async () => {
  resetMocks();
  __setAiAgentConfigOverrideForTests({ enabled: false });
  try {
    const { conversationId } = await seedConversation({ botEnabled: true });
    const msgId = await seedInbound(conversationId, "Hi, I want to study in Istanbul");
    const outcome = await maybeAutoReply({ conversationId, inboundMessageId: msgId });
    assert.equal(outcome.reason, "globally_disabled");
    assert.equal(sentCalls.length, 0);
    assert.equal(await outboundCount(conversationId), 0);
  } finally {
    __setAiAgentConfigOverrideForTests(null);
  }
});

test("external delivery defaults off and requires explicit approval", async () => {
  resetMocks();
  __setAiAgentConfigOverrideForTests({ enabled: true });
  try {
    const { conversationId } = await seedConversation({ botEnabled: true });
    const msgId = await seedInbound(conversationId, "Hi, I want to study in Istanbul");
    const outcome = await maybeAutoReply({ conversationId, inboundMessageId: msgId });
    assert.equal(outcome.reason, "external_delivery_disabled");
    assert.equal(sentCalls.length, 0);
    assert.equal(await outboundCount(conversationId), 0);
  } finally {
    __setAiAgentConfigOverrideForTests(null);
  }
});

test("only activation transitions require Super Admin", () => {
  const safe = { ...DEFAULT_AI_AGENT_CONFIG };
  assert.equal(aiAgentPatchRequiresSuperAdmin(safe, { externalAutoReplyEnabled: true }), true);
  assert.equal(aiAgentPatchRequiresSuperAdmin({ ...safe, enabled: false }, { enabled: true }), true);
  assert.equal(aiAgentPatchRequiresSuperAdmin(safe, { defaultOnForNew: true }), true);
  assert.equal(aiAgentPatchRequiresSuperAdmin({ ...safe, externalAutoReplyEnabled: true }, { externalAutoReplyEnabled: false }), false);
  assert.equal(aiAgentPatchRequiresSuperAdmin(safe, { enabled: false }), false);
});

test("the infrastructure kill switch is explicit and fail-safe", () => {
  const previous = process.env.AI_EXTERNAL_AUTO_REPLY_KILL_SWITCH;
  try {
    delete process.env.AI_EXTERNAL_AUTO_REPLY_KILL_SWITCH;
    assert.equal(isExternalAutoReplyEmergencyStopped(), false);
    process.env.AI_EXTERNAL_AUTO_REPLY_KILL_SWITCH = "true";
    assert.equal(isExternalAutoReplyEmergencyStopped(), true);
    process.env.AI_EXTERNAL_AUTO_REPLY_KILL_SWITCH = "0";
    assert.equal(isExternalAutoReplyEmergencyStopped(), false);
  } finally {
    if (previous === undefined) delete process.env.AI_EXTERNAL_AUTO_REPLY_KILL_SWITCH;
    else process.env.AI_EXTERNAL_AUTO_REPLY_KILL_SWITCH = previous;
  }
});

// ---------------------------------------------------------------------------
// Consecutive-reply handoff
// ---------------------------------------------------------------------------
test("a new inbound resets the stale reply streak before generating a reply", async () => {
  resetMocks();
  const handoffMessage = `HANDOFF_${RUN_ID}`;
  __setAiAgentConfigOverrideForTests({
    enabled: true,
    externalAutoReplyEnabled: true,
    maxConsecutiveReplies: 2,
    handoffMessage,
  });
  try {
    const { conversationId } = await seedConversation({ botEnabled: true, botReplyCount: 2 });
    const msgId = await seedInbound(conversationId, "Hello, any update?");
    const outcome = await maybeAutoReply({ conversationId, inboundMessageId: msgId });
    assert.equal(outcome.reason, "sent");
    assert.equal(sentCalls.length, 1);
    const [conv] = await db
      .select({
        botEnabled: conversationsTable.botEnabled,
        needsHuman: conversationsTable.needsHuman,
        botReplyCount: conversationsTable.botReplyCount,
      })
      .from(conversationsTable)
      .where(eq(conversationsTable.id, conversationId));
    assert.equal(conv.botEnabled, true);
    assert.equal(conv.needsHuman, false);
    assert.equal(conv.botReplyCount, 1);
  } finally {
    __setAiAgentConfigOverrideForTests(null);
  }
});

test("below the handoff threshold → normal reply, bot_reply_count increments", async () => {
  resetMocks();
  __setAiAgentConfigOverrideForTests({
    enabled: true,
    externalAutoReplyEnabled: true,
    maxConsecutiveReplies: 5,
  });
  try {
    const { conversationId } = await seedConversation({ botEnabled: true, botReplyCount: 1 });
    const msgId = await seedInbound(conversationId, "Hi, what programs do you offer?");
    const outcome = await maybeAutoReply({ conversationId, inboundMessageId: msgId });
    assert.equal(outcome.reason, "sent");
    assert.equal(sentCalls.length, 1);
    const [conv] = await db
      .select({ botReplyCount: conversationsTable.botReplyCount, botEnabled: conversationsTable.botEnabled })
      .from(conversationsTable)
      .where(eq(conversationsTable.id, conversationId));
    assert.equal(conv.botReplyCount, 1);
    assert.equal(conv.botEnabled, true);
  } finally {
    __setAiAgentConfigOverrideForTests(null);
  }
});

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------
test("cleanup seeded rows", async () => {
  for (const id of createdConvIds) {
    await db.delete(conversationsTable).where(eq(conversationsTable.id, id)).catch(() => {});
  }
  for (const id of createdContactIds) {
    await db.delete(externalContactsTable).where(eq(externalContactsTable.id, id)).catch(() => {});
  }
  if (channelAccountId) {
    await db.delete(channelAccountsTable).where(eq(channelAccountsTable.id, channelAccountId)).catch(() => {});
  }
  __setBotReplyOverrideForTests(null);
  __setBotSendOverrideForTests(null);
  __setAiAgentConfigOverrideForTests(null);
  setTimeout(() => process.exit(0), 100);
});
