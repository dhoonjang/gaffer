import { z } from "zod";
import { DateString } from "../core/date-string";
const Id = z.string().trim().min(1).max(160);
export const MailRecipientSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("club"), teamId: Id }).strict(),
  z.object({ kind: z.literal("agent"), playerId: Id }).strict(),
  z.object({ kind: z.literal("staff"), personId: Id }).strict(),
]);
export type MailRecipient = z.infer<typeof MailRecipientSchema>;
/** 수신인 한 명을 문자열 하나로 — `club:<teamId>` · `agent:<playerId>` · `staff:<personId>` */
export function mailRecipientHandle(recipient: MailRecipient): string {
  if (recipient.kind === "club") return `club:${recipient.teamId}`;
  if (recipient.kind === "agent") return `agent:${recipient.playerId}`;
  return `staff:${recipient.personId}`;
}
export function parseMailRecipientHandle(text: string): MailRecipient | null {
  const match = /^(club|agent|staff):(.+)$/.exec(text.trim());
  if (!match) return null;
  const id = match[2];
  const raw =
    match[1] === "club"
      ? { kind: "club", teamId: id }
      : match[1] === "agent"
        ? { kind: "agent", playerId: id }
        : { kind: "staff", personId: id };
  const parsed = MailRecipientSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
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
