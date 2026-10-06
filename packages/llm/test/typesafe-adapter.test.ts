import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvaluationRequest, EvaluatorConfig } from "../src/game-evaluator";
import {
  scoreExpectation,
  TypesafeEvaluationError,
  TypesafeGameEvaluator,
} from "../src/typesafe-adapter";

const config: EvaluatorConfig = {
  provider: "typesafe",
  model: "test-model",
  timeoutMs: 10_000,
  maxRetries: 2,
  inputUsdPerMillion: 0.042,
};
const request = {
  state: "기록된 경기 상황",
  questions: {
    intensity: {
      type: "score",
      instructions: "압박 강도",
      criteria: ["없음", "약함", "보통", "강함"],
    },
  },
} satisfies EvaluationRequest;
function answer() {
  return {
    type: "score",
    score: 2.5,
    legend: { "0": "없음", "1": "약함", "2": "보통", "3": "강함" },
    probabilities: { "0": 0, "1": 0, "2": 0.5, "3": 0.5 },
    confidence: 0.5,
  };
}
function response(answers: unknown = { intensity: answer() }) {
  return {
    model: "resolved-model-version",
    answers,
    usage: { input_tokens: 80, output_tokens: 12 },
  };
}
function evaluator(fetch: typeof globalThis.fetch, overrides: Partial<EvaluatorConfig> = {}) {
  return new TypesafeGameEvaluator({ ...config, ...overrides }, { apiKey: "test-secret", fetch });
}
afterEach(() => vi.useRealTimers());

describe("TypeSafe score validation", () => {
  it("uses probability expectation instead of the winning level and normalizes only rounding drift", () => {
    expect(scoreExpectation({ "0": 0, "1": 0, "2": 0.5, "3": 0.5 })).toBe(2.5);
    expect(scoreExpectation({ "0": 0.5, "1": 0.5000001 })).toBeCloseTo(0.5, 6);
    expect(scoreExpectation({ "0": 1, "1": 0 })).toBe(0);
    expect(scoreExpectation({ "0": 0, "1": 1 })).toBe(1);
  });

  it.each([
    {},
    { "0": 1 },
    { "0": 0.2, "1": 0.2 },
    { "0": -0.1, "1": 1.1 },
    { "0": NaN, "1": 1 },
    { "0": Infinity, "1": 0 },
    { "1": 0.5, "2": 0.5 },
    { "0": 0.5, "01": 0.5 },
    { "0": 0.5, "1": 0.5, extra: 0 },
  ])("rejects invalid probability distribution %#", (probabilities) => {
    expect(() => scoreExpectation(probabilities as Record<string, number>)).toThrow();
  });
});

