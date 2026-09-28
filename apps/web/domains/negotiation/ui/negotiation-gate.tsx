"use client";

import { useState } from "react";
import type { NegotiationMethod } from "@story-fm/domain";
import type { NegotiationRoomView } from "@story-fm/engine";
import { humanDate } from "@/domains/common/lib/dateline";
import {
  METHOD_LABELS,
  Followups,
  TermSheet,
  Voices,
  hasTermSheet,
} from "@/domains/negotiation/ui/negotiation-room";

/** The entry method belongs to this exchange; the counterparty history remains shared. */
export function NegotiationGate({
  room,
  date,
  busy,
  leaving = false,
  onEnter,
}: {
  room: NegotiationRoomView;
  /** 오늘 — 게이트의 데이트라인이 읽는 날짜 */
  date: string;
  busy: boolean;
  /** 감독이 지금 이 문을 지나는 중인가 — 무대는 이미 방이다(`GATE_LEAVE_MS`) */
  leaving?: boolean;
  onEnter: (method: NegotiationMethod) => void;
}) {
  const [method, setMethod] = useState(room.method);
  return (
    <div
      className={leaving ? "negotiation-gate leaving" : "negotiation-gate"}
      data-testid="negotiation-gate"
      role="dialog"
      aria-modal="true"
      aria-labelledby="negotiation-heading"
    >
      <div className="negotiation-card">
        <div className="ng-body">
          <span className="ng-dateline" id="negotiation-heading">
            {/* 상대가 선수 본인인 갈래는 이름이 아래 머리에 이미 선다 — 두 번 적지 않는다 */}
            {[
              room.kindLabel,
              room.counterpart === room.playerName ? null : room.counterpart,
              humanDate(date),
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
          <b className="ng-who">{room.playerName}</b>

          <div className="ng-block">
            <span className="ng-label">건너편</span>
            <Voices voices={room.voices} />
          </div>

          {/* 빈 협상(오퍼 없이 떠보는 자리)은 조건서가 없다 — 절 자체가 서지 않는다 */}
          {hasTermSheet(room) && (
            <div className="ng-block">
              <span className="ng-label">조건서</span>
              <TermSheet room={room} />
            </div>
          )}

          <label className="ng-block">
            연락 방식
            <select
              value={method}
              onChange={(event) => setMethod(event.target.value as NegotiationMethod)}
              disabled={busy}
            >
              {Object.entries(METHOD_LABELS).map(([key, label]) => (
                <option value={key} key={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <Followups room={room} />
        </div>
        <button
          className="primary-btn"
          autoFocus
          disabled={busy}
          /* 협상의 문도 손잡이다 — 무대는 누름과 함께 바뀌고, 그 턴이 여는 턴인지는
             코어가 안다(`seated`) */
          onClick={() => onEnter(method)}
          data-testid="negotiation-enter"
        >
          협상 이어가기
        </button>
      </div>
    </div>
  );
}
