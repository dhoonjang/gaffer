import type { AttributeAxis, AxisValues } from "@gaffer/domain";
import { bestOverall, normalizedLogCurve, weightSlotOf } from "@gaffer/domain";
import { hashOf } from "../../core/catalog/name-hash";
import { EA_FACE_MODEL, EA_LEVEL_MODEL, EA_RATINGS } from "./ea-ratings";
import {
  EA_FACE_OF,
  EA_STAT_KEYS,
  eaStatsOf,
  hasPlayStyle,
  type EaRating,
  type EaStats,
} from "./ea-stats";

/**
 * 37축 파생 — 능력치 모델의 데이터 계층 (player.md §1 · core/sources.md §4.2).
 *
 * 축은 EA SPORTS FC 공식 레이팅의 **세부 능력치 34개**에서 옮긴다(`ea-ratings.ts`).
 * EA에 없는 선수는 세부 능력치를 먼저 세우고 같은 옮김을 지난다 — 대표 수치만 아는
 * 실선수는 대표 수치에서(`estimateStats` · `EA_FACE_MODEL`), 실력 하나로 태어나는 절차 생성
 * 선수는 그 실력에서(`levelStats` · `EA_LEVEL_MODEL`). 그래서 실측 선수와 추정 선수가 한
 * 공식으로 같은 눈금에 선다.
 *
 * 추정은 두 가지를 지킨다.
 * 1. **결정적** — 이름 해시만 쓴다. 같은 선수는 언제나 같은 값.
 * 2. **근거 있는 흩어짐** — 편차의 가운데값에 그 흩어짐만큼 개인차를 얹는다. 흩어짐을
 *    빼면 같은 자리 선수가 전부 같은 모양이 되고, 난수로 채우면 카탈로그가 노이즈가 된다.
 */

/** 대표 수치 여섯 + GK 종합 (RealPlayerSeed의 능력치 부분) */
export interface SeedAxes {
  pace: number;
  shooting: number;
  passing: number;
  dribbling: number;
  defending: number;
  physical: number;
  goalkeeping?: number;
}

/** 대표 수치 말고 시드가 더 아는 것 — EA 한 줄과 실측 키 */
export interface SeedDetail {
  ea?: EaRating | undefined;
  height?: number | undefined;
}

const clamp99 = (x: number) => Math.max(1, Math.min(99, Math.round(x)));

/** [-spread, +spread] 결정적 편차 — 축마다 다른 해시 채널 */
function jitter(nameEn: string, axis: string, spread: number): number {
  const span = Math.round(spread);
  if (span <= 0) return 0;
  return (hashOf(`axis:${axis}:${nameEn}`) % (span * 2 + 1)) - span;
}

/** 추정 개인차의 폭 — 편차 흩어짐의 이만큼을 해시로 얹는다 */
const ESTIMATE_SPREAD = 0.8;

/**
 * 대표 수치 → 세부 능력치 34개. 세부 능력치 = 그것을 묶는 대표 수치 + 그 자리의
 * 편차 가운데값 ± 개인차. 필드 선수의 GK 세부 능력치는 대표 수치가 없어(0) 편차가
 * 곧 값이다.
 */
export function estimateStats(nameEn: string, position: string, seed: SeedAxes): EaStats {
  const model = EA_FACE_MODEL[weightSlotOf(position)];
  return Object.fromEntries(
    EA_STAT_KEYS.map((stat) => {
      const [offset, spread] = model[stat];
      const face = seed[EA_FACE_OF[stat]] ?? 0;
      return [stat, clamp99(face + offset + jitter(nameEn, stat, spread * ESTIMATE_SPREAD))];
    }),
  ) as EaStats;
}

/**
 * 실력 하나 → 세부 능력치 34개. 세부 능력치 = 실력 + 그 자리의 편차 가운데값 ± 개인차.
 * 생성기가 대표 수치를 지어내지 않는다 — 지어낸 대표 수치의 모양이 실선수와 다르면
 * 그 차이가 편차 표를 지나며 부푼다(스트라이커의 높은 수비 수치가 헤더 90이 된다).
 */
