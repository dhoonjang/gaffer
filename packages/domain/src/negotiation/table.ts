import { NegotiationMethodSchema } from "../common/turn-operation";
export { NegotiationMethodSchema, type NegotiationMethod } from "../common/turn-operation";
import { z } from "zod";
import { DateString } from "../common/date-string";
import { MAX_PAYMENT_YEARS } from "../common/payments";
import { SQUAD_STATUSES } from "../common/squad-rules";
import {
  NegotiationKindSchema,
  NegotiationRoundSchema,
  MedicalSchema,
  type NegotiationKind,
} from "./negotiation";
import { TabledTermSchema, DealTermSchema } from "./deal-terms";
import { formatMoney } from "../common/money";

export const TABLE_LINE_MAX = 600;

export const TABLE_SPEAKERS = ["club", "agent"] as const;

export const TableSpeakerSchema = z.enum(TABLE_SPEAKERS);

export type TableSpeaker = z.infer<typeof TableSpeakerSchema>;

export const TableLineSchema = z.object({
  date: DateString,
  by: z.enum(["us", "ledger"]),
  text: z.string().min(1).max(TABLE_LINE_MAX),
});

export type TableLine = z.infer<typeof TableLineSchema>;

export const NegotiationContactTableSchema = z.object({
  id: z.string().min(1),
  counterpartyId: z.string().min(1),
  representativeId: z.string().min(1),
  party: TableSpeakerSchema,
  openedOn: DateString,
  lines: z.array(
    TableLineSchema.extend({
      negotiationId: z.string().min(1),
      exchangeId: z.string().min(1),
    }),
  ),
});
export const NegotiationTableSchema = NegotiationContactTableSchema;
export type NegotiationTable = z.infer<typeof NegotiationTableSchema>;

export const NegotiationExchangeSchema = z.object({
  id: z.string().min(1),
  contactId: z.string().min(1),
  negotiationId: z.string().min(1),
  party: TableSpeakerSchema,
  method: NegotiationMethodSchema,
  openedOn: DateString,
  closedOn: DateString.nullable(),
  summary: z.string().max(1200),
  evaluationId: z.string().nullable(),
});
export type NegotiationExchange = z.infer<typeof NegotiationExchangeSchema>;

export const NegotiationTermsBundleSchema = z.object({
  fee: z.number().finite().min(0).max(1_000_000_000_000),
  weeklyWage: z.number().finite().min(0).max(1_000_000_000),
  contractYears: z.number().int().min(0).max(6),
  paymentYears: z.number().int().min(1).max(MAX_PAYMENT_YEARS).optional(),
  squadStatus: z.enum(SQUAD_STATUSES).optional(),
  terms: z.array(TabledTermSchema.shape.term).max(12),
});
export type NegotiationTermsBundle = z.infer<typeof NegotiationTermsBundleSchema>;
export const NegotiationAssessmentSchema = z.object({
  position: z.enum(["agree", "counter", "review", "end"]),
  conditions: NegotiationTermsBundleSchema,
  alternatives: z.array(NegotiationTermsBundleSchema).max(3),
  factRefs: z.array(z.string().min(1)).min(1),
  followup: z
    .object({
      purpose: z.enum(["response", "renegotiate", "medical"]),
      days: z.number().int().min(0).max(3650),
      requiresDecision: z.boolean(),
    })
    .nullable(),
});
export type NegotiationAssessment = z.infer<typeof NegotiationAssessmentSchema>;
export const NegotiationEvaluationSchema = z.object({
  kind: NegotiationKindSchema,
  id: z.string().min(1),
  negotiationId: z.string().min(1),
  exchangeId: z.string().min(1),
  party: TableSpeakerSchema,
  version: z.string().min(1),
  requestedOn: DateString,
  hasProposal: z.boolean(),
  status: z.enum(["pending", "completed", "stale"]),
  ending: z.boolean(),
  result: NegotiationAssessmentSchema.nullable(),
  error: z.string().max(600).nullable(),
});
export type NegotiationEvaluation = z.infer<typeof NegotiationEvaluationSchema>;
export const NegotiationFollowupSchema = z.object({
  id: z.string().min(1),
  negotiationId: z.string().min(1),
  exchangeId: z.string().min(1),
  evaluationId: z.string().min(1),
  party: TableSpeakerSchema,
  version: z.string().min(1),
  dueOn: DateString,
  createdOn: DateString,
  purpose: z.enum(["response", "renegotiate", "medical"]),
  requiresDecision: z.boolean(),
  status: z.enum(["pending", "completed", "cancelled"]),
});
export type NegotiationFollowup = z.infer<typeof NegotiationFollowupSchema>;

