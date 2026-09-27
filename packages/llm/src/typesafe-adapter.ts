import { z } from "zod";
import type {
  EvaluationRequest,
  EvaluationResult,
  EvaluatorConfig,
  GameEvaluator,
  ScoreAnswer,
} from "./game-evaluator";
import type { TurnUsage } from "./game-llm";
import { isRetryableStatus, kindOfStatus, LlmCallError } from "./llm-error";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const PROBABILITY_TOLERANCE = 1e-6;
const RETRY_BASE_MS = 250;
const RETRY_MAX_MS = 5_000;
const probabilitySchema = z.number().finite().min(0).max(1);
const usageSchema = z.object({
  input_tokens: z.number().int().nonnegative().safe(),
  output_tokens: z.number().int().nonnegative().safe(),
});
const questionSchema = z
  .object({
    type: z.literal("score"),
    instructions: z.string().min(1),
    criteria: z.array(z.string().min(1)).min(2).max(10),
  })
  .strict();
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
    z.object({
      type: z.literal("score"),
      score: z.number().finite(),
      legend: z.record(z.string()),
      probabilities: z.record(probabilitySchema),
      confidence: probabilitySchema,
    }),
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
): Record<string, number> {
  const parsed = z.record(probabilitySchema).safeParse(probabilities);
  const size = Object.keys(probabilities).length;
  const levels = Array.from({ length: size }, (_, index) => String(index));
  if (!parsed.success || size < 2 || size > 10 || !sameKeys(probabilities, levels)) {
    throw new LlmCallError("unknown", "TypeSafe returned invalid score levels");
  }
  const total = Object.values(parsed.data).reduce((sum, probability) => sum + probability, 0);
  if (Math.abs(total - 1) > PROBABILITY_TOLERANCE) {
    throw new LlmCallError("unknown", "TypeSafe probabilities do not sum to one");
  }
  return Object.fromEntries(
    Object.entries(parsed.data).map(([key, probability]) => [key, probability / total]),
  );
}

/** Ordered Score levels start at zero; tiny wire rounding drift is normalized. */
export function scoreExpectation(probabilities: Readonly<Record<string, number>>): number {
  return Object.entries(normalizedProbabilities(probabilities)).reduce(
    (sum, [level, probability]) => sum + Number(level) * probability,
    0,
  );
}

function parseAnswers(
  value: unknown,
  questions: EvaluationRequest["questions"],
): Omit<EvaluationResult, "usage"> {
  const parsed = responseSchema.safeParse(value);
  if (!parsed.success || !sameKeys(parsed.data.answers, Object.keys(questions))) {
    throw new LlmCallError("unknown", "TypeSafe returned an invalid evaluation response");
  }
  const answers: Record<string, ScoreAnswer> = {};
  for (const [key, question] of Object.entries(questions)) {
    const answer = parsed.data.answers[key]!;
    const levels = question.criteria.map((_, index) => String(index));
    if (
      !sameKeys(answer.probabilities, levels) ||
      !sameKeys(answer.legend, levels) ||
      levels.some((level, index) => answer.legend[level] !== question.criteria[index])
    ) {
      throw new LlmCallError("unknown", "TypeSafe returned mismatched score criteria");
    }
    const probabilities = normalizedProbabilities(answer.probabilities);
    const score = scoreExpectation(probabilities);
    if (
      answer.score < 0 ||
      answer.score > question.criteria.length - 1 ||
      Math.abs(answer.score - score) > PROBABILITY_TOLERANCE * question.criteria.length
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
