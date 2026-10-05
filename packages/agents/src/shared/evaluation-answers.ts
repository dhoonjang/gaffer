import { z } from "zod";
import type { ChoiceAnswer, EvaluationAnswer, EvaluationQuestion } from "@gaffer/llm";

const probability = z.number().finite().min(0).max(1);
const AnswerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: probability }),
  z.object({
    type: z.literal("choice"),
    choice: z.string(),
    confidence: probability,
    probabilities: z.record(probability),
  }),
  z.object({
    type: z.literal("score"),
    score: z.number().finite(),
    confidence: probability,
    probabilities: z.record(probability),
  }),
]);

/** Validate the provider-neutral boundary, including injected evaluators. Wire rounding belongs to the adapter. */
export function validatedAnswer(
  question: EvaluationQuestion,
  raw: unknown,
): EvaluationAnswer | undefined {
  const parsed = AnswerSchema.safeParse(raw);
  if (!parsed.success || parsed.data.type !== question.type) return undefined;
  const answer = parsed.data;
  if (question.type === "noul" || answer.type === "noul") return answer;
  const keys =
    question.type === "score"
      ? question.criteria.map((_, index) => String(index))
      : Object.keys(question.criteria);
  const probabilities = answer.probabilities;
  if (
    Object.keys(probabilities).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(probabilities, key)) ||
    Math.abs(keys.reduce((sum, key) => sum + probabilities[key]!, 0) - 1) > 1e-6
  )
    return undefined;
  if (answer.type === "choice") {
    if (
      !keys.includes(answer.choice) ||
      probabilities[answer.choice] !== Math.max(...Object.values(probabilities))
    )
      return undefined;
  } else {
    const expected = keys.reduce((sum, key) => sum + Number(key) * probabilities[key]!, 0);
    if (
      answer.score < 0 ||
      answer.score > keys.length - 1 ||
      Math.abs(expected - answer.score) > 1e-6
    )
      return undefined;
  }
  return answer;
}

/** A plurality does not authorize a discrete change; this is abstention, not calibrated accuracy. */
export function majorityChoice(answer: ChoiceAnswer): string | undefined {
  return answer.probabilities[answer.choice]! > 0.5 ? answer.choice : undefined;
}
