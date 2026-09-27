import type { OpsCaps, OpsOrders } from "../common/orders-ops";
import { MATCHDAY_BENCH } from "@story-fm/domain";

/** Domain-owned direct commands, ordered for dependent changes. */
export const TACTIC_OPS: readonly string[] = [
  "set_lineup",
  "set_squad_level",
  "set_captain",
  "substitute",
  "set_tactics",
  "set_player_tactic",
  "set_set_piece_takers",
  "set_set_piece_routine",
  "set_shootout_order",
];

/**
 * 명령마다 다른 상한 — **규칙이 정한 수가 있는 자리는 그 수를 쓴다** (match.md §5).
 * 교체는 벤치 전체를 옮길 수 있다. 대회별 교체 한도는 장부가 검증한다.
 */
export const TACTIC_CAPS: OpsCaps = {
  substitute: MATCHDAY_BENCH,
  set_player_tactic: 11,
};

export type TacticOrders = OpsOrders;
