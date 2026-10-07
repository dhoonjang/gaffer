import { PointSchema, SheetLineSchema } from "@gaffer/domain";
import {
  type EvaluationResult,
  type GameEvaluator,
  type GameLLM,
  type JsonObjectSchema,
  type ScoreQuestion,
} from "@gaffer/llm";
import { z } from "zod";
import { ModelOutputError, readOutput, retryOnce } from "../src/shared/retry";
import { toToolSchema } from "../src/shared/tool-schema";
import { matchReaderSystem, ReaderReportSchema, type MatchReaderOutput } from "./reader-baseline";

import { SHEET_MAX } from "../src/evaluators/jev-match-reader";

const SheetCandidateSchema = SheetLineSchema.omit({ step: true });
const CandidateReportSchema = ReaderReportSchema.extend({
  sheet: z.array(SheetCandidateSchema).max(SHEET_MAX),
});

export function readerRequestSchema(
  schema: JsonObjectSchema,
  probabilistic: boolean,
): JsonObjectSchema {
  const properties: Record<string, unknown> = {};
  const arrayProperty = (name: string, items: JsonObjectSchema) => {
    const existing = schema.properties?.[name];
    const description =
      existing && typeof existing === "object" && "description" in existing
        ? existing.description
        : undefined;
    return { type: "array", items, ...(typeof description === "string" ? { description } : {}) };
  };
  properties.points = arrayProperty("points", toToolSchema(PointSchema));
  properties.sheet = arrayProperty(
    "sheet",
    toToolSchema(probabilistic ? SheetCandidateSchema : SheetLineSchema),
  );
  return { ...schema, properties, required: ["points", "sheet"] };
}

/** No state transitions here: both stages must validate before the caller applies anything. */
export async function runReaderPipeline(options: {
  llm: GameLLM;
  user: string;
  schema: JsonObjectSchema;
  evaluator?: GameEvaluator | undefined;
}): Promise<{
  reading: MatchReaderOutput;
  attempts: number;
  evaluations: EvaluationResult[];
}> {
  let attempts = 0;
  const probabilistic = options.evaluator !== undefined;
  const schema = readerRequestSchema(options.schema, probabilistic);
  const report = await retryOnce("reader-baseline", async () => {
    attempts++;
    const result = await options.llm.runTurn({
      system: matchReaderSystem(probabilistic),
      history: [],
      user: options.user,
      outputSchema: schema,
    });
    if (!probabilistic) return readOutput("reader-baseline", ReaderReportSchema, result);
    const candidate = readOutput("reader-baseline", CandidateReportSchema, result);
    const pointIds = new Set(candidate.points.map((point) => point.id));
    if (
      pointIds.size !== candidate.points.length ||
      candidate.sheet.some((line) => !pointIds.has(line.pointId))
    ) {
      throw new ModelOutputError("match-sheet: duplicate or missing point reference");
    }
    return candidate;
  });
  const points = report.points;
  const evaluations: EvaluationResult[] = [];
  let sheet = report.sheet;
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
      if (answer.type !== "score") throw new ModelOutputError("match-sheet: expected score");
      return { ...line, step: answer.score };
    });
  }
  const parsed = z.array(SheetLineSchema).safeParse(sheet);
  if (!parsed.success) throw new ModelOutputError("match-sheet: invalid sheet strength");
  return { reading: { points, sheet: parsed.data }, attempts, evaluations };
}
