import { db, integrationsTable } from "@workspace/db";
import { eq, or } from "drizzle-orm";
import { decryptConfig } from "./encryption";
import {
  buildProgramTranslationPrompt,
  parseProgramTranslation,
  type ProgramLocalizedContent,
  type ProgramSourceContent,
  type ProgramTargetLocale,
} from "./programTranslationContract";

export type ProgramTranslationProviderInfo = {
  provider: "anthropic" | "openai";
  model: string;
};

type ResolvedProvider = ProgramTranslationProviderInfo & { apiKey: string };

export class ProgramTranslationProviderError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable: boolean,
  ) {
    super(code);
    this.name = "ProgramTranslationProviderError";
  }
}

function safeProviderError(error: unknown): ProgramTranslationProviderError {
  const status = Number((error as { status?: unknown })?.status || 0);
  const name = String((error as { name?: unknown })?.name || "");
  if (status === 401 || status === 403) return new ProgramTranslationProviderError("provider_auth_failed", false);
  if (status === 429) return new ProgramTranslationProviderError("provider_rate_limited", true);
  if (status >= 500) return new ProgramTranslationProviderError("provider_unavailable", true);
  if (name === "AbortError" || name === "TimeoutError") {
    return new ProgramTranslationProviderError("provider_timeout", true);
  }
  return new ProgramTranslationProviderError("provider_request_failed", false);
}

async function resolveProvider(): Promise<ResolvedProvider> {
  const rows = await db
    .select()
    .from(integrationsTable)
    .where(or(
      eq(integrationsTable.key, "claude"),
      eq(integrationsTable.key, "openai"),
    ));

  const ordered = rows.sort((a, b) => (a.key === "claude" ? -1 : b.key === "claude" ? 1 : 0));
  for (const row of ordered) {
    if (!row.isEnabled) continue;
    const config = decryptConfig(row.config as Record<string, unknown>);
    const apiKey = typeof config.apiKey === "string" ? config.apiKey.trim() : "";
    if (!apiKey || apiKey.startsWith("enc::")) continue;
    if (row.key === "claude") {
      return {
        provider: "anthropic",
        apiKey,
        model: typeof config.model === "string" && config.model.trim()
          ? config.model.trim()
          : "claude-sonnet-4-6",
      };
    }
    return {
      provider: "openai",
      apiKey,
      model: typeof config.model === "string" && config.model.trim()
        ? config.model.trim()
        : "gpt-4o-mini",
    };
  }
  throw new ProgramTranslationProviderError("provider_not_configured", true);
}

async function callAnthropic(config: ResolvedProvider, prompt: string): Promise<string> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  try {
    const client = new Anthropic({ apiKey: config.apiKey, timeout: 60_000, maxRetries: 0 });
    const result = await client.messages.create({
      model: config.model,
      max_tokens: 8_000,
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
    });
    const text = result.content.find((item) => item.type === "text");
    if (!text || text.type !== "text") {
      throw new ProgramTranslationProviderError("provider_empty_response", true);
    }
    return text.text;
  } catch (error) {
    if (error instanceof ProgramTranslationProviderError) throw error;
    throw safeProviderError(error);
  }
}

async function callOpenAI(config: ResolvedProvider, prompt: string): Promise<string> {
  const { default: OpenAI } = await import("openai");
  try {
    const client = new OpenAI({ apiKey: config.apiKey, timeout: 60_000, maxRetries: 0 });
    const result = await client.chat.completions.create({
      model: config.model,
      temperature: 0,
      max_tokens: 8_000,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    });
    const content = result.choices[0]?.message?.content;
    if (!content) throw new ProgramTranslationProviderError("provider_empty_response", true);
    return content;
  } catch (error) {
    if (error instanceof ProgramTranslationProviderError) throw error;
    throw safeProviderError(error);
  }
}

export async function translateProgramContent(
  locale: ProgramTargetLocale,
  source: ProgramSourceContent,
): Promise<{ content: ProgramLocalizedContent; provider: ProgramTranslationProviderInfo }> {
  const config = await resolveProvider();
  const prompt = buildProgramTranslationPrompt(locale, source);
  const raw = config.provider === "anthropic"
    ? await callAnthropic(config, prompt)
    : await callOpenAI(config, prompt);
  return {
    content: parseProgramTranslation(raw, source),
    provider: { provider: config.provider, model: config.model },
  };
}
