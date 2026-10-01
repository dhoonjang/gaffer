/**
 * 시장가 곡선 — **상태를 모르는 순수 계산**이다 (docs/negotiation/transfer.md §3).
 *
 * `market/market.ts`의 `marketValueOf`가 상태에서 등급·나이·잔여 계약·리그 경제를 읽어
 * 여기로 넘긴다. 세계를 만드는 자리(`core/state.ts`)도 같은 곡선으로 AI 계약의 바이아웃
 * 조항을 정하는데, 그쪽은 아직 상태가 서기 전이라 시장 모듈을 부를 수 없다 — 그래서
 * 곡선이 한 칸 아래로 내려와 둘이 같은 함수를 읽는다 (AGENTS.md §5 「한 규칙, 한 정의」).
 */

/**
 * 80 OVR·정점기 선수의 기준 시장가. 전체 곡선의 금액 배율이다.
 * 능력치 55를 바닥으로 비선형 곡선을 적용하며 주급 곡선과 별도로 계산한다.
 */
export const MARKET_VALUE_AT_PEAK = 65_000_000;
/** 그 금액이 붙는 등급 — 이 값과 `VALUE_FLOOR_RATING` 사이가 곡선의 허리다 */
const VALUE_PEAK_RATING = 80;
/** 곡선의 급함 — 클수록 최상급과 스쿼드 자원의 격차가 벌어진다 */
const VALUE_EXPONENT = 2.6;
/** 이 등급 아래는 이적료가 거의 붙지 않는다 */
const VALUE_FLOOR_RATING = 55;

/** 등급 → 기본 시장가. 80 OVR이 기준점이고 아래로 급하게 떨어진다 */
export function baseValueOf(overall: number): number {
  const over = Math.max(0, overall - VALUE_FLOOR_RATING);
  return (
    MARKET_VALUE_AT_PEAK * Math.pow(over / (VALUE_PEAK_RATING - VALUE_FLOOR_RATING), VALUE_EXPONENT)
  );
}

/** 나이·잠재력 곡선 — 피크는 24~27, 어린 유망주는 잠재력만큼 프리미엄 */
export function ageCurve(age: number, overall: number, potential: number): number {
  const upside = Math.max(0, potential - overall);
  // 어릴수록 "지금"보다 "될 것"에 값을 매긴다 — 유망주 프리미엄
  if (age <= 21) return 1 + Math.min(0.6, upside / 25);
  if (age <= 23) return 1 + Math.min(0.3, upside / 45);
  if (age <= 27) return 1;
  if (age <= 29) return 0.82;
  if (age <= 31) return 0.6;
  if (age <= 33) return 0.38;
  return 0.2;
}

export function contractFactor(yearsLeft: number): number {
  if (yearsLeft <= 0) return 0; // 계약 만료 = 자유계약, 이적료 없음
  if (yearsLeft < 1) return 0.45;
  if (yearsLeft < 2) return 0.7;
  if (yearsLeft < 3) return 0.9;
  return 1;
}

/** EPL(경제 수준 1.00)에서 뛰는 선수의 리그 보정 — 곡선 전체가 여기에 걸린다 */
export const LEAGUE_FACTOR_AT_TOP = 1.1;
/**
 * 리그 격차를 얼마나 눌러 쓰는가. 경제 수준을 날것으로 곱하면 챔피언십 선수가 EPL의
 * 15%가 된다 — 2부의 살림은 실제로 그만큼 작지만 **선수의 값은 리그가 아니라 주로
 * 능력에서 온다.** 0.15면 어느 리그에서 강등해도 ×0.75다 (=0.15^0.15).
 */
export const LEAGUE_FACTOR_EXPONENT = 0.15;
/**
 * 경제 수준의 하한 — 리그 2(0.063)보다 아래를 두지 않는다.
 *
 * 어드민은 중계권 0인 리그를 만들 수 있고(`admin-competition.ts`는 0 이상만 본다),
 * 그러면 경제 수준이 0이 되어 **그 리그 선수 전원의 몸값이 £0**이 된다.
 */
const LEAGUE_ECONOMY_FLOOR = 0.05;

/** 리그 경제 수준 → 시장가 보정. 어느 리그에서 뛰는가는 부르는 쪽이 정한다 */
export function leagueFactorOf(economy: number): number {
  return (
    LEAGUE_FACTOR_AT_TOP * Math.pow(Math.max(LEAGUE_ECONOMY_FLOOR, economy), LEAGUE_FACTOR_EXPONENT)
  );
}

export interface ValuationInput {
  overall: number;
  potential: number;
  age: number;
  /** 폼 −1~1 — 12%까지 값을 흔든다 */
  form: number;
  /** 잔여 계약(년) — 0이면 자유계약이라 값이 없다 */
  yearsLeft: number;
  /** 지금 뛰는 리그의 경제 수준 (`leagueEconomyLevel`) */
  economy: number;
}

/** 시장가 (£) — 10만 단위로 반올림한다. 안개 없는 진짜 값이다 */
export function playerValueOf(input: ValuationInput): number {
  const value =
    baseValueOf(input.overall) *
    ageCurve(input.age, input.overall, input.potential) *
    (1 + input.form * 0.12) *
    contractFactor(input.yearsLeft) *
    leagueFactorOf(input.economy);
  return Math.round(value / 100_000) * 100_000;
}
