import { type GameState, squadShortfall } from "../../../../common/core/state";
import { type CommandResult } from "../../../../common/commands/result";
import { pickSignedPlayer } from "../../../../common/core/player-ref";
import {
  loanLockOf,
  squadShortfallText,
  unilateralSeveranceOf,
  paymentYearsOf,
  firstInstallmentOf,
} from "../../../../negotiation/market/market";
import { josa, buildPaymentInstallments } from "@story-fm/domain";
import {
  formatMoney,
  settleDuePayments,
  recordFinance,
} from "../../../../negotiation/finance/finance";
import { toFreeAgency } from "../../../../negotiation/market/departures";
import { item } from "../../../../common/commands/brief";

/**
 * 계약 해지 — **돈으로 자리를 비운다.** 두 길의 공통 종착지다.
 *
 * `severance`가 실려 오면 **합의 해지의 확정**이다(`executeRelease`) — 값은 협상이
 * 정했다. 안 실려 오면 **일방 해지**이고, 값은 잔여 급여 **전액**이다
 * (`unilateralSeveranceOf`).
 *
 * ⚠️ **일방의 길을 닫지 않는 것이 이 함수의 일이다.** 합의가 끝내 안 되면 감독이
 * 전액을 물고 끊을 수 있어야 해지 협상이 협상이 된다 — 그 바깥값이 없으면 선수는
 * 무엇도 받아들일 이유가 없다 (transfer.md §2·§11).
 *
 * 어느 길이든 지불액은 즉시 나가고 원장에 남아 PSR까지 가며, 주급 총액에서 사라진다.
 */
export function releasePlayer(
  state: GameState,
  input: { playerId: string; severance?: number; paymentYears?: number },
): CommandResult {
  const pick = pickSignedPlayer(state, input.playerId);
  if (!pick.ok) return { ok: false, message: pick.message };
  const player = pick.player;
  // 임대 나간 선수도 계약은 우리 것이라 문을 지난다 — 임대 안내가 그에게 맞는 답이다
  // (transfer.md §2)
  const locked = loanLockOf(player);
  if (locked) return { ok: false, message: locked };
  const short = squadShortfall(state, state.userTeamId, player);
  if (short) return { ok: false, message: `우리 ${squadShortfallText(short, "release")}` };

  const agreed = input.severance !== undefined;
  const severance = Math.max(
    0,
    Math.round(input.severance ?? unilateralSeveranceOf(state, player.id)),
  );
  /**
   * **일방 해지는 분할을 타지 않는다** — 전액 일시금이 협상의 바깥값(BATNA)이고,
   * 그 값이 누그러지면 합의 해지에 응할 이유가 함께 사라진다 (transfer.md §11).
   */
  const paymentYears = agreed ? paymentYearsOf(input.paymentYears) : undefined;
  const dueNow = firstInstallmentOf(severance, paymentYears);
  const finance = state.finances.find((f) => f.teamId === state.userTeamId);
  if (finance && dueNow > finance.balance) {
    return {
      ok: false,
      message: `${agreed ? "정산금" : "위약금"} ${josa(formatMoney(dueNow), "을/를")} 감당할 잔고가 없습니다`,
    };
  }

  const wasCaptain = player.isCaptain;
  // 완장을 벗기기 전에 읽는다 — 떠나는 문이 곧 그 사람의 자리를 지운다
  const transferId = toFreeAgency(state, player, agreed ? "release-agreed" : "release-unilateral");
  if (severance > 0) {
    if (paymentYears !== undefined) {
      // 받는 쪽이 선수 본인이라 표가 payee를 갖지 않는다 — 원장은 우리 지출만 적는다
      state.paymentSchedules.push({
        id: `pay-${transferId}`,
        transferId,
        gamePlayerId: player.id,
        payerTeamId: state.userTeamId,
        payeeTeamId: null,
        kind: "severance",
        installments: buildPaymentInstallments(severance, paymentYears, state.date),
      });
      settleDuePayments(state);
    } else {
      recordFinance(state, state.userTeamId, {
        kind: "expense",
        category: "player_wages",
        label: `계약 해지 ${agreed ? "정산금" : "위약금"} — ${player.name}`,
        amount: severance,
        ref: { type: "player", id: player.id },
      });
    }
  }
  return {
    ok: true,
    brief: {
      head: "계약 해지",
      items: [
        item({ label: "해지", text: player.name, note: "무소속" }),
        item({
          label: agreed ? "정산금" : "위약금",
          text: formatMoney(severance),
          ...(paymentYears === undefined
            ? {}
            : { note: `${paymentYears}년 분할 · 첫 회분 ${formatMoney(dueNow)}` }),
        }),
        ...(wasCaptain ? [item({ text: "주장 공석" })] : []),
      ],
    },
    message:
      `${josa(player.name, "과/와")} 계약을 해지했습니다 — ${agreed ? "정산금" : "위약금 전액"} ${formatMoney(severance)}` +
      (paymentYears === undefined
        ? "."
        : ` (${paymentYears}년 분할 — 첫 회분 ${formatMoney(dueNow)}).`) +
      " 무소속이 됐습니다 — 다른 구단이 데려갈 수 있습니다." +
      (wasCaptain ? " 주장이 떠났습니다 — 새 주장을 지명하세요." : ""),
  };
}
