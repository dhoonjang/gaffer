import type { MailMessage } from "@gaffer/domain";
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
export function mainMailOverview(state: GameState) {
  const mail = buildMailView(state);
  return {
    unread: mail.unread,
    // 주소록은 싣지 않는다 — 세계의 모든 구단이라 수백 건이다. 보낼 상대는 get_mail이 준다
    recent: [...mail.threads]
      .sort(
        (a, b) =>
          (b.messages.at(-1)?.on ?? "").localeCompare(a.messages.at(-1)?.on ?? "") ||
          (b.messages.at(-1)?.at ?? "").localeCompare(a.messages.at(-1)?.at ?? "") ||
          (b.messages.at(-1)?.id ?? "").localeCompare(a.messages.at(-1)?.id ?? "", undefined, {
            numeric: true,
          }),
      )
      .slice(0, 8)
      .map((thread) => {
        const message = thread.messages.at(-1);
        return {
          threadId: thread.id,
          contactId: thread.contactId,
          label: thread.label,
          unread: thread.messages
            .slice(thread.lastReadMessage)
            .filter((m) => m.direction !== "outbound").length,
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
