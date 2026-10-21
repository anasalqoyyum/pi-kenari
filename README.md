# pi-kenari

[Kenari](https://kenari.id/en/docs) provider extension for [Pi](https://pi.dev). Loads tool-capable chat models from Kenari's live catalog and uses Pi's built-in OpenAI Chat Completions implementation for text, reasoning, tool calls, and image input on vision models.

Tested with `@earendil-works/pi-coding-agent` 1.3.0 and Node.js 22.19 or newer.

## Install

Install directly from GitHub:

```bash
pi install git:github.com/anasalqoyyum/pi-kenari
```

Start a new Pi session, or run `/reload` in an existing one. To install for the current project only, add `--local`.

## Use it

Create an API key in the [Kenari dashboard](https://kenari.id), then export it in the shell that starts Pi:

```bash
export KENARI_API_KEY='kn-your-key'
```

On first use, start Pi without selecting a Kenari model on the command line. Pi discovers models in the background after the UI opens. Run `/model` to choose one, or `/kenari-refresh` to explicitly fetch the catalog and wait for discovery.

Once a catalog has been saved, you can start Pi directly with a Kenari model:

```bash
pi --provider kenari --model 'hy3:free'
```

To list the saved models:

```bash
pi --list-models kenari
```

Pi resolves `KENARI_API_KEY` at request time. The extension does not copy it into files, put it in its source, or send it to the public catalog endpoints. Pi's runtime API key, stored credentials, or `models.json` credentials can take precedence over the environment variable.

Never commit your key. Export it again in a new shell, or load it through your own secret manager. This extension does not load `.env` files.

## Model discovery

Pi loads the saved catalog at startup and on `/reload` without making network requests. With Kenari credentials configured, it refreshes missing or outdated catalogs in the background, at most once every four hours after a successful refresh.

Run `/kenari-refresh` to refresh immediately. Discovery times out after 10 seconds, and failed or cancelled refreshes keep the last good catalog. `--offline` or `PI_OFFLINE=1` uses only saved models, even with `/kenari-refresh`.

On first use, save a catalog with `/kenari-refresh` in an interactive session before selecting Kenari models on the command line or using `--list-models` or noninteractive mode.

The catalog excludes non-chat models, models explicitly marked as lacking tool support, and models retired at discovery time. Free variants keep their `:free` suffix. Saved metadata may become outdated, and listed models may still require a subscription, balance, or permission from your API key.

Model capabilities and token limits come from the catalog. Missing limits default to a 128,000-token context window and an 8,192-token output limit. An advertised input limit can reduce the context window, and output never exceeds that window. Override limits per model in `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "kenari": {
      "modelOverrides": {
        "your-model-id": {
          "contextWindow": 128000,
          "maxTokens": 4096
        }
      }
    }
  }
}
```

## Cost display

Kenari bills in Rupiah. Pi displays USD estimates. The extension converts Kenari's micro-IDR prices per million tokens using `usd_idr_rate` from the public pricing feed. Free models report zero cost even if their catalog entry includes paid list prices. Missing prices also report zero, so Pi's totals are estimates, not an invoice. Subscription coverage and account-specific pricing are not included.

## Development

```bash
pnpm install
pnpm check
pnpm test
```

Try a local checkout without changing your Pi settings:

```bash
pi -e ./index.ts
```

Run `/kenari-refresh`, then choose a model with `/model`.

Or install the local package for future sessions:

```bash
pi install /absolute/path/to/pi-kenari
```

Tests use simulated catalog and chat responses. They do not need an API key or spend Kenari credits. Startup tests exercise Pi's actual extension loader, model runtime, and file-backed catalog store. A live authenticated chat request requires your own key.

## References

- [Authentication](https://kenari.id/en/docs/authentication)
- [Models and pricing](https://kenari.id/en/docs/models)
- [Chat completions](https://kenari.id/en/docs/chat)
- [Function calling](https://kenari.id/en/docs/function-calling)
- [Reasoning](https://kenari.id/en/docs/reasoning)
- [Streaming](https://kenari.id/en/docs/streaming)
