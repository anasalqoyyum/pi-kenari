import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { discoverAndLoadExtensions, ExtensionRunner, initTheme, ModelRegistry, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { UsagePanel, type UsageReport } from "../src/usage-panel.ts";

initTheme("dark");

const counters = {
  requests: 160,
  prompt_tokens: 532_000,
  completion_tokens: 114_000,
  cached_prompt_tokens: 200_000,
  cache_write_prompt_tokens: 0,
  cost_micro_idr: 15_400_000,
  catalog_micro_idr: 16_300_000,
};
const usage = {
  object: "usage.summary",
  start: 1_788_300_000,
  end: 1_790_892_000,
  data: [{ ...counters, model: "deepseek-v4-flash", billing_kind: "payg" }],
  total: counters,
};
const quota = {
  plan: {
    name: "Kreator",
    windows: {
      week: {
        budget_rp: 75_000, used_rp: 8_250, remaining_rp: 66_750,
        used_frac: 0.11, resets_at: "2026-10-28T07:12:00Z",
      },
      month: {
        budget_rp: 300_000, used_rp: 9_000, remaining_rp: 291_000,
        used_frac: 0.03, resets_at: "2026-11-20T07:12:00Z",
      },
    },
  },
  coupon: null,
  alert_pct: 80,
};

async function setup(t: TestContext) {
  const previousKey = process.env.KENARI_API_KEY;
  const previousOffline = process.env.PI_OFFLINE;
  delete process.env.KENARI_API_KEY;
  delete process.env.PI_OFFLINE;
  t.after(() => {
    if (previousKey === undefined) delete process.env.KENARI_API_KEY;
    else process.env.KENARI_API_KEY = previousKey;
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
  });
  const agentDir = await mkdtemp(resolve(tmpdir(), "pi-kenari-usage-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const loaded = await discoverAndLoadExtensions([resolve("index.ts")], process.cwd(), agentDir);
  assert.deepEqual(loaded.errors, []);
  const registration = loaded.runtime.pendingProviderRegistrations[0];
  assert.ok(registration);
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStore: new InMemoryModelsStore(), refreshOnCreate: false,
  });
  runtime.registerProvider(registration.name, registration.config);
  const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, process.cwd(), SessionManager.inMemory(), new ModelRegistry(runtime));
  const notify = t.mock.method(runner.getUIContext(), "notify");
  const command = runner.getCommand("kenari");
  assert.ok(command);
  return { runtime, command, ctx: runner.createCommandContext(), notify };
}

function mockReports(t: TestContext, usageBody: unknown = usage, quotaBody: unknown = quota) {
  return t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    assert.equal(request.headers.get("Authorization"), "Bearer kn-usage-test");
    assert.equal(request.headers.get("Accept"), "application/json");
    assert.equal(request.method, "GET");
    assert.equal(request.redirect, "error");
    assert.ok(init?.signal);
    if (request.url === "https://kenari.id/v1/account/quota") return Response.json(quotaBody);
    assert.match(request.url, /^https:\/\/kenari\.id\/v1\/usage\?range=(today|24h|7d|30d)$/);
    return Response.json(usageBody);
  });
}

test("/kenari usage resolves runtime credentials without a catalog and reports usage plus weekly and monthly quota", async (t) => {
  const { runtime, command, ctx, notify } = await setup(t);
  process.env.KENARI_API_KEY = "kn-env-key";
  await runtime.setRuntimeApiKey("kenari", "kn-usage-test");
  const fetch = mockReports(t);
  assert.equal(ctx.model, undefined);
  await command.handler("usage", ctx);
  assert.equal(fetch.mock.callCount(), 2);
  assert.ok(fetch.mock.calls.some((call) => String(call.arguments[0]).endsWith("/usage?range=30d")));
  const [text, level] = notify.mock.calls.at(-1)?.arguments ?? [];
  assert.equal(level, "info");
  assert.match(String(text), /Weekly\n🟢 \[[█░]+\] 89% left\nRp 66,750 of Rp 75,000 remaining/);
  assert.match(String(text), /Monthly\n🟢 \[[█░]+\] 97% left\nRp 291,000 of Rp 300,000 remaining/);
  assert.match(String(text), /Reset at 2026-10-28T07:12:00.000Z/);
  assert.match(String(text), /Requests: 160/);
  assert.match(String(text), /Tokens: 532,000 input, 114,000 output/);
  assert.match(String(text), /Cache: 200,000 read, 0 written/);
  assert.match(String(text), /Charged to balance: Rp 15.4/);
  assert.match(String(text), /List-price value: Rp 16.3/);
  assert.match(String(text), /deepseek-v4-flash \[payg\]/);
  assert.doesNotMatch(String(text), /kn-usage-test|kn-env-key/);
});

