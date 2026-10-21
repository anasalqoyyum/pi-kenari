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

Start Pi with a Kenari model:

```bash
pi --provider kenari --model 'hy3:free'
```

Or start Pi and choose a Kenari model with `/model`. To list the discovered models:

```bash
pi --list-models kenari
```

Pi resolves `KENARI_API_KEY` at request time. The extension does not copy it into files, put it in its source, or send it to the public catalog endpoints. Pi's runtime API key, stored credentials, or `models.json` credentials can take precedence over the environment variable.

Never commit your key. Export it again in a new shell, or load it through your own secret manager. This extension does not load `.env` files.

## Model discovery

On each load, including `/reload`, the extension reads these public endpoints with a 10-second timeout:

- `https://kenari.id/v1/models`
- `https://kenari.id/api/public/pricing`

It registers entries whose `endpoints` include `chat`, excluding models explicitly marked `tool_call: false` and models past their retirement date. Media-generation models and entries without chat metadata are not registered. Free variants retain their `:free` suffix. The provider also supplies a refresh callback for Pi's model-catalog refresh.

Network access is required at startup. Failed discovery produces an extension-loading error rather than a stale or hard-coded model list. There is no offline catalog cache. A discovered model may still require a subscription or sufficient balance, and restricted keys may not be allowed to use every listed model.

Context windows, output limits, image input, and reasoning levels come from the catalog. When Kenari omits limits, the extension uses a 128,000-token context window and an 8,192-token output limit. An advertised input limit further caps Pi's context window, and the output limit never exceeds that window. You can override these defaults per model in `~/.pi/agent/models.json`:

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
pi -e ./index.ts --provider kenari --model 'hy3:free'
```

Or install the local package for future sessions:

```bash
pi install /absolute/path/to/pi-kenari
```

Tests use simulated catalog and chat responses. They do not need an API key or spend Kenari credits. A live authenticated chat request requires your own key.

## References

- [Authentication](https://kenari.id/en/docs/authentication)
- [Models and pricing](https://kenari.id/en/docs/models)
- [Chat completions](https://kenari.id/en/docs/chat)
- [Function calling](https://kenari.id/en/docs/function-calling)
- [Reasoning](https://kenari.id/en/docs/reasoning)
- [Streaming](https://kenari.id/en/docs/streaming)
