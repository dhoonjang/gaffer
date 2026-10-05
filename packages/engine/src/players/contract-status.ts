import { type GameState, playersOf, activeContract } from "../core/state";
import { playerOverall, type GamePlayer, type SquadStatus, ageOf } from "@gaffer/domain";
import { SQUAD_CORE_SIZE, betterAtPosition } from "./squad-depth";

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

/** 최근 출전 현황을 읽는 경기 수. */
export const RECENT_APPEARANCE_MATCHES = 8;
