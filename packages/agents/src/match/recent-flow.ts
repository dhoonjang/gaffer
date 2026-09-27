import type { GameState } from "@story-fm/engine";
import { recentFlowOf } from "@story-fm/sim";

/** Only the confirmed live state supplies observed flow; no cumulative-stat fallback. */
export function buildRecentFlowBlock(state: GameState): string {
  const live = state.pendingMatch?.live;
  if (!live) return "";
  const flow = recentFlowOf(live);
  return [
    "<recent_match_flow>",
    `실제 관측 ${flow.observedSeconds}초, tick ${flow.startTick}–${flow.endTick}; 집계 정밀도 ${flow.precisionSeconds}초. 휴식 제외, 최대 최근 600초; 누적 경기 통계 아님.`,
    `home=${live.setup.sides.home.teamId}, away=${live.setup.sides.away.teamId}`,
    JSON.stringify(flow),
    "</recent_match_flow>",
  ].join("\n");
}
