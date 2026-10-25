import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { simBuildId } from "../../../scripts/sim-build";
const directory = resolve(process.env.SIM_DIR ?? "/tmp/gaffer-cli");
mkdirSync(directory, { recursive: true });
const clientFile = resolve(directory, "client-id");
const client = existsSync(clientFile) ? readFileSync(clientFile, "utf8") : randomUUID();
writeFileSync(clientFile, client);
export async function serviceFetch(
  input: string,
  init: RequestInit = {},
  onEvent?: (value: unknown) => void,
): Promise<Response> {
  const url = new URL(input);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    throw new Error("Simulation helpers only access local servers");
  if ((init.method ?? "GET") === "GET") return fetch(url, init);
  const body = typeof init.body === "string" ? init.body : "{}";
  const fingerprint = createHash("sha256")
    .update(url.href + "\n" + body)
    .digest("hex");
  const receipt = resolve(directory, `request-${fingerprint}.json`);
  const entry = existsSync(receipt)
    ? (JSON.parse(readFileSync(receipt, "utf8")) as { key: string })
    : { key: randomUUID() };
  writeFileSync(receipt, JSON.stringify(entry));
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Idempotency-Key", entry.key);
  const game = url.pathname.match(/^\/api\/games\/([^/]+)\/match\//)?.[1];
  if (game) {
    const control = await fetch(new URL(`/api/games/${game}/control`, url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: client }),
    });
    if (control.ok) {
      const result = (await control.json()) as { epoch: number };
      headers.set("X-Gaffer-Client", client);
      headers.set("X-Gaffer-Epoch", String(result.epoch));
      headers.set("X-Gaffer-Build", simBuildId());
    } else if (control.status !== 404) return control;
  }
  let response = await fetch(url, { ...init, headers, body });
  if (response.status === 202) {
    const { jobId } = (await response.json()) as { jobId: string };
    let seq = 0;
    for (;;) {
      response = await fetch(new URL(`/api/jobs/${jobId}?after=${seq}`, url));
      if (!response.ok) break;
      const result = (await response.json()) as {
        status: string;
        events: { seq: number; body: unknown }[];
        result: { status: number; body: unknown } | null;
        error: string | null;
      };
      for (const event of result.events) {
        seq = event.seq;
        onEvent?.(event.body);
      }
      if (result.result) {
        response = Response.json(result.result.body, { status: result.result.status });
        break;
      }
      if (!["queued", "running"].includes(result.status)) {
        response = Response.json(
          { error: result.error ?? "Operation finished without a result. Reload the game." },
          { status: 409 },
        );
        break;
      }
      await pause(1200);
    }
  }
  if (response.status < 500) unlinkSync(receipt);
  return response;
}
