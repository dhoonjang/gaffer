import { z } from "zod";
import { DateString } from "./date-string";
import { AXIS_KO, type AttributeAxis } from "./player";

// ── 성장 로그 ─────────────────────────────────────────
/**
 * 성장의 출처. `development`는 **코어의 월간 성장·쇠퇴** — 감독 팀 1군 밖의 선수
 * (우리 2군 · 모든 타 팀)가 나이·잠재력·난수로 조금씩 움직이는 몫이다.
 *
 * ⚠️ 갈래를 빼면 `SAVE_VERSION`이 오른다. 이 스키마는 로드가 통과해야 하는
 * 문이라(`core/save-schema.ts`), 뺀 값을 든 세이브는 그 자리에서 막힌다
 * (game-state.md §6).
 */
export const GrowthSourceSchema = z.enum(["training", "match", "development"]);

/**
 * 그 한 칸이 **어느 경로로** 올랐나 — `source`보다 한 단 세분한 코드.
 *
 * 같은 `training`이라도 팀 훈련 결산과 전향 프로그램은 다른 일이다. 문장으로
 * 적어 두면(`"훈련 결산"`) 그 문구가 세이브에 굳고 아무도 읽지 않는 줄이 된다.
 */
export const GrowthOriginSchema = z.enum([
  /** 팀 훈련 결산 (training-report.ts) */
  "training-settlement",
  /** 전향 프로그램 — 새 자리를 익히는 개인 훈련 */
  "position-conversion",
  /** 코어의 월간 성장·쇠퇴 (development.ts) */
  "monthly",
  /** 멘토 항이 곱해진 월간 성장 — 정신 6축의 멘티만 (people.md §5-3) */
  "mentoring",
  /** 경기에서 그 자리를 뛴 몫 (포지션 적응도) */
  "match-minutes",
  /** 경기 평점 결산 (ratings.ts) */
  "match-settlement",
]);

export type GrowthOrigin = z.infer<typeof GrowthOriginSchema>;

/** 성장 대상 — 능력치 16축, 포지션 적응도(pos:CODE), 전술 적응도(tactical) */
export const GrowthEntrySchema = z.object({
  gamePlayerId: z.string().min(1),
  /** 출처 일정 (SCHEDULE_ENTRY) — 훈련 세션 또는 경기. 코어 월간 성장은 없다(null) */
  entryId: z.string().min(1).nullable(),
  date: DateString,
  source: GrowthSourceSchema,
  /** "shooting", "pos:ST", "tactical" 등 */
  target: z.string().min(1),
  delta: z.number().int(),
  /** 어느 경로로 올랐나 */
  origin: GrowthOriginSchema,
});

export type GrowthEntry = z.infer<typeof GrowthEntrySchema>;

/** 포지션 적응도 대상의 접두 — 적는 쪽과 읽는 쪽이 같은 상수를 쓴다 */
export const GROWTH_POSITION_PREFIX = "pos:";

export function positionGrowthTarget(position: string): string {
  return `${GROWTH_POSITION_PREFIX}${position}`;
}

/**
 * 성장 한 줄이 무엇에 대한 것인가 — **낱말은 여기 하나다.**
 *
 * 달력 일지와 훈련 결과줄이 각자 이 분기를 적던 동안 한쪽에 `pos:` 갈래가 빠져 있어
 * 전향 훈련의 결과줄이 `pos:CB +1`로 섰다. 코드는 코드고 낱말은 낱말이다.
 */
export function growthLabel(target: string): string {
  if (target.startsWith(GROWTH_POSITION_PREFIX)) {
    return `${target.slice(GROWTH_POSITION_PREFIX.length)} 적응도`;
  }
  if (target === "tactical") return "전술 적응도";
  return AXIS_KO[target as AttributeAxis] ?? target;
}

