import { describe, expect, it } from "vitest";
import type { EvaluationRequest, GameEvaluator } from "@story-fm/llm";
import { interpretInstructions } from "../../src/common/instruction-compiler";
import type { InstructionCommand, InstructionRequest } from "../../src/common/instruction-contract";
import { sourceNumbers } from "../../src/common/instruction-values";

function evaluator(
  pick: (instructions: string, criteria: Record<string, string | null>, stage: number) => string,
): GameEvaluator & { requests: EvaluationRequest[] } {
  const requests: EvaluationRequest[] = [];
  return {
    requests,
    async evaluate(request) {
      requests.push(request);
      return {
        model: "mock",
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        answers: Object.fromEntries(
          Object.entries(request.questions).map(([key, question]) => {
            if (question.type !== "choice") throw new Error("Expected choice");
            const choice = pick(question.instructions, question.criteria, requests.length);
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
    },
  };
}
function request(
  commands: InstructionCommand[],
  model: GameEvaluator,
  extra: Partial<InstructionRequest> = {},
): InstructionRequest {
  return {
    said: "민수에게 등번호 9번을 줘",
    context: "민수 id=p1, 준호 id=p2",
    candidates: {
      playerId: [
        { label: "민수", value: "p1" },
        { label: "준호", value: "p2" },
      ],
    },
    commands,
    evaluator: model,
    ...extra,
  };
}
const numberCommand: InstructionCommand = {
  name: "set_squad_number",
  description: "등번호 지정",
  limit: 4,
  inputSchema: {
    type: "object",
    properties: {
      playerId: { type: "string" },
      number: { type: "integer", minimum: 1, maximum: 99 },
      take: { type: "boolean" },
    },
    required: ["playerId", "number"],
  },
};
const select = (criteria: Record<string, string | null>, label: string) =>
  Object.entries(criteria).find(([, value]) => value?.includes(label))?.[0] ?? "unclear";

describe("source-grounded instruction compiler", () => {
  it("never omits required fields through an applicability hook", async () => {
    const model = evaluator((_, __, stage) => (stage === 1 ? "n1" : "v0"));
    const output = await interpretInstructions(
      request(
        [
          {
            ...numberCommand,
            fieldDisposition: (path) => (path === "$.number" ? "omit" : "include"),
          },
        ],
        model,
      ),
    );
    expect(output.ops).toEqual({});
    expect(output.unresolved).toBeDefined();
  });

  it("bounds unresolved applicability dependencies without empty model calls", async () => {
    const model = evaluator(() => "n1");
    const output = await interpretInstructions(
      request(
        [
          {
            ...numberCommand,
            fieldDisposition: () => "defer",
          },
        ],
        model,
      ),
    );
    expect(output.ops).toEqual({});
    expect(output.unresolved).toBeDefined();
    expect(model.requests).toHaveLength(1);
  });

  it("narrows child fields from resolved sibling values without another evaluation round", async () => {
    const command: InstructionCommand = {
      name: "scoped",
      description: "conditional target",
      limit: 1,
      inputSchema: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["player"] },
          target: {
            type: "object",
            properties: { playerId: { type: "string" }, side: { type: "string", enum: ["home"] } },
          },
        },
        required: ["kind", "target"],
      },
      refineObjectSchema(path, input, schema) {
        if (path !== "$.target") return schema;
        expect(input.kind).toBe("player");
        return {
          ...schema,
          properties: { playerId: schema.properties?.playerId },
          required: ["playerId"],
        };
      },
    };
    const model = evaluator((instructions, criteria, stage) => {
      if (stage === 1) return "n1";
      expect(instructions).not.toContain(".side");
      expect(criteria).not.toHaveProperty("absent");
      return "v0";
    });
    expect(await interpretInstructions(request([command], model))).toEqual({
      ops: { scoped: [{ kind: "player", target: { playerId: "p1" } }] },
    });
    expect(model.requests).toHaveLength(3);
    expect(model.requests.every(({ state }) => !state.includes("refineObjectSchema"))).toBe(true);
  });

  it.each(["new field", "weaker field", "missing required"] as const)(
    "rejects schema refinement with %s",
    async (violation) => {
      const command: InstructionCommand = {
        ...numberCommand,
        refineObjectSchema(_, __, schema) {
          if (violation === "new field")
            return {
              ...schema,
              properties: { ...schema.properties, injected: { type: "string" } },
            };
          if (violation === "weaker field")
            return { ...schema, properties: { ...schema.properties, number: { type: "number" } } };
          return { ...schema, required: [] };
        },
      };
      const output = await interpretInstructions(
        request(
          [command],
          evaluator(() => "n1"),
        ),
      );
      expect(output.ops).toEqual({});
      expect(output.unresolved).toBeDefined();
    },
  );

  it("does not execute or ask for arguments when the execution classifier rejects a question", async () => {
    const model = evaluator(() => "n0");
    expect(
      await interpretInstructions(
        request([numberCommand], model, { said: "민수에게 9번을 주면 어떨까?" }),
      ),
    ).toEqual({ ops: {} });
    expect(model.requests).toHaveLength(1);
  });

  it("uses exact numbers from the utterance and IDs from the supplied state", async () => {
    const model = evaluator((instructions, criteria, stage) => {
      if (stage === 1) return "n1";
      if (instructions.includes("전체 지시 대조")) return "confirmed";
      if (instructions.includes("$.playerId")) return select(criteria, "민수");
      if (instructions.includes("$.number")) return select(criteria, "= 9");
      return "absent";
    });
    expect(await interpretInstructions(request([numberCommand], model))).toEqual({
      ops: { set_squad_number: [{ playerId: "p1", number: 9 }] },
    });
    expect(model.requests).toHaveLength(2);
  });

  it.each(["unclear", "overflow", "forged-key"])(
    "rejects an unresolved or out-of-contract route (%s) without partial output",
    async (answer) => {
      const model = evaluator(() => answer);
      const output = await interpretInstructions(request([numberCommand], model));
      expect(output.ops).toEqual({});
      expect(output.unresolved).toBeDefined();
      expect(model.requests).toHaveLength(1);
    },
  );

  it("does not infer an absent amount from the reference context", async () => {
    const command: InstructionCommand = {
      name: "send_offer",
      description: "오퍼",
      limit: 1,
      inputSchema: {
        type: "object",
        properties: { fee: { type: "number", minimum: 0 } },
        required: ["fee"],
      },
    };
    const model = evaluator((instructions, criteria, stage) => {
      if (stage === 1) return "n1";
      expect(criteria).toEqual({ unclear: expect.any(String) });
      return "unclear";
    });
    expect(
      (
        await interpretInstructions(
          request([command], model, { said: "민수를 사자", context: "이적료 3000000" }),
        )
      ).ops,
    ).toEqual({});
  });

  it("never converts an unknown ID field to arbitrary source text", async () => {
    const model = evaluator(() => "n1");
    const output = await interpretInstructions(request([numberCommand], model, { candidates: {} }));
    expect(output.ops).toEqual({});
    expect(output.unresolved).toBeDefined();
  });

  it("rejects duplicate selected array members and keeps the entire utterance unapplied", async () => {
    const command: InstructionCommand = {
      name: "order",
      description: "명단",
      limit: 1,
      inputSchema: {
        type: "object",
        properties: {
          playerIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 11 },
        },
        required: ["playerIds"],
      },
    };
    const model = evaluator((instructions, criteria, stage) =>
      stage === 1 ? "n1" : instructions.includes("항목만 세고") ? "n2" : select(criteria, "민수"),
    );
    const output = await interpretInstructions(
      request([command], model, {
        said: "민수와 준호를 명단에",
        candidates: {
          playerIds: [
            { label: "민수", value: "p1" },
            { label: "준호", value: "p2" },
          ],
        },
      }),
    );
    expect(output.ops).toEqual({});
    expect(output.unresolved).toBeDefined();
  });

  it("rejects reversed source boundaries rather than constructing new text", async () => {
    const command: InstructionCommand = {
      name: "note",
      description: "메모",
      limit: 1,
      inputSchema: {
        type: "object",
        properties: { note: { type: "string", minLength: 1 } },
        required: ["note"],
      },
    };
    const model = evaluator((instructions, criteria, stage) =>
      stage === 1 ? "n1" : instructions.includes("시작 경계.") ? "s2" : "e0",
    );
    expect(
      (await interpretInstructions(request([command], model, { said: "패스 훈련 진행" }))).ops,
    ).toEqual({});
  });

  it("fails an unsupported union visibly instead of guessing a shape", async () => {
    const command: InstructionCommand = {
      name: "unsupported",
      description: "union",
      limit: 1,
      inputSchema: {
        type: "object",
        properties: { value: { anyOf: [{ type: "string" }, { type: "number" }] } },
        required: ["value"],
      },
    };
    const output = await interpretInstructions(
      request(
        [command],
        evaluator(() => "n1"),
      ),
    );
    expect(output.unresolved).toBeDefined();
    expect(output.ops).toEqual({});
  });

  it("rejects numeric candidates outside the existing schema", async () => {
    const model = evaluator((instructions, criteria, stage) => {
      if (stage === 1) return "n1";
      if (instructions.includes("$.number")) {
        expect(Object.values(criteria).some((label) => label?.includes("999"))).toBe(false);
        return "unclear";
      }
      return instructions.includes("$.playerId") ? "v0" : "absent";
    });
    expect(
      (
        await interpretInstructions(
          request([numberCommand], model, { said: "민수에게 999번을 줘" }),
        )
      ).unresolved,
    ).toBeDefined();
  });

  it("rejects repeated identical command instances instead of applying a financial instruction twice", async () => {
    const command: InstructionCommand = {
      name: "request_board",
      description: "보드 예산 요청",
      limit: 4,
      inputSchema: {
        type: "object",
        properties: { amount: { type: "number", minimum: 1 } },
        required: ["amount"],
      },
    };
    const model = evaluator((instructions, criteria, stage) =>
      stage === 1 ? "n2" : select(criteria, "= 30000000"),
    );
    const output = await interpretInstructions(
      request([command], model, { said: "보드에 이적 예산 3천만원을 더 요청해" }),
    );
    expect(output.ops).toEqual({});
    expect(output.unresolved).toBeDefined();
  });

  it("keeps nested array arguments scoped to the same ordered item", async () => {
    const command: InstructionCommand = {
      name: "set_lineup",
      description: "선발",
      limit: 1,
      inputSchema: {
        type: "object",
        properties: {
          starting: {
            type: "array",
            minItems: 1,
            maxItems: 11,
            items: {
              type: "object",
              properties: {
                playerId: { type: "string" },
                position: { type: "string", enum: ["GK", "ST"] },
              },
              required: ["playerId", "position"],
            },
          },
        },
        required: ["starting"],
      },
    };
    const model = evaluator((instructions, criteria, stage) => {
      if (stage === 1) return "n1";
      if (instructions.includes("항목만 세고")) return "n2";
      const first = instructions.includes("$.starting[0]");
      return select(
        criteria,
        instructions.includes(".playerId") ? (first ? "민수" : "준호") : first ? "GK" : "ST",
      );
    });
    expect(
      await interpretInstructions(
        request([command], model, { said: "민수는 골키퍼, 준호는 공격수로 선발" }),
      ),
    ).toEqual({
      ops: {
        set_lineup: [
          {
            starting: [
              { playerId: "p1", position: "GK" },
              { playerId: "p2", position: "ST" },
            ],
          },
        ],
      },
    });
    expect(model.requests).toHaveLength(3);
  });

  it("allows explicit nullable clearing while rejecting null for a required non-nullable ID", async () => {
    const command: InstructionCommand = {
      name: "set_captain",
      description: "완장",
      limit: 1,
      inputSchema: { type: "object", properties: { vice: { type: ["string", "null"] } } },
    };
    const model = evaluator((instructions, criteria, stage) =>
      stage === 1 ? "n1" : select(criteria, "지정 해제"),
    );
    expect(
      await interpretInstructions(
        request([command], model, {
          said: "부주장 지정을 해제해",
          candidates: { vice: [{ label: "민수", value: "p1" }] },
        }),
      ),
    ).toEqual({ ops: { set_captain: [{ vice: null }] } });
    expect(model.requests).toHaveLength(2);
  });

  it("does not silently truncate candidate pools beyond the provider limit", async () => {
    const model = evaluator(() => "n1");
    const output = await interpretInstructions(
      request([numberCommand], model, {
        candidates: {
          playerId: Array.from({ length: 255 }, (_, i) => ({ label: `선수${i}`, value: `p${i}` })),
        },
      }),
    );
    expect(output.ops).toEqual({});
    expect(output.unresolved).toBeDefined();
    expect(model.requests).toHaveLength(1);
  });

  it.each(["plurality", "tie", "missing", "wrong-sum"])(
    "abstains from unsupported probability evidence (%s)",
    async (kind) => {
      const base = evaluator(() => "n1");
      const model: GameEvaluator = {
        async evaluate(input) {
          const result = await base.evaluate(input);
          const answer = result.answers.q0!;
          if (answer.type !== "choice") throw new Error("Expected choice");
          if (kind === "missing") delete answer.probabilities.n0;
          else if (kind === "wrong-sum") answer.probabilities.n1 = 0.8;
          else {
            answer.probabilities.n1 = kind === "tie" ? 0.5 : 0.4;
            answer.probabilities.n0 = kind === "tie" ? 0.5 : 0.35;
            answer.probabilities.unclear = kind === "tie" ? 0 : 0.25;
          }
          return result;
        },
      };
      const result = await interpretInstructions(request([numberCommand], model));
      expect(result.ops).toEqual({});
      expect(result.unresolved).toBeDefined();
      expect(base.requests).toHaveLength(1);
    },
  );

  it("propagates provider failures for caller metering and cancellation", async () => {
    const failure = new Error("Provider unavailable");
    const model: GameEvaluator = {
      evaluate: async () => {
        throw failure;
      },
    };
    await expect(interpretInstructions(request([numberCommand], model))).rejects.toBe(failure);
  });
});

