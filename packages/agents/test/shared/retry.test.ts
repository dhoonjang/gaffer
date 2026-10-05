import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  HISTORY_DIGEST_CHARS,
  HISTORY_CHAR_LIMIT,
  HISTORY_STEP,
  HISTORY_OPEN_CHARS,
  RATING_BAND,
  MATCH_FAMILIARITY_MIN,
  MATCH_FAMILIARITY_MAX,
  buildRatingBrief,
  finalizeMatch,
  startMatch,
  matchRated,
  settleMatchRating,
  type MatchRatingBrief,
  TACTIC_GAIN_MAX,
  TACTIC_GAIN_MIN,
  POSITION_TRAIN_MAX,
  TRAINING_QUESTION_LIMIT,
  applyTrainingOutcomes,
  trainingSettled,
  userPlayers,
  type TrainingBrief,
  type GameState,
} from "@story-fm/engine";
import { CharacterCandidateSchema, CHARACTER_CANDIDATES_MAX } from "@story-fm/domain";
import type {
  EvaluationResult,
  EvaluationRequest,
  GameEvaluator,
  GameLLM,
  JsonObjectSchema,
  TurnResult,
} from "@story-fm/llm";
import { LlmCallError, LlmTimeoutError, TokenBudgetExceededError } from "@story-fm/llm";
import { z } from "zod";
import { retryOnce, anchorStands, ModelOutputError, readOutput } from "../../src/shared/retry";
import { agreement, costUsd, durationStats } from "../../harness/match-reader-eval-metrics";
import { runReaderPipeline } from "../../harness/reader-pipeline";
import { matchReaderOutputSchema } from "../../harness/reader-baseline";
import {
  buildSettlementRequest,
  evaluateSettlement,
  runFinalizeMatch,
} from "../../src/evaluators/finalize-match";
import {
  buildTrainingRequest,
  evaluateTraining,
  reportTraining,
} from "../../src/evaluators/training-rater";
import { createTestGame, createMiniGame, advanceToMatchday } from "../../../engine/test/helpers";
import { compactHistory, REPORT_DIGEST_INPUT } from "../../src/memory/history-compactor";

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

describe("이력 압축 스키마의 수용 폭", () => {
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

  /**
   * ⚠️ 이력 압축의 상한은 **코어·세이브의 상수 그대로**여야 한다. 손으로 다시 적으면
   * 코어만 조여지고 모델은 옛 상한을 계속 믿는다 (agents.md §4).
   */
  it("압축 산출과 인물 후보의 상한은 도메인 상수를 그대로 쓴다", () => {
    expect(schemaAt(REPORT_DIGEST_INPUT, "past").maxLength).toBe(HISTORY_DIGEST_CHARS);
    expect(schemaAt(REPORT_DIGEST_INPUT, "open").maxLength).toBe(HISTORY_OPEN_CHARS);
    expect(schemaAt(REPORT_DIGEST_INPUT, "candidates").maxItems).toBe(CHARACTER_CANDIDATES_MAX);
    expect(schemaAt(REPORT_DIGEST_INPUT, "candidates.[].description").maxLength).toBe(
      CharacterCandidateSchema.shape.description.maxLength,
    );
  });
});

