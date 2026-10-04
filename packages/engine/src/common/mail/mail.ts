import {
  MailSendSchema,
  MailReplySchema,
  MailRecipientSchema,
  type MailContact,
  type MailRecipient,
  type MailView,
  type MailMessage,
} from "@story-fm/domain";
import { clockOf, managedTeamId, teamNameIn, type GameState } from "../core/state";
import { addDays } from "../core/dates";
import { agentForPlayer, staffOf } from "../people/persona";
export interface MailResult {
  ok: boolean;
  message: string;
  threadId?: string;
  messageId?: string;
  replayed?: boolean;
}
const fail = (message: string): MailResult => ({ ok: false, message });
export function resolveMailRecipient(state: GameState, raw: unknown): MailContact | null {
  const parsed = MailRecipientSchema.safeParse(raw);
  if (!parsed.success) return null;
  const recipient = parsed.data,
    team = managedTeamId(state);
  if (!team) return null;
  if (recipient.kind === "club") {
    if (recipient.teamId === team || !state.finances.some((f) => f.teamId === recipient.teamId))
      return null;
    return {
      contactId: `club:${recipient.teamId}`,
      label: teamNameIn(state, recipient.teamId),
      recipient,
    };
  }
  if (recipient.kind === "agent") {
    if (!state.players.some((p) => p.id === recipient.playerId)) return null;
    const agent = agentForPlayer(state, recipient.playerId);
    return {
      contactId: `agent:${agent?.characterId ?? recipient.playerId}`,
      label:
        agent?.name ?? `${state.players.find((p) => p.id === recipient.playerId)!.name} 에이전트`,
      recipient,
    };
  }
  const person = staffOf({ ...state, userTeamId: team }).find(
    (p) => p.characterId === recipient.personId,
  );
  return person
    ? { contactId: `staff:${person.characterId}`, label: person.name, recipient }
    : null;
}
function validReferences(
  state: GameState,
  team: string,
  contact: MailContact,
  negotiationId: string | undefined,
  refs: { playerIds: string[]; proposalIds: string[]; reportIds: string[] },
) {
  const n = negotiationId ? state.negotiations.find((n) => n.id === negotiationId) : undefined;
  if (negotiationId && (!n || ![n.buyerId, n.sellerId].includes(team))) return false;
  if (
    n &&
    contact.recipient.kind === "club" &&
    ![n.buyerId, n.sellerId].includes(contact.recipient.teamId)
  )
    return false;
  if (
    n &&
    contact.recipient.kind === "agent" &&
    resolveMailRecipient(state, { kind: "agent", playerId: n.playerId })?.contactId !==
      contact.contactId
  )
    return false;
  return (
    refs.playerIds.every((id) => state.players.some((p) => p.id === id)) &&
    refs.proposalIds.every((id) =>
      state.negotiations.some(
        (n) =>
          [n.buyerId, n.sellerId].includes(team) &&
          n.proposals.some((p) => p.id === id && (n.buyerId === team || p.terms.scope === "club")),
      ),
    ) &&
    refs.reportIds.every((id) => state.schedule.some((e) => e.id === id && e.teamId === team))
  );
}
export function sendMail(state: GameState, raw: unknown): MailResult {
  const parsed = MailSendSchema.safeParse(raw);
  if (!parsed.success) return fail("메일 형식이 올바르지 않습니다");
  const input = parsed.data;
  const replay = state.mailRequests.includes(input.requestId);
  if (replay) {
    const thread = state.mailThreads.find(
      (t) =>
        t.ownerTeamId === managedTeamId(state) &&
        t.messages.some((m) => m.requestId === input.requestId),
    );
    const message = thread?.messages.find((m) => m.requestId === input.requestId);
    return {
      ok: true,
      message: "이미 발송한 메일입니다",
      replayed: true,
      threadId: thread?.id,
      messageId: message?.id,
    };
  }
  const team = managedTeamId(state),
    contact = resolveMailRecipient(state, input.recipient);
  if (state.phase === "match" || !team || !contact)
    return fail("지금 이 상대에게 메일을 보낼 수 없습니다");
  const references = input.references ?? { playerIds: [], proposalIds: [], reportIds: [] };
  if (!validReferences(state, team, contact, input.negotiationId, references))
    return fail("메일 참조 권한이 없습니다");
  let thread = state.mailThreads.find(
    (t) => t.ownerTeamId === team && t.contactId === contact.contactId,
  );
  if (!thread) {
    thread = {
      id: `mail-${state.mailThreads.length + 1}`,
      ownerTeamId: team,
      ...contact,
      messages: [],
      lastReadMessage: 0,
    };
    state.mailThreads.push(thread);
  }
  const message: MailMessage = {
    id: `${thread.id}-m${thread.messages.length + 1}`,
    on: state.date,
    at: clockOf(state),
    requestId: input.requestId,
    direction: "outbound",
    subject: input.subject,
    body: input.body,
    references,
    negotiationId: input.negotiationId ?? null,
  };
  thread.messages.push(message);
  state.mailRequests.push(input.requestId);
  const pending = state.mailReplyJobs.find(
    (j) => j.threadId === thread.id && j.status === "pending",
  );
  if (pending) pending.throughMessageId = message.id;
  else
    state.mailReplyJobs.push({
      id: `mail-job-${state.mailReplyJobs.length + 1}`,
      threadId: thread.id,
      throughMessageId: message.id,
      dueOn: addDays(state.date, 1),
      status: "pending",
      completedOn: null,
    });
  return { ok: true, message: "메일을 발송했습니다", threadId: thread.id, messageId: message.id };
}
export function dueMailReplies(state: GameState) {
  return state.mailReplyJobs.filter(
    (j) =>
      j.status === "pending" &&
      j.dueOn <= state.date &&
      state.mailThreads.some((t) => t.id === j.threadId && t.ownerTeamId === managedTeamId(state)),
  );
}
export function completeMailReply(state: GameState, jobId: string, raw: unknown): MailResult {
  const parsed = MailReplySchema.safeParse(raw);
  if (!parsed.success) return fail("회신 형식이 올바르지 않습니다");
  const job = state.mailReplyJobs.find((j) => j.id === jobId),
    thread = state.mailThreads.find((t) => t.id === job?.threadId);
  if (!job || !thread || thread.ownerTeamId !== managedTeamId(state))
    return fail("회신 작업 권한이 없습니다");
  if (job.status === "done")
    return { ok: true, message: "이미 처리한 회신입니다", threadId: thread.id, replayed: true };
  const input = parsed.data,
    contact = resolveMailRecipient(state, thread.recipient),
    references = input.references ?? { playerIds: [], proposalIds: [], reportIds: [] };
  if (
    !contact ||
    contact.contactId !== thread.contactId ||
    job.dueOn > state.date ||
    job.throughMessageId !== input.throughMessageId ||
    !thread.messages.some((m) => m.id === input.throughMessageId && m.direction === "outbound") ||
    !validReferences(state, thread.ownerTeamId, contact, input.negotiationId, references)
  )
    return fail("회신 시점 또는 참조가 변경되었습니다");
  const message: MailMessage = {
    id: `${thread.id}-m${thread.messages.length + 1}`,
    on: state.date,
    at: clockOf(state),
    requestId: null,
    direction: "inbound",
    subject: input.subject,
    body: input.body,
    references,
    negotiationId: input.negotiationId ?? null,
  };
  thread.messages.push(message);
  job.status = "done";
  job.completedOn = state.date;
  return { ok: true, message: "회신을 기록했습니다", threadId: thread.id, messageId: message.id };
}
export function readMailThread(state: GameState, id: string): MailResult {
  const thread = state.mailThreads.find(
    (t) => t.id === id && t.ownerTeamId === managedTeamId(state),
  );
  if (!thread) return fail("메일을 찾을 수 없습니다");
  thread.lastReadMessage = thread.messages.length;
  return { ok: true, message: "읽음 처리했습니다", threadId: id };
}
export function mailMessageForViewer(state: GameState, id: string): MailMessage | null {
  return (
    state.mailThreads
      .filter((t) => t.ownerTeamId === managedTeamId(state))
      .flatMap((t) => t.messages)
      .find((m) => m.id === id) ?? null
  );
}
export function buildMailView(state: GameState): MailView {
  const team = managedTeamId(state);
  const threads = state.mailThreads
    .filter((t) => t.ownerTeamId === team)
    .sort(
      (a, b) =>
        (b.messages.at(-1)?.on ?? "").localeCompare(a.messages.at(-1)?.on ?? "") ||
        (b.messages.at(-1)?.at ?? "").localeCompare(a.messages.at(-1)?.at ?? "") ||
        a.id.localeCompare(b.id),
    );
  const recipients: MailContact[] = [];
  const add = (r: MailRecipient) => {
    const c = resolveMailRecipient(state, r);
    if (c && !recipients.some((p) => p.contactId === c.contactId)) recipients.push(c);
  };
  state.finances.forEach((f) => add({ kind: "club", teamId: f.teamId }));
  state.players
    .filter((p) => p.teamId === team)
    .forEach((p) => add({ kind: "agent", playerId: p.id }));
  staffOf(state).forEach((p) => add({ kind: "staff", personId: p.characterId }));
  return {
    threads: structuredClone(threads),
    unread: threads.reduce(
      (s, t) =>
        s + t.messages.slice(t.lastReadMessage).filter((m) => m.direction !== "outbound").length,
      0,
    ),
    recipients,
  };
}
export function recordMailReport(
  state: GameState,
  input: {
    key: string;
    recipient: MailRecipient;
    subject: string;
    body: string;
    negotiationId?: string;
    references?: { playerIds: string[]; proposalIds: string[]; reportIds: string[] };
  },
): MailResult {
  const { key, ...raw } = input;
  const parsed = MailSendSchema.safeParse({ ...raw, requestId: key });
  if (!parsed.success) return fail("보고서 형식이 올바르지 않습니다");
  const existing = state.mailThreads.find(
    (t) => t.ownerTeamId === managedTeamId(state) && t.messages.some((m) => m.requestId === key),
  );
  if (existing)
    return { ok: true, message: "이미 전달한 보고서입니다", threadId: existing.id, replayed: true };
  const contact = resolveMailRecipient(state, input.recipient),
    team = managedTeamId(state);
  if (!contact || !team) return fail("보고서 수신 권한이 없습니다");
  const references = input.references ?? { playerIds: [], proposalIds: [], reportIds: [] };
  if (!validReferences(state, team, contact, input.negotiationId, references))
    return fail("보고서 참조가 올바르지 않습니다");
  let thread = state.mailThreads.find(
    (t) => t.ownerTeamId === team && t.contactId === contact.contactId,
  );
  if (!thread) {
    thread = {
      id: `mail-${state.mailThreads.length + 1}`,
      ownerTeamId: team,
      ...contact,
      messages: [],
      lastReadMessage: 0,
    };
    state.mailThreads.push(thread);
  }
  const message: MailMessage = {
    id: `${thread.id}-m${thread.messages.length + 1}`,
    on: state.date,
    at: clockOf(state),
    requestId: key,
    direction: "inbound",
    subject: input.subject,
    body: input.body,
    references,
    negotiationId: input.negotiationId ?? null,
  };
  thread.messages.push(message);
  return { ok: true, message: "보고서를 전달했습니다", threadId: thread.id, messageId: message.id };
}

export function deliverIncomingMail(state: GameState, raw: unknown): MailResult {
  const parsed = MailSendSchema.safeParse(raw);
  if (!parsed.success) return fail("수신 메일 형식이 올바르지 않습니다");
  const { requestId, ...input } = parsed.data;
  return recordMailReport(state, { ...input, key: requestId });
}
