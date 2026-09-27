import { describe, expect, it, vi } from "vitest";
import {
  HISTORY_DIGEST_CHARS,
  HISTORY_OPEN_CHARS,
  MOOD_BATCH,
  MOOD_NOTE_MAX,
  RATING_MAX,
  TACTIC_GAIN_MAX,
  TACTIC_GAIN_MIN,
} from "@story-fm/engine";
import { CharacterMemorySchema } from "@story-fm/domain";
import type {
  EvaluationResult,
  GameEvaluator,
  GameLLM,
  JsonObjectSchema,
  TurnResult,
} from "@story-fm/llm";
import { LlmCallError, LlmTimeoutError, TokenBudgetExceededError } from "@story-fm/llm";
import { z } from "zod";
import { retryOnce, anchorStands, ModelOutputError, readOutput } from "../../src/common/retry";
import { agreement, costUsd, durationStats } from "../../harness/match-reader-eval-metrics";
import { runReaderPipeline } from "../../src/match/reader-pipeline";
import { matchReaderOutputSchema } from "../../src/match/match-reader";
import { SettleMatchSchema, SETTLE_MATCH_INPUT } from "../../src/match/finalize-match";
import { REPORT_TRAINING_INPUT, TrainingReportSchema } from "../../src/story/training-rater";
import { REPORT_DIGEST_INPUT } from "../../src/story/history-compactor";

const answered = (output: TurnResult["output"]): TurnResult => ({
  text: "",
  history: { version: 1, provider: "google", model: "test", messages: [] },
  historyBase: 0,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  toolCallCount: 0,
  stopReason: "completed",
  output,
});

/**
 * 실패 계약 — **쓸 수 없는 산출만 한 번 더 부르고, 그다음은 갈린다** (agents.md §8).
 * 장면(GM·중계·첫 장면)은 오류를 올리고, 결산 에이전트는 앵커를 남긴다.
 */
