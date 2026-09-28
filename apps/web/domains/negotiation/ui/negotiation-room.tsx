"use client";

import { useState } from "react";
import type { NegotiationRoomView } from "@story-fm/engine";
import { formatMoney, type NegotiationMethod, type ProposalPrefill } from "@story-fm/domain";
import { Crest } from "@/domains/common/ui/crest";
import { IconPerson } from "@/domains/common/ui/icons";
import { Terms } from "@/domains/negotiation/ui/market-card";
import { useProposal } from "@/domains/negotiation/ui/proposal-form";
import { humanDate } from "@/domains/common/lib/dateline";

/** Current terms, the same counterparty’s history, and scheduled followups. */
export function NegotiationRoom({
  room,
  busy,
  onLeave,
}: {
  room: NegotiationRoomView;
  busy: boolean;
  onLeave: () => void;
}) {
  const proposal = useProposal();
  return (
    <div className="negotiation-room" data-testid="negotiation-room">
      <header className="nr-head">
        <span className="nr-kind">
          {room.kindLabel} · {METHOD_LABELS[room.method]}
        </span>
        <b className="nr-who">{room.playerName}</b>
        {/* 상대가 선수 본인인 갈래(재계약·해지)는 같은 이름을 두 번 적지 않는다 */}
        {room.counterpart !== room.playerName && (
          <span className="nr-counterpart">{room.counterpart}</span>
        )}
      </header>

      <section className="nr-section">
        <span className="nr-label">건너편</span>
        <Voices voices={room.voices} />
      </section>

      {hasTermSheet(room) && (
        <section className="nr-section">
          <span className="nr-label">조건서</span>
          <TermSheet room={room} />
        </section>
      )}

      <ContactHistory room={room} />
      <Followups room={room} />

      <div className="nr-handles">
        {proposal !== null && (
          <button
            type="button"
            className="nr-btn propose"
            disabled={busy}
            onClick={() => proposal.open(room.playerId, prefillOf(room))}
            data-testid="negotiation-propose"
          >
            제안서 작성
          </button>
        )}
        <button
          type="button"
          className="nr-btn leave"
          disabled={busy}
          onClick={onLeave}
          data-testid="negotiation-leave"
        >
          일상으로 돌아가기
        </button>
      </div>
    </div>
  );
}

/**
 * 건너편의 목소리 — 구단이면 문장 + 구단, 선수 쪽이면 이름. 그 아래 **무엇을 답하는가**
 * (이적료 · 분할 · 기한 / 주급 · 연수 · 지위). 게이트와 방이 같은 줄을 세운다.
 */
