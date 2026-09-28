import type { TurnUsage } from "./game-llm";

/** Typed evaluation has no prose, history or executable tools. */
export interface ScoreQuestion {
  type: "score";
  instructions: string;
  criteria: string[];
}

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string | null>;
}

export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true?: string; false?: string };
}

export type EvaluationQuestion = ScoreQuestion | ChoiceQuestion | NoulQuestion;

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface NoulAnswer {
  type: "noul";
  noul: number;
}

export type EvaluationAnswer = ScoreAnswer | ChoiceAnswer | NoulAnswer;

export interface EvaluationRequest {
  state: string;
  questions: Record<string, EvaluationQuestion>;
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
  answers: Record<string, EvaluationAnswer>;
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
