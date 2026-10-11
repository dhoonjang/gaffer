import {
  FAMILIARITY_BASELINE,
  TacticsSpecSchema,
  type ClubColours,
  type Formation,
  type MatchRecord,
  type MatchSide,
  type TacticsSpec,
} from "@gaffer/domain";
import { liveFinished } from "@gaffer/sim";
import {
  type GameState,
  firstTeamPlayers,
  isAvailableFor,
  playerById,
  tacticsOf,
  teamNameIn,
  teamShortNameIn,
} from "../../core/state";
import { topLeagues } from "../../core/catalog/league-catalog";
import type { WorldScope } from "../../core/catalog/scope";
import { teamCatalog } from "../../core/catalog/team-catalog";
import { defaultXiIds } from "../../players/catalog/catalog";
import { buildAssignments } from "../../match/selection";
import { type FlowResult, markEntered, restoreTactics } from "../../match/match-flow";
import { setLineup, setTactics } from "../../team/lineup";
import { createGame } from "../create-game";
import { LAB_ID_PREFIX } from "../persistence";
import { startMatch } from "./match-flow";

/**
 * ── 경기 실험실 — 두 구단을 골라 경기 하나만 치르는 판 (match/live-match.md §8.6) ──
 *
 * 판은 진짜 세이브라 전술판·체크포인트·경기 중 지시가 게임의 라우트와 명령을 그대로
 * 지난다. 여기 있는 것은 게임에 없는 걸음뿐이다: 판 짓기, 두 팀의 프리셋 모양, 상대의
 * 전술, 적응도를 맞춘 킥오프, 킥오프 전으로 되돌리기.
 */

export interface LabSetup {
  homeTeamId: string;
  awayTeamId: string;
  /** 감독이 맡는 쪽 */
  managed: MatchSide;
  seed?: number | undefined;
}

export interface LabSideView {
  teamId: string;
  name: string;
  shortName: string;
  colours: ClubColours | null;
  /** 감독이 맡은 쪽인가 */
  ours: boolean;
  /** 저장된 판 — 경기 중 AI의 전환은 실리지 않는다 (그것은 `MatchView`의 몫이다) */
  tactics: TacticsSpec;
}

export interface LabView {
  /** 이 판에서 몇 번째 경기인가 — 다시 치를 때마다 하나씩 는다 */
  matchNo: number;
  seed: number;
  sides: Record<MatchSide, LabSideView>;
  /** 종료 휘슬이 울렸나 */
  finished: boolean;
}

/** 판을 고치는 쪽 — 우리 판은 감독의 명령이, 상대 판은 실험실이 고친다 */
export type LabSide = "ours" | "theirs";

const LAB_MANAGER = "실험실";
/** 경기 id의 머리 — 뒤의 수가 몇 번째 경기인가다. 난수 채널이 경기 id를 읽는다 */
const LAB_MATCH_PREFIX = "lab-";
const LAB_KICKOFF = "20:00";

function labMatchOf(state: GameState): MatchRecord | null {
  return state.matches.find((m) => m.id.startsWith(LAB_MATCH_PREFIX)) ?? null;
}

function matchNoOf(match: MatchRecord): number {
  return Number(match.id.slice(LAB_MATCH_PREFIX.length)) || 1;
}

/**
 * 오늘의 실험 경기 — **맡은 구단 리그의 리그 경기다.** 친선이면 교체 한도가 벤치
 * 전원이라 상대 벤치가 후반을 다른 열한 명으로 바꾼다.
 */
function scheduleLabMatch(state: GameState, home: string, away: string, no: number): void {
  const involved = (m: MatchRecord) =>
    [m.homeTeamId, m.awayTeamId].some((id) => id === home || id === away);
  // 킥오프가 찾는 오늘의 경기는 이 하나여야 한다 (`startMatch`)
  state.matches = state.matches.filter((m) => !(m.date === state.date && !m.result && involved(m)));
  state.matches.push({
    id: `${LAB_MATCH_PREFIX}${no}`,
    season: state.season,
    competitionId: state.teams.find((t) => t.id === state.userTeamId)?.leagueId ?? null,
    stage: "league",
    round: 1,
    date: state.date,
    time: LAB_KICKOFF,
    homeTeamId: home,
    awayTeamId: away,
    result: null,
  });
}

