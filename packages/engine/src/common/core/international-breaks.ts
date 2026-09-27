/**
 * A매치 휴식기 — 리그가 쉬는 네 주말. FIFA 캘린더의 자리라 대회와 무관하게 고정이다.
 *
 * **대표팀 소집도 이 표를 읽는다**(`competition/international.ts` ·
 * → docs/match/competition.md §5-1). 표가 소집 쪽이 아니라 여기 사는 이유는 라운드를
 * 비우는 판정(`isBlankWeekend`)이 같은 창을 읽기 때문이다 — 소집 쪽으로 옮기면 달력이
 * 소집 모듈을 불러야 하고, 소집 모듈은 세계 상태를 읽으므로
 * `calendar → international → state → calendar`가 된다. 날짜가 붙은 창은 소집 쪽이
 * 이 표에서 파생한다(`internationalBreaksOf`).
 */
export const INTERNATIONAL_BREAKS: ReadonlyArray<{
  /** 창을 가리키는 키의 자리이자 화면의 이름 */
  label: string;
  /** 월·일을 한 수로 (`MMDD`) — 시즌의 어느 해인지는 읽는 쪽이 붙인다 */
  from: number;
  to: number;
}> = [
  { label: "9월 A매치 휴식기", from: 901, to: 910 },
  { label: "10월 A매치 휴식기", from: 1008, to: 1014 },
  { label: "11월 A매치 휴식기", from: 1112, to: 1118 },
  { label: "3월 A매치 휴식기", from: 322, to: 331 },
];
