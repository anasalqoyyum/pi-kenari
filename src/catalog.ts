import type { Api, ClassifierApi, ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { SYSTEM_ONE_API } from "./system-one.ts";

export const BASE_URL = "https://kenari.id/v1";
type ChatModel = Extract<ProviderModelConfig, { reasoning: boolean }> & { api: Api };
type ClassifierModel = Extract<ProviderModelConfig, { type: "classifier" }> & { api: ClassifierApi };
export type KenariModel = ChatModel | ClassifierModel;

/** Kenari publishes no token limit for System One; TypeSafe's own Jev entry uses 64K. */
const SYSTEM_ONE_CONTEXT_WINDOW = 64_000;

const PositiveInteger = Type.Integer({ minimum: 1 });
const Price = Type.Union([Type.Number({ minimum: 0 }), Type.Null()]);
const KenariChatModel = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  endpoints: Type.Optional(Type.Array(Type.String())),
  context_length: Type.Optional(PositiveInteger),
  max_input_tokens: Type.Optional(PositiveInteger),
  max_output_tokens: Type.Optional(PositiveInteger),
  modalities: Type.Optional(Type.Object({ input: Type.Array(Type.String()) })),
  reasoning: Type.Optional(Type.Boolean()),
  reasoning_options: Type.Optional(Type.Array(Type.String())),
  reasoning_toggle: Type.Optional(Type.Boolean()),
  tool_call: Type.Optional(Type.Boolean()),
  sunset_at: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  pricing: Type.Object({
    input: Price,
    output: Price,
    cache_read: Price,
    cache_write: Price,
    free: Type.Boolean(),
    currency: Type.Literal("IDR"),
    unit: Type.Literal("micro_idr_per_1m_tokens"),
  }),
});
const KenariSystemOneModel = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  endpoints: Type.Optional(Type.Array(Type.String())),
  modalities: Type.Optional(Type.Object({ input: Type.Array(Type.String()) })),
  sunset_at: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  pricing: Type.Object({
    input: Price,
    free: Type.Boolean(),
    currency: Type.Literal("IDR"),
    unit: Type.Literal("micro_idr_per_1m_tokens"),
  }),
});
const Catalog = Type.Object({ data: Type.Array(KenariChatModel) });
const SystemOneCatalog = Type.Object({ data: Type.Array(KenariSystemOneModel) });
const ExchangeRate = Type.Object({ usd_idr_rate: Type.Number({ exclusiveMinimum: 0 }) });

function thinkingLevels(model: Static<typeof KenariChatModel>): ThinkingLevelMap | undefined {
  if (!model.reasoning) return undefined;
  const levels = model.reasoning_options;
  return {
    off: model.reasoning_toggle ? "none" : null,
    minimal: levels?.includes("minimal") ? "minimal" : null,
    low: levels && !levels.includes("low") ? null : "low",
    medium: levels && !levels.includes("medium") ? null : "medium",
    high: levels && !levels.includes("high") ? null : "high",
    xhigh: levels?.includes("xhigh") ? "xhigh" : null,
    max: levels?.includes("max") ? "max" : null,
  };
}

export function parseCatalog(catalog: unknown, pricing: unknown): ChatModel[] {
  if (!Value.Check(Catalog, catalog)) throw new Error("Kenari returned an invalid model catalog.");
  if (!Value.Check(ExchangeRate, pricing)) throw new Error("Kenari returned an invalid USD/IDR exchange rate.");

  const models: ChatModel[] = [];
  for (const model of catalog.data) {
    if (!model.endpoints?.includes("chat") || model.tool_call === false) continue;
    if (model.sunset_at != null && model.sunset_at <= Date.now() / 1000) continue;

    const contextWindow = Math.min(model.context_length ?? 128_000, model.max_input_tokens ?? Infinity);
    const toUsd = (price: number | null) =>
      model.pricing.free ? 0 : (price ?? 0) / 1_000_000 / pricing.usd_idr_rate;

    models.push({
      id: model.id,
      name: model.name,
      api: "openai-completions",
      reasoning: model.reasoning ?? false,
      thinkingLevelMap: thinkingLevels(model),
      input: model.modalities?.input.includes("image") ? ["text", "image"] : ["text"],
      contextWindow,
      maxTokens: Math.min(model.max_output_tokens ?? 8192, contextWindow),
      cost: {
        input: toUsd(model.pricing.input),
        output: toUsd(model.pricing.output),
        cacheRead: toUsd(model.pricing.cache_read),
        cacheWrite: toUsd(model.pricing.cache_write),
      },
      compat: {
        supportsStore: false,
        supportsDeveloperRole: true,
        supportsUsageInStreaming: false,
        maxTokensField: "max_tokens",
        thinkingFormat: "openrouter",
        requiresReasoningContentOnAssistantMessages: true,
      },
    });
  }
  if (models.length === 0) throw new Error("Kenari's catalog contains no tool-capable chat models.");
  return models;
}

/**
 * System One models are decision models, not chat models: they answer typed questions with
 * probabilities. Kenari lists them only under `?modality=systemone`, and bills input tokens only.
 */
export function parseSystemOneCatalog(catalog: unknown, pricing: unknown): ClassifierModel[] {
  if (!Value.Check(SystemOneCatalog, catalog)) throw new Error("Kenari returned an invalid System One catalog.");
  if (!Value.Check(ExchangeRate, pricing)) throw new Error("Kenari returned an invalid USD/IDR exchange rate.");

  const models: ClassifierModel[] = [];
  for (const model of catalog.data) {
    if (!model.endpoints?.includes("systemone")) continue;
    if (model.sunset_at != null && model.sunset_at <= Date.now() / 1000) continue;

    models.push({
      type: "classifier",
      api: SYSTEM_ONE_API,
      id: model.id,
      name: model.name,
      input: model.modalities?.input.includes("image") ? ["text", "image"] : ["text"],
      contextWindow: SYSTEM_ONE_CONTEXT_WINDOW,
      cost: {
        input: model.pricing.free ? 0 : (model.pricing.input ?? 0) / 1_000_000 / pricing.usd_idr_rate,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
    });
  }
  return models;
}

async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal, headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Kenari catalog request failed: HTTP ${response.status} at ${url}`);
  return response.json();
}

export async function discoverModels(signal?: AbortSignal): Promise<KenariModel[]> {
  const timeout = AbortSignal.timeout(10_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const [catalog, systemOne, pricing] = await Promise.all([
    fetchJson(`${BASE_URL}/models`, requestSignal),
    fetchJson(`${BASE_URL}/models?modality=systemone`, requestSignal),
    fetchJson("https://kenari.id/api/public/pricing", requestSignal),
  ]);
  return [...parseCatalog(catalog, pricing), ...parseSystemOneCatalog(systemOne, pricing)];
}
