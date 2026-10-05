import { z } from "zod";
import { DateString } from "../core/date-string";

export const ManagerOfferTermsSchema = z.object({
  salary: z.number().int().nonnegative().safe(),
  years: z.number().int().positive().max(100),
  expiresOn: DateString,
});
export type ManagerOfferTerms = z.infer<typeof ManagerOfferTermsSchema>;

export const ManagerJobOfferSchema = ManagerOfferTermsSchema.extend({
  team: z.string().trim().min(1),
  reason: z.string().trim().min(1),
});

/** Only actual employment actions belong in the ledger. */
export const BoardReviewSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("dismiss"),
    team: z.string().trim().min(1),
    reason: z.string().trim().min(1),
  }),
  z.object({
    action: z.literal("appoint"),
    team: z.string().trim().min(1),
    managerName: z.string().trim().min(1),
    rating: z.number().int().min(0).max(99).optional(),
    reason: z.string().trim().min(1),
  }),
]);

const InterviewTargetShape = {
  interviewId: z.string().trim().min(1).optional().describe("응답할 면접 id"),
  team: z.string().trim().min(1).optional().describe("응답할 구단 id·이름·약칭"),
};

export const InterviewOutcomeSchema = z.discriminatedUnion("offer", [
  z.object({ ...InterviewTargetShape, offer: z.literal(false), reason: z.string().trim().min(1) }),
  z.object({
    ...InterviewTargetShape,
    offer: z.literal(true),
    terms: ManagerOfferTermsSchema,
    reason: z.string().trim().min(1),
  }),
]);
export type InterviewOutcome = z.infer<typeof InterviewOutcomeSchema>;
