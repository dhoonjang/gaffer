import { type GameState } from "@story-fm/engine";
import { type GameToolSpec, type GameLLM } from "@story-fm/llm";
import { type Negotiation } from "@story-fm/domain";
import {
  type TableOrders,
  buildTableOrdersContext,
  TABLE_ORDERS_SPEC,
  BY_NEGOTIATION,
  BY_PLAYER,
} from "../../../negotiation/table-orders";
import { runOpsOrders } from "../../../common/orders-ops";
import { mockOrdersLlm } from "../../mock-gm";

/**
 * 감독의 말 → 이 협상의 명령 인자. 시장 해석과 같은 뼈대를 지난다(`runOpsOrders`).
 * 돌아온 명령의 `negotiationId`·`playerId`는 **이 테이블의 것으로 덮어쓴다.**
 */
export async function runTableOrders(
  state: GameState,
  specs: ReadonlyMap<string, GameToolSpec>,
  negotiation: Negotiation,
  line: string,
  llm?: GameLLM,
): Promise<{ ok: true; orders: TableOrders } | { ok: false; message: string }> {
  const user = [...buildTableOrdersContext(state, negotiation), ``, `@감독: ${line}`].join("\n");
  const parsed = await runOpsOrders(
    TABLE_ORDERS_SPEC,
    specs,
    user,
    llm ?? mockOrdersLlm(state, TABLE_ORDERS_SPEC, line),
    line,
  );
  if (!parsed.ok) return parsed;
  const ops: Record<string, unknown[]> = {};
  for (const [name, inputs] of Object.entries(parsed.orders.ops)) {
    ops[name] = inputs.map((input) => {
      const row = typeof input === "object" && input !== null ? { ...(input as object) } : {};
      const pinned: Record<string, unknown> = { ...row };
      if (BY_NEGOTIATION.has(name)) pinned.negotiationId = negotiation.id;
      if (BY_PLAYER.has(name)) pinned.playerId = negotiation.gamePlayerId;
      // 갈래도 협상의 것이다 — 영입 테이블에 임대 오퍼가 얹히면 코어가 반려한다 (transfer.md §1)
      if (name === "send_offer") pinned.kind = negotiation.kind === "loan" ? "loan" : "buy";
      return pinned;
    });
  }
  return { ok: true, orders: { ...parsed.orders, ops } };
}
