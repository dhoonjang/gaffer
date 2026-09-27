import { z } from "zod";
import type {
  EvaluationRequest,
  EvaluationResult,
  EvaluationAnswer,
  EvaluatorConfig,
  GameEvaluator,
} from "./game-evaluator";
import type { TurnUsage } from "./game-llm";
import { isRetryableStatus, kindOfStatus, LlmCallError } from "./llm-error";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const PROBABILITY_TOLERANCE = 1e-6;
// The direct API serializes probabilities and scores independently to hundredths.
const WIRE_ROUNDING_RADIUS = 0.005;
const RETRY_BASE_MS = 250;
const RETRY_MAX_MS = 5_000;
const probabilitySchema = z.number().finite().min(0).max(1);
const usageSchema = z.object({
  input_tokens: z.number().int().nonnegative().safe(),
  output_tokens: z.number().int().nonnegative().safe(),
});
const questionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("score"),
      instructions: z.string().min(1),
      criteria: z.array(z.string().min(1)).min(2).max(10),
    })
    .strict(),
  z
    .object({
      type: z.literal("choice"),
      instructions: z.string().min(1),
      criteria: z.record(z.string().nullable()).refine((criteria) => {
        const count = Object.keys(criteria).length;
        return count >= 1 && count <= 255;
      }),
    })
    .strict(),
  z
    .object({
      type: z.literal("noul"),
      instructions: z.string().min(1),
      criteria: z
        .object({ true: z.string().optional(), false: z.string().optional() })
        .strict()
        .optional(),
    })
    .strict(),
]);
const requestSchema = z
  .object({
    state: z.string(),
    questions: z.record(questionSchema).refine((questions) => Object.keys(questions).length > 0),
    signal: z.instanceof(AbortSignal).optional(),
  })
  .strict();
const responseSchema = z.object({
  model: z.string().min(1),
  answers: z.record(
    z.discriminatedUnion("type", [
      z.object({
        type: z.literal("score"),
        score: z.number().finite(),
        legend: z.record(z.string()),
        probabilities: z.record(probabilitySchema),
        confidence: probabilitySchema,
      }),
      z.object({
        type: z.literal("choice"),
        choice: z.string(),
        probabilities: z.record(probabilitySchema),
        confidence: probabilitySchema,
      }),
      z.object({ type: z.literal("noul"), noul: probabilitySchema }),
    ]),
  ),
  usage: usageSchema,
});

function sameKeys(record: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return (
    Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key))
  );
}

function normalizedProbabilities(
  probabilities: Readonly<Record<string, number>>,
  keys: readonly string[],
  allowWireRounding = false,
): Record<string, number> {
  const parsed = z.record(probabilitySchema).safeParse(probabilities);
  if (!parsed.success || !sameKeys(probabilities, keys)) {
    throw new LlmCallError("unknown", "TypeSafe returned invalid probability options");
  }
  const total = Object.values(parsed.data).reduce((sum, probability) => sum + probability, 0);
  if (Math.abs(total - 1) > PROBABILITY_TOLERANCE) {
    const values = Object.values(parsed.data);
    const minimum = values.reduce(
      (sum, probability) => sum + wireProbabilityBounds(probability).lower,
      0,
    );
    const maximum = values.reduce(
      (sum, probability) => sum + wireProbabilityBounds(probability).upper,
      0,
    );
    if (
      !allowWireRounding ||
      total <= 0 ||
      !values.every(hasWirePrecision) ||
      minimum > 1 + PROBABILITY_TOLERANCE ||
      maximum < 1 - PROBABILITY_TOLERANCE
    ) {
      throw new LlmCallError("unknown", "TypeSafe probabilities do not sum to one");
    }
  }
  return Object.fromEntries(
    Object.entries(parsed.data).map(([key, probability]) => [key, probability / total]),
  );
}

/** Ordered Score levels start at zero; tiny wire rounding drift is normalized. */
export function scoreExpectation(probabilities: Readonly<Record<string, number>>): number {
  const size = Object.keys(probabilities).length;
  if (size < 2 || size > 10)
    throw new LlmCallError("unknown", "TypeSafe returned invalid score levels");
  const levels = Array.from({ length: size }, (_, index) => String(index));
  return Object.entries(normalizedProbabilities(probabilities, levels)).reduce(
    (sum, [level, probability]) => sum + Number(level) * probability,
    0,
  );
}

function hasWirePrecision(value: number): boolean {
  return Math.abs(value * 100 - Math.round(value * 100)) < PROBABILITY_TOLERANCE;
}

