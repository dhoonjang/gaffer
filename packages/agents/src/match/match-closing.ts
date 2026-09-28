import { z } from "zod";
import { MOOD_BATCH } from "@story-fm/engine";
import { MoodNoteSchema } from "../common/mood-input";

/** Prose supplied by the existing match GM; numeric judgments belong to Jev. */
export const MatchClosingSchema = z
  .object({
    notes: z
      .array(
        z
          .object({
            playerId: z.string().min(1),
            note: z.string().min(1).max(200).describe("이 선수의 경기 사실에 근거한 평점 설명"),
          })
          .strict(),
      )
      .max(30)
      .optional(),
    moods: z
      .array(MoodNoteSchema.strict())
      .max(MOOD_BATCH)
      .optional()
      .describe(
        "출전 선수의 심경. 불만이 걸린 선수는 그 사실을 담고 acknowledgesIssue를 true로 적는다",
      ),
  })
  .strict();

export type MatchClosing = z.infer<typeof MatchClosingSchema>;