/** 실험실 판을 짓는다 — 고른 두 구단의 리그만 담은 세계다 */
export function createLabGame(
  setup: LabSetup,
): { ok: true; state: GameState } | { ok: false; message: string } {
  if (setup.homeTeamId === setup.awayTeamId)
    return { ok: false, message: "같은 구단끼리는 붙일 수 없습니다" };
  const top = new Set(topLeagues().map((l) => l.id));
  const entries = [setup.homeTeamId, setup.awayTeamId].map((id) =>
    teamCatalog().find((t) => t.id === id && top.has(t.leagueId)),
  );
  if (entries.some((t) => t === undefined))
    return { ok: false, message: "1부 리그 구단만 고를 수 있습니다" };
  const leagues = [...new Set(entries.flatMap((t) => (t ? [t.leagueId] : [])))];
  const size = Math.max(
    ...leagues.map((id) => teamCatalog().filter((t) => t.leagueId === id).length),
  );
  // 세계는 리그마다 카탈로그 앞에서부터 자르므로(`scopedTeamsOfLeague`) 리그 전체를 담는 짝수다
  const world: WorldScope = {
    leagues,
    teamsPerLeague: size + (size % 2),
    cups: false,
    markets: false,
  };
  const state = createGame({
    ...(setup.seed === undefined ? {} : { seed: setup.seed }),
    userTeamId: setup.managed === "home" ? setup.homeTeamId : setup.awayTeamId,
    managerName: LAB_MANAGER,
    background: LAB_MANAGER,
    world,
  });
  state.id = `${LAB_ID_PREFIX}${state.seed.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  scheduleLabMatch(state, setup.homeTeamId, setup.awayTeamId, 1);
  state.phase = "matchday";
  return { ok: true, state };
}

export function labView(state: GameState): LabView | null {
  const match = labMatchOf(state);
  if (!match) return null;
  const side = (teamId: string): LabSideView => ({
    teamId,
    name: teamNameIn(state, teamId),
    shortName: teamShortNameIn(state, teamId),
    colours: teamCatalog().find((t) => t.id === teamId)?.colours ?? null,
    ours: teamId === state.userTeamId,
    tactics: { ...tacticsOf(state, teamId).spec },
  });
  return {
    matchNo: matchNoOf(match),
    seed: state.seed,
    sides: { home: side(match.homeTeamId), away: side(match.awayTeamId) },
    finished: state.pendingMatch ? liveFinished(state.pendingMatch.live) : false,
  };
}

/** 경기 전의 실험 경기 — 경기 중 우리 판은 전술판 지시가 고친다 */
function matchBeforeKickoff(
  state: GameState,
): { ok: true; match: MatchRecord } | { ok: false; message: string } {
  if (state.phase === "match") return { ok: false, message: "경기 중에는 고칠 수 없습니다" };
  const match = labMatchOf(state);
  return match ? { ok: true, match } : { ok: false, message: "실험 경기를 찾지 못했습니다" };
}

/** 그 쪽의 구단 — 상대는 오늘의 실험 경기에서 우리가 아닌 쪽이다 */
function teamOf(state: GameState, match: MatchRecord, side: LabSide): string {
  if (side === "ours") return state.userTeamId;
  return match.homeTeamId === state.userTeamId ? match.awayTeamId : match.homeTeamId;
}

/**
 * 프리셋 모양으로 다시 짠다 — 우리는 **지금 선발을 앞세우고**, 상대는 구단의 기본 선발을
 * 앞세운다. 우리 판은 전술판 저장과 같은 명령(`setLineup`)을 지나 적응도·카드가 같은
 * 규칙을 밟는다.
 */
export function applyLabFormation(
  state: GameState,
  side: LabSide,
  formation: Formation,
): FlowResult {
  const found = matchBeforeKickoff(state);
  if (!found.ok) return found;
  const { match } = found;
  const teamId = teamOf(state, match, side);
  const tactics = tacticsOf(state, teamId);
  const available = (id: string) => {
    const player = playerById(state, id);
    return player !== null && isAvailableFor(state, player, match.competitionId);
  };
  const preferred =
    side === "ours"
      ? tactics.assignments.filter((a) => a.role === "starting").map((a) => a.playerId)
      : defaultXiIds(teamId);
  const fresh = buildAssignments(
    firstTeamPlayers(state, teamId),
    formation,
    FAMILIARITY_BASELINE,
    available,
    preferred,
  );
  if (side === "ours") {
    return setLineup(state, {
      starting: fresh
        .filter((a) => a.role === "starting")
        .map((a) => ({ playerId: a.playerId, ...(a.point ? { point: a.point } : {}) })),
      bench: fresh.filter((a) => a.role === "bench").map((a) => a.playerId),
    });
  }
  tactics.assignments = fresh;
  tactics.spec = { ...tactics.spec, formation };
  return { ok: true, message: `상대 모양 ${formation}` };
}

/**
 * 여섯 축과 갈래 넷 — 우리 판은 감독의 명령(`setTactics`)이 받고, 상대 판은 같은
 * 스키마로 검사해 앉힌다. 모양 이름은 배치의 파생이라 여기서 받지 않는다.
 */
export function applyLabTactics(
  state: GameState,
  side: LabSide,
  patch: { [K in Exclude<keyof TacticsSpec, "formation">]?: TacticsSpec[K] | undefined },
): FlowResult {
  const found = matchBeforeKickoff(state);
  if (!found.ok) return found;
  if (side === "ours") return setTactics(state, patch);
  const tactics = tacticsOf(state, teamOf(state, found.match, side));
  const given = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const parsed = TacticsSpecSchema.safeParse({ ...tactics.spec, ...given });
  if (!parsed.success) return { ok: false, message: "상대 전술 형식이 올바르지 않습니다" };
  tactics.spec = parsed.data;
  return { ok: true, message: "상대 전술을 고쳤습니다" };
}

/**
 * 킥오프 — `familiarity`가 있으면 두 팀의 적응도를 그 값 하나로 맞춘다. 전술을 바꾼
 * 쪽만 깎인 적응도로 서면 전술끼리가 아니라 익은 판과 낯선 판을 견주게 된다.
 */
export function kickoffLab(state: GameState, opts: { familiarity: number | null }): FlowResult {
  const found = matchBeforeKickoff(state);
  if (!found.ok) return found;
  if (opts.familiarity !== null) {
    for (const teamId of [found.match.homeTeamId, found.match.awayTeamId]) {
      for (const a of tacticsOf(state, teamId).assignments) a.familiarity = opts.familiarity;
    }
  }
  const started = startMatch(state);
  if (started.ok) markEntered(state);
  return started;
}

/**
 * 킥오프 전으로 되돌린다 — 경기 중 고친 우리 판은 킥오프 때로 돌아가고(`restoreTactics`),
 * 다음 경기는 id가 달라 다른 경기가 된다. 정산하지 않았으므로 몸·카드·부상은 그대로다.
 */
export function rewindLab(state: GameState): FlowResult {
  const match = labMatchOf(state);
  if (!match) return { ok: false, message: "실험 경기를 찾지 못했습니다" };
  if (state.pendingMatch) restoreTactics(state);
  state.pendingMatch = null;
  state.phase = "matchday";
  state.matches = state.matches.filter((m) => m.id !== match.id);
  const next = matchNoOf(match) + 1;
  scheduleLabMatch(state, match.homeTeamId, match.awayTeamId, next);
  return { ok: true, message: `${next}번째 경기` };
}
