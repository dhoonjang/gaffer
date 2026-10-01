/** 구단 체급은 세이브가 소유하며, 새 게임의 기본값은 카탈로그에서 읽는다. */
import type { GameState } from "./state";
import { teamCatalogById } from "../data/team-catalog";

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
