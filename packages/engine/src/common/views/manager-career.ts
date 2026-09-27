import { type GameState, managedTeamId } from "../core/state";
import { leagueOfTeamIn } from "../core/league-membership";

// ── 감독의 통산 ───────────────────────────────────────

/** 감독이 벤치에서 보낸 시간 — 리그 경기와 승 (career.md §6) */
export interface ManagerCareerTotals {
  matches: number;
  wins: number;
}

/**
 * 감독 통산 — **저장하지 않는다.** 지나간 시즌은 `SEASON_RECORD`가, 이번 시즌은
 * 리그 장부가 답한다 (career.md §6). 합계를 따로 들면 원본이 둘이 되어 언젠가 갈린다.
 *
 * ⚠️ **리그 경기만 센다.** 시즌 기록이 리그 순위표의 승무패라, 컵까지 세면 같은
 * 통산이 지나간 시즌과 이번 시즌에서 다른 눈금을 갖는다. 잘린 시즌은 그 표에 줄이
 * 없어 통산에도 없고(career.md §5.1), 시즌 중 부임한 구단의 부임 전 경기는 순위표가
 * 구단 단위라 함께 센다 — 커리어 표가 이미 그렇게 서 있다.
 */
export function managerCareerTotals(state: GameState): ManagerCareerTotals {
  let matches = 0;
  let wins = 0;
  for (const record of state.seasonRecords) {
    matches += record.wins + record.draws + record.losses;
    wins += record.wins;
  }
  const now = managedTeamId(state);
  if (now === null) return { matches, wins };
  const leagueId = leagueOfTeamIn(state, now);
  for (const match of state.matches) {
    if (match.season !== state.season || match.competitionId !== leagueId) continue;
    const result = match.result;
    if (!result) continue;
    const home = match.homeTeamId === now;
    if (!home && match.awayTeamId !== now) continue;
    matches += 1;
    const us = home ? result.homeGoals : result.awayGoals;
    const them = home ? result.awayGoals : result.homeGoals;
    if (us > them) wins += 1;
  }
  return { matches, wins };
}
