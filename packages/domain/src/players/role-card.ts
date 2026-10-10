import { z } from "zod";
import type { OverallAxis } from "./player";
import { PlaceSchema } from "./place";

/**
 * **역할 카드** — 자리 위에 얹는 지시 (player.md §3).
 *
 * 이름 하나와 낱말 열네 개의 단계(−3~+3)다. 단계 0은 그 자리의 기본 행동이고, 낱말이
 * 하나도 없는 카드가 그 자리의 기본 역할이다. 엔진은 낱말만 읽는다 — 이름은 사람이
 * 읽는 말이라 코드에 역할 목록이 없다.
 */

/** 공 있을 때의 낱말 열 */
export const IP_WORDS = [
  "width",
  "attack",
  "freedom",
  "dropDeep",
  "runBehind",
  "boxPresence",
  "dribble",
  "passRisk",
  "shoot",
  "cross",
] as const;

/** 공 없을 때의 낱말 넷 */
export const OOP_WORDS = ["press", "recover", "mark", "sweep"] as const;

export const CARD_WORDS = [...IP_WORDS, ...OOP_WORDS] as const;
export type IpWord = (typeof IP_WORDS)[number];
export type OopWord = (typeof OOP_WORDS)[number];
export type CardWord = (typeof CARD_WORDS)[number];
export const CardWordSchema = z.enum(CARD_WORDS);

/**
 * 낱말 → 단계 — 엔진이 읽는 카드의 꼴. 저장된 카드의 단계는 정수지만 경기 중 수정은
 * 지시 적용률이 곱해진 연속값이라(live-match.md §6.2) 이 꼴은 실수를 받는다.
 */
export type CardSteps = Partial<Record<CardWord, number>>;

/** 단계의 끝 — 경기 시트와 같은 눈금이다 */
export const CARD_STEP_MAX = 3;

export interface CardWordDef {
  /** 화면과 모델이 부르는 이름 */
  ko: string;
  /** −3 쪽과 +3 쪽의 뜻 */
  minus: string;
  plus: string;
  /**
   * 그 방향의 **성공을 정하는 축** — 카드의 가중치는 이 축에 단계만큼 얹힌다
   * (`cardWeights`). 엔진이 그 낱말에서 실제로 읽는 축이다.
   */
  plusAxes: readonly OverallAxis[];
  minusAxes: readonly OverallAxis[];
}

