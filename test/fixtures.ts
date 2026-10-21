import { parseCatalog, parseSystemOneCatalog } from "../src/catalog.ts";

export const exchangeRate = { usd_idr_rate: 16_000 };

export function storedCatalog(checkedAt = Date.now()) {
  return {
    checkedAt,
    models: [
      ...parseCatalog({ data: [model()] }, exchangeRate),
      ...parseSystemOneCatalog({ data: [
        systemOneModel(),
        systemOneModel({ id: "clef:free", name: "Clef", modalities: { input: ["text", "image"], output: [] } }),
      ] }, exchangeRate),
    ].map((entry) => ({ ...entry, provider: "kenari", baseUrl: "https://kenari.id/v1" })),
  };
}

export function model(overrides: Record<string, unknown> = {}) {
  return {
    id: "step-3-7-flash",
    name: "Step 3.7 Flash",
    endpoints: ["chat"],
    context_length: 262_144,
    max_output_tokens: 65_536,
    modalities: { input: ["text", "image", "file"], output: ["text"] },
    reasoning: true,
    reasoning_options: ["low", "medium", "high"],
    reasoning_toggle: true,
    tool_call: true,
    sunset_at: null,
    pricing: {
      input: 4_200_000_000,
      output: 24_000_000_000,
      cache_read: 840_000_000,
      cache_write: null,
      free: false,
      currency: "IDR",
      unit: "micro_idr_per_1m_tokens",
    },
    ...overrides,
  };
}

export function systemOneModel(overrides: Record<string, unknown> = {}) {
  return {
    id: "jev-1-13:free",
    name: "Jev 1.13 Free",
    endpoints: ["systemone"],
    modalities: { input: ["text"], output: [] },
    sunset_at: null,
    pricing: {
      input: null,
      free: true,
      currency: "IDR",
      unit: "micro_idr_per_1m_tokens",
    },
    ...overrides,
  };
}

export function catalogResponse() {
  return Response.json({ data: [model()] });
}

export function systemOneCatalogResponse() {
  return Response.json({ data: [systemOneModel()] });
}

export function systemOneResponse() {
  return Response.json({
    model: "jev-1.13-free",
    answers: {
      approved: { type: "noul", noul: 0.97 },
      tone: { type: "choice", choice: "happy", confidence: 1, probabilities: { happy: 1, angry: 0 } },
      severity: { type: "score", score: 2.96, confidence: 0.96 },
    },
    usage: { input_tokens: 82, output_tokens: 48 },
  });
}

export function sse(chunks: unknown[]): Response {
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

export function textResponse(text = "Hello, Jakarta! 🌴") {
  return sse([
    { choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { reasoning: "Think", reasoning_content: "Think" }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
    {
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 40 } },
    },
  ]);
}