function wireProbabilityBounds(probability: number): { lower: number; upper: number } {
  return {
    lower: Math.max(0, probability - WIRE_ROUNDING_RADIUS),
    upper: Math.min(1, probability + WIRE_ROUNDING_RADIUS),
  };
}

/** Possible expectations before independently rounding each reported probability. */
function roundedScoreBounds(probabilities: Readonly<Record<string, number>>): [number, number] {
  const levels = Object.entries(probabilities).map(([level, probability]) => ({
    level: Number(level),
    ...wireProbabilityBounds(probability),
  }));
  const extreme = (descending: boolean): number => {
    let remaining = 1 - levels.reduce((sum, level) => sum + level.lower, 0);
    let expectation = levels.reduce((sum, level) => sum + level.level * level.lower, 0);
    const ordered = [...levels].sort((a, b) =>
      descending ? b.level - a.level : a.level - b.level,
    );
    for (const level of ordered) {
      const allocated = Math.min(Math.max(0, remaining), level.upper - level.lower);
      expectation += level.level * allocated;
      remaining -= allocated;
    }
    return expectation;
  };
  return [extreme(false), extreme(true)];
}

function parseAnswers(
  value: unknown,
  questions: EvaluationRequest["questions"],
): Omit<EvaluationResult, "usage"> {
  const parsed = responseSchema.safeParse(value);
  if (!parsed.success || !sameKeys(parsed.data.answers, Object.keys(questions))) {
    throw new LlmCallError("unknown", "TypeSafe returned an invalid evaluation response");
  }
  const answers: Record<string, EvaluationAnswer> = {};
  for (const [key, question] of Object.entries(questions)) {
    const answer = parsed.data.answers[key]!;
    const typeError = () =>
      new LlmCallError("unknown", "TypeSafe returned a mismatched answer type");
    if (question.type === "noul") {
      if (answer.type !== "noul") throw typeError();
      answers[key] = answer;
      continue;
    }
    if (question.type === "choice") {
      if (answer.type !== "choice") throw typeError();
      const probabilities = normalizedProbabilities(
        answer.probabilities,
        Object.keys(question.criteria),
        true,
      );
      if (
        !Object.hasOwn(question.criteria, answer.choice) ||
        probabilities[answer.choice] !== Math.max(...Object.values(probabilities))
      ) {
        throw new LlmCallError("unknown", "TypeSafe choice disagrees with its probabilities");
      }
      answers[key] = { ...answer, probabilities };
      continue;
    }
    if (answer.type !== "score") throw typeError();
    const levels = question.criteria.map((_, index) => String(index));
    if (
      !sameKeys(answer.probabilities, levels) ||
      !sameKeys(answer.legend, levels) ||
      levels.some((level, index) => answer.legend[level] !== question.criteria[index])
    ) {
      throw new LlmCallError("unknown", "TypeSafe returned mismatched score criteria");
    }
    const probabilities = normalizedProbabilities(answer.probabilities, levels, true);
    const score = scoreExpectation(probabilities);
    const rounded =
      hasWirePrecision(answer.score) && Object.values(answer.probabilities).every(hasWirePrecision);
    const [minimum, maximum] = rounded ? roundedScoreBounds(answer.probabilities) : [score, score];
    const scoreTolerance = rounded
      ? WIRE_ROUNDING_RADIUS
      : PROBABILITY_TOLERANCE * question.criteria.length;
    if (
      answer.score < 0 ||
      answer.score > question.criteria.length - 1 ||
      answer.score + scoreTolerance < minimum - PROBABILITY_TOLERANCE ||
      answer.score - scoreTolerance > maximum + PROBABILITY_TOLERANCE
    ) {
      throw new LlmCallError("unknown", "TypeSafe score disagrees with its probabilities");
    }
    answers[key] = { type: "score", score, probabilities, confidence: answer.confidence };
  }
  return { model: parsed.data.model, answers };
}

export interface TypesafeEvaluationAccounting {
  attempts: number;
  /** False when any attempted request has no valid provider token report. */
  usageComplete: boolean;
}

/** Only provider-reported tokens are counted, including discarded retry responses. */
export class TypesafeEvaluationError extends LlmCallError implements TypesafeEvaluationAccounting {
  constructor(
    error: LlmCallError,
    readonly usage: TurnUsage,
    readonly attempts: number,
    readonly usageComplete: boolean,
  ) {
    super(error.kind, error.message);
  }
}

