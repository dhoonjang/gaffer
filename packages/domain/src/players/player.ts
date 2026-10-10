import { LorebookContentSchema, type LorebookContent } from "../people/lorebook";
import { z } from "zod";
import { DateString } from "../core/date-string";
import { SQUAD_STATUSES, type SquadStatus } from "./squad-rules";
import { CARD_WORDS, CARD_WORD_DEFS, cardStep, type RoleCard } from "./role-card";
import { PlaceSchema, type Place } from "./place";
import { SLOT_REFERENCE } from "./slot-reference";

/** 등번호의 위끝 — 능력치 눈금과 같은 99지만 다른 축이다 */
export const SQUAD_NUMBER_MAX = 99;

/** 능력치 눈금의 위끝 — 0~99 스케일, 선수·감독 공통 (player.md §1) */
export const RATING_MAX = 99;

/** 체력 눈금의 위끝 — 0~100, 높을수록 좋다 */
export const CONDITION_MAX = 100;

/** **누적 피로 눈금의 위끝 — 기준점은 0이다** (player.md §5.5). 잔고라 빈 통이 곧 기준점이다 */
export const FATIGUE_MAX = 100;

/** 0~99 능력치 스케일 — 선수·감독 공통 (player.md §1) */
export const RatingSchema = z.number().int().min(0).max(RATING_MAX);

export const PositionGroupSchema = z.enum(["GK", "DF", "MF", "FW"]);
export type PositionGroup = z.infer<typeof PositionGroupSchema>;

/** 세분 포지션 코드 → 그룹 매핑 — 시뮬 존 계산·OVR 공식의 기준 */
export const POSITION_GROUPS: Record<string, PositionGroup> = {
  GK: "GK",
  RB: "DF",
  RWB: "DF",
  RCB: "DF",
  CB: "DF",
  LCB: "DF",
  LB: "DF",
  LWB: "DF",
  DM: "MF",
  CDM: "MF",
  LDM: "MF",
  RDM: "MF",
  RCM: "MF",
  CM: "MF",
  LCM: "MF",
  AM: "MF",
  CAM: "MF",
  LAM: "MF",
  RAM: "MF",
  RM: "MF",
  LM: "MF",
  RW: "FW",
  LW: "FW",
  SS: "FW",
  ST: "FW",
  LST: "FW",
  RST: "FW",
  CF: "FW",
  LF: "FW",
  RF: "FW",
};

export function positionGroupOf(position: string): PositionGroup | null {
  return POSITION_GROUPS[position.toUpperCase()] ?? null;
}

/**
 * 고를 수 있는 포지션 코드 — 매핑이 원본이라 축이 늘면 같이 늘어난다.
 * 명령 입구의 거절 메시지와 어드민의 선택지가 같은 목록을 읽어야 한다.
 */
export const POSITION_CODES = Object.keys(POSITION_GROUPS);

/** 포지션 코드의 한국어 이름 — 코드만으로는 갈래가 같은 자리끼리 구별되지 않는다 */
export const POSITION_NAMES: Readonly<Record<string, string>> = {
  GK: "골키퍼",
  RB: "오른쪽 풀백",
  RWB: "오른쪽 윙백",
  RCB: "오른쪽 센터백",
  CB: "센터백",
  LCB: "왼쪽 센터백",
  LB: "왼쪽 풀백",
  LWB: "왼쪽 윙백",
  DM: "수비형 미드필더",
  CDM: "가운데 수비형 미드필더",
  LDM: "왼쪽 수비형 미드필더",
  RDM: "오른쪽 수비형 미드필더",
  RCM: "오른쪽 중앙 미드필더",
  CM: "중앙 미드필더",
  LCM: "왼쪽 중앙 미드필더",
  AM: "공격형 미드필더",
  CAM: "가운데 공격형 미드필더",
  LAM: "왼쪽 공격형 미드필더",
  RAM: "오른쪽 공격형 미드필더",
  RM: "오른쪽 미드필더",
  LM: "왼쪽 미드필더",
  RW: "오른쪽 윙어",
  LW: "왼쪽 윙어",
  SS: "세컨드 스트라이커",
  ST: "스트라이커",
  LST: "왼쪽 스트라이커",
  RST: "오른쪽 스트라이커",
  CF: "센터포워드",
  LF: "왼쪽 포워드",
  RF: "오른쪽 포워드",
};

/** 라인의 앞뒤 순서 — 자리를 옮길 때 **몇 개의 라인을 넘는지** 세는 데 쓴다 */
export const POSITION_LINE_ORDER: Record<PositionGroup, number> = { GK: 0, DF: 1, MF: 2, FW: 3 };

/**
 * 슬롯 코드 → 자리. **가운데 레인의 좌·중·우는 자리 하나를 함께 쓰고**(LCB·CB·RCB → CB),
 * 측면은 왼쪽과 오른쪽이 따로다. 이름만 다른 표기(CDM·CAM)도 같은 자리다.
 */
const PLACE_OF_CODE: Record<string, Place> = {
  GK: "GK",
  LB: "LB",
  RB: "RB",
  LCB: "CB",
  CB: "CB",
  RCB: "CB",
  LWB: "LWB",
  RWB: "RWB",
  DM: "DM",
  CDM: "DM",
  LDM: "DM",
  RDM: "DM",
  LM: "LM",
  RM: "RM",
  LCM: "CM",
  CM: "CM",
  RCM: "CM",
  LW: "LW",
  RW: "RW",
  AM: "AM",
  CAM: "AM",
  LAM: "AM",
  RAM: "AM",
  SS: "AM",
  ST: "ST",
  LST: "ST",
  RST: "ST",
  CF: "ST",
  LF: "ST",
  RF: "ST",
};

/** 이 슬롯 코드가 읽는 자리 — 모르는 코드면 null */
export function placeOf(position: string): Place | null {
  return PLACE_OF_CODE[position.toUpperCase()] ?? null;
}

/** 두 코드가 같은 자리를 읽는가 (LCB↔CB ✅ · CF↔ST ✅ · RB↔RWB ❌) */
export function samePlace(a: string, b: string): boolean {
  const pa = placeOf(a);
  return pa !== null && pa === placeOf(b);
}

/**
 * **이웃 쌍** — 다른 자리지만 현대 축구에서 한 사람이 같은 일로 오가는 짝이다:
 * 풀백↔윙백(라인 높이만 다르다), 측면 미드↔윙어(4-4-2의 RM과 4-3-3의 RW는 같은 선수).
 * 생성은 짝을 주 자리 바로 아래로 주고, 폴백은 짝에서 2만 깎는다 (player.md §8).
 */
const PLACE_PAIRS: readonly (readonly [Place, Place])[] = [
  ["RB", "RWB"],
  ["LB", "LWB"],
  ["RM", "RW"],
  ["LM", "LW"],
];

/** 이웃 쌍의 감점 — 저장 목록에 짝만 있을 때 이 자리를 읽는 값 (player.md §8) */
export const PLACE_PAIR_PENALTY = 2;

/** 이 자리의 이웃 쌍 — 없으면 null */
export function pairedPlaceOf(place: string): Place | null {
  for (const [a, b] of PLACE_PAIRS) {
    if (a === place) return b;
    if (b === place) return a;
  }
  return null;
}

/** 좌우가 있는 코드 전부 — 중앙(CB·CM·CDM·CAM·ST·CF)은 어느 쪽도 아니다 */
const RIGHT_CODES = new Set(["RCB", "RB", "RWB", "RDM", "RCM", "RM", "RW", "RAM", "RF", "RST"]);
const LEFT_CODES = new Set(["LCB", "LB", "LWB", "LDM", "LCM", "LM", "LW", "LAM", "LF", "LST"]);

/** 포지션 코드의 좌우 축 — 중앙(CB·CM·CDM·CAM 등)은 null */
export function sideOf(position: string): "R" | "L" | null {
  const code = position.toUpperCase();
  if (RIGHT_CODES.has(code)) return "R";
  if (LEFT_CODES.has(code)) return "L";
  return null;
}

/**
 * **두 발의 숙련도** — 각 1~5. 주발 하나로 뭉뚱그리지 않는다.
 *
 * 양발잡이는 5/5, 약발이 조금 아쉬운 선수는 5/4, 한쪽만 쓰는 선수는 5/2다.
 * 등급 하나로 "왼발/오른발"을 나누면 카르바할과 로버트슨이 같은 취급을 받는데,
 * 실제로는 약발을 얼마나 쓰느냐가 그 선수의 폭을 정한다.
 */
const FootRatingSchema = z.number().int().min(1).max(5);

/**
 * 신체 — 키(cm)와 체중(kg). **능력치가 아니라 묘사다.**
 * 공중볼·몸싸움은 이미 16축에 있으므로 전력 계산에 다시 넣지 않는다.
 * 대신 서사와 판단의 재료가 된다 — "저 팀 세트피스에 190 넘는 선수가 넷이다".
 */
const HeightSchema = z.number().int().min(150).max(215);
const WeightSchema = z.number().int().min(50).max(120);

