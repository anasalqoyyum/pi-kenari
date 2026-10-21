import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { InMemoryCredentialStore, InMemoryModelsStore, type ModelsStore } from "@earendil-works/pi-ai";
import { discoverAndLoadExtensions, ExtensionRunner, ModelRegistry, ModelRuntime, resolveCliModel, SessionManager } from "@earendil-works/pi-coding-agent";
import { catalogResponse, exchangeRate, model, storedCatalog } from "./fixtures.ts";

const refreshInterval = 4 * 60 * 60 * 1000;

async function setup(t: TestContext, store: ModelsStore | "disk" = new InMemoryModelsStore(), directory?: string) {
  const agentDir = directory ?? await mkdtemp(resolve(tmpdir(), "pi-kenari-startup-"));
  if (!directory) t.after(() => rm(agentDir, { recursive: true, force: true }));
  const loaded = await discoverAndLoadExtensions([resolve("index.ts")], process.cwd(), agentDir);
  assert.deepEqual(loaded.errors, []);
  const registration = loaded.runtime.pendingProviderRegistrations[0];
  assert.ok(registration);
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("kenari", async () => ({ type: "api_key", key: "kn-catalog-test" }));
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: resolve(agentDir, "models.json"),
    modelsStore: store === "disk" ? undefined : store,
    refreshOnCreate: false,
  });
  runtime.registerProvider(registration.name, registration.config);
  const restored = await runtime.refresh({ allowNetwork: false, providers: ["kenari"] });
  assert.equal(restored.errors.size, 0);
  return { runtime, agentDir, loaded, credentials };
}

function mockCatalog(t: TestContext, id?: string) {
  return t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(new Headers(init?.headers).get("Authorization"), null);
    const url = String(input);
    if (url === "https://kenari.id/v1/models") {
      return id ? Response.json({ data: [model({ id })] }) : catalogResponse();
    }
    assert.equal(url, "https://kenari.id/api/public/pricing");
    return Response.json(exchangeRate);
  });
}

function commandRunner(loaded: Awaited<ReturnType<typeof setup>>["loaded"], runtime: ModelRuntime) {
  return new ExtensionRunner(loaded.extensions, loaded.runtime, process.cwd(), SessionManager.inMemory(), new ModelRegistry(runtime));
}

test("extension loading and cold initialization do not fetch catalogs or wait for the network", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Startup must not depend on the network");
  });
  const { runtime } = await setup(t);
  assert.equal(fetch.mock.callCount(), 0);
  assert.deepEqual(runtime.getModels("kenari"), []);
  const unresolved = resolveCliModel({ cliProvider: "kenari", cliModel: "step-3-7-flash", modelRuntime: runtime });
  assert.ok(unresolved.error);
});

test("cache-only startup restores a stale catalog and resolves a CLI model without network access", async (t) => {
  const store = new InMemoryModelsStore();
  await store.write("kenari", storedCatalog(Date.now() - refreshInterval));
  const fetch = mockCatalog(t);
  const { runtime } = await setup(t, store);
  assert.equal(fetch.mock.callCount(), 0);
  const resolved = resolveCliModel({ cliProvider: "kenari", cliModel: "step-3-7-flash", modelRuntime: runtime });
  assert.equal(resolved.error, undefined);
  assert.equal(resolved.model?.id, "step-3-7-flash");
});

test("fresh catalogs skip automatic network refreshes, including after reload", async (t) => {
  const store = new InMemoryModelsStore();
  await store.write("kenari", storedCatalog());
  const fetch = mockCatalog(t);
  const first = await setup(t, store);
  await first.runtime.refresh({ providers: ["kenari"], allowNetwork: true });
  const second = await setup(t, store, first.agentDir);
  await second.runtime.refresh({ providers: ["kenari"], allowNetwork: true });
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(second.runtime.getModels("kenari").length, 1);
});

test("a stale catalog refreshes once online and saves the new catalog and freshness", async (t) => {
  const store = new InMemoryModelsStore();
  await store.write("kenari", storedCatalog(Date.now() - refreshInterval));
  const fetch = mockCatalog(t, "new-model");
  const { runtime } = await setup(t, store);
  const before = Date.now();
  const result = await runtime.refresh({ providers: ["kenari"], allowNetwork: true });
  assert.equal(result.errors.size, 0);
  assert.equal(fetch.mock.callCount(), 2);
  assert.deepEqual(runtime.getModels("kenari").map((entry) => entry.id), ["new-model"]);
  const saved = await store.read("kenari");
  assert.ok(saved?.checkedAt && saved.checkedAt >= before && saved.checkedAt <= Date.now());
  assert.equal(saved.models[0]?.provider, "kenari");
  await runtime.refresh({ providers: ["kenari"], allowNetwork: true });
  assert.equal(fetch.mock.callCount(), 2);
});

