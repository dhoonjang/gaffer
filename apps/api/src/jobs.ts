import { simBuildId } from "../../../scripts/sim-build";
const BUILD = simBuildId();
import type { LoreTask } from "./game/lorebook";
import { randomUUID } from "node:crypto";
import type { Database, Sql } from "./database";
import { HttpError } from "./config";
import { hash, encode, decode, type ObjectStore } from "./objects";

/**
 * 세이브에서 떼어 **내용 해시 조각**으로 두는 큰 표 — 바뀌지 않았으면 다시 올리지 않는다.
 *
 * 선수·계약·로어북이 세이브의 대부분인데, 경기 체크포인트·전술판·대화 턴에서는 거의 그대로다.
 * 세이브 본문은 조각 이름만 들고(`CHUNKS`), 읽을 때 붙여 같은 GameState로 되돌린다.
 */
const CHUNKED_TABLES = ["players", "contracts", "lorebook"] as const;
const CHUNKS = "__chunks";
/** 조각 이름 `<게임>/chunk/<표>-<내용 해시>-<무작위>` — 해시가 읽을 때의 검증값이다 */
const CHUNK_KEY = /\/chunk\/([a-z]+)-([0-9a-f]{64})-[0-9a-f-]{36}$/;
/**
 * 이벤트 한 줄로 쓰는 본문의 상한 — `events.body`의 CHECK(16,384바이트)는 공백이 붙는 jsonb
 * 텍스트로 재므로 넉넉히 안쪽이다. 넘는 본문(여러 명을 견주는 자료 카드)은 같은 트랜잭션에
 * `part` 줄로 잇달아 쓰고 브라우저가 이어 붙인다 (web `shared/api.ts` `followJob`).
 */
const EVENT_BYTES = 10_000;
/** `part` 한 줄이 싣는 글자 수 — 한글 3바이트 · 이스케이프된 따옴표 2바이트라도 한도 안이다 */
const EVENT_PART_CHARS = 3_000;

