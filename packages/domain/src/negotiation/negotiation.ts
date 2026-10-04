import { z } from "zod";
import { DateString } from "../common/date-string";
import { InjurySchema } from "../common/health";

const Id = z.string().trim().min(1).max(160);
const Money = z.number().int().min(0).max(1_000_000_000);
export const ProposalTermsSchema = z
  .object({
    scope: z.enum(["club", "player"]),
    fee: Money,
    installments: z.array(z.object({ date: DateString, amount: Money })).max(12),
    weeklyWage: Money,
    signingBonus: Money,
    since: DateString,
    until: DateString,
    promises: z.array(z.string().trim().min(1).max(500)).max(12),
    expiresOn: DateString,
  })
  .strict();
export type ProposalTerms = z.infer<typeof ProposalTermsSchema>;
export const NegotiationProposalSchema = z.object({
  id: Id,
  author: Id,
  sentOn: DateString,
  terms: ProposalTermsSchema,
  acceptedBy: z.array(Id),
  status: z.enum(["open", "superseded", "rejected", "expired"]),
  reason: z.string().max(2000),
});
export type NegotiationProposal = z.infer<typeof NegotiationProposalSchema>;
export const NegotiationBoundsSchema = z.object({
  fingerprint: z.string(),
  asOf: DateString,
  minFee: Money,
  maxFee: Money,
  minWeeklyWage: Money,
  maxWeeklyWage: Money,
  maxSigningBonus: Money,
  minYears: z.number(),
  maxYears: z.number(),
  reasons: z.array(z.string()),
});
export const NegotiationConfirmationPayloadSchema = z.object({
  kind: z.literal("negotiation-confirmation"),
  negotiationId: Id,
  revision: z.number().int().nonnegative(),
  stage: z.enum(["agreement", "medical", "sign"]),
  playerProposalId: Id.nullable(),
  clubProposalId: Id.nullable(),
});
export type NegotiationConfirmationPayload = z.infer<typeof NegotiationConfirmationPayloadSchema>;
export const NegotiationSchema = z.object({
  id: Id,
  playerId: Id,
  buyerId: Id,
  sellerId: Id,
  kind: z.enum(["transfer", "renewal", "free"]),
  openedOn: DateString,
  background: z.string().max(4000),
  sourceContractId: Id.nullable(),
  bounds: NegotiationBoundsSchema,
  status: z.enum(["open", "signed", "completed", "withdrawn"]),
  closed: z.object({ on: DateString, reason: z.string().min(1).max(2000) }).nullable(),
  revision: z.number().int().nonnegative(),
  proposals: z.array(NegotiationProposalSchema),
  drafts: z.array(ProposalTermsSchema).max(2),
  medical: z
    .object({
      requestedOn: DateString,
      readyOn: DateString,
      examinedOn: DateString.nullable(),
      injuries: z.array(InjurySchema),
      acknowledgedBy: z.array(Id),
    })
    .nullable(),
  signed: z
    .object({
      on: DateString,
      playerProposalId: Id,
      clubProposalId: Id.nullable(),
    })
    .nullable(),
  registration: z.enum(["not_submitted", "pending", "registered"]),
});
export type Negotiation = z.infer<typeof NegotiationSchema>;
export const TransferPaymentSchema = z.object({
  id: Id,
  negotiationId: Id,
  playerId: Id,
  fromTeamId: Id,
  toTeamId: Id.nullable(),
  dueOn: DateString,
  amount: Money,
  paidOn: DateString.nullable(),
  kind: z.enum(["fee", "signing_bonus"]),
});
export type TransferPayment = z.infer<typeof TransferPaymentSchema>;
export const MarketReviewSchema = z.object({
  lastDate: DateString.nullable(),
  clubs: z.array(
    z.object({
      teamId: Id,
      reviewedOn: DateString,
      fingerprint: z.string(),
    }),
  ),
});
export const OpenNegotiationSchema = z
  .object({
    playerId: Id,
    buyerId: Id,
    kind: z.enum(["transfer", "renewal", "free"]),
    background: z.string().trim().min(1).max(4000),
  })
  .strict();