/** 체격 한 줄 — "188cm · 82kg" */
export function physiqueLabel(height?: number, weight?: number): string {
  if (height === undefined && weight === undefined) return "정보 없음";
  return [height === undefined ? null : `${height}cm`, weight === undefined ? null : `${weight}kg`]
    .filter(Boolean)
    .join(" · ");
}

const FootSchema = z.object({
  left: FootRatingSchema,
  right: FootRatingSchema,
});
export type Foot = z.infer<typeof FootSchema>;

/** 두 발이 같으면 양발 — 어느 쪽도 유리하지 않다 */
function isTwoFooted(foot: Foot): boolean {
  return foot.left === foot.right;
}

/** 화면·서사용 한 줄 — "왼발 5 · 오른발 2" / "양발 5" */
export function footLabel(foot: Foot | undefined): string {
  if (!foot) return "정보 없음";
  if (isTwoFooted(foot)) return `양발 ${foot.left}`;
  return `왼발 ${foot.left} · 오른발 ${foot.right}`;
}

/** 주발 — `footLabel`이 가르는 그 세 갈래. 데이터가 없으면 부를 이름이 없다(null) */
export type StrongFoot = "left" | "right" | "both";
export function strongFootOf(foot: Foot | undefined): StrongFoot | null {
  if (!foot) return null;
  if (isTwoFooted(foot)) return "both";
  return foot.left > foot.right ? "left" : "right";
}

/**
 * 두 발 차이 1당 보정 폭. 차이가 클수록 좌우가 갈린다 —
 * 5/4는 ±1, 5/3·5/2는 ±2, 5/1은 ±3. 양발(5/5)은 0이다.
 */
const FOOT_STEP = 0.75;

/**
 * 주발 보정 — **그 쪽 발이 반대쪽보다 얼마나 나은가**로 정한다.
 * 왼발잡이가 LCB를 CB·RCB보다 편해하는 것이 이 함수의 전부이고,
 * 약발이 좋을수록(5/4) 그 차이가 작아진다.
 *
 * ⚠️ **반올림은 0에서 멀어지는 쪽으로** — 좌우가 정확히 대칭이어야 한다
 * (`footAdjust(L) === -footAdjust(R)`). `Math.round`는 1.5를 2로, −1.5를 −1로
 * 접어 발 차이 2(5/3 — 카탈로그의 57%)에서 한쪽만 넓게 벌어졌다.
 *
 * ⚠️ **이 값은 저장하지 않는다** — 조회할 때 `positionProficiency`가 한 번만
 * 얹는다 (player.md §4). 저장된 적응도에 미리 얹어 두면 이중으로 걸린다.
 */
export function footAdjust(position: string, foot: Foot | undefined): number {
  if (!foot) return 0;
  const side = sideOf(position);
  if (side === null) return 0;
  const mine = side === "L" ? foot.left : foot.right;
  const other = side === "L" ? foot.right : foot.left;
  const gap = mine - other;
  return Math.sign(gap) * Math.round(Math.abs(gap) * FOOT_STEP);
}

/**
 * 능력치 37축 (player.md §1) — 전 선수가 37축 **전부**를 갖는다. 이름은 FM의 것이다.
 * 포지션별 예외 분기는 없다: 어떤 축이 그 선수에게 의미 있는지는
 * POSITION_WEIGHTS(§2)가 정한다. GK 축도 필드 플레이어가 낮은 값으로 보유.
 *
 * 축마다 엔진에 그 축만 읽는 자리가 있다. 실측이 없는 성격 축(리더십·팀워크·투지·
 * 용감성·의사소통)은 숫자로 두지 않는다 — 인물 카드의 문장이 대신한다 (player.md §1).
 */
export const ATTRIBUTE_AXES = [
  // 기술 12
  "finishing",
  "longShots",
  "heading",
  "dribbling",
  "firstTouch",
  "passing",
  "crossing",
  "technique",
  "tackling",
  "marking",
  "freeKicks",
  "penalties",
  // 정신 10 — 능력 7 · 성향 3
  "anticipation",
  "vision",
  "decisions",
  "composure",
  "offTheBall",
  "positioning",
  "concentration",
  "aggression",
  "flair",
  "workRate",
  // 신체 8
  "acceleration",
  "pace",
  "agility",
  "balance",
  "jumpingReach",
  "strength",
  "stamina",
  "naturalFitness",
  // GK 7
  "reflexes",
  "handling",
  "oneOnOnes",
  "aerialReach",
  "kicking",
  "commandOfArea",
  "rushingOut",
] as const;
export type AttributeAxis = (typeof ATTRIBUTE_AXES)[number];

/**
 * **성향 축** — 얼마나 자주·얼마나 세게 하려 하는가. 선택을 기울이고 성공에는 닿지
 * 않으며, 종합에 들지 않는다 (player.md §1.1). 능력 축은 거꾸로 성공만 정하고 선택에는
 * 기대값을 거쳐서만 닿는다 — 한 축이 둘을 다 쥐면 결정력 높은 선수가 동료의 슈팅까지
 * 가져간다.
 */
export const INCLINATION_AXES = [
  "aggression",
  "flair",
  "workRate",
  "commandOfArea",
  "rushingOut",
] as const satisfies readonly AttributeAxis[];
export type InclinationAxis = (typeof INCLINATION_AXES)[number];

/**
 * **종합에 드는 축** — 성향 축과 타고난 체력을 뺀 32축. 타고난 체력은 경기 사이의
 * 회복과 노화를 맡는 축이라 오늘의 실력이 아니다 (FM도 CA 비용이 0이다).
 */
export const OVERALL_AXES = ATTRIBUTE_AXES.filter(
  (axis) =>
    axis !== "naturalFitness" && !(INCLINATION_AXES as readonly AttributeAxis[]).includes(axis),
) as readonly OverallAxis[];
export type OverallAxis = Exclude<
  AttributeAxis,
  (typeof INCLINATION_AXES)[number] | "naturalFitness"
>;
const OVERALL_AXIS_SET: ReadonlySet<AttributeAxis> = new Set(OVERALL_AXES);

/** GK만의 능력 축 — 필드 자리의 종합에는 들지 않는다 */
const KEEPER_AXES: ReadonlySet<AttributeAxis> = new Set([
  "reflexes",
  "handling",
  "oneOnOnes",
  "aerialReach",
  "kicking",
]);

/** 필드 선수의 기술 축 — GK 자리의 종합에는 들지 않는다 (패스·퍼스트 터치는 GK도 쓴다) */
const OUTFIELD_SKILL_AXES: ReadonlySet<AttributeAxis> = new Set([
  "finishing",
  "longShots",
  "heading",
  "dribbling",
  "crossing",
  "technique",
  "tackling",
  "marking",
  "freeKicks",
  "penalties",
  "offTheBall",
]);

/**
 * 이 선수에게 뜻이 있는 **능력** 축 — 강점·약점을 고르는 자리가 읽는다. 성향 축은 능력이
 * 아니라 빠지고, 골키퍼는 필드 기술 축을, 필드 선수는 GK 축을 보지 않는다.
 */
export function abilityAxesFor(isKeeper: boolean): AttributeAxis[] {
  return ATTRIBUTE_AXES.filter(
    (axis) =>
      !(INCLINATION_AXES as readonly AttributeAxis[]).includes(axis) &&
      (isKeeper ? !OUTFIELD_SKILL_AXES.has(axis) : !KEEPER_AXES.has(axis)),
  );
}

/**
 * 그 자리의 평균 선수와 견줘 **두드러진** 능력 축 — 강점은 위로, 약점은 아래로 가장 많이
 * 벗어난 축이다(`SLOT_REFERENCE`). 절대값으로 고르면 스트라이커의 약점은 언제나 태클·마킹이라
 * 아무것도 말하지 않는다.
 */
export function standoutAxes(
  attributes: Readonly<Record<AttributeAxis, number>>,
  position: string,
  count: number,
): { strengths: OverallAxis[]; weaknesses: OverallAxis[] } {
  const slot = weightSlotOf(position);
  const reference = SLOT_REFERENCE[slot];
  const ranked = abilityAxesFor(slot === "GK")
    .filter((axis): axis is OverallAxis => OVERALL_AXIS_SET.has(axis))
    .map((axis) => ({ axis, gap: attributes[axis] - reference[axis] }))
    .sort((a, b) => b.gap - a.gap);
  return {
    strengths: ranked.slice(0, count).map((r) => r.axis),
    weaknesses: ranked
      .slice(-count)
      .reverse()
      .map((r) => r.axis),
  };
}

/**
 * 이 이름이 37축 중 하나인가 — 세이브·판정·명령 입력이 들고 온 문자열을 좁히는
 * 유일한 문. 축 이름은 저장에 `string`으로 남으므로(`PlayerTraining.axis`) 읽는
 * 쪽마다 좁히면 한쪽만 조여진다.
 */