describe("retryOnce — 폴백 대신 한 번의 재시도", () => {
  it("성공하면 그대로 돌려주고 다시 부르지 않는다", async () => {
    const run = vi.fn().mockResolvedValue("장면");
    await expect(retryOnce("test", run)).resolves.toBe("장면");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("산출을 쓸 수 없으면 다시 부른다 — 다시 부르면 달라질 수 있다", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new ModelOutputError("첫 장면이 출력 문법을 어겼습니다"))
      .mockResolvedValue("두 번째 장면");
    await expect(retryOnce("test", run)).resolves.toBe("두 번째 장면");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("두 번째도 산출이 어긋나면 오류가 올라간다 — 대신 채우지 않는다", async () => {
    const run = vi.fn().mockRejectedValue(new ModelOutputError("출력 상한에 걸렸습니다"));
    await expect(retryOnce("test", run)).rejects.toThrow("출력 상한에 걸렸습니다");
    expect(run).toHaveBeenCalledTimes(2);
  });

  /**
   * 산출 이전에 끝난 실패는 다시 불러도 같은 답이다 — 시한은 같은 시한이 처음부터
   * 다시 걸려 잠금 안의 대기만 두 배가 되고(models.md §1-1), 예산 상한은 `recordSkip`이
   * 결산 한 번에 두 번 찍힌다(§4).
   */
  it.each([
    ["시한", new LlmTimeoutError("gm", 60_000)],
    [
      "예산 상한",
      new TokenBudgetExceededError("training-rater", { limit: 10, used: 20, over: true, ratio: 2 }),
    ],
    ["혼잡", new Error("529 overloaded")],
    ["연결", new Error("Connection error")],
  ])("%s 오류는 한 번만 부르고 그대로 올린다", async (_label, error) => {
    const run = vi.fn().mockRejectedValue(error);
    await expect(retryOnce("test", run)).rejects.toBe(error);
    expect(run).toHaveBeenCalledTimes(1);
  });

  /**
   * 자국이 남은 뒤의 재시도는 **이중 반영**이다 — 도구가 돌았으면 상태가 이미
   * 바뀌었고, 델타가 나갔으면 화면에 장면이 두 번 그려진다.
   */
  it("도구가 돌았거나 글자가 나간 뒤에는 다시 부르지 않는다", async () => {
    const run = vi.fn().mockRejectedValue(new ModelOutputError("중간에 끊김"));
    await expect(retryOnce("test", run, () => true)).rejects.toThrow("중간에 끊김");
    expect(run).toHaveBeenCalledTimes(1);
  });
});

/**
 * 산출을 읽는 문 — **없거나 스키마를 못 지나면 `ModelOutputError`다** (agents.md §8).
 * 그 예외 하나가 `retryOnce`의 한 번을 여는 열쇠라, 여기서 새지 않아야 재시도가 선다.
 */
describe("readOutput — 산출이 왔는가", () => {
  const schema = z.object({ n: z.number().int().min(0) });

  it("스키마를 지난 산출은 그대로 돌려준다", () => {
    expect(readOutput("t", schema, answered({ n: 3 }))).toEqual({ n: 3 });
  });

  it.each([
    ["산출이 없다 (null)", null],
    ["스키마를 싣지 않은 호출 (undefined)", undefined],
  ])("%s — ModelOutputError", (_label, output) => {
    expect(() => readOutput("t", schema, answered(output))).toThrow(ModelOutputError);
  });

  it("스키마를 못 지난 산출도 ModelOutputError이고, 어디가 틀렸는지 적는다", () => {
    expect(() => readOutput("t", schema, answered({ n: -1 }))).toThrow(/n: /);
  });
});

/** 결산에는 폴백이 있다 — 결산 하나 때문에 경기·시간 진행이 막히면 안 된다 */
describe("anchorStands — 결산 실패는 삼키고 앵커를 남긴다", () => {
  it("실패해도 호출부는 계속 간다 (조용히는 아니다 — 로그를 남긴다)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const run = vi.fn().mockRejectedValue(new Error("결산 실패"));

    await expect(
      retryOnce("rater:test", run).catch(anchorStands("rater:test")),
    ).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

/**
 * 결산 산출이 받아들이는 폭 — **넘친 값 하나가 결산 전체를 버리지 않는다** (agents.md §4).
 *
 * 스키마는 코어 밴드보다 넓게 열어 두고, 밴드 밖의 값은 파싱을 깨뜨리는 대신 코어가
 * 자른다. 그러나 그 **폭 밖**은 코어에 닿기 전에 반려된다 — 여기가 조여지면 한 선수의
 * 과한 숫자 하나로 경기 판정 전체가 앵커로 떨어지고, 반대로 풀리면 검증되지 않은 값이
 * 코어의 문 앞까지 온다. 재는 것은 그 산출의 Zod 한 벌이다 — 모델이 보는 JSON 스키마가
 * 거기서 파생되므로(prompts.md §2) 한 벌을 재면 둘을 잰다.
 */
describe("결산 스키마의 수용 폭", () => {
  /** 반려된 자리들 — 지났으면 빈 문자열이다 */
  function rejects(schema: z.ZodTypeAny, input: unknown): string {
    const parsed = schema.safeParse(input);
    return parsed.success ? "" : parsed.error.issues.map((i) => i.path.join(".")).join(" / ");
  }

  /** 도구 스키마의 한 자리 — `properties`가 unknown이라 여기서 한 번만 좁힌다 */
  function schemaAt(schema: JsonObjectSchema, path: string): Record<string, unknown> {
    let node: Record<string, unknown> = schema;
    for (const step of path.split(".")) {
      const next =
        step === "[]"
          ? node.items
          : (node.properties as Record<string, unknown> | undefined)?.[step];
      if (next === null || typeof next !== "object") throw new Error(`스키마에 ${path}가 없다`);
      node = next as Record<string, unknown>;
    }
    return node;
  }

  const settle = (input: unknown) => rejects(SettleMatchSchema, input);

  it("평점은 코어 밴드보다 넓게 받고, 그 폭 밖은 코어에 닿기 전에 반려한다", async () => {
    const rating = schemaAt(SETTLE_MATCH_INPUT, "ratings.[].rating");
    // 모델이 보는 폭이 코어 밴드보다 양쪽으로 넓다 (코어는 앵커 ±RATING_BAND로 다시 자른다)
    expect(rating.maximum).toBeGreaterThan(RATING_MAX);
    expect(rating.minimum).toBe(0);

    expect(settle({ ratings: [{ playerId: "p1", rating: Number(rating.maximum) + 1 }] })).toContain(
      "rating",
    );
    // 빈 제출도, 한 경기 명단을 넘는 제출도 여기서 걸린다
    expect(settle({ ratings: [] })).not.toBe("");
    const flood = Array.from({ length: 31 }, (_, i) => ({ playerId: `p${i}`, rating: 7 }));
    expect(settle({ ratings: flood })).not.toBe("");
    // 마무리 중계는 비워도 된다 — GM이 대신 닫는다 (agents.md §3)
    expect(settle({ ratings: [{ playerId: "p1", rating: 7 }] })).toBe("");
  });

  it("심경 한 줄은 세이브의 상한에서 끊기고, 한 번에 세는 인원도 물려 있다", async () => {
    // 길이는 세이브의 계약이 정한다 — 여기 다시 적으면 그 자리가 갈린다
    expect(schemaAt(SETTLE_MATCH_INPUT, "moods.[].text").maxLength).toBe(MOOD_NOTE_MAX);

    const ratings = [{ playerId: "p1", rating: 7 }];
    const note = (chars: number) => ({
      playerId: "p1",
      text: "말".repeat(chars),
      acknowledgesIssue: false,
    });
    expect(settle({ ratings, moods: [note(MOOD_NOTE_MAX + 1)] })).toContain("text");
    const flood = Array.from({ length: MOOD_BATCH + 1 }, () => note(10));
    expect(settle({ ratings, moods: flood })).not.toBe("");
  });

  it("훈련 결산의 폭도 코어 밴드보다 넓다 — 날짜는 형식이 여기서 걸린다", () => {
    const gain = schemaAt(REPORT_TRAINING_INPUT, "results.[].tacticGain");
    expect(gain.maximum).toBeGreaterThan(TACTIC_GAIN_MAX);
    expect(gain.minimum).toBeLessThan(TACTIC_GAIN_MIN);

    const report = (input: unknown) => rejects(TrainingReportSchema, input);
    expect(
      report({ results: [{ playerId: "p1", tacticGain: Number(gain.maximum) + 1 }] }),
    ).toContain("tacticGain");
    // 어느 훈련에서 나온 변화인지는 날짜로 가리킨다 — 형식이 어긋난 값은 코어까지 가지 않는다
    expect(report({ results: [{ playerId: "p1", date: "2026/01/02" }] })).toContain("date");
  });

  /**
   * ⚠️ 이력 압축의 상한은 **코어·세이브의 상수 그대로**여야 한다. 손으로 다시 적으면
   * 코어만 조여지고 모델은 옛 상한을 계속 믿는다 (agents.md §4).
   */
  it("압축 산출의 상한은 코어 상수를 그대로 쓰고, 카드의 자유 문구는 전부 물려 있다", () => {
    expect(schemaAt(REPORT_DIGEST_INPUT, "past").maxLength).toBe(HISTORY_DIGEST_CHARS);
    expect(schemaAt(REPORT_DIGEST_INPUT, "open").maxLength).toBe(HISTORY_OPEN_CHARS);
    expect(schemaAt(REPORT_DIGEST_INPUT, "memories.[].text").maxLength).toBe(
      CharacterMemorySchema.shape.text.maxLength,
    );
    // 카드는 불린 턴마다 레퍼런스 층에 통째로 실린다 — 한 문장이 문단이 되면 그 층을 밀어낸다
    const free = [
      "characters.[].archetype",
      "characters.[].motivation",
      "characters.[].traits.[]",
      "characters.[].speechStyle.note",
      "characters.[].speechStyle.samples.[]",
    ];
    for (const path of free) {
      expect(schemaAt(REPORT_DIGEST_INPUT, path).maxLength, path).toBeGreaterThan(0);
    }
  });
});

describe("reader pipeline — atomic probabilistic pilot", () => {
  const schema = matchReaderOutputSchema();
  const point = { id: "p", text: "왼쪽 공격이 이어진다", about: ["home"], importance: 2 };
  const candidate = {
    pointId: "p",
    target: { side: "home", lane: "left" },
    shape: "focus",
    sign: 1,
  };
  const evaluation = {
    model: "fixture",
    answers: {
      line_0: {
        type: "score" as const,
        score: 1.25,
        probabilities: { "0": 0, "1": 0.75, "2": 0.25, "3": 0 },
        confidence: 0.3,
      },
    },
    usage: { inputTokens: 12, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  };

  it("keeps fractional strength without multiplying confidence and removes scalar generation", async () => {
    const llm = {
      runTurn: vi.fn<GameLLM["runTurn"]>(async () =>
        answered({ points: [point], sheet: [candidate] }),
      ),
    };
    const evaluator = { evaluate: vi.fn(async () => evaluation) };
    const result = await runReaderPipeline({
      llm,
      evaluator,
      user: "recorded input",
      schema,
      hasSaid: false,
    });
    expect(result.reading.sheet[0]?.step).toBe(1.25);
    expect(result.evaluations).toEqual([evaluation]);
    expect(llm.runTurn).toHaveBeenCalledTimes(1);
    expect(evaluator.evaluate).toHaveBeenCalledTimes(1);
    const request = llm.runTurn.mock.calls[0]![0];
    expect(JSON.stringify(request.outputSchema)).not.toContain('"step"');
    expect(request.outputSchema?.properties).not.toHaveProperty("ops");
  });

  it("no manager utterance means no command, even if the model invents one", async () => {
    const llm: GameLLM = {
      runTurn: async () =>
        answered({
          points: [],
          sheet: [],
          ops: { substitute: [{ out: "a", in: "b" }] },
          unresolved: "invented",
        }),
    };
    const evaluator = { evaluate: vi.fn(async () => evaluation) };
    const result = await runReaderPipeline({
      llm,
      evaluator,
      user: "facts",
      schema,
      hasSaid: false,
    });
    expect(result.reading).toEqual({ points: [], sheet: [], ops: {} });
    expect(evaluator.evaluate).not.toHaveBeenCalled();
  });

  it("retry invalid point references before evaluating; never return partially translated commands", async () => {
    const llm = {
      runTurn: vi.fn(async () =>
        answered({ points: [], sheet: [candidate], ops: { substitute: [{ out: "a", in: "b" }] } }),
      ),
    };
    const evaluator = { evaluate: vi.fn(async () => evaluation) };
    await expect(
      runReaderPipeline({ llm, evaluator, user: "facts", schema, hasSaid: true }),
    ).rejects.toThrow(ModelOutputError);
    expect(llm.runTurn).toHaveBeenCalledTimes(2);
    expect(evaluator.evaluate).not.toHaveBeenCalled();
  });

  it.each(["missing", "out-of-range", "transport"])(
    "%s evaluation fails without repeating prose",
    async (failure) => {
      const llm = {
        runTurn: vi.fn<GameLLM["runTurn"]>(async () =>
          answered({ points: [point], sheet: [candidate] }),
        ),
      };
      const evaluator: GameEvaluator = {
        evaluate: async (): Promise<EvaluationResult> => {
          if (failure === "transport") throw new LlmCallError("auth", "missing key");
          return failure === "missing"
            ? { ...evaluation, answers: {} }
            : {
                ...evaluation,
                answers: { line_0: { ...evaluation.answers.line_0, score: 3.1 } },
              };
        },
      };
      await expect(
        runReaderPipeline({ llm, evaluator, user: "facts", schema, hasSaid: false }),
      ).rejects.toThrow();
      expect(llm.runTurn).toHaveBeenCalledTimes(1);
    },
  );
});

describe("reader comparison metrics", () => {
  it("empty measurements are unknown and percentiles use nearest rank", () => {
    expect(durationStats([])).toEqual({ n: 0, p50Ms: null, p95Ms: null });
    expect(durationStats([40, 10, 30, 20])).toEqual({ n: 4, p50Ms: 20, p95Ms: 40 });
  });

  it("missing prices and unsupported cache-write charges never look free", () => {
    const usage = {
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 200,
      cacheWriteTokens: 0,
    };
    expect(costUsd(usage, { input: 1, output: 2 })).toBeNull();
    expect(costUsd(usage, { input: 1, output: 2, cachedInput: 0.1 })).toBeCloseTo(0.00102);
    expect(
      costUsd({ ...usage, cacheWriteTokens: 1 }, { input: 1, output: 2, cachedInput: 0.1 }),
    ).toBeNull();
  });

  it("pairs duplicate rows once and separates lexical agreement from step error", () => {
    const row = {
      pointId: "p",
      target: { side: "home" as const, lane: "left" as const },
      shape: "focus" as const,
      sign: 1 as const,
      step: 1,
    };
    const baseline = {
      points: [{ id: "p", text: "same fact", about: [], importance: 1 as const }],
      sheet: [row, row],
      ops: { set_tactics: [{ pressing: 3, tempo: 2 }] },
    };
    const candidate = {
      ...baseline,
      sheet: [{ ...row, step: 1.5 }],
      ops: { set_tactics: [{ tempo: 2, pressing: 3 }] },
    };
    expect(agreement(baseline, candidate)).toMatchObject({
      matchedRows: 1,
      unmatchedBaselineRows: 1,
      structuralJaccard: 0.5,
      stepMeanAbsoluteError: 0.5,
      opsExact: true,
    });
    expect(
      agreement(baseline, {
        ...candidate,
        points: [{ ...baseline.points[0]!, text: "different wording" }],
      }),
    ).toMatchObject({ matchedRows: 0, stepMeanAbsoluteError: null });
  });
});
