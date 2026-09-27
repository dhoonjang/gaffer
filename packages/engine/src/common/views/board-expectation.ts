import { type GameState } from "../core/state";
import { type BoardExpectationCode } from "@story-fm/domain";
import { boardExpectationOfTier, tierOfTeamIn } from "../core/club-tier";
import { leagueSizeIn } from "../core/league-membership";

/**
 * 이 세이브에서 그 구단이 지고 있는 기대 — 체급은 세이브가 갖는다.
 * **코드와 목표 순위뿐이다** — 이름은 `boardExpectationText`가 만든다 (career.md §6).
 */
export function boardExpectation(
  state: GameState,
  teamId: string,
): { target: number; code: BoardExpectationCode } {
  return boardExpectationOfTier(tierOfTeamIn(state, teamId), leagueSizeIn(state, teamId));
}
