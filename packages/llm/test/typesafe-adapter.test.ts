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
const request: EvaluationRequest = {
  state: "기록된 경기 상황",
  questions: {
    intensity: {
      type: "score",
      instructions: "압박 강도",
      criteria: ["없음", "약함", "보통", "강함"],
    },
  },
};
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
    expect(JSON.parse(String(init?.body))).toEqual({
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

  it.each([1, 11])("rejects %i rubric levels before HTTP", async (count) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const invalid = {
      ...request,
      questions: {
        intensity: {
          ...request.questions.intensity!,
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
