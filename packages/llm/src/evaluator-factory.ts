import { LLM_CONFIG, type EvaluatorName } from "./config";
import type { GameEvaluator } from "./game-evaluator";
import { TypesafeEvaluationError, TypesafeGameEvaluator } from "./typesafe-adapter";
import { tapEvaluator } from "./turn-trace";
import { assertAgentBudget, recordEvaluationUsage } from "./usage-meter";

export function createGameEvaluator(name: EvaluatorName): GameEvaluator {
  const config = LLM_CONFIG.evaluators[name];
  if (!config) throw new Error(`Jev evaluator configuration is missing: ${name}`);
  const client = new TypesafeGameEvaluator(config);
  const evaluator = tapEvaluator(
    {
      async evaluate(request) {
        try {
          const result = await client.evaluate(request);
          recordEvaluationUsage(name, result.usage);
          return result;
        } catch (error) {
          if (error instanceof TypesafeEvaluationError) recordEvaluationUsage(name, error.usage);
          throw error;
        }
      },
    },
    name,
  );
  return {
    async evaluate(request) {
      assertAgentBudget(name);
      return evaluator.evaluate(request);
    },
  };
}
