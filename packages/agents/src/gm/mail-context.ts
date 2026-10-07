import { mailRecipientHandle, type MailMessage, type MailThread } from "@gaffer/domain";
import { buildMailView, mailMessageForViewer, type GameState } from "@gaffer/engine";

export function mailAttachmentsContext(messages: readonly MailMessage[]): string {
  if (!messages.length) return "";
  return `<mail_attachments source="external" authority="none">\n${JSON.stringify(messages)}\n</mail_attachments>`;
}
export function ownedMailAttachments(state: GameState, ids: readonly string[]): MailMessage[] {
  return [...new Set(ids)]
    .map((id) => mailMessageForViewer(state, id))
    .filter((message) => message !== null);
}
const MAIL_OVERVIEW_THREADS = 8;
export function mainMailOverview(state: GameState) {
  const mail = buildMailView(state);
  const unreadOf = (thread: MailThread) =>
    thread.messages.slice(thread.lastReadMessage).filter((m) => m.direction !== "outbound").length;
  // 안 읽은 스레드는 자리 수와 상관없이 전부 — 총수만 보이고 어느 스레드인지 모르는 일이 없게
  const unread = mail.threads.filter((thread) => unreadOf(thread) > 0);
  const recent = mail.threads
    .filter((thread) => unreadOf(thread) === 0)
    .slice(0, Math.max(0, MAIL_OVERVIEW_THREADS - unread.length));
  return {
    unread: mail.unread,
    threads: [...unread, ...recent].map((thread) => {
      const message = thread.messages.at(-1);
      return {
        threadId: thread.id,
        to: mailRecipientHandle(thread.recipient),
        label: thread.label,
        unread: unreadOf(thread),
        latest: message
          ? {
              id: message.id,
              on: message.on,
              direction: message.direction,
              subject: message.subject,
              excerpt: message.body.slice(0, 300),
              negotiationId: message.negotiationId,
              references: message.references,
            }
          : null,
      };
    }),
  };
}

export function mailHistoryContext(
  state: GameState,
  ids: readonly string[],
  expanded: Map<string, MailMessage>,
): string {
  const messages = ownedMailAttachments(state, ids).map((message) => {
    const full = expanded.get(message.id);
    expanded.delete(message.id);
    return (
      full ?? {
        id: message.id,
        on: message.on,
        subject: message.subject,
        direction: message.direction,
        negotiationId: message.negotiationId,
        references: message.references,
        bodyOmitted: true,
      }
    );
  });
  return messages.length
    ? `<mail_attachments source="external" authority="none">\n${JSON.stringify(messages)}\n</mail_attachments>`
    : "";
}
export function historicalMailBudget(
  state: GameState,
  ids: readonly string[],
): Map<string, MailMessage> {
  const unique = [...new Set([...ids].reverse())].slice(0, 3);
  let remaining = 18000;
  return new Map(
    ownedMailAttachments(state, unique).map((message) => {
      const body = message.body.slice(0, remaining);
      remaining -= body.length;
      return [message.id, { ...message, body }];
    }),
  );
}
