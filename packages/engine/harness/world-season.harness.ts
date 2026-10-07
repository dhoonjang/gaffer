import { playerOverall } from "@gaffer/domain";
import { describe, expect, it } from "vitest";
import {
  leagueOfTeamIn,
  EXHAUSTED_CONDITION,
  ROTATION_FATIGUE,
  ROTATION_FRESHER,
  ROTATION_OVR_DROP,
  advanceTime,
  assignmentsOf,
  computeStandings,
  firstTeamPlayers,
  groupOf,
  isInjured,
  isSuspended,
  simSquadOf,
  type GameState,
  eventTexts,
  RATING_BASELINE,
} from "@gaffer/engine";
import { createTestGame, drillUserTactics, settleMatchdayQuick } from "../test/helpers";
import { AI_ROTATION, LEAGUE_SPREAD, WORLD_SEASON } from "./catalog";
import { outOfBand, reportOf, type Readings } from "./harness";

/**
 * 전체 세계에서 한 시즌을 굴려 **분포**를 잰다 — 평균만으로는 닮았는지 알 수 없다.
 * 득점 평균이 2.8이어도 매 경기 1-1과 4-0이 반씩 섞인 리그와 실제 축구는 다른 게임이다.
 *
 * **재는 것은 간이 시뮬의 리그다** — 감독의 경기도 간이 결산으로 치른다. 실시간 경기를
 * 섞으면 380경기 중 38경기가 다른 시뮬의 값을 싣고, 그 차이를 재는 자리는 `sim-parity`다.
 * 실시간 경기 한 판이 수십 초라 섞는 순간 이 하네스 하나가 주간 시한을 넘기기도 했다.
 *
 *   pnpm balance world-season
 */

/**
 * 로테이션하는 감독 — AI 팀(`simSquadOf`)과 같은 문턱으로 지친 선발을 바꾼다.
 * 하네스가 이걸 안 하면 감독 팀만 시즌 내내 같은 XI로 뛰어 측정이 실제 플레이와
 * 다른 것을 잰다.
 *
 * ⚠️ 문턱은 `simSquadOf`가 쓰는 상수 그것이다. 여기에 숫자를 따로 적으면 로테이션을
 * 재는 자리가 재려는 대상과 다른 눈금을 쓴다.
 */
function rotate(state: GameState): void {
  const squad = firstTeamPlayers(state, state.userTeamId);
  const byId = new Map(squad.map((p) => [p.id, p]));
  const all = assignmentsOf(state, state.userTeamId);
  const starters = all.filter((a) => a.role === "starting");
  const used = new Set(starters.map((a) => a.playerId));
  for (const slot of starters) {
    const tired = byId.get(slot.playerId);
    const unavailable =
      !tired || isInjured(state, slot.playerId) || isSuspended(state, slot.playerId);
    if (!unavailable && 100 - tired.state.condition < ROTATION_FATIGUE) continue;
    const pick = squad
      .filter(
        (p) =>
          !used.has(p.id) &&
          !isInjured(state, p.id) &&
          !isSuspended(state, p.id) &&
          (!tired || groupOf(p) === groupOf(tired)) &&
          (!tired || playerOverall(p) >= playerOverall(tired) - ROTATION_OVR_DROP) &&
          (!tired || p.state.condition >= tired.state.condition + ROTATION_FRESHER),
      )
      .sort((a, b) => playerOverall(b) - playerOverall(a))[0];
    if (!pick) continue;
    const benchSlot = all.find((a) => a.playerId === pick.id);
    used.delete(slot.playerId);
    used.add(pick.id);
    const pos = slot.position;
    slot.playerId = pick.id;
    if (benchSlot) benchSlot.playerId = tired ? tired.id : benchSlot.playerId;
    slot.position = pos;
  }
}

const LEAGUE = "epl";

/**
 * 시즌을 굴리는 시드 — 승점 곡선이 잡음 위로 올라오는 데 필요한 표본이 정한다.
 * 시드 하나가 40초쯤이고, 아래 `CURVE_LEAGUES`가 시드마다 셋씩 표본을 준다.
 */
const SEEDS = [42, 7, 99, 3, 21, 64];

/**
 * **승점 곡선을 읽는 리그** — 20팀 더블 라운드로빈(38경기)인 셋만이다.
 *
 * 한 세계는 다섯 리그를 굴리는데 분데스리가·리그 1은 18팀 34경기라 승점이 다른 눈금에
 * 선다(우승 승점이 구조적으로 낮다). 나머지 셋은 실제로도 같은 형식·같은 대역이라
 * 시즌을 더 돌지 않고 표본을 셋으로 만든다.
 */
