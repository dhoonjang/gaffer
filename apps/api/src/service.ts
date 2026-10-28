import { GET as catalogGet } from "../../web/app/api/games/route";
import { parseTurn } from "../../web/app/api/games/[id]/turn/stream/route";
import { toPayload } from "../../web/game/store";
import { LiveActionSchema } from "../../web/screens/match/live-match-protocol";
import { LOCK_WAIT_MS } from "../../web/game/turn-runner";
import { setTimeout as pause } from "node:timers/promises";
import { simBuildId } from "../../../scripts/sim-build";
const SIM_BUILD = simBuildId();
import { decode, encode, hash } from "./objects";
import { maintenance } from "./maintenance";
import { configuredBackup } from "./backup";
import { localTools } from "./local-tools";
import { asActor } from "./database";
import type { Identity } from "./auth";
import { loadGame, gameSummary, SAVE_VERSION } from "@gaffer/engine";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { GoogleAuth, OAuth2Client } from "google-auth-library";
import { gameVersion } from "@gaffer/llm";
import type { Config } from "./config";
import { HttpError } from "./config";
import { Auth } from "./auth";
import { Jobs, type Game } from "./jobs";
import { Dispatcher } from "./dispatch";
import { Runner } from "./runner";
import { JobFeed, jobEventStream } from "./job-stream";
import { Usage } from "./usage";
import type { Database } from "./database";
import type { ObjectStore } from "./objects";
const Id = z.string().uuid();
const Feedback = z.object({
  gameId: Id.optional(),
  jobId: Id.optional(),
  category: z.enum([
    "bug",
    "idea",
    "experience",
    "instruction",
    "story",
    "rules",
    "ui",
    "speed",
    "other",
    "helpful",
    "problem",
  ]),
  message: z.string().trim().max(4000).default(""),
  turnIndex: z.number().int().min(0).optional(),
});
const mutationPath =
  /^\/api\/games(?:\/[0-9a-f-]+\/(?:turn\/stream|lineup|match\/(?:live|close)|mail|negotiation))?$/;
