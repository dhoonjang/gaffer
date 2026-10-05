import { z } from "zod";
import { DateString } from "../core/date-string";
const Id = z.string().trim().min(1).max(160);
export const MailRecipientSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("club"), teamId: Id }).strict(),
  z.object({ kind: z.literal("agent"), playerId: Id }).strict(),
  z.object({ kind: z.literal("staff"), personId: Id }).strict(),
]);
export type MailRecipient = z.infer<typeof MailRecipientSchema>;
const MailReferencesSchema = z
  .object({
    playerIds: z.array(Id).max(20).default([]),
    proposalIds: z.array(Id).max(20).default([]),
    reportIds: z.array(Id).max(20).default([]),
  })
  .strict();
const MailMessageSchema = z.object({
  id: Id,
  on: DateString,
  at: z.string().regex(/^\d{2}:\d{2}$/),
  requestId: Id.nullable(),
  direction: z.enum(["outbound", "inbound", "system"]),
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(12000),
  references: MailReferencesSchema,
  negotiationId: Id.nullable(),
});
export type MailMessage = z.infer<typeof MailMessageSchema>;
export const MailThreadSchema = z.object({
  id: Id,
  ownerTeamId: Id,
  contactId: Id,
  label: z.string(),
  recipient: MailRecipientSchema,
  messages: z.array(MailMessageSchema),
  lastReadMessage: z.number().int().nonnegative(),
});
export type MailThread = z.infer<typeof MailThreadSchema>;
export const MailReplyJobSchema = z.object({
  id: Id,
  threadId: Id,
  throughMessageId: Id,
  dueOn: DateString,
  status: z.enum(["pending", "done"]),
  completedOn: DateString.nullable(),
});
export type MailReplyJob = z.infer<typeof MailReplyJobSchema>;
export const MailSendSchema = z
  .object({
    requestId: Id,
    recipient: MailRecipientSchema,
    subject: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(12000),
    negotiationId: Id.optional(),
    references: MailReferencesSchema.optional(),
  })
  .strict();
export const MailReplySchema = MailSendSchema.omit({ requestId: true, recipient: true })
  .extend({ throughMessageId: Id })
  .strict();
export interface MailContact {
  contactId: string;
  label: string;
  recipient: MailRecipient;
}
export interface MailView {
  threads: MailThread[];
  unread: number;
  recipients: MailContact[];
}

/** Browser form input; the server resolves free text before invoking MailSendSchema. */
export const MailUiSendSchema = MailSendSchema.omit({ recipient: true })
  .extend({
    recipient: MailRecipientSchema.optional(),
    recipientText: z.string().trim().min(1).max(160).optional(),
  })
  .refine((input) => input.recipient !== undefined || input.recipientText !== undefined, {
    message: "수신인을 입력해 주세요",
  });
export const MailRecipientSearchSchema = z
  .object({
    query: z.string().trim().min(1).max(160),
    limit: z.number().int().min(1).max(20).default(8),
  })
  .strict();
export interface MailRecipientCandidate extends MailContact {
  description?: string;
}
export type MailRecipientResolution =
  | { ok: true; contact: MailRecipientCandidate }
  | { ok: false; message: string; candidates: MailRecipientCandidate[] };