export function levelStats(nameEn: string, position: string, level: number): EaStats {
  const model = EA_LEVEL_MODEL[weightSlotOf(position)];
  return Object.fromEntries(
    EA_STAT_KEYS.map((stat) => {
      const [offset, spread] = model[stat];
      return [stat, clamp99(level + offset + jitter(nameEn, stat, spread * ESTIMATE_SPREAD))];
    }),
  ) as EaStats;
}

/** 개인기 별 추정 — EA 분포의 문턱을 드리블 수치에 건다 (EA에 없는 선수만) */
function estimateSkillMoves(dribbling: number): number {
  return dribbling < 50 ? 1 : dribbling < 66 ? 2 : dribbling < 77 ? 3 : dribbling < 85 ? 4 : 5;
}

/** 키가 점프에 얹는 몫 — 182cm에서 0, 1cm당 0.8 ("200cm면 점프가 나빠도 높다") */
const HEIGHT_PIVOT = 182;
const HEIGHT_REACH = 0.8;
/** 골키퍼 키의 기준선 — 골키퍼끼리 견주는 자리다 */
const KEEPER_HEIGHT_PIVOT = 188;

/** 창의성의 밑값 — 개인기 별 하나당 */
const FLAIR_BY_SKILL_MOVES = [30, 40, 52, 66, 80] as const;
/** 창의성에 얹는 플레이스타일 — 정형에서 벗어나는 선택을 즐기는 표식 */
const FLAIR_STYLES: readonly (readonly [string, number])[] = [
  ["Trickster", 8],
  ["Inventive", 6],
  ["Gamechanger", 5],
  ["Technical", 3],
];
/** 활동량에 얹는 플레이스타일 — 끝까지 뛰고 무는 표식 */
const WORK_RATE_STYLES: readonly (readonly [string, number])[] = [
  ["Relentless", 8],
  ["Press Proven", 6],
];

function styleBonus(
  ea: EaRating | undefined,
  table: readonly (readonly [string, number])[],
): number {
  if (!ea) return 0;
  return table.reduce((sum, [style, bonus]) => sum + (hasPlayStyle(ea, style) ? bonus : 0), 0);
}

/** 시드 선수의 EA 한 줄 — 조인 키는 (이름 + 생년월일)이다 (`scripts/ea-ratings.ts`) */
export function eaRatingOf(seed: { nameEn: string; birthdate: string }): EaRating | undefined {
  return EA_RATINGS[`${seed.nameEn}|${seed.birthdate}`];
}

/** 시드 → 37축. EA 한 줄이 있으면 그것을, 없으면 대표 수치에서 세운 세부 능력치를 옮긴다 */
export function deriveAxes(
  nameEn: string,
  position: string,
  seed: SeedAxes,
  detail: SeedDetail = {},
): AxisValues {
  const ea = detail.ea;
  const stats = ea ? eaStatsOf(ea) : estimateStats(nameEn, position, seed);
  return axesFromStats(nameEn, position, stats, {
    skillMoves: ea?.sm ?? estimateSkillMoves(seed.dribbling),
    ea,
    height: detail.height ?? ea?.h,
  });
}

/** 실력 하나 → 37축 — 절차 생성 선수(유스·영입 후보·2부 스쿼드)가 태어나는 문 */
export function deriveLevelAxes(nameEn: string, position: string, level: number): AxisValues {
  const stats = levelStats(nameEn, position, level);
  return axesFromStats(nameEn, position, stats, {
    skillMoves: estimateSkillMoves(stats.dribbling),
    ea: undefined,
    height: undefined,
  });
}

