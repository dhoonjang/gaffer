import { z } from "zod";
import { DateString } from "../common/date-string";

// ── 멘토링 — 감독이 붙여 주는 사이 ────────────────────
/**
 * 멘토링 쌍 — **감독이 고참에게 유망주를 맡긴 사실** (→ docs/story/people.md §5-3).
 *
 * 얇은 장부다: 누가 누구를, 언제부터, 언제 끝났는가뿐이다. 배율도 자격도 저장하지
 * 않는다 — 리더십·나이·자리는 선수 표에 이미 있어 언제든 다시 매길 수 있다.
 *
 * ⚠️ **끝난 사이는 지우지 않고 닫는다.** `until`이 적히고 `MENTORING_ECHO_DAYS`가
 * 지나서야 걷힌다 — 멘토가 팀을 떠난 사실이 멘티의 심경에 서려면 그 줄이 며칠은
 * 남아 있어야 하고, 지우고 나면 「그 아이가 누구를 잃었는가」를 파생할 원본이 없다.
 */
export const MENTORING_ENDS = ["manager", "departure", "squad", "age"] as const;

export const MentoringEndSchema = z.enum(MENTORING_ENDS);

export type MentoringEnd = z.infer<typeof MentoringEndSchema>;

export const MentoringSchema = z.object({
  mentorId: z.string().min(1),
  menteeId: z.string().min(1),
  since: DateString,
  /** 사이가 닫힌 날 — 없으면 서 있는 사이다 */
  until: DateString.optional(),
  /** 왜 닫혔나 — 문장이 아니라 코드다 (people.md §5-3) */
  endedBy: MentoringEndSchema.optional(),
});

export type Mentoring = z.infer<typeof MentoringSchema>;
