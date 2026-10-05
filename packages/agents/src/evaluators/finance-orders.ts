import { type GameState, describeBoardRequests, financeLookup } from "@gaffer/engine";
import { tagged } from "./orders-ops";
import { buildRecentTurnsBlock } from "../shared/context";

/** 재정 지시가 부를 수 있는 코어 명령 — 티켓 가격 */
export const FINANCE_OPS: readonly string[] = ["set_ticket_price"];

/** 해석기의 입력 — 보드 요청·재정·지난 다섯 턴 */
export function buildFinanceContext(state: GameState): string[] {
  return [
    ...tagged("board", describeBoardRequests(state) ?? ""),
    ...tagged("finance", financeLookup(state).message),
    ...tagged("recent_turns", buildRecentTurnsBlock(state)),
  ];
}
