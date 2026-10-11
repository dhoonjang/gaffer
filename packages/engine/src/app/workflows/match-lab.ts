import {
  FAMILIARITY_BASELINE,
  LAB_ID_PREFIX,
  TacticsSpecSchema,
  type ClubColours,
  type Formation,
  type MatchRecord,
  type MatchSide,
  type TacticsSpec,
} from "@gaffer/domain";
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
import { type FlowResult, restoreTactics } from "../../match/match-flow";
import { createGame } from "../create-game";
import { startMatch } from "./match-flow";

/**
 * ── 경기 실험실 — 두 구단을 골라 경기 하나만 치르는 판 (match/live-match.md §8.6) ──
 *
 * 판은 진짜 세이브라 경기는 게임 화면이 게임과 같은 길로 치른다 — 입장, 말로 하는 지시,
 * 정지점의 중계까지. 여기 있는 것은 게임에 없는 걸음뿐이다: 판 짓기, 상대의 모양과 전술,
 * 적응도를 맞춰 경기 판 세우기, 같은 조합으로 다시 치를 새 판.
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
  /**
   * 경기가 어디까지 왔나 — `prep`은 판을 짜는 중, `open`은 경기 판이 서서 게임 화면이
   * 치르는 중(입장 전 포함), `played`는 정산까지 끝났다.
   */
  stage: "prep" | "open" | "played";
  result: MatchRecord["result"];
}

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
    stage: match.result ? "played" : state.pendingMatch ? "open" : "prep",
    result: match.result,
  };
}

/** 판을 짜는 중인 실험 경기 — 경기 판이 선 뒤의 일은 게임 화면의 몫이다 */
function matchInPrep(
  state: GameState,
): { ok: true; match: MatchRecord } | { ok: false; message: string } {
  const match = labMatchOf(state);
  if (!match) return { ok: false, message: "실험 경기를 찾지 못했습니다" };
  if (state.pendingMatch || match.result) return { ok: false, message: "경기 판이 이미 섰습니다" };
  return { ok: true, match };
}

/** 상대 — 오늘의 실험 경기에서 우리가 아닌 쪽이다 */
function opponentOf(state: GameState, match: MatchRecord): string {
  return match.homeTeamId === state.userTeamId ? match.awayTeamId : match.homeTeamId;
}

/**
 * 상대를 프리셋 모양으로 다시 짠다 — 구단의 기본 선발을 앞세운다. 우리 판은 게임 화면이
 * 감독의 말과 전술판으로 고친다.
 */
export function applyLabFormation(state: GameState, formation: Formation): FlowResult {
  const found = matchInPrep(state);
  if (!found.ok) return found;
  const { match } = found;
  const teamId = opponentOf(state, match);
  const tactics = tacticsOf(state, teamId);
  const available = (id: string) => {
    const player = playerById(state, id);
    return player !== null && isAvailableFor(state, player, match.competitionId);
  };
  tactics.assignments = buildAssignments(
    firstTeamPlayers(state, teamId),
    formation,
    FAMILIARITY_BASELINE,
    available,
    defaultXiIds(teamId),
  );
  tactics.spec = { ...tactics.spec, formation };
  return { ok: true, message: `상대 모양 ${formation}` };
}

/** 상대의 여섯 축과 갈래 넷 — 같은 스키마로 검사해 앉힌다. 모양 이름은 배치의 파생이다 */
export function applyLabTactics(
  state: GameState,
  patch: { [K in Exclude<keyof TacticsSpec, "formation">]?: TacticsSpec[K] | undefined },
): FlowResult {
  const found = matchInPrep(state);
  if (!found.ok) return found;
  const tactics = tacticsOf(state, opponentOf(state, found.match));
  const given = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const parsed = TacticsSpecSchema.safeParse({ ...tactics.spec, ...given });
  if (!parsed.success) return { ok: false, message: "상대 전술 형식이 올바르지 않습니다" };
  tactics.spec = parsed.data;
  return { ok: true, message: "상대 전술을 고쳤습니다" };
}

/**
 * 경기 판을 세운다 — `familiarity`가 있으면 두 팀의 적응도를 그 값 하나로 맞춘다. 전술을
 * 바꾼 쪽만 깎인 적응도로 서면 전술끼리가 아니라 익은 판과 낯선 판을 견주게 된다.
 * 입장은 게임 화면의 킥오프 게이트가 한다 — 그 뒤 판을 고치면 게임의 규칙대로 적응도가 움직인다.
 */
export function openLabMatch(state: GameState, opts: { familiarity: number | null }): FlowResult {
  const found = matchInPrep(state);
  if (!found.ok) return found;
  if (opts.familiarity !== null) {
    for (const teamId of [found.match.homeTeamId, found.match.awayTeamId]) {
      for (const a of tacticsOf(state, teamId).assignments) a.familiarity = opts.familiarity;
    }
  }
  return startMatch(state);
}

/**
 * 같은 조합을 다시 치를 새 판 — **치른 판을 되감지 않는다.** 경기가 남긴 몸·카드·부상과
 * 대화가 다음 경기에 묻지 않게 같은 시드의 새 세계에서 다시 짓고, 두 팀의 판(모양·배치·
 * 전술)만 옮겨 온다. 경기 번호가 하나 늘어 경기 id가 달라지므로 다른 경기가 된다.
 */
export function replayLabGame(
  old: GameState,
): { ok: true; state: GameState } | { ok: false; message: string } {
  const match = labMatchOf(old);
  if (!match) return { ok: false, message: "실험 경기를 찾지 못했습니다" };
  const created = createLabGame({
    homeTeamId: match.homeTeamId,
    awayTeamId: match.awayTeamId,
    managed: match.homeTeamId === old.userTeamId ? "home" : "away",
    seed: old.seed,
  });
  if (!created.ok) return created;
  const { state } = created;
  // 경기 도중이면 경기 중 조정을 걷은 킥오프의 판을 옮긴다 — 정산한 판은 이미 그렇다
  const source = old.pendingMatch ? structuredClone(old) : old;
  if (source.pendingMatch) restoreTactics(source);
  const teams = new Set([match.homeTeamId, match.awayTeamId]);
  state.tactics = state.tactics.map((t) =>
    teams.has(t.teamId) ? structuredClone(tacticsOf(source, t.teamId)) : t,
  );
  const no = matchNoOf(match) + 1;
  state.matches = state.matches.filter((m) => !m.id.startsWith(LAB_MATCH_PREFIX));
  scheduleLabMatch(state, match.homeTeamId, match.awayTeamId, no);
  return { ok: true, state };
}
