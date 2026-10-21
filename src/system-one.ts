import { calculateCost } from "@earendil-works/pi-ai";
import type {
  ClassifierApi,
  ClassifierFunction,
  ClassifierAnswer,
  ClassifierContext,
  ClassifierModel,
  ClassifierOptions,
  ClassifierResult,
  ImageContent,
  Usage,
} from "@earendil-works/pi-ai";

/**
 * Classifier API id for Kenari's System One endpoint.
 *
 * Kenari serves the TypeSafe System One contract at `POST /v1/systemone`: the request is the
 * System One body plus `model`, and the response is `{ model, answers, usage }` with no envelope.
 * https://kenari.id/en/docs/systemone
 */
export const SYSTEM_ONE_API = "kenari-system-one";

const LABEL = "Kenari System One";

type WireQuestion = { type: string; instructions: unknown; criteria?: unknown };
type WireBody = { model: string; state: ClassifierContext["state"]; questions: Record<string, WireQuestion> };

/** System One spells a yes/no question `noul`; Pi's classifier API calls it `bool`. */
function wireQuestion(question: ClassifierContext["questions"][string]): WireQuestion {
  return question.type === "bool" ? { ...question, type: "noul" } : question;
}

function assets(images: readonly ImageContent[]): Record<string, unknown> {
  return Object.fromEntries(images.map((image, index) => {
    const [, format = "png"] = image.mimeType.split("/");
    return [`image_${index + 1}`, { type: "image", format, data_base64: image.data }];
  }));
}

/**
 * Parses Kenari's answers into Pi's classifier answers. Kenari sends `noul` for yes/no questions,
 * the same wire name TypeSafe uses, and may add fields such as a score `legend` that Pi ignores.
 */
function parseAnswers(
  value: Record<string, unknown>,
  questions: ClassifierContext["questions"],
): Record<string, ClassifierAnswer> {
  const answers: Array<[string, ClassifierAnswer]> = [];
  for (const [id, question] of Object.entries(questions)) {
    const answer = value[id];
    if (typeof answer !== "object" || answer === null) throw new Error(`${LABEL} did not return an answer for ${id}`);
    const entry = answer as Record<string, unknown>;
    const number = (field: string): number => {
      const found = entry[field];
      if (typeof found !== "number" || !Number.isFinite(found)) {
        throw new Error(`${LABEL} returned an invalid ${field} for ${id}`);
      }
      return found;
    };

    if (question.type === "choice") {
      const probabilities = entry.probabilities;
      if (entry.type !== "choice" || typeof entry.choice !== "string" ||
        typeof probabilities !== "object" || probabilities === null) {
        throw new Error(`${LABEL} did not return a choice answer for ${id}`);
      }
      answers.push([id, {
        type: "choice",
        choice: entry.choice,
        probabilities: Object.fromEntries(
          Object.entries(probabilities).map(([option, probability]) => [option, Number(probability)]),
        ),
        confidence: number("confidence"),
      }]);
    } else if (question.type === "score") {
      if (entry.type !== "score") throw new Error(`${LABEL} did not return a score answer for ${id}`);
      answers.push([id, { type: "score", score: number("score"), confidence: number("confidence") }]);
    } else {
      if (entry.type !== "noul") throw new Error(`${LABEL} did not return a bool answer for ${id}`);
      answers.push([id, { type: "bool", probability: number("noul") }]);
    }
  }
  return Object.fromEntries(answers);
}

/** System One reports input and output tokens; Kenari bills input only, which the model cost reflects. */
function parseUsage(value: Record<string, unknown>, model: ClassifierModel<ClassifierApi>): Usage | undefined {
  const count = (field: string) => {
    const found = value[field];
    return typeof found === "number" && Number.isFinite(found) && found > 0 ? found : 0;
  };
  const input = count("input_tokens");
  const output = count("output_tokens");
  if (input === 0 && output === 0) return undefined;
  const usage: Usage = {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  calculateCost(model, usage);
  return usage;
}

/**
 * Request headers with Pi's documented precedence: defaults first, then caller headers, where a
 * later name replaces an earlier one case-insensitively and a `null` value suppresses it.
 */
function requestHeaders(options: ClassifierOptions, apiKey: string): Record<string, string> {
  const defaults: ClassifierOptions["headers"] = {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
  const merged = new Map<string, [string, string]>();
  for (const source of [defaults, options.headers]) {
    for (const [name, value] of Object.entries(source ?? {})) {
      const normalized = name.toLowerCase();
      merged.delete(normalized);
      if (value !== null) merged.set(normalized, [name, value]);
    }
  }
  return Object.fromEntries(merged.values());
}

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, name) => { record[name] = value; });
  return record;
}

function errorMessage(status: number, body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
      const error = (parsed as { error: unknown }).error;
      if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
        return `${LABEL} error (HTTP ${status}): ${error.message}`;
      }
    }
  } catch {
    // A non-JSON error body falls through to the status-only message.
  }
  return `${LABEL} request failed: HTTP ${status}`;
}

/**
 * One System One classification. Failures resolve to a result with `stopReason: "error"` rather
 * than rejecting, matching the classifier contract Pi's `classify()` documents.
 */
export async function classifySystemOne(
  model: ClassifierModel<ClassifierApi>,
  context: ClassifierContext,
  options: ClassifierOptions | undefined,
): Promise<ClassifierResult> {
  const result: ClassifierResult = {
    api: model.api,
    provider: model.provider,
    model: model.id,
    answers: {},
    stopReason: "stop",
    timestamp: Date.now(),
  };

  try {
    if (!options?.apiKey) throw new Error(`No API key for provider: ${model.provider}`);
    if (context.images?.length && !model.input.includes("image")) {
      throw new Error(`${LABEL} model ${model.id} does not accept images`);
    }

    const body: WireBody & { assets?: Record<string, unknown> } = {
      model: model.id,
      state: context.state,
      questions: Object.fromEntries(
        Object.entries(context.questions).map(([id, question]) => [id, wireQuestion(question)]),
      ),
    };
    if (context.images?.length) body.assets = assets(context.images);

    const payload = await options.onPayload?.(body, model) ?? body;
    const response = await (options.fetch ?? globalThis.fetch)(
      new URL("systemone", `${model.baseUrl.replace(/\/+$/u, "")}/`),
      {
        method: "POST",
        headers: requestHeaders(options, options.apiKey),
        body: JSON.stringify(payload),
        signal: options.signal,
      },
    );
    await options.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
    const text = await response.text();
    if (!response.ok) throw new Error(errorMessage(response.status, text));

    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) throw new Error(`${LABEL} returned an unexpected response`);
    const { answers, usage } = parsed as { answers?: unknown; usage?: unknown };
    if (typeof answers !== "object" || answers === null) throw new Error(`${LABEL} returned no answers`);
    result.answers = parseAnswers(answers as Record<string, unknown>, context.questions);
    if (typeof usage === "object" && usage !== null) result.usage = parseUsage(usage as Record<string, unknown>, model);
    return result;
  } catch (error) {
    result.stopReason = options?.signal?.aborted ? "aborted" : "error";
    result.errorMessage = error instanceof Error ? error.message : String(error);
    return result;
  }
}

/** Pi's provider contract for a classifier implementation. */
export const classify: ClassifierFunction = (model, context, options) =>
  classifySystemOne(model, context, options);
