import {
  type GameState,
  squadShortfall,
  firstTeamPlayers,
  pushNarrative,
} from "../../../../common/core/state";
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
import { departureSquadMorale, toFreeAgency } from "../../../../negotiation/market/departures";
import { buildDeparturePress } from "../../../../story/world/press";
import { openPress } from "../../story/world/press";
import { clampForm, moraleToForm } from "../../../../common/players/form";
import { item, signed } from "../../../../common/commands/brief";

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
  const squadMorale = departureSquadMorale(state, player);
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

  /**
   * **회견이 열릴 만한 자원이었는지가 사기의 문이기도 하다** — 회견을 여는 조건과
   * 같은 자를 쓴다. 백업 정리에도 라커룸이 상하면 정리 자체가 벌이 된다
   * (transfer.md §2). 회견 판정은 무소속이 된 **뒤에** 해야 남은 스쿼드와 견준다.
   */
  const press = buildDeparturePress(state, { playerId: player.id, severance, wasCaptain });
  if (press) {
    openPress(state, press);
    // 남은 1군만 — 떠난 당사자는 이미 무소속이라 자연히 빠진다
    for (const mate of firstTeamPlayers(state, state.userTeamId)) {
      mate.state.form = clampForm(mate.state.form + moraleToForm(squadMorale));
    }
  }

  pushNarrative(state, `${player.name} 계약 해지`, wasCaptain ? 5 : 4);
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
        ...(press
          ? [
              item({
                label: "1군 사기",
                text: signed(squadMorale),
                delta: squadMorale,
              }),
            ]
          : []),
      ],
    },
    message:
      `${josa(player.name, "과/와")} 계약을 해지했습니다 — ${agreed ? "정산금" : "위약금 전액"} ${formatMoney(severance)}` +
      (paymentYears === undefined
        ? "."
        : ` (${paymentYears}년 분할 — 첫 회분 ${formatMoney(dueNow)}).`) +
      " 무소속이 됐습니다 — 다른 구단이 데려갈 수 있습니다." +
      (wasCaptain ? " 주장이 떠났습니다 — 새 주장을 지명하세요." : "") +
      (press ? ` 기자회견이 열렸습니다. 남은 1군 사기 ${squadMorale}.` : ""),
  };
}