test("the catalog becomes stale at exactly four hours", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const store = new InMemoryModelsStore();
  await store.write("kenari", storedCatalog(now - refreshInterval + 1));
  const fetch = mockCatalog(t);
  const { runtime } = await setup(t, store);
  await runtime.refresh({ providers: ["kenari"], allowNetwork: true });
  assert.equal(fetch.mock.callCount(), 0);
  now++;
  await runtime.refresh({ providers: ["kenari"], allowNetwork: true });
  assert.equal(fetch.mock.callCount(), 2);
});

test("missing, invalid and future timestamps do not suppress discovery", async (t) => {
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  const fetch = mockCatalog(t);
  const store = new InMemoryModelsStore();
  for (const checkedAt of [undefined, NaN, Infinity, now + 1]) {
    await store.write("kenari", { ...storedCatalog(), checkedAt });
    const { runtime } = await setup(t, store);
    const result = await runtime.refresh({ providers: ["kenari"], allowNetwork: true });
    assert.equal(result.errors.size, 0);
  }
  assert.equal(fetch.mock.callCount(), 8);
});

test("force bypasses freshness but never bypasses allowNetwork false", async (t) => {
  const store = new InMemoryModelsStore();
  await store.write("kenari", storedCatalog());
  const fetch = mockCatalog(t, "forced-model");
  const { runtime } = await setup(t, store);
  await runtime.refresh({ providers: ["kenari"], force: true, allowNetwork: false });
  assert.equal(fetch.mock.callCount(), 0);
  await runtime.refresh({ providers: ["kenari"], force: true, allowNetwork: true });
  assert.equal(fetch.mock.callCount(), 2);
  assert.equal(runtime.getModels("kenari")[0]?.id, "forced-model");
});

test("offline mode restores cached models and prevents even a forced refresh from fetching", async (t) => {
  const previous = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previous;
  });
  const store = new InMemoryModelsStore();
  await store.write("kenari", storedCatalog(1));
  const fetch = mockCatalog(t);
  const { runtime, loaded } = await setup(t, store);
  await runtime.refresh({ providers: ["kenari"], force: true });
  const runner = commandRunner(loaded, runtime);
  const notify = t.mock.method(runner.getUIContext(), "notify");
  const command = runner.getCommand("kenari-refresh");
  assert.ok(command);
  await command.handler("", runner.createCommandContext());
  assert.match(String(notify.mock.calls.at(-1)?.arguments[0]), /No network refresh/);
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(runtime.getModels("kenari").length, 1);
  const cold = await setup(t);
  await cold.runtime.refresh({ providers: ["kenari"], force: true });
  assert.deepEqual(cold.runtime.getModels("kenari"), []);
  assert.equal(fetch.mock.callCount(), 0);
});

test("an unconfigured provider restores its cache but does not fetch", async (t) => {
  const previous = process.env.KENARI_API_KEY;
  delete process.env.KENARI_API_KEY;
  t.after(() => {
    if (previous !== undefined) process.env.KENARI_API_KEY = previous;
  });
  const store = new InMemoryModelsStore();
  await store.write("kenari", storedCatalog(1));
  const fetch = mockCatalog(t);
  const { runtime, credentials } = await setup(t, store);
  await credentials.delete("kenari");
  await runtime.refresh({ providers: ["kenari"], allowNetwork: true });
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(runtime.getModels("kenari").length, 1);
  assert.deepEqual(await runtime.getAvailable("kenari"), []);
});

test("HTTP and malformed discovery failures preserve the saved catalog and its timestamp", async (t) => {
  const store = new InMemoryModelsStore();
  const saved = storedCatalog(1);
  await store.write("kenari", saved);
  const { runtime } = await setup(t, store);
  for (const status of [401, 503, 200]) {
    t.mock.method(globalThis, "fetch", async () => status === 200
      ? Response.json({ data: [] })
      : new Response("private upstream detail", { status }));
    const result = await runtime.refresh({ providers: ["kenari"], allowNetwork: true });
    assert.equal(result.errors.size, 1);
    assert.deepEqual(await store.read("kenari"), saved);
    assert.equal(runtime.getModels("kenari")[0]?.id, "step-3-7-flash");
    assert.doesNotMatch(result.errors.get("kenari")?.message ?? "", /private upstream detail/);
  }
});