/**
 * 합성 선수의 종합이 기준선 위에 서는 몫 — 체급 기준선(`TIER_BASE`)과 명단 분위
 * (`topUpBase`)는 생성 선수가 이만큼 위에 선다는 것을 전제로 맞춰져 있다.
 */
export const SYNTHETIC_BASE_LIFT = 1.5;

/** 합성 선수 종합의 개인 편차(표준편차) — 같은 기준선에서도 사람마다 실력이 다르다 */
const SYNTHETIC_OVERALL_SPREAD = 1.8;

/** 되맞춤 반복 상한 — 못 닿으면 닿은 만큼으로 멈춘다 */
const SYNTHETIC_PASSES = 5;

/** 균등 둘의 합 — 평균 0 · 표준편차 1, 끝이 ±√6에서 끊기는 결정적 지문 */
function fingerprint(key: string, channel: string): number {
  const unit = (part: string) =>
    (hashOf(`synthetic:${channel}:${part}:${key}`) % 100_000) / 100_000;
  return (unit("a") + unit("b") - 1) * Math.sqrt(6);
}

/**
 * **목표 종합에서 태어나는 합성 선수** — 유스·영입 후보·절차 생성 스쿼드가 지나는 문.
 *
 * 목표 = 의도한 종합 + 개인 편차. 그 목표에서 세부 능력치를 세우고(`levelStats`), 37축의
 * 종합이 목표에 닿을 때까지 실력을 민다 — 자리마다 세부 능력치에서 종합으로 가는 낙차가
 * 달라(골키퍼 −5 · 윙어 0) 한 상수로는 어느 자리도 노린 자리에 서지 않는다.
 *
 * `positions`는 그 선수가 볼 줄 아는 자리 목록이다 — 종합은 `bestOverall`이 그 목록에서 낸다.
 */
export function synthesizeAxes(
  key: string,
  position: string,
  positions: readonly { position: string }[],
  intended: number,
): AxisValues {
  const target = intended + fingerprint(key, "overall") * SYNTHETIC_OVERALL_SPREAD;
  let level = target;
  let axes = deriveLevelAxes(key, position, level);
  for (let pass = 0; pass < SYNTHETIC_PASSES; pass++) {
    const gap = target - bestOverall(axes, positions);
    if (Math.abs(gap) <= 0.5) break;
    level += gap;
    axes = deriveLevelAxes(key, position, level);
  }
  return axes;
}

