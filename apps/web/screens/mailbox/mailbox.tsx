"use client";
import { useEffect, useId, useRef, useState } from "react";
import type { MailRecipient, MailRecipientCandidate, MailView } from "@gaffer/domain";
import type { GamePayload } from "@/game/store";
import {
  IconArrowLeft,
  IconClose,
  IconCompose,
  IconPaperclip,
  IconReply,
  IconSend,
} from "@/shared/icons";
import { humanDate } from "@/shared/dateline";
import { Button } from "@/shared/button";
export type MailDraft = { recipient: MailRecipient; subject: string; body: string; label?: string };
/**
 * ── 메일함 — 상대별 연락 스레드 ────────
 *
 * 위계와 흐름은 Gmail의 도구 모음·작성 흐름을 따르되 값은 게임의 토큰이다
 * (https://support.google.com/mail/answer/2473038 · /answer/9259768). 새 메일 버튼은 목록 위에만
 * 서고, 상세·작성 화면은 「메일함」 제목을 되풀이하지 않는다.
 *
 * - 작성은 받는 사람 · 제목 · 본문 순서이고 닫아도 초안이 남는다. 받는 사람은 자유 입력과
 *   키보드로 고르는 자동완성 — 입력한 이름 그대로도 보낼 수 있고, 모호하면 후보가 소속과
 *   종류로 갈린다. 발송 중에는 다시 보낼 수 없고 실패하면 쓴 것이 그대로 남는다.
 * - 「대화에 첨부」는 메인 입력창 위에 지울 수 있는 참조 카드를 세울 뿐이다. 읽음·새로고침은
 *   시간을 넘기지도 상대의 회신을 만들지도 않는다.
 * - 1024 이상에서는 메인 채팅과 함께 서고, 좁은 화면은 첨부한 뒤 메인 입력을 보여 준다.
 * - 협상은 메인 채팅의 만남·통화·메일 지시로 나아간다 — 별도의 협상 대화방도, 저절로
 *   화면이 넘어가는 일도 없다.
 */
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
  const [recipientText, setRecipientText] = useState("");
  const [candidates, setCandidates] = useState<MailRecipientCandidate[]>([]);
  const [lookupOpen, setLookupOpen] = useState(false);
  const [lookupPending, setLookupPending] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [candidateIndex, setCandidateIndex] = useState(-1);
  const [focusRecipient, setFocusRecipient] = useState(false);
  const lookupId = useId();
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const composeRef = useRef<HTMLFormElement>(null);
  const recipientRef = useRef<HTMLInputElement>(null);
  const replyThreadId = useRef<string | null>(null);
  useEffect(() => {
    if (compose && replying) {
      bodyRef.current?.focus({ preventScroll: true });
      composeRef.current?.scrollIntoView({ block: "end" });
    }
  }, [compose, replying]);
  const [customRecipient, setCustomRecipient] = useState<{
    recipient: MailRecipient;
    label: string;
  } | null>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!focusRecipient || pending || disabled || !compose) return;
    recipientRef.current?.focus({ preventScroll: true });
    recipientRef.current?.scrollIntoView({ block: "center" });
    setFocusRecipient(false);
  }, [focusRecipient, pending, disabled, compose]);

  const mounted = useRef(false);
  const writing = useRef(false);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const hydrated = useRef(false);
  const attemptedReads = useRef(new Set<string>());
  const request = useRef<{ key: string; id: string } | null>(null);
  const recipientsRef = useRef(mail.recipients);
  recipientsRef.current = mail.recipients;
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
          recipientText?: string;
          subject: string;
          body: string;
          customRecipient: typeof customRecipient;
          request: typeof request.current;
        };
        setRecipientKey(draft.recipientKey);
        setRecipientText(
          draft.recipientText ??
            draft.customRecipient?.label ??
            recipientsRef.current.find(
              (contact) => JSON.stringify(contact.recipient) === draft.recipientKey,
            )?.label ??
            "",
        );
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
        JSON.stringify({
          recipientKey,
          recipientText,
          subject,
          body,
          customRecipient,
          request: request.current,
        }),
      );
    } catch {
      // Storage may be unavailable; the active compose draft remains in memory.
    }
  }, [gameId, recipientKey, recipientText, subject, body, customRecipient, pending]);
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
  useEffect(() => {
    if (!compose || recipientKey || !recipientText.trim()) {
      setCandidates([]);
      setLookupPending(false);
      return;
    }
    const abort = new AbortController();
    setCandidates([]);
    setCandidateIndex(-1);
    setLookupPending(true);
    setLookupError(null);
    const timer = setTimeout(() => {
      void fetch(`/api/games/${gameId}/mail?query=${encodeURIComponent(recipientText.trim())}`, {
        signal: abort.signal,
      })
        .then(async (response) => {
          const data = (await response.json()) as {
            candidates?: MailRecipientCandidate[];
            error?: string;
          };
          if (!response.ok) throw new Error(data.error ?? "연락 상대를 찾지 못했습니다.");
          if (!abort.signal.aborted) setCandidates(data.candidates ?? []);
        })
        .catch((cause: unknown) => {
          if (!abort.signal.aborted)
            setLookupError(cause instanceof Error ? cause.message : "연락 상대를 찾지 못했습니다.");
        })
        .finally(() => {
          if (!abort.signal.aborted) setLookupPending(false);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [compose, recipientText, recipientKey, gameId]);
  const chooseRecipient = (contact: MailView["recipients"][number]) => {
    setError(null);
    setFocusRecipient(false);
    setCustomRecipient({ recipient: contact.recipient, label: contact.label });
    setRecipientKey(JSON.stringify(contact.recipient));
    setRecipientText(contact.label);
    setLookupOpen(false);
    setCandidateIndex(-1);
  };
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
      candidates?: MailRecipientCandidate[];
    };
    if (!response.ok || !result.game) {
      if (mounted.current && !signal.aborted && result.candidates) {
        setCandidates(result.candidates);
        setLookupOpen(true);
        setFocusRecipient(true);
      }
      throw new Error(result.error ?? "메일을 처리하지 못했습니다.");
    }
    return { game: result.game, threadId: result.threadId };
  };
  useEffect(() => {
    if (!initialDraft) return;
    setCustomRecipient({
      recipient: initialDraft.recipient,
      label: initialDraft.label ?? initialDraft.subject,
    });
    setRecipientKey(JSON.stringify(initialDraft.recipient));
    setRecipientText(initialDraft.label ?? initialDraft.subject);
    setSubject(initialDraft.subject);
    setBody(initialDraft.body);
    setCompose(true);
    setReplying(false);
    replyThreadId.current = null;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 읽음 표시는 대화를 잠그지 않고 발송 오류도 지우지 않는다
  }, [thread?.id, thread?.messages.length, thread?.lastReadMessage, disabled]);
  const send = async () => {
    if (
      disabled ||
      writing.current ||
      (!recipient && !recipientText.trim()) ||
      !subject.trim() ||
      !body.trim()
    )
      return;
    const values = {
      ...(recipient ? { recipient } : { recipientText: recipientText.trim() }),
      subject: subject.trim(),
      body: body.trim(),
    };
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
      replyThreadId.current = null;
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
  const composeForm = (
    <form
      ref={composeRef}
      className="mail-compose"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <header className="mail-compose-head">
        <h3>{replying ? "답장" : "새 메일"}</h3>
        <Button
          variant="ghost"
          size="icon"
          className="mail-icon-button"
          disabled={pending}
          aria-label="초안 닫기"
          title="초안 닫기"
          onClick={() => setCompose(false)}
        >
          <IconClose size={18} />
        </Button>
      </header>
      <label className="mail-field">
        <span>받는 사람</span>
        <div className="mail-recipient-control">
          <input
            ref={recipientRef}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={compose && lookupOpen && !recipientKey && !!recipientText.trim()}
            aria-controls={lookupId}
            aria-activedescendant={
              lookupOpen && !recipientKey && candidateIndex >= 0
                ? `${lookupId}-${candidateIndex}`
                : undefined
            }
            value={recipientText}
            required
            maxLength={160}
            disabled={disabled || pending}
            placeholder="구단, 선수, 에이전트 또는 담당자"
            data-testid="mail-recipient"
            onFocus={() => setLookupOpen(true)}
            onBlur={() => setLookupOpen(false)}
            onChange={(e) => {
              setError(null);
              setRecipientText(e.target.value);
              setRecipientKey("");
              setLookupOpen(true);
              setCandidateIndex(-1);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setLookupOpen(false);
                setCandidateIndex(-1);
              } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && candidates.length) {
                e.preventDefault();
                setLookupOpen(true);
                setCandidateIndex((index) =>
                  index < 0
                    ? e.key === "ArrowDown"
                      ? 0
                      : candidates.length - 1
                    : (index + (e.key === "ArrowDown" ? 1 : candidates.length - 1)) %
                      candidates.length,
                );
              } else if (
                e.key === "Enter" &&
                lookupOpen &&
                candidateIndex >= 0 &&
                candidates[candidateIndex]
              ) {
                e.preventDefault();
                chooseRecipient(candidates[candidateIndex]);
              }
            }}
          />
          {lookupOpen && !recipientKey && recipientText.trim() && (
            <div className="mail-recipient-results">
              <div id={lookupId} role="listbox" aria-label="연락 상대 후보">
                {candidates.map((contact, index) => (
                  <Button
                    variant="bare"
                    disabled={disabled || pending}
                    role="option"
                    aria-selected={candidateIndex === index}
                    id={`${lookupId}-${index}`}
                    key={contact.contactId}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => chooseRecipient(contact)}
                  >
                    <strong>{contact.label}</strong>
                    {contact.description && <small>{contact.description}</small>}
                  </Button>
                ))}
              </div>
              {lookupPending ? (
                <p role="status">찾는 중…</p>
              ) : lookupError ? (
                <p role="status">{lookupError}</p>
              ) : (
                !candidates.length && <p role="status">일치하는 연락 상대가 없습니다.</p>
              )}
            </div>
          )}
        </div>
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
          ref={bodyRef}
          value={body}
          maxLength={12000}
          required
          disabled={disabled || pending}
          onChange={(e) => setBody(e.target.value)}
          data-testid="mail-body"
        />
      </label>
      {error && (
        <div className="turn-error" role="alert">
          {error}
        </div>
      )}
      <footer>
        <Button
          variant="primary"
          type="submit"
          disabled={
            disabled ||
            pending ||
            (!recipient && !recipientText.trim()) ||
            !subject.trim() ||
            !body.trim()
          }
          data-testid="mail-send"
        >
          <IconSend size={17} /> {pending ? "발송 중…" : "메일 발송"}
        </Button>
      </footer>
    </form>
  );
  return (
    <div className="mailbox" data-testid="mailbox">
      {!compose && !thread && (
        <header className="mailbox-head">
          <h2>
            메일함{" "}
            {mail.unread > 0 && (
              <small aria-label={`${mail.unread}개 읽지 않은 메일`}>{mail.unread}</small>
            )}
          </h2>
          <Button
            variant="secondary"
            disabled={disabled || pending}
            onClick={() => {
              setCompose(true);
              setReplying(false);
              replyThreadId.current = null;
              setError(null);
            }}
            data-testid="mail-compose"
          >
            <IconCompose /> 메일 작성
          </Button>
        </header>
      )}
      {compose && !replying ? (
        composeForm
      ) : thread ? (
        <section className="mail-thread">
          <header className="mail-thread-toolbar">
            <Button
              variant="ghost"
              size="icon"
              className="mail-icon-button"
              aria-label="메일 목록"
              title="메일 목록"
              onClick={() => {
                setSelected(null);
                setCompose(false);
              }}
            >
              <IconArrowLeft size={18} />
            </Button>
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
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled || pending}
                onClick={() => onAttach(message.id)}
                title="대화에 첨부"
                aria-label={`${message.subject} 대화에 첨부`}
                data-testid="mail-attach"
              >
                <IconPaperclip size={16} /> 대화에 첨부
              </Button>
            </article>
          ))}
          {compose && replying ? (
            composeForm
          ) : (
            <Button
              variant="secondary"
              className="mail-reply"
              disabled={disabled || pending}
              onClick={() => {
                setReplying(true);
                if (replyThreadId.current !== thread.id) {
                  setCustomRecipient({ recipient: thread.recipient, label: thread.label });
                  setRecipientKey(JSON.stringify(thread.recipient));
                  setRecipientText(thread.label);
                  setSubject(
                    `Re: ${(thread.messages.at(-1)?.subject ?? "연락").replace(/^(?:Re:\s*)+/i, "")}`.slice(
                      0,
                      200,
                    ),
                  );
                  setBody("");
                  replyThreadId.current = thread.id;
                }
                setCompose(true);
              }}
            >
              <IconReply size={17} /> 답장
            </Button>
          )}
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
              <Button
                variant="bare"
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
              </Button>
            );
          })}
        </div>
      )}
    </div>
  );
}
