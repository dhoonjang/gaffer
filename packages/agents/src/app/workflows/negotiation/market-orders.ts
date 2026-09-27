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
import { tagged, runOpsOrders } from "../../../common/orders-ops";
import { buildRecentTurnsBlock } from "../../../common/context";
import { type GameToolSpec, type GameLLM } from "@story-fm/llm";
import { type MarketOrders, MARKET_ORDERS_SPEC } from "../../../negotiation/market-orders";
import { mockOrdersLlm } from "../../mock-gm";

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

/**
 * 감독의 말 → 시장·장부 명령의 인자. 훈련 해석과 같은 뼈대를 지난다(`runOpsOrders`).
 */
export async function runMarketOrders(
  state: GameState,
  specs: ReadonlyMap<string, GameToolSpec>,
  message: string,
  llm?: GameLLM,
): Promise<{ ok: true; orders: MarketOrders } | { ok: false; message: string }> {
  const user = [...buildMarketContext(state), ``, `@감독: ${message}`].join("\n");
  return runOpsOrders(
    MARKET_ORDERS_SPEC,
    specs,
    user,
    llm ?? mockOrdersLlm(state, MARKET_ORDERS_SPEC, message),
    message,
  );
}