describe("이력 요약 — 후보만 정규화하고 검증 전에는 원문을 보존한다", () => {
  const base = createMiniGame();

  function historyState(count = CHARACTER_CANDIDATES_MAX + 5): GameState {
    const state = structuredClone(base);
    state.players = [];
    state.personas = [];
    state.lorebook = Array.from({ length: count }, (_, i) => ({
      id: `person:summary-${i}`,
      kind: "person" as const,
      version: 2,
      name: `요약후보${i}`,
      keywords: [`별칭${i}`],
      description: `명부의 소개 ${i}`,
      information: `요약이 고쳐서는 안 되는 인물 정보 ${i}`,
    }));
    state.chat = Array.from({ length: HISTORY_STEP * 4 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("model" as const),
      text: `${i}번째 원문 ` + "대화".repeat(Math.ceil(HISTORY_CHAR_LIMIT / HISTORY_STEP)),
      toolCalls: [],
      at: state.date,
    }));
    state.historyDigest = {
      foldedTurns: HISTORY_STEP,
      text: "이전 결정",
      open: "아직 끝나지 않은 이야기",
      at: state.date,
      rounds: 1,
    };
    return state;
  }

  it.each([3, CHARACTER_CANDIDATES_MAX + 5])(
    "풀 %i명의 요약은 명부 설명만 최대 30명 남기고 로어북은 편집하지 않는다",
    async (count) => {
      const state = historyState(count);
      const before = structuredClone(state);
      const chosen = state.lorebook.at(-1)!;
      const runTurn = vi.fn<GameLLM["runTurn"]>().mockResolvedValue(
        answered({
          past: "  지난 결정과 이유  ",
          open: "  계속할 이야기  ",
          candidates: [
            {
              name: chosen.name,
              description: "모델이 다시 지은 소개",
              information: "주입할 상세 정보",
            },
            { name: chosen.name, description: "중복 소개" },
            { name: "명부에 없는 사람", description: "임의로 지은 인물" },
          ],
        }),
      );

      await expect(compactHistory(state, { runTurn })).resolves.toEqual({ folded: true });
      expect(runTurn).toHaveBeenCalledTimes(1);
      expect(state.historyDigest).toMatchObject({
        text: "지난 결정과 이유",
        open: "계속할 이야기",
        rounds: 2,
      });
      expect(state.historyDigest!.foldedTurns).toBeGreaterThan(before.historyDigest!.foldedTurns);
      const candidates = state.historyDigest!.candidates!;
      expect(candidates).toHaveLength(Math.min(count, CHARACTER_CANDIDATES_MAX));
      expect(new Set(candidates.map(({ name }) => name)).size).toBe(candidates.length);
      expect(candidates[0]).toEqual({ name: chosen.name, description: chosen.description });
      for (const candidate of candidates) {
        const canonical = before.lorebook.find(({ name }) => name === candidate.name)!;
        expect(candidate).toEqual({ name: canonical.name, description: canonical.description });
      }
      // 원문·로어북·편집 작업 원장은 요약 성공에도 그대로다.
      expect(state).toEqual({ ...before, historyDigest: state.historyDigest });
    },
  );

  it.each(["빈 요약", "후보 상한 초과", "재시도 실패"])(
    "%s이면 원문과 기존 folded marker를 보존한다",
    async (failure) => {
      const state = historyState();
      const before = structuredClone(state);
      const invalid = answered(
        failure === "후보 상한 초과"
          ? {
              past: "검증되지 않은 요약",
              candidates: state.lorebook.map(({ name, description }) => ({
                name,
                description,
              })),
            }
          : { past: " ", candidates: [] },
      );
      const runTurn = vi.fn<GameLLM["runTurn"]>().mockResolvedValue(invalid);
      if (failure === "재시도 실패") {
        runTurn
          .mockReset()
          .mockResolvedValueOnce(invalid)
          .mockRejectedValueOnce(new ModelOutputError("재시도도 산출 실패"));
      }
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        await expect(compactHistory(state, { runTurn })).resolves.toEqual({ folded: false });
        expect(runTurn).toHaveBeenCalledTimes(2);
        expect(state).toEqual(before);
        expect(warn).toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    },
  );
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
    });
    expect(result.reading.sheet[0]?.step).toBe(1.25);
    expect(result.evaluations).toEqual([evaluation]);
    expect(llm.runTurn).toHaveBeenCalledTimes(1);
    expect(evaluator.evaluate).toHaveBeenCalledTimes(1);
    const request = llm.runTurn.mock.calls[0]![0];
    expect(JSON.stringify(request.outputSchema)).not.toContain('"step"');
    expect(request.outputSchema?.properties).not.toHaveProperty("ops");
  });

  it("empty experimental sheet skips evaluator; obsolete command fields are discarded", async () => {
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
    });
    expect(result.reading).toEqual({ points: [], sheet: [] });
    expect(evaluator.evaluate).not.toHaveBeenCalled();
  });

  it("retry invalid point references before evaluating; never return a partial reading", async () => {
    const llm = {
      runTurn: vi.fn(async () =>
        answered({ points: [], sheet: [candidate], ops: { substitute: [{ out: "a", in: "b" }] } }),
      ),
    };
    const evaluator = { evaluate: vi.fn(async () => evaluation) };
    await expect(runReaderPipeline({ llm, evaluator, user: "facts", schema })).rejects.toThrow(
      ModelOutputError,
    );
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
      await expect(runReaderPipeline({ llm, evaluator, user: "facts", schema })).rejects.toThrow();
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
    };
    const candidate = {
      ...baseline,
      sheet: [{ ...row, step: 1.5 }],
    };
    expect(agreement(baseline, candidate)).toMatchObject({
      matchedRows: 1,
      unmatchedBaselineRows: 1,
      structuralJaccard: 0.5,
      stepMeanAbsoluteError: 0.5,
    });
    expect(
      agreement(baseline, {
        ...candidate,
        points: [{ ...baseline.points[0]!, text: "different wording" }],
      }),
    ).toMatchObject({ matchedRows: 0, stepMeanAbsoluteError: null });
  });
});