export const NegotiationActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("draft"), terms: ProposalTermsSchema }),
  z.object({ kind: z.literal("send"), terms: ProposalTermsSchema }),
  z.object({ kind: z.literal("accept"), proposalId: Id }),
  z.object({ kind: z.literal("reject"), proposalId: Id, reason: z.string().min(1).max(2000) }),
  z.object({ kind: z.literal("medical") }),
  z.object({ kind: z.literal("acknowledge_medical") }),
  z.object({ kind: z.literal("sign") }),
  z.object({ kind: z.literal("register") }),
  z.object({ kind: z.literal("withdraw"), reason: z.string().min(1).max(2000) }),
]);
export type NegotiationAction = z.infer<typeof NegotiationActionSchema>;
export const NegotiationRequestSchema = z
  .object({
    requestId: Id,
    negotiationId: Id,
    revision: z.number().int().nonnegative(),
    action: NegotiationActionSchema,
  })
  .strict();
export type NegotiationRequest = z.infer<typeof NegotiationRequestSchema>;
export interface NegotiationView {
  teamId: string | null;
  date: string;
  cases: Array<
    Omit<Negotiation, "bounds"> & { playerName: string; buyerName: string; sellerName: string }
  >;
  payments: TransferPayment[];
}
export function currentProposal(
  n: Pick<Negotiation, "proposals">,
  scope: ProposalTerms["scope"],
): NegotiationProposal | undefined {
  return [...n.proposals].reverse().find((p) => p.terms.scope === scope && p.status === "open");
}
export function proposalParties(
  n: Pick<Negotiation, "buyerId" | "sellerId" | "playerId">,
  scope: ProposalTerms["scope"],
): string[] {
  return scope === "club" ? [n.buyerId, n.sellerId] : [n.buyerId, n.playerId];
}
export function proposalAgreed(
  n: Pick<Negotiation, "buyerId" | "sellerId" | "playerId">,
  p: NegotiationProposal | undefined,
): boolean {
  return (
    !!p &&
    p.status === "open" &&
    proposalParties(n, p.terms.scope).every((id) => p.acceptedBy.includes(id))
  );
}
export function totalTransferFee(terms: ProposalTerms): number {
  return terms.fee + terms.installments.reduce((sum, p) => sum + p.amount, 0);
}
/** Season game rules: July–August and January; free agents and renewals are exempt. */
export function isTransferWindow(date: string): boolean {
  const month = date.slice(5, 7);
  return month === "01" || month === "07" || month === "08";
}
function contractDate(value: string): Date {
  const date = new Date(`${value}T00:00:00Z`);
  if (
    !DateString.safeParse(value).success ||
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    throw new RangeError(`Invalid contract date: ${value}`);
  }
  return date;
}

/** Inclusive end date; a leap-day anniversary rolls to March 1 before subtracting a day. */
export function contractEndForYears(since: string, years: number): string {
  if (!Number.isSafeInteger(years) || years < 1)
    throw new RangeError("Contract years must be a positive safe integer");
  const date = contractDate(since);
  date.setUTCFullYear(date.getUTCFullYear() + years);
  date.setUTCDate(date.getUTCDate() - 1);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() > 9999)
    throw new RangeError("Contract end date exceeds the supported calendar");
  return date.toISOString().slice(0, 10);
}

export const SetTransferListingSchema = z
  .object({
    playerId: Id,
    listed: z.boolean(),
    askingPrice: Money.optional(),
    note: z.string().trim().max(160).optional(),
  })
  .strict();
export type SetTransferListingInput = z.infer<typeof SetTransferListingSchema>;
export interface TransferListingRow {
  playerId: string;
  name: string;
  age: number;
  positions: string[];
  askingPrice?: number;
  listedOn: string;
  note?: string;
  negotiationIds: string[];
}
export interface TransferListingView {
  teamId: string | null;
  date: string;
  transferList: TransferListingRow[];
}
