import { z } from "zod";
import {
  PointSchema,
  SheetLineSchema,
  POINT_TEXT_MAX,
  type Point,
  type SheetLine,
} from "@story-fm/domain";
import type { GameEvaluator, JsonObjectSchema, ScoreQuestion } from "@story-fm/llm";
import { interpretInstructions } from "../common/instruction-compiler";
import type { InstructionRequest } from "../common/instruction-contract";
import type { OpsOrders } from "../common/orders-ops";
import { toToolSchema } from "../common/tool-schema";
import { SHEET_MAX } from "./match-reader";

const PLAN_COMMAND = "set_match_plan";
const CandidateLineSchema = SheetLineSchema.omit({ pointId: true, sign: true, step: true });
const PlanSchema = z.object({
  mode: z
    .enum(["replace", "clear", "keep"])
    .describe(
      "replace는 감독 지시를 반영한 전체 효과를 제출하되 active_effects의 무관한 기존 효과는 유지. 명시적으로 전체 교체를 요청한 경우에만 기존 효과를 모두 바꾼다. clear는 명시적으로 전체 해제, keep은 기존 효과 유지",
    ),
  sheet: z
    .array(CandidateLineSchema)
    .max(SHEET_MAX)
    .describe(
      "replace에는 요청한 변경·대가와 유지할 기존 효과 전체. 바꾸라고 하지 않은 active_effects는 유지한다. clear/keep은 빈 배열. behavior는 개인 지시, edge는 실행 품질, focus는 공격 방향, temper는 거칠기, legs는 체력 소모, cohesion은 형태 유지. behavior/edge/temper/legs는 target.player, focus는 target.side와 lane, cohesion은 target.side. behavior에는 action과 when, mark에는 targetPlayer가 필요하다. 수치 효과의 방향과 강도는 별도로 평가한다. 이득의 기회비용도 반영한다.",
    ),
});

const ScoreSchema = z.object({
  type: z.literal("score"),
  score: z.number().finite().min(0).max(6),
  confidence: z.number().finite().min(0).max(1),
  probabilities: z.record(z.number().finite().min(0).max(1)),
});

export interface MatchInstructionRequest extends Omit<InstructionRequest, "evaluator"> {
  evaluator: GameEvaluator;
  /** The caller owns stable IDs and supplies only the recent ten-minute match context. */
  pointId: string;
}

export type MatchInstructionResult = OpsOrders & {
  /** Absent means preserve the current plan; empty points/sheet means explicitly clear it. */
  reading?: { points: Point[]; sheet: SheetLine[] };
};

function unresolved(): MatchInstructionResult {
  return { ops: {}, unresolved: "경기 지시의 대상·효과·강도를 확인해야 합니다" };
}

function signedStrength(answer: unknown): number | undefined {
  const parsed = ScoreSchema.safeParse(answer);
  if (!parsed.success) return undefined;
  const { probabilities, score } = parsed.data;
  const keys = ["0", "1", "2", "3", "4", "5", "6"];
  if (
    Object.keys(probabilities).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(probabilities, key))
  )
    return undefined;
  const total = keys.reduce((sum, key) => sum + probabilities[key]!, 0);
  if (Math.abs(total - 1) > 1e-6) return undefined;
  const expected = keys.reduce((sum, key) => sum + Number(key) * probabilities[key]!, 0);
  if (Math.abs(expected - score) > 1e-6) return undefined;
  return expected - 3;
}

function refineTargetSchema(
  path: string,
  input: Readonly<Record<string, unknown>>,
  schema: JsonObjectSchema,
): JsonObjectSchema {
  const match = /^\$\.sheet\[(\d+)\]\.target$/.exec(path);
  if (!match || !Array.isArray(input.sheet)) return schema;
  const row: unknown = input.sheet[Number(match[1])];
  if (typeof row !== "object" || row === null || !("shape" in row)) return schema;
  let fields: string[];
  let required: string[];
  switch (row.shape) {
    case "behavior":
      fields = "action" in row && row.action === "mark" ? ["player"] : ["player", "lane"];
      required = ["player"];
      break;
    case "focus":
      fields = required = ["side", "lane"];
      break;
    case "cohesion":
      fields = required = ["side"];
      break;
    case "edge":
    case "temper":
    case "legs":
      fields = required = ["player"];
      break;
    default:
      return schema;
  }
  return {
    ...schema,
    properties: Object.fromEntries(fields.map((field) => [field, schema.properties?.[field]])),
    required,
  };
}

function fieldDisposition(
  path: string,
  input: Readonly<Record<string, unknown>>,
): "include" | "omit" | "defer" {
  const match = /^\$\.sheet\[(\d+)\]\.(action|when|targetPlayer|band|target\.lane)$/.exec(path);
  if (!match || !Array.isArray(input.sheet)) return "include";
  const row: unknown = input.sheet[Number(match[1])];
  if (typeof row !== "object" || row === null || !("shape" in row)) return "defer";
  if (match[2] !== "target.lane") return row.shape === "behavior" ? "include" : "omit";
  if (row.shape !== "behavior") return "include";
  if (!("action" in row)) return "defer";
  return row.action === "mark" ? "omit" : "include";
}

