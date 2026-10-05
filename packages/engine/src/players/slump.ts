import { type GameState } from "../core/state";
import { isFriendly } from "../core/calendar";
import { isReserveMatch } from "@story-fm/domain";

/** 이번 시즌 공식 1군 경기의 최근 결과. 조회와 재정이 읽으며 폼을 바꾸지 않는다. */
export function recentOutcomes(state: GameState, teamId: string, limit: number): MatchOutcome[] {
  return state.matches
    .filter(
      (m) =>
        m.result &&
        m.season === state.season &&
        !isFriendly(m) &&
        // 2군 리그는 1군의 연속 기록이 아니다 — 섞이면 2군 2패 + 리그 1패가 3연패가 된다
        !isReserveMatch(m) &&
        (m.homeTeamId === teamId || m.awayTeamId === teamId),
    )
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .slice(0, limit)
    .map((m) => {
      const home = m.homeTeamId === teamId;
      const ours = home ? m.result!.homeGoals : m.result!.awayGoals;
      const theirs = home ? m.result!.awayGoals : m.result!.homeGoals;
      return ours > theirs ? "win" : ours === theirs ? "draw" : "loss";
    });
}

type MatchOutcome = "win" | "draw" | "loss";

/** 맨 앞부터 같은 결과가 몇 번 이어지나 */
export function streakOf(outcomes: readonly MatchOutcome[], kind: MatchOutcome): number {
  let n = 0;
  for (const o of outcomes) {
    if (o !== kind) break;
    n++;
  }
  return n;
}
