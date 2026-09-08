---
name: Inbox bot auto-reply design
description: How the WhatsApp inbox Claude auto-reply layer is wired (toggle, trigger, idempotency, escalation) and its test gotchas.
---

# Inbox bot auto-reply (WhatsApp)

Per-conversation `bot_enabled` (default OFF) + `needs_human` + `bot_last_handled_message_id` on the conversations table. Claude intake brain replies in the student's language only when the global bot switch, the explicit customer-channel approval gate, and the per-conversation switch are all ON.

## Key design decisions
- **Trigger placement**: fire `maybeAutoReply` from `webhooks.ts` AFTER the 200 ack is sent (non-blocking), never inside the request path. Heavy/LLM work in the webhook request path risks autoscale OOM → opaque 403 (same class as the contract-PDF render incidents).
- **Idempotency**: claimed via a conditional UPDATE on `bot_last_handled_message_id` (compare-and-set), not a read-then-write. Two concurrent invocations for the same inbound message → only one wins the claim and sends.
- **Escalation gate runs in code BEFORE the LLM call**: `detectEscalation` keyword-matches contract / payment-fee / commission / partner-agency topics (multilingual). On hit: no send, set `needs_human`, turn bot OFF.
- **Human takeover**: a staff manual reply (POST inbox messages) turns the bot OFF for that conversation.
- **External delivery approval**: `externalAutoReplyEnabled` defaults OFF, including for older encrypted configs that do not contain the field. Only Super Admin can turn it ON; any admin can turn it OFF. New bot clones always start with external delivery and default-on disabled.
- **Emergency kill switch**: `AI_EXTERNAL_AUTO_REPLY_KILL_SWITCH=true` blocks every non-internal bot transport even when database controls are enabled. This is an infrastructure override for incident response; normal long-term control remains in the Super Admin panel.
- **Test seams**: `__setBotReplyOverrideForTests` / `__setBotSendOverrideForTests` let unit tests mock Anthropic + send with zero network.

**Why:** keeps the layer additive and reuses existing `sendWhatsAppText`; the claim + pre-LLM gate make it safe to fire-and-forget without double-replying or leaking escalation topics to the bot.

## Test gotchas (node:test against the real DB)
- The messages table has a UNIQUE index on `(channel, external_message_id)`. A mock send that returns `mock_${counter}` with a **per-test-reset** counter collides across test cases. Make mock external ids globally unique: `mock_${RUN_ID}_${monotonicSeq++}` (seq NOT reset by `resetMocks`).
- Seeded contact `externalId` / phone must also be globally unique — use a monotonic `seedCounter` + random suffix, not `createdConvIds.length`.