function trainingBrief(): TrainingBrief {
  const subject = {
    age: 22,
    position: "CM",
    familiarity: 5,
    condition: 90,
    form: 0,
    room: 10,
    overall: 70,
    apps: 0,
    rating: null,
  };
  return {
    teamName: "훈련팀",
    from: "2026-07-01",
    to: "2026-07-03",
    sessions: [
      {
        entryId: "training-1",
        date: "2026-07-02",
        slot: "am",
        label: "패스",
        focus: ["passing"],
        ordered: true,
      },
      {
        entryId: "training-2",
        date: "2026-07-03",
        slot: "am",
        label: "전술",
        focus: ["tactical"],
        ordered: false,
      },
    ],
    subjects: [
      { ...subject, playerId: "p1", name: "민수", program: { axis: "pace", position: "DM" } },
      { ...subject, playerId: "p2", name: "준호", program: null },
    ],
    trainedAxes: ["passing", "pace"],
    chat: [],
  };
}

function trainingAnswers(request: EvaluationRequest): EvaluationResult {
  return {
    model: "mock",
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    answers: Object.fromEntries(
      Object.entries(request.questions).map(([key, question]) => {
        if (question.type === "score") {
          const zero = question.criteria.indexOf("0");
          return [
            key,
            {
              type: "score",
              score: zero,
              confidence: 0.1,
              probabilities: Object.fromEntries(
                question.criteria.map((_, i) => [String(i), i === zero ? 1 : 0]),
              ),
            },
          ];
        }
        if (question.type !== "choice") throw new Error("unexpected noul");
        const choice = "none";
        return [
          key,
          {
            type: "choice",
            choice,
            confidence: 1,
            probabilities: Object.fromEntries(
              Object.keys(question.criteria).map((candidate) => [
                candidate,
                candidate === choice ? 1 : 0,
              ]),
            ),
          },
        ];
      }),
    ),
  };
}

function selectTraining(
  request: EvaluationRequest,
  result: EvaluationResult,
  key: string,
  choice: string,
) {
  const question = request.questions[key];
  if (question?.type !== "choice") throw new Error("expected choice");
  result.answers[key] = {
    type: "choice",
    choice,
    confidence: 1,
    probabilities: Object.fromEntries(
      Object.keys(question.criteria).map((candidate) => [candidate, candidate === choice ? 1 : 0]),
    ),
  };
}

