"use client";
import { useEffect, useRef, useState } from "react";
import {
  NegotiationConfirmationPayloadSchema,
  contractEndForYears,
  proposalAgreed,
  type NegotiationAction,
  type ProposalTerms,
} from "@story-fm/domain";
import type { GamePayload } from "@/application/lib/store";
const money = (n: number) => `£${n.toLocaleString("en-GB")}`;
const duration = (terms: ProposalTerms) => {
  const difference = Number(terms.until.slice(0, 4)) - Number(terms.since.slice(0, 4));
  for (const years of [difference, difference + 1])
    if (years > 0 && contractEndForYears(terms.since, years) === terms.until) return `${years}년`;
  return `${terms.since} ~ ${terms.until}`;
};
function Conditions({ terms }: { terms: ProposalTerms }) {
  return (
    <dl className="confirmation-terms">
      {terms.scope === "club" ? (
        <>
          <dt>이적료</dt>
          <dd>{money(terms.fee)}</dd>
        </>
      ) : (
        <>
          <dt>계약 기간</dt>
          <dd>{duration(terms)}</dd>
          <dt>주급</dt>
          <dd>{money(terms.weeklyWage)}</dd>
          <dt>계약금</dt>
          <dd>{money(terms.signingBonus)}</dd>
        </>
      )}
      {terms.installments.map((p, i) => (
        <div key={i}>
          분할 지급 {p.date} · {money(p.amount)}
        </div>
      ))}
      {terms.promises.map((promise, i) => (
        <div key={i}>{promise}</div>
      ))}
    </dl>
  );
}
export function NegotiationConfirmation({
  payload,
  game,
  blocked,
  onGame,
  onBusy,
}: {
  payload: unknown;
  game: GamePayload;
  blocked: boolean;
  onGame: (game: GamePayload) => void;
  onBusy: (busy: boolean) => void;
}) {
  const parsed = NegotiationConfirmationPayloadSchema.safeParse(payload);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revision = useRef(parsed.success ? parsed.data.revision : -1);
  const request = useRef<{ key: string; id: string } | null>(null);
  const writing = useRef(false);
  const mounted = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const onBusyRef = useRef(onBusy);
  onBusyRef.current = onBusy;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
      if (writing.current) onBusyRef.current(false);
    };
  }, []);
  if (!parsed.success) return null;
  const card = parsed.data;
  const item = game.views.negotiation.cases.find((n) => n.id === card.negotiationId);
  if (!item) return null;
  const proposals = [card.clubProposalId, card.playerProposalId]
    .filter((id): id is string => id !== null)
    .map((id) => item.proposals.find((p) => p.id === id));
  const stageReady =
    card.stage === "agreement"
      ? proposals.length > 0
      : item.buyerId === game.views.negotiation.teamId &&
        card.playerProposalId !== null &&
        (item.kind !== "transfer" || card.clubProposalId !== null);
  const valid =
    stageReady &&
    item.revision === revision.current &&
    proposals.every((p) => p && p.status === "open" && p.terms.expiresOn >= game.date);
  const disabled = blocked || pending || !valid || item.status !== "open";
  const registrationDisabled =
    blocked || pending || item.revision !== revision.current || !item.signed;
  const act = async (action: NegotiationAction) => {
    if ((action.kind === "register" ? registrationDisabled : disabled) || writing.current) return;
    writing.current = true;
    const actionController = new AbortController();
    controller.current = actionController;
    setPending(true);
    onBusy(true);
    setError(null);
    const key = JSON.stringify({ id: item.id, revision: item.revision, action });
    if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() };
    try {
      const response = await fetch(`/api/games/${game.id}/negotiation`, {
        method: "POST",
        signal: actionController.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: request.current.id,
          negotiationId: item.id,
          revision: item.revision,
          action,
        }),
      });
      const result = (await response.json()) as { game?: GamePayload; error?: string };
      if (!mounted.current || actionController.signal.aborted) return;
      if (response.status === 409) {
        const latest = await fetch(`/api/games/${game.id}`, { signal: actionController.signal });
        if (latest.ok && mounted.current && !actionController.signal.aborted)
          onGame((await latest.json()) as GamePayload);
      }
      if (!response.ok || !result.game)
        throw new Error(result.error ?? "조건 확인을 처리하지 못했습니다.");
      const updated = result.game.views.negotiation.cases.find((n) => n.id === item.id);
      if (updated) revision.current = updated.revision;
      request.current = null;
      onGame(result.game);
    } catch (cause) {
      if (mounted.current && !actionController.signal.aborted)
        setError(cause instanceof Error ? cause.message : "요청을 처리하지 못했습니다.");
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
    <section
      className="negotiation-confirmation"
      data-testid="negotiation-confirmation"
      data-negotiation-id={item.id}
    >
      <header>
        <strong>
          {item.playerName} ·{" "}
          {card.stage === "sign"
            ? "최종 계약 확인"
            : card.stage === "medical"
              ? "메디컬 확인"
              : "조건 확인"}
        </strong>
        <span>
          {!valid
            ? "이전 확인 · 최신 조건을 다시 요청하세요."
            : item.status !== "open"
              ? "처리 완료"
              : "정확한 조건을 확인해 주세요."}
        </span>
      </header>
      {proposals.map(
        (p) =>
          p && (
            <div key={p.id}>
              <h4>{p.terms.scope === "club" ? "구단 이적 조건" : "선수 계약 조건"}</h4>
              <Conditions terms={p.terms} />
              {card.stage === "agreement" &&
                !p.acceptedBy.includes(game.views.negotiation.teamId ?? "") && (
                  <button
                    disabled={disabled}
                    onClick={() => void act({ kind: "accept", proposalId: p.id })}
                  >
                    조건 확인 후 합의
                  </button>
                )}
            </div>
          ),
      )}
      {item.medical && (
        <div>
          <p>
            {item.medical.examinedOn ? "검사 완료" : "검사 예정"} ·{" "}
            {item.medical.examinedOn ?? item.medical.readyOn}
          </p>
          {item.medical.injuries.map((injury) => (
            <p key={injury.id}>
              {injury.bodyPart} · 예상 복귀 {injury.expectedReturn}
            </p>
          ))}
          {item.medical.examinedOn && item.medical.injuries.length === 0 && (
            <p>현재 부상 기록 없음</p>
          )}
        </div>
      )}
      {card.stage === "medical" && (
        <div className="confirmation-actions">
          {!item.medical && (
            <button disabled={disabled} onClick={() => void act({ kind: "medical" })}>
              메디컬 요청
            </button>
          )}
          {item.medical?.examinedOn && !item.medical.acknowledgedBy.includes(item.buyerId) && (
            <button disabled={disabled} onClick={() => void act({ kind: "acknowledge_medical" })}>
              검사 결과·위험 확인
            </button>
          )}
          {item.medical?.examinedOn && item.medical.injuries.length > 0 && (
            <button disabled={disabled} onClick={() => void act({ kind: "medical" })}>
              추가 검사 요청
            </button>
          )}
        </div>
      )}
      {card.stage === "sign" && (
        <button
          disabled={disabled || !proposals.every((p) => p && proposalAgreed(item, p))}
          onClick={() => void act({ kind: "sign" })}
        >
          최종 서명
        </button>
      )}
      {item.status === "completed" &&
        item.registration === "pending" &&
        item.buyerId === game.views.negotiation.teamId && (
          <button disabled={registrationDisabled} onClick={() => void act({ kind: "register" })}>
            등록 신청
          </button>
        )}
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
    </section>
  );
}