export function attributeAxisOf(value: string | null | undefined): AttributeAxis | null {
  return value !== null &&
    value !== undefined &&
    (ATTRIBUTE_AXES as readonly string[]).includes(value)
    ? (value as AttributeAxis)
    : null;
}

export const AXIS_KO: Record<AttributeAxis, string> = {
  finishing: "결정력",
  longShots: "중거리 슛",
  heading: "헤더",
  dribbling: "드리블",
  firstTouch: "퍼스트 터치",
  passing: "패스",
  crossing: "크로스",
  technique: "테크닉",
  tackling: "태클",
  marking: "마킹",
  freeKicks: "프리킥",
  penalties: "페널티킥",
  anticipation: "예측력",
  vision: "시야",
  decisions: "판단력",
  composure: "침착성",
  offTheBall: "오프 더 볼",
  positioning: "위치 선정",
  concentration: "집중력",
  aggression: "적극성",
  flair: "창의성",
  workRate: "활동량",
  acceleration: "가속력",
  pace: "속력",
  agility: "민첩성",
  balance: "균형 감각",
  jumpingReach: "점프력",
  strength: "몸싸움",
  // "체력"은 사기·피로를 합친 표시 수치(conditionOf)가 쓴다 — 축은 지구력으로 부른다
  stamina: "지구력",
  naturalFitness: "타고난 체력",
  reflexes: "반사 신경",
  handling: "핸들링",
  oneOnOnes: "1대1",
  aerialReach: "공중볼 처리",
  kicking: "킥",
  commandOfArea: "공중볼 장악",
  rushingOut: "나오기",
};

/** 축 묶음 — FM의 네 묶음. UI 그룹 헤더·조회 도구 요약용 */
export const AXIS_GROUPS = {
  technical: [
    "finishing",
    "longShots",
    "heading",
    "dribbling",
    "firstTouch",
    "passing",
    "crossing",
    "technique",
    "tackling",
    "marking",
    "freeKicks",
    "penalties",
  ],
  mental: [
    "anticipation",
    "vision",
    "decisions",
    "composure",
    "offTheBall",
    "positioning",
    "concentration",
    "aggression",
    "flair",
    "workRate",
  ],
  physical: [
    "acceleration",
    "pace",
    "agility",
    "balance",
    "jumpingReach",
    "strength",
    "stamina",
    "naturalFitness",
  ],
  goalkeeping: [
    "reflexes",
    "handling",
    "oneOnOnes",
    "aerialReach",
    "kicking",
    "commandOfArea",
    "rushingOut",
  ],
} as const satisfies Record<string, readonly AttributeAxis[]>;

export const AXIS_GROUP_KO: Record<keyof typeof AXIS_GROUPS, string> = {
  technical: "기술",
  mental: "정신",
  physical: "신체",
  goalkeeping: "GK",
};

/** 37축과 성장 상한만 저장한다. 종합은 playerOverall에서 파생한다 */
const PlayerAttributesSchema = z.object({
  ...(Object.fromEntries(ATTRIBUTE_AXES.map((a) => [a, RatingSchema])) as Record<
    AttributeAxis,
    typeof RatingSchema
  >),
  potential: RatingSchema,
});
export type PlayerAttributes = z.infer<typeof PlayerAttributesSchema>;

/** 37축만 담은 값 묶음 — overall·potential 없이 계산에 쓰는 입력 타입 */
export type AxisValues = Record<AttributeAxis, number>;

// ── 포지션 가중치 (player.md §2) ───────────────

/**
 * 가중치를 매기는 **자리** — 22개 포지션 코드를 9종으로 접는다.
 * 좌우 분화(RCB/LCB)나 표기 차이(DM/CDM)는 요구 역량이 같으므로 같은 슬롯을 쓴다.
 *
 * `ST`와 `CF`는 **다른 자리다**. 최전방 한 자리를 누가 맡느냐가 갈리는 지점이라
 * 접지 않는다: `ST`는 최종 수비선을 물고 마무리하는 9번(피지컬·공중볼·위치선정),
 * `CF`는 내려와 연결하며 몰고 들어가는 전방(드리블·시야·패스). 쿠냐·음뵈모·
 * 래시포드처럼 정통 9번이 아닌 선수가 4-2-3-1의 "1"을 맡는 경우가 CF다.
 */
export type WeightSlot = "GK" | "CB" | "FB" | "DM" | "CM" | "AM" | "W" | "CF" | "ST";

const SLOT_OF_POSITION: Record<string, WeightSlot> = {
  GK: "GK",
  RCB: "CB",
  CB: "CB",
  LCB: "CB",
  RB: "FB",
  LB: "FB",
  RWB: "FB",
  LWB: "FB",
  DM: "DM",
  CDM: "DM",
  LDM: "DM",
  RDM: "DM",
  RCM: "CM",
  CM: "CM",
  LCM: "CM",
  AM: "AM",
  CAM: "AM",
  LAM: "AM",
  RAM: "AM",
  RM: "W",
  LM: "W",
  RW: "W",
  LW: "W",
  // 처진 스트라이커(SS)는 정통 9번보다 CF에 가깝다
  CF: "CF",
  SS: "CF",
  LF: "CF",
  RF: "CF",
  ST: "ST",
  LST: "ST",
  RST: "ST",
};

export function weightSlotOf(position: string): WeightSlot {
  return SLOT_OF_POSITION[position.toUpperCase()] ?? "CM";
}

/**
 * **그 자리에 있는 축은 0이 아니다** — 표의 하한이자 "거의 무관"의 자리.
 *
 * 스트라이커의 태클도 실제 경기에선 조금은 쓰인다(전방 압박, 상대 역습 첫 지연).
 * 0으로 두면 태클 30인 9번과 60인 9번이 완전히 같은 선수가 된다. 그 자리에 **없는**
 * 축(필드 자리의 GK 축, GK 자리의 필드 기술 축)만 0이다 (`axisFloorAt`).
 *
 * ⚠️ 바닥은 **진짜 바닥**이어야 한다 — 이 값이 크면 자리의 색이 흐려진다.
 */
export const FLOOR_WEIGHT = 0.05;

/** 이 자리에서 그 축이 내려갈 수 있는 바닥 — 그 자리에 없는 축이면 0 */
export function axisFloorAt(slot: WeightSlot, axis: OverallAxis): number {
  const absent = slot === "GK" ? OUTFIELD_SKILL_AXES.has(axis) : KEEPER_AXES.has(axis);
  return absent ? 0 : FLOOR_WEIGHT;
}

/** 가중치의 천장 — 역할 차이를 얹어도 한 축이 이보다 무거워지지는 않는다 */
const CEIL_WEIGHT = 3;

/** 가중치의 해상도 — 0.05 단위로 떨어뜨려야 표와 계산이 같은 값을 본다 */
const roundWeight = (v: number) => Math.round(v * 20) / 20;

/** 한 자리의 종합 가중치 — 종합에 드는 축(`OVERALL_AXES`)마다 하나 */
export type OverallWeights = Record<OverallAxis, number>;

/**
 * 자리별 축 가중치 — `overall`·`cardFit`·간이 시뮬 존 점수의 단일 소스다 (player.md §2).
 * 각 자리의 값은 그 자리의 **기본 역할**(센터백·풀백·윙어…)이고, 역할 카드는 여기에
 * 낱말의 성공 축을 얹는다 (`cardWeights`).
 *
 * ⚠️ **합은 의미가 없다.** `cardFit`이 가중 평균이라 자리 안의 **상대 비율**만
 * 결과에 닿는다. 카드 기준점은 카드마다 계산되므로 따로 다시 잴 표가 없다.
 *
 * ⚠️ **0인 칸은 그 자리에 없는 축이다** — 필드 자리의 GK 축, GK 자리의 필드 기술 축
 * (`KEEPER_AXES`·`OUTFIELD_SKILL_AXES`). 나머지 칸은 바닥(`FLOOR_WEIGHT`) 아래로
 * 내려가지 않는다. 0을 허락하지 않으면 GK의 종합에 결정력·태클 열 개가 바닥 무게로
 * 얹혀 골키퍼 전원이 8점씩 내려간다.
 */
