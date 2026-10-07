import type { Formation, MatchRecord, MatchSide, MatchStatLine, TacticsSpec } from "@gaffer/domain";
import { FAMILIARITY_BASELINE, FORMATIONS, otherSide, weightSlotOf } from "@gaffer/domain";
import {
  HEADER_SHOT_HEIGHT,
  depthOf,
  playLiveToEnd,
  possessionOf,
  sideStatLine,
  type LiveMatch,
  type LiveTickObserver,
} from "@gaffer/sim";
import {
  buildAiLiveMatch,
  buildAssignments,
  firstTeamPlayers,
  leagueOfTeamIn,
  tacticsOf,
  type GameState,
} from "@gaffer/engine";
import { initialTactics } from "../src/app/create-game";
import { defaultXiIds } from "../src/players/catalog/catalog";

/**
 * 실시간 경기 하네스들이 같이 쓰는 실행기 — 두 AI 팀의 경기를 화면 없이 끝까지 굴리고
 * 팀-경기 표본으로 접는다. 하네스가 아니라서 `*.harness.ts`가 아니다.
 */

/** 두 AI 팀의 경기를 종료 휘슬까지 — 러너의 화면 없는 실행기 그대로다 */
export const playToEnd = playLiveToEnd;

/** 킥오프 전술을 갈아 끼운 AI 경기 — 벤치가 옮기는 기준도 이 값이다 */
export function liveMatchWith(
  state: GameState,
  fixture: MatchRecord,
  tactics?: Partial<Record<MatchSide, Partial<TacticsSpec>>>,
): LiveMatch {
  const live = buildAiLiveMatch(state, fixture);
  for (const side of ["home", "away"] as const) {
    const over = tactics?.[side];
    if (!over) continue;
    live.tactics[side] = { ...live.tactics[side], ...over };
    live.setup.sides[side].kickoffTactics = { ...live.setup.sides[side].kickoffTactics, ...over };
  }
  return live;
}

export interface TeamSample {
  teamId: string;
  side: MatchSide;
  /** 킥오프의 모양 — 모양마다 같은 밴드를 거는 하네스가 표본을 가른다 (자유 배치면 프리셋 밖 이름) */
  formation: string;
  goals: number;
  line: MatchStatLine;
  possession: number;
  yellows: number;
  reds: number;
  /** 퇴장 중 두 번째 경고로 나온 것 — 같은 선수의 경고 줄이 먼저 있다 */
  secondYellows: number;
  /** 이 팀 선수가 쓰러진 수 */
  injuries: number;
}

export interface MatchSample {
  teams: TeamSample[];
  home: number;
  away: number;
  /** 추가시간을 넣은 경기 길이 (분) */
  length: number;
  /** 볼 인플레이 몫 — 재시작이 아닌 시간 ÷ 경기 시간 */
  inPlay: number;
}

export function sampleOf(match: LiveMatch): MatchSample {
  const possession = possessionOf(match);
  const events = match.ledger.events;
  const addedOf = (type: string) => events.find((e) => e.type === type)?.added ?? 0;
  const length = 90 + addedOf("half_time") + addedOf("full_time");
  const played = match.state.possessionTime.home + match.state.possessionTime.away;
  const teams = (["home", "away"] as const).map((side) => ({
    teamId: match.setup.sides[side].teamId,
    side,
    formation: match.setup.sides[side].kickoffTactics.formation,
    goals: match.ledger.score[side],
    line: sideStatLine(match.ledger, side),
    possession: possession[side],
    yellows: events.filter((e) => e.type === "yellow_card" && e.team === side).length,
    reds: events.filter((e) => e.type === "red_card" && e.team === side).length,
    secondYellows: events.filter(
      (e) =>
        e.type === "red_card" &&
        e.team === side &&
        events.some((y) => y.type === "yellow_card" && y.actors[0] === e.actors[0]),
    ).length,
    injuries: events.filter((e) => e.type === "injury" && e.team === side).length,
  }));
  return {
    teams,
    home: match.ledger.score.home,
    away: match.ledger.score.away,
    length,
    inPlay: played / (length * 60),
  };
}

/**
 * 그 팀을 프리셋 포메이션으로 다시 세운다 — **그 팀이 그 모양으로 세워졌다면**의 전술·선발·벤치다.
 * 전술 적응도는 기준선이다: 팔마다 같은 출발선이라야 포메이션의 차이만 남는다.
 *
 * 세계를 세울 때와 같은 지정 선발(`defaultXiIds`)을 넘긴다 — 빼면 같은 모양으로 다시 짜기만
 * 해도 다른 열한 명이 서서, 모양이 아니라 선발이 바뀐 값을 잰다.
 */
