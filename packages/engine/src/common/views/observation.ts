import { type GameState } from "../core/state";
import { type ConditionRead, readCondition } from "../players/observation";
import { clampCondition, conditionLabel } from "@story-fm/domain";

/**
 * 화면에 서는 체력 — **판세 탭과 팀 탭이 이 함수 하나를 지난다.**
 *
 * 경기 중이면 저장값에서 이 경기가 가져간 만큼을 뺀 지금 값에 안개를 씌운다
 * (`readCondition` · player.md §9.2) — 뛰는 동안 남은 다리는 아무도 못 재기
 * 때문이다. 두 탭이 같은 인자로 이 문을 지나므로 같은 선수가 두 숫자로 보이지
 * 않고, 팀 탭이 참값을 쓰던 시절처럼 **두 탭을 견줘 안개를 걷을 수도 없다.**
 *
 * `live`가 없으면(경기 밖 · 출전 명단 밖) 아침에 잰 값 그대로라 폭이 0이다 —
 * 그때는 읽은 값이 아니라 잰 값이다.
 */
export function conditionShown(
  state: GameState,
  playerId: string,
  saved: number,
  live: { drain: number; matchId: string } | null,
): ConditionRead {
  if (!live) {
    const value = clampCondition(saved);
    return { value, low: value, high: value, margin: 0, label: conditionLabel(value) };
  }
  return readCondition(state, playerId, Math.max(0, saved - live.drain), live.drain, live.matchId);
}
