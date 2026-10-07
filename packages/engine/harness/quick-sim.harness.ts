import { describe, expect, it } from "vitest";
import { CONDITION_MAX, DEFAULT_TACTICS } from "@gaffer/domain";
import {
  injuryRiskOf,
  matchIntensity,
  penaltyRate,
  takerOnPitch,
  teamCardRate,
  teamInjuryRate,
} from "@gaffer/sim";
import {
  leagueOfTeamIn,
  quickSimulate,
  simSquadOf,
  simulateExtraTime,
  type SimSquad,
} from "@gaffer/engine";
import { positionGroupOfPlayer, type InjuryRiskGrade } from "@gaffer/domain";
import { createTestGame } from "../test/helpers";
import { INJURY_RATE, QUICK_OUTCOMES } from "./catalog";
import { outOfBand, reportOf, type Readings } from "./harness";

/**
 * **간이 시뮬의 가장자리** — 한 시즌을 굴리는 `world-season`에는 드물어 분포가 서지 않는 것들을,
 * 고정 대진을 수천~수만 번 굴려 잰다. 두 서술자가 한 파일을 쓴다.
 *
 * - `injury-rate` — 카드·퇴장·부상의 눈금, 성향·위험 등급·누적 피로가 부상률에 닿는 폭
 * - `quick-outcomes` — 연장 득점·카드, 퇴장이 득실점에 닿는 폭, AI 교체의 수·시점, 페널티 성공률
 *
 *   pnpm balance quick-sim
 *
 * ── `injury-rate` ──
 *
 * **간이 시뮬이 기대한 눈금으로 카드와 부상을 내는가** — 발생률 손잡이
 * (`teamCardRate`·`teamInjuryRate`)에서 유도한 기대치와 굴린 값을 맞댄다 (match.md §8).
 *
 * 한 시즌으로는 안 보인다 — 감독의 리그 38경기에 실리는 카드는 130장뿐이라 20%의
 * 차이가 표본 잡음에 묻힌다. 그래서 판정은 여기서, 표본을 키워서 한다. 실시간
 * 경기의 카드·부상은 말의 규칙에서 나오므로 `live-match-stats`가 실측과 맞댄다.
 *
 * 성향이 값으로 어떻게 움직이는지(오름·내림·상하한·균형식)는
 * `packages/engine/test/players/injury.test.ts`가 결정적으로 못 박고 있다.
 *
 */

/** 한 경기의 온필드 인원 (양팀) — 경기당 기대 건수를 개인 확률로 나눌 때의 분모 */
const ON_PITCH = 22;

/** 유리몸 성향 — 상한 근처의 값 하나로 "성향이 빈도에 닿는가"만 본다 */
const GLASS = 2.2;

/**
 * 팔마다 굴리는 경기 수 — **부상이 분모를 정한다.**
 *
 * 경기당 0.1건이라 12,000경기라야 1,300건이고 상대 표준편차가 2.8%, 두 팔의
 * 비로는 4%다. 4,000판에서는 그 잡음이 7%라 두 팔이 우연히 20% 벌어지는 것을
 * 봤다 — 밴드로 걸 수 없는 값이었다. 카드는 같은 표본에서 45,000장이라 0.5%로
 * 선다. 두 팔의 경기 수는 같아야 하므로 그 수를 여기 한 번만 적는다.
 */
const MATCHES = 12000;

const HOME = "chelsea";
const AWAY = "liverpool";

interface Tally {
  cards: number;
  /** 퇴장 줄 · 그중 두 번째 경고로 나온 것 */
  reds: number;
  secondYellows: number;
  injuries: number;
}

/**
 * **성향을 1로 눕힌 스쿼드** — 발생률을 기대치와 맞댈 때 쓴다.
 *
 * 부상 기대치는 성향 평균을 타고(`teamInjuryRate`) 그 평균은 뛴 선수 전원(선발 +
 * 투입된 교체)을 센다. 성향이 빈도에 닿는지는 아래 유리몸 두 지표가 따로 재므로,
 * 여기서는 눕히고 발생률만 본다.
 */