export const PersonalTermsSchema = z.object({
  weeklyWage: z.number().min(0),
  contractYears: z.number().int().min(1).max(6),
  squadStatus: z.enum(SQUAD_STATUSES).optional(),
  proposedOn: DateString,
  respondsOn: DateString,
  agreedOn: DateString.optional(),
  counter: z
    .object({
      weeklyWage: z.number().min(0),
      contractYears: z.number().int().min(1).max(6),
      squadStatus: z.enum(SQUAD_STATUSES).optional(),
      on: DateString,
      terms: z.array(DealTermSchema).optional(),
      note: z.string().optional(),
    })
    .optional(),
});

export type PersonalTerms = z.infer<typeof PersonalTermsSchema>;

export const MandateLimitSchema = z.object({
  fee: z.number().min(0).optional(),
  weeklyWage: z.number().min(0).optional(),
  contractYears: z.number().int().min(1).max(6).optional(),
});

export type MandateLimit = z.infer<typeof MandateLimitSchema>;

export const DelegationSchema = z.object({
  kind: NegotiationKindSchema,
  limit: MandateLimitSchema.optional(),
  since: DateString,
});

export type Delegation = z.infer<typeof DelegationSchema>;

export const NegotiationSchema = z.object({
  id: z.string().min(1),
  gamePlayerId: z.string().min(1),
  kind: NegotiationKindSchema,
  counterpartTeamId: z.string().min(1).nullable(),
  windowId: z.string().min(1).nullable(),
  openedOn: DateString,
  expiresOn: DateString.optional(),
  status: z.enum(["open", "agreed", "rejected", "expired", "completed"]),
  rounds: z.array(NegotiationRoundSchema),
  pitched: z.array(z.string().min(1).max(500)),
  medical: MedicalSchema.optional(),
  precontract: z.boolean(),
  tables: z
    .object({
      club: z.string().min(1).optional(),
      agent: z.string().min(1).optional(),
    })
    .optional(),
  feeAgreed: z
    .object({
      fee: z.number().min(0),
      paymentYears: z.number().int().min(1).max(MAX_PAYMENT_YEARS).optional(),
      on: DateString,
    })
    .optional(),
  terms: z.array(TabledTermSchema),
  buyout: z.boolean(),
  personal: PersonalTermsSchema.optional(),
  mandate: MandateLimitSchema.nullable().optional(),
});

export type Negotiation = z.infer<typeof NegotiationSchema>;

export function isMandated(negotiation: Pick<Negotiation, "status" | "mandate">): boolean {
  return (
    negotiation.mandate !== undefined &&
    negotiation.mandate !== null &&
    (negotiation.status === "open" || negotiation.status === "agreed")
  );
}

export function mandateLimitText(limit: MandateLimit, kind: NegotiationKind): string {
  const outgoing = kind === "sell" || kind === "loan_out";
  const money =
    kind === "release" ? "정산금" : kind === "loan" || kind === "loan_out" ? "임대료" : "이적료";
  const parts = [
    ...(limit.fee === undefined ? [] : [`${money} ${formatMoney(limit.fee)}`]),
    ...(limit.weeklyWage === undefined ? [] : [`주급 ${formatMoney(limit.weeklyWage)}`]),
    ...(limit.contractYears === undefined ? [] : [`${limit.contractYears}년`]),
  ];
  if (parts.length === 0) return "한도 없이";
  return `${parts.join(" · ")}${outgoing ? " 이상" : "까지"}`;
}
