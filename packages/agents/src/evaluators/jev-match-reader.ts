import { validatedAnswer } from "../shared/evaluation-answers";
import { z } from "zod";
import {
  PointSchema,
  SheetLineSchema,
  POINT_TEXT_MAX,
  type Point,
  type SheetLine,
} from "@gaffer/domain";
import type { GameEvaluator, JsonObjectSchema, ScoreQuestion } from "@gaffer/llm";
import { interpretInstructions } from "./instruction-compiler";
import type { InstructionRequest } from "./instruction-contract";
import type { OpsOrders } from "./orders-ops";
import { toToolSchema } from "../shared/tool-schema";
import { POINTS_MAX } from "@gaffer/engine";

/** At most three effect rows per source point. */
export const SHEET_LINES_PER_POINT = 3;
export const SHEET_MAX = POINTS_MAX * SHEET_LINES_PER_POINT;

const PLAN_COMMAND = "set_match_plan";
const CandidateLineSchema = SheetLineSchema.omit({ pointId: true, sign: true, step: true });
const PlanSchema = z.object({
  mode: z
    .enum(["replace", "clear", "keep"])
    .describe(
      "replace submits the full set of effects reflecting the manager's instruction while keeping unrelated existing effects in active_effects. Replace all existing effects only when a full replacement is explicitly asked for. clear is an explicit full removal, keep keeps the existing effects",
    ),
  sheet: z
    .array(CandidateLineSchema)
    .max(SHEET_MAX)
    .describe(
      "For replace: the requested changes and costs plus every existing effect to keep. Keep the active_effects not asked to change. Empty array for clear/keep. behavior is an individual instruction, edge execution quality, focus attacking direction, temper roughness, legs stamina spend, cohesion holding shape. behavior/edge/temper/legs take target.player, focus takes target.side and lane, cohesion takes target.side. behavior needs action and when; mark needs targetPlayer. The direction and strength of numeric effects are rated separately. Reflect the opportunity cost of a gain.",
    ),
});

export interface MatchInstructionRequest extends Omit<InstructionRequest, "evaluator"> {
  evaluator: GameEvaluator;
  /** The caller owns stable IDs and supplies only the recent ten-minute match context. */
  pointId: string;
}

type MatchInstructionResult = OpsOrders & {
  /** Absent means preserve the current plan; empty points/sheet means explicitly clear it. */
  reading?: { points: Point[]; sheet: SheetLine[] };
};

function unresolved(): MatchInstructionResult {
  return { ops: {}, unresolved: "경기 지시의 대상·효과·강도를 확인해야 합니다" };
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
          "Applies the manager's in-match tactical instructions: man-marking, cover, runs into space, attacking an opponent's weakness, focusing the attack left/right/centre (focus). Decide the effects and their costs together from the observed facts of the last 10 minutes and the current players' ability, position and stamina. Substitutions, positions, roles and changes to the six team-tactic axes are handled by their own commands.",
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
      instructions: `Direction and continuous strength of tactical effect ${index}. Judge from the tactic the manager asked for, the observed facts of the last 10 minutes, and the players' ability, position and stamina. Do not change the target or shape. Positive means more execution quality for edge, more preference for that direction for focus, more fouls for temper, more stamina spend for legs, more shape-holding for cohesion; negative is the reverse. Rate the gain and the opportunity cost separately, and do not use classification confidence as strength.`,
      criteria: [
        "-3: strong decrease",
        "-2: moderate decrease",
        "-1: slight decrease",
        "0: no effect",
        "+1: slight increase",
        "+2: moderate increase",
        "+3: strong increase",
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
    const answer =
      candidate.shape === "behavior"
        ? undefined
        : validatedAnswer(questions[`line_${index}`]!, answers[`line_${index}`]);
    const signed =
      candidate.shape === "behavior" ? 1 : answer?.type === "score" ? answer.score - 3 : undefined;
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
