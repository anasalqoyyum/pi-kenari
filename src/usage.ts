import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { BASE_URL } from "./catalog.ts";
import { UsagePanel, type UsageReport } from "./usage-panel.ts";

const RANGES = ["today", "24h", "7d", "30d"];
const HELP = "Usage: /kenari usage [today|24h|7d|30d]. Default: 30d. Today starts at 00:00 UTC.";
const Counter = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const Counters = Type.Object({
  requests: Counter,
  prompt_tokens: Counter,
  completion_tokens: Counter,
  cached_prompt_tokens: Counter,
  cache_write_prompt_tokens: Counter,
  cost_micro_idr: Counter,
  catalog_micro_idr: Counter,
});
const Timestamp = Type.Integer({ minimum: 0, maximum: 8_640_000_000_000 });
const UsageSummary = Type.Object({
  object: Type.Literal("usage.summary"),
  start: Timestamp,
  end: Timestamp,
  data: Type.Array(Type.Object({
    ...Counters.properties,
    model: Type.String(),
    billing_kind: Type.String(),
  })),
  total: Counters,
});
const QuotaWindow = Type.Object({
  budget_rp: Counter,
  remaining_rp: Counter,
  used_frac: Type.Number({ minimum: 0, maximum: 1 }),
  resets_at: Type.String(),
});
const Quota = Type.Object({
  plan: Type.Union([Type.Null(), Type.Object({
    name: Type.String(),
    windows: Type.Object({
      five_hour: Type.Optional(QuotaWindow),
      week: Type.Optional(QuotaWindow),
      month: Type.Optional(QuotaWindow),
    }),
  })]),
});

function formatUsage(usage: unknown): Extract<UsageReport, { ok: true }>["render"] | undefined {
  if (!Value.Check(UsageSummary, usage) || usage.start > usage.end) return undefined;
  const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 });
  const count = (value: number) => number.format(value);
  const rupiah = (micro: number) => `Rp ${number.format(micro / 1_000_000)}`;
  const total = usage.total;
  const lines = [
    "Kenari usage",
    `Window: ${new Date(usage.start * 1000).toISOString()} to ${new Date(usage.end * 1000).toISOString()}`,
    "Scope: usage visible to the current API key.",
    `Requests: ${count(total.requests)}`,
    `Tokens: ${count(total.prompt_tokens)} input, ${count(total.completion_tokens)} output`,
    `Cache: ${count(total.cached_prompt_tokens)} read, ${count(total.cache_write_prompt_tokens)} written`,
    `Charged to balance: ${rupiah(total.cost_micro_idr)}`,
    `List-price value: ${rupiah(total.catalog_micro_idr)}`,
    "",
  ];
  if (usage.data.length === 0) lines.push("No usage in this window.");
  else {
    lines.push("By model and billing kind:");
    for (const row of usage.data) {
      lines.push(`${row.model} [${row.billing_kind}]: ${count(row.requests)} requests, ` +
        `${count(row.prompt_tokens)} input, ${count(row.completion_tokens)} output, ` +
        `${rupiah(row.cost_micro_idr)} charged, ${rupiah(row.catalog_micro_idr)} list price`);
    }
  }
  return () => lines.join("\n");
}

