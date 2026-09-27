import { z } from "zod";
import { MOOD_BATCH } from "@story-fm/engine";
import { moodNotesArg } from "../common/mood-input";

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
    moods: moodNotesArg(MOOD_BATCH),
  })
  .strict();

export type MatchClosing = z.infer<typeof MatchClosingSchema>;