describe("typed training evaluation", () => {
  it("batches every subject, restricts personal axes, preserves facts and maps continuous levels", async () => {
    const brief = trainingBrief();
    const evaluate = vi.fn<GameEvaluator["evaluate"]>(async (request) => {
      // 능력치 질문은 훈련 날짜마다 선다 — 두 날짜면 두 칸이다
      expect(request.questions.p0_d0?.criteria).toHaveProperty("pace_up");
      expect(request.questions.p0_d1?.criteria).toHaveProperty("pace_up");
      expect(request.questions).not.toHaveProperty("p0_d2");
      expect(request.questions.p1_d0?.criteria).not.toHaveProperty("pace_up");
      expect(request.questions.p1_d0?.criteria).toHaveProperty("passing_down");
      expect(request.questions).not.toHaveProperty("p1_position");
      expect(request.questions).not.toHaveProperty("p0_date");
      for (const [key, question] of Object.entries(request.questions))
        expect(question.instructions).toContain(key.startsWith("p0_") ? "p1" : "p2");
      const result = trainingAnswers(request);
      const tactic = request.questions.p0_tactic!;
      if (tactic.type !== "score") throw new Error("expected score");
      expect(tactic.criteria).toEqual(
        Array.from({ length: TACTIC_GAIN_MAX - TACTIC_GAIN_MIN + 1 }, (_, i) =>
          String(i + TACTIC_GAIN_MIN),
        ),
      );
      result.answers.p0_tactic = {
        type: "score",
        score: 1.5,
        confidence: 0.01,
        probabilities: { "0": 0, "1": 0.5, "2": 0.5, "3": 0, "4": 0 },
      };
      const position = request.questions.p0_position!;
      if (position.type !== "score") throw new Error("expected score");
      result.answers.p0_position = {
        type: "score",
        score: POSITION_TRAIN_MAX,
        confidence: 1,
        probabilities: Object.fromEntries(
          position.criteria.map((_, i) => [String(i), i === POSITION_TRAIN_MAX ? 1 : 0]),
        ),
      };
      selectTraining(request, result, "p0_d0", "passing_up");
      selectTraining(request, result, "p0_d1", "pace_down");
      selectTraining(request, result, "p0_mark", "tired");
      return result;
    });
    const result = await evaluateTraining(brief, { evaluate });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      playerId: "p1",
      tacticGain: 1.5 + TACTIC_GAIN_MIN,
      positionGain: POSITION_TRAIN_MAX,
      attributes: [
        { date: "2026-07-02", axis: "passing", step: 1 },
        { date: "2026-07-03", axis: "pace", step: -1 },
      ],
      mark: "tired",
      note: "",
    });
    expect(result[1]).toMatchObject({
      playerId: "p2",
      positionGain: null,
      attributes: [],
      mark: null,
      note: "",
    });
  });

  it("abstains on tied discrete fields", async () => {
    const evaluator: GameEvaluator = {
      evaluate: async (request) => {
        const result = trainingAnswers(request);
        for (const [key, alternative] of [
          ["p0_d0", "pace_up"],
          ["p0_mark", "standout"],
        ]) {
          const original = result.answers[key!];
          if (original?.type !== "choice") throw new Error("expected choice");
          result.answers[key!] = {
            ...original,
            choice: alternative!,
            probabilities: {
              ...original.probabilities,
              [original.choice]: 0.5,
              [alternative!]: 0.5,
            },
          };
        }
        return result;
      },
    };
    const [outcome] = await evaluateTraining(trainingBrief(), evaluator);
    expect(outcome).toMatchObject({ attributes: [], mark: null });
  });

  it.each(["missing", "extra", "wrong key", "invalid mass", "inconsistent score", "forged choice"])(
    "rejects the entire report on %s",
    async (failure) => {
      const evaluator: GameEvaluator = {
        evaluate: async (request) => {
          const result = trainingAnswers(request);
          if (failure === "missing") delete result.answers.p1_tactic;
          if (failure === "extra") result.answers.unknown = result.answers.p0_tactic!;
          if (failure === "wrong key") {
            result.answers.unknown = result.answers.p1_tactic!;
            delete result.answers.p1_tactic;
          }
          const answer = result.answers.p0_tactic;
          if (answer?.type === "score") {
            if (failure === "invalid mass") answer.probabilities["0"] = 0.1;
            if (failure === "inconsistent score") answer.score += 0.1;
          }
          if (failure === "forged choice") selectTraining(request, result, "p1_d0", "pace_up");
          return result;
        },
      };
      await expect(evaluateTraining(trainingBrief(), evaluator)).rejects.toThrow(ModelOutputError);
    },
  );

  it("rejects duplicate subjects and keeps a long interval inside the question limit", () => {
    const brief = trainingBrief();
    expect(() =>
      buildTrainingRequest({ ...brief, subjects: [brief.subjects[0]!, brief.subjects[0]!] }),
    ).toThrow("중복");
    const long = buildTrainingRequest({
      ...brief,
      sessions: Array.from({ length: 400 }, (_, i) => ({
        ...brief.sessions[0]!,
        date: `date-${String(i).padStart(3, "0")}`,
      })),
    });
    expect(Object.keys(long.questions).length).toBeLessThanOrEqual(TRAINING_QUESTION_LIMIT);
  });
});

