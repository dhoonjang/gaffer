import {
  type GameState,
  seasonStatOf,
  openInjury,
  contractTermsOf,
  lastSeasonAwardsOf,
  seasonMilestonesOf,
  formLabel,
  squadStatusOf,
  awardLine,
  playerById,
  formatMoney,
  teamNameIn,
  diffDays,
  describeWindowState,
} from "@story-fm/engine";
import {
  type Negotiation,
  type GamePlayer,
  seasonRating,
  SQUAD_STATUS_KO,
  milestonePhrase,
  mediaFactText,
} from "@story-fm/domain";
import {
  SITUATION_AWARDS,
  SITUATION_MILESTONES,
  SITUATION_PAST_DEALS,
  standingLine,
  euroLine,
  SITUATION_MEDIA_LINES,
  answeringClubOf,
  clubBlock,
} from "../../../negotiation/table-situation";

/**
 * 선수의 지금 — 시즌 기록·폼·부상·지위·심경·약속·감독과의 관계·시상·마일스톤.
 *
 * 시상의 창은 `state.season - 1` 하나이고(`lastSeasonAwardsOf` — season.md §6),
 * 마일스톤은 이번 시즌 것만이다. 없으면 그 줄이 아예 없다 — 「시상 없음」은 사실이
 * 아니라 빈칸을 메운 말이다.
 */
function playerBlock(state: GameState, negotiation: Negotiation, player: GamePlayer): string[] {
  const ours = player.teamId === state.userTeamId;
  const stat = seasonStatOf(state, player.id);
  const rating = seasonRating(stat);
  const injury = openInjury(state, player.id);
  // 계약에 적힌 조건 — 재계약 테이블의 선수 쪽이 지난 약속을 읽는 자리다 (transfer.md §12-3)
  const contractTerms = ours ? contractTermsOf(state, player.id) : [];
  const awards = lastSeasonAwardsOf(state, player.id).slice(0, SITUATION_AWARDS);
  const milestones = seasonMilestonesOf(state, player.id, state.season).slice(
    0,
    SITUATION_MILESTONES,
  );
  return [
    `<player_now>`,
    stat
      ? `이번 시즌: 출전 ${stat.apps} · 골 ${stat.goals} · 도움 ${stat.assists ?? 0}` +
        (rating === null ? "" : ` · 평점 ${rating}`)
      : `이번 시즌: 출전 없음`,
    `폼 ${formLabel(player.state.form)}` +
      (injury ? ` · 부상 중` : "") +
      ` · 지위 ${SQUAD_STATUS_KO[squadStatusOf(state, player)]}`,
    ...(contractTerms.length > 0 ? [`계약 조건: ${contractTerms.join(" · ")}`] : []),
    ...(awards.length > 0
      ? [`지난 시즌 시상: ${awards.map((a) => awardLine(a)).join(" · ")}`]
      : []),
    // 「구단 통산」 접두를 붙이는 것은 `milestonePhrase`다 — 떼면 읽는 쪽이 100경기를
    // 커리어 통산으로 읽고 원장에 없는 부임 전 이력을 흥정에 지어 넣는다
    ...(milestones.length > 0
      ? [`이번 시즌 기록: ${milestones.map((m) => milestonePhrase(m.code, m.value)).join(" · ")}`]
      : []),
    `</player_now>`,
  ];
}

/** 두 구단 사이의 지난 거래 — 상대가 "지난번엔"이라 말할 수 있는 사실 */
function pastDealsLine(state: GameState, otherTeamId: string): string | null {
  const us = state.userTeamId;
  const deals = state.transfers
    .filter(
      (t) =>
        (t.fromTeamId === us && t.toTeamId === otherTeamId) ||
        (t.fromTeamId === otherTeamId && t.toTeamId === us),
    )
    .slice(-SITUATION_PAST_DEALS)
    .reverse();
  if (deals.length === 0) return null;
  return (
    `지난 거래: ` +
    deals
      .map((t) => {
        const name = playerById(state, t.gamePlayerId)?.name ?? t.gamePlayerId;
        const arrow = t.toTeamId === us ? "→ 우리" : "→ 그쪽";
        return `${t.date} ${name} ${arrow} ${formatMoney(t.fee)}`;
      })
      .join(" · ")
  );
}

/** 우리 구단이 밖에서 보이는 모습 — 순위·유럽·감독 평판·무대·지난 거래 */
function ourClubBlock(state: GameState, otherTeamId: string | null): string[] {
  const us = state.userTeamId;
  return [
    `<our_club name="${teamNameIn(state, us)}">`,
    ...[standingLine(state, us), euroLine(state, us)].filter((l): l is string => l !== null),
    ...(otherTeamId === null ? [] : [pastDealsLine(state, otherTeamId)].filter((l) => l !== null)),
    `</our_club>`,
  ];
}

/** 시계 — 이적창과 협상 기한 */
function clockLine(state: GameState, negotiation: Negotiation): string {
  if (!negotiation.expiresOn) return `<clock>${describeWindowState(state)}</clock>`;
  const left = diffDays(state.date, negotiation.expiresOn);
  return (
    `<clock>${describeWindowState(state)} · 협상 기한 ${negotiation.expiresOn}` +
    (left > 0 ? ` (${left}일 남음)` : " (오늘)") +
    `</clock>`
  );
}

/** 회견 밖의 기사 — 그날의 배경 */
function pressBlock(state: GameState): string[] {
  const facts = state.media.slice(-SITUATION_MEDIA_LINES);
  if (facts.length === 0) return [];
  return [`<press>`, ...facts.map((f) => `- ${f.date} · ${mediaFactText(f)}`), `</press>`];
}

export function buildSituationBlock(state: GameState, negotiation: Negotiation): string | null {
  const player = playerById(state, negotiation.gamePlayerId);
  if (!player) return null;
  const club = answeringClubOf(negotiation, player);
  return [
    `<situation date="${state.date}">`,
    clockLine(state, negotiation),
    ...(club === null ? [] : clubBlock(state, club, player)),
    ...playerBlock(state, negotiation, player),
    ...ourClubBlock(state, club),
    ...pressBlock(state),
    `</situation>`,
  ].join("\n");
}