function flat(squad: SimSquad): SimSquad {
  return { ...squad, proneness: {} };
}

function quickArm(home: SimSquad, away: SimSquad, runs: number, channel: string): Tally {
  const tally: Tally = { cards: 0, reds: 0, secondYellows: 0, injuries: 0 };
  for (let i = 0; i < runs; i++) {
    const one = quickSimulate(home, away, 2000 + i, `${channel}:${i}`);
    tally.cards += one.cards.length;
    for (const red of one.cards.filter((c) => c.card === "red")) {
      tally.reds += 1;
      // 두 번째 경고는 같은 분·같은 선수의 경고 한 줄 + 퇴장 한 줄이다 (match.md §5)
      if (one.cards.some((c) => c.card === "yellow" && c.playerId === red.playerId))
        tally.secondYellows += 1;
    }
    tally.injuries += one.injuries.length;
  }
  return tally;
}

/**
 * 위험 등급을 **갈라 세운 선발 열한 명** — 넷은 신선, 넷은 지친 몸, 셋은 지친 유리몸.
 *
 * ⚠️ **체력은 스쿼드를 세운 뒤에 누른다.** `simSquadOf`는 지친 선발을 스스로 빼므로
 * (`ROTATION_FATIGUE`), 세우기 전에 내리면 재려던 선수가 그 경기에 서지 않는다.
 * 성향은 반대다 — 스쿼드가 만드는 지도에 실려 나가므로 세우기 **전**에 심는다.
 */
function riskSpread(index: number): { condition: number; proneness: number } {
  if (index < 4) return { condition: 100, proneness: 1 };
  if (index < 8) return { condition: 62, proneness: 1 };
  return { condition: 45, proneness: 1.7 };
}

/**
 * **잔고만 다른 두 무리** — 시즌이 쌓아 둔 부하가 굴림에 닿는가 (player.md §5.5).
 *
 * 등급 팔(`gradeArm`)이 재는 것은 「등급이 부상률 순서로 서는가」라 체력·성향으로
 * 등급을 갈라 심는다. 여기서 재는 것은 그와 다른 질문이다: **체력이 가득한 선수끼리**
 * 잔고만 갈랐을 때 저울이 실제로 기우는가. 갈라 두지 않으면 새 항이 0으로 곱해져도
 * 다른 항의 신호에 묻혀 아무도 눈치채지 못한다.
 */
const LOADED = 70;

/** 잔고 팔의 몸싸움 — 열한 명을 같은 값으로 눕힌다 (저울의 다른 항이 갈리면 안 된다) */
const LOAD_ARM_STRENGTH = 70;

function loadArm(runs: number): { fresh: number; loaded: number; injuries: [number, number] } {
  const state = createTestGame(11);
  const home = flat({ ...simSquadOf(state, HOME, leagueOfTeamIn(state, HOME)), bench: [] });
  /**
   * ⚠️ **스쿼드를 세운 뒤에 심는다** — `simSquadOf`가 잔고로도 로테이션하므로
   * (`ROTATION_LOAD`), 세우기 전에 심으면 재려던 선수가 그 경기에 서지 않는다.
   *
   * 체력·몸싸움을 전원 같은 값으로 눕히고 성향은 `flat`이 지운다 — 갈리는 항이
   * 잔고 하나뿐이라야 비가 곧 그 항의 크기다.
   */
  const loadedIds = new Set<string>();
  home.starters.forEach((p, i) => {
    p.state.condition = CONDITION_MAX;
    p.attributes.strength = LOAD_ARM_STRENGTH;
    if (i % 2 === 0) return;
    p.state.fatigue = LOADED;
    loadedIds.add(p.id);
  });
  const away = flat({ ...simSquadOf(state, AWAY, leagueOfTeamIn(state, AWAY)), bench: [] });
  const injuries: [number, number] = [0, 0];
  for (let i = 0; i < runs; i++) {
    for (const tag of quickSimulate(home, away, 7000 + i, `load:${i}`).injuries) {
      if (!tag.startsWith("home:")) continue;
      injuries[loadedIds.has(tag.slice("home:".length)) ? 1 : 0] += 1;
    }
  }
  return {
    fresh: home.starters.length - loadedIds.size,
    loaded: loadedIds.size,
    injuries,
  };
}

