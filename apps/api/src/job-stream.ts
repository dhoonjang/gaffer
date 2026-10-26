import { asActor, type Database } from "./database";
import type { Jobs } from "./jobs";

/** 작업 이벤트가 쌓이거나 상태가 바뀌면 이 채널로 작업 id가 온다 (001-service.sql 트리거). */
const CHANNEL = "gaffer_job";
/**
 * 연결 하나가 머무는 시간 — Cloud Run 요청 시한(65초)과 Pages 프록시(70초) 안에서 서버가
 * 먼저 닫고, 클라이언트가 마지막 seq부터 다시 붙는다.
 */
export const STREAM_WINDOW_MS = 45_000;
/** 알림을 듣고 있어도 이 간격으로는 다시 본다 — 놓친 알림 하나가 스트림을 세우지 않게. */
const LISTENING_CHECK_MS = 5_000;
/** 알림을 못 들을 때(LISTEN 연결이 없거나 끊김)의 조회 간격. */
const POLLING_CHECK_MS = 300;
/** 유휴 연결을 프록시가 끊지 않게 주석 줄을 보내는 간격. */
const HEARTBEAT_MS = 15_000;
const RELISTEN_MS = 2_000;
/** 끊긴 클라이언트가 다시 붙기 전에 기다리는 시간(EventSource `retry`). */
const RETRY_MS = 1_000;
/** 한 번에 읽는 이벤트 수 — 넘치면 상태를 보기 전에 마저 읽는다. */
const PAGE = 100;
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "expired", "dead"]);

interface Watch {
  /** 지난번 이후 알림이 왔으면 바로, 아니면 알림이나 `ms` 중 먼저 오는 것에 풀린다. */
  changed(ms: number): Promise<void>;
  close(): void;
}

/** 프로세스 하나가 LISTEN 연결 하나로 받은 알림을 작업별 스트림에 나눠 준다. */
export class JobFeed {
  private readonly watchers = new Map<string, Set<() => void>>();
  private listening = false;
  private started = false;
  constructor(private readonly db: Database) {}
  private async listen(): Promise<void> {
    try {
      const stop = await this.db.listen(
        CHANNEL,
        (id) => {
          for (const poke of this.watchers.get(id) ?? []) poke();
        },
        () => {
          this.listening = false;
          this.relisten();
        },
      );
      this.listening = stop !== null;
    } catch {
      this.listening = false;
      this.relisten();
    }
  }
  private relisten(): void {
    setTimeout(() => void this.listen(), RELISTEN_MS).unref();
  }
  watch(id: string): Watch {
    if (!this.started) {
      this.started = true;
      void this.listen();
    }
    let dirty = false;
    let wake: (() => void) | null = null;
    const poke = () => {
      dirty = true;
      wake?.();
    };
    const set = this.watchers.get(id) ?? new Set();
    set.add(poke);
    this.watchers.set(id, set);
    return {
      changed: (ms) =>
        new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            wake = null;
            dirty = false;
            resolve();
          };
          if (dirty) {
            done();
            return;
          }
          const timer = setTimeout(
            done,
            Math.max(0, Math.min(ms, this.listening ? LISTENING_CHECK_MS : POLLING_CHECK_MS)),
          );
          wake = done;
        }),
      close: () => {
        set.delete(poke);
        if (!set.size) this.watchers.delete(id);
        wake?.();
      },
    };
  }
}

interface Progress extends Record<string, unknown> {
  status: string;
  game_id: string;
  committed_revision: number | null;
  result_key: string | null;
  error: string | null;
  events: { seq: number; body: unknown }[];
}

/**
 * 작업 하나의 SSE — `job` 이벤트(id는 seq)를 차례로 보내고, 작업이 끝나면 `end`에 결과를
 * 실어 닫는다. 이벤트와 상태를 한 문장으로 읽어, 끝난 상태를 본 스냅샷에 그 전의 마지막
 * 조각까지 함께 보인다.
 */
export function jobEventStream(
  feed: JobFeed,
  db: Database,
  jobs: Jobs,
  owner: string,
  id: string,
  after: number,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let closed = false;
  let watch: Watch | null = null;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      watch = feed.watch(id);
      const send = (text: string) => {
        if (!closed) controller.enqueue(encoder.encode(text));
      };
      const until = Date.now() + STREAM_WINDOW_MS;
      let seq = after;
      let wrote = Date.now();
      try {
        send(`retry: ${RETRY_MS}\n\n`);
        while (!closed) {
          const [row] = await asActor(owner, () =>
            db.query<Progress>(
              `SELECT j.status,j.game_id,j.committed_revision,j.result_key,j.error,
                coalesce((SELECT json_agg(json_build_object('seq',e.seq,'body',e.body) ORDER BY e.seq)
                  FROM (SELECT seq,body FROM private.events WHERE job_id=j.id AND seq>$3 ORDER BY seq LIMIT ${PAGE}) e),'[]'::json) AS events
              FROM private.jobs j JOIN private.members m ON m.id=j.owner_id AND m.active
              WHERE j.id=$1 AND j.owner_id=$2`,
              [id, owner, seq],
            ),
          );
          if (!row) break;
          for (const event of row.events) {
            send(`id: ${event.seq}\nevent: job\ndata: ${JSON.stringify(event.body)}\n\n`);
            seq = event.seq;
            wrote = Date.now();
          }
          if (row.events.length === PAGE) continue;
          if (TERMINAL.has(row.status) || row.result_key) {
            const result = row.result_key
              ? await jobs.result({ result_key: row.result_key })
              : null;
            send(
              `event: end\ndata: ${JSON.stringify({
                status: row.status,
                gameId: row.game_id,
                revision: row.committed_revision,
                result,
                error: row.error,
              })}\n\n`,
            );
            break;
          }
          if (Date.now() >= until) break;
          if (Date.now() - wrote >= HEARTBEAT_MS) {
            send(": ping\n\n");
            wrote = Date.now();
          }
          await watch.changed(Math.min(until, wrote + HEARTBEAT_MS) - Date.now());
        }
      } catch (error) {
        // 읽기가 실패하면 닫는다 — 클라이언트가 같은 seq에서 다시 붙는다
        console.warn(
          JSON.stringify({
            event: "job_stream_failed",
            error: error instanceof Error ? error.name : "Error",
          }),
        );
      } finally {
        watch.close();
        if (!closed) {
          closed = true;
          controller.close();
        }
      }
    },
    cancel() {
      closed = true;
      watch?.close();
    },
  });
}
