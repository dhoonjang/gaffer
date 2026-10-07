import { z } from "zod";

/** Prose supplied by the existing match GM; numeric judgments belong to Jev. */
export const MatchClosingSchema = z
  .object({
    notes: z
      .array(
        z
          .object({
            playerId: z.string().min(1),
            note: z
              .string()
              .min(1)
              .max(200)
              .describe("rating notes for this player, grounded in their match facts"),
          })
          .strict(),
      )
      .max(30)
      .optional(),
  })
  .strict();

export type MatchClosing = z.infer<typeof MatchClosingSchema>;