export function withFormation(state: GameState, teamId: string, formation: Formation): void {
  const tactics = tacticsOf(state, teamId);
  // 여섯 축도 세계를 세울 때의 그것이다 — 연구된 성향이 없는 구단은 모양이 축을 정한다
  tactics.spec = initialTactics(teamId, formation);
  tactics.assignments = buildAssignments(
    firstTeamPlayers(state, teamId),
    formation,
    FAMILIARITY_BASELINE,
    undefined,
    defaultXiIds(teamId),
  );
}

/**
 * 하네스가 도는 모양 — **프리셋 전부다.** 시드 세계는 감독 리그(EPL)의 열일곱 팀이
 * 4-2-3-1을 고르므로, 모양을 세계에 맡기면 경기 하네스는 한 모양의 거울 경기만 잰다.
 */
export const FORMATION_ARMS: readonly Formation[] = FORMATIONS;

/**
 * 대진 `i`의 (홈, 원정) 모양 — 연속한 49경기가 7×7 순서쌍을 한 번씩 덮는다.
 * `offset`은 시드마다 같은 쌍에 다른 팀이 서게 민다.
 */
export function formationPairOf(i: number, offset = 0): [Formation, Formation] {
  const n = FORMATION_ARMS.length;
  return [FORMATION_ARMS[(i + offset) % n]!, FORMATION_ARMS[(Math.floor(i / n) + 2 * offset) % n]!];
}

/** 대진 하나를 그 모양 쌍으로 세운 실시간 경기 */
export function liveMatchIn(
  state: GameState,
  fixture: MatchRecord,
  [home, away]: readonly [Formation, Formation],
  tactics?: Partial<Record<MatchSide, Partial<TacticsSpec>>>,
): LiveMatch {
  withFormation(state, fixture.homeTeamId, home);
  withFormation(state, fixture.awayTeamId, away);
  return liveMatchWith(state, fixture, tactics);
}

/**
 * 시즌을 굴리는 하네스의 세계 — **리그마다 팀에 프리셋을 돌려 준다** (팀 id 순).
 * AI는 모양을 세계를 세울 때 한 번 고르므로 준 모양이 시즌 내내 선다. 감독 팀도 같다.
 */
export function assignLeagueFormations(state: GameState, offset = 0): Map<string, Formation> {
  const byLeague = new Map<string, string[]>();
  for (const { teamId } of state.tactics) {
    const league = leagueOfTeamIn(state, teamId);
    byLeague.set(league, [...(byLeague.get(league) ?? []), teamId]);
  }
  const given = new Map<string, Formation>();
  for (const teams of byLeague.values()) {
    [...teams].sort().forEach((teamId, i) => {
      const formation = FORMATION_ARMS[(i + offset) % FORMATION_ARMS.length]!;
      withFormation(state, teamId, formation);
      given.set(teamId, formation);
    });
  }
  return given;
}

/** 모양별로 가른 표본 — 키는 언제나 프리셋 일곱이다 */
export function byFormation<T>(): Record<Formation, T[]> {
  return Object.fromEntries(FORMATION_ARMS.map((f) => [f, [] as T[]])) as Record<Formation, T[]>;
}

/**
 * 모양 효과를 원값에서 세운다 — `"<모양> — <지표>"`의 일곱 값을 그 평균과 견준다. 비로 읽는
 * 지표(`ratio`)와 차로 읽는 지표(`difference`, 점유·몫)를 나눠 받는다. 밴드는 실측 쪽의 같은
 * 셈에서 나온다 (catalog.ts `FORMATION_PROFILE`).
 */
export function addShapeEffects(
  readings: Record<string, number>,
  labels: { ratio?: readonly string[]; difference?: readonly string[] },
): void {
  const raw = (f: Formation, label: string) => readings[`${f} — ${label}`] ?? Number.NaN;
  for (const [kind, list] of [
    ["ratio", labels.ratio ?? []],
    ["difference", labels.difference ?? []],
  ] as const) {
    for (const label of list) {
      const center = mean(FORMATION_ARMS.map((f) => raw(f, label)));
      for (const f of FORMATION_ARMS)
        readings[`${f} — ${label} (모양 효과)`] =
          kind === "ratio" ? raw(f, label) / center : raw(f, label) - center;
    }
  }
}

