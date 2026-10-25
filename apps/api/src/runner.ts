import { capture } from "./diagnostics";
import { configuration, HttpError } from "./config";
import { LlmCallError, llmErrorKind, type LlmErrorKind } from "@gaffer/llm";
import { setTimeout as pause } from "node:timers/promises";
import { decode } from "./objects";
import type { Game } from "./jobs";
import { Worker } from "node:worker_threads";
import { catalogCacheKey } from "@gaffer/engine";
import type { HttpAttempt, HttpUsage } from "@gaffer/llm";
import type { Jobs, Job } from "./jobs";
import type { Usage } from "./usage";
import type { Command, Executed } from "./game/execute";

/**
 * How long a read waits in line for a Worker before it answers 503. A read Worker
 * finishes in about a second, so a full line drains well inside this.
 */
export const READ_WAIT_MS = 15_000;
/** How long a finished Worker stays warm for the next command before it is let go. */
export const WARM_IDLE_MS = 5 * 60_000;

/** An execution Worker and the catalog generation its module graph loaded. */
interface Executor {
  worker: Worker;
  catalog: string;
}

interface WorkerMessage {
  type: string;
  id: string;
  value: unknown;
  text: string;
  result: Executed;
  error: string;
  kind?: LlmErrorKind;
}

export class Runner {
  private active = 0;
  /**
   * Finished Workers kept for the next command — starting one loads the whole engine and
   * catalog, which costs more than most commands. One runs a single command at a time.
   */
  private readonly warm: { executor: Executor; idle: ReturnType<typeof setTimeout> }[] = [];
  /** Reads have their own Worker slots: a long turn must not turn a player card into a 503. */
  private reading = 0;
  private readonly readers: (() => void)[] = [];
  constructor(
    readonly jobs: Jobs,
    readonly usage: Usage,
    readonly capacity = 2,
    readonly readCapacity = 2,
    readonly readWaitMs = READ_WAIT_MS,
  ) {}
  available(): boolean {
    return this.active < this.capacity;
  }
  /** Job slots not taken right now. */
  free(): number {
    return Math.max(0, this.capacity - this.active);
  }
  private async readSlot(): Promise<void> {
    if (this.reading < this.readCapacity) {
      this.reading++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const grant = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const at = this.readers.indexOf(grant);
        if (at >= 0) this.readers.splice(at, 1);
        reject(new HttpError(503, "Busy"));
      }, this.readWaitMs);
      this.readers.push(grant);
    });
  }
  /** A released slot passes straight to the oldest waiting read. */
  private releaseRead(): void {
    const next = this.readers.shift();
    if (next) next();
    else this.reading--;
  }
  /** A warm Worker on the current catalog, or a new one. */
  private acquire(): Executor {
    const catalog = catalogCacheKey();
    for (let entry = this.warm.pop(); entry; entry = this.warm.pop()) {
      clearTimeout(entry.idle);
      if (entry.executor.catalog === catalog) {
        entry.executor.worker.ref();
        return entry.executor;
      }
      void entry.executor.worker.terminate();
    }
    const worker = new Worker(new URL("./worker-bootstrap.mjs", import.meta.url));
    // A warm Worker that dies while idle simply leaves the pool.
    worker.on("exit", () => {
      const at = this.warm.findIndex((entry) => entry.executor.worker === worker);
      if (at >= 0) this.warm.splice(at, 1);
    });
    return { worker, catalog };
  }
  /**
   * Keeps a Worker that finished its command cleanly. One still running (deadline, lost
   * lease) or on an older catalog is stopped instead.
   */
  private release(executor: Executor, reusable: boolean): Promise<void> | void {
    if (
      !reusable ||
      executor.catalog !== catalogCacheKey() ||
      this.warm.length >= this.capacity + this.readCapacity
    )
      return executor.worker.terminate().then(() => undefined);
    executor.worker.unref();
    const idle = setTimeout(() => {
      const at = this.warm.findIndex((entry) => entry.executor === executor);
      if (at >= 0) this.warm.splice(at, 1);
      void executor.worker.terminate();
    }, WARM_IDLE_MS);
    idle.unref();
    this.warm.push({ executor, idle });
  }
  async run(command: Command, job?: Job, reserved = false): Promise<Executed> {
    if (!reserved && !this.available()) throw new Error("Runner capacity exhausted");
    if (!reserved) this.active++;
    let executor: Executor;
    let diagnostics: boolean;
    try {
      diagnostics = job
        ? Boolean((await this.jobs.game(job.owner_id, job.game_id)).diagnostics_consent)
        : false;
      executor = this.acquire();
    } catch (error) {
      if (!reserved) this.active--;
      throw error;
    }
    const { worker } = executor;
    let reusable = false;
    let lastHeartbeat = Date.now();
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let batch: ReturnType<typeof setInterval> | undefined;
    let delta = "";
    let events = Promise.resolve();
    let eventError: unknown;
    const flush = () => {
      if (!job || !delta) return;
      const text = delta.slice(0, 3000);
      delta = delta.slice(3000);
      events = events.then(() =>
        this.jobs.db
          .transaction((sql) => this.jobs.event(sql, job, { type: "delta", text }))
          .catch((error: unknown) => {
            eventError = error;
          }),
      );
    };
    let onMessage: (m: WorkerMessage) => void = () => undefined;
    let onError: (e: unknown) => void = () => undefined;
    let onExit: () => void = () => undefined;
    try {
      return await new Promise<Executed>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Execution deadline exceeded")),
          command.path.endsWith("/match/live") ? 45_000 : 600_000,
        );
        const finish = (error: Error | null, result?: Executed) => {
          clearTimeout(timeout);
          if (error) reject(error);
          else if (result) resolve(result);
        };
        onMessage = (m: WorkerMessage) => {
          if (m.type === "delta") {
            delta += m.text;
            return;
          }
          if (m.type === "done") {
            reusable = true;
            while (delta) flush();
            void events
              .then(() => finish(eventError ? new Error("Event write failed") : null, m.result))
              .catch((e: unknown) =>
                finish(e instanceof Error ? e : new Error("Event write failed")),
              );
            return;
          }
          if (m.type === "error") {
            reusable = true;
            finish(new LlmCallError(m.kind ?? "unknown", m.error));
            return;
          }
          if (m.type === "reserve" || m.type === "settle" || m.type === "capture") {
            const work = async () => {
              if (!job) throw new Error("Read requests cannot call an LLM");
              if (m.type === "capture") {
                await capture(configuration(), this.jobs, job, m.value);
                return null;
              }
              if (m.type === "reserve") return this.usage.reserve(job, m.value as HttpAttempt);
              const v = m.value as { id: string; usage: HttpUsage | null };
              await this.usage.settle(v.id, v.usage);
              return null;
            };
            void work()
              .then((value) => worker.postMessage({ type: "rpc_result", id: m.id, value }))
              .catch((error: unknown) =>
                worker.postMessage({
                  type: "rpc_result",
                  id: m.id,
                  error: "LLM admission denied",
                  kind: llmErrorKind(error),
                }),
              );
          }
        };
        onError = (e: unknown) => finish(e instanceof Error ? e : new Error("Worker failed"));
        onExit = () => finish(new Error("Execution worker stopped"));
        if (job)
          heartbeat = setInterval(() => {
            void this.jobs
              .heartbeat(job)
              .then((ok) => {
                if (!ok) finish(new Error("Lease lost"));
                else lastHeartbeat = Date.now();
              })
              .catch(() => {
                if (Date.now() - lastHeartbeat > 45000) finish(new Error("Heartbeat failed"));
              });
          }, 10_000);
        batch = setInterval(flush, 1000);
        worker.on("message", onMessage);
        worker.once("error", onError);
        worker.once("exit", onExit);
        worker.postMessage({ type: "run", command: { ...command, diagnostics } });
      });
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (batch) clearInterval(batch);
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
      await this.release(executor, reusable);
      if (!reserved) this.active--;
    }
  }
  async read(game: Game, path: string): Promise<Executed> {
    await this.readSlot();
    try {
      return await this.run(
        {
          id: game.id,
          path,
          method: "GET",
          payload: null,
          snapshot: await this.jobs.snapshot(game),
        },
        undefined,
        true,
      );
    } finally {
      this.releaseRead();
    }
  }
  private async lore(job: Job): Promise<void> {
    let patch: unknown;
    if (job.work_key) patch = decode(await this.jobs.objects.get(job.work_key));
    else {
      const game = await this.jobs.game(job.owner_id, job.game_id);
      const output = await this.run(
        {
          id: game.id,
          path: job.path,
          method: "POST",
          payload: job.payload,
          snapshot: await this.jobs.snapshot(game),
        },
        job,
        true,
      );
      if (output.result.status === 429) {
        await this.jobs.deferLore(job);
        return;
      }
      if (output.result.status >= 400) {
        await this.jobs.retryLore(job, output.result.status >= 500);
        return;
      }
      patch = output.result.body;
      const saved = await this.jobs.object(game.id, "lore-patch", patch);
      const rows = await this.jobs.db.query(
        "UPDATE private.jobs SET work_key=$3 WHERE id=$1 AND attempt=$2 AND status='running' AND lease_until>now() RETURNING id",
        [job.id, job.attempt, saved.key],
      );
      if (!rows.length) return;
    }
    for (let conflict = 0; conflict < 2; conflict++) {
      const latest = await this.jobs.game(job.owner_id, job.game_id);
      if (latest.active_job) {
        await this.jobs.deferLore(job);
        return;
      }
      const output = await this.run(
        {
          id: latest.id,
          path: "/internal/lorebook-apply",
          method: "POST",
          payload: patch,
          snapshot: await this.jobs.snapshot(latest),
        },
        undefined,
        true,
      );
      if (output.result.status === 409) {
        await this.jobs.retryLore(job, true, true);
        return;
      }
      if (
        await this.jobs.commit(
          job,
          output.result,
          output.snapshot,
          output.summary,
          output.view,
          output.loreTasks,
          latest.revision,
        )
      )
        return;
      if (!(await this.jobs.heartbeat(job))) return;
      await pause(500);
    }
    await this.jobs.deferLore(job);
  }
  async job(id: string): Promise<void> {
    if (!this.available()) return;
    this.active++;
    try {
      const job = await this.jobs.claim(id);
      if (!job) return;
      const heartbeat = setInterval(() => {
        void this.jobs.heartbeat(job).catch(() => false);
      }, 10_000);
      let phase = "load";
      try {
        if (job.path === "/internal/lorebook") {
          await this.lore(job);
          return;
        }
        const game = await this.jobs.game(job.owner_id, job.game_id);
        const snapshot = await this.jobs.snapshot(game);
        phase = "run";
        const output = await this.run(
          { id: game.id, path: job.path, method: job.method, payload: job.payload, snapshot },
          job,
          true,
        );
        phase = "commit";
        const committed = await this.jobs.commit(
          job,
          output.result,
          output.snapshot,
          output.summary,
          output.view,
          output.loreTasks,
        );
        console.info(
          JSON.stringify({ event: "job_finished", jobId: id, attempt: job.attempt, committed }),
        );
      } catch (error) {
        if (job.path === "/internal/lorebook") await this.jobs.retryLore(job, true);
        else await this.jobs.fail(job);
        console.error(
          JSON.stringify({
            event: "job_failed",
            jobId: id,
            attempt: job.attempt,
            error: error instanceof Error ? error.name : "Error",
            kind: llmErrorKind(error),
            phase,
          }),
        );
      } finally {
        clearInterval(heartbeat);
      }
    } finally {
      this.active--;
    }
  }
}
