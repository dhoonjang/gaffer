import { z } from "zod";
import { DateString } from "../common/date-string";

/** 함께 훈련하도록 배정한 선수와 배정 기간. 관계 점수나 성장 배수를 저장하지 않는다. */
export const MENTORING_ENDS = ["manager", "departure"] as const;

export const MentoringEndSchema = z.enum(MENTORING_ENDS);

export type MentoringEnd = z.infer<typeof MentoringEndSchema>;

export const MentoringSchema = z.object({
  mentorId: z.string().min(1),
  menteeId: z.string().min(1),
  since: DateString,
  /** 배정 종료일 — 없으면 현재 유효한 배정이다 */
  until: DateString.optional(),
  /** 배정 종료 사유 코드 (people.md §5-3) */
  endedBy: MentoringEndSchema.optional(),
});

export type Mentoring = z.infer<typeof MentoringSchema>;
