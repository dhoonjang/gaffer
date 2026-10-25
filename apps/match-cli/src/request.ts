import { writeFile, appendFile } from "node:fs/promises";
import { serviceFetch } from "./service-client";
const [url, method, body, output, mode] = process.argv.slice(2);
if (!url || !method || !output) throw new Error("Expected URL METHOD BODY OUTPUT [stream]");
await writeFile(output, "");
const events: unknown[] = [];
const response = await serviceFetch(
  url,
  { method, ...(method === "GET" ? {} : { body: body ?? "{}" }) },
  (event) => events.push(event),
);
if (mode === "stream" && !response.headers.get("content-type")?.includes("ndjson")) {
  const payload: unknown = await response.json();
  events.push(response.ok ? { type: "done", payload } : { type: "error", ...(payload as object) });
  await appendFile(output, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
} else await writeFile(output, await response.text());
console.info(response.status);
