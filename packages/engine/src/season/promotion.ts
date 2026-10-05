import { type GameState, catalogLeagueIn } from "../core/state";
import { teamsOfLeagueIn, RELEGATION_SLOTS } from "../core/league-membership";
import { computeStandings } from "./standings";
import { makeRng } from "../core/rng";
import { squadRating } from "../players/squad-depth";
import { type PositionGroup } from "@story-fm/domain";

/**
 * 승강 — 1부 하위 세 팀과 그 나라 2부 상위 세 팀이 자리를 바꾼다.
 *
 * 팀의 소속 리그는 카탈로그가 갖고 **불변**이므로(2-레이어 원칙) 승강은 세이브
 * 상태(`state.leagueOf`)로만 표현된다. "이 팀이 지금 어느 리그에 있는가"를 묻는
 * 자리는 전부 `leagueOfTeamIn`을 지나야 한다 — 일정·순위표·재정·조회
 * 도구. 소속에서 파생하는 판정도 같은 자리에 선다 — `isTopFlightIn`,
 * `clubEconomyLevelIn`. 카탈로그를 직접 읽어도 되는 것은 승강이 바꾸지 않는 축,
 * 곧 리그의 종류(`market-only` 등)와 나라, 그리고 세이브가 아직 없는 **세계 생성**뿐이다.
 *
 * 2부는 리그전을 돌지 않아 순위표가 없다(`league-catalog`의 `cup-only`). 그래서
 * 승격 팀은 **전력 + 시즌을 섞은 시드**로 뽑는다 — 다만 감독이 그 리그에 있으면
 * 그 시즌엔 진짜 순위표가 있으므로(`buildAllLeagueMatches`의 추가 리그) 표를 쓴다.
 */

/**
 * 승격 추첨의 폭 — 전력 **서열** 위에 얹히는 난수(자리 수).
 *
 * 전력을 점수 그대로 쓰면 안 된다: 방금 강등된 클럽은 실선수 스쿼드라 절차 생성
 * 2부 클럽보다 열다섯 점쯤 높아서, 어떤 난수를 얹어도 매년 그 셋이 그대로 올라온다.
 * 서열로 재면 눈금이 아니라 자리만 남아 4~5위도 올라올 수 있다.
 */
const PROMOTION_LUCK = 4;

/** 이 리그가 이번 시즌 실제로 경기를 했는가 — 안 뛴 리그는 강등도 없다 */
export function played(state: GameState, leagueId: string): boolean {
  return state.matches.some(
    (m) => m.season === state.season && m.competitionId === leagueId && m.result !== null,
  );
}

/** 올라올 세 팀 — 순위표가 있으면 그것으로, 없으면 전력 + 시즌 시드 */
export function promotedFrom(state: GameState, secondTier: string): string[] {
  const pool = teamsOfLeagueIn(state, secondTier);
  if (played(state, secondTier)) {
    return computeStandings(state, secondTier)
      .slice(0, RELEGATION_SLOTS)
      .map((r) => r.teamId);
  }
  // 시즌을 채널에 섞는다 — 안 그러면 한 세이브에서 매년 같은 팀이 올라온다
  const rng = makeRng(state.seed, `promotion:${secondTier}:${state.season}`);
  const byStrength = [...pool].sort((a, b) => squadRating(state, b) - squadRating(state, a));
  return byStrength
    .map((teamId, rank) => ({ teamId, score: pool.length - rank + rng() * PROMOTION_LUCK }))
    .sort((a, b) => b.score - a.score)
    .slice(0, RELEGATION_SLOTS)
    .map((x) => x.teamId);
}

export function setLeague(state: GameState, teamId: string, leagueId: string): void {
  const map = (state.leagueOf ??= {});
  // 세이브가 복사한 원 소속과 같으면 항목을 두지 않는다 — 지금 카탈로그와 견주면
  // 어드민의 리그 이동 편집이 진행 중인 세이브의 승강 기록을 지운다
  if (catalogLeagueIn(state, teamId) === leagueId) delete map[teamId];
  else map[teamId] = leagueId;
}

/**
 * 승격 팀이 1부 첫 시즌을 시작하는 **자리별 목표 인원**.
 *
 * 등록 뎁스 쿼터(`core/state.ts`의 `ESSENTIAL_QUOTA` — team.md §5)에 공격수 하나를
 * 얹은 표다. 인원만 세면 골키퍼 둘짜리 팀이 공격수를 다섯 받는다.
 */
const PROMOTED_QUOTA: Record<PositionGroup, number> = { GK: 3, DF: 8, MF: 8, FW: 6 };

/**
 * 승격 팀 명단의 하한 — **목표의 합이다**(25). 매치데이 정원(20)에 로테이션·부상
 * 몫 다섯을 얹은 수이고, 등록 명단 상한도 25라 하한이 상한을 밀지 않는다.
 * 같은 숫자를 두 곳에 적지 않으려고 표에서 낸다.
 */
export const PROMOTED_SQUAD_FLOOR = Object.values(PROMOTED_QUOTA).reduce((sum, n) => sum + n, 0);

/**
 * 보강이 서는 분위 — 그 클럽 **주전 열한 명 평균에서 이만큼 아래**.
 *
 * 체급 상수(`TIER_BASE`)를 쓰면 갓 올라온 팀이 1부 눈금의 선수를 다섯 공짜로 받아
 * 첫 시즌부터 중위권이 된다. 승격이 팀을 강하게 만드는 것이 아니라 **두껍게**
 * 만들어야 하므로, 기준선은 그 팀 자신의 명단에서 파생한다 (team.md §5).
 */
export const REINFORCEMENT_DROP = 4;

/** 보강 계약 기간 — 유스 콜업과 같은 3년 */
export const REINFORCEMENT_YEARS = 3;

/** 자리를 고르는 순서 — 부족분이 같으면 앞의 자리가 먼저다 (결정적) */
export const GROUP_ORDER: readonly PositionGroup[] = ["GK", "DF", "MF", "FW"];

/** 지금 가장 모자란 자리 — 부족분이 가장 큰 포지션군 */
export function neediestGroup(have: Record<PositionGroup, number>): PositionGroup {
  return GROUP_ORDER.reduce((best, group) =>
    PROMOTED_QUOTA[group] - have[group] > PROMOTED_QUOTA[best] - have[best] ? group : best,
  );
}
