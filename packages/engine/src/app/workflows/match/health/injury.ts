import { type GameState, openInjury } from "../../../../common/core/state";
import { type GamePlayer } from "@story-fm/domain";
import { diffDays, addDays } from "../../../../common/core/dates";
import { rollInjury, raiseProneness } from "../../../../common/players/injury";
import { recordMedicalCost } from "../../../../negotiation/finance/finance";

/** 부상 발생 — INJURY row 생성 (현재 부상 = returnedOn null) */
export function openInjuryFor(
  state: GameState,
  player: GamePlayer,
  cause: "match" | "training",
  rng: () => number,
): { days: number; part: string } {
  /**
   * **선수당 미복귀는 최대 1건**(`domain/records.ts`)이고, 그 계약은 행을 쓰는 여기가
   * 지킨다. 이미 열린 부상이 있으면 새 행도 성향 상승도 치료비도 없고 — 안고 있는 그
   * 부상을 그대로 돌려준다. 지금 호출부는 모두 `isInjured`로 먼저 거르지만, 거르지
   * 않는 호출부가 하나 생기면 미복귀 두 건이 남아 복귀일도 부위도 둘이 되고,
   * 화면·조회·간이 시뮬이 각자 다른 하나를 집는다.
   */
  const current = openInjury(state, player.id);
  if (current) {
    const left = Math.max(0, diffDays(state.date, current.expectedReturn));
    return { days: left, part: current.bodyPart };
  }
  const { severity, days, part } = rollInjury(rng);
  state.injuries.push({
    id: `inj-${player.id}-${state.date}`,
    gamePlayerId: player.id,
    bodyPart: part,
    severity,
    cause,
    occurredOn: state.date,
    expectedReturn: addDays(state.date, days),
    returnedOn: null,
  });
  // 다친 사실은 그 선수에게 남는다 — 다음 부상이 조금 더 가까워진다
  raiseProneness(player, severity);
  // 치료비 — 부상은 재정에도 흔적을 남긴다 (finance.md §6). 남의 팀 장부는 우리 것이 아니다
  if (player.teamId === state.userTeamId) {
    recordMedicalCost(state, player.id, player.name, severity);
  }
  return { days, part };
}
