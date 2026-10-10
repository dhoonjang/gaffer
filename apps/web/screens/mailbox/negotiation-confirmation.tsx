"use client";
import { Fragment, useEffect, useRef, useState } from "react";
import {
  NegotiationConfirmationPayloadSchema,
  proposalAgreed,
  type NegotiationAction,
  type ProposalTerms,
} from "@gaffer/domain";
import type { GamePayload } from "@/game/store";
import { Button } from "../../shared/button";
import { contractSpan, humanDate } from "../../shared/dateline";
/** 확인 카드는 정확한 액수다 — 줄인 표기(`£42.0M`)가 아니라 파운드 단위까지 */
const money = (n: number) => `£${n.toLocaleString("en-GB")}`;
function Conditions({ terms }: { terms: ProposalTerms }) {
  return (
    <dl className="sheet-dl">
      {terms.scope === "club" ? (
        <>
          <dt>이적료</dt>
          <dd>{money(terms.fee)}</dd>
        </>
      ) : (
        <>
          <dt>계약 기간</dt>
          <dd>{contractSpan(terms.since, terms.until)}</dd>
          <dt>주급</dt>
          <dd>{money(terms.weeklyWage)}</dd>
          <dt>계약금</dt>
          <dd>{money(terms.signingBonus)}</dd>
        </>
      )}
      {terms.installments.map((p, i) => (
        <Fragment key={`i${i}`}>
          <dt>{i === 0 ? "분할 지급" : ""}</dt>
          <dd>
            {humanDate(p.date, { year: true, weekday: false })} · {money(p.amount)}
          </dd>
        </Fragment>
      ))}
      {terms.promises.map((promise, i) => (
        <Fragment key={`p${i}`}>
          <dt>{i === 0 ? "약속" : ""}</dt>
          <dd>{promise}</dd>
        </Fragment>
      ))}
    </dl>
  );
}
const STAGE_KO = {
  agreement: "조건 확인",
  medical: "메디컬 확인",
  sign: "최종 계약 확인",
} as const;
/**
 * ── 협상 확인 카드 — 대화 스크롤 안의 읽기 전용 장부 ────────
 *
 * 핵심은 지금 상대의 이적료, 또는 주급·계약 기간·계약금이고 분할금과 약속이 함께 선다.
 * 기간은 연수로 적고 정해진 연수와 맞지 않으면 날짜 범위를 쓴다(`contractSpan`). **카드에서
 * 조건을 고치지 않는다** — 조정은 자연어 대화로 하고, 발송한 제안은 뒤에 조건이 바뀌어도
 * 그대로 남는다(수정은 새 제안이다). 조작은 정확한 제안 id와 협상 버전으로 하고, 서버의
 * 버전이 바뀌었으면 갱신한 뒤 조작한다. 메디컬은 요청·완료·실제 부상 이력과 위험 확인을
 * 이 카드에 세우고, 계약 체결과 등록 대기는 서로 다른 상태다.
 */
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
    /** 기다리는 사이 화면이 닫히거나 요청이 끊겼나 — 매번 다시 읽는다 */
    const live = () => mounted.current && !actionController.signal.aborted;
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
      if (!live()) return;
      if (response.status === 409) {
        const latest = await fetch(`/api/games/${game.id}`, { signal: actionController.signal });
        if (latest.ok && live()) onGame((await latest.json()) as GamePayload);
      }
      if (!response.ok || !result.game)
        throw new Error(result.error ?? "조건 확인을 처리하지 못했습니다.");
      const updated = result.game.views.negotiation.cases.find((n) => n.id === item.id);
      if (updated) revision.current = updated.revision;
      request.current = null;
      onGame(result.game);
    } catch (cause) {
      if (live()) setError(cause instanceof Error ? cause.message : "요청을 처리하지 못했습니다.");
    } finally {
      writing.current = false;
      controller.current = null;
      if (mounted.current) {
        setPending(false);
        onBusy(false);
      }
    }
  };
  /** 이 카드가 지금도 조작할 수 있는 것인가 — 아니면 그 까닭이 머리줄 오른쪽에 선다 */
  const status =
    item.status !== "open"
      ? { label: "처리 완료", tone: "done" }
      : !valid
        ? { label: "지난 조건", tone: undefined }
        : null;
  return (
    <section
      className="sheet negotiation-confirmation"
      data-layer="order"
      data-testid="negotiation-confirmation"
      data-negotiation-id={item.id}
    >
      <header className="sheet-kicker">
        <b>{STAGE_KO[card.stage]}</b>
        {status && (
          <span className="sheet-status" data-tone={status.tone}>
            {status.label}
          </span>
        )}
      </header>
      <div className="sheet-title">
        <span className="sheet-name">{item.playerName}</span>
        <span className="sheet-sub">
          {item.kind === "transfer"
            ? item.buyerId === game.views.negotiation.teamId
              ? `이적 · ${item.sellerName} 소속`
              : `이적 · ${item.buyerName} 영입`
            : item.kind === "renewal"
              ? "재계약"
              : "자유계약"}
        </span>
      </div>
      <div className="sheet-terms">
        {proposals.map(
          (p) =>
            p && (
              <section className="sheet-section" key={p.id}>
                <div className="sheet-section-head">
                  <b>{p.terms.scope === "club" ? "구단 이적 조건" : "선수 계약 조건"}</b>
                </div>
                <Conditions terms={p.terms} />
                {card.stage === "agreement" &&
                  !p.acceptedBy.includes(game.views.negotiation.teamId ?? "") && (
                    <div className="confirmation-actions">
                      <Button
                        variant="primary"
                        disabled={disabled}
                        onClick={() => void act({ kind: "accept", proposalId: p.id })}
                      >
                        조건 확인 후 합의
                      </Button>
                    </div>
                  )}
              </section>
            ),
        )}
      </div>
      {item.medical && (
        <div className="sheet-foot">
          <span>
            <em>메디컬</em>
            {item.medical.examinedOn ? "검사 완료" : "검사 예정"} ·{" "}
            {humanDate(item.medical.examinedOn ?? item.medical.readyOn, { weekday: false })}
          </span>
          {item.medical.injuries.map((injury) => (
            <span data-short="true" key={injury.id}>
              {injury.bodyPart} · {humanDate(injury.expectedReturn, { weekday: false })} 복귀
            </span>
          ))}
          {item.medical.examinedOn && item.medical.injuries.length === 0 && (
            <span>부상 기록 없음</span>
          )}
        </div>
      )}
      {card.stage === "medical" && (
        <div className="confirmation-actions">
          {!item.medical && (
            <Button
              variant="secondary"
              disabled={disabled}
              onClick={() => void act({ kind: "medical" })}
            >
              메디컬 요청
            </Button>
          )}
          {item.medical?.examinedOn && !item.medical.acknowledgedBy.includes(item.buyerId) && (
            <Button
              variant="secondary"
              disabled={disabled}
              onClick={() => void act({ kind: "acknowledge_medical" })}
            >
              검사 결과·위험 확인
            </Button>
          )}
          {item.medical?.examinedOn && item.medical.injuries.length > 0 && (
            <Button
              variant="secondary"
              disabled={disabled}
              onClick={() => void act({ kind: "medical" })}
            >
              추가 검사 요청
            </Button>
          )}
        </div>
      )}
      {card.stage === "sign" && (
        <div className="confirmation-actions">
          <Button
            variant="primary"
            disabled={disabled || !proposals.every((p) => p && proposalAgreed(item, p))}
            onClick={() => void act({ kind: "sign" })}
          >
            최종 서명
          </Button>
        </div>
      )}
      {item.status === "completed" &&
        item.registration === "pending" &&
        item.buyerId === game.views.negotiation.teamId && (
          <div className="confirmation-actions">
            <Button
              variant="primary"
              disabled={registrationDisabled}
              onClick={() => void act({ kind: "register" })}
            >
              등록 신청
            </Button>
          </div>
        )}
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
    </section>
  );
}
