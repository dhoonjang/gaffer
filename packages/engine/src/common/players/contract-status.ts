import { type GameState, playersOf, activeContract } from "../core/state";
import { type GamePlayer, type SquadStatus, ageOf, isReserveMatch } from "@story-fm/domain";
import { SQUAD_CORE_SIZE } from "./squad-depth";
import { betterAtPosition } from "./squad-depth";
import { isFriendly } from "../core/match-kinds";

/**
 * **감독의 약속 — 갈래·기한·상태뿐인 장부** (→ docs/story/people.md §5-2).
 *
 * 이 게임의 인터페이스는 말이고 잘한 말은 잘 먹혀야 한다. 그런데 말이 공짜면 가장
 * 잘 먹히는 말이 가장 값싼 말이 된다 — 불만 선수를 면담 한 번의 "다음 경기 선발이다"로
 * 잠재우고 잊는 것이 최적 전략이 되고, "방치의 대가는 시간의 결과"라는 규약이
 * 약속 앞에서만 빈다.
 *
 * ⚠️ **여기 어디에도 문장이 없다.** 무슨 말로 약속했는지는 장면의 것이고, 이행
 * 판정은 전부 다른 장부에서 나온다 — 출전 명단 · 등번호 · 완장.
 */

/** 지위·약속을 재는 창 — 여덟 경기는 한 시즌의 다섯 번째쯤이고 두 달 남짓이다 */
export const PROMISE_WINDOW_MATCHES = 8;

/** `key`로 서려면 스쿼드 안에서 이 순위 안에 들어야 한다 */
export const KEY_SQUAD_RANK = 5;

/** 유망주로 보는 나이 — 만 21세 이하 (등록 명단이 가르는 자와 같은 눈금) */
export const PROSPECT_AGE = 21;

/**
 * 계약에 지위가 없을 때 **지금 서열에서 파생하는 지위** (people.md §5-2).
 *
 * 파생은 **지금 실제로 서는 순서**라, 지위를 적지 않은 계약(시드·AI 구단)이 없던
 * 불만을 만들어 내지 않는다 — 자기 자리에 맞는 지위를 받으므로 기대와 실제가
 * 처음부터 맞는다.
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
    (p) => p.id !== player.id && p.attributes.overall > player.attributes.overall,
  ).length;
  const young = ageOf(player.birthdate, state.date) <= PROSPECT_AGE;
  /**
   * **스쿼드의 핵심 밖이면 자리 깊이를 보지 않는다** — 등재·계약 불만이 쓰는 것과
   * 같은 자다(`SQUAD_CORE_SIZE` — people.md §5).
   *
   * 자리 깊이만 보면 서른 명짜리 1군이 열두어 자리로 나뉘어 **자리마다 둘째까지**
   * 로테이션이 되고, 여덟 경기에 여든여덟 자리뿐인 판에 감당할 수 없는 기대가
   * 스물여섯 개 선다. 백업 정리가 조용한 이유와 같은 이유로 여기서 끊는다.
   *
   * ⚠️ **계약에 적힌 지위에는 걸리지 않는다** — 서열 밖의 선수에게 감독이 자리를
   * 약속했다면 그것은 약속이지 파생이 아니다 (people.md §5-2).
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
export function injuredOn(state: GameState, playerId: string, date: string): boolean {
  return state.injuries.some(
    (i) =>
      i.gamePlayerId === playerId &&
      i.occurredOn <= date &&
      (i.returnedOn === null || i.returnedOn > date),
  );
}

/** 이 경기가 그 창에 드는가 — 우리 1군의 공식 경기만 (친선·2군은 출전 기회가 아니다) */
export function countsForMinutes(state: GameState, match: (typeof state.matches)[number]): boolean {
  if (!match.result) return false;
  if (isReserveMatch(match)) return false;
  if (isFriendly(match)) return false;
  return match.homeTeamId === state.userTeamId || match.awayTeamId === state.userTeamId;
}

/** 그 경기에 선발로 섰는가 */
export function startedIn(
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
export function appearedIn(
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
export function matchWindowOf(state: GameState): (typeof state.matches)[number][] {
  return state.matches
    .filter((m) => countsForMinutes(state, m) && m.date <= state.date)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

export interface StartRead {
  /** 그가 설 수 있었던 경기 수 — 부상으로 빠져 있던 날은 빠진다 */
  played: number;
  starts: number;
  /**
   * **그라운드를 밟은 경기 수** — 선발 + 교체 투입이라 `starts` 이상이다
   * (people.md §5-2).
   *
   * ⚠️ **판정은 이 값을 보지 않는다.** 출전 약속의 뜻은 "주전으로 세우겠다"이므로
   * 기한 날 재는 것은 `starts`뿐이다. 이 칸은 **사실 카드의 것**이다 — 카드가
   * 선발 수만 실으면 「한 번도 못 뛰었다」와 「뛰었지만 선발은 아니었다」가 읽는
   * 쪽에 같은 사실로 가고, GM이 후반 45분을 뛴 선수에게 투입되지 못했다고 쓴다.
   */
  apps: number;
  /** `played`가 0이면 1로 읽는다 — 나눌 것이 없는 자리에서 비율은 뜻이 없다 */
  share: number;
}

/**
 * 창 안의 **선발 비율** — `from`이 있으면 그날 이후, 없으면 최근
 * `PROMISE_WINDOW_MATCHES`경기다.
 *
 * ⚠️ **분모는 그가 설 수 있었던 경기다** (people.md §5). 부상으로 빠져 있던 경기까지
 * 세면 복귀 첫 주에 불만이 선다 — 못 나온 것이 감독의 결정이 아닌 경기다.
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
  const limit = window.matches ?? PROMISE_WINDOW_MATCHES;
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