test("a failed first discovery leaves the provider registered and can be retried", async (t) => {
  const { runtime } = await setup(t);
  t.mock.method(globalThis, "fetch", async () => new Response("Unavailable", { status: 503 }));
  const failed = await runtime.refresh({ providers: ["kenari"], allowNetwork: true });
  assert.equal(failed.errors.size, 1);
  assert.ok(runtime.getProvider("kenari"));
  assert.deepEqual(runtime.getModels("kenari"), []);
  mockCatalog(t);
  const retried = await runtime.refresh({ providers: ["kenari"], allowNetwork: true });
  assert.equal(retried.errors.size, 0);
  assert.equal(runtime.getModels("kenari").length, 1);
});

test("cancelling discovery preserves the last good catalog", async (t) => {
  const store = new InMemoryModelsStore();
  const saved = storedCatalog(1);
  await store.write("kenari", saved);
  const { runtime } = await setup(t, store);
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    assert.ok(init?.signal);
    controller.abort();
    init.signal.throwIfAborted();
    throw new Error("Expected cancellation");
  });
  const result = await runtime.refresh({ providers: ["kenari"], allowNetwork: true, signal: controller.signal });
  assert.equal(result.aborted, true);
  assert.deepEqual(await store.read("kenari"), saved);
  assert.equal(runtime.getModels("kenari")[0]?.id, "step-3-7-flash");
});

test("superseded discovery cannot overwrite a newer catalog even if its fetch ignores cancellation", async (t) => {
  const store = new InMemoryModelsStore();
  await store.write("kenari", storedCatalog(1));
  const { runtime } = await setup(t, store);
  const releases: (() => void)[] = [];
  let started = () => {};
  const pendingRequests = new Promise<void>((resolve) => { started = resolve; });
  let count = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    count++;
    const url = String(input);
    if (count <= 2) {
      return new Promise<Response>((resolve) => {
        releases.push(() => resolve(url.endsWith("/models") ? Response.json({ data: [model({ id: "old-model" })] }) : Response.json(exchangeRate)));
        if (releases.length === 2) started();
      });
    }
    return url.endsWith("/models") ? Response.json({ data: [model({ id: "new-model" })] }) : Response.json(exchangeRate);
  });
  const older = runtime.refresh({ providers: ["kenari"], allowNetwork: true, force: true });
  await pendingRequests;
  await runtime.refresh({ providers: ["kenari"], allowNetwork: true, force: true });
  releases.forEach((release) => release());
  await older;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal((await store.read("kenari"))?.models[0]?.id, "new-model");
  assert.equal(runtime.getModels("kenari")[0]?.id, "new-model");
});

test("Pi's file-backed cache survives a new runtime and contains no API key", async (t) => {
  const fetch = mockCatalog(t);
  const first = await setup(t, "disk");
  await first.runtime.refresh({ providers: ["kenari"], allowNetwork: true });
  assert.equal(fetch.mock.callCount(), 2);
  const second = await setup(t, "disk", first.agentDir);
  assert.equal(second.runtime.getModels("kenari")[0]?.id, "step-3-7-flash");
  await second.runtime.refresh({ providers: ["kenari"], allowNetwork: true });
  assert.equal(fetch.mock.callCount(), 2);
  const saved = await readFile(resolve(first.agentDir, "models-store.json"), "utf8");
  assert.doesNotMatch(saved, /kn-catalog-test|Authorization|apiKey/);
});

test("empty and unrelated cached catalogs cannot suppress discovery", async (t) => {
  const store = new InMemoryModelsStore();
  const fetch = mockCatalog(t);
  for (const models of [[], storedCatalog().models.map((entry) => ({ ...entry, provider: "other" })),
    storedCatalog().models.map((entry) => ({ ...entry, baseUrl: "https://other.example/v1" }))]) {
    await store.write("kenari", { models, checkedAt: Date.now() });
    const { runtime } = await setup(t, store);
    assert.deepEqual(runtime.getModels("kenari"), []);
    const result = await runtime.refresh({ providers: ["kenari"], allowNetwork: true });
    assert.equal(result.errors.size, 0);
    assert.equal(runtime.getModels("kenari").length, 1);
  }
  assert.equal(fetch.mock.callCount(), 6);
});

test("/kenari-refresh initializes a cold catalog and bypasses freshness on subsequent requests", async (t) => {
  const fetch = mockCatalog(t);
  const { runtime, loaded } = await setup(t);
  const runner = commandRunner(loaded, runtime);
  const notify = t.mock.method(runner.getUIContext(), "notify");
  const command = runner.getCommand("kenari-refresh");
  assert.ok(command);
  await command.handler("", runner.createCommandContext());
  assert.equal(fetch.mock.callCount(), 2);
  assert.equal(runtime.getModels("kenari").length, 1);
  await command.handler("", runner.createCommandContext());
  assert.equal(fetch.mock.callCount(), 4);
  assert.match(String(notify.mock.calls.at(-1)?.arguments[0]), /catalog refreshed/);
});
