import { normalizeCard, placeOf, type RoleCard } from "@gaffer/domain";
import type { GameState } from "../core/state";

/**
 * 카드 기억 — **그 선수가 그 자리에서 마지막에 맡던 카드.**
 *
 * 배치(`TacticAssignment.card`)는 로테이션마다 다시 써지므로 벤치로 한 번 내려가면
 * 감독의 결정이 사라진다. 배치 바깥의 이 테이블이 그 결정을 들고 있다가, 같은 자리로
 * 돌아올 때 기본 행동 대신 내어 준다 (→ docs/players/player.md §3.2).
 *
 * 되찾기는 **기본값을 갈아끼우는 것**이지 잠그는 게 아니다 — 감독이 새로 고치면 그게
 * 새 기억이 된다.
 */

/** 그 칸의 자리에서 맡던 카드 — 없으면 `undefined`(그 자리의 기본 행동에서 시작한다) */
export function recallCard(
  state: GameState,
  playerId: string,
  position: string,
): RoleCard | undefined {
  const place = placeOf(position);
  if (place === null) return undefined;
  return state.cardMemory.find((m) => m.gamePlayerId === playerId && m.place === place)?.card;
}

/**
 * 그 자리의 카드를 기억에 적는다 — 감독이 고칠 때, 그리고 **배치가 그 카드를 내릴
 * 때**(다른 자리로 이동·벤치 강등). 빈 카드면 그 자리의 기억을 지운다 — 감독이 기본
 * 행동으로 돌려놓은 것이다.
 *
 * ⚠️ **경기 중에는 적지 않는다.** 그 경기의 대응은 그 경기에서 끝나고
 * (`restoreTactics`), 킥오프 값으로 되돌아가는 카드가 기억에만 남으면 다음 경기의
 * 라인업이 그 카드로 선다.
 */
export function rememberCard(
  state: GameState,
  playerId: string,
  position: string,
  card: RoleCard | null | undefined,
): void {
  if (state.phase === "match") return;
  const place = placeOf(position);
  if (place === null) return;
  const kept = normalizeCard(card);
  const rest = state.cardMemory.filter((m) => !(m.gamePlayerId === playerId && m.place === place));
  state.cardMemory = kept ? [...rest, { gamePlayerId: playerId, place, card: kept }] : rest;
}

/** 팀을 떠난 선수의 기억은 지운다 (`playerTraining`과 같은 자리에서) */
export function forgetCards(state: GameState, playerId: string): void {
  state.cardMemory = state.cardMemory.filter((m) => m.gamePlayerId !== playerId);
}