describe("TypesafeGameEvaluator", () => {
  const choiceQuestion = {
    type: "choice" as const,
    instructions: "실행할 지시인가?",
    criteria: { execute: "직접 지시", clarify: null },
  };
  const choiceAnswer = {
    type: "choice" as const,
    choice: "execute",
    probabilities: { execute: 0.8, clarify: 0.2 },
    confidence: 0.6,
  };

  it("validates mixed Score, Choice and Noul answers without converting classifications to scores", async () => {
    const questions = {
      ...request.questions,
      intent: choiceQuestion,
      confirmed: {
        type: "noul" as const,
        instructions: "명시적 지시인가?",
        criteria: { true: "지시", false: "질문" },
      },
    };
    const answers = {
      intensity: answer(),
      intent: choiceAnswer,
      confirmed: { type: "noul", noul: 0.7 },
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json(response(answers)));
    const result = await evaluator(fetch).evaluate({ state: request.state, questions });
    expect(result.answers).toEqual({
      intensity: {
        type: "score",
        score: 2.5,
        probabilities: answer().probabilities,
        confidence: 0.5,
      },
      intent: choiceAnswer,
      confirmed: { type: "noul", noul: 0.7 },
    });
    const sent = JSON.parse(fetch.mock.calls[0]?.[1]?.body as string) as { questions: unknown };
    expect(sent.questions).toEqual(questions);
  });

  it.each([1, 255])("accepts a nonempty Choice with %i options", async (count) => {
    const criteria = Object.fromEntries(
      Array.from({ length: count }, (_, i) => [`option_${i}`, null]),
    );
    const probabilities = Object.fromEntries(
      Object.keys(criteria).map((key, i) => [key, i === 0 ? 1 : 0]),
    );
    const resultAnswer = { type: "choice", choice: "option_0", probabilities, confidence: 1 };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json(response({ intent: resultAnswer })));
    const result = await evaluator(fetch).evaluate({
      state: "state",
      questions: { intent: { ...choiceQuestion, criteria } },
    });
    expect(result.answers.intent).toEqual(resultAnswer);
  });

  it.each([0, 256])("rejects %i Choice options before HTTP", async (count) => {
    const criteria = Object.fromEntries(
      Array.from({ length: count }, (_, i) => [`option_${i}`, null]),
    );
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      evaluator(fetch).evaluate({
        state: "state",
        questions: { intent: { ...choiceQuestion, criteria } },
      }),
    ).rejects.toMatchObject({ kind: "invalid_request", attempts: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("allows tied highest-probability choices and normalizes only tiny probability drift", async () => {
    const tied = {
      ...choiceAnswer,
      choice: "clarify",
      probabilities: { execute: 0.5000001, clarify: 0.5000001 },
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json(response({ intent: tied })));
    const result = await evaluator(fetch).evaluate({
      state: "state",
      questions: { intent: choiceQuestion },
    });
    expect(result.answers.intent).toEqual({
      ...tied,
      probabilities: { execute: 0.5, clarify: 0.5 },
    });
  });

  it("normalizes the observed independently rounded Choice vector only when unit mass remains possible", async () => {
    const probabilities = { unclear: 0.01, v4: 0, v0: 0, absent: 0.8, v1: 0.17, v2: 0, v3: 0.01 };
    const criteria = Object.fromEntries(Object.keys(probabilities).map((key) => [key, null]));
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json(
        response({
          intent: {
            type: "choice",
            choice: "absent",
            probabilities,
            confidence: 0.8,
          },
        }),
      ),
    );
    const result = await evaluator(fetch).evaluate({
      state: "state",
      questions: { intent: { ...choiceQuestion, criteria } },
    });
    const got = result.answers.intent;
    if (got?.type !== "choice") throw new Error("Expected Choice answer");
    expect(got.choice).toBe("absent");
    expect(got.probabilities.absent).toBeCloseTo(0.8 / 0.99);
    expect(Object.values(got.probabilities).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1);
    expect(result.attempts).toBe(1);
  });

  it.each([
    { a: 0.32, b: 0.32, c: 0.32 },
    { a: 0.35, b: 0.35, c: 0.35 },
    { a: 0.3331, b: 0.3331, c: 0.3331 },
    { a: 0, b: 0, c: 0 },
  ])("rejects sums with no supported rounding explanation %#", async (probabilities) => {
    const criteria = Object.fromEntries(Object.keys(probabilities).map((key) => [key, null]));
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () =>
      Response.json(
        response({
          intent: {
            type: "choice",
            choice: "a",
            probabilities,
            confidence: 0,
          },
        }),
      ),
    );
    await expect(
      evaluator(fetch).evaluate({
        state: "state",
        questions: { intent: { ...choiceQuestion, criteria } },
      }),
    ).rejects.toMatchObject({
      kind: "unknown",
      attempts: 2,
      usage: { inputTokens: 160, outputTokens: 24 },
      usageComplete: true,
    });
  });

  it("keeps standalone expectations strict even when the wire adapter can explain decimal rounding", () => {
    expect(() => scoreExpectation({ "0": 0.33, "1": 0.33, "2": 0.33 })).toThrow();
  });

  it.each([
    { probabilities: { "0": 0.33, "1": 0.33, "2": 0.33, "3": 0 }, score: 1, expected: 1 },
    { probabilities: { "0": 0.34, "1": 0.34, "2": 0.33, "3": 0 }, score: 0.99, expected: 1 / 1.01 },
  ])(
    "normalizes rounded Score mass above and below one %#",
    async ({ probabilities, score, expected }) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(
          Response.json(response({ intensity: { ...answer(), probabilities, score } })),
        );
      const result = await evaluator(fetch).evaluate(request);
      const got = result.answers.intensity;
      if (got?.type !== "score") throw new Error("Expected Score answer");
      expect(got.score).toBeCloseTo(expected);
      expect(result.attempts).toBe(1);
    },
  );

  it.each([
    { ...choiceAnswer, choice: "clarify" },
    { ...choiceAnswer, choice: "unknown" },
    { ...choiceAnswer, probabilities: { execute: 1 } },
    { ...choiceAnswer, probabilities: { execute: 0.8, clarify: 0.2, extra: 0 } },
    { ...choiceAnswer, probabilities: { execute: 0.8, clarify: 0.1 } },
    { ...choiceAnswer, probabilities: { execute: 1.1, clarify: -0.1 } },
    { ...choiceAnswer, confidence: 1.1 },
    { type: "noul", noul: 0.7 },
  ])(
    "rejects invalid Choice output and type mismatches after one output retry %#",
    async (invalid) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementation(async () => Response.json(response({ intent: invalid })));
      await expect(
        evaluator(fetch).evaluate({ state: "state", questions: { intent: choiceQuestion } }),
      ).rejects.toMatchObject({ kind: "unknown", attempts: 2, usage: { inputTokens: 160 } });
    },
  );

  it.each([0, 1])("preserves Noul endpoint %i without inventing confidence", async (noul) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json(response({ intent: { type: "noul", noul } })));
    const result = await evaluator(fetch).evaluate({
      state: "state",
      questions: { intent: { type: "noul", instructions: "직접 지시인가?" } },
    });
    expect(result.answers.intent).toEqual({ type: "noul", noul });
  });

  it.each([-0.01, 1.01, NaN, Infinity])("rejects invalid Noul probability %s", async (noul) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => Response.json(response({ intent: { type: "noul", noul } })));
    await expect(
      evaluator(fetch).evaluate({
        state: "state",
        questions: { intent: { type: "noul", instructions: "직접 지시인가?" } },
      }),
    ).rejects.toMatchObject({ kind: "unknown", attempts: 2 });
  });

  it("rejects a Choice answer to a Noul question even when both could describe the same intent", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => Response.json(response({ intent: choiceAnswer })));
    await expect(
      evaluator(fetch).evaluate({
        state: "state",
        questions: { intent: { type: "noul", instructions: "직접 지시인가?" } },
      }),
    ).rejects.toMatchObject({ kind: "unknown", attempts: 2 });
  });

  it("sends only the typed request, preserves resolved model and usage, and accepts fractional scores", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(response()));
    const result = await evaluator(fetch).evaluate(request);
    expect(fetch.mock.calls[0]?.[0]).toBe("https://api.typesafe.ai/v1/systemone");
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      Authorization: "Bearer test-secret",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init?.body as string)).toEqual({
      state: request.state,
      questions: request.questions,
      model: config.model,
    });
    expect(result).toMatchObject({
      model: "resolved-model-version",
      answers: { intensity: { score: 2.5 } },
      usage: { inputTokens: 80, outputTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 0 },
      attempts: 1,
      usageComplete: true,
    });
  });

  it("accepts independently rounded live Score values but computes strength from the distribution", async () => {
    const rounded = {
      ...answer(),
      score: 1.94,
      probabilities: { "0": 0, "1": 0.05, "2": 0.95, "3": 0 },
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json(response({ intensity: rounded })));
    const result = await evaluator(fetch).evaluate(request);
    expect(result.answers.intensity).toMatchObject({
      type: "score",
      score: 1.95,
      probabilities: rounded.probabilities,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([1.9, 1.97])(
    "rejects Score %s when no latent distribution can explain its rounding",
    async (score) => {
      const rounded = {
        ...answer(),
        score,
        probabilities: { "0": 0, "1": 0.05, "2": 0.95, "3": 0 },
      };
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementation(async () => Response.json(response({ intensity: rounded })));
      await expect(evaluator(fetch).evaluate(request)).rejects.toMatchObject({
        kind: "unknown",
        attempts: 2,
      });
    },
  );

  it.each([1, 11])("rejects %i rubric levels before HTTP", async (count) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const invalid = {
      ...request,
      questions: {
        intensity: {
          ...request.questions.intensity,
          criteria: Array.from({ length: count }, () => "level"),
        },
      },
    };
    await expect(evaluator(fetch).evaluate(invalid)).rejects.toMatchObject({
      kind: "invalid_request",
      attempts: 0,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects empty questions and prose/tools before HTTP", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      evaluator(fetch).evaluate({ state: "state", questions: {} }),
    ).rejects.toMatchObject({ kind: "invalid_request" });
    await expect(
      evaluator(fetch).evaluate({ ...request, tools: [] } as EvaluationRequest),
    ).rejects.toMatchObject({ kind: "invalid_request" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { intensity: { ...answer(), probabilities: { "0": 0.5, "1": 0.5 } } },
    { intensity: { ...answer(), probabilities: { ...answer().probabilities, "4": 0 } } },
    { intensity: { ...answer(), score: 3 } },
    { intensity: { ...answer(), score: -1 } },
    { intensity: { ...answer(), confidence: 2 } },
    { intensity: { ...answer(), legend: { ...answer().legend, "3": "다른 눈금" } } },
    { other: answer() },
    { intensity: answer(), extra: answer() },
  ])("rejects repeated malformed output atomically after one retry %#", async (answers) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => Response.json(response(answers)));
    await expect(evaluator(fetch).evaluate(request)).rejects.toMatchObject({
      kind: "unknown",
      usage: { inputTokens: 160, outputTokens: 24 },
      attempts: 2,
      usageComplete: true,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("retries invalid output once independently of the transport budget and accounts both responses", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(response({ intensity: { ...answer(), score: 3 } })))
      .mockResolvedValueOnce(Response.json(response()));
    const result = await evaluator(fetch, { maxRetries: 0 }).evaluate(request);
    expect(result).toMatchObject({
      attempts: 2,
      usageComplete: true,
      answers: { intensity: { score: 2.5 } },
      usage: { inputTokens: 160, outputTokens: 24 },
    });
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(fetch.mock.calls[1]?.[1]?.body);
  });

  it("does not reset the transport retry allowance after invalid output", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({}, { status: 503 }))
      .mockResolvedValueOnce(Response.json(response({})))
      .mockResolvedValueOnce(Response.json({}, { status: 503 }));
    const failure = evaluator(fetch, { maxRetries: 1 })
      .evaluate(request)
      .catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(await failure).toMatchObject({
      kind: "overloaded",
      attempts: 3,
      usageComplete: false,
      usage: { inputTokens: 80, outputTokens: 12 },
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("shares the original deadline with the invalid-output retry", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve(Response.json(response({}))), 30);
          }),
      )
      .mockImplementationOnce(() => new Promise(() => {}));
    const failure = evaluator(fetch, { timeoutMs: 50 })
      .evaluate(request)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20);
    expect(await failure).toMatchObject({
      kind: "timeout",
      attempts: 2,
      usageComplete: false,
      usage: { inputTokens: 80, outputTokens: 12 },
    });
    expect(fetch.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
  });

  it("counts every reported retry and bounds retries", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({ usage: { input_tokens: 17, output_tokens: 2 } }, { status: 529 }),
      )
      .mockResolvedValueOnce(Response.json(response()));
    const pending = evaluator(fetch).evaluate(request);
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({
      attempts: 2,
      usageComplete: true,
      usage: { inputTokens: 97, outputTokens: 14 },
    });

    const failedFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => Response.json({ private: "test-secret" }, { status: 503 }));
    const failure = evaluator(failedFetch)
      .evaluate(request)
      .catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(await failure).toMatchObject({
      kind: "overloaded",
      attempts: 3,
      usageComplete: false,
      usage: { inputTokens: 0 },
    });
    expect(failedFetch).toHaveBeenCalledTimes(3);
    expect(String(await failure)).not.toContain("test-secret");
  });

  it.each([401, 422])(
    "does not retry permanent HTTP %i or expose response bodies",
    async (status) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(Response.json({ error: "test-secret" }, { status }));
      const error: unknown = await evaluator(fetch)
        .evaluate(request)
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(TypesafeEvaluationError);
      expect(error).toMatchObject({
        kind: status === 401 ? "auth" : "invalid_request",
        attempts: 1,
        usageComplete: false,
      });
      expect(String(error)).not.toContain("test-secret");
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("marks unreported network retries incomplete without inventing tokens", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new Error("test-secret network payload"))
      .mockResolvedValueOnce(Response.json(response()));
    const pending = evaluator(fetch).evaluate(request);
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({
      attempts: 2,
      usageComplete: false,
      usage: { inputTokens: 80, outputTokens: 12 },
    });
  });

  it("honors Retry-After within a single deadline", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({}, { status: 429, headers: { "Retry-After": "1" } }))
      .mockResolvedValueOnce(Response.json(response()));
    const pending = evaluator(fetch).evaluate(request);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ attempts: 2, usageComplete: false });

    const delayed = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({}, { status: 429, headers: { "Retry-After": "3600" } }));
    const failure = evaluator(delayed, { timeoutMs: 50 })
      .evaluate(request)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(50);
    expect(await failure).toMatchObject({ kind: "timeout", attempts: 1 });
    expect(delayed).toHaveBeenCalledTimes(1);
  });

  it("ends the request and aborts its signal even if fetch ignores cancellation", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() => new Promise(() => {}));
    const failure = evaluator(fetch, { timeoutMs: 50 })
      .evaluate(request)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(50);
    expect(await failure).toMatchObject({ kind: "timeout", usageComplete: false });
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);

    const controller = new AbortController();
    const cancelled = evaluator(fetch)
      .evaluate({ ...request, signal: controller.signal })
      .catch((error: unknown) => error);
    controller.abort(new Error("test-secret abort reason"));
    expect(await cancelled).toMatchObject({
      kind: "unknown",
      message: "TypeSafe evaluation was cancelled",
    });
    expect(fetch.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
  });

  it("does not call HTTP for pre-aborted requests or missing credentials", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const controller = new AbortController();
    controller.abort();
    await expect(
      evaluator(fetch).evaluate({ ...request, signal: controller.signal }),
    ).rejects.toMatchObject({ attempts: 0 });
    await expect(
      new TypesafeGameEvaluator(config, { apiKey: "", fetch }).evaluate(request),
    ).rejects.toMatchObject({ kind: "auth", attempts: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });
});