export const CARD_WORD_DEFS: Readonly<Record<CardWord, CardWordDef>> = {
  width: {
    ko: "폭",
    minus: "안으로 좁히기",
    plus: "넓게 벌리기",
    plusAxes: ["crossing", "pace", "stamina"],
    minusAxes: ["dribbling", "passing", "longShots"],
  },
  attack: {
    ko: "공격 가담",
    minus: "뒤에 남기",
    plus: "올라가기",
    plusAxes: ["stamina", "offTheBall"],
    minusAxes: ["positioning", "anticipation"],
  },
  freedom: {
    ko: "자유",
    minus: "자리 지키기",
    plus: "공을 찾아 움직이기",
    plusAxes: ["vision", "decisions", "offTheBall"],
    minusAxes: ["positioning", "concentration"],
  },
  dropDeep: {
    ko: "받으러 내려오기",
    minus: "덜",
    plus: "더",
    plusAxes: ["firstTouch", "passing", "strength"],
    minusAxes: [],
  },
  runBehind: {
    ko: "뒷공간 침투",
    minus: "덜",
    plus: "더",
    plusAxes: ["offTheBall", "acceleration", "pace", "anticipation"],
    minusAxes: [],
  },
  boxPresence: {
    ko: "박스 안으로",
    minus: "덜",
    plus: "더",
    plusAxes: ["offTheBall", "heading", "jumpingReach", "finishing"],
    minusAxes: [],
  },
  dribble: {
    ko: "드리블",
    minus: "덜",
    plus: "더",
    plusAxes: ["dribbling", "agility", "balance", "acceleration"],
    minusAxes: [],
  },
  passRisk: {
    ko: "과감한 패스",
    minus: "안전하게",
    plus: "과감하게",
    plusAxes: ["vision", "passing", "technique", "decisions"],
    minusAxes: ["passing", "composure"],
  },
  shoot: {
    ko: "슈팅",
    minus: "아끼기",
    plus: "자주",
    plusAxes: ["finishing", "longShots", "composure"],
    minusAxes: [],
  },
  cross: {
    ko: "크로스",
    minus: "덜",
    plus: "더",
    plusAxes: ["crossing", "technique"],
    minusAxes: [],
  },
  press: {
    ko: "압박",
    minus: "기다리기",
    plus: "달려들기",
    plusAxes: ["acceleration", "stamina", "anticipation", "tackling"],
    minusAxes: ["positioning", "anticipation"],
  },
  recover: {
    ko: "수비 복귀",
    minus: "위에 남기",
    plus: "끝까지 따라 내려오기",
    plusAxes: ["stamina", "positioning", "marking"],
    minusAxes: ["offTheBall", "pace"],
  },
  mark: {
    ko: "마크",
    minus: "지역",
    plus: "대인",
    plusAxes: ["marking", "agility", "concentration", "strength"],
    minusAxes: ["positioning", "anticipation", "concentration"],
  },
  sweep: {
    ko: "나오기",
    minus: "라인 지키기",
    plus: "뒤 덮기",
    plusAxes: ["acceleration", "pace", "oneOnOnes", "decisions"],
    minusAxes: [],
  },
};

/**
 * 그 자리에서 뜻이 있는 낱말 — 골키퍼는 「과감한 패스」와 「나오기」, 필드는 「나오기」를
 * 뺀 전부다. 엔진은 어느 낱말이든 읽지만(단계는 기본 행동에서의 차이다), 화면과 모델이
 * 고르는 칸은 이 목록이다 — 센터백의 「나오기」는 경기 어디에도 닿지 않는다.
 */
export function cardWordsAt(keeper: boolean): readonly CardWord[] {
  return keeper ? ["passRisk", "sweep"] : CARD_WORDS.filter((word) => word !== "sweep");
}

export const CardStepSchema = z.number().int().min(-CARD_STEP_MAX).max(CARD_STEP_MAX);

/** 이름의 길이 — 화면 한 칸과 모델이 붙이는 이름이 같은 자에 선다 */
export const CARD_LABEL_MAX = 24;

const stepsOf = <W extends string>(words: readonly W[]) =>
  z
    .object(
      Object.fromEntries(words.map((w) => [w, CardStepSchema.optional()])) as Record<
        W,
        z.ZodOptional<typeof CardStepSchema>
      >,
    )
    .strict();

export const RoleCardSchema = z
  .object({
    /** 감독이 부른 이름이 먼저, 없으면 모델이 붙인다 — 없어도 된다 */
    label: z.string().trim().min(1).max(CARD_LABEL_MAX).optional(),
    /** 공 있을 때 — 자리(없으면 전술판의 자리 — player.md §3.3)와 낱말 */
    ip: stepsOf(IP_WORDS).extend({ place: PlaceSchema.optional() }),
    /** 공 없을 때 */
    oop: stepsOf(OOP_WORDS),
  })
  .strict();
export type RoleCard = z.infer<typeof RoleCardSchema>;

/**
 * **카드를 고치는 말** — 적은 낱말만 바뀌고, 0을 적으면 그 낱말이 지워진다. 이름을 주면
 * 이름이 바뀌고 빈 이름이면 지워진다. `reset`이면 빈 카드(그 자리의 기본 행동)에서
 * 시작한다. 모델은 카드를 처음부터 다시 쓰지 않고 있는 카드를 고친다 (player.md §3.2) —
 * 같은 말이 호출마다 다른 카드가 되는 흔들림을 이것이 막는다.
 */
