import { type OpsOrders } from "../common/orders-ops";

export const MARKET_OPS: readonly string[] = [
  "respond_offer",
  "accept_deal",
  "respond_transfer_request",
  "withdraw_offer",
  // 도로 가져오는 말이 먼저다 — 걷고 나서 감독이 직접 답하는 말이 한 턴에 함께 온다
  "revoke_mandate",
  "set_transfer_list",
  // 조건은 오퍼보다 앞이다 — 같은 말에 함께 오면 조건서가 먼저 서야 오퍼가 싣는다 (§12-3)
  "answer_term",
  "offer_terms",
  "send_offer",
  "open_renewal",
  "propose_personal",
  "open_release",
  // 위임은 협상을 열 수도 있어 여는 셋 뒤다 (§12-4)
  "delegate_negotiation",
  "release_player",
  "exercise_buyback",
  "recall_loan",
  "adjust_transfer_budget",
  "request_board",
  "fund_transfer_budget",
  "pay_player_bonus",
  "set_ticket_price",
  // 자른 자리에 그 턴 안에 다시 앉힐 수 있게 — 자리 상한과 주급 여력을 해고가 먼저 비운다
  "release_staff",
  "hire_staff",
  "accept_manager_offer",
  "counter_manager_offer",
  "apply_manager_job",
];

export type MarketOrders = OpsOrders;
