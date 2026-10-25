/**
 * 화면 없는 **클라이언트** — 브라우저의 실행기(`apps/web/screens/match/use-live-match.ts`)와 같은 일을
 * 로컬 서버에 대고 한다 (live-match.md §8).
 *
 * 서버의 확정 상태를 받아 같은 함수로 시계를 밀고, 서버가 준 상태를 이어받는다. 브라우저와
 * 달리 부르는 쪽(시뮬레이션 스킬의 `match.sh`)이 결정할 자리가 필요해 정지점
 * (`STOP_EVENT_TYPES`)에서 확정하고 멈춘다 — 그 자리에서 감독의 턴을 보낼지는 부르는 쪽이
 * 정한다. 아직 입장 전이면 처음 부를 때 들어서고, 종료 휘슬에는 브라우저와 같은 마감을 부른다.
 *
 *   SIM_HOST=http://localhost:5173 SIM_GAME=<id> tsx src/client.ts [--resume | --shootout]
 *
 * 종료 코드: 0 정지점 · 10 휴식(하프타임·연장 개시 — `--resume`으로 재개) ·
 * 20 경기 마감 · 21 승부차기가 남았다(`--shootout`으로 한 발씩) · 1 오류
 */
import { serviceFetch as fetch } from "./service-client";
import { LIVE_STEP, STOP_EVENT_TYPES, type MatchEvent } from "@gaffer/domain";
import { advanceLive, liveDigest, liveHalted, type LiveMatch } from "@gaffer/sim";

const host = process.env.SIM_HOST ?? "http://localhost:5173";
const game = process.env.SIM_GAME;
if (!game) {
  console.error("SIM_GAME이 비었다");
  process.exit(1);
}
const resume = process.argv.includes("--resume");
const shootout = process.argv.includes("--shootout");

/** 한 번에 미는 틱 — 경기 시간 1분. 정지점을 그 분 안에서 잡는다 */
const STEP_TICKS = Math.round(60 / LIVE_STEP);

interface Snapshot {
  live: LiveMatch;
  view: { beforeKickoff: boolean } | null;
  awaitingShootout: boolean;
  needsClose: boolean;
  verdict?: { ok: boolean; reason?: string };
  events?: MatchEvent[];
  shootout?: { message: string; done: boolean };
}

async function call(body: unknown): Promise<Snapshot> {
  const res = await fetch(`${host}/api/games/${game}/match/live`, {
    method: body ? "POST" : "GET",
    ...(body
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  const json = (await res.json()) as Snapshot & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `경기 요청 실패 (${res.status})`);
  return json;
}

const minuteOf = (live: LiveMatch) =>
  `${live.ledger.minute}${live.ledger.added ? `+${live.ledger.added}` : ""}′`;
const scoreOf = (live: LiveMatch) => `${live.ledger.score.home}–${live.ledger.score.away}`;

/** 종료 휘슬 뒤 — 승부차기가 남았으면 알리고, 아니면 마감을 부른다 */
async function close(snapshot: Snapshot): Promise<number> {
  if (snapshot.awaitingShootout) {
    console.log(`승부차기 — ${scoreOf(snapshot.live)} · 한 발씩 --shootout`);
    return 21;
  }
  const res = await fetch(`${host}/api/games/${game}/match/close`, { method: "POST" });
  const json = (await res.json()) as { error?: string };
  if (!res.ok) throw new Error(json.error ?? `마감 실패 (${res.status})`);
  console.log(`경기 마감 — ${scoreOf(snapshot.live)}`);
  return 20;
}

async function main(): Promise<number> {
  if (shootout) {
    const kicked = await call({ kind: "shootout" });
    console.log(kicked.shootout?.message ?? "승부차기");
    return kicked.needsClose ? close(kicked) : 21;
  }
  let snapshot = await call(null);
  // 화면 없는 실행기에는 게이트가 없다 — 처음 부르는 순간이 입장이다
  if (snapshot.view?.beforeKickoff) snapshot = await call({ kind: "enter" });
  if (snapshot.needsClose || snapshot.awaitingShootout) return close(snapshot);
  if (snapshot.live.state.interval) {
    if (!resume) {
      const live = snapshot.live;
      console.log(`휴식 — ${minuteOf(live)} ${scoreOf(live)} · 재개하려면 --resume`);
      return 10;
    }
    snapshot = await call({ kind: "resume" });
  }
  const live = snapshot.live;
  for (let guard = 0; guard < 400; guard++) {
    const { events } = advanceLive(live, STEP_TICKS);
    const stopped = events.filter((e) => STOP_EVENT_TYPES.has(e.type));
    if (stopped.length === 0 && !liveHalted(live)) continue;
    const confirmed = await call({
      kind: "checkpoint",
      checkpoint: {
        fromTick: live.committedTick,
        toTick: live.state.tick,
        digest: liveDigest(live),
      },
    });
    if (confirmed.verdict && !confirmed.verdict.ok)
      console.error(`체크포인트 반려 (${confirmed.verdict.reason}) — 서버 상태를 이어받는다`);
    const now = confirmed.live;
    if (confirmed.needsClose || confirmed.awaitingShootout) return close(confirmed);
    if (now.state.interval) {
      console.log(`휴식 — ${minuteOf(now)} ${scoreOf(now)} · 재개하려면 --resume`);
      return 10;
    }
    const kinds = (confirmed.events ?? []).filter((e) => STOP_EVENT_TYPES.has(e.type));
    console.log(
      `정지점 — ${minuteOf(now)} ${scoreOf(now)} · ${kinds.map((e) => e.type).join(", ")}`,
    );
    return 0;
  }
  throw new Error("경기가 끝나지 않았습니다");
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
