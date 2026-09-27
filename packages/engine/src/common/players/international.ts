import { seasonYear, diffDays } from "../core/dates";
import { INTERNATIONAL_BREAKS } from "../core/international-breaks";
import { type GameState } from "../core/state";
import { type CallUp } from "@story-fm/domain";

/**
 * **대표팀 소집 — 휴식기는 빈 주말이 아니라 사건이다**
 * (→ [docs/match/competition.md](../../../../docs/match/competition.md) §5-1).
 *
 * A매치는 굴리지 않는다. 세계가 그 경기를 관측할 이유가 없기 때문이다 — 남는 것은
 * 「3경기 2골」이라는 사실 한 줄과 돌아온 몸이고, 그 둘은 결정적 추첨으로 충분하다.
 * 경기를 굴리면 5,700명을 나라별로 세우고 90분을 네 번 돌려야 하는데, 그 비용이
 * 사는 것은 이미 갖고 있는 두 개의 수뿐이다.
 *
 * 이 파일이 갖는 것은 넷이다 — 창(언제), 서열(누가), 추첨(무엇이 있었나),
 * 정산(어떤 몸으로 돌아오나). 문장은 하나도 쓰지 않는다.
 */

// ── 창 ────────────────────────────────────────────────

export interface InternationalBreak {
  /** `<시즌>:<MMDD>` — 세이브 안에서 이 창을 가리키는 유일한 키 */
  key: string;
  label: string;
  /** 소집일 (창의 첫날) */
  from: string;
  /** 복귀 정산일 (창의 마지막 날) */
  to: string;
}

/** `MMDD` 한 수 → 그 시즌의 ISO 날짜. 7월 이후는 시즌 연도, 그 앞은 이듬해다 */
export function dateOfMd(season: number, md: number): string {
  const month = Math.floor(md / 100);
  const day = md % 100;
  const year = seasonYear(season) + (month >= 7 ? 0 : 1);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** 이 시즌의 A매치 휴식기 넷 — 날짜가 붙은 창 (달력의 `INTERNATIONAL_BREAKS`에서 파생) */
export function internationalBreaksOf(season: number): InternationalBreak[] {
  return INTERNATIONAL_BREAKS.map((w) => ({
    key: `${season}:${String(w.from).padStart(4, "0")}`,
    label: w.label,
    from: dateOfMd(season, w.from),
    to: dateOfMd(season, w.to),
  }));
}

/** 그 창의 우리 팀 소집 — 화면·사실 카드가 읽는 자리 */
export function callUpsOfBreak(state: GameState, breakKey: string): CallUp[] {
  return state.callUps.filter((c) => c.breakKey === breakKey);
}

/** `<시즌>:<MMDD>` 키에서 시즌만 */
export function seasonOfKey(key: string): number {
  return Number(key.split(":")[0]);
}

/** 이 창의 명단에 대비해 지난 창에는 있었는데 이번엔 없는 우리 선수 — 낙마 */
export function droppedFrom(state: GameState, previousKey: string, currentKey: string): string[] {
  const now = new Set(callUpsOfBreak(state, currentKey).map((c) => c.gamePlayerId));
  return callUpsOfBreak(state, previousKey)
    .filter((c) => !now.has(c.gamePlayerId))
    .filter((c) => state.players.find((p) => p.id === c.gamePlayerId)?.teamId === state.userTeamId)
    .map((c) => c.gamePlayerId);
}

/** 이 창 바로 앞의 창 — 시즌 경계를 넘어 앞 시즌의 마지막 창으로 이어진다 */
export function previousBreakKey(key: string): string {
  const season = seasonOfKey(key);
  const windows = internationalBreaksOf(season);
  const i = windows.findIndex((w) => w.key === key);
  if (i > 0) return windows[i - 1]!.key;
  const prev = internationalBreaksOf(season - 1);
  return prev[prev.length - 1]!.key;
}

/** 오늘로부터 이 창의 복귀일까지 남은 날 — 화면·프롬프트가 읽는 사실 */
export function daysUntilReturn(state: GameState, window: InternationalBreak): number {
  return Math.max(0, diffDays(state.date, window.to));
}
