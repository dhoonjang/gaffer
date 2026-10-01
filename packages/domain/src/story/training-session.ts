import { z } from "zod";
import { ATTRIBUTE_AXES, AXIS_GROUPS, AXIS_KO, type AttributeAxis } from "../common/player";

/**
 * 훈련 효과 대상 — 능력치 16축 + 전술 적응도(tactical) + 회복(recovery).
 * GM(LLM)이 자연어 훈련을 이 focus 목록으로 해석하고, 코어가 효과를 준다.
 * (16축이므로 "측면 크로스 반복" → kicking·passing 처럼 해상도가 올라간다)
 */
export const TrainAttrSchema = z.enum([...ATTRIBUTE_AXES, "tactical", "recovery"]);

export type TrainAttr = z.infer<typeof TrainAttrSchema>;

/**
 * 훈련 대상의 표기 — 화면과 결산이 같은 이름을 쓴다.
 * `AXIS_KO`만으로는 능력치 밖의 둘(tactical·recovery)이 영어 id 그대로 샌다.
 */
export const TRAIN_ATTR_KO: Record<TrainAttr, string> = {
  ...AXIS_KO,
  tactical: "전술",
  recovery: "회복",
};

/**
 * 세션 종류의 **부하** — 누적 피로와 훈련 부상이 같은 값을 읽는다 (player.md §5.5).
 * 갈래는 능력치 카탈로그의 것이고, 능력치 밖의 둘(전술·회복)은 따로 선다.
 */
export const SESSION_LOAD = {
  physical: 1.4,
  technical: 1,
  goalkeeping: 1,
  mental: 0.7,
  tactical: 0.7,
  recovery: 0.2,
} as const;

/** focus가 없는 세션의 부하 — 무엇을 했는지 모르는 세션은 보통의 본훈련으로 친다 */
export const SESSION_LOAD_DEFAULT = 1;

const AXIS_LOAD = Object.fromEntries(
  (Object.keys(AXIS_GROUPS) as (keyof typeof AXIS_GROUPS)[]).flatMap((group) =>
    AXIS_GROUPS[group].map((axis) => [axis, SESSION_LOAD[group]] as const),
  ),
) as Record<AttributeAxis, number>;

/** 세션 하나의 부하 — focus 항목마다 갈래의 부하를 읽은 **평균**이다 */
export function sessionLoad(focus: readonly TrainAttr[]): number {
  if (focus.length === 0) return SESSION_LOAD_DEFAULT;
  const sum = focus.reduce(
    (n, f) =>
      n + (f === "tactical" || f === "recovery" ? SESSION_LOAD[f] : AXIS_LOAD[f as AttributeAxis]),
    0,
  );
  return sum / focus.length;
}

/** 훈련 세션 (TRAINING_SESSION) — 자유서술 label + 코어가 쓰는 focus */
export const TrainingSessionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  focus: z.array(TrainAttrSchema),
  /**
   * 기본 훈련 메뉴의 **id** — `auto`인 세션만 갖는다.
   *
   * 일정이 움직이면 tick이 기대 배치와 실제 배치를 대조해 어긋난 자리만 다시 깐다
   * (season.md §4). 그 대조를 메뉴의 한국어 이름으로 하면 문구 한 글자를 고치는
   * 순간 시즌 전체의 기본 훈련이 한 번 다시 깔린다. 감독이 지시한 세션엔 없다.
   */
  menuId: z.string().min(1).optional(),
  /**
   * 코어가 깐 **기본 훈련**인가 — 감독이 지시한 세션과 구분한다.
   * 경기가 새로 편성되면 그 주변의 기본 세션만 걷어내고 다시 깔 수 있어야 하기 때문.
   * 없으면 감독 지시다.
   */
  auto: z.boolean().optional(),
  /**
   * **쉬는 날로 못 박은 자리** — 감독이 "이 날은 쉬자"고 지시한 결과.
   *
   * 휴식은 원래 **엔트리가 없는 것**으로 표현된다(기본 훈련의 MD+2·주말이 그렇다).
   * 그래서 훈련을 지우기만 하면 다음 tick의 `syncDefaultTraining`이 그 자리를
   * "아직 안 깐 날"로 읽고 기본 훈련을 도로 깐다 — 감독의 지시가 하루 만에
   * 사라진다. 빈자리와 **비우기로 한 자리**는 다른 것이라 표식이 필요하다.
   *
   * 이 세션은 달력에 "휴식"으로 서지만 훈련으로 처리되지 않는다 — 성장도 부상
   * 위험도 없고, 피로 회복은 훈련 없는 날과 똑같다 (`tick.ts`의 `idleDay`).
   * 쉬는 날로 못 박은 세션에만 선다.
   */
  rest: z.boolean().optional(),
});

export type TrainingSession = z.infer<typeof TrainingSessionSchema>;

/** 오전/오후 슬롯 — 일정 시간으로 매핑 (am 10:00, pm 15:00) */
export const SlotSchema = z.enum(["am", "pm"]);

export type Slot = z.infer<typeof SlotSchema>;

export const SLOT_TIME: Record<Slot, string> = { am: "10:00", pm: "15:00" };

export function slotOfTime(time: string): Slot {
  return time < "12:00" ? "am" : "pm";
}
