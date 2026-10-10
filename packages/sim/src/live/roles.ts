import {
  CARD_WORDS,
  cardStepsOf,
  weightSlotOf,
  type CardSteps,
  type CardWord,
  type RoleCard,
  type WeightSlot,
} from "@gaffer/domain";

/**
 * 역할 성향표 (live-match.md §4).
 *
 * 말마다 **공이 있을 때 무엇을 고르고, 공이 없을 때 어디로 가는가**의 성향 한 줄이 선다.
 * 자리 묶음(`WeightSlot`)의 기본값(`SLOT_TENDENCY`)에 역할 카드의 낱말이 단계만큼
 * (`WORD_TENDENCY_STEP`) 얹힌다 — 카드 가중치가 낱말의 성공 축을 얹는 것과 같은 모양이다.
 *
 * **이 표는 낱말의 정의이고 밸런스 손잡이가 아니다.** 「폭 −」이 바깥으로 벌리면 그것은
 * 튜닝이 아니라 표기 오류다. 경기 전체의 슈팅 수·패스 성공률 같은 통계를 옮길 자리는
 * 이 표가 아니라 성향을 읽는 효용식과 전술이다.
 *
 * 값은 전부 0..1이고 0.5가 중립이다 — 차이는 더해서 0..1로 잘라 `TENDENCY_RESOLUTION`으로
 * 떨어뜨린다.
 */
export interface RoleTendency {
  /** 공을 가졌을 때 자리보다 앞으로 나가는 정도 */
  advance: number;
  /** 자리를 떠나지 않으려는 정도 */
  hold: number;
  /** 터치라인 쪽을 지키는 정도 */
  width: number;
  /** 안쪽으로 파고드는 정도 */
  inside: number;
  /** 공을 받으러 내려오는 정도 */
  dropDeep: number;
  /** 수비 뒤로 침투하는 정도 */
  runBehind: number;
  /** 마무리 국면에 박스 안에 서는 정도 */
  boxPresence: number;
  /** 자리를 벗어나 공을 찾아다니는 정도 */
  roam: number;
  /** 공 없을 때 압박에 나서려는 정도 */
  press: number;
  /** 드리블을 고르는 정도 */
  dribble: number;
  /** 위험한 전진 패스를 고르는 정도 */
  passRisk: number;
  /** 슈팅을 고르는 정도 */
  shoot: number;
  /** 크로스를 고르는 정도 */
  cross: number;
  /** 공이 없을 때 뒤로 따라 내려와 지키는 정도 */
  cover: number;
  /** 공이 없을 때 가까운 상대에게 붙는 정도 */
  mark: number;
  /** 골키퍼가 라인 뒤를 덮으러 나오는 정도 */
  sweep: number;
}

export type TendencyAxis = keyof RoleTendency;

/** 성향 축 전부 — 잘라 내기와 검증이 같은 목록을 돈다 */
export const TENDENCY_AXES: readonly TendencyAxis[] = [
  "advance",
  "hold",
  "width",
  "inside",
  "dropDeep",
  "runBehind",
  "boxPresence",
  "roam",
  "press",
  "dribble",
  "passRisk",
  "shoot",
  "cross",
  "cover",
  "mark",
  "sweep",
];

/** 성향의 해상도 — 차이를 얹은 뒤 0.01 단위로 떨어뜨려 표와 계산이 같은 값을 본다 */
const TENDENCY_RESOLUTION = 0.01;

/**
 * 자리 묶음의 기본 성향 — 그 자리의 **기본 역할**(빈 카드)이 선다.
 * `sweep`은 골키퍼만의 축이라 나머지 자리는 0이다. `mark`는 모든 자리가 중립(0.5)에서
 * 시작한다 — 마크의 무게는 자리가 아니라 수비 복귀 성향(`cover`)이 이미 가른다.
 */
