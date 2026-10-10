/**
 * EA SPORTS FC 공식 레이팅의 세부 능력치 한 줄 — 시드가 싣는 모양 (core/sources.md §4.2).
 *
 * 값은 `scripts/ea-ratings.ts`가 공개 레이팅 API에서 받아 `ea-ratings.ts`에 적고,
 * 능력치 파생(`attributes.ts`)이 축으로 옮긴다. 이 모듈은 둘이 함께 읽는 열 순서와
 * 모양만 쥔다 — 열 순서가 두 벌이면 한쪽만 고친 날 모든 선수의 축이 한 칸씩 밀린다.
 */

/** 세부 능력치 34개의 열 순서 — 필드 29 + GK 5. `EaRating.s`가 이 순서로 적힌다 */
export const EA_STAT_KEYS = [
  "acceleration",
  "sprintSpeed",
  "positioning",
  "finishing",
  "shotPower",
  "longShots",
  "volleys",
  "penalties",
  "vision",
  "crossing",
  "freeKickAccuracy",
  "shortPassing",
  "longPassing",
  "curve",
  "agility",
  "balance",
  "reactions",
  "ballControl",
  "dribbling",
  "composure",
  "interceptions",
  "headingAccuracy",
  "defensiveAwareness",
  "standingTackle",
  "slidingTackle",
  "jumping",
  "stamina",
  "strength",
  "aggression",
  "gkDiving",
  "gkHandling",
  "gkKicking",
  "gkPositioning",
  "gkReflexes",
] as const;
export type EaStat = (typeof EA_STAT_KEYS)[number];

export interface EaRating {
  /** EA 선수 id — 다음 수집이 같은 사람을 다시 찾는 열쇠 */
  id: number;
  /** EA 종합(OVR) — 축이 아니라 종합 눈금을 대조하는 값이다 */
  ovr: number;
  /** EA 주 포지션 약어 (ST · RW · CDM …) */
  pos: string;
  /** EA 보조 포지션 약어 */
  alt: readonly string[];
  /** 주발 */
  foot: "L" | "R";
  /** 약발 별 1~5 */
  wf: number;
  /** 개인기 별 1~5 */
  sm: number;
  /** 키(cm) · 체중(kg) */
  h: number;
  w: number;
  /** 세부 능력치 — `EA_STAT_KEYS` 순서 */
  s: readonly number[];
  /** 플레이스타일 — 강화판(PlayStyle+)은 `pp`에 따로 */
  ps: readonly string[];
  pp: readonly string[];
}

/**
 * 세부 능력치마다 그것을 묶는 **대표 수치** — EA 카드의 여섯 숫자(PAC·SHO·PAS·DRI·DEF·PHY)와
 * GK 종합이다. 시드가 대표 수치만 가진 선수는 이 짝과 자리별 편차(`EA_FACE_MODEL`)로
 * 세부 능력치를 추정한다.
 */
export const EA_FACE_OF: Readonly<Record<EaStat, FaceKey>> = {
  acceleration: "pace",
  sprintSpeed: "pace",
  positioning: "shooting",
  finishing: "shooting",
  shotPower: "shooting",
  longShots: "shooting",
  volleys: "shooting",
  penalties: "shooting",
  vision: "passing",
  crossing: "passing",
  freeKickAccuracy: "passing",
  shortPassing: "passing",
  longPassing: "passing",
  curve: "passing",
  agility: "dribbling",
  balance: "dribbling",
  reactions: "dribbling",
  ballControl: "dribbling",
  dribbling: "dribbling",
  composure: "dribbling",
  interceptions: "defending",
  headingAccuracy: "defending",
  defensiveAwareness: "defending",
  standingTackle: "defending",
  slidingTackle: "defending",
  jumping: "physical",
  stamina: "physical",
  strength: "physical",
  aggression: "physical",
  gkDiving: "goalkeeping",
  gkHandling: "goalkeeping",
  gkKicking: "goalkeeping",
  gkPositioning: "goalkeeping",
  gkReflexes: "goalkeeping",
};

/** 대표 수치의 이름 — 시드(`RealPlayerSeed`)의 능력치 칸과 같다 */
export type FaceKey =
  "pace" | "shooting" | "passing" | "dribbling" | "defending" | "physical" | "goalkeeping";

/** 한 줄을 이름으로 읽는 표 — 파생 공식이 열 번호를 외우지 않게 */
export type EaStats = Record<EaStat, number>;

export function eaStatsOf(rating: Pick<EaRating, "s">): EaStats {
  return Object.fromEntries(EA_STAT_KEYS.map((key, i) => [key, rating.s[i] ?? 0])) as EaStats;
}

/** 이 선수가 그 플레이스타일을 가졌는가 — 강화판도 가진 것이다 */
export function hasPlayStyle(rating: Pick<EaRating, "ps" | "pp">, style: string): boolean {
  return rating.ps.includes(style) || rating.pp.includes(style);
}