function retryDelay(header: string | null, retry: number): number {
  if (header !== null) {
    const seconds = Number(header);
    if (header.trim() !== "" && Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** retry);
}

function waitForRetry(delay: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delay);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

export class TypesafeGameEvaluator implements GameEvaluator {
  private readonly apiKey: string | undefined;
  private readonly fetch: typeof globalThis.fetch;

  constructor(
    private readonly config: EvaluatorConfig,
    options: { apiKey?: string; fetch?: typeof globalThis.fetch } = {},
  ) {
    this.apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async evaluate(
    request: EvaluationRequest,
  ): Promise<EvaluationResult & TypesafeEvaluationAccounting> {
    const usage: TurnUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    let attempts = 0;
    let reportedAttempts = 0;
    const fail = (error: LlmCallError) =>
      new TypesafeEvaluationError(error, { ...usage }, attempts, reportedAttempts === attempts);
    const parsed = requestSchema.safeParse(request);
    if (!parsed.success)
      throw fail(new LlmCallError("invalid_request", "Invalid TypeSafe evaluation request"));
    if (!this.apiKey?.trim()) throw fail(new LlmCallError("auth", "TYPESAFE_API_KEY is required"));

    const controller = new AbortController();
    const deadline = Date.now() + this.config.timeoutMs;
    const timeoutError = new LlmCallError(
      "timeout",
      "TypeSafe evaluation exceeded its total timeout",
    );
    const cancelError = new LlmCallError("unknown", "TypeSafe evaluation was cancelled");
    const onCancel = () => controller.abort(cancelError);
    request.signal?.addEventListener("abort", onCancel, { once: true });
    if (request.signal?.aborted) onCancel();
    const timer = setTimeout(() => controller.abort(timeoutError), this.config.timeoutMs);
    const signal = controller.signal;
    let removeAbortListener: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      const onAbort = () =>
        reject(fail(signal.reason instanceof LlmCallError ? signal.reason : cancelError));
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      if (signal.aborted) onAbort();
    });

    const run = async (): Promise<EvaluationResult & TypesafeEvaluationAccounting> => {
      let transportRetries = 0;
      let outputRetried = false;
      for (;;) {
        if (signal.aborted) throw signal.reason;
        if (Date.now() >= deadline) throw timeoutError;
        attempts++;
        let failure = new LlmCallError("unknown", "TypeSafe evaluation request failed");
        let retryable = true;
        let invalidOutput = false;
        let delay = retryDelay(null, transportRetries);
        try {
          const response = await this.fetch(ENDPOINT, {
            method: "POST",
            headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              state: parsed.data.state,
              questions: parsed.data.questions,
              model: this.config.model,
            }),
            signal,
          });
          if (signal.aborted) throw signal.reason;
          const body: unknown = await response.json().catch(() => null);
          if (signal.aborted) throw signal.reason;
          const reported = z.object({ usage: usageSchema }).safeParse(body);
          if (reported.success) {
            usage.inputTokens += reported.data.usage.input_tokens;
            usage.outputTokens += reported.data.usage.output_tokens;
            reportedAttempts++;
          }
          if (response.ok) {
            invalidOutput = true;
            const result = parseAnswers(body, parsed.data.questions);
            return { ...result, usage, attempts, usageComplete: reportedAttempts === attempts };
          }
          failure = new LlmCallError(
            response.status === 422 ? "invalid_request" : kindOfStatus(response.status),
            `TypeSafe HTTP ${response.status}`,
          );
          retryable = isRetryableStatus(response.status);
          delay = retryDelay(response.headers.get("Retry-After"), transportRetries);
        } catch (error) {
          if (signal.aborted) throw signal.reason;
          if (error instanceof LlmCallError) failure = error;
        }
        if (invalidOutput) {
          if (outputRetried) throw failure;
          outputRetried = true;
          continue;
        }
        if (!retryable || transportRetries >= this.config.maxRetries) throw failure;
        transportRetries++;
        await waitForRetry(Math.min(delay, Math.max(0, deadline - Date.now())), signal);
      }
    };
    try {
      return await Promise.race([run(), aborted]);
    } catch (error) {
      if (error instanceof TypesafeEvaluationError) throw error;
      throw fail(
        error instanceof LlmCallError
          ? error
          : new LlmCallError("unknown", "TypeSafe evaluation failed"),
      );
    } finally {
      clearTimeout(timer);
      removeAbortListener?.();
      request.signal?.removeEventListener("abort", onCancel);
    }
  }
}