test("usage ranges and argument completion use Kenari's supported presets", async (t) => {
  const { command, ctx } = await setup(t);
  process.env.KENARI_API_KEY = "kn-usage-test";
  const fetch = mockReports(t);
  for (const range of ["today", "24h", "7d", "30d"]) {
    await command.handler(` usage ${range} `, ctx);
    assert.ok(fetch.mock.calls.some((call) => String(call.arguments[0]).endsWith(`/usage?range=${range}`)));
  }
  assert.deepEqual(await command.getArgumentCompletions?.("us"), [{ value: "usage", label: "usage" }]);
  assert.deepEqual(await command.getArgumentCompletions?.("usage 7"), [{ value: "usage 7d", label: "usage 7d" }]);
});

test("help, invalid ranges, missing credentials and offline mode make no requests", async (t) => {
  const { command, ctx, notify } = await setup(t);
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network request"); });
  for (const args of ["", "help", "usage 14d", "usage 7d extra"]) {
    await command.handler(args, ctx);
    assert.match(String(notify.mock.calls.at(-1)?.arguments[0]), /Usage: \/kenari usage/);
  }
  await command.handler("usage", ctx);
  assert.match(String(notify.mock.calls.at(-1)?.arguments[0]), /No Kenari API key/);
  process.env.KENARI_API_KEY = "kn-usage-test";
  process.env.PI_OFFLINE = "1";
  await command.handler("usage", ctx);
  assert.match(String(notify.mock.calls.at(-1)?.arguments[0]), /Offline mode/);
  assert.equal(fetch.mock.callCount(), 0);
});

test("restricted keys still see usage when quota is forbidden", async (t) => {
  const { command, ctx, notify } = await setup(t);
  process.env.KENARI_API_KEY = "kn-usage-test";
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => String(input).endsWith("/quota")
    ? new Response("private error detail", { status: 403 }) : Response.json(usage));
  await command.handler("usage", ctx);
  const [text, level] = notify.mock.calls.at(-1)?.arguments ?? [];
  assert.equal(level, "warning");
  assert.match(String(text), /Quota requires an unrestricted key/);
  assert.match(String(text), /Requests: 160/);
  assert.doesNotMatch(String(text), /private error detail/);
});

test("quota remains visible when usage is rate limited, unauthorized or unavailable", async (t) => {
  const { command, ctx, notify } = await setup(t);
  process.env.KENARI_API_KEY = "kn-usage-test";
  for (const status of [401, 403, 429, 500]) {
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => String(input).endsWith("/quota")
      ? Response.json(quota) : new Response("private error detail", { status }));
    await command.handler("usage", ctx);
    const [text, level] = notify.mock.calls.at(-1)?.arguments ?? [];
    assert.equal(level, "warning");
    assert.match(String(text), new RegExp(`HTTP ${status}`));
    assert.match(String(text), /Weekly\n🟢 \[[█░]+\] 89% left/);
    assert.doesNotMatch(String(text), /private error detail/);
  }
});

test("empty usage and an account without a plan are explicit", async (t) => {
  const { command, ctx, notify } = await setup(t);
  process.env.KENARI_API_KEY = "kn-usage-test";
  const zeroCounters = Object.fromEntries(Object.keys(counters).map((key) => [key, 0]));
  mockReports(t, { ...usage, data: [], total: zeroCounters }, { plan: null, coupon: null, alert_pct: 80 });
  await command.handler("usage", ctx);
  const text = String(notify.mock.calls.at(-1)?.arguments[0]);
  assert.match(text, /no active plan/);
  assert.match(text, /No usage in this window/);
  assert.match(text, /Charged to balance: Rp 0/);
});

