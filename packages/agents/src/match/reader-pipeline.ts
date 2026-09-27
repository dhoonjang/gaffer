import { PointSchema, SheetLineSchema } from "@story-fm/domain";
import {
  type EvaluationResult,
  type GameEvaluator,
  type GameLLM,
  type JsonObjectSchema,
  type ScoreQuestion,
} from "@story-fm/llm";
import { z } from "zod";
import { parseOrdersReport, UnresolvedSchema } from "../common/orders-ops";
import { ModelOutputError, readOutput, retryOnce } from "../common/retry";
import { toToolSchema } from "../common/tool-schema";
import {
  MATCH_OPS,
  matchReaderSystem,
  ReaderReportSchema,
  SHEET_MAX,
  type MatchReaderOutput,
} from "./match-reader";
import { TACTIC_CAPS } from "./tactic-orders";

const SheetCandidateSchema = SheetLineSchema.omit({ step: true });
const CandidateReportSchema = z.object({
  points: z.array(PointSchema),
  sheet: z.array(SheetCandidateSchema).max(SHEET_MAX),
  ops: z.record(z.unknown()).optional(),
  unresolved: UnresolvedSchema.optional(),
});

export function readerRequestSchema(
  schema: JsonObjectSchema,
  options: { hasSaid: boolean; probabilistic: boolean },
): JsonObjectSchema {
  const properties: Record<string, unknown> = { ...schema.properties };
  const arrayProperty = (name: string, items: JsonObjectSchema) => {
    const existing = properties[name];
    const description =
      existing && typeof existing === "object" && "description" in existing
        ? existing.description
        : undefined;
    return { type: "array", items, ...(typeof description === "string" ? { description } : {}) };
  };
  properties.points = arrayProperty("points", toToolSchema(PointSchema));
  properties.sheet = arrayProperty(
    "sheet",
    toToolSchema(options.probabilistic ? SheetCandidateSchema : SheetLineSchema),
  );
  if (!options.hasSaid) {
    delete properties.ops;
    delete properties.unresolved;
  }
  const required = (schema.required ?? []).filter((key) => key in properties);
  if (options.probabilistic) required.push("points", "sheet");
  return { ...schema, properties, required: [...new Set(required)] };
}

/** No state transitions here: both stages must validate before the caller applies anything. */
export async function runReaderPipeline(options: {
  llm: GameLLM;
  user: string;
  schema: JsonObjectSchema;
  hasSaid: boolean;
  evaluator?: GameEvaluator;
  onAttempt?: () => void;
}): Promise<{
  reading: MatchReaderOutput;
  attempts: number;
  evaluations: EvaluationResult[];
}> {
  let attempts = 0;
  const probabilistic = options.evaluator !== undefined;
  const schema = readerRequestSchema(options.schema, { hasSaid: options.hasSaid, probabilistic });
  const report = await retryOnce("match-reader", async () => {
    attempts++;
    options.onAttempt?.();
    const result = await options.llm.runTurn({
      system: matchReaderSystem(probabilistic),
      history: [],
      user: options.user,
      outputSchema: schema,
    });
    if (!probabilistic) return readOutput("match-reader", ReaderReportSchema, result);
    const candidate = readOutput("match-reader", CandidateReportSchema, result);
    const pointIds = new Set(candidate.points.map((point) => point.id));
    if (
      pointIds.size !== candidate.points.length ||
      candidate.sheet.some((line) => !pointIds.has(line.pointId))
    ) {
      throw new ModelOutputError("match-sheet: duplicate or missing point reference");
    }
    return candidate;
  });
  const orders = options.hasSaid ? parseOrdersReport(report, MATCH_OPS, TACTIC_CAPS) : { ops: {} };
  const points = report.points ?? [];
  const evaluations: EvaluationResult[] = [];
  let sheet = report.sheet ?? [];
  if (options.evaluator && sheet.length > 0) {
    const questions: Record<string, ScoreQuestion> = {};
    sheet.forEach((line, index) => {
      questions[`line_${index}`] = {
        type: "score",
        instructions: `시트 후보 ${index}의 대상·방향·동작이 포인트와 경기 사실에서 얼마나 강하게 뒷받침되는가? 이득과 대가를 함께 읽고, 후보를 바꾸지 말고 이 줄의 영향 강도를 평가하라.`,
        criteria: ["0: 근거 없거나 효과 없음", "1: 약한 영향", "2: 중간 영향", "3: 강한 영향"],
      };
    });
    const evaluation = await options.evaluator.evaluate({
      state: JSON.stringify({ facts: options.user, points, candidates: sheet }),
      questions,
    });
    evaluations.push(evaluation);
    if (
      Object.keys(evaluation.answers).length !== sheet.length ||
      Object.keys(questions).some((key) => !(key in evaluation.answers))
    ) {
      throw new ModelOutputError("match-sheet: missing or extra answer");
    }
    sheet = sheet.map((line, index) => {
      const answer = evaluation.answers[`line_${index}`]!;
      return { ...line, step: answer.score };
    });
  }
  const parsed = z.array(SheetLineSchema).safeParse(sheet);
  if (!parsed.success) throw new ModelOutputError("match-sheet: invalid sheet strength");
  return { reading: { ...orders, points, sheet: parsed.data }, attempts, evaluations };
}