describe("exact source numbers", () => {
  it("parses Korean monetary units without quantizing values", () => {
    expect(
      sourceNumbers("이적료 2억 3천만, 주급 42,350.5, 계약 3년").map((number) => number.value),
    ).toEqual([230_000_000, 42350.5, 3]);
    expect(sourceNumbers("금액 -12.5와 1.25억").map((number) => number.value)).toEqual([
      -12.5, 125_000_000,
    ]);
  });
  it("rejects malformed digit grouping without extracting a plausible smaller amount", () => {
    expect(sourceNumbers("1,00원")).toEqual([]);
    expect(sourceNumbers("금액 100, 연수 3").map(({ value }) => value)).toEqual([100, 3]);
    expect(sourceNumbers("2억 3,000만").map(({ value }) => value)).toEqual([230_000_000]);
  });
  it("preserves explicit zero instead of treating it as an omitted unit coefficient", () => {
    expect(sourceNumbers("0억, 0천만, 1억 0천만").map(({ value }) => value)).toEqual([
      0, 0, 100_000_000,
    ]);
  });
  it("retains exact source slices and rejects unsafe magnitudes", () => {
    const said = "2억 3천만을 제안해";
    expect(
      sourceNumbers(said).map(({ start, end, text }) => said.slice(start, end) === text),
    ).toEqual([true]);
    expect(sourceNumbers("99999999999999999999원")).toEqual([]);
  });
});