test("uncapped, exhausted, and five-hour quota windows keep their meaning", async (t) => {
  const { command, ctx, notify } = await setup(t);
  process.env.KENARI_API_KEY = "kn-usage-test";
  mockReports(t, usage, { plan: { name: "Test", windows: {
    week: { ...quota.plan.windows.week, remaining_rp: 0, used_frac: 1 },
    five_hour: { ...quota.plan.windows.week, remaining_rp: 75_000, used_frac: 0 },
  } } });
  await command.handler("usage", ctx);
  const text = String(notify.mock.calls.at(-1)?.arguments[0]);
  assert.match(text, /Weekly\n🔴 \[░+\] 0% left\nRp 0/);
  assert.match(text, /Monthly: no quota ceiling/);
  assert.match(text, /Five-hour\n🟢 \[█+\] 100% left/);
});

test("malformed usage or quota does not produce misleading totals or hide the other report", async (t) => {
  const { command, ctx, notify } = await setup(t);
  process.env.KENARI_API_KEY = "kn-usage-test";
  for (const invalid of [{}, { ...usage, total: { ...counters, cost_micro_idr: -1 } }, { ...usage, start: usage.end + 1 }]) {
    mockReports(t, invalid);
    await command.handler("usage", ctx);
    const text = String(notify.mock.calls.at(-1)?.arguments[0]);
    assert.match(text, /invalid usage response/);
    assert.match(text, /Weekly\n🟢 \[[█░]+\] 89% left/);
    assert.doesNotMatch(text, /Charged to balance/);
  }
  for (const window of [
    { ...quota.plan.windows.week, used_frac: 1.5 },
    { ...quota.plan.windows.week, resets_at: "invalid" },
  ]) {
    mockReports(t, usage, { plan: { name: "Test", windows: { week: window } } });
    await command.handler("usage", ctx);
    const text = String(notify.mock.calls.at(-1)?.arguments[0]);
    assert.match(text, /invalid quota response/);
    assert.match(text, /Requests: 160/);
  }
});

test("network failures, malformed JSON, cancellation, and timeouts are reported without leaking error details", async (t) => {
  const { command, ctx, notify } = await setup(t);
  process.env.KENARI_API_KEY = "kn-usage-test";
  t.mock.method(globalThis, "fetch", async () => { throw new Error("private error detail"); });
  await command.handler("usage", ctx);
  assert.match(String(notify.mock.calls.at(-1)?.arguments[0]), /Check your connection/);
  assert.doesNotMatch(String(notify.mock.calls.at(-1)?.arguments[0]), /private error detail/);
  t.mock.method(globalThis, "fetch", async () => new Response("{invalid json"));
  await command.handler("usage", ctx);
  assert.match(String(notify.mock.calls.at(-1)?.arguments[0]), /invalid usage response/);
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    init?.signal?.throwIfAborted();
    throw new Error("Expected an aborted signal");
  });
  Object.defineProperty(ctx, "signal", { value: AbortSignal.abort(), configurable: true });
  await command.handler("usage", ctx);
  assert.match(String(notify.mock.calls.at(-1)?.arguments[0]), /cancelled/);
  Object.defineProperty(ctx, "signal", { value: undefined });
  t.mock.method(AbortSignal, "timeout", (delay: number) => {
    assert.equal(delay, 10_000);
    return AbortSignal.abort(new DOMException("Timed out", "TimeoutError"));
  });
  await command.handler("usage", ctx);
  assert.match(String(notify.mock.calls.at(-1)?.arguments[0]), /timed out after 10 seconds/);
  assert.equal(notify.mock.calls.at(-1)?.arguments[1], "error");
});

test("TUI commands open a custom panel without adding a transcript notification", async (t) => {
  const { command, ctx, notify } = await setup(t);
  Object.defineProperty(ctx, "mode", { value: "tui" });
  const custom = t.mock.method(ctx.ui, "custom", async () => undefined);
  await command.handler("usage", ctx);
  assert.equal(custom.mock.callCount(), 1);
  assert.equal(notify.mock.callCount(), 0);
});