/** How often `?settled=1` looks again for the running job's commit. */
const SETTLE_POLL_MS = 250;
export class Service {
  readonly auth: Auth;
  readonly jobs: Jobs;
  readonly dispatcher: Dispatcher;
  readonly runner: Runner;
  readonly usage: Usage;
  readonly feed: JobFeed;
  private catalog: unknown;
  constructor(
    readonly c: Config,
    readonly db: Database,
    objects: ObjectStore,
  ) {
    this.auth = new Auth(c, db);
    this.jobs = new Jobs(db, objects, 2);
    this.dispatcher = new Dispatcher(c, db);
    this.usage = new Usage(c, db);
    this.feed = new JobFeed(db);
    // A local process is every role at once, so it gets the job slots of the whole
    // deployed worker tier (2 instances × concurrency 2).
    this.runner = new Runner(
      this.jobs,
      this.usage,
      c.SERVICE_ROLE === "sim" ? 1 : c.GAFFER_MODE === "local" ? 4 : 2,
    );
  }
  /**
   * `?settled=1` reads after the running job commits, waiting as long as the save lock
   * once did. Past that the client is told to ask again.
   */
  private async settled(owner: string, gameId: string): Promise<Game | null> {
    const until = Date.now() + LOCK_WAIT_MS.settled;
    for (;;) {
      await pause(SETTLE_POLL_MS);
      const game = await this.jobs.game(owner, gameId);
      if (!game.active_job) return game;
      if (Date.now() >= until) return null;
    }
  }
  async internal(req: Request): Promise<void> {
    if (this.c.GAFFER_MODE === "local") return;
    const token = req.headers.get("authorization")?.replace(/^Bearer /, "");
    if (!token) throw new HttpError(401, "Unauthorized");
    const audience =
      this.c.SERVICE_ROLE === "sim"
        ? this.c.SIM_URL
        : this.c.SERVICE_ROLE === "maintenance"
          ? this.c.MAINTENANCE_URL
          : this.c.WORKER_URL;
    const ticket = await new OAuth2Client().verifyIdToken({ idToken: token, audience: audience! });
    const identity = ticket.getPayload();
    if (
      !identity?.email_verified ||
      (identity.email !== this.c.TASK_SERVICE_ACCOUNT &&
        !(this.c.SERVICE_ROLE === "sim" && identity.email === this.c.API_SERVICE_ACCOUNT))
    )
      throw new HttpError(403, "Forbidden");
  }
  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === "/health") return Response.json({ ok: true, role: this.c.SERVICE_ROLE });
    if (path.startsWith("/internal/")) {
      if (this.c.SERVICE_ROLE === "api") throw new HttpError(404, "Not found");
      await this.internal(req);
      if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
      if (path === "/internal/reconcile") {
        await this.jobs.recover();
        await this.dispatcher.dispatch();
        if (this.c.SERVICE_ROLE === "maintenance")
          await maintenance(this.c, this.db, this.jobs.objects);
        return Response.json({ ok: true });
      }
      if (path === "/internal/backup" && this.c.SERVICE_ROLE === "maintenance") {
        const key = await configuredBackup(this.c, this.db, this.jobs.objects).create();
        return Response.json({ key });
      }
      const id = path.match(/^\/internal\/jobs\/([^/]+)$/)?.[1];
      if (!id || !Id.safeParse(id).success) throw new HttpError(404, "Not found");
      if (!this.runner.available()) throw new HttpError(503, "Busy");
      await this.runner.job(id);
      try {
        await this.dispatcher.dispatch();
      } catch {
        console.warn(JSON.stringify({ event: "dispatch_deferred" }));
      }
      return Response.json({ ok: true });
    }
    if (this.c.SERVICE_ROLE !== "api") throw new HttpError(404, "Not found");
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      !this.auth.development &&
      req.headers.get("origin") !== this.c.APP_ORIGIN
    )
      throw new HttpError(403, "Invalid origin");
    if (path === "/api/auth/start" && req.method === "POST") return this.auth.start();
    if (path === "/api/auth/callback" && req.method === "GET") return this.auth.callback(req);
    if (
      (
        await this.db.query(
          "SELECT key FROM private.operations WHERE key='maintenance' AND value='true'::jsonb",
        )
      ).length
    )
      throw new HttpError(503, "점검 중입니다");
    const identity = await this.auth.identity(req);
    return asActor(identity.id, () => this.memberRequest(req, identity));
  }
  private async memberRequest(req: Request, identity: Identity): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const owner = identity.id;
    const local = await localTools(this.c, req);
    if (local) return local;
    if (path === "/api/auth/me" && req.method === "GET") {
      const fresh = this.auth.development && !this.auth.cookies(req)["gaffer_local"];
      const id = fresh ? randomUUID() : owner;
      return Response.json(
        { id, role: identity.role, local: this.auth.development, email: identity.email ?? null },
        // 로컬 계정은 브라우저에 오래 남아야 지난 테스트 게임을 다시 연다 (브라우저 상한 400일)
        {
          headers: fresh ? { "Set-Cookie": this.auth.cookie("gaffer_local", id, 400 * 86400) } : {},
        },
      );
    }
    if (path === "/api/auth/logout" && req.method === "POST") return this.auth.logout(req);
    if (path === "/api/account" && req.method === "DELETE") {
      const marker = encode({ ownerId: owner });
      try {
        await this.jobs.objects.put(`tombstones/${owner}`, marker);
      } catch (error) {
        if (hash(await this.jobs.objects.get(`tombstones/${owner}`)) !== hash(marker)) throw error;
      }
      await this.auth.deleteAccount(owner);
      return this.auth.logout(req);
    }
    if (
      this.auth.development &&
      process.env.GAFFER_TEST_FIXTURES === "1" &&
      process.env.LLM_MODE === "mock" &&
      path === "/api/dev/import" &&
      req.method === "POST"
    ) {
      const body = z.object({ id: Id }).parse(await req.json());
      const state = loadGame(body.id);
      if (!state) throw new HttpError(404, "Fixture missing");
      // recover() deletes an idle game row without a snapshot, so the row is born with
      // its save and screen view — the same pair a committed job leaves behind.
      const put = async (kind: string, value: unknown) => {
        const bytes = encode(value);
        const key = `${state.id}/${kind}/${randomUUID()}`;
        await this.jobs.objects.put(key, bytes);
        return { key, checksum: hash(bytes) };
      };
      const saved = await put("save", { ...state, saveVersion: SAVE_VERSION });
      const view = await put("view", toPayload(state));
      await this.db.transaction(async (sql) => {
        await sql.query(
          "INSERT INTO private.games(id,owner_id,snapshot_key,snapshot_hash,view_key,view_hash,summary) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [
            state.id,
            owner,
            saved.key,
            saved.checksum,
            view.key,
            view.checksum,
            JSON.stringify(gameSummary(state)),
          ],
        );
        await sql.query(
          "INSERT INTO private.objects(key,game_id,checksum,state) VALUES($1,$2,$3,'committed'),($4,$2,$5,'committed')",
          [saved.key, state.id, saved.checksum, view.key, view.checksum],
        );
      });
      return Response.json({ ok: true });
    }
    if (path === "/api/feedback" && req.method === "POST") {
      const body = Feedback.parse(await req.json());
      if (body.gameId) await this.jobs.game(owner, body.gameId);
      if (body.jobId) await this.jobs.get(owner, body.jobId);
      const feedbackId = randomUUID();
      await this.db.transaction(async (sql) => {
        await this.jobs.member(sql, owner);
        const [count] = await sql.query<{ n: string }>(
          "SELECT count(*)::text AS n FROM private.feedback WHERE owner_id=$1 AND created_at>now()-interval '1 day'",
          [owner],
        );
        if (Number(count?.n) >= 100)
          throw new HttpError(429, "피드백은 하루 100개까지 보낼 수 있습니다");
        await sql.query(
          "INSERT INTO private.feedback(id,owner_id,game_id,job_id,category,message,game_version) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [
            feedbackId,
            owner,
            body.gameId ?? null,
            body.jobId ?? null,
            body.category,
            body.message,
            gameVersion(),
          ],
        );
        await sql.query(
          "INSERT INTO private.analytics(id,owner_id,name,game_id) VALUES($1,$2,'feedback_submitted',$3)",
          [randomUUID(), owner, body.gameId ?? null],
        );
        await sql.query(
          "UPDATE private.feedback SET revision=(SELECT revision FROM private.games WHERE id=$2),release=$3,turn_index=$4 WHERE id=$1",
          [
            feedbackId,
            body.gameId ?? null,
            process.env.GAFFER_BUILD_ID ?? "local",
            body.turnIndex ?? null,
          ],
        );
      });
      return Response.json({ id: feedbackId, status: "new" });
    }
    if (path === "/api/feedback" && req.method === "GET")
      return Response.json({
        feedback: await this.db.query(
          "SELECT id,category,message,status,created_at FROM private.feedback WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 50",
          [owner],
        ),
      });
    if (path === "/api/account/privacy" && req.method === "GET")
      return Response.json(
        (
          await this.db.query("SELECT analytics_consent FROM private.members WHERE id=$1", [owner])
        )[0],
      );
    if (path === "/api/account/privacy" && req.method === "PUT") {
      const body = z.object({ analyticsConsent: z.boolean() }).parse(await req.json());
      await this.db.query("UPDATE private.members SET analytics_consent=$2 WHERE id=$1", [
        owner,
        body.analyticsConsent,
      ]);
      if (!body.analyticsConsent)
        await this.db.query(
          "UPDATE private.analytics SET delivered_at=now() WHERE owner_id=$1 AND delivered_at IS NULL",
          [owner],
        );
      return Response.json({ ok: true });
    }
    if (path === "/api/usage" && req.method === "GET") {
      const [row] = await this.db.query(
        "SELECT coalesce(sum(coalesce(actual_micros,reserved_micros)),0)::text AS spent FROM private.usage WHERE owner_id=$1 AND created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'",
        [owner],
      );
      return Response.json({
        spentMicros: Number(row?.spent),
        limitMicros: this.c.USER_DAILY_BUDGET_MICROS,
      });
    }
    const streamed = path.match(/^\/api\/jobs\/([^/]+)\/events$/)?.[1];
    if (streamed && req.method === "GET") {
      Id.parse(streamed);
      const job = await this.jobs.get(owner, streamed);
      if (job.path.startsWith("/internal/")) throw new HttpError(404, "작업을 찾을 수 없습니다");
      // 다시 붙는 EventSource는 마지막 id를 헤더로, fetch 구독은 쿼리로 보낸다
      const after = Math.max(
        ...[url.searchParams.get("after"), req.headers.get("last-event-id")].map((v) =>
          z.coerce
            .number()
            .int()
            .min(0)
            .catch(0)
            .parse(v ?? 0),
        ),
      );
      return new Response(jobEventStream(this.feed, this.db, this.jobs, owner, job.id, after), {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Accel-Buffering": "no",
        },
      });
    }
    const jobId = path.match(/^\/api\/jobs\/([^/]+)$/)?.[1];
    if (jobId && req.method === "GET") {
      Id.parse(jobId);
      const job = await this.jobs.get(owner, jobId);
      if (job.path.startsWith("/internal/")) throw new HttpError(404, "작업을 찾을 수 없습니다");
      const after = z.coerce
        .number()
        .int()
        .min(0)
        .parse(url.searchParams.get("after") ?? 0);
      const events = await this.db.query(
        "SELECT seq,attempt,body FROM private.events WHERE job_id=$1 AND seq>$2 ORDER BY seq LIMIT 100",
        [job.id, after],
      );
      return Response.json({
        id: job.id,
        gameId: job.game_id,
        status: job.status,
        attempt: job.attempt,
        revision: job.committed_revision,
        events,
        result: await this.jobs.result(job),
        error: job.error,
      });
    }
    if (path === "/api/jobs" && req.method === "GET") {
      const rows = await this.db.query(
        "SELECT id,game_id,status FROM private.jobs WHERE owner_id=$1 AND status IN ('queued','running') AND path <> '/internal/lorebook' ORDER BY created_at DESC LIMIT 10",
        [owner],
      );
      return Response.json({ jobs: rows });
    }
    if (path === "/api/games" && req.method === "GET" && url.searchParams.get("catalog") !== "1") {
      const rows = await this.db.query(
        "SELECT summary FROM private.games WHERE owner_id=$1 AND deleted_at IS NULL AND snapshot_key IS NOT NULL ORDER BY updated_at DESC LIMIT 100",
        [owner],
      );
      return Response.json({ games: rows.map((r) => r.summary) });
    }
    const gameId = path.match(/^\/api\/games\/([^/]+)/)?.[1];
    let epoch: number | undefined;
    if (gameId) {
      Id.parse(gameId);
      let game = await this.jobs.game(owner, gameId);
      if (req.method === "GET" && url.searchParams.get("settled") === "1" && game.active_job) {
        const settled = await this.settled(owner, gameId);
        if (!settled)
          return Response.json({ error: "작업이 진행 중입니다", retry: true }, { status: 409 });
        game = settled;
      }
      if (path === `/api/games/${gameId}` && req.method === "DELETE") {
        await this.jobs.remove(owner, gameId);
        return Response.json({ ok: true });
      }
      if (path.endsWith("/privacy") && req.method === "PUT") {
        const body = z.object({ diagnosticsConsent: z.boolean() }).parse(await req.json());
        await this.db.query(
          "UPDATE private.games SET diagnostics_consent=$2 WHERE id=$1 AND owner_id=$3",
          [gameId, body.diagnosticsConsent, owner],
        );
        if (!body.diagnosticsConsent)
          await this.db.query("DELETE FROM private.diagnostics WHERE game_id=$1 AND owner_id=$2", [
            gameId,
            owner,
          ]);
        return Response.json({ ok: true });
      }
      if (path.endsWith("/control") && req.method === "POST") {
        const body = z
          .object({ clientId: z.string().uuid(), takeover: z.boolean().default(false) })
          .parse(await req.json());
        const current = await this.db.transaction(async (sql) => {
          await this.jobs.member(sql, owner);
          const g = await this.jobs.game(owner, gameId, sql, true);
          if (g.client_id && g.client_id !== body.clientId && !body.takeover)
            throw new HttpError(409, "다른 창에서 경기를 진행 중입니다");
          if (g.client_id !== body.clientId) {
            if (
              g.active_job &&
              (
                await sql.query(
                  "SELECT id FROM private.jobs WHERE id=$1 AND path NOT LIKE '%/match/%'",
                  [g.active_job],
                )
              ).length
            )
              throw new HttpError(409, "현재 작업이 끝난 뒤 경기 창을 바꿔 주세요");
            await sql.query(
              "UPDATE private.jobs SET status='cancelled',lease_until=NULL WHERE game_id=$1 AND status IN ('queued','running') AND path LIKE '%/match/%'",
              [gameId],
            );
            await sql.query(
              "UPDATE private.games SET client_id=$2,client_epoch=client_epoch+1,active_job=NULL WHERE id=$1",
              [gameId, body.clientId],
            );
          }
          return this.jobs.game(owner, gameId, sql);
        });
        return Response.json({ epoch: current.client_epoch });
      }
      if (path.includes("/match/") && req.method === "POST") {
        if (
          this.c.GAFFER_MODE === "production" &&
          (req.headers.get("x-gaffer-build") !== SIM_BUILD ||
            (game.match_build !== null && game.match_build !== SIM_BUILD))
        )
          throw new HttpError(409, "경기 버전이 맞지 않습니다. 새로고침 후 다시 시도해 주세요");
        const client = req.headers.get("x-gaffer-client");
        epoch = Number(req.headers.get("x-gaffer-epoch"));
        if (!client || client !== game.client_id || epoch !== game.client_epoch)
          throw new HttpError(409, "경기 제어권을 다시 확인해 주세요");
      }
      if (
        req.method === "GET" &&
        !url.search &&
        game.view_key &&
        (path.endsWith("/mail") || path.endsWith("/negotiation"))
      ) {
        const view = decode(
          await this.jobs.objects.get(game.view_key),
          game.view_hash ?? undefined,
        ) as { views: Record<string, unknown> };
        const key = path.endsWith("/mail") ? "mail" : "negotiation";
        return Response.json(
          { [key]: view.views[key] },
          { headers: { "X-Gaffer-Revision": String(game.revision) } },
        );
      }
      if (req.method === "GET" && path === `/api/games/${gameId}` && game.view_key) {
        return Response.json(
          decode(await this.jobs.objects.get(game.view_key), game.view_hash ?? undefined),
          { headers: { "X-Gaffer-Revision": String(game.revision) } },
        );
      }
      if (req.method === "GET") {
        if (
          !/^\/api\/games\/[0-9a-f-]+(?:\/(?:mail|negotiation|match\/live|player\/[^/]+|match-report\/[^/]+))?$/.test(
            path,
          )
        )
          throw new HttpError(404, "Not found");
        const out = await this.runner.read(game, path + url.search);
        return Response.json(out.result.body, {
          status: out.result.status,
          headers: { "X-Gaffer-Revision": String(game.revision) },
        });
      }
    }
    if (path === "/api/games" && req.method === "GET") {
      this.catalog ??= (await catalogGet(req).json()) as unknown;
      return Response.json(this.catalog);
    }
    if (req.method === "POST" && mutationPath.test(path)) {
      if (
        this.c.GAFFER_MODE === "production" &&
        (path === "/api/games" || path.endsWith("/turn/stream"))
      ) {
        const [backup] = await this.db.query(
          "SELECT key FROM private.operations WHERE key='last_backup' AND updated_at>now()-interval '48 hours'",
        );
        if (!backup) throw new HttpError(503, "백업 상태 확인 중입니다");
      }
      const body: unknown = await req.json();
      // A malformed turn is answered here, with its reason, instead of taking a job slot.
      if (path.endsWith("/turn/stream")) {
        const turn = parseTurn(body);
        if (!turn.ok) return turn.response;
      }
      // A match order names itself: within one control epoch a resend after a lost reply
      // joins the same job even under a new request key, since every job gets a fresh Worker.
      const action = path.endsWith("/match/live") ? LiveActionSchema.safeParse(body) : null;
      const job = await this.jobs.submit(
        owner,
        path,
        req.method,
        body,
        action?.success && action.data.kind === "orders"
          ? `order-${epoch}-${action.data.commandId}`
          : (req.headers.get("idempotency-key") ?? ""),
        gameId,
        epoch,
      );
      if (path.endsWith("/match/live")) {
        try {
          if (this.c.GAFFER_MODE === "local") await this.runner.job(job.id);
          else {
            const client = await new GoogleAuth().getIdTokenClient(this.c.SIM_URL!);
            await client.request({
              url: `${this.c.SIM_URL!}/internal/jobs/${job.id}`,
              method: "POST",
              data: {},
              timeout: 55_000,
            });
          }
          const finished = await this.jobs.get(owner, job.id);
          const result = (await this.jobs.result(finished)) as {
            status: number;
            body: unknown;
          } | null;
          if (result) return Response.json(result.body, { status: result.status });
        } catch {
          console.warn(JSON.stringify({ event: "sim_deferred", jobId: job.id }));
        }
      }
      // Locally this process is also the worker: start now instead of on the next sweep.
      if (this.c.GAFFER_MODE === "local")
        void this.runner
          .job(job.id)
          .catch(() => console.warn(JSON.stringify({ event: "dispatch_deferred", jobId: job.id })));
      try {
        await this.dispatcher.dispatch();
      } catch {
        console.warn(JSON.stringify({ event: "dispatch_deferred", jobId: job.id }));
      }
      return Response.json(
        { jobId: job.id, gameId: job.game_id, status: job.status },
        { status: 202 },
      );
    }
    throw new HttpError(404, "Not found");
  }
}
