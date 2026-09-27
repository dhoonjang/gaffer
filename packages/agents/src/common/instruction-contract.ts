import type { GameEvaluator, JsonObjectSchema } from "@story-fm/llm";
import type { OpsOrders } from "./orders-ops";

/** Domain-owned commands; the evaluator never receives executable tools. */
export interface InstructionCommand {
  name: string;
  description: string;
  inputSchema: JsonObjectSchema;
  limit: number;
}

export interface InstructionCandidate {
  label: string;
  value: string | number | boolean | null;
}

export interface InstructionRequest {
  said: string;
  context: string;
  commands: readonly InstructionCommand[];
  /** Candidate pools keyed by schema property name, supplied by the owning workflow. */
  candidates: Readonly<Record<string, readonly InstructionCandidate[]>>;
  evaluator: GameEvaluator;
}

/** Interpretation does not execute commands or write game state. */
export type InstructionResult = OpsOrders;