test("quota indicators cover the 30% and 70% boundaries and reset countdowns", async (t) => {
  const { command, ctx, notify } = await setup(t);
  process.env.KENARI_API_KEY = "kn-usage-test";
  const reset = Date.parse(quota.plan.windows.week.resets_at);
  let now = reset - (2 * 60 + 15) * 60_000;
  t.mock.method(Date, "now", () => now);
  for (const [used, indicator, percent] of [
    [0.2999, "🟢", "70.01"], [0.3, "🟡", "70"],
    [0.7, "🟡", "30"], [0.7001, "🔴", "29.99"],
  ] satisfies Array<[number, string, string]>) {
    mockReports(t, usage, { plan: { name: "Test", windows: {
      week: { ...quota.plan.windows.week, used_frac: used },
    } } });
    await command.handler("usage", ctx);
    const text = String(notify.mock.calls.at(-1)?.arguments[0]);
    assert.ok(text.includes(`${indicator} [`));
    assert.ok(text.includes(`${percent}% left`));
    assert.match(text, /Resets in 2h 15m/);
  }
  now = reset - 45_000;
  await command.handler("usage", ctx);
  assert.match(String(notify.mock.calls.at(-1)?.arguments[0]), /Resets in 45s/);
  now = reset;
  await command.handler("usage", ctx);
  assert.match(String(notify.mock.calls.at(-1)?.arguments[0]), /Reset due. Press r to refresh/);
});

test("panel scrolls, wraps at terminal width, refreshes once, and updates its clock without fetching", async (t) => {
  const { ctx } = await setup(t);
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  let calls = 0;
  let requestSignal: AbortSignal | undefined;
  const reports: UsageReport[] = [{ ok: true, render: (time) => [
    `Clock ${time}`, "🟢 [██████████░░░░] 70% left",
    ...Array.from({ length: 30 }, (_, index) => `Model ${index}: ${"long content ".repeat(8)}`),
  ].join("\n") }];
  let resolveRefresh: ((value: UsageReport[]) => void) | undefined;
  let done = false;
  const panel = new UsagePanel({
    range: "30d", theme: ctx.ui.theme, height: () => 20,
    done: () => { done = true; }, requestRender: () => {},
    load: async (signal) => {
      calls += 1;
      requestSignal = signal;
      if (calls > 1) return new Promise<UsageReport[]>((resolve) => { resolveRefresh = resolve; });
      return reports;
    },
  });
  t.after(() => panel.dispose());
  assert.match(stripTerminalSequences(panel.render(80).join("\n")), /Loading usage and quota/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const initial = panel.render(80).join("\n");
  assert.match(stripTerminalSequences(initial), /Clock 1000000/);
  now += 1_000;
  assert.match(stripTerminalSequences(panel.render(80).join("\n")), /Clock 1001000/);
  assert.equal(calls, 1);
  panel.handleInput("\x1b[6~");
  const scrolled = stripTerminalSequences(panel.render(80).join("\n"));
  assert.doesNotMatch(scrolled, /Clock 1001000/);
  panel.handleInput("\x1b[F");
  assert.match(stripTerminalSequences(panel.render(80).join("\n")), /Model 29/);
  for (const width of [1, 20, 40, 80, 120]) {
    const lines = panel.render(width);
    assert.ok(lines.length <= 20);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
  }
  panel.handleInput("r");
  panel.handleInput("r");
  assert.equal(calls, 2);
  assert.match(stripTerminalSequences(panel.render(80).join("\n")), /Loading/);
  assert.ok(resolveRefresh);
  resolveRefresh(reports);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.match(stripTerminalSequences(panel.render(80).join("\n")), /Clock 1001000/);
  panel.handleInput("\x1b");
  assert.equal(done, true);
  assert.equal(requestSignal?.aborted, true);
});

test("closing a loading panel cancels its request and discards late results", async (t) => {
  const { ctx } = await setup(t);
  let release: ((value: UsageReport[]) => void) | undefined;
  let requestSignal: AbortSignal | undefined;
  let renders = 0;
  const panel = new UsagePanel({
    range: "7d", theme: ctx.ui.theme, height: () => 20,
    done: () => {}, requestRender: () => { renders += 1; },
    load: (signal) => {
      requestSignal = signal;
      return new Promise<UsageReport[]>((resolve) => { release = resolve; });
    },
  });
  t.after(() => panel.dispose());
  panel.handleInput("q");
  assert.equal(requestSignal?.aborted, true);
  assert.ok(release);
  release([{ ok: false, text: "Late response" }]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(renders, 0);
});
