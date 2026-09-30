import { type GameState, describeBoardRequests, financeLookup } from "@story-fm/engine";
import { tagged } from "../../../common/orders-ops";
import { buildRecentTurnsBlock } from "../../../common/context";

/** 해석기의 입력 — 보드 요청·재정·지난 다섯 턴 */
export function buildFinanceContext(state: GameState): string[] {
  return [
    ...tagged("board", describeBoardRequests(state) ?? ""),
    ...tagged("finance", financeLookup(state).message),
    ...tagged("recent_turns", buildRecentTurnsBlock(state)),
  ];
}
