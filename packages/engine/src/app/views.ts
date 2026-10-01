import { type MatchView, buildMatchView } from "../match/views/live";
import { type NegotiationRoomView, buildNegotiationView } from "../negotiation/views/room";
import { type SquadView, buildSquadView } from "./views/squad";
import { type CalendarView, buildCalendarView } from "./calendar-view";
import { type FinanceView, buildFinanceView } from "../negotiation/views/finance";
import { type CompetitionsView, buildCompetitionsView } from "../match/views/competition";
import { type CareerView, buildCareerView } from "./views/career";
import { type GameState, playerName } from "../common/core/state";
import { pendingVerdicts } from "../negotiation/market/negotiation";
import { squadRatingsOf } from "../common/players/squad-depth";
import { nextMatchFor } from "../common/core/calendar";

/**
 * 안건 한 갈래 — **감독이 답을 미루면 기한이 지나가는 일** (overview.md §5).
 *
 * 답할 차례의 협상이 안건으로 선다.
 * 어느 것도 상시로 서지 않는다 — 없으면 목록에서 빠진다.
 */
export type AttentionKind = "press" | "approach" | "verdicts";

/**
 * 안건 칩 하나가 읽는 **사실** — 문장은 화면이 조립한다 (overview.md §5).
 *
 * 갈래마다 값이 하나뿐인 것이 아니라, **하나면 이름 · 여럿이면 수**다. 다섯 갈래가
 * 한 줄에 서야 해서 이름을 여럿 세울 자리가 없고, 이름이 셋 늘어선 칩은 「누구부터」를
 * 말하지도 못한다.
 */
export interface AttentionItemView {
  kind: AttentionKind;
  /** 갈래의 이름 — 협상 */
  label: string;
  /** 이 갈래에 몇인가 */
  count: number;
  /** 하나뿐일 때 그 하나의 이름 — 여럿이면 수로 접히므로 null이다 */
  name: string | null;
  /**
   * 가장 이른 기한까지 남은 날 — 날짜가 없는 안건은 null이다.
   */
  daysLeft: number | null;
}

/** 오피스 뷰 — 상태의 읽기 전용 프로젝션 (overview §5) */
export interface OfficeViews {
  /** 경기 중에만 채워진다 — 그 밖에는 null */
  match: MatchView | null;
  /** 협상 방이 열려 있을 때만 채워진다 — 그 밖에는 null (transfer.md §12-2) */
  negotiation: NegotiationRoomView | null;
  /**
   * **답을 기다리는 일** — 상단 띠의 안건 칩 (overview.md §5). 있을 때만 채워지고
   * 없으면 빈 배열이다. 순서는 고정이다(협상) — 매 턴
   * 자리가 바뀌면 감독은 띠를 훑는 대신 매번 읽어야 한다.
   */
  attention: AttentionItemView[];
  squad: SquadView;
  calendar: CalendarView;
  finance: FinanceView;
  /** 대회 — 우리 리그 + 우리 대항전. 대회별 순위표와 일정이 한 자리에 (overview §5) */
  competitions: CompetitionsView;
  career: CareerView;
}

/**
 * 이 팀의 승패와 그 한글 표기는 **도메인의 것**이다 — 경기 기록 하나만 보면 답이
 * 나오는 규칙이라 화면·조회·코치의 눈이 같은 판정을 쓴다 (AGENTS.md §5 「한 규칙,
 * 한 정의」). 여기서 다시 내보내므로 코어 쪽 호출자는 자리를 옮기지 않는다.
 */
export { outcomeFor, outcomeLabel } from "@story-fm/domain";

/**
 * 오늘의 안건 — **스냅샷이 읽는 것과 같은 코어 함수에서 낸다** (overview.md §5).
 *
 * 뷰가 자기 판정을 세우면 화면의 칩과 GM이 받는 주의 줄이 다른 날 갈린다. 그래서
 * 여기 있는 규칙은 **무엇을 세우는가**가 아니라 **어떻게 접는가**뿐이다.
 *
 * ⚠️ **띠에 서는 협상은 감독이 도구로 답할 것뿐이다.** 답할 날이 된 라운드는 그날의
 * tick이 앵커로 굳히고 결과가 사건 한 줄로 서므로(transfer.md §12-1), 띠가 들 것은 그
 * 뒤에 감독의 차례로 남은 자리 하나다 (overview.md §5).
 */
export function attentionView(state: GameState): AttentionItemView[] {
  const items: AttentionItemView[] = [];
  // 방 안의 안건은 건너편 한 사람이다 — 띠에 다른 것을 세우지 않는다 (overview.md §5)
  if (state.phase === "negotiation") return items;
  const verdicts = pendingVerdicts(state);
  if (verdicts.length > 0) {
    items.push({
      kind: "verdicts",
      label: "협상",
      count: verdicts.length,
      name: verdicts.length === 1 ? playerName(state, verdicts[0]!.negotiation.gamePlayerId) : null,
      daysLeft: null,
    });
  }
  return items;
}

export function buildOfficeViews(state: GameState): OfficeViews;
export function buildOfficeViews<K extends keyof OfficeViews>(
  state: GameState,
  only: readonly K[],
): Pick<OfficeViews, K>;
export function buildOfficeViews(
  state: GameState,
  only?: readonly (keyof OfficeViews)[],
): Partial<OfficeViews> {
  let context:
    | { ratings: ReturnType<typeof squadRatingsOf>; next: ReturnType<typeof nextMatchFor> }
    | undefined;
  const calendarContext = () =>
    (context ??= {
      ratings: squadRatingsOf(state),
      next: nextMatchFor(
        state.matches,
        state.userTeamId,
        state.date,
        state.pendingMatch?.matchId ?? null,
      ),
    });
  const builders = {
    match: () => buildMatchView(state),
    negotiation: () => buildNegotiationView(state),
    attention: () => attentionView(state),
    squad: () => buildSquadView(state),
    calendar: () => {
      const { ratings, next } = calendarContext();
      return buildCalendarView(state, ratings, next);
    },
    finance: () => buildFinanceView(state),
    competitions: () => {
      const { ratings, next } = calendarContext();
      return buildCompetitionsView(state, ratings, next);
    },
    career: () => buildCareerView(state),
  };
  const keys = only ?? (Object.keys(builders) as (keyof OfficeViews)[]);
  return Object.fromEntries(keys.map((key) => [key, builders[key]()]));
}