/** Interpret existing match commands and tactical effects without generating point prose. */
export async function interpretMatchInstructions(
  request: MatchInstructionRequest,
): Promise<MatchInstructionResult> {
  if (!request.said.trim()) return { ops: {} };
  const source = PointSchema.safeParse({
    id: request.pointId,
    text: request.said.slice(0, POINT_TEXT_MAX),
    about: [],
    importance: 1,
  });
  if (!source.success || request.commands.some((command) => command.name === PLAN_COMMAND))
    return unresolved();
  const players = request.candidates[`${PLAN_COMMAND}.player`] ?? request.candidates.player ?? [];
  const targets =
    request.candidates[`${PLAN_COMMAND}.targetPlayer`] ?? request.candidates.targetPlayer ?? [];
  const interpreted = await interpretInstructions({
    ...request,
    candidates: {
      ...request.candidates,
      [`${PLAN_COMMAND}.player`]: players,
      [`${PLAN_COMMAND}.targetPlayer`]: targets,
    },
    commands: [
      ...request.commands,
      {
        name: PLAN_COMMAND,
        description:
          "감독의 경기 전술 실행 지시를 적용한다: 맨마킹·커버·공간 침투·상대 약점 공략·왼쪽/오른쪽/중앙 공격 집중(focus). 최근 10분의 관측 사실과 현재 선수의 능력·위치·체력에 근거해 효과와 대가를 함께 정한다. 교체·자리·역할·팀 전술 6축 수치 변경은 해당 명령이 처리한다.",
        inputSchema: toToolSchema(PlanSchema),
        limit: 1,
        contextual: true,
        refineObjectSchema: refineTargetSchema,
        fieldDisposition,
      },
    ],
  });
  if (interpreted.unresolved) return interpreted;
  const ops = { ...interpreted.ops };
  const raw = ops[PLAN_COMMAND];
  delete ops[PLAN_COMMAND];
  if (!raw) return { ...interpreted, ops };
  if (raw.length !== 1) return unresolved();
  const parsed = PlanSchema.safeParse(raw[0]);
  if (!parsed.success) return unresolved();
  const plan = parsed.data;
  if (plan.mode !== "replace") {
    if (plan.sheet.length !== 0) return unresolved();
    return plan.mode === "clear" ? { ops, reading: { points: [], sheet: [] } } : { ops };
  }
  if (plan.sheet.length === 0) return unresolved();
  const playerIds = new Set(players.map((candidate) => candidate.value));
  const targetIds = new Set(targets.map((candidate) => candidate.value));
  if (
    plan.sheet.some(
      (line) =>
        (line.shape === "behavior" && line.action === "mark" && line.targetPlayer === undefined) ||
        (line.target.player !== undefined && !playerIds.has(line.target.player)) ||
        (line.targetPlayer !== undefined && !targetIds.has(line.targetPlayer)),
    )
  )
    return unresolved();

  const questions: Record<string, ScoreQuestion> = {};
  plan.sheet.forEach((line, index) => {
    if (line.shape === "behavior") return;
    questions[`line_${index}`] = {
      type: "score",
      instructions: `전술 효과 ${index}의 방향과 연속 강도. 감독이 요청한 전술과 최근 10분의 관측 사실, 선수의 능력·위치·체력으로 판단한다. 대상과 모양은 바꾸지 않는다. 양수는 edge 실행 품질 증가, focus 해당 방향 선호 증가, temper 파울 증가, legs 체력 소모 증가, cohesion 형태 유지 증가이며 음수는 반대다. 이득과 기회비용을 각각 평가하고 분류 자신감을 강도로 사용하지 않는다.`,
      criteria: [
        "-3: 강한 감소",
        "-2: 중간 감소",
        "-1: 약한 감소",
        "0: 효과 없음",
        "+1: 약한 증가",
        "+2: 중간 증가",
        "+3: 강한 증가",
      ],
    };
  });
  const questionKeys = Object.keys(questions);
  const answers: Record<string, unknown> =
    questionKeys.length === 0
      ? {}
      : (
          await request.evaluator.evaluate({
            state: JSON.stringify({
              instruction: request.said,
              context: request.context,
              effects: plan.sheet,
            }),
            questions,
          })
        ).answers;
  if (
    Object.keys(answers).length !== questionKeys.length ||
    questionKeys.some((key) => !Object.hasOwn(answers, key))
  )
    return unresolved();
  const sheet: SheetLine[] = [];
  for (let index = 0; index < plan.sheet.length; index++) {
    const candidate = plan.sheet[index]!;
    // The core consumes behavior as a discrete instruction and ignores its sign/step.
    const signed = candidate.shape === "behavior" ? 1 : signedStrength(answers[`line_${index}`]);
    if (signed === undefined) return unresolved();
    const line = SheetLineSchema.safeParse({
      ...candidate,
      pointId: request.pointId,
      sign: signed < 0 ? -1 : 1,
      step: Math.abs(signed),
    });
    if (!line.success) return unresolved();
    sheet.push(line.data);
  }
  const about = [
    ...new Set(
      sheet.flatMap((line) =>
        [line.target.player, line.target.side, line.targetPlayer].filter(
          (value): value is string => value !== undefined,
        ),
      ),
    ),
  ];
  return { ops, reading: { points: [{ ...source.data, about }], sheet } };
}