export interface Game extends Record<string, unknown> {
  id: string;
  owner_id: string;
  revision: number;
  snapshot_key: string | null;
  snapshot_hash: string | null;
  match_build: string | null;
  view_key: string | null;
  view_hash: string | null;
  active_job: string | null;
  client_epoch: number;
  client_id: string | null;
  summary: Record<string, unknown>;
}
export interface Job extends Record<string, unknown> {
  id: string;
  owner_id: string;
  game_id: string;
  path: string;
  method: string;
  payload: unknown;
  status: string;
  attempt: number;
  base_revision: number;
  client_epoch: number;
  result_key: string | null;
  work_key: string | null;
  error: string | null;
}
export interface Result {
  status: number;
  body: unknown;
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.entries(v)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
      .join(",")}}`;
  return JSON.stringify(v);
}
export class Jobs {
  constructor(
    readonly db: Database,
    readonly objects: ObjectStore,
    readonly maxGames = Number.POSITIVE_INFINITY,
  ) {}
  async member(sql: Sql, owner: string): Promise<void> {
    const [m] = await sql.query(
      "SELECT id FROM private.members WHERE id=$1 AND active FOR UPDATE",
      [owner],
    );
    if (!m) throw new HttpError(401, "로그인이 필요합니다");
  }
  async game(owner: string, id: string, sql: Sql = this.db, lock = false): Promise<Game> {
    const [g] = await sql.query<Game>(
      `SELECT * FROM private.games WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL ${lock ? "FOR UPDATE" : ""}`,
      [id, owner],
    );
    if (!g) throw new HttpError(404, "게임을 찾을 수 없습니다");
    return g;
  }
  async submit(
    owner: string,
    path: string,
    method: string,
    payload: unknown,
    key: string,
    gameId?: string,
    epoch?: number,
  ): Promise<Job> {
    if (!/^[a-zA-Z0-9_-]{16,128}$/.test(key))
      throw new HttpError(400, "Idempotency-Key가 필요합니다");
    const fingerprint = hash(canonical({ path, method, payload, epoch: epoch ?? null }));
    return this.db.transaction(async (sql) => {
      await this.member(sql, owner);
      const [size] = await sql.query<{ bytes: number }>(
        "SELECT octet_length($1::jsonb::text) AS bytes",
        [JSON.stringify(payload)],
      );
      if (size!.bytes > 262144) throw new HttpError(413, "요청이 너무 큽니다");
      const [old] = await sql.query<Job>(
        "SELECT * FROM private.jobs WHERE owner_id=$1 AND request_key=$2",
        [owner, key],
      );
      if (old) {
        if (old.payload_hash !== fingerprint)
          throw new HttpError(409, "같은 요청 키의 내용이 달라졌습니다");
        return old;
      }
      const [active] = await sql.query<{ id: string }>(
        "SELECT id FROM private.jobs WHERE owner_id=$1 AND status IN ('queued','running') AND path <> '/internal/lorebook' LIMIT 1",
        [owner],
      );
      if (active) throw new HttpError(409, "이전 작업이 진행 중입니다", { activeJobId: active.id });
      if (!gameId) {
        const [count] = await sql.query<{ n: string }>(
          "SELECT count(*)::text AS n FROM private.games WHERE owner_id=$1 AND deleted_at IS NULL",
          [owner],
        );
        if (Number(count?.n) >= this.maxGames)
          throw new HttpError(409, "활성 게임은 계정당 2개까지 만들 수 있습니다");
      }
      const id = gameId ?? randomUUID();
      if (!gameId)
        await sql.query("INSERT INTO private.games(id,owner_id) VALUES($1,$2)", [id, owner]);
      const game = await this.game(owner, id, sql, true);
      if (epoch !== undefined && game.client_epoch !== epoch)
        throw new HttpError(409, "다른 경기 창이 제어권을 가지고 있습니다");
      const jobId = randomUUID();
      const [job] = await sql.query<Job>(
        `INSERT INTO private.jobs(id,owner_id,game_id,request_key,payload_hash,path,method,payload,base_revision,client_epoch)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [
          jobId,
          owner,
          id,
          key,
          fingerprint,
          path,
          method,
          JSON.stringify(payload),
          game.revision,
          game.client_epoch,
        ],
      );
      await sql.query("UPDATE private.games SET active_job=$1 WHERE id=$2", [jobId, id]);
      await sql.query("INSERT INTO private.outbox(job_id) VALUES($1)", [jobId]);
      await sql.query(
        "INSERT INTO private.analytics(id,owner_id,name,game_id,job_id) VALUES($1,$2,$3,$4,$5)",
        [
          randomUUID(),
          owner,
          path === "/api/games"
            ? "game_creation_requested"
            : path.endsWith("/turn/stream")
              ? "turn_accepted"
              : "job_submitted",
          id,
          jobId,
        ],
      );
      return job!;
    });
  }
  async get(owner: string, id: string): Promise<Job> {
    const [job] = await this.db.query<Job>(
      "SELECT j.* FROM private.jobs j JOIN private.members m ON m.id=j.owner_id AND m.active WHERE j.id=$1 AND j.owner_id=$2",
      [id, owner],
    );
    if (!job) throw new HttpError(404, "작업을 찾을 수 없습니다");
    return job;
  }
  async claim(id: string): Promise<Job | null> {
    return this.db.transaction(async (sql) => {
      const [job] = await sql.query<Job>(
        `UPDATE private.jobs j SET status='running',attempt=attempt+1,lease_until=now()+interval '60 seconds',updated_at=now()
    FROM private.games g,private.members m WHERE j.id=$1 AND j.status='queued' AND j.deadline>now() AND NOT EXISTS(SELECT 1 FROM private.operations WHERE key='maintenance' AND value='true'::jsonb)
    AND g.id=j.game_id AND g.deleted_at IS NULL AND ((j.path='/internal/lorebook') OR (g.active_job=j.id AND g.revision=j.base_revision AND g.client_epoch=j.client_epoch)) AND m.id=j.owner_id AND m.active RETURNING j.*`,
        [id],
      );
      if (!job) return null;
      await this.event(sql, job, { type: "attempt_reset" });
      return job;
    });
  }
  async heartbeat(job: Job): Promise<boolean> {
    const rows = await this.db.query(
      "UPDATE private.jobs SET lease_until=now()+interval '60 seconds' WHERE id=$1 AND attempt=$2 AND status='running' AND lease_until>now() AND deadline>now() RETURNING id",
      [job.id, job.attempt],
    );
    return rows.length === 1;
  }
  async event(sql: Sql, job: Job, body: unknown): Promise<void> {
    const text = JSON.stringify(body);
    if (Buffer.byteLength(text) <= EVENT_BYTES) return this.eventRow(sql, job, text);
    for (let at = 0; at < text.length;) {
      let end = Math.min(text.length, at + EVENT_PART_CHARS);
      // 서로게이트 쌍을 가르지 않는다 — 짝 잃은 반쪽은 jsonb가 받지 않는다
      const last = text.charCodeAt(end - 1);
      if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
      const data = text.slice(at, end);
      await this.eventRow(
        sql,
        job,
        JSON.stringify({ type: "part", data, last: end === text.length }),
      );
      at = end;
    }
  }
  private async eventRow(sql: Sql, job: Job, body: string): Promise<void> {
    const [seq] = await sql.query<{ next_seq: number }>(
      "UPDATE private.jobs SET next_seq=next_seq+1 WHERE id=$1 AND attempt=$2 AND status='running' AND lease_until>now() RETURNING next_seq",
      [job.id, job.attempt],
    );
    if (seq)
      await sql.query("INSERT INTO private.events(job_id,seq,attempt,body) VALUES($1,$2,$3,$4)", [
        job.id,
        seq.next_seq,
        job.attempt,
        body,
      ]);
  }
  async object(
    gameId: string,
    kind: string,
    value: unknown,
    refs: string[] = [],
  ): Promise<{ key: string; checksum: string }> {
    return this.upload(`${gameId}/${kind}/${randomUUID()}`, gameId, encode(value), refs);
  }
  private async upload(
    key: string,
    gameId: string,
    bytes: Uint8Array,
    refs: string[] = [],
  ): Promise<{ key: string; checksum: string }> {
    const checksum = hash(bytes);
    await this.db.query(
      "INSERT INTO private.objects(key,game_id,checksum,refs) VALUES($1,$2,$3,$4)",
      [key, gameId, checksum, JSON.stringify(refs)],
    );
    await this.objects.put(key, bytes);
    if (hash(await this.objects.get(key)) !== checksum)
      throw new Error("Object verification failed");
    return { key, checksum };
  }
  /**
   * 조각 하나 — 같은 내용의 확정된 조각이 있으면 그것을 다시 쓴다.
   *
   * 다시 쓰는 그 갱신이 `created_at`을 지금으로 옮겨 GC의 하루 유예를 새로 건다. GC는 행을
   * 조건부로 먼저 지우고 성공했을 때만 바이트를 지우므로(maintenance), 갱신에 성공한 조각은
   * 커밋 전에 사라지지 않는다. 갱신할 행이 없으면 **새 이름**으로 올린다 — 이름을 되쓰지
   * 않으니 지워지는 중인 바이트와 겹치지 않는다.
   */
  private async chunk(gameId: string, table: string, value: unknown): Promise<string> {
    const json = JSON.stringify(value);
    const prefix = `${gameId}/chunk/${table}-${hash(json)}-`;
    const [kept] = await this.db.query<{ key: string }>(
      `UPDATE private.objects SET created_at=now() WHERE key=(SELECT key FROM private.objects WHERE game_id=$1 AND state='committed' AND starts_with(key,$2) ORDER BY created_at DESC LIMIT 1) RETURNING key`,
      [gameId, prefix],
    );
    if (kept) return kept.key;
    const { key } = await this.upload(`${prefix}${randomUUID()}`, gameId, encode(value));
    // 조각은 내용이 이름에 묶인 불변 객체다 — 올리고 검증한 순간부터 다시 쓸 수 있다
    await this.db.query("UPDATE private.objects SET state='committed' WHERE key=$1", [key]);
    return key;
  }
  /** 세이브 — 큰 표는 조각으로, 본문은 조각 이름과 나머지 상태만 든다 */
  private async save(
    gameId: string,
    snapshot: unknown,
  ): Promise<{ key: string; checksum: string }> {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot))
      return this.object(gameId, "save", snapshot);
    const body: Record<string, unknown> = { ...(snapshot as Record<string, unknown>) };
    const chunks: Record<string, string> = {};
    for (const table of CHUNKED_TABLES) {
      if (body[table] === undefined) continue;
      chunks[table] = await this.chunk(gameId, table, body[table]);
      delete body[table];
    }
    body[CHUNKS] = chunks;
    return this.object(gameId, "save", body, Object.values(chunks));
  }
  async commit(
    job: Job,
    result: Result,
    snapshot: unknown,
    summary: Record<string, unknown>,
    view: unknown = null,
    tasks: LoreTask[] = [],
    expectedRevision?: number,
  ): Promise<boolean> {
    const saved = snapshot === null ? null : await this.save(job.game_id, snapshot);
    const cached = saved && view ? await this.object(job.game_id, "view", view) : null;
    const answer = await this.object(job.game_id, "result", result);
    return this.db.transaction(async (sql) => {
      await this.member(sql, job.owner_id);
      const game = await this.game(job.owner_id, job.game_id, sql, true);
      const background = job.path === "/internal/lorebook";
      if (background && (game.active_job !== null || game.revision !== expectedRevision))
        return false;
      const [fenced] = await sql.query(
        `UPDATE private.jobs SET status=$3,result_key=$4,committed_revision=$8,lease_until=NULL,updated_at=now()
    WHERE id=$1 AND attempt=$2 AND status='running' AND lease_until>now() AND deadline>now()
    AND ($7 OR (base_revision=$5 AND client_epoch=$6)) RETURNING id`,
        [
          job.id,
          job.attempt,
          result.status < 400 ? "succeeded" : "failed",
          answer.key,
          game.revision,
          game.client_epoch,
          background,
          game.revision + (saved ? 1 : 0),
        ],
      );
      if (!fenced || (!background && game.active_job !== job.id)) {
        if (fenced) throw new Error("Active job fence mismatch");
        return false;
      }
      await sql.query(
        `UPDATE private.games SET active_job=NULL,revision=revision+$2,snapshot_key=coalesce($3,snapshot_key),snapshot_hash=coalesce($4,snapshot_hash),summary=CASE WHEN $2=1 THEN $5::jsonb ELSE summary END,view_key=coalesce($6,view_key),view_hash=coalesce($7,view_hash),match_build=CASE WHEN $2=1 THEN $8 ELSE match_build END,updated_at=now() WHERE id=$1`,
        [
          game.id,
          saved ? 1 : 0,
          saved?.key ?? null,
          saved?.checksum ?? null,
          JSON.stringify(summary),
          cached?.key ?? null,
          cached?.checksum ?? null,
          snapshot &&
          typeof snapshot === "object" &&
          "pendingMatch" in snapshot &&
          snapshot.pendingMatch
            ? (game.match_build ?? BUILD)
            : null,
        ],
      );
      await sql.query(
        "UPDATE private.objects SET state='committed' WHERE key=$1 OR key=$2 OR key=$3",
        [answer.key, saved?.key ?? null, cached?.key ?? null],
      );
      await sql.query("DELETE FROM private.outbox WHERE job_id=$1", [job.id]);
      await sql.query(
        "INSERT INTO private.analytics(id,owner_id,name,game_id,job_id) VALUES($1,$2,$3,$4,$5)",
        [
          randomUUID(),
          job.owner_id,
          job.path === "/api/games"
            ? result.status < 400
              ? "game_created"
              : "game_creation_failed"
            : job.path.endsWith("/turn/stream")
              ? result.status < 400
                ? "turn_committed"
                : "turn_failed"
              : result.status < 400
                ? "job_succeeded"
                : "job_failed",
          game.id,
          job.id,
        ],
      );
      if (result.status < 400 && !background) {
        if (job.path.endsWith("/turn/stream"))
          await sql.query(
            "INSERT INTO private.analytics(id,owner_id,name,game_id,job_id) SELECT $1,$2,'first_turn_committed',$3,$4 WHERE NOT EXISTS(SELECT 1 FROM private.analytics WHERE game_id=$3 AND name='first_turn_committed')",
            [randomUUID(), job.owner_id, game.id, job.id],
          );
        const hasMatch = Boolean(
          snapshot &&
          typeof snapshot === "object" &&
          "pendingMatch" in snapshot &&
          snapshot.pendingMatch,
        );
        const name =
          saved && !game.match_build && hasMatch
            ? "match_started"
            : saved && game.match_build && !hasMatch
              ? "match_completed"
              : null;
        if (name)
          await sql.query(
            "INSERT INTO private.analytics(id,owner_id,name,game_id,job_id) VALUES($1,$2,$3,$4,$5)",
            [randomUUID(), job.owner_id, name, game.id, job.id],
          );
      }
      if (result.status >= 400 && !game.snapshot_key)
        await sql.query("UPDATE private.games SET deleted_at=now() WHERE id=$1", [game.id]);
      for (const task of tasks) {
        // A dead edit is held for operator inspection; later edits for that character must not overtake it.
        const id = randomUUID();
        const requestKey = `lore-${game.id}-${task.id}`;
        const rows = await sql.query(
          "INSERT INTO private.jobs(id,owner_id,game_id,request_key,payload_hash,path,method,payload,base_revision,client_epoch) VALUES($1,$2,$3,$4,$4,'/internal/lorebook','POST',$5,$6,$7) ON CONFLICT(owner_id,request_key) DO NOTHING RETURNING id",
          [
            id,
            job.owner_id,
            game.id,
            requestKey,
            JSON.stringify(task),
            game.revision + (saved ? 1 : 0),
            game.client_epoch,
          ],
        );
        if (rows.length) await sql.query("INSERT INTO private.outbox(job_id) VALUES($1)", [id]);
      }
      return true;
    });
  }
  async deferLore(job: Job): Promise<void> {
    await this.db.transaction(async (sql) => {
      const [updated] = await sql.query(
        "UPDATE private.jobs SET status='queued',lease_until=NULL WHERE id=$1 AND attempt=$2 AND status='running' AND lease_until>now() RETURNING id",
        [job.id, job.attempt],
      );
      if (!updated) return;
      await sql.query(
        "UPDATE private.outbox SET sent_at=NULL,generation=generation+1,next_at=now()+interval '15 seconds' WHERE job_id=$1",
        [job.id],
      );
    });
  }
  async retryLore(job: Job, transient: boolean, clear = false): Promise<void> {
    await this.db.transaction(async (sql) => {
      const [updated] = await sql.query(
        "UPDATE private.jobs SET status=CASE WHEN $3 AND lore_failures<2 AND deadline>now() THEN 'queued' ELSE 'dead' END,lore_failures=lore_failures+1,lease_until=NULL,work_key=CASE WHEN $4 THEN NULL ELSE work_key END WHERE id=$1 AND attempt=$2 AND status='running' AND lease_until>now() RETURNING status",
        [job.id, job.attempt, transient, clear],
      );
      if (!updated) return;
      if (updated.status === "queued")
        await sql.query(
          "UPDATE private.outbox SET sent_at=NULL,generation=generation+1,next_at=now()+interval '5 seconds' WHERE job_id=$1",
          [job.id],
        );
      else {
        await sql.query("DELETE FROM private.outbox WHERE job_id=$1", [job.id]);
        console.error(JSON.stringify({ event: "lorebook_held", jobId: job.id }));
      }
    });
  }
  async fail(job: Job): Promise<void> {
    await this.db.transaction(async (sql) => {
      const rows = await sql.query(
        "UPDATE private.jobs SET status='failed',error='작업 실행에 실패했습니다',lease_until=NULL WHERE id=$1 AND attempt=$2 AND status='running' AND lease_until>now() RETURNING id",
        [job.id, job.attempt],
      );
      if (rows.length) {
        await sql.query("UPDATE private.games SET active_job=NULL WHERE id=$1 AND active_job=$2", [
          job.game_id,
          job.id,
        ]);
        await sql.query("DELETE FROM private.outbox WHERE job_id=$1", [job.id]);
        await sql.query(
          "UPDATE private.games SET deleted_at=now() WHERE id=$1 AND snapshot_key IS NULL",
          [job.game_id],
        );
      }
    });
  }
  async recover(): Promise<void> {
    await this.db.transaction(async (sql) => {
      // Match the member → game/job ordering used by commits and deletion.
      await sql.query("SELECT id FROM private.members ORDER BY id FOR UPDATE");
      await sql.query(`UPDATE private.jobs SET status=CASE WHEN deadline<=now() THEN 'expired' WHEN (CASE WHEN path='/internal/lorebook' THEN lore_failures ELSE attempt END)>=3 THEN 'dead' ELSE 'queued' END,lease_until=NULL,updated_at=now()
    WHERE (status='running' AND lease_until<=now()) OR (status='queued' AND deadline<=now())`);
      await sql.query(
        "UPDATE private.outbox o SET sent_at=NULL,generation=generation+1,next_at=now() FROM private.jobs j WHERE j.id=o.job_id AND j.status='queued' AND o.sent_at<now()-interval '5 minutes'",
      );
      await sql.query(
        "DELETE FROM private.outbox o USING private.jobs j WHERE j.id=o.job_id AND j.status NOT IN ('queued','running')",
      );
      await sql.query(
        "UPDATE private.games g SET active_job=NULL FROM private.jobs j WHERE g.active_job=j.id AND j.status NOT IN ('queued','running')",
      );
      await sql.query(
        "UPDATE private.games SET deleted_at=now() WHERE snapshot_key IS NULL AND active_job IS NULL AND deleted_at IS NULL",
      );
      await sql.query("DELETE FROM private.events WHERE created_at<now()-interval '24 hours'");
      await sql.query("DELETE FROM private.feedback WHERE created_at<now()-interval '90 days'");
      await sql.query("DELETE FROM private.analytics WHERE created_at<now()-interval '180 days'");
      await sql.query("DELETE FROM private.sessions WHERE expires_at<now()");
      await sql.query(
        "UPDATE private.usage u SET status='unknown',finished_at=now() FROM private.jobs j WHERE j.id=u.job_id AND u.status='reserved' AND (j.status<>'running' OR j.attempt<>u.job_attempt OR j.lease_until<=now())",
      );
    });
  }
  async remove(owner: string, id: string): Promise<void> {
    await this.db.transaction(async (sql) => {
      await this.member(sql, owner);
      await this.game(owner, id, sql, true);
      await sql.query(
        "UPDATE private.jobs SET status='cancelled',lease_until=NULL WHERE game_id=$1 AND status IN ('queued','running')",
        [id],
      );
      await sql.query(
        "UPDATE private.games SET deleted_at=now(),active_job=NULL WHERE id=$1 AND owner_id=$2",
        [id, owner],
      );
    });
  }
  async snapshot(game: Game): Promise<unknown> {
    if (!game.snapshot_key) return null;
    const body = decode(await this.objects.get(game.snapshot_key), game.snapshot_hash ?? undefined);
    if (!body || typeof body !== "object" || !(CHUNKS in body)) return body;
    const { [CHUNKS]: chunks, ...rest } = body as Record<string, unknown>;
    const state: Record<string, unknown> = rest;
    for (const [table, key] of Object.entries(chunks as Record<string, string>)) {
      const parts = CHUNK_KEY.exec(key);
      if (!parts || parts[1] !== table) throw new Error("Invalid snapshot chunk");
      const value = decode(await this.objects.get(key));
      // 이름의 해시가 곧 검증값이다 — 상하거나 다른 조각이면 세이브를 읽지 않는다
      if (hash(JSON.stringify(value)) !== parts[2])
        throw new Error("Snapshot chunk checksum mismatch");
      state[table] = value;
    }
    return state;
  }
  async result(job: Pick<Job, "result_key">): Promise<unknown> {
    return job.result_key ? decode(await this.objects.get(job.result_key)) : null;
  }
}