export const POSITION_WEIGHTS: Record<WeightSlot, OverallWeights> = {
  GK: {
    finishing: 0,
    longShots: 0,
    heading: 0,
    dribbling: 0,
    firstTouch: 0.05,
    passing: 0.05,
    crossing: 0,
    technique: 0,
    tackling: 0,
    marking: 0,
    freeKicks: 0,
    penalties: 0,
    anticipation: 0.15,
    vision: 0.05,
    decisions: 0.05,
    composure: 0.1,
    offTheBall: 0,
    positioning: 0.2,
    concentration: 0.05,
    acceleration: 0.05,
    pace: 0.05,
    agility: 0.45,
    balance: 0.05,
    jumpingReach: 0.05,
    strength: 0.05,
    stamina: 0.05,
    reflexes: 1.05,
    handling: 0.6,
    oneOnOnes: 0.45,
    aerialReach: 0.55,
    kicking: 0.35,
  },
  CB: {
    finishing: 0.05,
    longShots: 0.05,
    heading: 1.2,
    dribbling: 0.05,
    firstTouch: 0.05,
    passing: 0.25,
    crossing: 0.1,
    technique: 0.1,
    tackling: 1.6,
    marking: 1.05,
    freeKicks: 0.05,
    penalties: 0.05,
    anticipation: 0.45,
    vision: 0.05,
    decisions: 0.25,
    composure: 0.25,
    offTheBall: 0.25,
    positioning: 0.65,
    concentration: 0.15,
    acceleration: 0.3,
    pace: 0.35,
    agility: 0.05,
    balance: 0.65,
    jumpingReach: 1.8,
    strength: 1.9,
    stamina: 0.2,
    reflexes: 0,
    handling: 0,
    oneOnOnes: 0,
    aerialReach: 0,
    kicking: 0,
  },
  FB: {
    finishing: 0.05,
    longShots: 0.25,
    heading: 0.15,
    dribbling: 0.35,
    firstTouch: 0.2,
    passing: 0.4,
    crossing: 0.3,
    technique: 0.2,
    tackling: 1.35,
    marking: 0.9,
    freeKicks: 0.15,
    penalties: 0.05,
    anticipation: 0.5,
    vision: 0.25,
    decisions: 0.1,
    composure: 0.15,
    offTheBall: 0.55,
    positioning: 0.8,
    concentration: 0.1,
    acceleration: 1.35,
    pace: 1.65,
    agility: 0.1,
    balance: 0.2,
    jumpingReach: 0.2,
    strength: 0.5,
    stamina: 2.2,
    reflexes: 0,
    handling: 0,
    oneOnOnes: 0,
    aerialReach: 0,
    kicking: 0,
  },
  DM: {
    finishing: 0.05,
    longShots: 0.3,
    heading: 0.2,
    dribbling: 0.2,
    firstTouch: 0.1,
    passing: 1.5,
    crossing: 0.65,
    technique: 0.5,
    tackling: 1.8,
    marking: 1.2,
    freeKicks: 0.35,
    penalties: 0.05,
    anticipation: 0.95,
    vision: 1.35,
    decisions: 0.4,
    composure: 0.45,
    offTheBall: 0.6,
    positioning: 1.45,
    concentration: 0.3,
    acceleration: 0.1,
    pace: 0.15,
    agility: 0.05,
    balance: 0.35,
    jumpingReach: 0.25,
    strength: 0.95,
    stamina: 1.7,
    reflexes: 0,
    handling: 0,
    oneOnOnes: 0,
    aerialReach: 0,
    kicking: 0,
  },
  CM: {
    finishing: 0.2,
    longShots: 0.3,
    heading: 0.05,
    dribbling: 0.4,
    firstTouch: 0.25,
    passing: 1.8,
    crossing: 0.65,
    technique: 0.55,
    tackling: 0.6,
    marking: 0.4,
    freeKicks: 0.4,
    penalties: 0.05,
    anticipation: 0.1,
    vision: 1.95,
    decisions: 0.3,
    composure: 0.35,
    offTheBall: 0.25,
    positioning: 0.2,
    concentration: 0.2,
    acceleration: 0.15,
    pace: 0.2,
    agility: 0.1,
    balance: 0.15,
    jumpingReach: 0.1,
    strength: 0.25,
    stamina: 1.7,
    reflexes: 0,
    handling: 0,
    oneOnOnes: 0,
    aerialReach: 0,
    kicking: 0,
  },
  AM: {
    finishing: 0.8,
    longShots: 0.6,
    heading: 0.05,
    dribbling: 1.2,
    firstTouch: 0.7,
    passing: 1.7,
    crossing: 0.6,
    technique: 0.5,
    tackling: 0.05,
    marking: 0.05,
    freeKicks: 0.35,
    penalties: 0.15,
    anticipation: 0.1,
    vision: 3,
    decisions: 0.3,
    composure: 0.35,
    offTheBall: 0.45,
    positioning: 0.15,
    concentration: 0.25,
    acceleration: 0.25,
    pace: 0.35,
    agility: 0.35,
    balance: 0.15,
    jumpingReach: 0.05,
    strength: 0.15,
    stamina: 0.55,
    reflexes: 0,
    handling: 0,
    oneOnOnes: 0,
    aerialReach: 0,
    kicking: 0,
  },
  W: {
    finishing: 0.8,
    longShots: 0.6,
    heading: 0.05,
    dribbling: 1.35,
    firstTouch: 0.8,
    passing: 0.3,
    crossing: 0.25,
    technique: 0.15,
    tackling: 0.05,
    marking: 0.05,
    freeKicks: 0.15,
    penalties: 0.15,
    anticipation: 0.1,
    vision: 0.5,
    decisions: 0.2,
    composure: 0.2,
    offTheBall: 0.4,
    positioning: 0.1,
    concentration: 0.15,
    acceleration: 1.35,
    pace: 1.65,
    agility: 0.4,
    balance: 0.2,
    jumpingReach: 0.05,
    strength: 0.15,
    stamina: 0.55,
    reflexes: 0,
    handling: 0,
    oneOnOnes: 0,
    aerialReach: 0,
    kicking: 0,
  },
  CF: {
    finishing: 1.8,
    longShots: 1.1,
    heading: 0.15,
    dribbling: 0.9,
    firstTouch: 0.55,
    passing: 0.35,
    crossing: 0.25,
    technique: 0.15,
    tackling: 0.05,
    marking: 0.05,
    freeKicks: 0.15,
    penalties: 0.3,
    anticipation: 0.15,
    vision: 0.9,
    decisions: 0.7,
    composure: 0.8,
    offTheBall: 1.25,
    positioning: 0.25,
    concentration: 0.5,
    acceleration: 0.35,
    pace: 0.45,
    agility: 0.25,
    balance: 0.25,
    jumpingReach: 0.25,
    strength: 0.4,
    stamina: 0.4,
    reflexes: 0,
    handling: 0,
    oneOnOnes: 0,
    aerialReach: 0,
    kicking: 0,
  },
  ST: {
    finishing: 1.8,
    longShots: 0.95,
    heading: 0.7,
    dribbling: 0.5,
    firstTouch: 0.3,
    passing: 0.1,
    crossing: 0.05,
    technique: 0.05,
    tackling: 0.05,
    marking: 0.05,
    freeKicks: 0.05,
    penalties: 0.3,
    anticipation: 0.15,
    vision: 0.3,
    decisions: 0.6,
    composure: 0.7,
    offTheBall: 1.5,
    positioning: 0.2,
    concentration: 0.45,
    acceleration: 0.95,
    pace: 1.15,
    agility: 0.15,
    balance: 0.45,
    jumpingReach: 1,
    strength: 1.15,
    stamina: 0.4,
    reflexes: 0,
    handling: 0,
    oneOnOnes: 0,
    aerialReach: 0,
    kicking: 0,
  },
};

/**
 * **전술 적응 민감도** — 자리마다 "손발이 맞아야 하는 정도"가 다르다.
 *
 * 같은 전술 적응도라도 자리에 따라 손해가 다르다. 중원은 팀 구조의 중심이라
 * 간격·위치가 어긋나면 곧바로 무너지지만, 최전방의 마무리는 조직이 덜 익어도
 * 개인 기술로 해낸다. 수비는 라인·커버가 곧 조직이라 중원 다음으로 민감하다.
 *
 * 1.0이 기준이고, 이 배율만큼 전술 적응도의 **감점 폭**이 커지거나 줄어든다
 * (`famFactor` — sim/match-ability.ts). 초안 값이다.
 */
const TACTICAL_SENSITIVITY: Record<WeightSlot, number> = {
  GK: 0.8, // 라인 높이에 따라 스위퍼 역할이 갈리는 정도
  CB: 1.2, // 라인·오프사이드 트랩·커버 = 조직 그 자체
  FB: 1.2, // 오버래핑 타이밍은 팀 약속이다
  DM: 1.4, // 팀 구조의 중심 — 어긋나면 가장 먼저 드러난다
  CM: 1.4,
  AM: 1.0,
  W: 0.7, // 측면 돌파는 개인의 몫이 크다
  CF: 0.7,
  ST: 0.6, // 마무리는 조직이 덜 익어도 해낸다
};

export function tacticalSensitivityOf(position: string): number {
  return TACTICAL_SENSITIVITY[weightSlotOf(position)];
}

/** 낱말 한 칸이 그 방향의 성공 축 하나에 얹는 가중치 (player.md §3) */
export const CARD_WORD_WEIGHT = 0.1;

/** 카드 하나의 가중치와 기준점 — 같은 (자리 묶음, 낱말) 조합은 한 번만 잰다 */
interface CardModel {
  weights: OverallWeights;
  pivot: number;
}
const cardModelCache = new Map<string, CardModel>();

