import { describe, expect, it } from "vitest";
import type { EvaluationAnswer, EvaluationRequest, GameEvaluator, ScoreAnswer } from "@gaffer/llm";
import { POINT_TEXT_MAX } from "@gaffer/domain";
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
    missingMarkTarget?: boolean;
    ordinary?: boolean;
    inconsistentClear?: boolean;
    shapes?: readonly ("behavior" | "edge" | "focus" | "cohesion" | "temper" | "legs")[];
    behaviorAction?: "mark" | "run";
    missingTargetField?: boolean;
  } = {},
): GameEvaluator & { requests: EvaluationRequest[] } {
  const requests: EvaluationRequest[] = [];
  const mode = options.mode ?? "replace";
  const shapes = options.shapes ?? ["behavior"];
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
        const shape = shapes[rowIndex] ?? "behavior";
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
        else if (instruction.includes(".action"))
          choice = shape === "behavior" ? byLabel(options.behaviorAction ?? "mark") : "absent";
        else if (instruction.includes(".when"))
          choice = shape === "behavior" ? byLabel("defend") : "absent";
        else if (instruction.includes(".targetPlayer"))
          choice =
            options.missingMarkTarget || shape !== "behavior" || options.behaviorAction === "run"
              ? "absent"
              : byLabel("상대 공격수");
        else if (instruction.includes(".target.player"))
          choice = options.forgedPlayer ? "not-a-candidate" : byLabel("우리 수비수");
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
      "set_match_plan.player": [{ label: "우리 수비수", value: "home-1" }],
      "set_match_plan.targetPlayer": [{ label: "상대 공격수", value: "away-1" }],
    },
    evaluator,
  };
}

describe("Jev match instruction boundary", () => {
  it("grounds a discrete behavior in the literal instruction without evaluating sign or strength", async () => {
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
            shape: "behavior",
            sign: 1,
            step: 1,
            action: "mark",
            when: "defend",
            targetPlayer: "away-1",
          },
        ],
      },
    });
    expect(
      evaluator.requests.filter((request) =>
        Object.values(request.questions).some((question) => question.type === "score"),
      ),
    ).toHaveLength(0);
    expect(
      evaluator.requests.some((request) =>
        Object.values(request.questions).some((question) =>
          question.instructions.includes("argument $.sheet[0].sign"),
        ),
      ),
    ).toBe(false);
    expect(evaluator.requests).toHaveLength(4);
  });

  it.each([
    ["behavior", "mark", { player: "home-1" }, ["player"]],
    ["behavior", "run", { player: "home-1", lane: "left" }, ["player", "lane"]],
    ["focus", "mark", { side: "home", lane: "left" }, ["side", "lane"]],
    ["cohesion", "mark", { side: "home" }, ["side"]],
    ["edge", "mark", { player: "home-1" }, ["player"]],
    ["temper", "mark", { player: "home-1" }, ["player"]],
    ["legs", "mark", { player: "home-1" }, ["player"]],
  ] as const)(
    "only asks applicable target fields for %s/%s",
    async (shape, action, target, fields) => {
      const evaluator = model({ shapes: [shape], behaviorAction: action });
      const result = await interpretMatchInstructions(input(evaluator));
      expect(result.unresolved).toBeUndefined();
      expect(result.reading?.sheet[0]?.target).toEqual(target);
      const asked = evaluator.requests
        .flatMap((request) => Object.values(request.questions))
        .flatMap((question) => {
          const match = /argument \$\.sheet\[0\]\.target\.(\w+)/.exec(question.instructions);
          return match ? [match[1]] : [];
        });
      expect(asked).toEqual(fields);
      if (shape !== "behavior") {
        const behaviorFields = evaluator.requests
          .flatMap((request) => Object.values(request.questions))
          .filter((question) =>
            /argument \$\.sheet\[0\]\.(action|when|targetPlayer|band)\./.test(
              question.instructions,
            ),
          );
        expect(behaviorFields).toEqual([]);
        expect(evaluator.requests).toHaveLength(5);
        expect(
          Object.values(evaluator.requests[4]!.questions).every(
            (question) => question.type === "score",
          ),
        ).toBe(true);
      }
    },
  );

  it("requires both focus target fields without allowing an omitted lane", async () => {
    const result = await interpretMatchInstructions(
      input(model({ shapes: ["focus"], missingTargetField: true })),
    );
    expect(result.ops).toEqual({});
    expect(result.reading).toBeUndefined();
    expect(result.unresolved).toBeDefined();
  });

  it("scores only numeric effects in a mixed plan and preserves the continuous signed expectation", async () => {
    const evaluator = model({ shapes: ["behavior", "edge"] });
    const result = await interpretMatchInstructions(input(evaluator));
    expect(result.unresolved).toBeUndefined();
    expect(result.reading?.sheet.map(({ shape, sign, step }) => ({ shape, sign, step }))).toEqual([
      { shape: "behavior", sign: 1, step: 1 },
      { shape: "edge", sign: 1, step: 1.5 },
    ]);
    const scoring = evaluator.requests.filter((request) =>
      Object.values(request.questions).some((question) => question.type === "score"),
    );
    expect(scoring).toHaveLength(1);
    expect(Object.keys(scoring[0]!.questions)).toEqual(["line_1"]);
    expect(scoring[0]!.questions.line_1?.criteria).toHaveLength(7);
  });

  it.each([
    ["negative boundary", [1, 0, 0, 0, 0, 0, 0], -1, 3],
    ["positive boundary", [0, 0, 0, 0, 0, 0, 1], 1, 3],
    ["zero", [0, 0, 0, 1, 0, 0, 0], 1, 0],
    ["opposing mass", [0.5, 0, 0, 0, 0, 0, 0.5], 1, 0],
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

  it("rejects marking without a target before scoring or applying effects", async () => {
    const evaluator = model({ missingMarkTarget: true });
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

  it("rejects a clear decision paired with nonempty effects instead of clearing the current plan", async () => {
    const result = await interpretMatchInstructions(
      input(model({ mode: "clear", inconsistentClear: true })),
    );
    expect(result.reading).toBeUndefined();
    expect(result.unresolved).toBeDefined();
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
  ] as const)("rejects %s score before any commands can apply", async (_, score) => {
    const evaluator = model({ score, ordinary: true, shapes: ["edge"] });
    const result = await interpretMatchInstructions(input(evaluator));
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
