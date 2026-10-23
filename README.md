# pi-kenari

[Kenari](https://kenari.id/en/docs) provider extension for [Pi](https://pi.dev). Loads tool-capable chat models from Kenari's live catalog and uses Pi's built-in OpenAI Chat Completions implementation for text, reasoning, tool calls, and image input on vision models. It also registers Kenari's System One decision models as Pi classifier models for `codemode`'s `models.classify()` and classifier-driven extensions.

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

## Usage

Run `/kenari usage` to read your usage over the last 30 days from Kenari. Choose another window with `/kenari usage today`, `/kenari usage 24h`, `/kenari usage 7d`, or `/kenari usage 30d`. `today` starts at 00:00 UTC. The report shows the resolved window, requests, input and output tokens, cache tokens, and a breakdown by model and billing kind.

In Pi's terminal UI, the command opens a settings-style panel in the editor area. Use Up/Down or Page Up/Page Down to scroll, Home/End to jump, `r` to refresh, and Escape or `q` to close. The panel does not add output to the conversation. Other modes receive a plain-text report.

The panel shows weekly and monthly quota with bars representing the amount remaining. Indicators are green above 70% remaining, yellow from 30% through 70%, and red below 30%. Each window shows the percentage left, remaining Rupiah, budget, a live reset countdown such as `Resets in 2h 15m`, and the UTC reset time. Countdown updates do not make network requests; press `r` to fetch current quota after a reset.

Five-hour quota appears when the plan has that ceiling. Quota windows come from Kenari and do not change with the usage range. A missing ceiling is shown as uncapped; an account without an active plan is identified explicitly.

Amounts are in Rupiah. "Charged to balance" is what Kenari deducted from your balance; "List-price value" includes the catalog value of plan, coupon, free, and BYOK requests, even when the charge is zero. These are Kenari's reported figures, separate from Pi's USD cost estimates.

The command resolves Kenari credentials through Pi at request time and works before model discovery or while another provider is selected. An unrestricted key reads the whole account, including usage outside Pi. A restricted key reads only its own usage and cannot read plan quota; shared keys cannot read either. If one endpoint fails, the report still shows the other endpoint's results. Reading usage and quota is free, times out after 10 seconds, and is unavailable with `--offline` or `PI_OFFLINE=1`.

## Model discovery

Pi loads the saved catalog at startup and on `/reload` without making network requests. With Kenari credentials configured, it refreshes missing or outdated catalogs in the background, at most once every four hours after a successful refresh.

Run `/kenari-refresh` to refresh immediately. Discovery times out after 10 seconds, and failed or cancelled refreshes keep the last good catalog. `--offline` or `PI_OFFLINE=1` uses only saved models, even with `/kenari-refresh`.

On first use, save a catalog with `/kenari-refresh` in an interactive session before selecting Kenari models on the command line or using `--list-models` or noninteractive mode.

The catalog excludes non-chat models, models explicitly marked as lacking tool support, and models retired at discovery time. Free variants keep their `:free` suffix. Saved metadata may become outdated, and listed models may still require a subscription, balance, or permission from your API key.

Kenari's catalog also lists image, video, speech, transcription, music, rerank, moderation, and embedding models. This extension registers none of them: Pi only streams chat models, and the extension does not implement those endpoints. Chat models that accept `file`, `pdf`, `video`, or `audio` input are registered as text and image models, because Pi's chat content types carry no other input kind.

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

## Classifiers

System One models (`jev-1-13`, `jev-1-13:free`, `jev-1-14`, `clef:free`, `clef-flash:free`) answer typed questions about JSON state and images instead of chatting. Kenari lists them only under `?modality=systemone`, and discovery registers them as Pi classifier models.

Classifier models never appear in `/model`. Reach them from `codemode`, which is off unless `"defaultTools": ["+codemode"]` is set in settings:

```js
const jev = await models.getModelOfType("classifier", "kenari", "jev-1-13:free");
const result = await models.classify(jev, {
  state: { message: "The change works, thanks!" },
  questions: {
    approved: { type: "bool", instructions: "Does the user approve?", criteria: { true: "approval", false: "no approval" } },
  },
});
return result.answers;
```

Extensions reach the same models through `ctx.modelRegistry.classify()`. To make Kenari the default classifier for the `classify` tool or a Jev-routing extension, name it in `~/.pi/agent/settings.json`:

```json
{ "classifier": { "model": "kenari/jev-1-13:free" } }
```

`jev-1-14` and the Clef models also read images passed in `images`; `jev-1-13` and `jev-1-13:free` reject them. Kenari bills System One input tokens only, so reported cost uses the input rate and counts output tokens at zero. Kenari publishes no token limit for these models, so the extension assumes a 64,000-token context window.

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

Tests use simulated catalog, chat, usage, and quota responses. They do not need an API key or spend Kenari credits. Startup and command tests exercise Pi's actual extension loader and model runtime; startup tests also cover the file-backed catalog store. A live authenticated request requires your own key.

## References

- [Authentication](https://kenari.id/en/docs/authentication)
- [Models and pricing](https://kenari.id/en/docs/models)
- [Chat completions](https://kenari.id/en/docs/chat)
- [Function calling](https://kenari.id/en/docs/function-calling)
- [Reasoning](https://kenari.id/en/docs/reasoning)
- [Streaming](https://kenari.id/en/docs/streaming)
- [System One](https://kenari.id/en/docs/systemone)
- [Usage](https://kenari.id/en/docs/usage)
- [Account quota](https://kenari.id/en/docs/account-quota)