/** 그 가중치로 낸 평균 — 무게가 0인 축은 보지 않는다 */
function weightedMean(values: Readonly<Record<OverallAxis, number>>, w: OverallWeights): number {
  let sum = 0;
  let total = 0;
  for (const axis of OVERALL_AXES) {
    const weight = w[axis];
    if (weight === 0) continue;
    sum += values[axis] * weight;
    total += weight;
  }
  return total === 0 ? 0 : sum / total;
}

/** 두 자리의 반씩 — 공 있을 때의 자리가 있는 카드의 바탕과 기준 선수 (player.md §3.3) */
function halfAndHalf(
  a: Readonly<Record<OverallAxis, number>>,
  b: Readonly<Record<OverallAxis, number>>,
  round: (v: number) => number = (v) => v,
): Record<OverallAxis, number> {
  const out = { ...a };
  for (const axis of OVERALL_AXES) out[axis] = round((a[axis] + b[axis]) / 2);
  return out;
}

function cardModelOf(slot: WeightSlot, card: RoleCard | null | undefined): CardModel {
  const ipSlot = card?.ip.place ? weightSlotOf(card.ip.place) : slot;
  const key = `${slot}|${ipSlot}|${CARD_WORDS.map((word) => cardStep(card, word)).join(",")}`;
  const cached = cardModelCache.get(key);
  if (cached) return cached;
  const base =
    ipSlot === slot
      ? POSITION_WEIGHTS[slot]
      : halfAndHalf(POSITION_WEIGHTS[slot], POSITION_WEIGHTS[ipSlot], roundWeight);
  const lift: Partial<Record<OverallAxis, number>> = {};
  for (const word of CARD_WORDS) {
    const step = cardStep(card, word);
    if (step === 0) continue;
    const def = CARD_WORD_DEFS[word];
    for (const axis of step > 0 ? def.plusAxes : def.minusAxes) {
      lift[axis] = (lift[axis] ?? 0) + Math.abs(step) * CARD_WORD_WEIGHT;
    }
  }
  const weights = { ...base };
  for (const axis of OVERALL_AXES) {
    const d = lift[axis];
    if (d === undefined) continue;
    weights[axis] = Math.max(
      axisFloorAt(slot, axis),
      Math.min(CEIL_WEIGHT, roundWeight(base[axis] + d)),
    );
  }
  /**
   * ⚠️ **기준점은 카드마다 잰다** — 그 자리 선수의 평균 축(`SLOT_REFERENCE`)이 이 카드에서
   * 내는 값과 기본 카드에서 내는 값의 차다. 없으면 카드가 곧 공짜 능력치다: 평균이 높은
   * 축만 얹는 카드는 누구를 넣어도 오르고, 낮은 축을 얹는 카드는 누구를 넣어도 내려간다.
   */
  const reference =
    ipSlot === slot
      ? SLOT_REFERENCE[slot]
      : halfAndHalf(SLOT_REFERENCE[slot], SLOT_REFERENCE[ipSlot]);
  const pivot = weightedMean(reference, weights) - weightedMean(reference, base);
  const model = { weights, pivot };
  cardModelCache.set(key, model);
  return model;
}

/**
 * **자리를 옮겼을 때 되찾는 카드** — ① 같은 자리 안의 이동(LCB → RCB)이면 지금 카드
 * 그대로 → ② 그 자리의 기억 (player.md §3.2). 둘 다 없으면 `undefined`, 곧 **그 자리의
 * 기본 행동**이다.
 *
 * 코어(`setLineup`의 승계 · `movePlayerSlot`)와 전술판이 **같은 이 함수를 부른다.**
 * 저장을 기다리는 3초 동안 화면이 규칙을 따로 밟으면, 감독이 누른 적 없는 카드 변경이
 * 자동 저장 응답과 함께 혼자 일어난다.
 *
 * @param from 지금 서 있던 칸 — 벤치·예비에서 올라오면 null
 * @param to 새로 서는 칸
 * @param current 지금 걸린 카드
 * @param remembered 새 칸의 자리에서 마지막에 맡던 카드
 */
export function inheritedCard(
  from: string | null | undefined,
  to: string,
  current: RoleCard | null | undefined,
  remembered: RoleCard | null | undefined,
): RoleCard | undefined {
  if (current && from != null && samePlace(from, to)) return current;
  return remembered ?? undefined;
}

/** 자리 + 카드 → 축 가중치. 카드가 없으면 그 자리의 기본 가중치다 */
export function cardWeights(position: string, card?: RoleCard | null): OverallWeights {
  return cardModelOf(weightSlotOf(position), card).weights;
}

/**
 * **감독이 그 선수를 얼마나 정확히 아는가** — 표시값에 얹히는 결정적 오프셋 하나.
 *
 * 오프셋을 **무엇으로 정하는지**는 세이브를 읽어야 알므로 엔진의 몫이다
 * (`observationOf`). 그것을 **어떻게 얹는지**는 순수 규칙이라 여기 있다 —
 * 전술판이 저장 전 배치의 전력을 낼 때 부르는 함수이기 때문이다.
 *
 * ⚠️ 엔진에 두면 화면이 값을 가져오려고 코어를 import하게 되고, 그 순간 `node:fs`가
 * 브라우저 번들에 딸려 온다. 순수한 규칙은 양쪽이 닿는 자리에 있어야 한다.
 */
interface ObservationOffset {
  /** 종합·자리 전력에 얹는 결정적 오프셋 */
  overallOffset: number;
}

/** 화면에 적는 능력치의 아래끝 — 0은 "값이 없다"로 읽히므로 쓰지 않는다 */
const SHOWN_RATING_MIN = 1;

/** 표시용 눈금 — 1~99에서 자른다 */
const clampShown = (value: number) =>
  Math.max(SHOWN_RATING_MIN, Math.min(RATING_MAX, Math.round(value)));

/**
 * 관측된 축에서 그 자리·카드의 전력을 낸다 — **화면과 서버의 단일 규칙.**
 *
 * 안개는 **축에만** 있다(`axes`가 이미 관측값이다). 합성값은 전부 여기서 파생되므로
 * 자리를 어떻게 옮겨도 명단과 전술판이 어긋날 수 없다.
 */
export function observedFit(
  axes: AxisValues,
  observation: ObservationOffset,
  position: string,
  card?: RoleCard | null,
): number {
  return clampShown(cardFit(axes, position, card) + observation.overallOffset);
}

/** 보유 자리 목록의 한 줄 — 칸이 아니라 자리를 잰다 (`placeFit`) */
export function observedPlaceFit(
  axes: AxisValues,
  observation: ObservationOffset,
  place: string,
): number {
  return clampShown(placeFit(axes, place) + observation.overallOffset);
}

/** 실제 37축·보유 자리에서 낸 종합에 관측 오차를 한 번만 얹는다. */
export function observedOverall(overall: number, observation: ObservationOffset): number {
  return clampShown(overall + observation.overallOffset);
}

/**
 * 등급 — 수치를 말로 자르는 **단일 자.** GM이 읊는 말과 화면이 그리는 등급이
 * 같은 표를 읽어야, 같은 선수를 두고 둘이 다른 말을 하지 않는다.
 */
const RATING_TIERS = [
  { key: "world", min: 90, ko: "월드클래스" },
  { key: "elite", min: 85, ko: "리그 최정상" },
  { key: "first", min: 78, ko: "정상급" },
  { key: "squad", min: 70, ko: "준주전급" },
  { key: "par", min: 60, ko: "리그 평균" },
  { key: "below", min: 50, ko: "평균 이하" },
  { key: "weak", min: 0, ko: "약점" },
] as const;

export type RatingTier = (typeof RATING_TIERS)[number]["key"];

const tierOfRating = (value: number) => RATING_TIERS.find((t) => value >= t.min) ?? RATING_TIERS[6];

/** 등급 키 — 화면이 색을 고르는 자리 */
export function ratingTier(value: number): RatingTier {
  return tierOfRating(value).key;
}

/**
 * 수치 → 서술 라벨. 채팅에서 능력치 숫자를 읊지 않는다는 노출 규약(player.md §10)과 맞물려,
 * 안개가 있는 선수는 숫자 대신 이 라벨만 GM에게 전달한다.
 */
export function ratingLabel(value: number): string {
  return tierOfRating(value).ko;
}

/**
 * 이 자리·이 카드에서의 전력 — **종합 축의 가중 평균이고, 축 범위를 벗어나지 않는다.**
 *
 * 같은 선수라도 **자리에 따라** 다르고(라이스를 DM에 두면 태클·위치 선정이 지배하고
 * AM에 올리면 시야·드리블이 지배한다), 같은 자리에서도 **카드에 따라** 다르다(같은
 * 풀백이라도 안으로 좁히는 풀백은 패스·드리블을 더 본다).
 *
 * 카드를 주지 않으면 그 자리의 **기본 역할**이다 — 표시용 `overall`이 이 값을 쓴다.
 *
 * ⚠️ **평균을 되펴지 않는다.** 배율로 되펴면 종합이 **그 선수 어느 축보다도 높게**
 * 나온다 — 축을 함께 펼쳐 놓은 화면에서 그건 계산이 틀린 것으로 읽힌다 (player.md §4).
 */