export const SLOT_TENDENCY: Record<WeightSlot, RoleTendency> = {
  GK: {
    advance: 0,
    hold: 1,
    width: 0,
    inside: 0,
    dropDeep: 0,
    runBehind: 0,
    boxPresence: 0,
    roam: 0,
    press: 0,
    dribble: 0,
    passRisk: 0.1,
    shoot: 0,
    cross: 0,
    cover: 0,
    mark: 0.5,
    sweep: 0.3,
  },
  CB: {
    advance: 0.2,
    hold: 0.8,
    width: 0.3,
    inside: 0.4,
    dropDeep: 0.2,
    runBehind: 0.05,
    boxPresence: 0.15,
    roam: 0.1,
    press: 0.35,
    dribble: 0.15,
    passRisk: 0.3,
    shoot: 0.05,
    cross: 0.05,
    cover: 0.8,
    mark: 0.5,
    sweep: 0,
  },
  FB: {
    advance: 0.55,
    hold: 0.5,
    width: 0.85,
    inside: 0.2,
    dropDeep: 0.3,
    runBehind: 0.3,
    boxPresence: 0.15,
    roam: 0.2,
    press: 0.5,
    dribble: 0.4,
    passRisk: 0.4,
    shoot: 0.1,
    cross: 0.55,
    cover: 0.6,
    mark: 0.5,
    sweep: 0,
  },
  DM: {
    advance: 0.3,
    hold: 0.75,
    width: 0.3,
    inside: 0.5,
    dropDeep: 0.6,
    runBehind: 0.1,
    boxPresence: 0.15,
    roam: 0.25,
    press: 0.55,
    dribble: 0.25,
    passRisk: 0.4,
    shoot: 0.15,
    cross: 0.1,
    cover: 0.8,
    mark: 0.5,
    sweep: 0,
  },
  CM: {
    advance: 0.5,
    hold: 0.5,
    width: 0.35,
    inside: 0.5,
    dropDeep: 0.5,
    runBehind: 0.3,
    boxPresence: 0.35,
    roam: 0.4,
    press: 0.55,
    dribble: 0.4,
    passRisk: 0.5,
    shoot: 0.3,
    cross: 0.2,
    cover: 0.5,
    mark: 0.5,
    sweep: 0,
  },
  AM: {
    advance: 0.65,
    hold: 0.3,
    width: 0.3,
    inside: 0.6,
    dropDeep: 0.4,
    runBehind: 0.5,
    boxPresence: 0.55,
    roam: 0.55,
    press: 0.45,
    dribble: 0.6,
    passRisk: 0.7,
    shoot: 0.55,
    cross: 0.2,
    cover: 0.25,
    mark: 0.5,
    sweep: 0,
  },
  W: {
    advance: 0.7,
    hold: 0.3,
    width: 0.85,
    inside: 0.4,
    dropDeep: 0.3,
    runBehind: 0.55,
    boxPresence: 0.4,
    roam: 0.35,
    press: 0.45,
    dribble: 0.8,
    passRisk: 0.5,
    shoot: 0.45,
    cross: 0.75,
    cover: 0.25,
    mark: 0.5,
    sweep: 0,
  },
  CF: {
    advance: 0.6,
    hold: 0.3,
    width: 0.25,
    inside: 0.6,
    dropDeep: 0.65,
    runBehind: 0.45,
    boxPresence: 0.6,
    roam: 0.5,
    press: 0.45,
    dribble: 0.6,
    passRisk: 0.6,
    shoot: 0.65,
    cross: 0.1,
    cover: 0.1,
    mark: 0.5,
    sweep: 0,
  },
  ST: {
    advance: 0.7,
    hold: 0.35,
    width: 0.2,
    inside: 0.6,
    dropDeep: 0.3,
    runBehind: 0.8,
    boxPresence: 0.85,
    roam: 0.3,
    press: 0.45,
    dribble: 0.4,
    passRisk: 0.4,
    shoot: 0.85,
    cross: 0.05,
    cover: 0.05,
    mark: 0.5,
    sweep: 0,
  },
};

/**
 * 낱말 한 칸이 옮기는 성향 — 카드의 단계가 이만큼씩 곱해져 자리 기본값에 얹힌다.
 * 끝(±3)에서 0.36~0.45 — FM 역할 하나가 기본 역할에서 벗어나던 폭과 같은 자리다.
 */
export const WORD_TENDENCY_STEP: Readonly<Record<CardWord, Partial<RoleTendency>>> = {
  width: { width: 0.13, inside: -0.13 },
  attack: { advance: 0.12, hold: -0.06 },
  freedom: { roam: 0.13, hold: -0.06 },
  dropDeep: { dropDeep: 0.12 },
  runBehind: { runBehind: 0.12 },
  boxPresence: { boxPresence: 0.12 },
  dribble: { dribble: 0.12 },
  passRisk: { passRisk: 0.12 },
  shoot: { shoot: 0.12 },
  cross: { cross: 0.12 },
  press: { press: 0.13 },
  recover: { cover: 0.12 },
  mark: { mark: 0.15 },
  sweep: { sweep: 0.15 },
};

const clampTendency = (v: number) =>
  Math.round(Math.min(1, Math.max(0, v)) / TENDENCY_RESOLUTION) * TENDENCY_RESOLUTION;

/** 공 없을 때의 성향 — 공 있을 때의 자리가 바꾸지 않는 넷 (player.md §3.3) */
const OUT_OF_POSSESSION: ReadonlySet<TendencyAxis> = new Set(["press", "cover", "mark", "sweep"]);

/** 자리와 카드의 성향 — 저장된 카드 한 장 (`stepsTendencyOf`) */
export function cardTendencyOf(position: string, card?: RoleCard | null): RoleTendency {
  return stepsTendencyOf(position, cardStepsOf(card), card?.ip.place);
}

/**
 * 자리와 낱말 단계의 성향 — `SLOT_TENDENCY[자리]` + Σ 단계 × `WORD_TENDENCY_STEP[낱말]`.
 *
 * 낱말이 없으면 자리 기본값이다. 낱말은 어느 자리에서나 읽힌다 — 단계는 그 자리의 기본
 * 행동에서의 차이라 같은 `attack +2`도 자리마다 다른 곳에 선다 (player.md §3). 단계는
 * 실수다 — 경기 중 수정은 지시 적용률이 곱해진 연속값이다 (live-match.md §6.2).
 *
 * 공 있을 때의 자리(`ipPosition`)가 있으면 공 있을 때 성향의 기본값은 그 자리의 것이다
 * — 공 없을 때의 넷만 전술판 자리에 남는다 (player.md §3.3).
 */
export function stepsTendencyOf(
  position: string,
  steps: CardSteps,
  ipPosition?: string,
): RoleTendency {
  const out = { ...SLOT_TENDENCY[weightSlotOf(position)] };
  if (ipPosition) {
    const ip = SLOT_TENDENCY[weightSlotOf(ipPosition)];
    for (const axis of TENDENCY_AXES) if (!OUT_OF_POSSESSION.has(axis)) out[axis] = ip[axis];
  }
  // 낱말이 닿은 축만 자른다 — 기본값은 이미 해상도 위에 있다
  const touched = new Set<TendencyAxis>();
  for (const word of CARD_WORDS) {
    const step = steps[word] ?? 0;
    if (step === 0) continue;
    const delta = WORD_TENDENCY_STEP[word];
    for (const axis of TENDENCY_AXES) {
      const d = delta[axis];
      if (d === undefined) continue;
      out[axis] += step * d;
      touched.add(axis);
    }
  }
  for (const axis of touched) out[axis] = clampTendency(out[axis]);
  return out;
}
