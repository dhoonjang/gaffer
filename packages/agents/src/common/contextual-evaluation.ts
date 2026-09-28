import type { GameEvaluator, ChoiceQuestion } from "@story-fm/llm";
import { validatedAnswer } from "./evaluation-answers";
import { ModelOutputError, retryOnce } from "./retry";

export interface ContextChoice {
  instructions: string;
  criteria: Record<string, string | null>;
}

/** Keep structured judgment and source references separate from generated prose. */
export async function evaluateChoices(
  state: string,
  choices: Record<string, ContextChoice>,
  evaluator: GameEvaluator,
): Promise<Record<string, string>> {
  const questions: Record<string, ChoiceQuestion> = Object.fromEntries(
    Object.entries(choices).map(([key, q]) => [key, { type: "choice" as const, ...q }]),
  );
  if (Object.keys(questions).length === 0) return {};
  return retryOnce("contextual-evaluation", async () => {
    const result = await evaluator.evaluate({ state, questions });
    const answers: Record<string, string> = {};
    for (const [key, question] of Object.entries(questions)) {
      const answer = validatedAnswer(question, result.answers[key]);
      if (!answer || answer.type !== "choice")
        throw new ModelOutputError(`Invalid contextual choice: ${key}`);
      answers[key] = answer.choice;
    }
    return answers;
  });
}

/** Decimal interval refinement covers the entire representable domain, not an anchor ± balance band. */
export async function evaluateNumber(
  state: string,
  instructions: string,
  range: { min: number; max: number; integer?: boolean },
  evaluator: GameEvaluator,
): Promise<number> {
  const scale = range.integer === false ? 100 : 1;
  let low = Math.ceil(range.min * scale);
  let high = Math.floor(range.max * scale);
  if (!Number.isSafeInteger(low) || !Number.isSafeInteger(high) || low > high)
    throw new Error("Invalid evaluation number range");
  while (low < high) {
    const width = Math.max(1, Math.ceil((high - low + 1) / 10));
    const bands: Record<string, [number, number]> = {};
    for (let start = low; start <= high; start += width) {
      bands[String(Object.keys(bands).length)] = [start, Math.min(high, start + width - 1)];
    }
    const result = await evaluateChoices(
      state,
      {
        value: {
          instructions: `${instructions}\nChoose the interval containing the appropriate value. This is numeric refinement, not low/medium/high balance. All values are legal representation limits, not suggested prices.`,
          criteria: Object.fromEntries(
            Object.entries(bands).map(([key, [a, b]]) => [
              key,
              a === b ? String(a / scale) : `${a / scale} to ${b / scale}`,
            ]),
          ),
        },
      },
      evaluator,
    );
    [low, high] = bands[result.value!]!;
  }
  return low / scale;
}
