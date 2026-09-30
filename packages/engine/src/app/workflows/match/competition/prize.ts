import { type GameState } from "../../../../common/core/state";
import { type PrizePayment, prizeLabel, prizeKey } from "../../../../match/competition/prize";
import { type TickSink, pushEvent } from "@story-fm/domain";
import { payOnce, formatMoney } from "../../../../common/finance/finance";

/**
 * 상금 한 건을 지급하고, 감독의 팀이면 다이제스트에 올린다.
 * 중복 지급은 `FINANCE.prizesPaid`의 키가 막는다 — 원장이 아니다 (finance.md §4.4·§4.5).
 *
 * **실제로 나갔는지를 돌려준다.** 그 불리언이 곧 "이 대회 이 시즌을 아직 결산하지
 * 않았다"는 사실이라, 매일 불리는 정산이 우승 보고를 되풀이하지 않는 문지기가 된다
 * (`advanceSuperCups`).
 */
export function payPrize(state: GameState, prize: PrizePayment, digest: TickSink): boolean {
  const label = prizeLabel(prize.cup, state.season, prize.what);
  const paid = payOnce(state, prize.teamId, prizeKey(prize.cup.id, prize.kind, state.season), {
    kind: "income",
    category: "prize",
    label,
    amount: prize.amount,
    ref: { type: "competition", id: prize.cup.id },
  });
  if (paid && prize.teamId === state.userTeamId) {
    // 상금은 추첨이 아니라 장부의 일이다 — 컵 패스가 추첨으로 잡혀 있어도 이 줄은 소식이다
    pushEvent(digest, "news", `${label} ${formatMoney(prize.amount)} 입금`);
  }
  return paid;
}
