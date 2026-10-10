import type { GameEvaluator, JsonObjectSchema } from "@gaffer/llm";
import type { OpsOrders } from "./orders-ops";

/** Domain-owned commands; the evaluator never receives executable tools. */
export interface InstructionCommand {
  name: string;
  description: string;
  /** Short Korean name for hold reasons sent to the GM; defaults to `description`. */
  label?: string;
  inputSchema: JsonObjectSchema;
  limit: number;
  /** Tactical effect fields may be inferred from the authorized instruction and observed facts. */
  contextual?: boolean;
  /** Narrow applicable object fields using previously resolved arguments; never expands the schema. */
  refineObjectSchema?: (
    path: string,
    input: Readonly<Record<string, unknown>>,
    schema: JsonObjectSchema,
  ) => JsonObjectSchema;
  /** Resolve field applicability after discriminants; only optional fields may be omitted. */
  fieldDisposition?: (
    path: string,
    input: Readonly<Record<string, unknown>>,
  ) => "include" | "omit" | "defer";
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