export const RoleCardPatchSchema = z
  .object({
    label: z.string().trim().max(CARD_LABEL_MAX).optional(),
    /** `place: null`이면 공 있을 때도 전술판의 자리로 돌아간다 */
    ip: stepsOf(IP_WORDS).extend({ place: PlaceSchema.nullable().optional() }).optional(),
    oop: stepsOf(OOP_WORDS).optional(),
    reset: z.boolean().optional(),
  })
  .strict();
export type RoleCardPatch = z.infer<typeof RoleCardPatchSchema>;

/** 지금 카드에 고칠 말을 얹는다 — 결과는 저장하는 꼴(`normalizeCard`)이다 */
export function patchCard(
  current: RoleCard | null | undefined,
  patch: RoleCardPatch,
): RoleCard | undefined {
  const base = patch.reset ? undefined : current;
  const label = patch.label === undefined ? base?.label : patch.label;
  const { place, ...steps }: NonNullable<RoleCardPatch["ip"]> = patch.ip ?? {};
  const ip: RoleCard["ip"] = { ...base?.ip, ...steps };
  if (place === null) delete ip.place;
  else if (place !== undefined) ip.place = place;
  return normalizeCard({
    ...(label ? { label } : {}),
    ip,
    oop: { ...base?.oop, ...patch.oop },
  });
}

const IP_SET: ReadonlySet<string> = new Set(IP_WORDS);

/** 그 낱말의 국면 */
export function phaseOfWord(word: CardWord): "ip" | "oop" {
  return IP_SET.has(word) ? "ip" : "oop";
}

/** 카드 한 장의 낱말 단계 — 없는 낱말은 0이다. 카드가 없으면 전부 0 */
export function cardStep(card: RoleCard | null | undefined, word: CardWord): number {
  if (!card) return 0;
  const steps: Partial<Record<CardWord, number | undefined>> =
    phaseOfWord(word) === "ip" ? card.ip : card.oop;
  return steps[word] ?? 0;
}

/** 카드를 엔진이 읽는 꼴로 — 0인 낱말은 싣지 않는다 */
export function cardStepsOf(card: RoleCard | null | undefined): CardSteps {
  const out: CardSteps = {};
  for (const word of CARD_WORDS) {
    const step = cardStep(card, word);
    if (step !== 0) out[word] = step;
  }
  return out;
}

/**
 * 저장하는 꼴로 — 0인 낱말을 걷고, 낱말도 이름도 없으면 카드가 없는 것(`undefined`)이다.
 * 빈 카드를 배치에 적어 두면 그 자리의 기본 행동이 감독의 결정으로 기억에 남는다.
 */
export function normalizeCard(card: RoleCard | null | undefined): RoleCard | undefined {
  if (!card) return undefined;
  const ip: RoleCard["ip"] = card.ip.place ? { place: card.ip.place } : {};
  const oop: RoleCard["oop"] = {};
  for (const word of IP_WORDS) {
    const step = card.ip[word] ?? 0;
    if (step !== 0) ip[word] = step;
  }
  for (const word of OOP_WORDS) {
    const step = card.oop[word] ?? 0;
    if (step !== 0) oop[word] = step;
  }
  const label = card.label?.trim();
  const hasWords = Object.keys(ip).length > 0 || Object.keys(oop).length > 0;
  if (!hasWords && !label) return undefined;
  return { ...(label ? { label } : {}), ip, oop };
}

/** 공 있을 때의 자리를 바꾸는 것 — 낱말 몇 단계를 옮긴 것과 같은가 (player.md §3.3) */
export const CARD_PLACE_STEPS = 3;

/** 낱말 단계 차의 합과 공 있을 때의 자리 차 — 이름은 엔진에 닿지 않으므로 세지 않는다 */
export function cardDistance(
  a: RoleCard | null | undefined,
  b: RoleCard | null | undefined,
): number {
  let d = 0;
  for (const word of CARD_WORDS) d += Math.abs(cardStep(a, word) - cardStep(b, word));
  if ((a?.ip.place ?? null) !== (b?.ip.place ?? null)) d += CARD_PLACE_STEPS;
  return d;
}

