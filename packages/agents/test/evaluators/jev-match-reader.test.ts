import { describe, expect, it } from "vitest";
import type { EvaluationAnswer, EvaluationRequest, GameEvaluator, ScoreAnswer } from "@gaffer/llm";
import { CARD_STEP_MAX, POINT_TEXT_MAX, cardStepLabel } from "@gaffer/domain";
import {
  interpretMatchInstructions,
  type MatchInstructionRequest,
} from "../../src/evaluators/jev-match-reader";

const scored = (
  score = 4.5,
  probabilities = { "0": 0, "1": 0, "2": 0, "3": 0, "4": 0.5, "5": 0.5, "6": 0 },
): ScoreAnswer => ({
  type: "score",
  score,
  confidence: 0.1,
  probabilities,
});

function model(
  options: {
    mode?: "replace" | "clear" | "keep" | "none";
    score?: EvaluationAnswer | null;
    forgedPlayer?: boolean;
    opponentCard?: boolean;
    missingWord?: boolean;
    zonal?: boolean;
    ordinary?: boolean;
    inconsistentClear?: boolean;
    shapes?: readonly ("card" | "edge" | "focus" | "cohesion" | "temper" | "legs")[];
    word?: "mark" | "runBehind";
    missingTargetField?: boolean;
  } = {},
): GameEvaluator & { requests: EvaluationRequest[] } {
  const requests: EvaluationRequest[] = [];
  const mode = options.mode ?? "replace";
  const shapes = options.shapes ?? ["card"];
  const word = options.word ?? "mark";
  return {
    requests,
    async evaluate(request) {
      requests.push(request);
      const answers: Record<string, EvaluationAnswer> = {};
      for (const [key, question] of Object.entries(request.questions)) {
        if (question.type === "score") {
          if (options.score !== null) answers[key] = options.score ?? scored();
          continue;
        }
        if (question.type !== "choice") throw new Error("Unexpected question");
        const instruction = question.instructions;
        const rowIndex = Number(/\$\.sheet\[(\d+)\]/.exec(instruction)?.[1] ?? 0);
        const shape = shapes[rowIndex] ?? "card";
        let choice = "absent";
        const byLabel = (label: string) =>
          Object.entries(question.criteria).find(([, text]) => text === label)?.[0] ?? "unclear";
        if (requests.length === 1) {
          choice = instruction.includes("set_match_plan")
            ? mode === "none"
              ? "n0"
              : "n1"
            : options.ordinary
              ? "n1"
              : "n0";
        } else if (instruction.includes("set_tactics")) choice = "v0";
        else if (instruction.includes("$.mode")) choice = byLabel(mode);
        else if (instruction.includes("The number of items"))
          choice = mode === "replace" || options.inconsistentClear ? `n${shapes.length}` : "n0";
        else if (instruction.includes(".shape")) choice = byLabel(shape);
        else if (instruction.includes(".word"))
          choice = shape === "card" && !options.missingWord ? byLabel(word) : "absent";
        else if (instruction.includes(".targetPlayer"))
          choice =
            shape === "card" && word === "mark" && !options.zonal
              ? byLabel("상대 공격수")
              : "absent";
        else if (instruction.includes(".target.player"))
          choice = options.forgedPlayer
            ? "not-a-candidate"
            : byLabel(options.opponentCard ? "상대 공격수" : "우리 수비수");
        else if (instruction.includes(".target.side")) choice = byLabel("home");
        else if (instruction.includes(".target.lane"))
          choice = options.missingTargetField ? "absent" : byLabel("left");
        answers[key] = {
          type: "choice",
          choice,
          confidence: 1,
          probabilities: Object.fromEntries(
            Object.keys(question.criteria).map((candidate) => [
              candidate,
              candidate === choice ? 1 : 0,
            ]),
          ),
        };
      }
      return {
        model: "mock",
        answers,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
}

function input(evaluator: GameEvaluator): MatchInstructionRequest {
  return {
    said: "우리 수비수는 상대 공격수를 밀착 마크해",
    context:
      "최근 10분: 상대 공격수가 세 차례 중앙에서 패스를 받았다. 현재 두 선수 모두 그라운드에 있다.",
    pointId: "order-1",
    ours: ["home-1"],
    commands: [
      {
        name: "set_tactics",
        description: "압박 변경",
        limit: 1,
        inputSchema: {
          type: "object",
          properties: { pressing: { type: "integer", enum: [4] } },
          required: ["pressing"],
        },
      },
    ],
    candidates: {
      "set_match_plan.player": [
        { label: "우리 수비수", value: "home-1" },
        { label: "상대 공격수", value: "away-1" },
      ],
      "set_match_plan.targetPlayer": [{ label: "상대 공격수", value: "away-1" }],
    },
    evaluator,
  };
}

describe("Jev match instruction boundary", () => {
  it("grounds a card row in the literal instruction and scores its step on the word's own scale", async () => {
    const evaluator = model();
    const request = input(evaluator);
    const result = await interpretMatchInstructions(request);
    expect(result).toEqual({
      ops: {},
      reading: {
        points: [{ id: "order-1", text: request.said, about: ["home-1", "away-1"], importance: 1 }],
        sheet: [
          {
            pointId: "order-1",
            target: { player: "home-1" },
            shape: "card",
            sign: 1,
            step: 1.5,
            word: "mark",
            targetPlayer: "away-1",
          },
        ],
      },
    });
    const scoring = evaluator.requests.filter((request) =>
      Object.values(request.questions).some((question) => question.type === "score"),
    );
    expect(scoring).toHaveLength(1);
    expect(scoring[0]!.questions.line_0?.criteria).toEqual(
      Array.from({ length: CARD_STEP_MAX * 2 + 1 }, (_, i) =>
        cardStepLabel("mark", i - CARD_STEP_MAX),
      ),
    );
    expect(
      evaluator.requests.some((request) =>
        Object.values(request.questions).some((question) =>
          question.instructions.includes("argument $.sheet[0].sign"),
        ),
      ),
    ).toBe(false);
  });

  it("asks for a mark target only on the mark word", async () => {
    const zonal = await interpretMatchInstructions(input(model({ zonal: true })));
    expect(zonal.reading?.sheet[0]).toMatchObject({ shape: "card", word: "mark" });
    expect(zonal.reading?.sheet[0]?.targetPlayer).toBeUndefined();
    const evaluator = model({ word: "runBehind" });
    const run = await interpretMatchInstructions(input(evaluator));
    expect(run.reading?.sheet[0]).toMatchObject({ shape: "card", word: "runBehind" });
    expect(
      evaluator.requests
        .flatMap((request) => Object.values(request.questions))
        .some((question) => question.instructions.includes("$.sheet[0].targetPlayer")),
    ).toBe(false);
  });

  it.each([
    ["card", { player: "home-1" }, ["player"]],
    ["focus", { side: "home", lane: "left" }, ["side", "lane"]],
    ["cohesion", { side: "home" }, ["side"]],
    ["edge", { player: "home-1" }, ["player"]],
    ["temper", { player: "home-1" }, ["player"]],
    ["legs", { player: "home-1" }, ["player"]],
  ] as const)("only asks applicable target fields for %s", async (shape, target, fields) => {
    const evaluator = model({ shapes: [shape] });
    const result = await interpretMatchInstructions(input(evaluator));
    expect(result.unresolved).toBeUndefined();
    expect(result.reading?.sheet[0]?.target).toEqual(target);
    const questions = evaluator.requests.flatMap((request) => Object.values(request.questions));
    const asked = questions.flatMap((question) => {
      const match = /argument \$\.sheet\[0\]\.target\.(\w+)/.exec(question.instructions);
      return match ? [match[1]] : [];
    });
    expect(asked).toEqual(fields);
    if (shape !== "card") {
      expect(
        questions.filter((question) =>
          /argument \$\.sheet\[0\]\.(word|targetPlayer)\./.test(question.instructions),
        ),
      ).toEqual([]);
      // routing · mode · effect count · line · target fields · score
      expect(evaluator.requests).toHaveLength(6);
      expect(
        Object.values(evaluator.requests.at(-1)!.questions).every(
          (question) => question.type === "score",
        ),
      ).toBe(true);
    }
  });

  it("requires both focus target fields without allowing an omitted lane", async () => {
    const result = await interpretMatchInstructions(
      input(model({ shapes: ["focus"], missingTargetField: true })),
    );
    expect(result.ops).toEqual({});
    expect(result.reading).toBeUndefined();
    expect(result.unresolved).toBeDefined();
  });

  it("scores every effect of a mixed plan in one request and preserves the continuous signed expectation", async () => {
    const evaluator = model({ shapes: ["card", "edge"] });
    const result = await interpretMatchInstructions(input(evaluator));
    expect(result.unresolved).toBeUndefined();
    expect(result.reading?.sheet.map(({ shape, sign, step }) => ({ shape, sign, step }))).toEqual([
      { shape: "card", sign: 1, step: 1.5 },
      { shape: "edge", sign: 1, step: 1.5 },
    ]);
    const scoring = evaluator.requests.filter((request) =>
      Object.values(request.questions).some((question) => question.type === "score"),
    );
    expect(scoring).toHaveLength(1);
    expect(Object.keys(scoring[0]!.questions)).toEqual(["line_0", "line_1"]);
    expect(scoring[0]!.questions.line_1?.criteria).toHaveLength(7);
  });

  it.each([
    ["negative boundary", [1, 0, 0, 0, 0, 0, 0], -1, 3],
    ["positive boundary", [0, 0, 0, 0, 0, 0, 1], 1, 3],
    ["zero", [0, 0, 0, 1, 0, 0, 0], 1, 0],
    ["continuous negative", [0, 0.5, 0.5, 0, 0, 0, 0], -1, 1.5],
  ] as const)("maps %s to deterministic direction and magnitude", async (_, mass, sign, step) => {
    const score: ScoreAnswer = {
      type: "score",
      score: mass.reduce<number>((sum, probability, index) => sum + probability * index, 0),
      confidence: 0.1,
      probabilities: Object.fromEntries(
        mass.map((probability, index) => [String(index), probability]),
      ),
    };
    const result = await interpretMatchInstructions(input(model({ shapes: ["edge"], score })));
    expect(result.unresolved).toBeUndefined();
    expect(result.reading?.sheet[0]).toMatchObject({ shape: "edge", sign, step });
  });

  it("holds an effect whose strength readings point both ways instead of averaging to zero", async () => {
    const score: ScoreAnswer = {
      type: "score",
      score: 3,
      confidence: 0.1,
      probabilities: { "0": 0.5, "1": 0, "2": 0, "3": 0, "4": 0, "5": 0, "6": 0.5 },
    };
    const result = await interpretMatchInstructions(
      input(model({ shapes: ["edge"], score, ordinary: true })),
    );
    expect(result.reading).toBeUndefined();
    expect(result.ops).toEqual({ set_tactics: [{ pressing: 4 }] });
    expect(result.unresolved).toBe("경기 전술 효과 — 효과의 방향이 갈림");
  });

  it("rejects a card row without a word before scoring or applying effects", async () => {
    const evaluator = model({ missingWord: true });
    const result = await interpretMatchInstructions(input(evaluator));
    expect(result.unresolved).toBeTruthy();
    expect(result.reading).toBeUndefined();
    expect(
      evaluator.requests.some((request) =>
        Object.values(request.questions).some((question) => question.type === "score"),
      ),
    ).toBe(false);
  });

  it.each(["keep", "none"] as const)("preserves the current plan on %s", async (mode) => {
    const evaluator = model({ mode });
    expect(await interpretMatchInstructions(input(evaluator))).toEqual({ ops: {} });
    expect(
      evaluator.requests.every((request) =>
        Object.values(request.questions).every((question) => question.type === "choice"),
      ),
    ).toBe(true);
  });

  it("clears only an explicit empty clear plan", async () => {
    const evaluator = model({ mode: "clear" });
    expect(await interpretMatchInstructions(input(evaluator))).toEqual({
      ops: {},
      reading: { points: [], sheet: [] },
    });
  });

  it("asks for effect lines only once the plan replaces the current effects", async () => {
    const evaluator = model({ mode: "clear", inconsistentClear: true });
    const result = await interpretMatchInstructions(input(evaluator));
    expect(result).toEqual({ ops: {}, reading: { points: [], sheet: [] } });
    const asked = evaluator.requests
      .flatMap((request) => Object.values(request.questions))
      .map((question) => question.instructions);
    expect(asked.some((text) => text.includes("argument $.sheet"))).toBe(false);
  });

  it("keeps ordinary commands without manufacturing a tactical reading", async () => {
    const result = await interpretMatchInstructions(input(model({ mode: "none", ordinary: true })));
    expect(result).toEqual({ ops: { set_tactics: [{ pressing: 4 }] } });
  });

  it("preserves ordinary match commands and removes its virtual plan command", async () => {
    const evaluator = model({ ordinary: true });
    const result = await interpretMatchInstructions(input(evaluator));
    expect(result.ops).toEqual({ set_tactics: [{ pressing: 4 }] });
    expect(result.reading?.sheet).toHaveLength(1);
  });

  it.each([
    ["missing", null],
    ["out of bounds", scored(7)],
    ["inconsistent expectation", scored(4)],
    ["missing probability", { ...scored(), probabilities: { "0": 0, "1": 0.5, "2": 0.5 } }],
    ["invalid total", { ...scored(), probabilities: { ...scored().probabilities, "0": 0.1 } }],
    ["extra probability", { ...scored(), probabilities: { ...scored().probabilities, "7": 0 } }],
    [
      "negative probability",
      { ...scored(), probabilities: { ...scored().probabilities, "0": -0.1 } },
    ],
    ["wrong type", { type: "noul", noul: 0.9 }],
  ] as const)("drops the effect on a %s score and keeps the ordinary command", async (_, score) => {
    const evaluator = model({ score, ordinary: true, shapes: ["edge"] });
    const result = await interpretMatchInstructions(input(evaluator));
    expect(result.ops).toEqual({ set_tactics: [{ pressing: 4 }] });
    expect(result.reading).toBeUndefined();
    expect(result.unresolved).toBeDefined();
  });

  it("does not write a card row for an opponent — the manager instructs only their own players", async () => {
    const result = await interpretMatchInstructions(input(model({ opponentCard: true })));
    expect(result.ops).toEqual({});
    expect(result.reading).toBeUndefined();
    expect(result.unresolved).toBeDefined();
  });

  it("does not accept a player outside the caller's on-pitch candidates", async () => {
    const result = await interpretMatchInstructions(input(model({ forgedPlayer: true })));
    expect(result.ops).toEqual({});
    expect(result.reading).toBeUndefined();
    expect(result.unresolved).toBeDefined();
  });

  it("bounds source metadata without inventing or paraphrasing prose", async () => {
    const request = { ...input(model()), said: "밀착 마크 지시 ".repeat(20) };
    const result = await interpretMatchInstructions(request);
    expect(result.reading?.points[0]?.text).toBe(request.said.slice(0, POINT_TEXT_MAX));
  });

  it("propagates provider failure while returning no partial result", async () => {
    const evaluator = model({ shapes: ["edge"] });
    const failing: GameEvaluator = {
      evaluate: async (request) => {
        if (Object.values(request.questions).some((question) => question.type === "score"))
          throw new Error("score unavailable");
        return evaluator.evaluate(request);
      },
    };
    await expect(interpretMatchInstructions(input(failing))).rejects.toThrow("score unavailable");
  });
});
