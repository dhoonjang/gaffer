import { Auth } from "./auth";
import type { Config } from "./config";
import type { Jobs, Job } from "./jobs";
import { randomUUID } from "node:crypto";
// Only request/response bodies enter this sink; HTTP headers and query credentials never do.
function redact(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/(?:Bearer\s+|sk-|AIza)[A-Za-z0-9_./+=-]{16,}/g, "[credential]");
}
export async function capture(c: Config, jobs: Jobs, job: Job, value: unknown): Promise<void> {
  try {
    const [consent] = await jobs.db.query(
      "SELECT id FROM private.games WHERE id=$1 AND owner_id=$2 AND diagnostics_consent AND deleted_at IS NULL",
      [job.game_id, job.owner_id],
    );
    if (!consent) return;
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > 524288) return;
    const [count] = await jobs.db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM private.diagnostics WHERE owner_id=$1 AND created_at>now()-interval '1 day'",
      [job.owner_id],
    );
    if (Number(count?.n) >= 20) return;
    const cipher = new Auth(c, jobs.db).encrypt({ body: redact(text) });
    const object = await jobs.object(job.game_id, "diagnostic", { cipher });
    await jobs.db.query(
      `INSERT INTO private.diagnostics(id,owner_id,game_id,job_id,object_key)
      SELECT $1,$2,$3,$4,$5 WHERE EXISTS(SELECT 1 FROM private.games WHERE id=$3 AND diagnostics_consent AND deleted_at IS NULL)`,
      [randomUUID(), job.owner_id, job.game_id, job.id, object.key],
    );
  } catch {
    console.warn(JSON.stringify({ event: "trace_incomplete", jobId: job.id }));
  }
}