// ── 훈련 결산 카드 ────────────────────────────────────
/**
 * 훈련장에서 눈에 띈 갈래 — **문장이 아니라 코드다.**
 *
 * "두드러졌다"를 세이브에 문장으로 적으면 그 문구가 굳고, 화면과 프롬프트가
 * 각자 그 문장을 다시 다듬는다. 갈래는 셋이면 족하다 — 올라온 사람, 안 한 사람,
 * 지쳐서 흐트러진 사람.
 */
export const TRAINING_MARKS = ["standout", "slack", "tired"] as const;

export const TrainingMarkSchema = z.enum(TRAINING_MARKS);

export type TrainingMark = z.infer<typeof TrainingMarkSchema>;

/** 갈래의 낱말 — 화면과 스냅샷이 같은 표를 읽는다 */
export const TRAINING_MARK_KO: Record<TrainingMark, string> = {
  standout: "두드러짐",
  slack: "태만",
  tired: "지침",
};

/**
 * 한 구간의 훈련 결산이 남기는 **사실 카드 한 장**
 * (→ docs/common/season.md §4).
 *
 * 판정의 산출이 요약 줄 배열이던 동안 근거 한 줄(`note`)은 호출 자리에서
 * 사라졌고, 감독이 훈련장에 쓴 며칠은 달력의 「+1 3명」한 묶음으로만 남았다.
 *
 * ⚠️ **`moved`는 판정이 낸 값이 아니라 코어가 실제로 남긴 것이다** — 천장에 막혀
 * 한 칸도 안 오른 `+2`는 카드에도 없다. 성장 로그에 적힌 그 줄이 곧 카드의 줄이다.
 */
export const TrainingReportSchema = z.object({
  from: DateString,
  to: DateString,
  /** 이 구간에 소화된 훈련 세션 수 */
  sessions: z.number().int().min(0),
  moved: z.array(
    z.object({
      gamePlayerId: z.string().min(1),
      /** "shooting", "pos:ST", "tactical" — 성장 로그와 같은 눈금 */
      target: z.string().min(1),
      delta: z.number().int(),
    }),
  ),
  marks: z.array(
    z.object({
      gamePlayerId: z.string().min(1),
      /** 판정이 갈래를 적지 않고 근거만 냈으면 null */
      code: TrainingMarkSchema.nullable(),
      /** 판정의 근거 한 줄 — 감독이 읽는다. 없으면 빈 문자열 */
      note: z.string(),
    }),
  ),
});

export type TrainingReport = z.infer<typeof TrainingReportSchema>;

// ── 2군 훈련 방침 ─────────────────────────────────────
/**
 * 2군 훈련 방침 — **어느 축으로 자라는지**를 정하는 코드 (season.md §2).
 *
 * 결산 없는 2군에서 축을 겨냥할 자리는 월간 성장의 축 선택뿐이라, 방침은 거기에
 * 얹힌다. 코드만 상태에 남고(`GAME_STATE.reserveTraining`), 어느 축이 그 갈래에
 * 드는지와 배율은 `engine/squad/training-plan.ts`가 한 자리에서 갖는다.
 *
 * `balanced`가 기본값이자 해제다 — 방침을 세운 적 없으면 그것으로 읽힌다.
 */
export const RESERVE_TRAINING_POLICIES = ["balanced", "physical", "technical", "mental"] as const;

export const ReserveTrainingPolicySchema = z.enum(RESERVE_TRAINING_POLICIES);

export type ReserveTrainingPolicy = z.infer<typeof ReserveTrainingPolicySchema>;

/** 코드 → 방침의 이름 — 화면과 프롬프트가 코드를 읽는 유일한 표 */
export const RESERVE_TRAINING_TITLES: Record<ReserveTrainingPolicy, string> = {
  balanced: "균형",
  physical: "신체",
  technical: "기술",
  mental: "정신",
};

export function reserveTrainingTitle(policy: ReserveTrainingPolicy): string {
  return RESERVE_TRAINING_TITLES[policy];
}
