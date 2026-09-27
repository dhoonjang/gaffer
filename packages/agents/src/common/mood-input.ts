import { z } from "zod";
import { MOOD_NOTE_MAX } from "@story-fm/domain";

/**
 * 심경 잔향 — 그 선수와 있었던 일을 쓴 호출이 한 문장을 함께 남긴다 (agents.md §4-3).
 * 검사는 코어의 것이다(`applyMoodNotes`): 대상 밖의 선수는 버리고, 불만이 걸린 선수의
 * 문장은 `acknowledgesIssue`로 그 사실을 안아야 남는다 — 낱말을 세지 않는다.
 */
const MOOD_LINE_HINT =
  "이 일 뒤 그 선수의 심경 한 문장 (60자 안팎). 불만이 걸린 선수면 그 사실을 안았는지 acknowledgesIssue로";

export const moodLineArg = z
  .object({
    text: z.string().min(1).max(MOOD_NOTE_MAX),
    acknowledgesIssue: z.boolean().optional(),
  })
  .optional()
  .describe(MOOD_LINE_HINT);

/** 대상이 여럿인 자리(팀토크·사건)의 심경 — 선수마다 한 줄, 상한은 그 자리가 정한다 */
export const moodNotesArg = (max: number) =>
  z
    .array(
      z.object({
        playerId: z.string().min(1),
        text: z.string().min(1).max(MOOD_NOTE_MAX),
        acknowledgesIssue: z.boolean().optional(),
      }),
    )
    .max(max)
    .optional()
    .describe(`${MOOD_LINE_HINT} — 이 일을 겪은 선수마다 한 줄, ${max}명까지`);
