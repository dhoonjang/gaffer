import { AI_MANAGER_RATING_FALLBACK } from "@story-fm/domain";
import { managedTeamId, type GameState } from "../../common/core/state";

/** 경기 지시 적용률에서 유저 팀은 중립값, 다른 팀은 소속 AI 감독의 전술 값을 쓴다. */
export function managerTacticsOf(state: GameState, teamId: string): number {
  return teamId === managedTeamId(state)
    ? AI_MANAGER_RATING_FALLBACK
    : (state.teams.find((team) => team.id === teamId)?.aiManagerTacticsRating ??
        AI_MANAGER_RATING_FALLBACK);
}