/**
 * 단계 한 칸의 전술 적응도 손실 — FM이 잦은 지시 변경에 거는 제동이다. 낱말 다섯을
 * 한두 칸씩 옮긴 카드(윙백 · 메짤라 쪽) 하나가 슬라이더 한 칸(1.5~4)과 같은 눈금에 선다.
 */
export const CARD_CHANGE_LOSS = 0.5;

/**
 * 카드를 바꿀 때 치르는 **전술 적응도 대가** — 도메인이 유일한 출처다 (player.md §7.2).
 * 코어와 전술판이 같은 함수를 부른다.
 */
export function cardChangeCost(
  from: RoleCard | null | undefined,
  to: RoleCard | null | undefined,
): number {
  return Math.round(cardDistance(from, to) * CARD_CHANGE_LOSS);
}

/** 두 카드가 엔진에 같은가 — 이름만 다르면 같다 */
export function sameCardWords(
  a: RoleCard | null | undefined,
  b: RoleCard | null | undefined,
): boolean {
  return cardDistance(a, b) === 0;
}

/** 두 카드가 같은가 — 낱말과 이름이 모두 같아야 한다 (저장에 실을지 가르는 자) */
export function sameCard(a: RoleCard | null | undefined, b: RoleCard | null | undefined): boolean {
  return sameCardWords(a, b) && (a?.label ?? null) === (b?.label ?? null);
}

/** 단계를 부호와 함께 — `+2` · `−1` (0은 쓰지 않는다) */
export const signedStep = (step: number) => (step > 0 ? `+${step}` : `−${-step}`);
const signed = signedStep;

/**
 * 낱말 한 칸의 단계를 뜻으로 — `폭 +2: 넓게 벌리기` · `폭 0: 그 자리의 기본`. 감독은
 * 「+2」라고 말하지 않으니, 모델이 단계를 고르는 자리는 숫자 옆에 이 뜻을 싣는다.
 */
export function cardStepLabel(word: CardWord, step: number): string {
  const def = CARD_WORD_DEFS[word];
  const side = step < 0 ? def.minus : step > 0 ? def.plus : "그 자리의 기본";
  const strongest = Math.abs(step) === CARD_STEP_MAX ? " (가장 강하게)" : "";
  return `${def.ko} ${step === 0 ? "0" : signed(step)}: ${side}${strongest}`;
}

/**
 * 카드를 말로 — `공 있을 때 DM · 폭 +2 · 드리블 +1 · 압박 −1`. 낱말이 없으면 빈
 * 문자열이다. 화면과 모델이 같은 꼴로 읽는다.
 */
export function cardWordsText(card: RoleCard | null | undefined): string {
  const place = card?.ip.place;
  return [
    ...(place ? [`공 있을 때 ${place}`] : []),
    ...CARD_WORDS.flatMap((word) => {
      const step = cardStep(card, word);
      return step === 0 ? [] : [`${CARD_WORD_DEFS[word].ko} ${signed(step)}`];
    }),
  ].join(" · ");
}

/** 카드의 이름 — 붙인 이름이 없으면 낱말이, 낱말도 없으면 「기본」이다 */
export function cardTitle(card: RoleCard | null | undefined): string {
  return card?.label ?? (cardWordsText(card) || "기본");
}

/**
 * 카드 한 줄 — 이름과 낱말을 함께: `「볼 플레잉」 과감한 패스 +2 · 드리블 +1`.
 * 모델이 지금 카드를 보고 **고칠 말만** 적으려면 이름이 아니라 낱말을 봐야 한다.
 */
export function cardLine(card: RoleCard | null | undefined): string {
  const words = cardWordsText(card);
  if (!card?.label) return words || "기본";
  return words ? `「${card.label}」 ${words}` : `「${card.label}」`;
}
