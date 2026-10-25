import { AsyncLocalStorage } from "node:async_hooks";
import * as files from "@gaffer/engine";
import type { GameState } from "@gaffer/engine";
export interface Execution {
  id: string;
  state: GameState | null;
  saved: GameState | null;
  deferred: (() => void | Promise<void>)[];
}
const storage = new AsyncLocalStorage<Execution>();
export const execution = () => storage.getStore();
export const withExecution = <T>(value: Execution, fn: () => T): T => storage.run(value, fn);
function current(id: string): Execution | undefined {
  const ctx = execution();
  if (ctx && id !== ctx.id) throw new Error("Cross-game persistence access");
  if (!ctx && process.env.GAFFER_MODE === "production")
    throw new Error("Missing execution context");
  return ctx;
}
export function loadGame(id: string): GameState | null {
  const ctx = current(id);
  return ctx ? (ctx.saved ?? ctx.state) : files.loadGame(id);
}
export function saveGame(state: GameState): void {
  const ctx = current(state.id);
  if (ctx) {
    ctx.saved = structuredClone(state);
    ctx.state = ctx.saved;
  } else files.saveGame(state);
}
export function deleteGame(id: string): boolean {
  if (current(id)) throw new Error("Deletion must use the service transaction");
  return files.deleteGame(id);
}
export const NextResponse = Response;
export type NextResponse = Response;
export function after(fn: () => void | Promise<void>): void {
  const ctx = execution();
  if (ctx) ctx.deferred.push(fn);
}
