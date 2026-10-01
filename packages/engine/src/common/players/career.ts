import { type GameState } from "../core/state";
import { type SeasonAward } from "@story-fm/domain";

/**
 * **가장 최근에 매겨진 시즌**(`state.season - 1`)에 그 선수가 받은 상 — 장부 순서 그대로.
 *
 * 시상은 시즌 전환이 매기므로 진행 중인 시즌에는 아직 상이 없다. 창이 하나인 것이 규약이다
 * (season.md §6 「상이 사실로 서는 자리」) — 자리마다 다른 창을 쓰면 같은 상이 협상 서류엔
 * 서고 회견엔 서지 않는다.
 */
export function lastSeasonAwardsOf(state: GameState, playerId: string): readonly SeasonAward[] {
  return state.awards.filter((a) => a.season === state.season - 1 && a.gamePlayerId === playerId);
}