/** 세부 능력치 34개 → 37축 — 실측 선수와 추정 선수가 지나는 한 공식 */
function axesFromStats(
  nameEn: string,
  position: string,
  s: EaStats,
  detail: { skillMoves: number; ea: EaRating | undefined; height: number | undefined },
): AxisValues {
  const isGk = weightSlotOf(position) === "GK";
  const { ea, height, skillMoves } = detail;
  const reachOf = (pivot: number) => (height === undefined ? 0 : (height - pivot) * HEIGHT_REACH);
  const mix = (...parts: (readonly [number, number])[]) =>
    clamp99(parts.reduce((sum, [value, w]) => sum + value * w, 0));

  return {
    // ── 기술 12
    finishing: mix([s.finishing, 0.8], [s.volleys, 0.2]),
    longShots: mix([s.longShots, 0.7], [s.shotPower, 0.3]),
    heading: clamp99(s.headingAccuracy),
    dribbling: clamp99(s.dribbling),
    firstTouch: clamp99(s.ballControl),
    passing: mix([s.shortPassing, 0.7], [s.longPassing, 0.3]),
    crossing: mix([s.crossing, 0.85], [s.curve, 0.15]),
    technique: clamp99(
      (s.curve + s.volleys + s.longPassing + s.ballControl) / 4 + (skillMoves - 3) * 3,
    ),
    tackling: mix([s.standingTackle, 0.6], [s.slidingTackle, 0.4]),
    marking: clamp99(s.defensiveAwareness),
    freeKicks: mix([s.freeKickAccuracy, 0.8], [s.curve, 0.2]),
    penalties: clamp99(s.penalties),
    // ── 정신 10 — 골키퍼의 판단은 골키퍼 위치선정에서 읽는다(EA는 골키퍼의 필드 판단 축을
    // 따로 재지 않는다 — 수비 인지가 한 자릿수다)
    anticipation: clamp99(s.reactions),
    vision: clamp99(s.vision),
    decisions: isGk
      ? mix([s.reactions, 0.5], [s.gkPositioning, 0.5])
      : mix([s.reactions, 0.5], [s.composure, 0.5]),
    composure: clamp99(s.composure),
    offTheBall: clamp99(s.positioning),
    positioning: isGk
      ? clamp99(s.gkPositioning)
      : mix([s.defensiveAwareness, 0.6], [s.interceptions, 0.4]),
    concentration: isGk
      ? mix([s.reactions, 0.5], [s.gkPositioning, 0.5])
      : mix([s.reactions, 0.5], [s.composure, 0.3], [s.defensiveAwareness, 0.2]),
    aggression: clamp99(s.aggression),
    flair: clamp99(
      FLAIR_BY_SKILL_MOVES[Math.max(1, Math.min(5, skillMoves)) - 1]! +
        styleBonus(ea, FLAIR_STYLES) +
        jitter(nameEn, "flair", 5),
    ),
    workRate: clamp99(
      s.stamina * 0.6 +
        s.aggression * 0.4 +
        styleBonus(ea, WORK_RATE_STYLES) +
        jitter(nameEn, "workRate", 5),
    ),
    // ── 신체 8 — 골키퍼의 민첩성은 다이빙이다(몸을 던져 닿는 범위)
    acceleration: clamp99(s.acceleration),
    pace: clamp99(s.sprintSpeed),
    agility: clamp99(isGk ? s.gkDiving : s.agility),
    balance: clamp99(s.balance),
    jumpingReach: clamp99(s.jumping + reachOf(HEIGHT_PIVOT)),
    strength: clamp99(s.strength),
    stamina: clamp99(s.stamina),
    naturalFitness: clamp99(
      s.stamina * 0.6 + s.strength * 0.4 + jitter(nameEn, "naturalFitness", 4),
    ),
    // ── GK 7 — 필드 선수는 EA의 GK 세부 능력치(한 자릿수~십 대) 그대로다
    reflexes: clamp99(s.gkReflexes),
    handling: clamp99(s.gkHandling),
    oneOnOnes: mix([s.gkReflexes, 0.4], [s.gkPositioning, 0.4], [s.gkDiving, 0.2]),
    aerialReach: isGk
      ? clamp99(s.jumping + reachOf(KEEPER_HEIGHT_PIVOT - 3))
      : clamp99(s.gkHandling),
    kicking: clamp99(s.gkKicking),
    commandOfArea: isGk
      ? clamp99(
          45 +
            reachOf(KEEPER_HEIGHT_PIVOT) +
            styleBonus(ea, [["Cross Claimer", 20]]) +
            jitter(nameEn, "commandOfArea", 8),
        )
      : clamp99(s.gkHandling),
    rushingOut: isGk
      ? clamp99(
          40 +
            (s.gkDiving - 75) * 0.4 +
            styleBonus(ea, [["Rush Out", 25]]) +
            jitter(nameEn, "rushingOut", 8),
        )
      : clamp99(s.gkPositioning),
  };
}

// ── 노화 곡선 (player.md §6.3) ────────────────────

/**
 * 축별 노화 곡선 — 축을 가른 최대 수확.
 * "다리는 죽었지만 머리로 뛰는 베테랑"이 데이터에서 자동으로 나온다.
 */
export type AgingCurve = "early" | "mid" | "late" | "flat";

