import { describe, expect, it } from "vitest";
import type { SubCause } from "@gaffer/domain";
import { CONDITION_MAX, FATIGUE_BAND_FLOOR, fatigueOf } from "@gaffer/domain";
import {
  familiarityOf,
  firstTeamPlayers,
  isFriendly,
  playersOf,
  type GameState,
} from "@gaffer/engine";
import { createTestGame, keepSeat } from "../test/helpers";
import { AI_BENCH, AI_FITNESS } from "./catalog";
import { playSeason, playUntil } from "./season";
import { outOfBand, reportOf, type Readings } from "./harness";

/**
 * **감독의 경기를 실시간으로 치르며 도는 시즌** — 같은 시즌을 두 서술자가 나눠 읽는다.
 *
 * - `ai-bench` — 상대 벤치가 쓴 교체의 수·시점·갈래, 감독 대역의 교체 수 (match.md §3.3)
 * - `ai-fitness` — 시즌을 돈 뒤의 체력·적응도·누적 피로, 개막이 남긴 피로 (match.md §8.6)
 *
 * 실시간 경기 한 판이 20초 남짓이라 시즌 하나가 20분을 넘는다. 서술자마다 제 시즌을 굴리면
 * 같은 시드(7)를 두 번 돈다. 감독 팀에도 AI 벤치 정책이 걸린다(`playSeason`의 대역).
 *
 * 재는 것은 손잡이(`SUB_CHASE_MINUTE`·`SUB_HOLD_MINUTE`·장수 상한)가 실제 경기 분포로
 * 번역됐는가다. 문턱을 여기에 다시 적지 않는다 — 갈래를 가르는 열쇠는 실시간 경기가 쥔
 * `subCause`이고, 밴드는 서술자가 쥔다.
 *
 *   pnpm balance live-season
 */

/** 벤치는 두 시드를 모아 읽고, 체력은 첫 시드의 시즌 하나로 읽는다 */
const SEEDS = [7, 11];
const FITNESS_SEED = 7;

/** 후반 교체가 몰리는 구간의 시작 — 분포를 읽는 눈금이지 문턱이 아니다 */
const LATE = 60;

interface Tally {
  matches: number;
  /** 감독 팀이 쓴 교체 — 대역(`userBench`)이 실제로 교체하는가 */
  userSubs: number;
  subs: number[];
  chase: number;
  hold: number;
  fatigue: number;
  injury: number;
  /** 끝까지 뒤진 경기 · 그중 승부수를 던진 경기 */
  trailed: number;
  trailedChased: number;
  led: number;
  ledHeld: number;
  reshaped: number;
}

function collect(state: GameState, tally: Tally): void {
  const pending = state.pendingMatch;
  if (!pending) return;
  const match = state.matches.find((m) => m.id === pending.matchId);
  if (!match) return;
  const aiSide = match.homeTeamId === state.userTeamId ? "away" : "home";
  const score = pending.live.ledger.score;
  const diff = aiSide === "home" ? score.home - score.away : score.away - score.home;

  const subs = pending.live.ledger.events.filter(
    (e) => e.type === "substitution" && e.team === aiSide,
  );
  tally.userSubs += pending.live.ledger.events.filter(
    (e) => e.type === "substitution" && e.team !== aiSide,
  ).length;
  const of = (cause: SubCause) => subs.filter((e) => e.subCause === cause).length;

  tally.matches += 1;
  for (const sub of subs) tally.subs.push(sub.minute);
  tally.chase += of("chase");
  tally.hold += of("hold");
  tally.fatigue += of("fatigue");
  tally.injury += of("injury");
  if (pending.live.ledger.events.some((e) => e.type === "tactical_shift" && e.team === aiSide))
    tally.reshaped += 1;
  if (diff < 0) {
    tally.trailed += 1;
    if (of("chase") > 0) tally.trailedChased += 1;
  }
  if (diff > 0) {
    tally.led += 1;
    if (of("hold") > 0) tally.ledHeld += 1;
  }
}

