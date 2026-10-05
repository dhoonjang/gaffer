import { type GameState, catalogLeagueIn, clubProfileIn } from "./state";
import { isTopLeague, leagueCatalog, leagueCatalogById } from "./catalog/league-catalog";
import { clubEconomyLevel } from "./catalog/league-economy";
import { type SeasonPrediction } from "@gaffer/domain";
import { teamCatalogById } from "./catalog/team-catalog";

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
 * (`core/league-membership.ts` · career.md §5). 승강이 옮긴 소속을 본다.
 */
export function leagueSizeIn(state: GameState, teamId: string): number {
  return teamsOfLeagueIn(state, leagueOfTeamIn(state, teamId)).length;
}

/** 국내 컵을 채우는 2부들 — 승강의 상대 리그 */
const secondTiers = () => leagueCatalog().filter((l) => l.kind === "cup-only");

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

/** 이번 시즌 대항전 참가 팀 — 추첨은 이미 일어난 사실이라 세이브에 남는다 */
export interface EuroEntry {
  cupId: string;
  teams: string[];
}

/** 세이브에 남은 이번 시즌 참가 팀 */
export function entrantsOf(entrants: EuroEntry[], cupId: string): string[] {
  return entrants.find((e) => e.cupId === cupId)?.teams ?? [];
}

/** 이 팀이 이번 시즌 나가는 대항전 (없으면 null) — 브리핑·서사용 */
export function euroCompetitionOf(entrants: EuroEntry[], teamId: string): string | null {
  return entrants.find((e) => e.teams.includes(teamId))?.cupId ?? null;
}

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

/** 구단 체급은 세이브가 소유하며, 새 게임의 기본값은 카탈로그에서 읽는다. */

/** 카탈로그에 없는 팀(어드민 추가 직후 등)의 체급 */
const TIER_FALLBACK = 3;

/**
 * **세이브가 없는 문맥**의 체급 — 새 게임 생성·절차 생성·어드민 미리보기·부임 전
 * 팀 목록. 게임이 진행 중이면 `tierOfTeamIn`을 써야 한다.
 */
export function catalogTierOf(teamId: string): 1 | 2 | 3 | 4 {
  return teamCatalogById(teamId)?.tier ?? TIER_FALLBACK;
}

/**
 * 이 팀의 **지금** 체급 — 세이브가 갖고, 세이브에 없는 팀이면 카탈로그가 답한다.
 * `leagueOfTeamIn`과 같은 모양이다.
 */
export function tierOfTeamIn(state: GameState, teamId: string): 1 | 2 | 3 | 4 {
  return state.teams.find((t) => t.id === teamId)?.tier ?? catalogTierOf(teamId);
}

/**
 * 리그의 모양에서 나오는 자리들 — **문턱은 순위가 아니라 리그의 크기에서 나온다**
 * (career.md §5).
 *
 * 보드 기대·경질 위험선·잔류·업적이 20팀 리그의 순위로 적혀 있었다. 18팀인
 * 분데스리가·리그 1에서 17위는 강등인데 그 값이 "잔류 충족"이었고, 34라운드 리그에
 * 38경기 무패는 있을 수 없다. 재료는 둘뿐이다 — 리그 팀 수와 강등 칸 수.
 *
 * 어느 도메인에도 속하지 않는 산수라 아무것도 import 하지 않는 자리에 둔다.
 */

/** 강등·승격 인원 — 실제 5대 리그와 같다 */
export const RELEGATION_SLOTS = 3;

/** 잔류가 확정되는 마지막 자리 — 20팀·3칸이면 17위, 18팀이면 15위 */
export function safetyLine(leagueSize: number, slots: number = RELEGATION_SLOTS): number {
  return Math.max(1, leagueSize - slots);
}

/** 리그전 전 경기 수 — 더블 라운드로빈. 20팀 38, 18팀 34 */
export function leagueRounds(leagueSize: number): number {
  return Math.max(0, (leagueSize - 1) * 2);
}