export const AXIS_AGING: Record<AttributeAxis, AgingCurve> = {
  // 이르게 정점, 28+ 급락 — 다리
  acceleration: "early",
  pace: "early",
  agility: "early",
  stamina: "early",
  dribbling: "early",
  // 30~32 유지 후 완만한 하락 — 몸과 몸으로 하는 기술
  strength: "mid",
  balance: "mid",
  jumpingReach: "mid",
  naturalFitness: "mid",
  finishing: "mid",
  heading: "mid",
  tackling: "mid",
  marking: "mid",
  crossing: "mid",
  firstTouch: "mid",
  reflexes: "mid",
  aerialReach: "mid",
  // 34+까지 계속 성장 — 머리와 발끝
  passing: "late",
  longShots: "late",
  technique: "late",
  freeKicks: "late",
  penalties: "late",
  anticipation: "late",
  vision: "late",
  decisions: "late",
  composure: "late",
  // 침투는 다리가 아니라 머리가 한다 — 서른 넘어서도 자리를 찾는 9번이 그것이다
  offTheBall: "late",
  positioning: "late",
  concentration: "late",
  handling: "late",
  oneOnOnes: "late",
  kicking: "late",
  // 성향 — 거의 불변
  aggression: "flat",
  flair: "flat",
  workRate: "flat",
  commandOfArea: "flat",
  rushingOut: "flat",
};

export function agingDelta(axis: AttributeAxis, age: number): number {
  const curve = AXIS_AGING[axis];
  if (curve === "flat") return 0;
  if (curve === "early") {
    if (age >= 33) return -3;
    if (age >= 30) return -2;
    if (age >= 28) return -1;
    return 0;
  }
  if (curve === "mid") {
    if (age >= 34) return -2;
    if (age >= 31) return -1;
    return 0;
  }
  // late — 늦게까지 오르고, 아주 늦게 조금 꺾인다
  if (age >= 37) return -1;
  if (age >= 24 && age <= 33) return 1;
  return 0;
}

// ── 능력치가 오르는 속도 — 잠재력·나이·현재 수준 ─────────────
//
// 판정(훈련·경기 결산)이 "이 선수는 한 칸 올랐다"고 말해도 **그대로 오르지는
// 않는다.** 열여덟 살 유망주의 한 칸과 서른 살 주전의 한 칸은 같은 사건이 아니다.
// 실제 선수의 성장을 가르는 셋을 그대로 곱한다:
//   ① **잠재력 여유** — 천장에 가까울수록 는 게 없다. 넘어선 축은 아예 안 자란다.
//   ② **나이** — 스물셋까지가 가장 빠르고 스물여덟을 넘으면 눈에 띄게 준다.
//      축마다 시계가 다르다(`AXIS_AGING`): 다리는 먼저 죽고 머리는 늦게까지 큰다.
//   ③ **현재 수준** — 85를 86으로 만드는 일은 60을 61로 만드는 일보다 어렵다.
//      ①과 겹쳐 보이지만 다른 이야기다: 잠재력 90짜리 두 선수라도 지금 70인
//      선수와 85인 선수의 다음 한 칸은 무게가 다르다.
// 결과가 1보다 작으면 `growthCarry`에 쌓인다 — 그래서 노장도 아주 천천히는 는다.
// **내려가는 건 깎지 않는다.** 오히려 이미 꺾인 축은 더 잘 떨어진다 —
// 판정이 "예전 같지 않다"고 말할 때 그게 서른셋의 스피드라면 그대로 받는다.

/** 잠재력 여유가 이만큼이면 성장 계수가 최대 */
const ROOM_FULL = 10;
/** 여유의 로그 눈금 — 여유가 조금만 있어도 완전히 멎지는 않는다 */
const ROOM_LOG_SCALE = 2;
/** 현재 수준의 감쇠가 시작되는 값과 급함 */
const LEVEL_FLOOR = 60;
const LEVEL_LOG_SCALE = 1;