function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** 상위 n명의 평균 체력 — 라인업에 설 만한 자원이 얼마나 신선한가 */
function topCondition(state: GameState, teamId: string, n: number): number {
  const top = firstTeamPlayers(state, teamId)
    .map((p) => p.state.condition)
    .sort((a, b) => b - a)
    .slice(0, n);
  return top.reduce((a, b) => a + b, 0) / (top.length || 1);
}

/**
 * **가장 무거운 n명의 평균 누적 피로** — 라인업을 계속 진 사람들이 얼마나 쌓였는가.
 *
 * 체력·적응도와 달리 **위에서 자른다**: 저 둘은 "쓸 만한 자원이 있는가"를 묻지만 이 축이
 * 묻는 것은 "누가 갈려 나갔는가"라, 잘 쉰 백업까지 섞으면 로테이션한 팀과 열한 명으로
 * 버틴 팀이 같은 값으로 선다 (player.md §5.5).
 */
function topLoad(state: GameState, teamId: string, n: number): number {
  const top = firstTeamPlayers(state, teamId)
    .map((p) => fatigueOf(p.state))
    .sort((a, b) => b - a)
    .slice(0, n);
  return mean(top);
}

/** 「과부하」에 선 1군 인원 — 감독이 손을 써야 하는 줄의 수 */
function overloadedCount(state: GameState, teamId: string): number {
  return firstTeamPlayers(state, teamId).filter(
    (p) => fatigueOf(p.state) >= FATIGUE_BAND_FLOOR.overloaded,
  ).length;
}

