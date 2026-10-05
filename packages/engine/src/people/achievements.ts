import { type GameState, playersOf } from "../core/state";
import {
  leagueOfTeamIn,
  leagueSizeIn,
  leagueRounds,
  safetyLine,
  tierOfTeamIn,
} from "../core/league-membership";
import { domesticCupCatalog } from "../core/catalog/domestic-cup-catalog";
import {
  cupCatalog,
  euroSlotsOf,
  TOP_EURO_CUP_ID,
  competitionName,
} from "../core/catalog/cup-catalog";
import { domesticChampion } from "../season/domestic-cup";
import { euroChampion } from "../season/euro-knockout";
import { type StandingRow } from "../season/standings";
import {
  isReserveStat,
  type AchievementCode,
  type Achievement,
  achievementTitle,
} from "@story-fm/domain";
import { isTopLeague, leagueName } from "../core/catalog/league-catalog";

/** 골잡이 조련사가 서는 문턱 — 이만큼 넣은 최다 득점자가 우리 팀에 있어야 한다 */
const SHARPSHOOTER_GOALS = 15;

/**
 * 업적 검사 — **사실만 남긴다.** 코드와 근거 수치를 적고 이름·설명 문장은 읽는 쪽이
 * 쓴다 (career.md §6, overview.md §1 철칙 4).
 */
export function checkAchievements(state: GameState, position: number, row: StandingRow): void {
  const add = (code: AchievementCode, facts: Omit<Achievement, "code" | "season"> = {}) => {
    // 컵 업적은 대회마다 하나씩 붙으므로 대회까지 같을 때만 중복이다
    const dup = state.achievements.some(
      (a) =>
        a.code === code && a.season === state.season && a.competitionId === facts.competitionId,
    );
    if (dup) return;
    state.achievements.push({ code, season: state.season, ...facts });
  };
  const leagueId = leagueOfTeamIn(state, state.userTeamId);
  const size = leagueSizeIn(state, state.userTeamId);
  const rounds = leagueRounds(size);
  if (position === 1) add("champion", { position, leagueId });
  if (row.losses === 0 && row.played >= rounds)
    add("invincible", { matches: row.played, leagueId });
  // 유럽 최상위 진출은 **그 리그의 UCL 티켓 안**이다 — 순위 하나로 자르면 티켓이 없는
  // 2부의 4위에도 붙는다 (티켓 수는 리그마다 다르다, europe.ts의 배정과 같은 표)
  // 2부의 UCL 티켓은 **순위표가 아니라 전력 서열**이 정한다 (europe.ts `rankedTeams`) —
  // 리그전을 도는 리그에서만 "몇 위면 유럽"이 사실이다
  if (isTopLeague(leagueId) && position <= euroSlotsOf(TOP_EURO_CUP_ID, leagueId)) {
    add("ucl-spot", { position, leagueId });
  }

  /**
   * 골잡이 조련사는 **시즌 전 대회의 골**로 센다 — 감독이 키운 것은 골잡이이지
   * 리그 골잡이가 아니다. 행이 대회별로 갈리므로(game-state.md §3.4) 선수마다 먼저
   * 더한다: 안 더하면 리그 12 + 컵 5로 열일곱 골을 넣은 공격수가 문턱에 못 닿는다.
   */
  const goalsByPlayer = new Map<string, number>();
  for (const s of state.seasonStats) {
    if (s.season !== state.season || s.teamId !== state.userTeamId || isReserveStat(s)) continue;
    goalsByPlayer.set(s.gamePlayerId, (goalsByPlayer.get(s.gamePlayerId) ?? 0) + s.goals);
  }
  const topScorer = [...goalsByPlayer]
    .filter(([, goals]) => goals >= SHARPSHOOTER_GOALS)
    // 동률은 id로 끊는다 — 명단 순서가 업적의 주인을 정하면 안 된다 (§8 불변식)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
  if (topScorer) {
    const player = playersOf(state, state.userTeamId).find((p) => p.id === topScorer[0]);
    if (player) {
      add("sharpshooter", {
        gamePlayerId: player.id,
        playerName: player.name,
        goals: topScorer[1],
      });
    }
  }
  const tier = tierOfTeamIn(state, state.userTeamId);
  if (tier === 4 && position <= safetyLine(size)) add("survivor", { position, leagueId });

  // 컵·대항전 우승 — 결산이 먼저 돌아 우승 팀이 이미 정해져 있다 (`reviewSeason`의 순서)
  for (const cup of domesticCupCatalog()) {
    if (domesticChampion(state, cup.id) === state.userTeamId) {
      add("cup-winner", { competitionId: cup.id });
    }
  }
  for (const cup of cupCatalog()) {
    if (euroChampion(state, cup.id) === state.userTeamId) {
      add("euro-champion", { competitionId: cup.id });
    }
  }
}

/**
 * 업적 한 줄 — 코드가 주는 이름과 근거 수치로 **읽는 자리에서** 쓴다.
 * 세이브에는 문장이 없으므로 문구를 고치면 옛 업적도 새 문구로 읽힌다 (career.md §6).
 * 화면은 같은 사실을 뷰로 받아 제 문장을 쓴다 (`views.ts`).
 */
export function achievementLine(a: Achievement): string {
  const title = achievementTitle(a.code);
  const detail = achievementDetail(a);
  return detail ? `${title} — ${detail}` : title;
}

function achievementDetail(a: Achievement): string {
  if (a.competitionId) return `${competitionName(a.competitionId)} 우승`;
  if (a.playerName && a.goals !== undefined) return `${a.playerName} 시즌 ${a.goals}골`;
  if (a.matches !== undefined) return `${a.matches}경기 무패`;
  if (a.position !== undefined && a.leagueId) return `${leagueName(a.leagueId)} ${a.position}위`;
  return "";
}
