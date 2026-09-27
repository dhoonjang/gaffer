import { type GameState } from "../core/state";
import { type SeasonPrediction } from "@story-fm/domain";
import { leagueOfTeamIn } from "../core/league-membership";

/** 그 시즌 그 리그의 예상 줄 — 없으면 null (예상이 서기 전) */
export function predictionOf(
  state: GameState,
  leagueId: string,
  season = state.season,
): SeasonPrediction | null {
  return state.predictions.find((r) => r.season === season && r.leagueId === leagueId) ?? null;
}

/**
 * 그 팀의 예상 순위 (1부터) — 예상이 없거나 그 표에 없으면 null.
 *
 * 리그를 묻지 않는다: 팀이 지금 속한 리그의 표를 본다. 승강으로 리그가 바뀌면 그
 * 시즌의 표는 새 리그의 것이라, 이 함수가 답하는 자리(회견 카드·순위표 열)와 같다.
 */
export function predictedPlaceOf(
  state: GameState,
  teamId: string,
  season = state.season,
): number | null {
  const row = predictionOf(state, leagueOfTeamIn(state, teamId), season);
  if (!row) return null;
  const index = row.order.indexOf(teamId);
  return index < 0 ? null : index + 1;
}