export function Voices({ voices }: { voices: NegotiationRoomView["voices"] }) {
  return (
    <ul className="nr-voices">
      {voices.map((voice) => (
        <li className="nr-voice" key={`${voice.speaker}-${voice.name}`}>
          {voice.team ? (
            <Crest
              id={voice.team.id}
              shortName={voice.team.short}
              colours={voice.team.colours}
              size={24}
            />
          ) : (
            <span className="nr-voice-mark" aria-hidden>
              <IconPerson size={16} />
            </span>
          )}
          <span className="nr-voice-who">
            <b className="nr-voice-name">{voice.name}</b>
            <em className="nr-voice-title">
              {voice.team ? `${voice.team.name} ${voice.title}` : voice.title}
            </em>
          </span>
          {voice.answers.length > 0 && (
            <span className="nr-voice-answers">
              {voice.answers.map((answer) => (
                <span key={answer}>{answer}</span>
              ))}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** 걸린 조건 한 줄의 답 — 코어가 낸 값 셋을 화면의 낱말로 */
const ANSWER_KO = { granted: "수락", refused: "거절" } as const;

/** 조건서에 세울 것이 하나라도 있는가 — 없으면 절 자체가 서지 않는다 (감독 노트와 같은 규약) */
export function hasTermSheet(room: NegotiationRoomView): boolean {
  return (
    room.ours !== null ||
    room.theirs !== null ||
    room.terms.length > 0 ||
    room.personal !== null ||
    room.feeAgreed !== null ||
    room.pitched.length > 0
  );
}

/**
 * 조건서 — 시장 카드의 표와 같은 격자 (`.mc-table`). 「제시」 한 줄과 「조정」 한 줄, 그
 * 아래 걸린 조건 목록(누가 · 갈래 · 답)과 개인 조건 선합의. 값의 자는 `formatMoney`다.
 */
export function TermSheet({ room }: { room: NegotiationRoomView }) {
  return (
    <div className="nr-sheet">
      {(room.ours || room.theirs) && (
        <div className="mc-table">
          {room.ours && (
            <div className="mc-terms">
              <em className="mc-side">제시</em>
              <div className="mc-vals">
                <Terms terms={room.ours} loan={room.loan} />
              </div>
            </div>
          )}
          {room.theirs && (
            <div className="mc-terms demand">
              <em className="mc-side">조정</em>
              <div className="mc-vals">
                <Terms terms={room.theirs} loan={room.loan} />
              </div>
            </div>
          )}
        </div>
      )}
      {room.feeAgreed && (
        <div className="nr-personal" data-agreed>
          <em className="mc-side">이적료 합의</em>
          <div className="mc-vals">
            <span>
              <em>이적료</em>
              <b>{formatMoney(room.feeAgreed.fee)}</b>
            </span>
          </div>
        </div>
      )}
      {room.personal && (
        <div className="nr-personal" data-agreed={room.personal.agreed || undefined}>
          <em className="mc-side">
            {room.personal.agreed
              ? "개인 조건 합의"
              : room.personal.countered
                ? "개인 조건 조정"
                : "개인 조건"}
          </em>
          <div className="mc-vals">
            <span>
              <em>주급</em>
              <b>{formatMoney(room.personal.weeklyWage)}</b>
            </span>
            <span>
              <em>기간</em>
              <b>{room.personal.years}년</b>
            </span>
          </div>
        </div>
      )}
      {room.terms.length > 0 && (
        <ul className="nr-terms">
          {room.terms.map((term, i) => (
            <li key={i} data-by={term.by} data-answer={term.answer ?? "pending"}>
              <span className="nr-term-by">{term.by === "us" ? "우리" : "상대"}</span>
              <b className="nr-term-label">{term.label}</b>
              {term.answer && <em className="nr-term-answer">{ANSWER_KO[term.answer]}</em>}
            </li>
          ))}
        </ul>
      )}
      {room.pitched.length > 0 && (
        <div className="mc-pitch">
          {room.pitched.map((claim) => (
            <span className="on" key={claim}>
              {claim}
            </span>
          ))}
        </div>
      )}
      {room.awaiting && <span className="nr-awaiting">답 대기</span>}
    </div>
  );
}

export const METHOD_LABELS: Record<NegotiationMethod, string> = {
  meeting: "대면",
  phone: "통화",
  proposal: "제안서",
};

export function Followups({ room }: { room: NegotiationRoomView }) {
  const labels = { response: "답신", renegotiate: "추가 협상", medical: "메디컬" };
  if (room.followups.length === 0) return null;
  return (
    <section className="nr-section">
      <span className="nr-label">다음 할 일</span>
      <ul>
        {room.followups.map((event) => (
          <li key={event.id}>
            {humanDate(event.dueOn)} · {labels[event.purpose]} ·{" "}
            {event.status === "completed"
              ? "처리됨"
              : event.requiresDecision
                ? "감독 결정 필요"
                : "예정"}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ContactHistory({ room }: { room: NegotiationRoomView }) {
  const [method, setMethod] = useState<NegotiationMethod | "all">("all");
  const [deal, setDeal] = useState("all");
  const deals = [
    ...new Map(room.history.map((line) => [line.negotiationId, line.playerName])).entries(),
  ];
  const lines = room.history.filter(
    (line) =>
      (method === "all" || line.method === method) &&
      (deal === "all" || line.negotiationId === deal),
  );
  return (
    <details className="nr-section">
      <summary>상대와의 연락 기록 ({room.history.length})</summary>
      <select
        aria-label="연락 방식"
        value={method}
        onChange={(event) => setMethod(event.target.value as NegotiationMethod | "all")}
      >
        <option value="all">모든 방식</option>
        {Object.entries(METHOD_LABELS).map(([key, label]) => (
          <option value={key} key={key}>
            {label}
          </option>
        ))}
      </select>
      <select aria-label="거래" value={deal} onChange={(event) => setDeal(event.target.value)}>
        <option value="all">모든 거래</option>
        {deals.map(([id, name]) => (
          <option value={id} key={id}>
            {name} · {id}
          </option>
        ))}
      </select>
      <ol>
        {lines.map((line, index) => (
          <li key={`${line.exchangeId}-${index}`}>
            <small>
              {humanDate(line.date, { weekday: false })} · {METHOD_LABELS[line.method]} ·{" "}
              {line.playerName}
            </small>
            <p>{line.text}</p>
          </li>
        ))}
      </ol>
    </details>
  );
}

/**
 * 방이 폼에 미리 채우는 값 — 상대의 조정안이 있으면 그것, 없으면 우리 마지막 오퍼다
 * (시장 카드와 같은 규약 · transfer.md §12-3). 폼이 갖는 갈래(영입·임대 영입·재계약)에
 * 드는 방만 갈래를 적고, 나머지는 폼이 스스로 고른다.
 */
function prefillOf(room: NegotiationRoomView): ProposalPrefill {
  const terms = room.theirs ?? room.ours;
  const kind =
    room.kind === "renew"
      ? "renew"
      : room.kind === "loan"
        ? "loan"
        : room.kind === "buy"
          ? "buy"
          : undefined;
  return {
    ...(kind === undefined ? {} : { kind }),
    ...(terms?.fee === undefined ? {} : { fee: terms.fee }),
    ...(terms?.paymentYears === undefined ? {} : { paymentYears: terms.paymentYears }),
    ...(terms?.weeklyWage === undefined ? {} : { weeklyWage: terms.weeklyWage }),
    ...(terms?.years === undefined ? {} : { years: terms.years }),
  };
}