export function cardFit(axes: AxisValues, position: string, card?: RoleCard | null): number {
  const { weights: w, pivot } = cardModelOf(weightSlotOf(position), card);
  let sum = 0;
  let total = 0;
  let lowest = Infinity;
  let highest = -Infinity;
  for (const axis of OVERALL_AXES) {
    // 그 자리에 없는 축(무게 0)은 값도 범위도 보지 않는다 — 골키퍼의 결정력 11이
    // 종합의 아래끝이 되면 종합이 축 범위 안이라는 말이 뜻을 잃는다
    const weight = w[axis];
    if (weight === 0) continue;
    const value = axes[axis];
    sum += value * weight;
    total += weight;
    if (value < lowest) lowest = value;
    if (value > highest) highest = value;
  }
  if (total === 0) return 0;
  // 카드 기준점은 **평행 이동**이다 — 카드를 고르는 것만으로 값이 오르내리지
  // 않게 하되(§3), 축 범위 밖으로는 나가지 못한다.
  const leveled = sum / total - pivot;
  return Math.max(lowest, Math.min(highest, Math.round(leveled)));
}

/**
 * 자리가 품은 가중치 묶음 — 최전방(ST)은 전술판의 두 줄이 다른 묶음을 읽는다: 맨 앞 줄은
 * 마무리하는 9번(ST), 그 뒤 줄은 내려와 잇는 전방(CF). 나머지 자리는 묶음 하나다.
 */
const PLACE_WEIGHT_CODES: Partial<Record<Place, readonly string[]>> = { ST: ["ST", "CF"] };

/**
 * 그 **자리**에서 기본 역할로 내는 전력 — 묶음이 둘이면 높은 쪽이다 (player.md §4).
 * 전술판의 한 칸은 `cardFit`으로 잰다: 칸은 자기 묶음 하나만 읽는다.
 */
export function placeFit(axes: AxisValues, place: string): number {
  const at = placeOf(place);
  const codes = (at && PLACE_WEIGHT_CODES[at]) ?? [place];
  let best = 0;
  for (const code of codes) best = Math.max(best, cardFit(axes, code));
  return best;
}

/**
 * **표시용 종합** — 그 선수가 가장 잘 맞는 자리에서, **빈 카드로** 낸 값.
 *
 * 선수 카드의 숫자 하나는 "이 선수는 어느 정도인가"에 답해야 하므로 역할 카드를 타면
 * 안 된다(같은 선수가 카드만큼 여러 등급을 갖게 된다). 실제로 맡은 자리·카드의 값은
 * `cardFit`이 따로 낸다 — 그래서 안으로 좁히는 카드를 받은 정통 풀백은 종합은 그대로인데
 * 그 경기의 전력만 달리 잡힌다.
 *
 * `positions`는 그 선수가 볼 줄 아는 자리 목록(`PLAYER_POSITION`)이다. 주 포지션만
 * 보면 안 된다 — 시드의 주 포지션 표기는 출처마다 갈리고(EA는 윙어를 LM/RM으로 적는다),
 * 그 표기 하나 때문에 종합이 낮게 나오면 라인업 판단이 통째로 어긋난다.
 */
export function bestOverall(axes: AxisValues, positions: readonly { position: string }[]): number {
  let best = 0;
  for (const p of positions) best = Math.max(best, placeFit(axes, p.position));
  return best;
}

// ── 은퇴 (season.md §6) ─────────────────────────────

/** GM이 선언할 때 기록한 사유. 자동 판정 조건이 아니다. */
const RETIREMENT_REASONS = ["age", "decline", "idle", "personal", "injury"] as const;
export const RetirementReasonSchema = z.enum(RETIREMENT_REASONS);
export type RetirementReason = z.infer<typeof RetirementReasonSchema>;

export const RetirementDecisionSchema = z.discriminatedUnion("action", [
  z
    .object({
      playerId: z.string().min(1),
      action: z.literal("declare"),
      reason: RetirementReasonSchema,
    })
    .strict(),
  z.object({ playerId: z.string().min(1), action: z.literal("withdraw") }).strict(),
]);

/** 빠르게 변하는 컨디션 — 부상은 별도 INJURY 테이블 (player.md §5) */
export const PlayerStateSchema = z.object({
  /**
   * 폼 **−1.0 ‥ +1.0** (실수) — 1이 곧 절정, −1이 곧 바닥이라 값 자체가 비율로
   * 읽힌다. 규칙은 `engine/form.ts` 한곳에 있다.
   */
  form: z.number().min(-1).max(1),
  /**
   * **체력 0~100** — 지금 이 선수가 낼 수 있는 상태. 높을수록 좋다.
   *
   * 경기·훈련이 깎고 휴식·회복이 채운다. 폼과 별도로 관리하는 몸의 준비 상태다.
   */
  condition: z.number().int().min(0).max(CONDITION_MAX),
  /** GM이 결정한 시즌 말 은퇴 선언. 실행 전에는 나이와 무관하게 철회할 수 있다. */
  retiringAfterSeason: z.object({ on: DateString, reason: RetirementReasonSchema }).optional(),
  /**
   * **누적 피로 0~100** — 시즌이 이 몸에 쌓아 둔 부하의 잔고 (player.md §5.5).
   *
   * 체력과 다른 축이다. 체력은 하루 단위의 예산이라 이레면 차지만 이 잔고는 시즌
   * 단위로 쌓여 12월의 다리를 8월과 다르게 만든다. **출전 분·연전 간격·본훈련
   * 세션이 쌓고** 휴식·경기 없는 주·개인 휴식이 지수로 뺀다.
   *
   * ⚠️ **전력에 닿지 않는다.** 닿는 자리는 회복 배율(`recoveryFactor`)과 부상 저울
   * (`injuryWeight`) 둘뿐이고, 지친 몸이 약하다는 사실은 체력이 이미 말한다 —
   * 계수를 하나 더 얹으면 같은 사실이 두 번 값을 치른다.
   *
   * ⚠️ **정수가 아니다** — 전술 적응도와 같은 이유로 실수로 둔다 (player.md §7.1).
   * 하루치 감쇠가 평형 근처에서 1 아래라, 반올림해 저장하면 그 구간에서 값이
   * 통째로 멈춘다.
   */
  fatigue: z.number().min(0).max(FATIGUE_MAX),
  /**
   * **통산 A매치 출전·골** (→ docs/season/competition.md §5-1).
   *
   * 소집 표(`state.callUps`)에서 파생하지 않고 저장하는 이유는 그 표가 **최근 두
   * 시즌만** 남기 때문이다 — 합쳐서 세면 통산이 세 시즌 뒤에 사라진다. 새 게임의
   * 선수는 0이 아니다: 세계 생성이 나이·서열로 통산을 미리 세운다
   * (`seedInternationalCaps`). 그러지 않으면 서른 살 주전이 첫 소집에서 데뷔한다.
   */
  caps: z.number().int().min(0),
  internationalGoals: z.number().int().min(0),
  /**
   * **여름 대회를 뛰고 늦게 합류하는 날** (→ docs/season/competition.md §5-1).
   *
   * 짝수 해 여름의 대회가 남기는 유일한 사실이다 — 경기는 굴리지 않으므로 대회가
   * 세계에 남기는 것은 「누가 늦게 오나」뿐이고, 그 날짜는 어디에서도 파생되지
   * 않는다(나라 서열은 그해 전환 시점의 것이다). 그날까지 훈련장에도 프리시즌
   * 친선에도 서지 않는다.
   *
   * 대회가 없는 해엔 지워진다 — 없으면 늦게 오는 사람이 아니다.
   */
  summerReturn: DateString.optional(),
});
export type PlayerState = z.infer<typeof PlayerStateSchema>;

/** 통산 A매치 출전 */
export function capsOf(state: Pick<PlayerState, "caps">): number {
  return state.caps;
}

/** 통산 A매치 골 */
export function internationalGoalsOf(state: Pick<PlayerState, "internationalGoals">): number {
  return state.internationalGoals;
}

/** 새 선수·새 시즌이 출발하는 누적 피로 — 여름이 통을 비웠다 (player.md §5.5) */
export const FATIGUE_BASE = 0;

/** 저장된 누적 피로를 읽는 **유일한 문** — 기본값이 코드베이스에 흩어지지 않게 한다 */
export function fatigueOf(state: Pick<PlayerState, "fatigue">): number {
  return state.fatigue;
}

/**
 * **새 선수의 상태** — 시드 인스턴스·유스·승격 보강 선수가 같은 함수로 출발한다.
 *
 * 폼·체력만 부르는 쪽이 정한다. 나머지는 아직 아무 일도 겪지 않은 몸의 장부라
 * 기준값에서 시작한다 — 새 선수를 만드는 자리가 셋이라 각자 적으면 조용히 갈린다.
 */
export function freshPlayerState(input: { form: number; condition: number }): PlayerState {
  return {
    form: input.form,
    condition: input.condition,
    fatigue: FATIGUE_BASE,
    caps: 0,
    internationalGoals: 0,
  };
}

