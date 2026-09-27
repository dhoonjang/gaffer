/** Public command surface; engine modules import their owning leaf module. */
export { MATCHDAY_BENCH, groupOf, tacticsOf } from "../common/core/state";
export { recallRole } from "../common/players/role-memory";

export type { CommandResult, MarketCommandResult } from "../common/commands/result";
export * from "../story/commands/talk";
export * from "./workflows/story/commands/talk";
export * from "../match/commands/lineup";
export * from "../story/commands/training";
export * from "./workflows/story/commands/training";
export * from "../negotiation/commands/scouting";
