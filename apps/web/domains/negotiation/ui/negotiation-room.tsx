"use client";

import type { NegotiationRoomView } from "@story-fm/engine";
import { formatMoney, type NegotiationMethod, type ProposalPrefill } from "@story-fm/domain";
import { Crest } from "@/domains/common/ui/crest";
import { IconPerson } from "@/domains/common/ui/icons";
import { Terms } from "@/domains/negotiation/ui/market-card";
import { useProposal } from "@/domains/negotiation/ui/proposal-form";

/** 협상 상대와 현재 제안 조건. */
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
        <h2 className="nr-title">
          {room.playerName} <span>{room.kindLabel}</span>
        </h2>
        <span className="nr-method">{METHOD_LABELS[room.method]}</span>
      </header>

      <section className="nr-section">
        <span className="nr-label">협상 상대</span>
        <Voices voices={room.voices} />
      </section>

      {hasTermSheet(room) && (
        <section className="nr-section">
          <span className="nr-label">현재 조건</span>
          <TermSheet room={room} />
        </section>
      )}

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
          돌아가기
        </button>
      </div>
    </div>
  );
}

/** 게이트와 방에서 상대의 이름·소속·직책을 표시한다. */
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
    (room.party === "agent" && (room.personal !== null || room.feeAgreed !== null)) ||
    room.pitched.length > 0
  );
}

/** 현재 상대와 협의 중인 제안 또는 합의 조건을 표시한다. */
export function TermSheet({ room }: { room: NegotiationRoomView }) {
  const personal = room.party === "agent" ? room.personal : null;
  const terms = personal
    ? { weeklyWage: personal.weeklyWage, years: personal.years }
    : (room.theirs ?? room.ours);
  const agreed = personal
    ? personal.agreed
    : room.status === "agreed" ||
      room.status === "completed" ||
      (room.party === "club" && room.feeAgreed !== null);
  const fromCounterparty = personal ? personal.countered : room.theirs !== null;
  return (
    <div className="nr-sheet">
      {(terms || room.terms.length > 0) && (
        <div className="nr-offer">
          <span className="nr-offer-source">
            {terms
              ? agreed
                ? "합의한 조건"
                : fromCounterparty
                  ? "상대 제안"
                  : "우리 제안"
              : "추가 조건"}
          </span>
          {terms && (
            <div className="nr-offer-values">
              <Terms terms={terms} loan={room.loan} />
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
        </div>
      )}
      {room.feeAgreed && room.party === "agent" && (
        <div className="nr-agreement">
          <span>합의한 이적료</span>
          <b>{formatMoney(room.feeAgreed.fee)}</b>
        </div>
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
    </div>
  );
}

export const METHOD_LABELS: Record<NegotiationMethod, string> = {
  meeting: "대면",
  phone: "통화",
  proposal: "제안서",
};

/**
 * 방이 폼에 미리 채우는 값 — 상대의 조정안이 있으면 그것, 없으면 우리 마지막 오퍼다
 * (transfer.md). 폼이 갖는 갈래(영입·임대 영입·재계약)에
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
