"use client";
import { useEffect, useRef, useState } from "react";
import type { MailRecipient, MailView } from "@story-fm/domain";
import type { GamePayload } from "@/application/lib/store";
import {
  IconArrowLeft,
  IconClose,
  IconCompose,
  IconPaperclip,
  IconReply,
  IconSend,
} from "@/domains/common/ui/icons";
import { humanDate } from "@/domains/common/lib/dateline";
export type MailDraft = { recipient: MailRecipient; subject: string; body: string; label?: string };
export function Mailbox({
  gameId,
  mail,
  initialDraft,
  disabled,
  onDraftConsumed,
  onGame,
  onBusy,
  onAttach,
}: {
  gameId: string;
  mail: MailView;
  initialDraft: MailDraft | null;
  disabled: boolean;
  onDraftConsumed: () => void;
  onGame: (game: GamePayload, readOnly?: boolean) => void;
  onBusy: (busy: boolean) => void;
  onAttach: (id: string) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [compose, setCompose] = useState(false);
  const [replying, setReplying] = useState(false);
  const [recipientKey, setRecipientKey] = useState("");
  const [customRecipient, setCustomRecipient] = useState<{
    recipient: MailRecipient;
    label: string;
  } | null>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const writing = useRef(false);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const hydrated = useRef(false);
  const attemptedReads = useRef(new Set<string>());
  const request = useRef<{ key: string; id: string } | null>(null);
  const onGameRef = useRef(onGame);
  onGameRef.current = onGame;
  const onBusyRef = useRef(onBusy);
  onBusyRef.current = onBusy;
  useEffect(() => {
    mounted.current = true;
    try {
      const saved = sessionStorage.getItem(`mail-draft:${gameId}`);
      if (saved) {
        const draft = JSON.parse(saved) as {
          recipientKey: string;
          subject: string;
          body: string;
          customRecipient: typeof customRecipient;
          request: typeof request.current;
        };
        setRecipientKey(draft.recipientKey);
        setSubject(draft.subject);
        setBody(draft.body);
        setCustomRecipient(draft.customRecipient);
        request.current = draft.request;
      }
    } catch {
      // Storage may be unavailable; the active compose draft remains in memory.
    }
    return () => {
      mounted.current = false;
      controller.current?.abort();
      if (writing.current) onBusyRef.current(false);
    };
  }, [gameId]);
  useEffect(() => {
    if (!hydrated.current) {
      hydrated.current = true;
      return;
    }
    try {
      sessionStorage.setItem(
        `mail-draft:${gameId}`,
        JSON.stringify({ recipientKey, subject, body, customRecipient, request: request.current }),
      );
    } catch {
      // Storage may be unavailable; the active compose draft remains in memory.
    }
  }, [gameId, recipientKey, subject, body, customRecipient, pending]);
  const thread = mail.threads.find((t) => t.id === selected);
  const contacts =
    customRecipient &&
    !mail.recipients.some(
      (contact) => JSON.stringify(contact.recipient) === JSON.stringify(customRecipient.recipient),
    )
      ? [...mail.recipients, { contactId: "draft-contact", ...customRecipient }]
      : mail.recipients;
  const recipient = contacts.find(
    (contact) => JSON.stringify(contact.recipient) === recipientKey,
  )?.recipient;
  const apply = async (payload: unknown, signal: AbortSignal) => {
    const response = await fetch(`/api/games/${gameId}/mail`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify(payload),
    });
    const result = (await response.json()) as {
      game?: GamePayload;
      threadId?: string;
      error?: string;
    };
    if (!response.ok || !result.game)
      throw new Error(result.error ?? "메일을 처리하지 못했습니다.");
    return { game: result.game, threadId: result.threadId };
  };
  useEffect(() => {
    if (!initialDraft) return;
    setCustomRecipient({
      recipient: initialDraft.recipient,
      label: initialDraft.label ?? initialDraft.subject,
    });
    setRecipientKey(JSON.stringify(initialDraft.recipient));
    setSubject(initialDraft.subject);
    setBody(initialDraft.body);
    setCompose(true);
    setReplying(false);
    setError(null);
    onDraftConsumed();
  }, [initialDraft, onDraftConsumed]);
  useEffect(() => {
    if (!thread || thread.messages.length <= thread.lastReadMessage || disabled || writing.current)
      return;
    const key = `${thread.id}:${thread.messages.length}`;
    if (attemptedReads.current.has(key)) return;
    attemptedReads.current.add(key);
    const readController = new AbortController();
    const at = generation.current;
    void apply({ kind: "read", threadId: thread.id }, readController.signal)
      .then((result) => {
        if (mounted.current && !readController.signal.aborted && at === generation.current)
          onGameRef.current(result.game, true);
      })
      .catch(() => {});
    return () => readController.abort();
    // Read acknowledgements never lock the main conversation or clear send errors.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread?.id, thread?.messages.length, thread?.lastReadMessage, disabled]);
  const send = async () => {
    if (disabled || writing.current || !recipient || !subject.trim() || !body.trim()) return;
    const values = { recipient, subject: subject.trim(), body: body.trim() };
    const key = JSON.stringify(values);
    if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() };
    writing.current = true;
    const at = ++generation.current;
    const sendController = new AbortController();
    controller.current = sendController;
    setPending(true);
    onBusy(true);
    setError(null);
    try {
      const result = await apply(
        { kind: "send", requestId: request.current.id, ...values },
        sendController.signal,
      );
      if (!mounted.current || sendController.signal.aborted || at !== generation.current) return;
      onGameRef.current(result.game);
      request.current = null;
      setCompose(false);
      setSubject("");
      setBody("");
      if (result.threadId) setSelected(result.threadId);
    } catch (cause) {
      if (mounted.current && !sendController.signal.aborted)
        setError(cause instanceof Error ? cause.message : "메일을 보내지 못했습니다.");
    } finally {
      writing.current = false;
      controller.current = null;
      if (mounted.current) {
        setPending(false);
        onBusy(false);
      }
    }
  };
  return (
    <div className="mailbox" data-testid="mailbox">
      <header className="mailbox-head">
        <h2>
          메일함{" "}
          {mail.unread > 0 && (
            <small aria-label={`${mail.unread}개 읽지 않은 메일`}>{mail.unread}</small>
          )}
        </h2>
        {!compose && (
          <button
            disabled={disabled || pending}
            onClick={() => {
              setCompose(true);
              setReplying(false);
              setError(null);
            }}
            data-testid="mail-compose"
          >
            <IconCompose /> 메일 작성
          </button>
        )}
      </header>
      {error && (
        <div className="turn-error" role="alert">
          {error}
        </div>
      )}
      {compose ? (
        <form
          className="mail-compose"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <header className="mail-compose-head">
            <h3>{replying ? "답장" : "새 메일"}</h3>
            <button
              type="button"
              className="mail-icon-button"
              disabled={pending}
              aria-label="초안 닫기"
              title="초안 닫기"
              onClick={() => setCompose(false)}
            >
              <IconClose size={18} />
            </button>
          </header>
          <label className="mail-field">
            <span>받는 사람</span>
            <select
              value={recipientKey}
              required
              disabled={disabled || pending}
              onChange={(e) => setRecipientKey(e.target.value)}
              data-testid="mail-recipient"
            >
              <option value="">연락 상대 선택</option>
              {contacts.map((contact) => (
                <option key={contact.contactId} value={JSON.stringify(contact.recipient)}>
                  {contact.label}
                </option>
              ))}
            </select>
          </label>
          <label className="mail-field">
            <span>제목</span>
            <input
              value={subject}
              maxLength={200}
              required
              disabled={disabled || pending}
              onChange={(e) => setSubject(e.target.value)}
              data-testid="mail-subject"
            />
          </label>
          <label className="mail-body-field">
            <span className="mail-sr-only">본문</span>
            <textarea
              value={body}
              maxLength={12000}
              required
              disabled={disabled || pending}
              onChange={(e) => setBody(e.target.value)}
              data-testid="mail-body"
            />
          </label>
          <footer>
            <button
              type="submit"
              disabled={disabled || pending || !recipient || !subject.trim() || !body.trim()}
              data-testid="mail-send"
            >
              <IconSend size={17} /> {pending ? "발송 중…" : "메일 발송"}
            </button>
          </footer>
        </form>
      ) : thread ? (
        <section className="mail-thread">
          <header className="mail-thread-toolbar">
            <button
              className="mail-icon-button"
              aria-label="메일 목록"
              title="메일 목록"
              onClick={() => setSelected(null)}
            >
              <IconArrowLeft size={18} />
            </button>
            <div>
              <h3>{thread.label}</h3>
              <span>주고받은 메일 {thread.messages.length}개</span>
            </div>
          </header>
          {thread.messages.map((message) => (
            <article
              key={message.id}
              className={`mail-message${message.id === thread.messages.at(-1)?.id ? " latest" : ""}`}
            >
              <h4>{message.subject}</h4>
              <header className="mail-message-meta">
                <span className="mail-avatar" aria-hidden="true">
                  {message.direction === "outbound" ? "나" : thread.label.slice(0, 1)}
                </span>
                <div>
                  <strong>{message.direction === "outbound" ? "나" : thread.label}</strong>
                  <span>{message.direction === "outbound" ? `${thread.label}에게` : "내게"}</span>
                </div>
                <time>
                  {humanDate(message.on)} {message.at}
                </time>
              </header>
              <p>{message.body}</p>
              <button
                disabled={disabled || pending}
                onClick={() => onAttach(message.id)}
                className="mail-attach-action"
                title="대화에 첨부"
                aria-label={`${message.subject} 대화에 첨부`}
                data-testid="mail-attach"
              >
                <IconPaperclip size={16} /> 대화에 첨부
              </button>
            </article>
          ))}
          <button
            className="mail-reply"
            disabled={disabled || pending}
            onClick={() => {
              setReplying(true);
              setCustomRecipient({ recipient: thread.recipient, label: thread.label });
              setRecipientKey(JSON.stringify(thread.recipient));
              setSubject(
                `Re: ${(thread.messages.at(-1)?.subject ?? "연락").replace(/^(?:Re:\s*)+/i, "")}`.slice(
                  0,
                  200,
                ),
              );
              setBody("");
              setCompose(true);
            }}
          >
            <IconReply size={17} /> 답장
          </button>
        </section>
      ) : (
        <div className="mail-threads">
          {!mail.threads.length && <p className="muted">주고받은 메일이 없습니다.</p>}
          {mail.threads.map((row) => {
            const latest = row.messages.at(-1);
            const unread = row.messages
              .slice(row.lastReadMessage)
              .some((message) => message.direction !== "outbound");
            return (
              <button
                key={row.id}
                onClick={() => {
                  attemptedReads.current.clear();
                  setSelected(row.id);
                }}
                className={`mail-thread-row${unread ? " unread" : ""}`}
                data-testid="mail-thread"
              >
                <span className="mail-row-contact">
                  <strong>{row.label}</strong>
                  {unread && (
                    <>
                      <i aria-hidden="true" />
                      <span className="mail-sr-only">새 메일</span>
                    </>
                  )}
                </span>
                <time>{humanDate(latest?.on ?? "")}</time>
                <span className="mail-row-subject">{latest?.subject}</span>
                <span className="mail-row-preview">{latest?.body.replace(/\s+/g, " ")}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