/** 등급별 노출(선수 × 경기)과 실제 부상 건수 */
interface GradeTally {
  exposure: Record<InjuryRiskGrade, number>;
  injuries: Record<InjuryRiskGrade, number>;
  players: Record<InjuryRiskGrade, number>;
}

/**
 * **등급이 실제 부상률과 같은 순서로 서는가** (player.md §5.3).
 *
 * 등급은 굴림에 닿지 않고 `injuryWeight`를 낱말로 옮기기만 하므로, 이 비가 무너졌다면
 * 경계가 분포에서 떨어져 나갔거나 저울의 항이 움직인 것이다. 벤치를 비우는 이유는
 * 추첨 후보가 **뛴 선수 전원**이어서다 — 교체가 들어가면 노출의 분모가 흐려진다.
 */
function gradeArm(runs: number): GradeTally {
  const state = createTestGame(11);
  const home = { ...simSquadOf(state, HOME, leagueOfTeamIn(state, HOME)), bench: [] };
  home.proneness = Object.fromEntries(home.starters.map((p, i) => [p.id, riskSpread(i).proneness]));
  home.starters.forEach((p, i) => {
    p.state.condition = riskSpread(i).condition;
  });
  const away = { ...simSquadOf(state, AWAY, leagueOfTeamIn(state, AWAY)), bench: [] };

  const gradeOf = new Map(
    home.starters.map((p) => [p.id, injuryRiskOf(p, home.proneness?.[p.id]).grade]),
  );
  const zero = (): Record<InjuryRiskGrade, number> => ({ low: 0, elevated: 0, high: 0 });
  const tally: GradeTally = { exposure: zero(), injuries: zero(), players: zero() };
  for (const grade of gradeOf.values()) {
    tally.players[grade] += 1;
    tally.exposure[grade] += runs;
  }
  for (let i = 0; i < runs; i++) {
    const one = quickSimulate(home, away, 9000 + i, `grade:${i}`);
    for (const tag of one.injuries) {
      if (!tag.startsWith("home:")) continue;
      const grade = gradeOf.get(tag.slice("home:".length));
      if (grade !== undefined) tally.injuries[grade] += 1;
    }
  }
  return tally;
}

