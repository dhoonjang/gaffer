import { playerOverall, weightSlotOf, type MatchEvent, type WeightSlot } from "@gaffer/domain";
import { describe, expect, it } from "vitest";
import { EXPECTED_LOAD, type LiveMatch } from "@gaffer/sim";
import { quickSimulate, simSquadOf } from "@gaffer/engine";
import { createTestGame } from "../test/helpers";
import { LIVE_GOAL_ANATOMY, LIVE_MATCH_STATS, LIVE_PLAYER_LOAD, SIM_PARITY } from "./catalog";
import { outOfBand, reportOf, type Readings } from "./harness";
import {
  leagueFixtures,
  liveMatchWith,
  mean,
  median,
  playToEnd,
  quantile,
  sampleOf,
  shapeProbe,
  sd,
  share,
  type MatchSample,
  type ShapeProbe,
  type TeamSample,
} from "./live-runs";

/**
 * **전술을 건드리지 않은 실시간 경기 한 벌** — 시드 세계의 리그 대진을 두 AI 팀으로 끝까지
 * 굴리고, 그 같은 경기들을 네 서술자가 나눠 읽는다 (live-match.md §9.3 · football-reference.md).
 *
 * - `live-match-stats` — 팀 통계의 평균·중간값·sd
 * - `live-goal-anatomy` — 골과 슛이 언제·어디서·누구에게서·무엇으로 나왔는가
 * - `live-player-load` — 풀타임 선수의 포지션별 거리·고속·스프린트
 * - `sim-parity` — 같은 대진을 간이 시뮬로 굴린 값과의 눈금
 *
 * 경기는 결정적이라 서술자마다 따로 굴리면 같은 경기를 몇 번이고 다시 굴린다. 한 번 굴려
 * 넷이 읽는다 — 표본은 가장 큰 요구(`sim-parity`의 기울기)에 맞춘다.
 *
 *   pnpm balance live-baseline
 */

const SEEDS = [42, 7, 3];
/** 기울기는 대진 수의 제곱근으로만 좁혀진다 — 24경기로는 같은 설정에서 비가 20~80%로 흔들렸다 */
const MATCHES_PER_SEED = 24;
/** 대진마다 간이 시뮬을 굴리는 횟수 — 실시간 한 판의 잡음보다 한참 작게 */
const QUICK_DRAWS = 20;

// ── live-player-load ──

type LoadGroup = "GK" | "CB" | "FB" | "CM" | "W" | "ST";
const LOAD_GROUP_OF: Record<WeightSlot, LoadGroup> = {
  GK: "GK",
  CB: "CB",
  FB: "FB",
  DM: "CM",
  CM: "CM",
  AM: "CM",
  W: "W",
  CF: "ST",
  ST: "ST",
};

interface Load {
  distance: number;
  highSpeed: number;
  sprint: number;
  /** 그 자리의 기대 부하표 거리 */
  expected: number;
}

/** 교체·퇴장·부상으로 나가지 않고 90분을 다 뛴 선발만 — 들어온 몇 분은 부하를 재지 못한다 */
function fullTimeLoads(live: LiveMatch, starters: ReadonlySet<string>): Array<[LoadGroup, Load]> {
  const left = new Set(
    live.ledger.events
      .filter((e) => e.type === "substitution" || e.type === "red_card" || e.type === "injury")
      .map((e) => e.actors[0] ?? ""),
  );
  const out: Array<[LoadGroup, Load]> = [];
  for (const id of starters) {
    if (left.has(id)) continue;
    const slot = weightSlotOf(live.positionsPlayed[id] ?? "");
    const line = live.ledger.stats[id];
    if (!line) continue;
    out.push([
      LOAD_GROUP_OF[slot],
      {
        distance: line.distance,
        highSpeed: line.highSpeed,
        sprint: line.sprint,
        expected: EXPECTED_LOAD[slot].distance,
      },
    ]);
  }
  return out;
}

// ── live-goal-anatomy ──

/** 슈팅·득점 몫을 가르는 묶음 — football-reference.md §8의 표 그대로 */
type ShotGroup = "ST" | "W" | "CM" | "AM" | "FB" | "CB";
const SHOT_GROUP_OF: Partial<Record<WeightSlot, ShotGroup>> = {
  CB: "CB",
  FB: "FB",
  DM: "CM",
  CM: "CM",
  AM: "AM",
  W: "W",
  CF: "ST",
  ST: "ST",
};

