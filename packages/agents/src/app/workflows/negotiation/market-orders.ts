import {
  type GameState,
  describeNegotiations,
  pendingVerdicts,
  describeBoardRequests,
  describeBuyBackRights,
  describeInterests,
  financeLookup,
  describeStaffPool,
} from "@story-fm/engine";
import { managerSeatLines } from "./context";
import { tagged } from "../../../common/orders-ops";
import { buildRecentTurnsBlock } from "../../../common/context";

/** 해석기의 입력 — 협상·관심·되사기·보드·감독직·재정·스태프 풀·지난 다섯 턴 */
export function buildMarketContext(state: GameState): string[] {
  const negotiations = describeNegotiations(state);
  const verdicts = pendingVerdicts(state).map((v) => `❗ ${v.label} (${v.negotiation.id})`);
  const seat = managerSeatLines(state);
  const board = describeBoardRequests(state);
  const buybacks = describeBuyBackRights(state);
  const interest = describeInterests(state);
  return [
    ...tagged(
      "negotiations",
      [...(negotiations.startsWith("진행 중인 협상 없음") ? [] : [negotiations]), ...verdicts].join(
        "\n",
      ),
    ),
    ...tagged("interest", interest.join("\n")),
    ...tagged("buybacks", buybacks ?? ""),
    ...tagged("board", board ?? ""),
    ...tagged("seat", seat.join("\n")),
    ...tagged("finance", financeLookup(state).message),
    // 감독이 부른 이름을 그 사람으로 옮기는 자리 — 풀에 없는 이름은 고용할 수 없다
    ...tagged("staff_pool", describeStaffPool(state).join("\n")),
    ...tagged("recent_turns", buildRecentTurnsBlock(state)),
  ];
}
