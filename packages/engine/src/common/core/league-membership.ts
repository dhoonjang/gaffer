import { type GameState, catalogLeagueIn, clubProfileIn } from "./state";
import { isTopLeague, leagueCatalog, leagueCatalogById } from "../data/league-catalog";
import { clubEconomyLevel } from "../data/league-economy";
import { tierOfTeamIn } from "./club-tier";
import { RELEGATION_SLOTS } from "./league-shape";

/**
 * 이 팀이 지금 속한 리그 — 세 층을 순서대로 본다.
 *
 * 승강 결과(`state.leagueOf`) → 게임 시작에 복사한 소속(`GAME_TEAM.leagueId`) →
 * 카탈로그. 가운데 층이 있어야 어드민이 팀의 리그를 옮겨도 진행 중인 세이브의
 * 순위표·일정이 흔들리지 않는다 (game-state.md §1).
 */
export function leagueOfTeamIn(state: GameState, teamId: string): string {
  return state.leagueOf?.[teamId] ?? catalogLeagueIn(state, teamId);
}

/**
 * 이 팀이 지금 1부인가 — `isTopFlight`의 상태 인지 판.
 *
 * 카탈로그판은 **세계 생성**(새 게임의 스쿼드 분류·절차 생성·축소 세계)이 계속
 * 쓴다. 그 자리엔 아직 세이브가 없고, 새 게임의 결과는 카탈로그만으로 정해져야
 * 재현된다. 게임이 시작한 뒤 도는 자리(AI 시장·국내 컵 시드)는 이쪽이다.
 */
export function isTopFlightIn(state: GameState, teamId: string): boolean {
  return isTopLeague(leagueOfTeamIn(state, teamId));
}

/**
 * 이 구단의 지금 살림 수준 — `clubEconomyLevel`의 상태 인지 판. 리그도 체급도
 * 세이브가 답한다.
 *
 * 승강이 이 값을 움직이는 축이다(2부는 그 나라 1부에서 파생한다). 카탈로그판을
 * 그대로 두면 강등한 구단이 2부 수입을 받으면서 1부 고정비를 내고 1부 시즌 예산을
 * 배정받는다 (finance.md §6.2).
 */
export function clubEconomyLevelIn(state: GameState, teamId: string): number {
  return clubEconomyLevel(
    teamId,
    tierOfTeamIn(state, teamId),
    leagueOfTeamIn(state, teamId),
    clubProfileIn(state, teamId).commercialTier,
  );
}

/** 지금 그 리그에 속한 클럽 (세이브 기준) */
export function teamsOfLeagueIn(state: GameState, leagueId: string): string[] {
  return state.teams.filter((t) => leagueOfTeamIn(state, t.id) === leagueId).map((t) => t.id);
}

/**
 * 이 팀이 속한 리그의 클럽 수 — 순위 문턱이 파생하는 두 재료 중 하나
 * (`core/league-shape.ts` · career.md §5). 승강이 옮긴 소속을 본다.
 */
export function leagueSizeIn(state: GameState, teamId: string): number {
  return teamsOfLeagueIn(state, leagueOfTeamIn(state, teamId)).length;
}

/** 국내 컵을 채우는 2부들 — 승강의 상대 리그 */
export const secondTiers = () => leagueCatalog().filter((l) => l.kind === "cup-only");

/** 그 리그의 아래 — 같은 나라의 2부 (없으면 null) */
export function secondTierOf(leagueId: string): string | null {
  const country = leagueCatalogById(leagueId)?.country;
  if (!country) return null;
  return secondTiers().find((l) => l.country === country)?.id ?? null;
}

/** 이 리그에 승강이 있는가 — 아래 리그가 세이브에 실제로 있어야 한다(축소 세계엔 없다) */
export function hasRelegation(state: GameState, leagueId: string): boolean {
  const second = secondTierOf(leagueId);
  if (!second) return false;
  return teamsOfLeagueIn(state, second).length >= RELEGATION_SLOTS;
}
