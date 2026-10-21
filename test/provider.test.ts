import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { InMemoryCredentialStore, InMemoryModelsStore, Type, type Context } from "@earendil-works/pi-ai";
import { discoverAndLoadExtensions, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { exchangeRate, model, sse, storedCatalog, textResponse } from "./fixtures.ts";

const context = {
  systemPrompt: "Answer briefly.",
  messages: [{ role: "user", content: "Hello", timestamp: 1 }],
} satisfies Context;

function setKey(t: TestContext, value?: string) {
  const previous = process.env.KENARI_API_KEY;
  if (value === undefined) delete process.env.KENARI_API_KEY;
  else process.env.KENARI_API_KEY = value;
  t.after(() => {
    if (previous === undefined) delete process.env.KENARI_API_KEY;
    else process.env.KENARI_API_KEY = previous;
  });
}

async function setup(t: TestContext) {
  const agentDir = await mkdtemp(resolve(tmpdir(), "pi-kenari-test-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Cached startup must not send a network request");
  });
  const loaded = await discoverAndLoadExtensions([resolve("index.ts")], process.cwd(), agentDir);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const [registration] = loaded.runtime.pendingProviderRegistrations;
  assert.ok(registration);
  assert.equal(registration.name, "kenari");
  assert.equal(registration.config.apiKey, "$KENARI_API_KEY");
  assert.equal(registration.config.baseUrl, "https://kenari.id/v1");
  const modelsStore = new InMemoryModelsStore();
  await modelsStore.write("kenari", storedCatalog());
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStore,
  });
  runtime.registerProvider(registration.name, registration.config);
  const refreshed = await runtime.refresh({ allowNetwork: false, providers: ["kenari"] });
  assert.equal(refreshed.errors.size, 0);
  const selected = runtime.getModel("kenari", "step-3-7-flash");
  assert.ok(selected);
  t.mock.restoreAll();
  return { runtime, selected };
}

test("Pi loads the extension and resolves KENARI_API_KEY at request time", async (t) => {
  setKey(t, "kn-first-test-key");
  const { runtime } = await setup(t);
  assert.equal((await runtime.getAuth("kenari"))?.auth.apiKey, "kn-first-test-key");
  process.env.KENARI_API_KEY = "kn-rotated-test-key";
  assert.equal((await runtime.getAuth("kenari"))?.auth.apiKey, "kn-rotated-test-key");
  assert.equal((await runtime.getAvailable("kenari")).length, 1);
  await runtime.setRuntimeApiKey("kenari", "kn-runtime-key");
  assert.equal((await runtime.getAuth("kenari"))?.auth.apiKey, "kn-runtime-key");
});

test("a missing key leaves Kenari unavailable without sending a chat request", async (t) => {
  setKey(t);
  const { runtime, selected } = await setup(t);
  await assert.rejects(runtime.getAuth("kenari"), /KENARI_API_KEY/);
  assert.deepEqual(await runtime.getAvailable("kenari"), []);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Must not send a request"); });
  const result = await runtime.completeSimple(selected, context);
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /api key|auth|configured/i);
});

test("built-in streaming handles reasoning, Unicode, usage, hooks and bearer auth", async (t) => {
  setKey(t, "kn-stream-test");
  const { runtime, selected } = await setup(t);
  let payload: unknown;
  let status: number | undefined;
  const rawEvents: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    assert.equal(request.url, "https://kenari.id/v1/chat/completions");
    assert.equal(request.headers.get("Authorization"), "Bearer kn-stream-test");
    const body: unknown = await request.json();
    assert.ok(body && typeof body === "object");
    assert.ok("model" in body && body.model === selected.id);
    assert.ok("max_tokens" in body && body.max_tokens === 512);
    assert.ok("reasoning" in body);
    assert.deepEqual(body.reasoning, { effort: "high" });
    assert.equal("stream_options" in body, false);
    return textResponse();
  });
  const result = await runtime.completeSimple(selected, context, {
    reasoning: "high", maxTokens: 512,
    onPayload: (value) => { payload = value; },
    onResponse: (response) => { status = response.status; },
    onProviderStreamEvent: (event) => { rawEvents.push(event); },
  });
  assert.equal(result.stopReason, "stop");
  assert.ok(result.content.some((block) => block.type === "text" && block.text === "Hello, Jakarta! 🌴"));
  assert.ok(result.content.some((block) => block.type === "thinking" && block.thinking === "Think"));
  assert.equal(result.usage.input, 60);
  assert.equal(result.usage.cacheRead, 40);
  assert.equal(result.usage.output, 20);
  assert.equal(result.usage.totalTokens, 120);
  assert.ok(Math.abs(result.usage.cost.total - 0.00004785) < 1e-12);
  assert.ok(payload);
  assert.equal(status, 200);
  assert.equal(rawEvents.length, 4);
});

