import type { TurnUsage } from "./game-llm";

/** Typed evaluation has no prose, history or executable tools. */
export interface ScoreQuestion {
  type: "score";
  instructions: string;
  criteria: string[];
}

export interface EvaluationRequest {
  state: string;
  questions: Record<string, ScoreQuestion>;
  signal?: AbortSignal;
}

export interface ScoreAnswer {
  type: "score";
  score: number;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface EvaluationResult {
  model: string;
  answers: Record<string, ScoreAnswer>;
  usage: TurnUsage;
  attempts?: number;
  usageComplete?: boolean;
}

export interface GameEvaluator {
  evaluate(request: EvaluationRequest): Promise<EvaluationResult>;
}

export interface EvaluatorConfig {
  provider: "typesafe";
  model: string;
  timeoutMs: number;
  maxRetries: number;
  inputUsdPerMillion: number;
}