/** 누적 피로를 0~100 안으로 — 모든 변화가 이 문을 지난다 */
export function clampFatigue(value: number): number {
  return Math.max(0, Math.min(FATIGUE_MAX, value));
}

/** 체력을 0~100 안으로 — 모든 변화가 이 문을 지난다 */
export function clampCondition(value: number): number {
  return Math.max(0, Math.min(CONDITION_MAX, Math.round(value)));
}

/** 하루가 시작될 때의 기본 체력 — 새 선수·새 시즌이 여기서 출발한다 */
export const CONDITION_BASE = 75;

/**
 * 체력 구간 — **라벨과 화면의 색이 같은 경계를 쓴다.**
 *
 * 경계가 두 곳에 적히면 명단의 막대와 경기 화면의 막대가 같은 선수를 다른 색으로
 * 칠한다 — 실제로 한동안 그랬다(명단 35/50, 경기 화면은 구멍 문턱과 50).
 */
type ConditionBand = "fresh" | "good" | "fair" | "low" | "spent";

/** 각 구간이 시작되는 체력 — 이 아래는 다음(더 나쁜) 구간이다 */
const CONDITION_BAND_FLOOR = {
  fresh: 80,
  good: 65,
  fair: 50,
  low: 35,
} as const;

export function conditionBand(condition: number): ConditionBand {
  if (condition >= CONDITION_BAND_FLOOR.fresh) return "fresh";
  if (condition >= CONDITION_BAND_FLOOR.good) return "good";
  if (condition >= CONDITION_BAND_FLOOR.fair) return "fair";
  if (condition >= CONDITION_BAND_FLOOR.low) return "low";
  return "spent";
}

const CONDITION_BAND_KO: Record<ConditionBand, string> = {
  fresh: "최상",
  good: "좋음",
  fair: "보통",
  low: "처짐",
  spent: "바닥",
};

/** 체력 구간 라벨 — 숫자만 보면 "70이 좋은 건가?"가 된다 */
export function conditionLabel(condition: number): string {
  return CONDITION_BAND_KO[conditionBand(condition)];
}

/**
 * 누적 피로 구간 — **화면·조회·심경·AI 로테이션이 같은 경계를 쓴다** (player.md §5.5).
 *
 * **등급으로만 선다.** 감독이 관측할 수 있는 것은 출전 기록과 일정이지
 * "피로 63"이 아니고, 등급이면 그 두 사실에서 읽어 낼 수 있다.
 */
type FatigueBand = "clear" | "building" | "heavy" | "overloaded";

/** 각 구간이 시작되는 값 — 이 위는 앞(더 무거운) 구간이다. 낮을수록 좋은 축이다 */
export const FATIGUE_BAND_FLOOR = {
  overloaded: 75,
  heavy: 50,
  building: 28,
} as const;

export function fatigueBand(fatigue: number): FatigueBand {
  if (fatigue >= FATIGUE_BAND_FLOOR.overloaded) return "overloaded";
  if (fatigue >= FATIGUE_BAND_FLOOR.heavy) return "heavy";
  if (fatigue >= FATIGUE_BAND_FLOOR.building) return "building";
  return "clear";
}

/** 가능 포지션 + 포지션 적응도 — 선수당 여러 개, isNatural은 **하나 이상** */
const PlayerPositionSchema = z.object({
  /** 자리 14개 중 하나 — 슬롯 코드는 적히지 않는다 (player.md §8) */
  position: PlaceSchema,
  /** 포지션 적응도 0~99 — 출전·훈련으로 상승 */
  proficiency: RatingSchema,
  /** 주 포지션 — positionGroup·overall 공식의 기준 */
  isNatural: z.boolean(),
});
export type PlayerPosition = z.infer<typeof PlayerPositionSchema>;

/**
 * 게임 선수 (GAME_PLAYER) — 한 게임 안에서 변화하는 선수의 전부.
 * 카탈로그를 복사해 만들고 catalogId로 출처를 링크한다 (유스 등 생성 선수는 null).
 * 부상·징계·계약·이동·성장은 GameState의 기록 테이블이 gamePlayerId로 참조한다.
 */
export const GamePlayerSchema = z.object({
  /** 시드 선수는 카탈로그 id 재사용, 생성 선수는 신규 슬러그 */
  id: z.string().min(1),
  catalogId: z.string().min(1).nullable(),
  /** 소속 팀 — 바뀌면 반드시 선수 이동 원장(`PlayerMove`)과 원자적으로 */
  teamId: z.string().min(1),
  /** 구단 내부 스쿼드. reserve는 별도 경기를 만들지 않는 개발 스쿼드다 */
  squadLevel: z.enum(["first", "reserve"]),
  name: z.string().min(1),
  /** 현재 소속팀의 등번호. 미배정·무소속 선수는 없음 */
  squadNumber: z.number().int().min(1).max(SQUAD_NUMBER_MAX).optional(),
  /** 출생년월일 (YYYY-MM-DD). 나이는 플레이 날짜 기준으로 계산 (ageOf) */
  birthdate: DateString,
  positions: z.array(PlayerPositionSchema).min(1),
  /**
   * 홈그로운 자격을 가진 **협회(나라)**. 등록 명단의 홈그로운 판정은 이 값과
   * 소속 클럽의 리그 국가를 비교한다 — 잉글랜드에서 자란 선수는 잉글랜드의 어느
   * 구단에서도 홈그로운이지만, 라리가 구단에서는 아니다 (squad-rules.ts).
   * 없으면 어느 리그에서도 홈그로운이 아니다.
   */
  homegrownCountry: z.string().optional(),
  /**
   * **국적 — 그 선수가 대표하는 협회** (FIFA 3자 코드 · `nationality.ts`).
   * 홈그로운과 다른 축이다: 홈그로운은 어디서 자랐는가이고 이것은 누구인가라,
   * 비EU 쿼터·대표팀 소집·워크퍼밋이 전부 이 값에 걸린다.
   * 없으면 소속 구단의 나라가 협회에 닿지 않는 선수다 — 소집 표에 서지 않는다.
   */
  nationality: z.string().optional(),
  /**
   * 둘째 국적 — **하나만 담는다.** 등록 자격을 가르는 것은 "EU 여권이 있는가"이지
   * 여권의 개수가 아니라서, 셋째 칸은 판정에 아무것도 더하지 않는다.
   */
  secondNationality: z.string().optional(),
  /** 주발 — 카탈로그 항목이 들지 않았으면(어드민 생성) 없고, 양발로 다뤄 보정 0 */
  foot: FootSchema.optional(),
  /** 키(cm) · 체중(kg) — 묘사용. 카탈로그 항목이 들지 않았으면 없다 */
  height: HeightSchema.optional(),
  weight: WeightSchema.optional(),
  attributes: PlayerAttributesSchema,
  state: PlayerStateSchema,
  /** 주장 — 팀당 최대 1명 (검증 레이어 보장) */
  isCaptain: z.boolean(),
  /**
   * 부주장 — 팀당 최대 1명인 감독의 지정이다 (docs/people/people.md §5-1).
   * 주장이 없는 경기 명단에서 완장을 잇고, 주장 자리가 비면 우선 승계한다.
   */
  isViceCaptain: z.boolean(),
  /**
   * **아직 한 칸을 못 채운 성장** — 축별로 −1 < x < 1.
   *
   * 능력치는 정수라 "이번 훈련이 반 칸쯤 남겼다"를 표현할 자리가 없다. 그래서
   * 판정이 낸 값을 곡선으로 깎아 여기 쌓고(`applyAttributeStep`), 1을 넘는 순간
   * 능력치가 1 오른다. 이 그릇이 없으면 스물아홉 살 85짜리 선수는 아무리 훈련해도
   * 영영 그대로다 — 곡선이 그의 몫을 언제나 1보다 작게 만들기 때문이다.
   */
  growthCarry: z.record(z.string(), z.number()),
});
export type GamePlayer = z.infer<typeof GamePlayerSchema>;

/** The profile rating is derived from current axes and positions, never stored. */
export function playerOverall(player: Pick<GamePlayer, "attributes" | "positions">): number {
  return bestOverall(player.attributes, player.positions);
}
/** 관례상 짧은 별칭 — 코드 전반에서 Player로 쓴다 */
export type Player = GamePlayer;

/**
 * 선수 카탈로그 (PLAYER_CATALOG) — 모든 게임이 공유하는 불변 초기치 DB.
 * 16축을 평면 필드로 갖는다 (overall은 파생이라 저장하지 않는다).
 */
