import type { GamePlayer } from "@story-fm/domain";
import { playerOverall, naturalPositionOf } from "@story-fm/domain";
import { playersOf, type GameState } from "../core/state";

/**
 * 스쿼드의 **깊이와 힘** — "그 자리에 나보다 나은 선수가 몇이나 있나"와 "이 팀은
 * 얼마나 센가"를 한 벌로 갖는다.
 *
 * 지위 파생·승강·체급 재산정·시즌 예상이 이 두 물음을 던진다. 여기는 아무도
 * import 하지 않는 잎이라 어느 쪽에서든 부를 수 있다 (AGENTS.md §5).
 */

/** 판에 서는 인원 — 스쿼드의 힘은 이만큼의 평균으로 잰다 */
const STARTING_XI = 11;

/**
 * 이 팀에서 그 자리를 더 잘 보는 선수 수 — 포지션군(GK/DF/MF/FW)은 40인 스쿼드에서
 * 너무 거칠어 "8명이 더 낫다"가 늘 나온다. 주 포지션 코드로 좁혀 센다.
 */
export function betterAtPosition(state: GameState, teamId: string, player: GamePlayer): number {
  const position = naturalPositionOf(player).position;
  return playersOf(state, teamId).filter(
    (p) =>
      p.id !== player.id &&
      naturalPositionOf(p).position === position &&
      playerOverall(p) > playerOverall(player),
  ).length;
}

/** 상위 열한 명의 평균 — **규칙은 한 벌이고 진입점만 둘이다** (한 팀 · 전 팀) */
function topElevenMean(overalls: number[]): number {
  if (overalls.length === 0) return 0;
  const top = [...overalls].sort((a, b) => b - a).slice(0, STARTING_XI);
  return top.reduce((sum, v) => sum + v, 0) / top.length;
}

/**
 * 스쿼드 상위 열한 명의 평균 OVR — 팀 하나를 한 숫자로 줄이는 잣대.
 * 승강(2부 클럽 줄 세우기)과 체급 재산정의 전력 축이 같은 자를 쓴다.
 */
export function squadRating(state: GameState, teamId: string): number {
  return topElevenMean(playersOf(state, teamId).map((p) => playerOverall(p)));
}

/**
 * 전 팀의 등급을 **한 번의 순회로** — 시즌 예상·대회 조회처럼 세계의 모든 구단을
 * 줄 세우는 자리가 쓴다. 팀마다 `squadRating`을 부르면 그 자리
 * 하나가 「팀 수 × 선수 수」가 된다.
 *
 * `squadDepthOf`와 같은 결의 **읽기 전용 파생**이다 — 세운 뒤에 선수가 옮겨 가면
 * 낡은다. 한 번의 순회 안에서 세우고 버린다.
 */
export function squadRatingsOf(state: GameState): Map<string, number> {
  const bySquad = new Map<string, number[]>();
  for (const p of state.players) {
    const list = bySquad.get(p.teamId);
    if (list) list.push(playerOverall(p));
    else bySquad.set(p.teamId, [playerOverall(p)]);
  }
  const ratings = new Map<string, number>();
  for (const [teamId, overalls] of bySquad) ratings.set(teamId, topElevenMean(overalls));
  return ratings;
}

/** 계약 기대와 회견에서 함께 사용하는 핵심 선수단 범위. */
export const SQUAD_CORE_SIZE = 14;
