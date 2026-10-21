import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BASE_URL, discoverModels } from "./src/catalog.ts";

export default async function kenari(pi: ExtensionAPI): Promise<void> {
  let models = await discoverModels();
  pi.registerProvider("kenari", {
    name: "Kenari",
    baseUrl: BASE_URL,
    api: "openai-completions",
    apiKey: "$KENARI_API_KEY",
    models,
    refreshModels: async ({ allowNetwork, signal }) => {
      if (allowNetwork) models = await discoverModels(signal);
      return models;
    },
  });
}