interface Anatomy {
  shots: MatchEvent[];
  goals: MatchEvent[];
  /** 슛·골의 주인이 선 자리 묶음 */
  groupOf: Map<MatchEvent, ShotGroup | undefined>;
  /** 관찰자가 본 비행 — 헤더인가 · 목표까지의 거리. 짝이 어긋난 경기의 슛은 없다 */
  flightOf: Map<MatchEvent, ShapeProbe["shots"][number]>;
  /** 장부의 슛과 관찰자의 비행 수가 갈린 경기 — 0이 아니면 아래 짝짓기를 믿을 수 없다 */
  unpaired: number;
}

function anatomyOf(live: LiveMatch, flights: ShapeProbe["shots"], into: Anatomy): void {
  const events = live.ledger.events.filter((e) => e.type === "shot" || e.type === "goal");
  const paired = events.length === flights.length;
  if (!paired) into.unpaired += 1;
  events.forEach((e, i) => {
    const slot = weightSlotOf(live.positionsPlayed[e.actors[0] ?? ""] ?? "");
    into.groupOf.set(e, SHOT_GROUP_OF[slot]);
    if (paired) into.flightOf.set(e, flights[i]!);
    into.shots.push(e);
    if (e.type === "goal") into.goals.push(e);
  });
}

const isSetPiece = (e: MatchEvent) => e.shotOrigin !== undefined && e.shotOrigin !== "open";

// ── sim-parity ──

interface Pair {
  /** 홈 − 원정 선발 평균 종합 능력치 */
  gap: number;
  live: { goals: [number, number]; xg: [number, number]; shots: [number, number] };
  quick: { goals: [number, number]; xg: [number, number]; shots: [number, number] };
}

/** 최소제곱 기울기 — y를 x에 */
function slope(xs: number[], ys: number[]): number {
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) ** 2;
  }
  return den > 0 ? num / den : Number.NaN;
}

/** 최소제곱 기울기의 표준오차 — 잔차의 분산 ÷ x의 제곱합 */
function slopeError(xs: number[], ys: number[], b: number): number {
  const mx = mean(xs);
  const my = mean(ys);
  let rss = 0;
  let sxx = 0;
  for (let i = 0; i < xs.length; i++) {
    const r = ys[i]! - my - b * (xs[i]! - mx);
    rss += r * r;
    sxx += (xs[i]! - mx) ** 2;
  }
  return xs.length > 2 && sxx > 0 ? Math.sqrt(rss / (xs.length - 2) / sxx) : Number.NaN;
}

