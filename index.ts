import type { AnyModel } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BASE_URL, discoverModels } from "./src/catalog.ts";
import { SYSTEM_ONE_API, classify } from "./src/system-one.ts";
import { registerUsageCommand } from "./src/usage.ts";

const CATALOG_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;

export default function kenari(pi: ExtensionAPI): void {
  registerUsageCommand(pi);

  pi.registerProvider("kenari", {
    name: "Kenari",
    baseUrl: BASE_URL,
    api: "openai-completions",
    apiKey: "$KENARI_API_KEY",
    models: [],
    classifiers: { [SYSTEM_ONE_API]: { classify } },
    refreshModels: async ({ allowNetwork, force, signal, stored, publish }) => {
      const cached = (stored?.models ?? []).filter(
        (model): model is AnyModel =>
          model.provider === "kenari" && model.baseUrl === BASE_URL &&
          (model.api === "openai-completions" || model.api === SYSTEM_ONE_API),
      );
      if (!allowNetwork) return cached;

      const age = typeof stored?.checkedAt === "number" ? Date.now() - stored.checkedAt : Infinity;
      if (!force && cached.length > 0 && age >= 0 && age < CATALOG_REFRESH_INTERVAL_MS) return cached;

      const models = await discoverModels(signal);
      const published = await publish({
        persist: {
          models: models.map((model) => ({ ...model, provider: "kenari", baseUrl: BASE_URL })),
          checkedAt: Date.now(),
        },
      });
      return published ? models : cached;
    },
  });

  pi.registerCommand("kenari-refresh", {
    description: "Refresh Kenari's model catalog now",
    handler: async (_args, ctx) => {
      const result = await ctx.modelRegistry.refresh({ providers: ["kenari"], force: true });
      const error = result.errors.get("kenari");
      if (error) ctx.ui.notify(error.message, "error");
      else if (result.aborted) ctx.ui.notify("Kenari model refresh cancelled.", "warning");
      else if (!ctx.modelRegistry.getAvailable().some((model) => model.provider === "kenari")) {
        ctx.ui.notify("No Kenari models available. Configure KENARI_API_KEY and refresh online to save a catalog.", "warning");
      } else if (process.env.PI_OFFLINE !== undefined) {
        ctx.ui.notify("Offline mode: using the saved Kenari catalog. No network refresh was made.", "info");
      } else ctx.ui.notify("Kenari model catalog refreshed. Use /model to select a model.", "info");
    },
  });
}