describe("간이 시뮬은 기대한 눈금으로 카드와 부상을 낸다", () => {
  it("경기당 건수 · 기대 대비 배율 · 성향이 닿는 폭", () => {
    const state = createTestGame(11);
    const home = simSquadOf(state, HOME, leagueOfTeamIn(state, HOME));
    const away = simSquadOf(state, AWAY, leagueOfTeamIn(state, AWAY));
    const intensity = {
      home: matchIntensity(home.tactics ?? DEFAULT_TACTICS),
      away: matchIntensity(away.tactics ?? DEFAULT_TACTICS),
    };
    /**
     * 기대치는 **손잡이에서 유도한다** — 눈금을 조정해도 하네스가 따라온다.
     * 성향은 두 팔 모두 1이므로(`flat`) 강도만 실린다.
     */
    const expected = {
      cards: teamCardRate(intensity.home) + teamCardRate(intensity.away),
      injuries: teamInjuryRate(intensity.home) + teamInjuryRate(intensity.away),
    };

    const quick = quickArm(flat(home), flat(away), MATCHES, "rate");

    // 유리몸 두 지표는 성향을 살린 세계에서 잰다 — 기준선도 같은 세계여야 한다
    const healthy = quickArm(home, away, MATCHES, "healthy");
    const fragileHome = {
      ...home,
      proneness: Object.fromEntries(
        [...home.starters, ...(home.bench ?? [])].map((p) => [p.id, GLASS]),
      ),
    };
    const fragile = quickArm(fragileHome, away, MATCHES, "healthy");

    const glass = home.starters[3]!;
    const shareHome = { ...home, proneness: { ...home.proneness, [glass.id]: GLASS } };
    const shareAway = away;
    let hisShare = 0;
    let homeInjuries = 0;
    for (let i = 0; i < MATCHES; i++) {
      const r = quickSimulate(shareHome, shareAway, 5000 + i, `share:${i}`);
      for (const tag of r.injuries) {
        if (!tag.startsWith("home:")) continue;
        homeInjuries++;
        if (tag === `home:${glass.id}`) hisShare++;
      }
    }

    const grades = gradeArm(MATCHES);
    const gradeRate = (grade: InjuryRiskGrade) =>
      grades.injuries[grade] / Math.max(1, grades.exposure[grade]);

    const load = loadArm(MATCHES);
    const freshRate = load.injuries[0] / Math.max(1, load.fresh * MATCHES);
    const loadedRate = load.injuries[1] / Math.max(1, load.loaded * MATCHES);

    const per = (n: number) => n / MATCHES;
    const readings: Readings<typeof INJURY_RATE> = {
      "경기 강도 (양 팀 평균)": (intensity.home + intensity.away) / 2,
      "경기당 부상 건수 (간이)": per(quick.injuries),
      "부상 기대 대비 배율 (간이)": per(quick.injuries) / expected.injuries,
      "경기당 카드 (간이)": per(quick.cards),
      "카드 기대 대비 배율 (간이)": per(quick.cards) / expected.cards,
      "경기당 퇴장 (간이)": per(quick.reds),
      "퇴장 중 두 번째 경고 몫 (간이)": quick.secondYellows / Math.max(1, quick.reds),
      "유리몸 팀 배율": fragile.injuries / Math.max(1, healthy.injuries),
      "유리몸 한 명의 부상 점유율": hisShare / Math.max(1, homeInjuries),
      "위험 낮음 인원": grades.players.low,
      "위험 보통 인원": grades.players.elevated,
      "위험 높음 인원": grades.players.high,
      "1인당 부상률 — 위험 낮음": gradeRate("low"),
      "1인당 부상률 — 위험 보통": gradeRate("elevated"),
      "1인당 부상률 — 위험 높음": gradeRate("high"),
      "부상률 — 보통/낮음": gradeRate("elevated") / Math.max(1e-9, gradeRate("low")),
      "부상률 — 높음/낮음": gradeRate("high") / Math.max(1e-9, gradeRate("low")),
      "1인당 부상률 — 잔고 0": freshRate,
      [`1인당 부상률 — 잔고 ${LOADED}`]: loadedRate,
      [`부상률 — 잔고 ${LOADED}/0`]: loadedRate / Math.max(1e-9, freshRate),
    };
    console.log(
      reportOf(
        INJURY_RATE,
        readings,
        `${HOME} vs ${AWAY} · 간이 ${(MATCHES * 6).toLocaleString()}판 · 기대 부상 ${expected.injuries.toFixed(3)}건 · 기대 카드 ${expected.cards.toFixed(2)}장 (개인 확률 ${(expected.injuries / ON_PITCH).toFixed(4)})`,
      ),
    );
    expect(outOfBand(INJURY_RATE, readings)).toEqual([]);
  });
});

/** 시즌 중 선발의 평균 체력 — `ai-rotation`의 「선발 평균 체력」 실측 */
const SEASON_STARTER_CONDITION = 95;

