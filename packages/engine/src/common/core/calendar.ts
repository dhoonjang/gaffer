import { dayOfWeek, addDays, seasonYear } from "./dates";
import { type ScheduleEntry, type MatchRecord, isReserveMatch } from "@story-fm/domain";

/**
 * 시즌 캘린더 — 게임은 7월 1일(여름 이적창 개장)에 시작해 프리시즌을 보내고
 * 8월 중순 개막전으로 들어간다. 경기·훈련·이적창이 모두 SCHEDULE_ENTRY 단일 축에
 * 등록되고, 경기 실체는 MATCH가 갖는다 (season.md §2).
 *
 * 날짜는 ISO 문자열(YYYY-MM-DD), 시간대 이슈를 피해 UTC로만 계산한다.
 */

export interface SeasonCalendar {
  season: number;
  /** 게임/시즌 시작일 = 7월 1일 */
  preseasonStart: string;
  /**
   * **선수단 소집일** — 이날부터 훈련이 가능하다. 그 전은 여름 휴가다.
   *
   * 기본 훈련 배치와 감독의 훈련 지시(`setTraining`)가 모두 이 날짜를 읽어야
   * 한다 — 휴가 기간을 모르면 아무도 없는 훈련장에 세션이 깔린다.
   */
  squadReturn: string;
  /** 리그 개막일 — 8월 중순 토요일 */
  start: string;
}

/**
 * 선수단이 돌아오는 날 = 7월 **둘째 월요일**.
 *
 * 실제 EPL 복귀는 7월 초~하순에 흩어져 있고(2026년 에버턴 7/10 · 다수 7/13 ·
 * 맨시티 7/20), FIFPro는 최소 4주 회복을 권고한다.
 */
export function preseasonReturnDate(preseasonStart: string): string {
  let date = preseasonStart;
  while (dayOfWeek(date) !== 1) date = addDays(date, 1); // 첫 월요일
  return addDays(date, 7); // 둘째 월요일
}

/** 이 세이브의 소집일 */
export function squadReturnOf(calendar: SeasonCalendar): string {
  return calendar.squadReturn;
}

/** 개막 토요일 — 8월 15일 이후 첫 토요일 (리그는 그 전날 금요일 밤에 개막한다) */
export function openerSaturday(year: number): string {
  let d = `${year}-08-15`;
  while (dayOfWeek(d) !== 6) d = addDays(d, 1);
  return d;
}

/**
 * 새 게임이 서는 시즌 — **언제나 1이다** (`createGame`). 세이브의 `season`은
 * 여기서부터 세므로, 게임이 시작한 날짜도 이 번호 하나로 정해진다.
 */
export const FIRST_SEASON = 1;

export function buildSeasonCalendar(season: number): SeasonCalendar {
  const year = seasonYear(season);
  // 개막전은 금요일 밤 — 주말 라운드의 첫 슬롯이다
  const preseasonStart = `${year}-07-01`;
  return {
    season,
    preseasonStart,
    squadReturn: preseasonReturnDate(preseasonStart),
    start: addDays(openerSaturday(year), -1),
  };
}

export function sortEntries(entries: ScheduleEntry[]): ScheduleEntry[] {
  return [...entries].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : a.time < b.time ? -1 : a.time > b.time ? 1 : 0,
  );
}

export function matchesOn(matches: MatchRecord[], date: string): MatchRecord[] {
  return matches.filter((m) => m.date === date);
}

/**
 * 다음 경기 — 결과가 없는 가장 이른 우리 경기.
 *
 * @param skipId 건너뛸 경기 하나 — **지금 치르는 경기**에 쓴다. 결과는 종료
 *   시점에 쓰이므로 경기 중에는 그게 "결과 없는 첫 경기"로 잡혀서, 화면이 다음
 *   상대 자리에 지금 상대를 세운다. 호출부에서 배열을 걸러 넘기면 시즌 전체
 *   경기(2,000여 건)를 뷰를 만들 때마다 복사하게 되므로 여기서 받는다.
 */
export function nextMatchFor(
  matches: MatchRecord[],
  teamId: string,
  date: string,
  skipId?: string | null,
): MatchRecord | null {
  let best: MatchRecord | null = null;
  for (const m of matches) {
    if (m.result || m.date < date || m.id === skipId) continue;
    if (m.homeTeamId !== teamId && m.awayTeamId !== teamId) continue;
    // 2군 경기는 1군의 "다음 경기"가 아니다 — 훈련 리듬도 회견도 여기 걸리면 안 된다
    if (isReserveMatch(m)) continue;
    if (best === null || m.date < best.date) best = m;
  }
  return best;
}

/** 시즌 마지막 경기일 — 달력 뷰의 시즌 종료 표기 */
export function seasonEndDate(matches: MatchRecord[]): string | null {
  return matches.reduce<string | null>(
    (max, m) => (max === null || m.date > max ? m.date : max),
    null,
  );
}