const CURVE_LEAGUES = ["epl", "laliga", "seriea"];

/** 모집단 표준편차 — 리그 스무 팀은 표본이 아니라 전부다 */
function stdev(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}

function average(xs: readonly number[]): number {
  return xs.length === 0 ? Number.NaN : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** 한 리그-시즌의 순위표 — 승점만, 1위부터 */
interface LeagueCurve {
  points: number[];
  played: number;
}

/**
 * 끝난 시즌의 최종 순위표 — **원장(`state.history`)에서 읽는다.**
 *
 * `computeStandings`로는 읽을 수 없다. 시즌 종료는 `advanceTime` 한 번 안에서
 * 남은 경기를 다 굴리고 `endSeason`까지 마치므로, 하네스가 볼 수 있는 마지막
 * 순간에는 이미 `state.season`이 올라가 있고 승강이 리그 소속까지 바꾼 뒤다.
 * 지나간 시즌의 순위표가 남는 유일한 자리가 원장이다 (season.md §6).
 */
function curveOf(state: GameState, season: number, leagueId: string): LeagueCurve {
  const rows = (
    state.history.find((h) => h.season === season)?.leagues.find((l) => l.leagueId === leagueId)
      ?.rows ?? []
  ).map((r) => r.record);
  return {
    points: rows.map((r) => r.points),
    // 팀-경기 합의 절반이 경기 수다 — 한 경기가 두 줄에 적힌다
    played: rows.reduce((a, r) => a + r.played, 0) / 2,
  };
}

/**
 * 승점 곡선 — **평균과 표준편차를 함께 읽는다.** 한 리그-시즌의 순위별 승점은 ±10점씩
 * 흔들리므로 평균만으로는 대역 안팎을 말할 수 없고, 표준편차 없이는 그 평균이 얼마나
 * 미더운지도 말할 수 없다.
 */
function spreadReadings(curves: readonly LeagueCurve[]): Readings<typeof LEAGUE_SPREAD> {
  const at = (i: number) => curves.map((c) => c.points[i < 0 ? c.points.length + i : i] ?? 0);
  const spreads = curves.map((c) => stdev(c.points));
  const champions = at(0);
  const bottom = at(-1);
  const tenth = at(9);
  return {
    "표본 (시드 × 리그)": curves.length,
    "리그당 경기 수 (최소)": Math.min(...curves.map((c) => c.played)),
    "리그 승점 표준편차 (평균)": average(spreads),
    "리그 승점 표준편차 (리그-시즌 σ)": stdev(spreads),
    "승점 1위 평균": average(champions),
    "승점 1위 리그-시즌 σ": stdev(champions),
    "승점 4위 평균": average(at(3)),
    "승점 10위 평균": average(tenth),
    "승점 17위 평균": average(at(16)),
    "승점 최하위 평균": average(bottom),
    "승점 최하위 리그-시즌 σ": stdev(bottom),
    "승점 1위 − 10위 평균": average(champions.map((p, i) => p - (tenth[i] ?? 0))),
  };
}

function ratio(n: number, total: number): number {
  return n / Math.max(1, total);
}

/**
 * 득점 시각 한 구간의 몫 — 실측(football-reference.md §2)은 하프 안에서도 뒤로 갈수록 붐빈다.
 * 간이 시뮬은 추가시간 축이 없어 90+ 골이 76~90에 접히므로 마지막 칸은 둘을 합쳐 읽는다.
 */
function goalShareBetween(minutes: readonly number[], from: number, to: number): number {
  return ratio(minutes.filter((m) => m >= from && m <= to).length, minutes.length);
}

/**
 * 출전당 평점 평균 — 시즌 기록의 `ratingSum ÷ apps`. 폼은 이 평균을 중립점(`RATING_BASELINE`)과
 * 견주므로, 둘이 갈리면 리그 전체의 폼이 경기마다 한쪽으로 조용히 기운다 (player.md §5)
 */
function ratingMeanOf(state: GameState, competitionId: string): number {
  const rows = state.seasonStats.filter(
    (r) => r.season === state.season && r.competitionId === competitionId,
  );
  const apps = rows.reduce((a, r) => a + r.apps, 0);
  return rows.reduce((a, r) => a + (r.ratingSum ?? 0), 0) / Math.max(1, apps);
}

function seasonReadings(state: GameState): Readings<typeof WORLD_SEASON> {
  const played = state.matches.filter(
    (m) => m.result && m.competitionId === LEAGUE && m.season === state.season,
  );
  const n = Math.max(1, played.length);
  const totals = played.map((m) => m.result!.homeGoals + m.result!.awayGoals);
  const mean = totals.reduce((a, b) => a + b, 0) / n;
  const teamGoals = played.flatMap((m) => [m.result!.homeGoals, m.result!.awayGoals]);
  const shots = played.flatMap((m) => [m.result!.homeShots, m.result!.awayShots]);
  const shotMean = shots.reduce((a, b) => a + b, 0) / Math.max(1, shots.length);
  const sum = (pick: (m: (typeof played)[number]) => number) =>
    played.reduce((a, m) => a + pick(m), 0);
  const share = (xs: number[], goals: number, top = false) =>
    ratio(xs.filter((x) => (top ? x >= goals : x === goals)).length, xs.length);

  const table = computeStandings(state, LEAGUE);
  const at = (i: number) => table[i]?.points ?? 0;
  const usIndex = table.findIndex((r) => r.teamId === state.userTeamId);
  const bookings = state.bookings.filter((b) => played.some((m) => m.id === b.matchId));
  /** **세트피스 득점 비율** — 골마다 붙는 `goalOrigins`가 원본이다 (match.md §4) */
  const origins = played.flatMap((m) => m.result!.goalOrigins);
  const originShare = (kinds: readonly string[]) =>
    ratio(origins.filter((o) => kinds.includes(o)).length, origins.length);
  const originPerMatch = (kinds: readonly string[]) =>
    ratio(origins.filter((o) => kinds.includes(o)).length, played.length);

  const draw = played.filter((m) => m.result!.homeGoals === m.result!.awayGoals).length;
  const goalMinutes = played.flatMap((m) => m.result!.goalMinutes);

  return {
    "리그 평균 슈팅/경기": shotMean * 2,
    "리그 평균 기회 xG/경기": sum((m) => m.result!.homeXg + m.result!.awayXg) / n,
    "결정력 반영 기대 득점/경기":
      sum((m) => m.result!.homeExpectedGoals + m.result!.awayExpectedGoals) / n,
    "리그 평균 득점/경기": mean,
    "총득점 분산": totals.reduce((a, b) => a + (b - mean) ** 2, 0) / n,
    "무승부 비율": ratio(draw, n),
    // 클린시트는 **팀-경기** 단위다 — 경기 단위로 "한쪽이라도 0골"을 세면 두 배가 된다
    "클린시트 비율": share(teamGoals, 0),
    "총득점 0골 비율": share(totals, 0),
    "총득점 1골 비율": share(totals, 1),
    "총득점 2골 비율": share(totals, 2),
    "총득점 3골 비율": share(totals, 3),
    "총득점 4골 비율": share(totals, 4),
    "총득점 5골 비율": share(totals, 5),
    "총득점 6골 비율": share(totals, 6),
    "총득점 7골+ 비율": share(totals, 7, true),
    "팀득점 0골 비율": share(teamGoals, 0),
    "팀득점 1골 비율": share(teamGoals, 1),
    "팀득점 2골 비율": share(teamGoals, 2),
    "팀득점 3골 비율": share(teamGoals, 3),
    "팀득점 4골+ 비율": share(teamGoals, 4, true),
    "세트피스 득점 비율": originShare(["corner", "free_kick", "penalty"]),
    "코너·프리킥 득점/경기": originPerMatch(["corner", "free_kick"]),
    "페널티 득점/경기": originPerMatch(["penalty"]),
    "팀당 슈팅/경기": shotMean,
    "슈팅당 xG": sum((m) => m.result!.homeXg + m.result!.awayXg) / Math.max(1, shotMean * 2 * n),
    "팀-경기 xG sd": stdev(played.flatMap((m) => [m.result!.homeXg, m.result!.awayXg])),
    "점유율 sd": stdev(
      played.flatMap((m) => [m.result!.possession.home, m.result!.possession.away]),
    ),
    "전반 득점 비중": ratio(
      played.flatMap((m) => m.result!.goalMinutes).filter((minute) => minute <= 45).length,
      played.reduce((a, m) => a + m.result!.goalMinutes.length, 0),
    ),
    "득점 시각 1~15분": goalShareBetween(goalMinutes, 0, 15),
    "득점 시각 16~30분": goalShareBetween(goalMinutes, 16, 30),
    "득점 시각 31~45분": goalShareBetween(goalMinutes, 31, 45),
    "득점 시각 46~60분": goalShareBetween(goalMinutes, 46, 60),
    "득점 시각 61~75분": goalShareBetween(goalMinutes, 61, 75),
    "득점 시각 76~90분": goalShareBetween(goalMinutes, 76, 90),
    "평점 평균 − 폼 중립점": ratingMeanOf(state, LEAGUE) - RATING_BASELINE,
    "도움 붙은 골 비중": ratio(
      played.flatMap((m) => m.result!.assists).filter((a) => a !== "").length,
      played.reduce((a, m) => a + m.result!.assists.length, 0),
    ),
    "팀당 슈팅 분산":
      shots.reduce((a, b) => a + (b - shotMean) ** 2, 0) / Math.max(1, shots.length),
    "승점 1위": at(0),
    "승점 4위": at(3),
    "승점 10위": at(9),
    "승점 17위": at(16),
    "승점 최하위": at(table.length - 1),
    "리그 승점 표준편차": stdev(table.map((r) => r.points)),
    "옐로/경기": ratio(bookings.filter((b) => b.card === "yellow").length, n),
    "레드/경기": ratio(bookings.filter((b) => b.card === "red").length, n),
    "감독 팀 순위": usIndex + 1,
    "감독 팀 승점": table[usIndex]?.points ?? 0,
    "리그 경기 수": played.length,
  };
}

/**
 * **AI 로테이션 — 문턱 셋이 실제로 걸리는가.**
 *
 * `ROTATION_FATIGUE`·`ROTATION_OVR_DROP`·`ROTATION_FRESHER`는 **동시에** 걸려야
 * 하므로 깊이가 얕은 팀에서는 통째로 불발하고 `EXHAUSTED_CONDITION` 갈래만 남는다.
 * 그게 실제로 일어나는지는 코드를 읽어서는 알 수 없다 — 시즌을 굴려 세는 자리가 여기다.
 */
const CONDITION_BANDS = [40, 60, 80, 100];

interface RotationTally {
  /** 표본 = 팀 × 경기일 */
  samples: number;
  /** 그날 서는 선발의 체력 (평균의 분자와 분모) */
  starterCondition: number;
  starterCount: number;
  /** 1군 전체의 체력 분포 — `CONDITION_BANDS` 구간별 인원 */
  bands: number[];
  bandTotal: number;
  /** 피로 문턱을 넘긴 가용 선발 */
  tired: number;
  /** 그중 실제로 라인업에서 빠진 사람 */
  rotated: number;
  /**
   * 빠진 사람 중 체력이 탈진 문턱 **위**였던 사람 — 문턱 셋 갈래가 확실히 걸린
   * 경우다. 탈진 문턱 아래는 두 갈래를 밖에서 가를 수 없다.
   */
  aboveExhausted: number;
}

function newTally(): RotationTally {
  return {
    samples: 0,
    starterCondition: 0,
    starterCount: 0,
    bands: new Array(CONDITION_BANDS.length + 1).fill(0) as number[],
    bandTotal: 0,
    tired: 0,
    rotated: 0,
    aboveExhausted: 0,
  };
}

function bandOf(condition: number): number {
  const index = CONDITION_BANDS.findIndex((edge) => condition < edge);
  return index === -1 ? CONDITION_BANDS.length : index;
}

/** 감독 경기가 시작되는 순간의 리그 — 그 시점의 AI 라인업을 그대로 읽는다 */
function sampleRotation(state: GameState, tally: RotationTally): void {
  for (const row of computeStandings(state, LEAGUE)) {
    if (row.teamId === state.userTeamId) continue;
    const squad = firstTeamPlayers(state, row.teamId);
    const byId = new Map(squad.map((p) => [p.id, p]));
    const onPitch = new Set(
      simSquadOf(state, row.teamId, leagueOfTeamIn(state, row.teamId)).starters.map((p) => p.id),
    );
    tally.samples += 1;
    for (const p of squad) {
      tally.bandTotal += 1;
      tally.bands[bandOf(p.state.condition)]! += 1;
      if (onPitch.has(p.id)) {
        tally.starterCondition += p.state.condition;
        tally.starterCount += 1;
      }
    }
    for (const a of assignmentsOf(state, row.teamId, "starting")) {
      const p = byId.get(a.playerId);
      // 부상·정지로 빠진 자리는 로테이션이 아니다 — 문턱이 판단할 기회조차 없다
      if (!p || isInjured(state, p.id) || isSuspended(state, p.id)) continue;
      if (100 - p.state.condition < ROTATION_FATIGUE) continue;
      tally.tired += 1;
      if (onPitch.has(p.id)) continue;
      tally.rotated += 1;
      if (p.state.condition > EXHAUSTED_CONDITION) tally.aboveExhausted += 1;
    }
  }
}

function rotationReadings(tally: RotationTally): Readings<typeof AI_ROTATION> {
  const per = (n: number) => n / Math.max(1, tally.samples);
  return {
    "표본 (팀 × 경기일)": tally.samples,
    "선발 평균 체력": tally.starterCondition / Math.max(1, tally.starterCount),
    "1군 체력 ~39 비율": ratio(tally.bands[0] ?? 0, tally.bandTotal),
    "1군 체력 40~59 비율": ratio(tally.bands[1] ?? 0, tally.bandTotal),
    "1군 체력 60~79 비율": ratio(tally.bands[2] ?? 0, tally.bandTotal),
    "1군 체력 80~99 비율": ratio(tally.bands[3] ?? 0, tally.bandTotal),
    "1군 체력 100 비율": ratio(tally.bands[4] ?? 0, tally.bandTotal),
    "피로 문턱↑ 가용 선발 (팀·경기일당)": per(tally.tired),
    "그중 로테이션된 비율": ratio(tally.rotated, tally.tired),
    "로테이션 중 탈진 문턱 위 비율": ratio(tally.aboveExhausted, tally.rotated),
  };
}

describe("전체 세계 한 시즌", () => {
  /**
   * 시드마다 `CURVE_LEAGUES` 셋의 순위표가 여기 쌓이고, 마지막 케이스가 그것을 모아
   * 승점 곡선을 판정한다 — 케이스는 선언 순서대로 도므로 마지막 것이 전부를 본다.
   */
  const curves: LeagueCurve[] = [];
  /**
   * 시드마다의 시즌 측정값과 로테이션 집계 — **표는 시드를 모은 뒤 한 번 선다.** 한
   * 리그-시즌은 380경기라 0골 비율 같은 칸이 시드마다 ±2%p씩 흔들리고, 여섯 장의 표를
   * 나란히 읽으면 그 흔들림이 신호처럼 보인다. 시드마다 경기 수가 같으므로 칸별 평균이
   * 곧 모은 표본의 값이다.
   */
  const seasons: Array<Readings<typeof WORLD_SEASON>> = [];
  const rotation = newTally();
  const notes: string[] = [];

  for (const seed of SEEDS) {
    it(`시드 ${seed}`, () => {
      const state = createTestGame(seed);
      const tally = rotation;
      let season: Readings<typeof WORLD_SEASON> | null = null;
      let note = "";
      for (let i = 0; i < 600; i++) {
        const advanced = advanceTime(state, "next_match");
        if (!advanced.ok) {
          note = ` ⚠️ ${eventTexts(advanced.events).join(" / ")}`;
          break;
        }
        if (state.season === 1) season = seasonReadings(state);
        if (advanced.stopped === "season_end") break;
        if (advanced.stopped === "matchday") {
          if (state.season === 1) sampleRotation(state, tally);
          drillUserTactics(state, 7);
          rotate(state);
          settleMatchdayQuick(state);
          if (state.season === 1) season = seasonReadings(state);
        }
      }
      expect(season, `시즌 1의 리그 경기가 하나도 없다${note}`).not.toBeNull();
      curves.push(...CURVE_LEAGUES.map((league) => curveOf(state, 1, league)));
      seasons.push(season!);
      if (note) notes.push(`시드 ${seed}${note}`);
    });
  }

  it(`시즌 분포 — 시드 ${SEEDS.length}개를 모아`, () => {
    const metrics = Object.keys(seasons[0] ?? {}) as Array<keyof Readings<typeof WORLD_SEASON>>;
    const pooled = Object.fromEntries(
      metrics.map((metric) => [metric, average(seasons.map((r) => r[metric]))]),
    ) as Readings<typeof WORLD_SEASON>;
    const label = `시드 ${SEEDS.join("·")} 평균 (리그-시즌 ${seasons.length}개)${notes.length ? ` ⚠️ ${notes.join(" / ")}` : ""}`;
    console.log(
      [
        reportOf(WORLD_SEASON, pooled, label),
        reportOf(AI_ROTATION, rotationReadings(rotation), label),
      ].join("\n"),
    );
    expect(seasons).toHaveLength(SEEDS.length);
    expect(outOfBand(WORLD_SEASON, pooled)).toEqual([]);
  });

  it(`승점 곡선 — 시드 ${SEEDS.length} × 리그 ${CURVE_LEAGUES.length}`, () => {
    const readings = spreadReadings(curves);
    const label = `시드 ${SEEDS.join("·")} × ${CURVE_LEAGUES.join("·")}`;
    console.log(reportOf(LEAGUE_SPREAD, readings, label));
    expect(outOfBand(LEAGUE_SPREAD, readings)).toEqual([]);
  });
});