describe("간이 시뮬의 연장 · 퇴장 · 교체 · 페널티", () => {
  it("quick-outcomes", () => {
    const state = createTestGame(3);
    const squad = (id: string) => simSquadOf(state, id, leagueOfTeamIn(state, id));

    // 연장 — 같은 두 팀의 30분을 200번
    const home = squad("mancity");
    const away = squad("arsenal");
    let extraGoals = 0;
    let extraCards = 0;
    for (let i = 0; i < 200; i++) {
      const r = simulateExtraTime(home, away, 500 + i, `extra:${i}`);
      extraGoals += r.homeGoals + r.awayGoals;
      extraCards += r.cards.length;
    }

    // 퇴장 — 미드필더 하나를 뺀 열 명과 열한 명을 같은 상대에 150번씩
    const total = { eleven: { scored: 0, conceded: 0 }, ten: { scored: 0, conceded: 0 } };
    for (const [h, a] of [
      ["mancity", "hull"],
      ["arsenal", "everton"],
      ["fulham", "wolves"],
    ] as const) {
      const eleven = squad(h);
      const opponent = squad(a);
      const gone = eleven.starters.find((p) => positionGroupOfPlayer(p) === "MF")!;
      const ten = { ...eleven, starters: eleven.starters.filter((p) => p.id !== gone.id) };
      for (const key of ["eleven", "ten"] as const)
        for (let i = 0; i < 150; i++) {
          const r = quickSimulate(
            key === "eleven" ? eleven : ten,
            opponent,
            10000 + i,
            `red:${h}:${i}`,
          );
          total[key].scored += r.homeGoals;
          total[key].conceded += r.awayGoals;
        }
    }

    // 교체 · 페널티 — EPL 전 대진 한 바퀴. 새 세계의 체력은 개막 전의 몸(평균 78쯤)이라
    // 그대로 재면 하프타임 교체가 쏟아진다 — 시즌 중 선발의 몸(`ai-rotation`이 재는 95쯤)으로 세운다
    const epl = state.teams.map((t) => t.id).filter((id) => leagueOfTeamIn(state, id) === "epl");
    const inSeason = (s: SimSquad): SimSquad => {
      const rested = (p: SimSquad["starters"][number]) => ({
        ...p,
        state: { ...p.state, condition: SEASON_STARTER_CONDITION },
      });
      return { ...s, starters: s.starters.map(rested), bench: (s.bench ?? []).map(rested) };
    };
    const squads = new Map(epl.map((id) => [id, inSeason(squad(id))] as const));
    const subMinutes: number[] = [];
    let teamGames = 0;
    const designated: number[] = [];
    const topFive: number[] = [];
    const keeperOf = (s: SimSquad) =>
      s.starters.find((p) => positionGroupOfPlayer(p) === "GK") ?? null;
    for (const h of epl) {
      for (const a of epl) {
        if (h === a) continue;
        const r = quickSimulate(squads.get(h)!, squads.get(a)!, 20000, `subs:${h}:${a}`);
        teamGames += 2;
        for (const sub of r.subs) subMinutes.push(sub.minute);
        const ours = squads.get(h)!;
        const theirKeeper = keeperOf(squads.get(a)!);
        const taker = takerOnPitch(ours.setPieceTakers?.penalty, "penalty", ours.starters);
        if (taker) designated.push(penaltyRate(taker, theirKeeper));
        const order = ours.starters
          .filter((p) => positionGroupOfPlayer(p) !== "GK")
          .map((p) => penaltyRate(p, theirKeeper))
          .sort((x, y) => y - x)
          .slice(0, 5);
        topFive.push(...order);
      }
    }
    const sorted = [...subMinutes].sort((x, y) => x - y);
    const avg = (xs: number[]) => xs.reduce((x, y) => x + y, 0) / Math.max(1, xs.length);

    const readings: Readings<typeof QUICK_OUTCOMES> = {
      "연장 득점/경기": extraGoals / 200,
      "연장 카드/경기": extraCards / 200,
      "열 명/열한 명 실점 비": total.ten.conceded / total.eleven.conceded,
      "열 명/열한 명 득점 비": total.ten.scored / total.eleven.scored,
      "간이 AI 교체/팀": subMinutes.length / Math.max(1, teamGames),
      "간이 교체 중앙 분": sorted[Math.floor(sorted.length / 2)] ?? Number.NaN,
      "간이 교체 하프타임 몫":
        subMinutes.filter((m) => m === 45).length / Math.max(1, subMinutes.length),
      "지정 키커 페널티 성공률 (기대)": avg(designated),
      "필드 상위 다섯 페널티 성공률 (기대)": avg(topFive),
    };
    console.log(
      reportOf(
        QUICK_OUTCOMES,
        readings,
        `연장 200 · 퇴장 대조 900 · EPL 전 대진 ${teamGames / 2}경기`,
      ),
    );
    expect(outOfBand(QUICK_OUTCOMES, readings)).toEqual([]);
  });
});