describe("training evaluation workflow", () => {
  let base: GameState;
  beforeAll(() => {
    base = createTestGame();
  });
  function fixture() {
    const state = structuredClone(base);
    const brief = trainingBrief();
    brief.subjects = brief.subjects.map((subject, i) => ({
      ...subject,
      playerId: userPlayers(state)[i]!.id,
    }));
    for (const session of brief.sessions)
      state.schedule.push({
        id: session.entryId,
        date: session.date,
        time: "10:00",
        type: "training",
        refId: session.entryId,
        teamId: state.userTeamId,
        status: "done",
      });
    return { state, brief };
  }

  it("preserves an empty report in mock mode without settling the ledger", async () => {
    vi.stubEnv("LLM_MODE", "mock");
    try {
      const { state, brief } = fixture();
      const { report } = await reportTraining(state, brief);
      expect(report).toMatchObject({ moved: [], marks: [] });
      expect(trainingSettled(state, brief)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("retries malformed evaluation once and leaves an empty report without settlement", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { state, brief } = fixture();
      const evaluate = vi.fn<GameEvaluator["evaluate"]>(async (request) => ({
        ...trainingAnswers(request),
        answers: {},
      }));
      const { report } = await reportTraining(state, brief, { evaluate });
      expect(evaluate).toHaveBeenCalledTimes(2);
      expect(report).toMatchObject({ moved: [], marks: [] });
      expect(trainingSettled(state, brief)).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it("does not retry transport errors", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { state, brief } = fixture();
      const evaluate = vi.fn<GameEvaluator["evaluate"]>(async () => {
        throw new LlmCallError("auth", "unavailable");
      });
      await reportTraining(state, brief, { evaluate });
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(trainingSettled(state, brief)).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it("applies only once and skips evaluation for an already settled interval", async () => {
    const { state, brief } = fixture();
    const evaluate = vi.fn<GameEvaluator["evaluate"]>(async (request) => trainingAnswers(request));
    const first = await reportTraining(state, brief, { evaluate });
    expect(first.report).not.toBeNull();
    expect(trainingSettled(state, brief)).toBe(true);
    const after = structuredClone(state);
    expect(await reportTraining(state, brief, { evaluate })).toEqual({ report: null });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(state).toEqual(after);
  });

  it("discards a result if another call settles the interval while it waits", async () => {
    const { state, brief } = fixture();
    let settled: GameState | undefined;
    const evaluator: GameEvaluator = {
      evaluate: async (request) => {
        applyTrainingOutcomes(state, brief, []);
        settled = structuredClone(state);
        const result = trainingAnswers(request);
        selectTraining(request, result, "p0_mark", "standout");
        return result;
      },
    };
    expect(await reportTraining(state, brief, evaluator)).toEqual({ report: null });
    expect(state).toEqual(settled);
  });
});

function settlementBrief(): MatchRatingBrief {
  return {
    matchId: "match-test",
    scoreline: "우리 1 : 0 상대",
    outcome: "win",
    timeline: ["후반 압박으로 상대 전개를 막았다"],
    players: ["p1", "p2"].map((playerId) => ({
      playerId,
      name: playerId,
      position: "CM",
      started: true,
      minutes: 90,
      goals: 0,
      assists: 0,
      shots: 0,
      saves: 0,
      yellows: 0,
      reds: 0,
      anchor: 6.5,
      age: 25,
      room: 5,
      familiarity: 30,
    })),
  };
}

describe("typed match settlement", () => {
  it.each([0, 1] as const)(
    "maps the %s endpoint of both score ranges from a single full batch",
    async (upper) => {
      const brief = settlementBrief();
      const evaluate = vi.fn<GameEvaluator["evaluate"]>(async (request) => {
        expect(JSON.parse(request.state)).toMatchObject({ brief, commentary: "확정 중계" });
        expect(Object.keys(request.questions)).toHaveLength(brief.players.length * 3);
        const result = trainingAnswers(request);
        for (const [key, question] of Object.entries(request.questions)) {
          expect(question.instructions).toContain(key.startsWith("p0_") ? "p1" : "p2");
          if (question.type !== "score") continue;
          const last = question.criteria.length - 1;
          expect(question.criteria).toHaveLength(key.endsWith("rating") ? 7 : 6);
          result.answers[key] = {
            type: "score",
            score: upper * last,
            confidence: 0.1,
            probabilities: Object.fromEntries(
              question.criteria.map((_, i) => [String(i), i === upper * last ? 1 : 0]),
            ),
          };
        }
        selectTraining(request, result, "p0_attribute", "pace_down");
        return result;
      });
      const entries = await evaluateSettlement(brief, "확정 중계", { evaluate });
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(entries).toHaveLength(2);
      expect(entries[0]?.rating).toBeCloseTo(6.5 + (upper ? RATING_BAND : -RATING_BAND));
      expect(entries[0]?.drill).toBe(upper ? MATCH_FAMILIARITY_MAX : MATCH_FAMILIARITY_MIN);
      expect(entries[0]).toMatchObject({ playerId: "p1", attribute: "pace", attributeStep: -1 });
      expect(entries.every((entry) => entry.note === undefined)).toBe(true);
    },
  );

  it("retains fractional score expectations and abstains on a tied attribute", async () => {
    const evaluator: GameEvaluator = {
      evaluate: async (request) => {
        const result = trainingAnswers(request);
        for (const key of ["p0_rating", "p0_drill"]) {
          const question = request.questions[key];
          if (question?.type !== "score") throw new Error("expected score");
          result.answers[key] = {
            type: "score",
            score: 2.25,
            confidence: 0.01,
            probabilities: Object.fromEntries(
              question.criteria.map((_, i) => [String(i), i === 2 ? 0.75 : i === 3 ? 0.25 : 0]),
            ),
          };
        }
        const attribute = result.answers.p0_attribute;
        if (attribute?.type !== "choice") throw new Error("expected choice");
        result.answers.p0_attribute = {
          ...attribute,
          choice: "pace_up",
          probabilities: { ...attribute.probabilities, none: 0.5, pace_up: 0.5 },
        };
        return result;
      },
    };
    const [entry] = await evaluateSettlement(settlementBrief(), "", evaluator);
    expect(entry?.rating).toBeCloseTo(6.5 - RATING_BAND + (2.25 * 2 * RATING_BAND) / 6);
    expect(entry?.drill).toBeCloseTo(
      MATCH_FAMILIARITY_MIN + (2.25 * (MATCH_FAMILIARITY_MAX - MATCH_FAMILIARITY_MIN)) / 5,
    );
    expect(entry).toMatchObject({ attribute: null, attributeStep: null });
  });

  it.each(["missing", "extra", "wrong key", "invalid mass", "inconsistent score", "wrong type"])(
    "rejects %s across the whole batch",
    async (failure) => {
      const evaluator: GameEvaluator = {
        evaluate: async (request) => {
          const result = trainingAnswers(request);
          if (failure === "missing") delete result.answers.p1_rating;
          if (failure === "extra") result.answers.unknown = result.answers.p0_rating!;
          if (failure === "wrong key") {
            result.answers.unknown = result.answers.p1_rating!;
            delete result.answers.p1_rating;
          }
          const answer = result.answers.p1_rating;
          if (answer?.type === "score") {
            if (failure === "invalid mass") answer.probabilities["0"] = 0.1;
            if (failure === "inconsistent score") answer.score += 0.1;
          }
          if (failure === "wrong type") result.answers.p1_rating = { type: "noul", noul: 0.5 };
          return result;
        },
      };
      await expect(evaluateSettlement(settlementBrief(), "", evaluator)).rejects.toThrow(
        ModelOutputError,
      );
    },
  );

  it("rejects duplicate subjects rather than repeating a participant's settlement", () => {
    const brief = settlementBrief();
    expect(() =>
      buildSettlementRequest({ ...brief, players: [brief.players[0]!, brief.players[0]!] }, ""),
    ).toThrow("중복");
  });
});

describe("match settlement workflow", () => {
  let base: GameState;
  let brief: MatchRatingBrief;
  beforeAll(() => {
    base = createMiniGame();
    advanceToMatchday(base);
    expect(startMatch(base).ok).toBe(true);
    brief = buildRatingBrief(base)!;
    finalizeMatch(base);
  });

  it("keeps anchors and prose untouched in mock mode", async () => {
    const state = structuredClone(base);
    vi.stubEnv("LLM_MODE", "mock");
    try {
      expect(
        await runFinalizeMatch(state, brief, undefined, {
          notes: [{ playerId: brief.players[0]!.playerId, note: "마감 근거" }],
        }),
      ).toEqual({ settled: 0 });
      expect(state).toEqual(base);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("retries malformed batches once without applying numbers or closing prose", async () => {
    const state = structuredClone(base);
    const evaluate = vi.fn<GameEvaluator["evaluate"]>(async (request) => ({
      ...trainingAnswers(request),
      answers: {},
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(
        await runFinalizeMatch(
          state,
          brief,
          { evaluate },
          { notes: [{ playerId: brief.players[0]!.playerId, note: "좋았다" }] },
        ),
      ).toEqual({ settled: 0 });
      expect(evaluate).toHaveBeenCalledTimes(2);
      expect(state).toEqual(base);
    } finally {
      warn.mockRestore();
    }
  });

  it("rejects malformed closing prose before evaluation or mutation", async () => {
    const state = structuredClone(base);
    const evaluate = vi.fn<GameEvaluator["evaluate"]>(async (request) => trainingAnswers(request));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(
        await runFinalizeMatch(
          state,
          brief,
          { evaluate },
          { notes: [{ playerId: brief.players[0]!.playerId, note: "" }] },
        ),
      ).toEqual({ settled: 0 });
      expect(evaluate).not.toHaveBeenCalled();
      expect(state).toEqual(base);
    } finally {
      warn.mockRestore();
    }
  });

  it("filters prose to participants, keeps first duplicate note, and never re-applies settlement", async () => {
    const state = structuredClone(base);
    const playerId = brief.players[0]!.playerId;
    const outsider = userPlayers(state).find(
      (player) => !brief.players.some((subject) => subject.playerId === player.id),
    )!;
    const outsiderBefore = structuredClone(outsider.state);
    const evaluate = vi.fn<GameEvaluator["evaluate"]>(async (request) => {
      expect(request.state).not.toContain("마감 설명은 별도");
      return trainingAnswers(request);
    });
    const result = await runFinalizeMatch(
      state,
      brief,
      { evaluate },
      {
        notes: [
          { playerId, note: "마감 설명은 별도" },
          { playerId, note: "덮어쓰면 안 됨" },
          { playerId: outsider.id, note: "뛰지 않음" },
        ],
      },
    );
    expect(result.settled).toBe(brief.players.length);
    const notes = state.matches.find((match) => match.id === brief.matchId)?.result?.ratingNotes;
    expect(notes?.[playerId]).toBe("마감 설명은 별도");
    expect(notes).not.toHaveProperty(outsider.id);
    expect(outsider.state).toEqual(outsiderBefore);
    expect(matchRated(state, brief.matchId)).toBe(true);
    const after = structuredClone(state);
    expect(await runFinalizeMatch(state, brief, { evaluate })).toEqual({ settled: 0 });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(state).toEqual(after);
  });

  it("ignores an in-flight evaluation if another settlement has already applied", async () => {
    const state = structuredClone(base);
    let settled: GameState | undefined;
    const evaluator: GameEvaluator = {
      evaluate: async (request) => {
        settleMatchRating(
          state,
          brief.matchId,
          brief.players.map((player) => ({ playerId: player.playerId, rating: player.anchor })),
        );
        settled = structuredClone(state);
        return trainingAnswers(request);
      },
    };
    expect(
      await runFinalizeMatch(state, brief, evaluator, {
        notes: [{ playerId: brief.players[0]!.playerId, note: "반영하면 안 됨" }],
      }),
    ).toEqual({ settled: 0 });
    expect(state).toEqual(settled);
  });
});
