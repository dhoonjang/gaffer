import { z } from "zod";

/**
 * 게임 안의 모든 날짜는 `YYYY-MM-DD` 하나로만 적는다 — 시각도 시간대도 없다.
 * 세이브에 그대로 담기는 형식이라, 검증하는 자리가 늘어나도 표현은 하나여야 한다.
 */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** `DATE_PATTERN`을 강제하는 날짜 문자열 스키마 */
export const DateString = z.string().regex(DATE_PATTERN);

/**
 * 두 날짜 사이의 일수 (`b − a`, 부호 있음) — **UTC 자정끼리 잰다.**
 *
 * 시각을 붙이지 않고 `Date.parse`에 그냥 넘기면 서머타임 경계에서 23시간·25시간짜리
 * 하루가 생겨 반올림이 하루를 삼킨다. `T00:00:00Z`를 붙이는 것이 그 자를 고정한다.
 *
 * 이 자리가 `packages/domain`인 이유는 **엔진과 도메인이 같이 부르기 때문이다** —
 * 전술 기억(`domain/tactics.ts`)은 엔진을 import 할 수 없으므로 엔진 안에 두면
 * 도메인이 같은 식을 베껴 적게 된다. 엔진은 `core/dates.ts`로 재수출한다.
 *
 * 음수(과거)와 `NaN`(형식이 깨진 날짜)은 그대로 돌려준다 — 0으로 접는 것은 부르는
 * 쪽의 판단이지 자의 성질이 아니다.
 */
/**
 * 새 게임이 서는 시즌 — **언제나 1이다** (`createGame`). 세이브의 `season`은
 * 여기서부터 세므로, 게임이 시작한 날짜도 이 번호 하나로 정해진다.
 */
export const FIRST_SEASON = 1;

/** 시즌 n의 기준 연도 — 시즌 1 = 2026 */
export function seasonYear(season: number): number {
  return 2026 + (season - 1);
}

/** 시즌 n이 열리는 날 — 7월 1일, 여름 이적창이 열리는 날이다 */
export function seasonStartOf(season: number): string {
  return `${seasonYear(season)}-07-01`;
}

export function diffDays(a: string, b: string): number {
  return Math.round(
    (new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86_400_000,
  );
}