interface PlayerCatalogMeta {
  lorebook?: LorebookContent | undefined;
  id: string;
  /** 시드 시점 소속 팀 (TEAM_CATALOG) */
  teamId: string;
  nameKo: string;
  nameEn: string;
  /**
   * **위키데이터 QID** — 사람을 가리는 유일한 키(시드의 `RealPlayerSeed.wikidataId`).
   * 시드에 동명이인이 있어 이름으로 잇는 표(부상 이력)는 한 사람의 기록을 남의
   * 몸에 붙인다. 그래서 QID가 시드에서 카탈로그까지 흘러야 한다 — 카탈로그가
   * 게임 선수와 시드 사이의 유일한 다리다.
   * 위키 문서가 없는 선수(합성·아카데미)는 QID가 없다.
   */
  wikidataId?: string | undefined;
  /**
   * 실존 시드가 아니라 절차 생성으로 채운 사람 — 아카데미·2부 스쿼드가 그렇다.
   * id에는 아무 표시가 없으므로(선수 id는 출신도 소속도 담지 않는다) 여기서 안다.
   */
  synthetic?: boolean | undefined;
  /** 시드 시점 소속팀의 등번호. 번호가 공식 배정되지 않았으면 생략 */
  squadNumber?: number | undefined;
  birthdate: string;
  /** 가능 포지션 + 적응도 초기치 → 게임 시작 시 그대로 복사 */
  positions: PlayerPosition[];
  /** 성장 상한 */
  potential: number;
  /** 홈그로운 자격 협회 (나라) — 없으면 어느 리그에서도 홈그로운이 아니다 */
  homegrownCountry?: string | undefined;
  /** 국적 — 대표하는 협회의 FIFA 3자 코드 (`nationality.ts`) */
  nationality?: string | undefined;
  /** 둘째 국적 — 하나만 담는다 (EU 자격을 가르는 자리다) */
  secondNationality?: string | undefined;
  /** 주발 */
  foot?: Foot | undefined;
  /** 키(cm) · 체중(kg) */
  height?: number | undefined;
  weight?: number | undefined;
  /**
   * 실제 주급 (£/주) — 새 게임의 초기 계약에 그대로 쓰인다.
   * 없으면(합성 선수·시드 미상) `wages.ts`의 모델이 계산한다 —
   * 구단 예산을 스쿼드 서열·나이·포지션으로 나눈다.
   * 카탈로그는 불변 초기치이므로 여기 값은 "부임 시점의 계약"일 뿐,
   * 이후 계약은 `CONTRACT` 원장이 갖는다.
   */
  weeklyWage?: number | undefined;
  /**
   * **주장 완장** — 그 구단이 공표한 주장(`RealPlayerSeed.isCaptain`).
   * 구단당 한 명까지이고, 같은 사람이 부주장일 수 없다
   * (`engine/world/catalog-invariants.ts`). 없으면 새 게임이 배치에서
   * 파생한다 (`initialCaptainOf` — people/people.md §5-1).
   */
  isCaptain?: boolean | undefined;
  /** 부주장 완장 — 같은 규칙. **파생으로 세우지 않는다**: 없으면 비운 채로 둔다 */
  isViceCaptain?: boolean | undefined;
  /**
   * **계약 지위** — 새 게임의 초기 계약에 그대로 적힌다 (people/people.md §5-2).
   * 없으면 계약에 칸을 두지 않아 `squadStatusOf`가 서열에서 파생한다.
   */
  squadStatus?: SquadStatus | undefined;
}
export type PlayerCatalogEntry = PlayerCatalogMeta & AxisValues;

/**
 * 카탈로그 한 줄의 **파일 모양** — 어드민이 저장한 `player-catalog.json`은 이
 * 스키마를 지나야 카탈로그가 된다. 어긋난 파일을 그대로 읽으면 실패가 저장한
 * 순간이 아니라 한참 뒤 새 게임을 세울 때 터진다 (team/team.md §1).
 *
 * 16축은 `ATTRIBUTE_AXES`에서 펼친다 — 축이 늘어도 스키마가 따라온다.
 * `overall`은 파생이라 담기지 않는다 (`PlayerCatalogMeta`와 같은 목록).
 */
export const PlayerCatalogEntrySchema = z.object({
  lorebook: LorebookContentSchema.optional(),
  id: z.string().min(1),
  teamId: z.string().min(1),
  nameKo: z.string().min(1),
  nameEn: z.string().min(1),
  wikidataId: z.string().min(1).optional(),
  synthetic: z.boolean().optional(),
  squadNumber: z.number().int().min(0).max(SQUAD_NUMBER_MAX).optional(),
  birthdate: DateString,
  positions: z.array(PlayerPositionSchema).min(1),
  potential: RatingSchema,
  homegrownCountry: z.string().min(1).optional(),
  nationality: z.string().min(1).optional(),
  secondNationality: z.string().min(1).optional(),
  foot: FootSchema.optional(),
  height: HeightSchema.optional(),
  weight: WeightSchema.optional(),
  weeklyWage: z.number().min(0).optional(),
  isCaptain: z.boolean().optional(),
  isViceCaptain: z.boolean().optional(),
  squadStatus: z.enum(SQUAD_STATUSES).optional(),
  ...(Object.fromEntries(ATTRIBUTE_AXES.map((a) => [a, RatingSchema])) as Record<
    AttributeAxis,
    typeof RatingSchema
  >),
});

/**
 * **주 포지션은 여럿일 수 있다** — 한 자리만 진짜인 선수가 있고, 두 자리를 다
 * 자기 자리로 삼는 선수가 있다(칸셀루의 풀백·윙, 카마빙가의 중원·측면).
 * 검증 레이어는 **하나 이상**을 보장한다.
 */
/** 보유 목록의 한 줄 — 저장 모양(`PlayerPosition`)도, 화면이 받는 복사본도 이 꼴이다 */
interface HeldPosition {
  position: string;
  proficiency: number;
  isNatural: boolean;
}

export function naturalPositionsOf<P extends HeldPosition>(player: {
  positions: readonly P[];
}): P[] {
  const natural = player.positions.filter((p) => p.isNatural);
  return natural.length > 0 ? natural : player.positions.slice(0, 1);
}

/**
 * 대표 주 포지션 하나 — 화면 한 칸·포지션군처럼 **하나만 쓸 수 있는 자리**용이다.
 * 여럿이면 적응도가 가장 높은 쪽, 같으면 목록 순서(결정적).
 * 선호 여부를 물을 땐 이 함수가 아니라 `isNaturalAt`을 써야 한다 — 대표 하나만
 * 보면 나머지 주 포지션이 "소화 가능"으로 밀려난다.
 */
export function naturalPositionOf<P extends HeldPosition>(player: { positions: readonly P[] }): P {
  const natural = naturalPositionsOf(player);
  return natural.reduce((best, p) => (p.proficiency > best.proficiency ? p : best), natural[0]!);
}

/**
 * 이 칸이 그 선수의 **선호**인가 — 주 자리로 접히는 칸이면 참이다 (player.md §8).
 * `CB`가 주 자리인 선수에게 `LCB`·`RCB`는 "소화 가능"이 아니라 같은 자리다.
 * 이웃 쌍(`RB↔RWB`)까지는 넓히지 않는다 — 다른 자리라 감점이 남는다.
 */
export function isNaturalAt(
  player: { positions: readonly HeldPosition[] },
  position: string,
): boolean {
  return naturalPositionsOf(player).some((p) => samePlace(p.position, position));
}

export function positionGroupOfPlayer(player: {
  positions: readonly HeldPosition[];
}): PositionGroup {
  return positionGroupOf(naturalPositionOf(player).position) ?? "MF";
}

/** 출생년월일 + 기준일(게임 날짜) → 만 나이 */
export function ageOf(birthdate: string, onDate: string): number {
  const b = new Date(`${birthdate}T00:00:00Z`);
  const d = new Date(`${onDate}T00:00:00Z`);
  let age = d.getUTCFullYear() - b.getUTCFullYear();
  const m = d.getUTCMonth() - b.getUTCMonth();
  if (m < 0 || (m === 0 && d.getUTCDate() < b.getUTCDate())) age -= 1;
  return age;
}

/**
 * 완장이 비었을 때의 배정 순서 — **나이가 많은 쪽, 그다음 id.** 사회적 서열을 만들지
 * 않는다. 누가 라커룸을 이끄는가는 인물 카드의 문장이 말하고, 감독이 그 말을 듣고
 * 완장을 옮긴다 (people.md §5-1).
 */
export function compareCaptainCandidates<P extends { id: string; birthdate: string }>(
  a: P,
  b: P,
): number {
  return a.birthdate.localeCompare(b.birthdate) || a.id.localeCompare(b.id);
}

/** 카탈로그 지정이 없으면 실제 선발, 1군, 선수단 순서로 후보를 찾는다. */
export function initialCaptainOf<P extends Pick<GamePlayer, "id" | "birthdate" | "squadLevel">>(
  squad: readonly P[],
  startingXi: readonly string[],
): P | null {
  const xi = new Set(startingXi);
  const starters = squad.filter((p) => xi.has(p.id));
  const firstTeam = squad.filter((p) => p.squadLevel === "first");
  const candidates = starters.length > 0 ? starters : firstTeam.length > 0 ? firstTeam : squad;
  return [...candidates].sort(compareCaptainCandidates)[0] ?? null;
}