function countdown(reset: number, now: number): string {
  const seconds = Math.ceil((reset - now) / 1000);
  if (seconds <= 0) return "Reset due. Press r to refresh.";
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `Resets in ${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `Resets in ${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `Resets in ${minutes}m ${seconds % 60}s`;
  return `Resets in ${seconds}s`;
}

function formatQuota(quota: unknown): Extract<UsageReport, { ok: true }>["render"] | undefined {
  if (!Value.Check(Quota, quota)) return undefined;
  if (!quota.plan) return () => "Kenari quota: no active plan.";
  const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
  const planName = quota.plan.name;
  const windows: Array<[string, Static<typeof QuotaWindow> | undefined]> = [
    ["Weekly", quota.plan.windows.week],
    ["Monthly", quota.plan.windows.month],
    ["Five-hour", quota.plan.windows.five_hour],
  ];
  if (windows.some(([, window]) => window && !Number.isFinite(Date.parse(window.resets_at)))) return undefined;
  return (now, width) => {
    const lines = [`Kenari quota: ${planName}`, ""];
    const cells = Math.max(1, Math.min(28, width - 18));
    for (const [label, window] of windows) {
      if (!window) {
        if (label !== "Five-hour") lines.push(`${label}: no quota ceiling.`, "");
        continue;
      }
      const left = 1 - window.used_frac;
      const filled = Math.round(left * cells);
      const indicator = window.used_frac < 0.3 ? "🟢" : window.used_frac <= 0.7 ? "🟡" : "🔴";
      lines.push(
        label,
        `${indicator} [${"█".repeat(filled)}${"░".repeat(cells - filled)}] ${number.format(left * 100)}% left`,
        `Rp ${number.format(window.remaining_rp)} of Rp ${number.format(window.budget_rp)} remaining`,
        countdown(Date.parse(window.resets_at), now),
        `Reset at ${new Date(window.resets_at).toISOString()}`,
        "",
      );
    }
    return lines.join("\n");
  };
}

function httpError(status: number, label: string): string {
  const prefix = `Kenari ${label} request failed: HTTP ${status}.`;
  if (status === 401) return `${prefix} The API key is invalid or expired.`;
  if (status === 403) return label === "quota"
    ? `${prefix} Quota requires an unrestricted key from your own account.`
    : `${prefix} This key cannot read usage. Shared keys are not supported.`;
  if (status === 429) return `${prefix} Usage rate limit reached. Wait a few seconds and retry.`;
  return prefix;
}

async function fetchReport({ endpoint, label, apiKey, signal, format }: {
  endpoint: string;
  label: string;
  apiKey: string;
  signal: AbortSignal;
  format: (value: unknown) => Extract<UsageReport, { ok: true }>["render"] | undefined;
}): Promise<UsageReport> {
  try {
    const response = await fetch(`${BASE_URL}/${endpoint}`, {
      signal,
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      redirect: "error",
    });
    if (!response.ok) return { ok: false, text: httpError(response.status, label) };
    const data: unknown = await response.json();
    const render = format(data);
    return render === undefined
      ? { ok: false, text: `Kenari returned an invalid ${label} response.` }
      : { ok: true, render };
  } catch (error) {
    let text = `Could not read Kenari ${label}. Check your connection and try again.`;
    if (signal.aborted) text = signal.reason instanceof Error && signal.reason.name === "TimeoutError"
      ? `Kenari ${label} request timed out after 10 seconds.`
      : `Kenari ${label} request cancelled.`;
    else if (error instanceof SyntaxError) text = `Kenari returned an invalid ${label} response.`;
    return { ok: false, text };
  }
}

export function registerUsageCommand(pi: ExtensionAPI): void {
  pi.registerCommand("kenari", {
    description: "Check Kenari usage and quota with /kenari usage [today|24h|7d|30d]",
    getArgumentCompletions: (prefix) => {
      const choices = prefix.includes(" ") ? RANGES.map((range) => `usage ${range}`) : ["usage"];
      const matches = choices.filter((choice) => choice.startsWith(prefix));
      return matches.length ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const [subcommand, range = "30d", ...extra] = args.trim().split(/\s+/);
      if (subcommand !== "usage" || !RANGES.includes(range) || extra.length > 0) {
        ctx.ui.notify(HELP, "info");
        return;
      }
      if (process.env.PI_OFFLINE !== undefined) {
        ctx.ui.notify("Offline mode: Kenari usage requires a network request.", "warning");
        return;
      }
      const load = async (panelSignal: AbortSignal): Promise<UsageReport[]> => {
        const apiKey = await ctx.modelRegistry.getApiKeyForProvider("kenari");
        if (!apiKey) return [{ ok: false, text: "No Kenari API key available. Configure KENARI_API_KEY or Kenari credentials in Pi." }];
        const signals = [panelSignal, AbortSignal.timeout(10_000)];
        if (ctx.signal) signals.push(ctx.signal);
        const signal = AbortSignal.any(signals);
        return Promise.all([
          fetchReport({ endpoint: "account/quota", label: "quota", apiKey, signal, format: formatQuota }),
          fetchReport({ endpoint: `usage?range=${range}`, label: "usage", apiKey, signal, format: formatUsage }),
        ]);
      };
      if (ctx.mode === "tui") {
        await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new UsagePanel({
          range, theme, load,
          requestRender: () => tui.requestRender(),
          height: () => Math.max(7, Math.min(30, tui.terminal.rows - 6)),
          done: () => done(),
        }));
        return;
      }
      const reports = await load(new AbortController().signal);
      const level = reports.every((report) => report.ok) ? "info"
        : reports.some((report) => report.ok) ? "warning" : "error";
      ctx.ui.notify(reports.map((report) => report.ok ? report.render(Date.now(), 80) : report.text).join("\n\n"), level);
    },
  });
}