/** 상위 n명의 평균 전술 적응도 — 체력과 같은 자를 적응도 축에 댄 값 */
function topFamiliarity(state: GameState, teamId: string, n: number): number {
  const top = firstTeamPlayers(state, teamId)
    .map((p) => familiarityOf(state, p.id))
    .sort((a, b) => b - a)
    .slice(0, n);
  return mean(top);
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? Number.NaN : values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * 선수별 친선 출전 경기 수 — **재려는 값이 아니라 출전에서 무리를 가른다.**
 * 잔고로 상위·하위를 자르면 "많이 쌓인 선수가 많이 쌓였다"를 재게 된다.
 */
function friendlyAppsOf(state: GameState): Map<string, number> {
  const apps = new Map<string, number>();
  for (const match of state.matches) {
    if (!isFriendly(match) || !match.result) continue;
    for (const id of [...match.result.homeLineup, ...match.result.awayLineup]) {
      apps.set(id, (apps.get(id) ?? 0) + 1);
    }
  }
  return apps;
}

const RIVALS = ["mancity", "liverpool", "chelsea", "tottenham"];
/** 라인업에 설 인원 — 선발 11 + 교체 3 */
const LINEUP = 14;
/** 그라운드에 서는 인원 — 누적 피로는 이 폭으로 잰다 (`topLoad`의 주석) */
const XI = 11;
/** "프리시즌을 치렀다"로 볼 친선 출전 수 — 넷 중 셋 */
const PRESEASON_PLAYED = 3;

describe("감독의 경기를 실시간으로 치르는 시즌", () => {
  const tally: Tally = {
    matches: 0,
    userSubs: 0,
    subs: [],
    chase: 0,
    hold: 0,
    fatigue: 0,
    injury: 0,
    trailed: 0,
    trailedChased: 0,
    led: 0,
    ledHeld: 0,
    reshaped: 0,
  };

  it(`시드 ${FITNESS_SEED} — 체력·출전 분포 (ai-fitness)`, () => {
    const state = createTestGame(FITNESS_SEED);
    // 경질은 시계를 멈춘다 — 한 시즌을 다 돌아야 분포가 선다
    keepSeat(state);

    /**
     * ── 개막 아침 — **프리시즌이 몸에 무엇을 남겼는가** ──
     *
     * 그 질문을 지던 축(「경기 감각」)은 걷혔고, 지금 친선 넷이 개막까지 남기는 것은
     * **누적 피로**다 (player.md §5.5). 적응도 쪽은 친선을 뛰었는지가 아니라 여름을
     * 클럽 밖에서 보냈는지가 가르므로(§7.4) 무리를 나눠 재지 않고 상위 14명으로 읽는다.
     */
    playUntil(state, state.calendar.start, (s) => collect(s, tally));
    const friendlyApps = friendlyAppsOf(state);
    const ours = firstTeamPlayers(state, state.userTeamId);
    const played = ours.filter((p) => (friendlyApps.get(p.id) ?? 0) >= PRESEASON_PLAYED);
    const rested = ours.filter((p) => (friendlyApps.get(p.id) ?? 0) === 0);
    const openingPlayed = mean(played.map((p) => fatigueOf(p.state)));
    const openingRested = mean(rested.map((p) => fatigueOf(p.state)));
    const openingDrilled = topFamiliarity(state, state.userTeamId, LINEUP);

    /**
     * **잔고의 본론은 시즌 말의 스냅숏이 아니라 시즌 중의 봉우리다** (player.md §5.5).
     *
     * `playSeason`은 마지막 경기가 끝난 자리에서 멈추므로 그때는 이미 며칠이 지나
     * 모두가 회복해 있다 — 그 값만 재면 12월의 연전 구간이 통째로 안 보인다.
     * 하루마다 봉우리를 남긴다.
     */
    let ourPeak = 0;
    let theirPeak = 0;
    let overloadPeak = 0;
    /**
     * **같은 하루에 리그의 바닥도 잰다** — 잔고가 회복을 늦추므로, 이 축이 세면
     * 12월에 선수단이 통째로 눕는다 (match.md §3.1의 ⚠️). 라인업에 설 14명이
     * 시즌의 **어느 날에도** 쓸 만해야 한다는 것이 위 첫 가드의 뜻이고, 시즌 말
     * 스냅숏은 그 어느 날이 아니다.
     *
     * ⚠️ **감독 팀에는 대지 않는다.** 이 하네스의 감독 팀은 시즌 내내 같은 XI로
     * 선발하므로(교체만 한다) 나머지가 늘 신선하다 — 그 팀의 「상위 14명」은 무엇을 해도 100
     * 근처라 아무것도 판정하지 못한다. 리그의 건강을 재는 자리는 로테이션하는 쪽이다.
     */
    let theirFloor = CONDITION_MAX;
    playSeason(
      state,
      (s) => collect(s, tally),
      (day) => {
        ourPeak = Math.max(ourPeak, topLoad(day, day.userTeamId, XI));
        theirPeak = Math.max(theirPeak, mean(RIVALS.map((t) => topLoad(day, t, XI))));
        overloadPeak = Math.max(overloadPeak, overloadedCount(day, day.userTeamId));
        theirFloor = Math.min(theirFloor, ...RIVALS.map((t) => topCondition(day, t, LINEUP)));
      },
    );

    const us = topCondition(state, state.userTeamId, LINEUP);
    const spread = [...RIVALS, "newcastle"].map((t) => topCondition(state, t, LINEUP));
    const them = spread.reduce((a, b) => a + b, 0) / spread.length;
    const ourSharp = topFamiliarity(state, state.userTeamId, LINEUP);
    const theirSharp = mean([...RIVALS, "newcastle"].map((t) => topFamiliarity(state, t, LINEUP)));
    const ourLoad = topLoad(state, state.userTeamId, XI);
    const theirLoad = mean([...RIVALS, "newcastle"].map((t) => topLoad(state, t, XI)));
    const apps = playersOf(state, "mancity")
      // 행은 대회별로 갈려 있다 — 한 행만 집으면 리그 출전이 컵 한 경기로 읽힌다
      .map((p) =>
        state.seasonStats
          .filter((s) => s.gamePlayerId === p.id)
          .reduce((sum, s) => sum + s.apps, 0),
      )
      .filter((n) => n > 0);

    const readings: Readings<typeof AI_FITNESS> = {
      "상대 상위 14명 체력 (최저 팀)": Math.min(
        ...RIVALS.map((t) => topCondition(state, t, LINEUP)),
      ),
      "우리와 상대의 체력 격차": Math.abs(us - them),
      "한 시즌 출전 인원 (맨시티)": apps.length,
      "개막 잔고 — 친선 3경기 이상": openingPlayed,
      "개막 잔고 — 친선 0경기": openingRested,
      "개막 잔고 차 (친선 3+ vs 0)": openingPlayed - openingRested,
      "개막의 두 무리를 잰 인원": Math.min(played.length, rested.length),
      "개막 적응도 (상위 14명)": openingDrilled,
      "시즌 말 적응도 (상위 14명)": ourSharp,
      "우리와 상대의 적응도 격차": Math.abs(ourSharp - theirSharp),
      "시즌 말 누적 피로 — 우리 상위 11": ourLoad,
      "시즌 말 누적 피로 — 상대 상위 11": theirLoad,
      "우리와 상대의 피로 격차": Math.abs(ourLoad - theirLoad),
      "과부하 인원 (상대 최다 팀)": Math.max(...RIVALS.map((t) => overloadedCount(state, t))),
      "시즌 중 잔고 봉우리 — 우리 상위 11": ourPeak,
      "시즌 중 잔고 봉우리 — 상대 상위 11": theirPeak,
      "시즌 중 과부하 인원 (우리 최다)": overloadPeak,
      "시즌 중 체력 바닥 — 상대 상위 14 (최저일)": theirFloor,
    };
    console.log(
      reportOf(
        AI_FITNESS,
        readings,
        `시드 ${FITNESS_SEED} · 우리 ${us.toFixed(1)} vs 상대 ${them.toFixed(1)} · ` +
          `개막 프리시즌 친선 ${played.length}명 / 미출전 ${rested.length}명`,
      ),
    );
    expect(outOfBand(AI_FITNESS, readings)).toEqual([]);
  });

  for (const seed of SEEDS.filter((s) => s !== FITNESS_SEED)) {
    it(`시드 ${seed} — 벤치 표본`, () => {
      const state = createTestGame(seed);
      keepSeat(state);
      playSeason(state, (s) => collect(s, tally));
    });
  }

  it(`상대 벤치가 스코어와 남은 시간을 읽는가 — 시드 ${SEEDS.join("·")} (ai-bench)`, () => {
    const per = (n: number) => n / (tally.matches || 1);
    const readings: Readings<typeof AI_BENCH> = {
      "AI 교체/경기": per(tally.subs.length),
      "승부수 교체/경기": per(tally.chase),
      "굳히기 교체/경기": per(tally.hold),
      "체력 교체/경기": per(tally.fatigue),
      "부상 교체/경기": per(tally.injury),
      "끝까지 뒤진 경기에서 승부수를 던진 비율": tally.trailedChased / (tally.trailed || 1),
      "끝까지 앞선 경기에서 굳힌 비율": tally.ledHeld / (tally.led || 1),
      "AI 교체의 60′ 이후 비율":
        tally.subs.filter((m) => m >= LATE).length / (tally.subs.length || 1),
      "AI 교체 중앙 분": median(tally.subs),
      "판의 모양을 바꾼 경기 비율": tally.reshaped / (tally.matches || 1),
      "잰 경기 수": tally.matches,
      "감독 팀 교체/경기": per(tally.userSubs),
    };
    console.log(
      reportOf(
        AI_BENCH,
        readings,
        `시드 ${SEEDS.join("·")} · 뒤진 경기 ${tally.trailed} · 앞선 경기 ${tally.led}`,
      ),
    );
    expect(outOfBand(AI_BENCH, readings)).toEqual([]);
  });
});
