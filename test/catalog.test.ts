import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverModels, parseCatalog } from "../src/catalog.ts";
import { exchangeRate, model } from "./fixtures.ts";

function parse(overrides: Record<string, unknown> = {}) {
  const [result] = parseCatalog({ data: [model(overrides)] }, exchangeRate);
  assert.ok(result);
  return result;
}

test("maps capabilities, limits, reasoning and micro-IDR costs", () => {
  const result = parse();
  assert.equal(result.id, "step-3-7-flash");
  assert.equal(result.name, "Step 3.7 Flash");
  assert.deepEqual(result.input, ["text", "image"]);
  assert.equal(result.contextWindow, 262_144);
  assert.equal(result.maxTokens, 65_536);
  assert.equal(result.reasoning, true);
  assert.deepEqual(result.thinkingLevelMap, {
    off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null,
  });
  assert.deepEqual(result.cost, { input: 0.2625, output: 1.5, cacheRead: 0.0525, cacheWrite: 0 });
});

test("keeps only unretired chat models that do not explicitly lack tools", () => {
  const result = parseCatalog({ data: [
    model(),
    model({ id: "image", endpoints: ["images"] }),
    model({ id: "auto", endpoints: undefined }),
    model({ id: "no-tools", tool_call: false }),
    model({ id: "expired", sunset_at: 1 }),
    model({ id: "tools-unknown", tool_call: undefined }),
    model({ id: "retiring-later", sunset_at: Date.now() / 1000 + 86400 }),
  ] }, exchangeRate);
  assert.deepEqual(result.map((entry) => entry.id), ["step-3-7-flash", "tools-unknown", "retiring-later"]);
});

test("free variants cost zero even when paid list prices remain", () => {
  const entry = model();
  const result = parse({ id: "step-3-7-flash:free", pricing: { ...entry.pricing, free: true } });
  assert.equal(result.id, "step-3-7-flash:free");
  assert.deepEqual(result.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("uses documented defaults for omitted capabilities and limits", () => {
  const result = parse({
    context_length: undefined, max_output_tokens: undefined, modalities: undefined,
    reasoning: undefined, reasoning_options: undefined,
  });
  assert.equal(result.contextWindow, 128_000);
  assert.equal(result.maxTokens, 8192);
  assert.equal(result.reasoning, false);
  assert.equal(result.thinkingLevelMap, undefined);
  assert.deepEqual(result.input, ["text"]);
});

test("caps context by the input limit and output by context", () => {
  const result = parse({ max_input_tokens: 4096 });
  assert.equal(result.contextWindow, 4096);
  assert.equal(result.maxTokens, 4096);
});

test("does not advertise off for always-on reasoning and preserves extended efforts", () => {
  const result = parse({ reasoning_toggle: false, reasoning_options: ["high", "xhigh", "max"] });
  assert.equal(result.thinkingLevelMap?.off, null);
  assert.equal(result.thinkingLevelMap?.low, null);
  assert.equal(result.thinkingLevelMap?.xhigh, "xhigh");
  assert.equal(result.thinkingLevelMap?.max, "max");
});

test("rejects malformed catalogs, empty selections and invalid exchange rates", () => {
  for (const value of [null, {}, { data: [{}] }, { data: [model({ context_length: -1 })] }]) {
    assert.throws(() => parseCatalog(value, exchangeRate), /invalid model catalog/);
  }
  assert.throws(() => parseCatalog({ data: [] }, exchangeRate), /no tool-capable/);
  for (const value of [null, {}, { usd_idr_rate: 0 }, { usd_idr_rate: "16000" }]) {
    assert.throws(() => parseCatalog({ data: [model()] }, value), /invalid USD\/IDR/);
  }
});

test("discovery sends no credentials to public endpoints and propagates cancellation", async (t) => {
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    assert.equal(new Headers(init?.headers).get("Authorization"), null);
    assert.ok(init?.signal);
    return Response.json(url.endsWith("/models") ? { data: [model()] } : exchangeRate);
  });
  assert.equal((await discoverModels()).length, 1);
  assert.deepEqual(requests.sort(), ["https://kenari.id/api/public/pricing", "https://kenari.id/v1/models"]);
  t.mock.restoreAll();

  const controller = new AbortController();
  controller.abort();
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    init?.signal?.throwIfAborted();
    throw new Error("Expected an aborted signal");
  });
  await assert.rejects(discoverModels(controller.signal), { name: "AbortError" });
});

test("discovery reports HTTP failures without including the response body", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("private upstream detail", { status: 503 }));
  await assert.rejects(discoverModels(), /Kenari catalog request failed: HTTP 503/);
});