/**
 * 나이대별 성장 배율 — **한 열이고 두 경로가 같이 읽는다** (player.md §6.3).
 * 결산 판정 한 칸이 실제로 남기는 몫(`attributeGainScale`)과 월간 성장 확률의
 * 나이 가중(`squad/development.ts`)이 같은 값을 본다.
 *
 * 한때 두 경로가 같은 경계에 다른 값을 두었다(스물하나·스물넷·서른하나부터).
 * 남은 한 열은 결산 쪽 값이다 — 열여덟까지의 가산과 서른하나부터의 한 칸이 월간
 * 쪽에는 아예 없어, 그쪽만 `AXIS_AGING`의 "머리는 늦게까지 큰다"와 어긋나 있었다.
 * 월간이 그만큼 빨라지지는 않는다: `growChance`가 여유 배율을 곱한 뒤 0.35에서
 * 자르므로 여유가 5 이상인 선수는 옛 값에서 이미 천장에 붙어 있었다.
 */
const AGE_GROWTH_BANDS = [
  { untilAge: 18, factor: 1.15 },
  { untilAge: 20, factor: 1 },
  { untilAge: 23, factor: 0.85 },
  { untilAge: 27, factor: 0.6 },
  { untilAge: 30, factor: 0.4 },
  { untilAge: 33, factor: 0.25 },
] as const;

/** 표의 마지막 줄 — 어느 경계에도 걸리지 않는 나이(34+) */
const AGE_GROWTH_OLDEST = 0.15;

/** 나이 배율 — 스물셋까지가 가장 빠르다. 결산 판정과 월간 성장이 같이 읽는다 */
export function ageGrowthFactor(age: number): number {
  return (AGE_GROWTH_BANDS.find((band) => age <= band.untilAge) ?? { factor: AGE_GROWTH_OLDEST })
    .factor;
}

/**
 * 판정 1점이 이 선수의 이 축에 실제로 남기는 값 (0 이상).
 *
 * 예: 18세 60(잠재력 85) → 1.15 · 24세 75(85) → 0.68 · 27세 82(85) → 0.16 ·
 * 30세 85(88) → 0.09. 유망주는 판정 한 번에 한 칸을 얻고, 전성기를 지난 주전은
 * 열 번 넘게 받아야 한 칸이다.
 */
export function attributeGainScale(
  axis: AttributeAxis,
  value: number,
  potential: number,
  age: number,
): number {
  const room = potential - value;
  if (room <= 0 || value >= 99) return 0;

  const byRoom = normalizedLogCurve(room / ROOM_FULL, ROOM_LOG_SCALE);
  const byLevel = normalizedLogCurve((100 - value) / (100 - LEVEL_FLOOR), LEVEL_LOG_SCALE);
  return byRoom * byLevel * ageGrowthFactor(age) * axisClockFactor(axis, age);
}

/**
 * 축의 시계 — 이미 꺾이는 축은 훈련해도 덜 붙고(×0.6), 늦게까지 크는 축은 조금 더
 * 붙는다(×1.15). 결산 판정과 월간 성장이 **같은 표**를 읽는다 (player.md §6.2·§6.3) —
 * 한쪽만 다른 배율을 들면 우리 1군과 나머지 세계가 다른 시계로 자란다.
 */
export function axisClockFactor(axis: AttributeAxis, age: number): number {
  const aging = agingDelta(axis, age);
  return aging < 0 ? 0.6 : aging > 0 ? 1.15 : 1;
}

/**
 * 쇠퇴 배율 — **깎지 않는다.** 나이가 밀어내는 축이면 오히려 크게 받는다.
 * 젊고 안 꺾이는 축의 하락은 조금 눌러 둔다(훈련 한 번에 스물둘의 패스가
 * 나빠지지는 않는다).
 */
export function attributeDeclineScale(axis: AttributeAxis, age: number): number {
  const aging = agingDelta(axis, age);
  if (aging < 0) return 1 + Math.min(3, Math.abs(aging)) * 0.25;
  return age <= 24 ? 0.7 : 1;
}
