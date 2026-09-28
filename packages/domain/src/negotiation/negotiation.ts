import { z } from "zod";
import { DateString } from "../common/date-string";
import { PitchClaimSchema } from "./persuasion";
import { MAX_PAYMENT_YEARS } from "../common/payments";
import { SQUAD_STATUSES } from "../common/squad-rules";
import { SQUAD_NUMBER_MAX } from "../common/player";
import { DealTermSchema } from "./deal-terms";

// ── 협상 (진행 중 흥정 — 완료된 이동은 TRANSFER) ────────
export const NegotiationKindSchema = z.enum([
  "buy",
  "sell",
  "renew",
  "loan",
  "loan_out",
  "release",
]);

export type NegotiationKind = z.infer<typeof NegotiationKindSchema>;

export function isPlayerDeal(kind: NegotiationKind): boolean {
  return kind === "renew" || kind === "release";
}

export const NegotiationVerdictSchema = z.enum(["accept", "counter", "reject"]);

export type NegotiationVerdict = z.infer<typeof NegotiationVerdictSchema>;

export const NegotiationRoundSchema = z.object({
  date: DateString,
  by: z.enum(["us", "them"]),
  fee: z.number().min(0),
  weeklyWage: z.number().min(0),
  contractYears: z.number().int().min(0).max(6),
  respondsOn: DateString.nullable(),
  announcedOn: DateString.optional(),
  verdict: NegotiationVerdictSchema.nullable(),
  origin: z.enum(["medical"]).optional(),
  note: z.string().optional(),
  pitch: z.array(PitchClaimSchema).optional(),
  paymentYears: z.number().int().min(1).max(MAX_PAYMENT_YEARS).optional(),
  squadStatus: z.enum(SQUAD_STATUSES).optional(),
  squadNumber: z.number().int().min(1).max(SQUAD_NUMBER_MAX).optional(),
  terms: z.array(DealTermSchema).optional(),
  deadlineOn: DateString.optional(),
});

export const MedicalConcernSchema = z.object({
  code: z.enum(["open-injury", "past-injury", "age-load", "muscle-balance"]),
  bodyPart: z.string().min(1).optional(),
  days: z.number().int().min(0).optional(),
  value: z.number().optional(),
});

export type MedicalConcern = z.infer<typeof MedicalConcernSchema>;

export const MedicalSchema = z.object({
  onDate: DateString,
  status: z.enum(["scheduled", "passed", "flagged"]),
  concern: MedicalConcernSchema.optional(),
  overridden: z.boolean().optional(),
});

export type Medical = z.infer<typeof MedicalSchema>;
