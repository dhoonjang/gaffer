import { type GameState, playersOf, activeContract } from "../core/state";
import {
  playerOverall,
  type GamePlayer,
  type SquadStatus,
  ageOf,
  isReserveMatch,
} from "@story-fm/domain";
import { SQUAD_CORE_SIZE, betterAtPosition } from "./squad-depth";
import { isFriendly } from "../core/calendar";

/** `key`로 서려면 스쿼드 안에서 이 순위 안에 들어야 한다 */
const KEY_SQUAD_RANK = 5;

/** 유망주로 보는 나이 — 만 21세 이하 (등록 명단이 가르는 자와 같은 눈금) */
const PROSPECT_AGE = 21;

/**
 * 계약에 역할이 없을 때 현재 선수단의 능력·자리 깊이·나이로 파생하는 참고 역할.
 * 계약에 명시적으로 합의한 역할은 `squadStatusOf`가 우선한다 (people.md §5-2).
 */
export function derivedSquadStatus(
  state: GameState,
  player: GamePlayer,
  /**
   * 어느 스쿼드의 서열로 재는가 — 기본은 그의 소속이다.
   */
  teamId: string = player.teamId,
): SquadStatus {
  const better = playersOf(state, teamId).filter(
    (p) => p.id !== player.id && playerOverall(p) > playerOverall(player),
  ).length;
  const young = ageOf(player.birthdate, state.date) <= PROSPECT_AGE;
  /**
   * 선수단 핵심 범위 밖에서는 자리 깊이 대신 나이로 백업·유망주를 구분한다.
   * 이 파생값은 계약에 합의한 역할을 덮어쓰지 않는다.
   */
  if (better >= SQUAD_CORE_SIZE) return young ? "prospect" : "backup";
  const blocked = betterAtPosition(state, teamId, player);
  if (blocked === 0) return better < KEY_SQUAD_RANK ? "key" : "starter";
  if (blocked === 1) return "rotation";
  return young ? "prospect" : "backup";
}

/** 그가 **어떤 자리로 있는가** — 계약에 적힌 지위, 없으면 파생 */
export function squadStatusOf(state: GameState, player: GamePlayer): SquadStatus {
  return activeContract(state, player.id)?.squadStatus ?? derivedSquadStatus(state, player);
}

/** 그날 부상으로 빠져 있었나 — 원장의 기간으로 판정한다 (미복귀는 `returnedOn`이 없다) */
function injuredOn(state: GameState, playerId: string, date: string): boolean {
  return state.injuries.some(
    (i) =>
      i.gamePlayerId === playerId &&
      i.occurredOn <= date &&
      (i.returnedOn === null || i.returnedOn > date),
  );
}

/** 이 경기가 그 창에 드는가 — 우리 1군의 공식 경기만 (친선·2군은 출전 기회가 아니다) */
function countsForMinutes(state: GameState, match: (typeof state.matches)[number]): boolean {
  if (!match.result) return false;
  if (isReserveMatch(match)) return false;
  if (isFriendly(match)) return false;
  return match.homeTeamId === state.userTeamId || match.awayTeamId === state.userTeamId;
}

/** 그 경기에 선발로 섰는가 */
function startedIn(
  state: GameState,
  match: (typeof state.matches)[number],
  playerId: string,
): boolean {
  const result = match.result;
  if (!result) return false;
  const home = match.homeTeamId === state.userTeamId;
  return (home ? result.homeStarters : result.awayStarters).includes(playerId);
}

/**
 * 그 경기에 **그라운드를 밟았는가** — 선발과 교체 투입을 가리지 않는다
 * (「뛴 사람 전부」 칸 `homeLineup`).
 */
function appearedIn(
  state: GameState,
  match: (typeof state.matches)[number],
  playerId: string,
): boolean {
  const result = match.result;
  if (!result) return false;
  const home = match.homeTeamId === state.userTeamId;
  return (home ? result.homeLineup : result.awayLineup).includes(playerId);
}

/**
 * 우리 공식 경기를 **최근 순으로** — 창을 여러 번 재는 호출이 원장을 한 번만 훑게
 * 하는 색인이다.
 *
 * `minutesShortfalls`는 월요일마다 1군 전원에게 창을 묻는다. 호출마다 원장을
 * 훑으면 멀티시즌 세이브의 한 주가 「선수 수 × 전체 경기 수」가 된다. **읽기 전용 파생**이라
 * 원장이 그대로인 동안만 유효하다: 한 번의 순회 안에서 세우고 버린다.
 */
function matchWindowOf(state: GameState): (typeof state.matches)[number][] {
  return state.matches
    .filter((m) => countsForMinutes(state, m) && m.date <= state.date)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

interface StartRead {
  /** 그가 설 수 있었던 경기 수 — 부상으로 빠져 있던 날은 빠진다 */
  played: number;
  starts: number;
  /**
   * **그라운드를 밟은 경기 수** — 선발 + 교체 투입이라 `starts` 이상이다
   * (people.md §5-2).
   *
   * 이 칸은 **사실 카드의 것**이다 — 카드가
   * 선발 수만 실으면 「한 번도 못 뛰었다」와 「뛰었지만 선발은 아니었다」가 읽는
   * 쪽에 같은 사실로 가고, GM이 후반 45분을 뛴 선수에게 투입되지 못했다고 쓴다.
   */
  apps: number;
  /** `played`가 0이면 1로 읽는다 — 나눌 것이 없는 자리에서 비율은 뜻이 없다 */
  share: number;
}

/**
 * 창 안의 **선발 비율** — `from`이 있으면 그날 이후, 없으면 최근
 * `RECENT_APPEARANCE_MATCHES`경기다.
 *
 * ⚠️ **분모는 그가 설 수 있었던 경기다** (people.md §5). 부상으로 빠져 있던 경기까지
 * 세면 부상 결장을 감독이 선택한 결장과 같은 값으로 읽게 된다.
 */
export function startsInWindow(
  state: GameState,
  player: GamePlayer,
  window: {
    from?: string;
    matches?: number;
    /** 미리 세운 최근 순 경기 색인 (`matchWindowOf`) — 없으면 그 자리에서 세운다 */
    pool?: readonly (typeof state.matches)[number][];
  } = {},
): StartRead {
  const limit = window.matches ?? RECENT_APPEARANCE_MATCHES;
  const ours = (window.pool ?? matchWindowOf(state))
    .filter((m) => window.from === undefined || m.date >= window.from)
    .slice(0, limit);
  let played = 0;
  let starts = 0;
  let apps = 0;
  for (const match of ours) {
    if (injuredOn(state, player.id, match.date)) continue;
    played += 1;
    const started = startedIn(state, match, player.id);
    if (started) starts += 1;
    // 선발은 언제나 출전이다 — 두 칸이 다른 장부에서 나와도 `apps >= starts`는 선다
    if (started || appearedIn(state, match, player.id)) apps += 1;
  }
  return { played, starts, apps, share: played > 0 ? starts / played : 1 };
}

/** 최근 출전 현황을 읽는 경기 수. */
export const RECENT_APPEARANCE_MATCHES = 8;