describe("실시간 경기 기준판", () => {
  const matches: MatchSample[] = [];
  const goalSide: number[] = [];
  const fullBackSpans: number[] = [];
  const fullBackReach: number[] = [];
  const fullBackRuns: number[] = [];
  const loads: Record<LoadGroup, Load[]> = { GK: [], CB: [], FB: [], CM: [], W: [], ST: [] };
  const anatomy: Anatomy = {
    shots: [],
    goals: [],
    groupOf: new Map(),
    flightOf: new Map(),
    unpaired: 0,
  };
  const pairs: Pair[] = [];
  let label = "";

  it(`시드 ${SEEDS.join("·")} × 리그 ${MATCHES_PER_SEED}경기를 굴린다`, () => {
    for (const seed of SEEDS) {
      const state = createTestGame(seed);
      for (const fixture of leagueFixtures(state, MATCHES_PER_SEED)) {
        const live = liveMatchWith(state, fixture);
        const starters = new Set([...live.ledger.home.onPitch, ...live.ledger.away.onPitch]);
        const probe = shapeProbe();
        playToEnd(live, probe.onTick);
        const sample = sampleOf(live);
        matches.push(sample);

        goalSide.push(...probe.goalSide);
        // 30분 넘게 뛴 풀백만 — 교체로 들어온 몇 분은 범위를 재지 못한다
        for (const [id, depths] of probe.fullBackDepths) {
          if (depths.length < 30 * 60) continue;
          // 90분으로 환산한 달리기 수
          fullBackRuns.push(((probe.fullBackRuns.get(id) ?? 0) * 90 * 60) / depths.length);
          fullBackSpans.push(quantile(depths, 0.9) - quantile(depths, 0.1));
          fullBackReach.push(quantile(depths, 0.9));
        }
        for (const [group, load] of fullTimeLoads(live, starters)) loads[group].push(load);
        anatomyOf(live, probe.shots, anatomy);

        const home = simSquadOf(state, fixture.homeTeamId, fixture.competitionId);
        const away = simSquadOf(state, fixture.awayTeamId, fixture.competitionId);
        const strength = (squad: typeof home) => mean(squad.starters.map((p) => playerOverall(p)));
        const quick: Pair["quick"] = { goals: [0, 0], xg: [0, 0], shots: [0, 0] };
        for (let i = 0; i < QUICK_DRAWS; i++) {
          const r = quickSimulate(home, away, seed * 1000 + i, `parity:${fixture.id}:${i}`);
          quick.goals[0] += r.homeGoals / QUICK_DRAWS;
          quick.goals[1] += r.awayGoals / QUICK_DRAWS;
          quick.xg[0] += r.homeXg / QUICK_DRAWS;
          quick.xg[1] += r.awayXg / QUICK_DRAWS;
          quick.shots[0] += r.homeShots / QUICK_DRAWS;
          quick.shots[1] += r.awayShots / QUICK_DRAWS;
        }
        const [h, a] = sample.teams as [TeamSample, TeamSample];
        pairs.push({
          gap: strength(home) - strength(away),
          live: {
            goals: [h.goals, a.goals],
            xg: [h.line.xg, a.line.xg],
            shots: [h.line.shots, a.line.shots],
          },
          quick,
        });
      }
    }
    label = `시드 ${SEEDS.join("·")} × 리그 ${MATCHES_PER_SEED}경기 = ${matches.length}경기 · 두 AI 팀`;
    expect(matches.length).toBe(SEEDS.length * MATCHES_PER_SEED);
  });

  it("팀 통계가 실측 밴드에 선다 — live-match-stats", () => {
    const teams = matches.flatMap((m) => m.teams);
    const of = (pick: (t: TeamSample) => number) => teams.map(pick);
    const sum = (pick: (t: TeamSample) => number) => of(pick).reduce((x, y) => x + y, 0);
    const per = (num: (t: TeamSample) => number, den: (t: TeamSample) => number) =>
      sum(num) / Math.max(1e-9, sum(den));
    const goals = of((t) => t.goals);
    const shots = of((t) => t.line.shots);
    const xg = of((t) => t.line.xg);
    const passes = of((t) => t.line.passes);
    const readings: Readings<typeof LIVE_MATCH_STATS> = {
      "팀-경기 표본": teams.length,
      "팀 득점 평균": mean(goals),
      "팀 득점 sd": sd(goals),
      "팀 득점 0골": share(goals, (g) => g === 0),
      "팀 득점 1골": share(goals, (g) => g === 1),
      "팀 득점 2골": share(goals, (g) => g === 2),
      "팀 득점 3골": share(goals, (g) => g === 3),
      "팀 득점 4골+": share(goals, (g) => g >= 4),
      "무승부 비율": share(
        matches.map((m) => m.home - m.away),
        (d) => d === 0,
      ),
      "슈팅 평균": mean(shots),
      "슈팅 중간값": median(shots),
      "슈팅 sd": sd(shots),
      "유효슈팅 비율": per(
        (t) => t.line.shotsOnTarget,
        (t) => t.line.shots,
      ),
      "골/유효슈팅": per(
        (t) => t.goals,
        (t) => t.line.shotsOnTarget,
      ),
      "xG 평균": mean(xg),
      "xG sd": sd(xg),
      "슈팅당 xG": per(
        (t) => t.line.xg,
        (t) => t.line.shots,
      ),
      "득점/xG": per(
        (t) => t.goals,
        (t) => t.line.xg,
      ),
      "패스 시도 평균": mean(passes),
      "패스 시도 sd": sd(passes),
      "패스 성공률": per(
        (t) => t.line.passesCompleted,
        (t) => t.line.passes,
      ),
      "패스 성공률 sd": sd(of((t) => t.line.passesCompleted / Math.max(1, t.line.passes))),
      "점유율 sd": sd(of((t) => t.possession)),
      "태클 시도": mean(of((t) => t.line.tackles)),
      "태클 성공률": per(
        (t) => t.line.tacklesWon,
        (t) => t.line.tackles,
      ),
      인터셉트: mean(of((t) => t.line.interceptions)),
      "드리블 시도": mean(of((t) => t.line.dribbles)),
      파울: mean(of((t) => t.line.fouls)),
      경고: mean(of((t) => t.yellows)),
      퇴장: mean(of((t) => t.reds)),
      코너: mean(of((t) => t.line.corners)),
      크로스: mean(of((t) => t.line.crosses)),
      오프사이드: mean(of((t) => t.line.offsides)),
      "팀 총 거리 (km)": mean(of((t) => t.line.distance / 1000)),
      "팀 스프린트 거리 (km)": mean(of((t) => t.line.sprint / 1000)),
      "경기 길이 (분)": mean(matches.map((m) => m.length)),
      "볼 인플레이 몫": mean(matches.map((m) => m.inPlay)),
      "슈팅 순간 골 쪽 수비 수": mean(goalSide),
      "슈팅 순간 골 쪽 수비 수 sd": sd(goalSide),
      "풀백 깊이 폭 (p10~p90, m)": mean(fullBackSpans),
      "풀백 깊이 폭 sd (m)": sd(fullBackSpans),
      "풀백 앞 끝 (p90 깊이, m)": mean(fullBackReach),
      "풀백 오버래핑·침투 (회/90분)": mean(fullBackRuns),
      "풀백 오버래핑·침투 sd": sd(fullBackRuns),
    };
    console.log(reportOf(LIVE_MATCH_STATS, readings, label));
    expect(outOfBand(LIVE_MATCH_STATS, readings)).toEqual([]);
  });

  it("골과 슛의 시각·경로·자리가 실측 밴드에 선다 — live-goal-anatomy", () => {
    const { shots, goals } = anatomy;
    const teamGames = matches.length * 2;
    const ratio = (n: number, d: number) => n / Math.max(1, d);
    const count = (xs: MatchEvent[], test: (e: MatchEvent) => boolean) => xs.filter(test).length;
    const origin = (xs: MatchEvent[], kind: MatchEvent["shotOrigin"]) =>
      count(xs, (e) => e.shotOrigin === kind);
    const groupShare = (xs: MatchEvent[], group: ShotGroup) =>
      ratio(
        count(xs, (e) => anatomy.groupOf.get(e) === group),
        count(xs, (e) => anatomy.groupOf.get(e) !== undefined),
      );
    const penalties = origin(shots, "penalty");
    // 비행과 짝지어진 슛만 — 몸의 부위와 거리는 관찰자만 안다
    const seen = (xs: MatchEvent[]) => xs.filter((e) => anatomy.flightOf.has(e));
    const isHeader = (e: MatchEvent) => anatomy.flightOf.get(e)?.header === true;
    const readings: Readings<typeof LIVE_GOAL_ANATOMY> = {
      "골 표본": goals.length,
      "전반 득점 비중": ratio(
        count(goals, (e) => e.minute < 45 || (e.minute === 45 && e.added !== undefined)),
        goals.length,
      ),
      "90+ 득점 비중": ratio(
        count(goals, (e) => e.minute === 90 && e.added !== undefined),
        goals.length,
      ),
      "세트피스 득점 비중": ratio(count(goals, isSetPiece), goals.length),
      "세트피스 슈팅 비중": ratio(count(shots, isSetPiece), shots.length),
      "코너 슈팅/팀": ratio(origin(shots, "corner"), teamGames),
      "프리킥 슈팅/팀": ratio(origin(shots, "free_kick"), teamGames),
      "페널티/팀": ratio(penalties, teamGames),
      "페널티 성공률": ratio(origin(goals, "penalty"), penalties),
      "슛 짝이 어긋난 경기": anatomy.unpaired,
      "헤더 슈팅 비중": ratio(count(seen(shots), isHeader), seen(shots).length),
      "헤더 득점 비중": ratio(count(seen(goals), isHeader), seen(goals).length),
      "골 원인 header 비중": ratio(
        count(goals, (e) => e.causes.some((c) => c.code === "header")),
        goals.length,
      ),
      "슈팅 거리 중간값 (m)": median(seen(shots).map((e) => anatomy.flightOf.get(e)!.distance)),
      "18m 밖 슈팅 비중": ratio(
        count(seen(shots), (e) => anatomy.flightOf.get(e)!.distance > 18),
        seen(shots).length,
      ),
      "도움 붙은 골 비중": ratio(
        count(goals, (e) => e.actors.length > 1),
        goals.length,
      ),
      "슈팅 몫 — 스트라이커": groupShare(shots, "ST"),
      "슈팅 몫 — 측면": groupShare(shots, "W"),
      "슈팅 몫 — 중앙·수비형 미드": groupShare(shots, "CM"),
      "슈팅 몫 — 공격형 미드": groupShare(shots, "AM"),
      "슈팅 몫 — 풀백": groupShare(shots, "FB"),
      "슈팅 몫 — 센터백": groupShare(shots, "CB"),
      "득점 몫 — 스트라이커": groupShare(goals, "ST"),
      "득점 몫 — 수비수": groupShare(goals, "FB") + groupShare(goals, "CB"),
    };
    console.log(reportOf(LIVE_GOAL_ANATOMY, readings, label));
    expect(outOfBand(LIVE_GOAL_ANATOMY, readings)).toEqual([]);
  });

  it("풀타임 선수의 거리·고속·스프린트가 포지션의 실측에 선다 — live-player-load", () => {
    const km = (g: LoadGroup) => mean(loads[g].map((l) => l.distance)) / 1000;
    const hsr = (g: LoadGroup) => mean(loads[g].map((l) => l.highSpeed));
    const spr = (g: LoadGroup) => mean(loads[g].map((l) => l.sprint));
    const all = Object.values(loads).flat();
    const readings: Readings<typeof LIVE_PLAYER_LOAD> = {
      "풀타임 표본": all.length,
      "골키퍼 거리 (km)": km("GK"),
      "센터백 거리 (km)": km("CB"),
      "풀백 거리 (km)": km("FB"),
      "중앙 미드 거리 (km)": km("CM"),
      "측면 거리 (km)": km("W"),
      "공격수 거리 (km)": km("ST"),
      "센터백 고속 (m)": hsr("CB"),
      "풀백 고속 (m)": hsr("FB"),
      "중앙 미드 고속 (m)": hsr("CM"),
      "측면 고속 (m)": hsr("W"),
      "공격수 고속 (m)": hsr("ST"),
      "센터백 스프린트 (m)": spr("CB"),
      "풀백 스프린트 (m)": spr("FB"),
      "측면 스프린트 (m)": spr("W"),
      "공격수 스프린트 (m)": spr("ST"),
      "실측/기대 부하표 — 거리":
        mean(all.map((l) => l.distance)) / Math.max(1, mean(all.map((l) => l.expected))),
    };
    console.log(reportOf(LIVE_PLAYER_LOAD, readings, `${label} · 풀타임 선수만`));
    expect(outOfBand(LIVE_PLAYER_LOAD, readings)).toEqual([]);
  });

  it("같은 대진의 득점·xG·슈팅·기울기가 간이 시뮬과 같은 밴드에 선다 — sim-parity", () => {
    const perTeam = (pick: (p: Pair) => [number, number]) => mean(pairs.flatMap((p) => pick(p)));
    const ratioOf = (pick: (p: Pair) => [number, number], other: (p: Pair) => [number, number]) =>
      perTeam(pick) / Math.max(1e-9, perTeam(other));
    const gaps = pairs.map((p) => p.gap);
    const liveDiff = pairs.map((p) => p.live.xg[0] - p.live.xg[1]);
    const liveSlope = slope(gaps, liveDiff);
    const quickSlope = slope(
      gaps,
      pairs.map((p) => p.quick.xg[0] - p.quick.xg[1]),
    );
    const readings: Readings<typeof SIM_PARITY> = {
      대진: pairs.length,
      "팀 득점 — 실시간": perTeam((p) => p.live.goals),
      "팀 득점 — 간이": perTeam((p) => p.quick.goals),
      "팀 득점 — 실시간/간이": ratioOf(
        (p) => p.live.goals,
        (p) => p.quick.goals,
      ),
      "팀 xG — 실시간": perTeam((p) => p.live.xg),
      "팀 xG — 간이": perTeam((p) => p.quick.xg),
      "팀 xG — 실시간/간이": ratioOf(
        (p) => p.live.xg,
        (p) => p.quick.xg,
      ),
      "팀 슈팅 — 실시간/간이": ratioOf(
        (p) => p.live.shots,
        (p) => p.quick.shots,
      ),
      "전력 기울기 (xG 차/능력치 1) — 실시간": liveSlope,
      "전력 기울기 (xG 차/능력치 1) — 간이": quickSlope,
      "전력 기울기 표준오차 — 실시간": slopeError(gaps, liveDiff, liveSlope),
      "전력 기울기 — 실시간/간이": liveSlope / quickSlope,
    };
    console.log(reportOf(SIM_PARITY, readings, `${label} · 간이 ${QUICK_DRAWS}회씩`));
    expect(outOfBand(SIM_PARITY, readings)).toEqual([]);
  });
});
