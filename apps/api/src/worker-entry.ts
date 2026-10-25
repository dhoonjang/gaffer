import { llmErrorKind, LlmCallError, type LlmErrorKind } from "@gaffer/llm";
import { parentPort, workerData } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { withHttpMeter, meteredFetch, type HttpAttempt, type HttpUsage } from "@gaffer/llm";
import { execute, type Command } from "./game/execute";
const port = parentPort!;
const pending = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();
port.on(
  "message",
  (message: { type: string; id: string; value?: unknown; error?: string; kind?: LlmErrorKind }) => {
    if (message.type !== "rpc_result") return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new LlmCallError(message.kind ?? "unknown", message.error));
    else waiter.resolve(message.value);
  },
);
function rpc(type: string, value: unknown): Promise<unknown> {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    port.postMessage({ type, id, value });
  });
}
// Google's SDK uses the global Fetch API; the other adapters inject the same wrapper.
globalThis.fetch = meteredFetch;
if (process.env.GAFFER_MODE === "production") {
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    const original = console[method].bind(console);
    console[method] = () => original(JSON.stringify({ event: "game_diagnostic", level: method }));
  }
}
const command = workerData as Command;
try {
  const result = await withHttpMeter(
    {
      ...(command.diagnostics
        ? {
            capture: async (id: string, request: string, response: string) => {
              await rpc("capture", { id, request, response });
            },
          }
        : {}),
      reserve: async (attempt: HttpAttempt) => String(await rpc("reserve", attempt)),
      settle: async (id: string, usage: HttpUsage | null) => {
        await rpc("settle", { id, usage });
      },
    },
    () => execute(command, (text) => port.postMessage({ type: "delta", text })),
  );
  port.postMessage({ type: "done", result });
} catch (error) {
  port.postMessage({
    type: "error",
    error: error instanceof Error ? error.name : "Error",
    kind: llmErrorKind(error),
  });
}
port.close();
