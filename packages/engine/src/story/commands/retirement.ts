import { RetirementDecisionSchema } from "@story-fm/domain";
import { type GameState, playerById } from "../../common/core/state";
import type { CommandResult } from "../../common/commands/result";

/** GM의 결정만 기록한다. 선수·계약·명단의 은퇴 정리는 시즌 전환이 실행한다. */
export function setRetirement(state: GameState, input: unknown): CommandResult {
  const parsed = RetirementDecisionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "은퇴 결정의 선수·행동·사유를 확인하세요" };
  if (state.phase === "match") return { ok: false, message: "은퇴 결정은 경기 밖에서 기록합니다" };
  const decision = parsed.data;
  const player = playerById(state, decision.playerId);
  if (!player) return { ok: false, message: "현역 선수를 찾을 수 없습니다" };
  const declared = player.state.retiringAfterSeason;
  if (decision.action === "withdraw") {
    if (!declared) return { ok: true, unchanged: true, message: "철회할 은퇴 선언이 없습니다" };
    delete player.state.retiringAfterSeason;
    return {
      ok: true,
      message: `${player.name}의 은퇴 선언을 철회했습니다`,
      brief: { head: "은퇴 선언 철회", items: [{ label: player.name, text: "현역 활동" }] },
    };
  }
  if (declared?.reason === decision.reason) {
    return { ok: true, unchanged: true, message: "이미 같은 은퇴 선언이 기록되어 있습니다" };
  }
  player.state.retiringAfterSeason = { on: state.date, reason: decision.reason };
  return {
    ok: true,
    message: `${player.name}의 시즌 말 은퇴를 기록했습니다`,
    brief: { head: "은퇴 선언", items: [{ label: player.name, text: "이번 시즌 종료 후 은퇴" }] },
  };
}
