import {
  type GameState,
  leagueOfTeamIn,
  computeStandings,
  competitionName,
  euroCompetitionOf,
  stageScaleOf,
  playersOf,
  betterAtPosition,
  financeOf,
  teamNameIn,
  formatMoney,
  weeklyWagesOf,
} from "@story-fm/engine";
import {
  type GamePlayer,
  naturalPositionOf,
  type Negotiation,
  isPlayerDeal,
} from "@story-fm/domain";

/**
 * `<situation>` — **테이블 건너편이 아는 주변 상황** (agents.md §4-1 · transfer.md §12-2).
 *
 * 서류(`<counterparty>`)는 이 협상의 사실이고, 여기는 그 협상을 둘러싼 세계다 — 시계,
 * 답하는 쪽의 처지, 선수의 지금, 우리 구단이 밖에서 어떻게 보이는가. 상대가 "급한 건
 * 그쪽"이라 말할 수 있으려면 마감까지 며칠인지 알아야 하고, "우리 팀에 그 자리 선수가
 * 넷"이라 말하려면 그 수를 알아야 한다. 사실만 싣고 지시문은 싣지 않는다 (prompts.md §5).
 *
 * ⚠️ **메인 채팅은 여기 없다.** 상대는 감독이 이사회나 라커룸에 한 말을 모른다 — 그것이
 * 테이블을 GM 턴 밖에 따로 세운 이유다.
 */

/** 최근 기사 수 — 배경이지 화제가 아니다 */
export const SITUATION_MEDIA_LINES = 3;

/** 두 구단 사이의 지난 거래 — 최근 것부터 이만큼 */
export const SITUATION_PAST_DEALS = 3;

/** 지난 시즌 시상 — 장부 순서로 이만큼. 더 적으면 서류가 시상식이 된다 */
export const SITUATION_AWARDS = 2;

/** 이번 시즌 마일스톤 — 드문 것부터 이만큼 */
export const SITUATION_MILESTONES = 3;

/** 리그 순위 한 줄 — `프리미어리그 4위 (12경기 승점 25)` */
export function standingLine(state: GameState, teamId: string): string | null {
  const leagueId = leagueOfTeamIn(state, teamId);
  const rows = computeStandings(state, leagueId);
  const index = rows.findIndex((r) => r.teamId === teamId);
  if (index < 0) return null;
  const row = rows[index]!;
  return `${competitionName(leagueId)} ${index + 1}위 (${row.played}경기 승점 ${row.points})`;
}

/** 유럽 무대 한 줄 — 나가지 않으면 없다 */
export function euroLine(state: GameState, teamId: string): string | null {
  const cupId = euroCompetitionOf(state.euroEntrants, teamId);
  return cupId === null ? null : `유럽: ${competitionName(cupId)}`;
}

/** 우리와의 무대 격차 — 부호는 상대 기준이다 */
function stageLine(state: GameState, teamId: string): string {
  const gap = stageScaleOf(state).gapTo(teamId);
  if (Math.abs(gap) < 0.15) return "무대: 우리와 비슷하다";
  return gap > 0 ? "무대: 우리보다 크다" : "무대: 우리보다 작다";
}

/** 답하는 구단의 처지 — 순위·유럽·그 자리의 깊이·재정·무대 */
export function clubBlock(state: GameState, teamId: string, player: GamePlayer): string[] {
  const position = naturalPositionOf(player).position;
  const atPosition = playersOf(state, teamId).filter(
    (p) => naturalPositionOf(p).position === position,
  ).length;
  const better = betterAtPosition(state, teamId, player);
  const finance = financeOf(state, teamId);
  return [
    `<club name="${teamNameIn(state, teamId)}">`,
    ...[standingLine(state, teamId), euroLine(state, teamId)].filter(
      (l): l is string => l !== null,
    ),
    `이 자리(${position}): 선수 ${atPosition}명 · 그중 ${player.name}보다 나은 사람 ${better}명`,
    `재정: 이적 예산 ${formatMoney(finance.transferBudget)} · 주급 총액 ${formatMoney(
      weeklyWagesOf(state, teamId),
    )}/주 · 잔고 ${formatMoney(finance.balance)}`,
    stageLine(state, teamId),
    `</club>`,
  ];
}

/**
 * 답하는 쪽의 구단 — 선수 본인이 답하는 갈래(재계약·해지·사전 계약)에는 없다.
 * 매각·임대 송출의 상대는 선수의 소속이 아니라 사려는 구단이다 (transfer.md §1).
 */
export function answeringClubOf(negotiation: Negotiation, player: GamePlayer): string | null {
  if (isPlayerDeal(negotiation.kind) || negotiation.precontract === true) return null;
  const selling = negotiation.kind === "sell" || negotiation.kind === "loan_out";
  // 데려오는 갈래의 답하는 구단도 협상의 상대다 — 빌려 온 선수는 우리 팀에서 뛰고 있다
  return selling
    ? (negotiation.counterpartTeamId ?? null)
    : (negotiation.counterpartTeamId ?? player.teamId);
}