/** 감독 리그의 대진 앞에서부터 `count`경기 */
export function leagueFixtures(state: GameState, count: number): MatchRecord[] {
  const league = leagueOfTeamIn(state, state.userTeamId);
  return state.matches
    .filter((m) => m.competitionId === league && m.stage === "league")
    .slice(0, count);
}

export const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
export const sd = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};
export const median = (xs: number[]) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
};
export const share = (xs: number[], test: (x: number) => boolean) =>
  xs.filter(test).length / Math.max(1, xs.length);

/** 정렬한 표본의 분위 — 0..1 */
export const quantile = (xs: number[], q: number) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? Number.NaN;
};

/** 풀백의 깊이를 이만큼 틱마다 적는다 — 1초 */
const DEPTH_SAMPLE_TICKS = 20;

/**
 * 장부에 없는 배치를 재는 관찰자 — 슈팅 순간 공보다 골 쪽에 선 수비 필드 선수 수와,
 * 풀백마다 경기 중 선 깊이(우리 골라인에서)의 표본 (live-match.md §3.3 · §5.2).
 */
export interface ShapeProbe {
  onTick: LiveTickObserver;
  /** 슈팅 한 번마다 — 공보다 골 쪽의 수비 필드 선수 수 */
  goalSide: number[];
  /** 풀백 id → 1초마다의 깊이 */
  fullBackDepths: Map<string, number[]>;
  /** 풀백 id → 우리가 공을 가졌을 때 달리기(`run`)를 시작한 횟수 — 오버래핑·침투 */
  fullBackRuns: Map<string, number>;
  /**
   * 떠난 순서대로의 슛 — 헤더인가 · 목표까지의 거리(m) · 찬 순간의 자리. 장부의 슛 사건에는
   * 몸의 부위도 거리도 없고, `positionsPlayed`는 교체로 자리를 옮긴 선수의 **마지막** 자리라
   * 그 전에 찬 슛의 자리를 모른다. 공은 하나라 슛은 떠난 순서대로 끝나므로 장부의 `shot`·`goal` 사건과
   * 순서로 짝지어진다.
   */
  shots: Array<{ header: boolean; distance: number; position: string }>;
}

export function shapeProbe(): ShapeProbe {
  const probe: ShapeProbe = {
    onTick: () => {},
    goalSide: [],
    fullBackDepths: new Map(),
    fullBackRuns: new Map(),
    shots: [],
  };
  let lastFlight = "";
  let lastShot: Record<MatchSide, number> | null = null;
  const running = new Set<string>();
  probe.onTick = (state, input) => {
    const positionOf = (id: string) =>
      (
        input.home.slots.find((s) => s.player.id === id) ??
        input.away.slots.find((s) => s.player.id === id)
      )?.position ?? "";
    const slotOf = (id: string) => weightSlotOf(positionOf(id));
    for (const side of ["home", "away"] as const) {
      if (lastShot && state.lastShotAt[side] !== lastShot[side] && !state.restart) {
        const defending = otherSide(side);
        const ballDepth = depthOf(state.ball.x, defending);
        probe.goalSide.push(
          state.players.filter(
            (p) =>
              p.side === defending && slotOf(p.id) !== "GK" && depthOf(p.x, defending) < ballDepth,
          ).length,
        );
      }
    }
    lastShot = { ...state.lastShotAt };
    const flight = state.ball.flight;
    const key = flight?.kind === "shot" ? `${flight.from}:${flight.to.x}:${flight.to.y}` : "";
    if (flight && key && key !== lastFlight) {
      // 헤더 슛은 높이가 정확히 `HEADER_SHOT_HEIGHT`다 — 발 슛은 0.3~1.7에서 연속으로 뽑혀
      // 높이 문턱으로는 가를 수 없다
      probe.shots.push({
        header: flight.height === HEADER_SHOT_HEIGHT,
        distance: flight.distance,
        position: positionOf(flight.from),
      });
    }
    lastFlight = key;
    for (const p of state.players) {
      const run = p.action === "run" && p.side === state.possession;
      if (run && !running.has(p.id) && slotOf(p.id) === "FB") {
        probe.fullBackRuns.set(p.id, (probe.fullBackRuns.get(p.id) ?? 0) + 1);
      }
      if (run) running.add(p.id);
      else running.delete(p.id);
    }
    if (state.tick % DEPTH_SAMPLE_TICKS !== 0 || state.restart) return;
    for (const p of state.players) {
      if (slotOf(p.id) !== "FB") continue;
      const depths = probe.fullBackDepths.get(p.id) ?? [];
      depths.push(depthOf(p.x, p.side));
      probe.fullBackDepths.set(p.id, depths);
    }
  };
  return probe;
}