test("empty text responses still finish successfully", async (t) => {
  setKey(t, "kn-empty-test");
  const { runtime, selected } = await setup(t);
  t.mock.method(globalThis, "fetch", async () => textResponse(""));
  const result = await runtime.completeSimple(selected, context);
  assert.equal(result.stopReason, "stop");
  assert.equal(result.content.filter((block) => block.type === "text").length, 0);
});

test("tool arguments stream in fragments and tool results survive a follow-up", async (t) => {
  setKey(t, "kn-tools-test");
  const { runtime, selected } = await setup(t);
  const toolContext = {
    ...context,
    tools: [{ name: "weather", description: "Get weather", parameters: Type.Object({ city: Type.String() }) }],
  } satisfies Context;
  t.mock.method(globalThis, "fetch", async () => sse([
    { choices: [{ index: 0, delta: { tool_calls: [
      { index: 0, id: "call_1", type: "function", function: { name: "weather", arguments: "" } },
    ] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Jakarta"}' } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ]));
  const result = await runtime.completeSimple(selected, toolContext);
  assert.equal(result.stopReason, "toolUse");
  const call = result.content.find((block) => block.type === "toolCall");
  assert.ok(call && call.type === "toolCall");
  assert.equal(call.name, "weather");
  assert.deepEqual(call.arguments, { city: "Jakarta" });
  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const body: unknown = await new Request(input, init).json();
    assert.ok(body && typeof body === "object" && "messages" in body && Array.isArray(body.messages));
    assert.ok(body.messages.some((entry: unknown) => entry && typeof entry === "object" &&
      "role" in entry && entry.role === "tool" && "tool_call_id" in entry && entry.tool_call_id === call.id));
    return textResponse("31°C");
  });
  const final = await runtime.completeSimple(selected, {
    ...toolContext,
    messages: [...context.messages, result, {
      role: "toolResult", toolCallId: call.id, toolName: call.name,
      content: [{ type: "text", text: "31°C" }], isError: false, timestamp: 2,
    }],
  });
  assert.equal(final.stopReason, "stop");
});

test("vision input is sent as an OpenAI image part", async (t) => {
  setKey(t, "kn-vision-test");
  const { runtime, selected } = await setup(t);
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const body = await new Request(input, init).text();
    assert.match(body, /image_url/);
    assert.match(body, /data:image\/png;base64,aGVsbG8=/);
    return textResponse();
  });
  const result = await runtime.completeSimple(selected, { messages: [{
    role: "user", timestamp: 1,
    content: [{ type: "text", text: "Describe this" }, { type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
  }] });
  assert.equal(result.stopReason, "stop");
});

test("refresh replaces removed models and retains the previous list on failure", async (t) => {
  setKey(t, "kn-refresh-test");
  const { runtime } = await setup(t);
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) =>
    Response.json(String(input).endsWith("/models") ? { data: [model({ id: "new-model" })] } : exchangeRate));
  const result = await runtime.refresh({ providers: ["kenari"], force: true });
  assert.equal(result.errors.size, 0);
  assert.deepEqual(runtime.getModels("kenari").map((entry) => entry.id), ["new-model"]);
  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", async () => new Response("Unavailable", { status: 503 }));
  const failed = await runtime.refresh({ providers: ["kenari"], force: true });
  assert.equal(failed.errors.size, 1);
  assert.deepEqual(runtime.getModels("kenari").map((entry) => entry.id), ["new-model"]);
});

test("abort, malformed streams, context overflow and in-stream errors do not report success", async (t) => {
  setKey(t, "kn-errors-test");
  const { runtime, selected } = await setup(t);
  const controller = new AbortController();
  controller.abort();
  const aborted = await runtime.completeSimple(selected, context, { signal: controller.signal });
  assert.ok(["aborted", "error"].includes(aborted.stopReason));

  for (const response of [
    new Response("data: {invalid json}\n\n", { headers: { "Content-Type": "text/event-stream" } }),
    Response.json({ error: { message: "context_length_exceeded", type: "invalid_request_error", code: "context_length_exceeded" } }, { status: 400 }),
    sse([{ error: { message: "upstream interrupted", type: "upstream_error", code: "stream_interrupted" } }]),
  ]) {
    t.mock.method(globalThis, "fetch", async () => response);
    const result = await runtime.completeSimple(selected, context);
    assert.equal(result.stopReason, "error");
    assert.ok(result.errorMessage);
    t.mock.restoreAll();
  }
});
