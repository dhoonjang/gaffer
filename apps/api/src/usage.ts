import { setTimeout as pause } from "node:timers/promises";
import { gameVersion, LLM_CONFIG, LlmCallError } from "@gaffer/llm";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { HttpAttempt, HttpUsage } from "@gaffer/llm";
import type { Config } from "./config";
import type { Database } from "./database";
import type { Job } from "./jobs";
const Prices = z.object({
  version: z.string().min(1),
  models: z.record(
    z.object({
      inputMicrosPerToken: z.number().positive(),
      outputMicrosPerToken: z.number().nonnegative(),
      rpm: z.number().int().positive(),
      tpm: z.number().int().positive(),
      concurrency: z.number().int().positive(),
    }),
  ),
});
export class Usage {
  private prices: z.infer<typeof Prices> | null = null;
  constructor(
    readonly c: Config,
    readonly db: Database,
  ) {}
  async init(): Promise<void> {
    if (this.c.LLM_PRICES_JSON) this.prices = Prices.parse(JSON.parse(this.c.LLM_PRICES_JSON));
    else if (this.c.LLM_PRICES_FILE)
      this.prices = Prices.parse(JSON.parse(await readFile(this.c.LLM_PRICES_FILE, "utf8")));
  }
  validateConfiguredModels(): void {
    for (const agent of [
      ...Object.values(LLM_CONFIG.agents),
      ...Object.values(LLM_CONFIG.evaluators),
    ]) {
      if (!this.prices?.models[`${agent.provider}/${agent.model}`])
        throw new Error("Missing configured model price");
    }
  }
  async reserve(job: Job, attempt: HttpAttempt): Promise<string> {
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        return await this.reserveOnce(job, attempt);
      } catch (error) {
        if (
          !(error instanceof LlmCallError) ||
          error.kind !== "rate_limit" ||
          job.path === "/internal/lorebook" ||
          Date.now() >= deadline
        )
          throw error;
        await pause(1000);
      }
    }
  }
  private async reserveOnce(job: Job, attempt: HttpAttempt): Promise<string> {
    if (!this.prices)
      throw new LlmCallError("invalid_request", "LLM price registry is required for paid calls");
    const price = this.prices.models[`${attempt.provider}/${attempt.model}`];
    if (!price) throw new LlmCallError("invalid_request", "Missing model price");
    const cost = Math.ceil(
      attempt.inputBound * price.inputMicrosPerToken +
        attempt.outputBound * price.outputMicrosPerToken,
    );
    const id = randomUUID();
    await this.db.transaction(async (sql) => {
      await sql.query(
        "INSERT INTO private.operations(key,value) VALUES('budget','{}') ON CONFLICT DO NOTHING",
      );
      await sql.query("SELECT key FROM private.operations WHERE key='budget' FOR UPDATE");
      const [live] = await sql.query(
        "SELECT id FROM private.jobs WHERE id=$1 AND attempt=$2 AND status='running' AND lease_until>now() AND deadline>now()",
        [job.id, job.attempt],
      );
      if (!live) throw new Error("Job no longer owns its lease");
      await sql.query(
        "UPDATE private.usage u SET status='unknown',finished_at=now() FROM private.jobs j WHERE j.id=u.job_id AND u.status='reserved' AND (j.status<>'running' OR j.attempt<>u.job_attempt OR j.lease_until<=now())",
      );
      const [sum] = await sql.query<{ global: string; personal: string }>(
        `SELECT coalesce(sum(coalesce(actual_micros,reserved_micros)),0)::text AS global,coalesce(sum(CASE WHEN owner_id=$1 THEN coalesce(actual_micros,reserved_micros) ELSE 0 END),0)::text AS personal FROM private.usage WHERE created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
        [job.owner_id],
      );
      if (
        Number(sum?.global) + cost > this.c.GLOBAL_DAILY_BUDGET_MICROS ||
        Number(sum?.personal) + cost > this.c.USER_DAILY_BUDGET_MICROS
      )
        throw new LlmCallError("budget", "Daily LLM budget exhausted");
      if (
        job.path === "/internal/lorebook" &&
        (
          await sql.query(
            "SELECT id FROM private.jobs WHERE owner_id=$1 AND path<>'/internal/lorebook' AND status IN ('queued','running') LIMIT 1",
            [job.owner_id],
          )
        ).length
      )
        throw new LlmCallError("rate_limit", "Foreground work has priority");
      const [personal] = await sql.query(
        "SELECT u.id FROM private.usage u JOIN private.jobs j ON j.id=u.job_id WHERE u.owner_id=$1 AND u.status='reserved' AND ($2 OR j.path<>'/internal/lorebook') LIMIT 1",
        [job.owner_id, job.path === "/internal/lorebook"],
      );
      if (personal) throw new LlmCallError("rate_limit", "One paid request per user");
      const [rate] = await sql.query<{ requests: string; active: string; tokens: string }>(
        `SELECT count(*) FILTER(WHERE created_at>now()-interval '1 minute')::text AS requests,coalesce(sum(token_bound) FILTER(WHERE created_at>now()-interval '1 minute'),0)::text AS tokens,count(*) FILTER(WHERE status='reserved')::text AS active FROM private.usage WHERE provider=$1 AND model=$2`,
        [attempt.provider, attempt.model],
      );
      if (
        Number(rate?.requests) >= price.rpm ||
        Number(rate?.active) >= price.concurrency ||
        Number(rate?.tokens) + attempt.inputBound + attempt.outputBound > price.tpm
      )
        throw new LlmCallError("rate_limit", "Provider capacity exhausted");
      await sql.query(
        "INSERT INTO private.usage(id,owner_id,job_id,provider,model,price_version,reserved_micros,input_tokens,output_tokens,token_bound,job_attempt,agent,call_id,game_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
        [
          id,
          job.owner_id,
          job.id,
          attempt.provider,
          attempt.model,
          this.prices!.version,
          cost,
          attempt.inputBound,
          attempt.outputBound,
          attempt.inputBound + attempt.outputBound,
          job.attempt,
          attempt.agent ?? "unknown",
          attempt.callId ?? null,
          gameVersion(),
        ],
      );
    });
    return id;
  }
  async settle(id: string, usage: HttpUsage | null): Promise<void> {
    const [row] = await this.db.query<{ provider: string; model: string }>(
      "SELECT provider,model FROM private.usage WHERE id=$1",
      [id],
    );
    if (!row) return;
    const price = this.prices?.models[`${row.provider}/${row.model}`];
    if (!usage || !price) {
      await this.db.query(
        "UPDATE private.usage SET status='unknown',finished_at=now() WHERE id=$1 AND status='reserved'",
        [id],
      );
      return;
    }
    const cost = Math.ceil(
      usage.inputTokens * price.inputMicrosPerToken +
        usage.outputTokens * price.outputMicrosPerToken,
    );
    await this.db.query(
      "UPDATE private.usage SET status='settled',actual_micros=$2,input_tokens=$3::bigint,output_tokens=$4::bigint,token_bound=$3::bigint+$4::bigint,finished_at=now() WHERE id=$1 AND status='reserved'",
      [id, cost, usage.inputTokens, usage.outputTokens],
    );
  }
}
