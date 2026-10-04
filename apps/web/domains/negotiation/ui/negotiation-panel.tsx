"use client";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  NEGOTIATION_CHANNEL_LABELS,
  INJURY_SEVERITY_KO,
  currentProposal,
  contractEndForYears,
  proposalAgreed,
  type NegotiationChannel,
  type NegotiationView,
  type ProposalTerms,
} from "@story-fm/domain";
import { useNegotiationRequest } from "./use-negotiation-request";
import { AgentCenterSearch } from "./agent-center-search";
import { humanDate } from "@/domains/common/lib/dateline";
import { PlayerName } from "@/domains/common/ui/player-card";
import type { OfficeViews } from "@story-fm/engine";
import type { GamePayload } from "@/application/lib/store";

const archived = (n: Case) =>
  n.status === "withdrawn" || (n.status === "completed" && n.registration === "registered");
const duration = (terms: ProposalTerms) => {
  const difference = Number(terms.until.slice(0, 4)) - Number(terms.since.slice(0, 4));
  for (const years of [difference, difference + 1]) {
    if (years > 0 && contractEndForYears(terms.since, years) === terms.until) return `${years}년`;
  }
  return `${terms.since} ~ ${terms.until}`;
};
const money = (amount: number) => `£${amount.toLocaleString("en-GB")}`;
const channels: NegotiationChannel[] = ["club", "player"];
type Case = NegotiationView["cases"][number];
function validAgreement(item: Case, scope: ProposalTerms["scope"], date: string): boolean {
  const proposal = currentProposal(item, scope);
  return !!proposal && proposal.terms.expiresOn >= date && proposalAgreed(item, proposal);
}
function caseStatus(item: Case, teamId: string | null, date: string): string {
  if (item.status === "withdrawn") return "철회";
  if (item.registration === "registered") return "완료";
  if (item.status === "completed") return "등록 대기";
  if (item.status === "signed") return "합류 대기";
  const club = currentProposal(item, "club");
  const agreed =
    validAgreement(item, "player", date) &&
    (item.kind !== "transfer" || validAgreement(item, "club", date));
  if (agreed) {
    if (item.kind === "renewal") return "서명 대기";
    if (!item.medical) return "메디컬 대기";
    if (!item.medical.examinedOn) return "검사 대기";
    return item.medical.acknowledgedBy.includes(item.buyerId) ? "서명 대기" : "검사 결과 확인";
  }
  if (item.nextReplyOn) return "상대 답변 대기";
  if (
    item.proposals.some(
      (proposal) => proposal.status === "open" && !proposal.acceptedBy.includes(teamId ?? ""),
    )
  )
    return "제안 검토";
  if (item.sellerId === teamId && item.buyerId !== teamId && proposalAgreed(item, club))
    return "구단 조건 합의";
  return item.proposals.length > 0 ? "조건 논의 중" : "협상 중";
}

export function NegotiationPanel({
  gameId,
  view,
  blocked,
  onGame,
  onBusy,
  mode = "detail",
  selectedId = null,
  onSelect,
  renderMessages,
  renderComposer,
  renderPending,
  renderError,
  expiringContracts = [],
  onMainChat,
}: {
  gameId: string;
  view: NegotiationView;
  blocked: boolean;
  onGame: (game: GamePayload) => void;
  onBusy: (busy: boolean) => void;
  mode?: "list" | "detail";
  selectedId?: string | null;
  onSelect: (id: string | null) => void;
  expiringContracts?: OfficeViews["finance"]["expiringContracts"];
  onMainChat?: () => void;
  renderMessages?: (messages: NegotiationView["cases"][number]["messages"]) => ReactNode;
  renderPending?: (props: { text: string | null; thinking: boolean }) => ReactNode;
  renderError?: (props: {
    error: string | null;
    onRetry?: () => void;
    onDismiss: () => void;
    busy: boolean;
  }) => ReactNode;
  renderComposer?: (props: {
    text: string;
    channel: NegotiationChannel;
    onText: (text: string) => void;
    onSend: () => void;
    busy: boolean;
    inputRef: RefObject<HTMLTextAreaElement | null>;
  }) => ReactNode;
}) {
  const centerId = useId();
  const [centerTab, setCenterTab] = useState("negotiations");
  const centerTabs = [
    { id: "negotiations", label: "협상" },
    { id: "search", label: "선수 찾기" },
    { id: "contracts", label: "계약 만료" },
    { id: "transfers", label: "이적 명단" },
  ];
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    menuTriggerRef.current?.focus();
  }, []);
  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
    const outside = (event: MouseEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) closeMenu();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeMenu();
      }
    };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [menuOpen, closeMenu]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const selected = mode === "detail" ? selectedId : null;
  const setSelected = onSelect;
  const [channel, setChannel] = useState<NegotiationChannel>("club");
  const item = view.cases.find((n) => n.id === selected);
  const { text, setText, error, pending, optimisticText, thinking, dismiss, retry, act } =
    useNegotiationRequest({ gameId, item, channel, blocked, onGame, onBusy });
  useEffect(() => {
    setMenuOpen(false);
    setChannel(item?.kind === "transfer" ? "club" : "player");
  }, [selected, item?.kind]);
  const availableChannels = useMemo(
    () =>
      item?.kind !== "transfer"
        ? channels.filter((candidate) => candidate !== "club")
        : item.sellerId === view.teamId && item.buyerId !== view.teamId
          ? channels.filter((candidate) => candidate !== "player")
          : channels,
    [item?.kind, item?.sellerId, item?.buyerId, view.teamId],
  );
  useEffect(() => {
    if (!availableChannels.includes(channel)) setChannel(availableChannels[0] ?? "player");
  }, [availableChannels, channel]);
  useEffect(() => {
    if (mode !== "detail") return;
    timelineRef.current?.scrollTo({ top: timelineRef.current.scrollHeight });
  }, [mode, selected, channel, item?.messages.length, optimisticText, thinking]);
  useEffect(() => {
    if (mode === "detail" && selected && !blocked) inputRef.current?.focus();
  }, [mode, selected, blocked]);
  const disabled = blocked || pending;
  const isBuyer = item?.buyerId === view.teamId;
  const agreed =
    !!item &&
    validAgreement(item, "player", view.date) &&
    (item.kind !== "transfer" || validAgreement(item, "club", view.date));
  const medicalAcknowledged =
    !!item?.medical?.examinedOn && item.medical.acknowledgedBy.includes(item.buyerId);
  const signReady = agreed && (item?.kind === "renewal" || medicalAcknowledged);
  const payments = view.payments.filter((payment) => payment.negotiationId === selected);
  return (
    <section className={`negotiation-workspace negotiation-${mode}`} aria-label="협상">
      {mode === "list" && (
        <aside className="negotiation-list">
          <header className="negotiation-list-header">
            <h2>
              에이전트 센터 <small>{view.unread > 0 && view.unread}</small>
            </h2>
          </header>
          <div className="agent-center-tabs" role="tablist" aria-label="에이전트 센터">
            {centerTabs.map((tab, index) => (
              <button
                key={tab.id}
                id={`${centerId}-tab-${tab.id}`}
                data-testid={`agent-center-tab-${tab.id}`}
                role="tab"
                aria-selected={centerTab === tab.id}
                aria-controls={`${centerId}-panel-${tab.id}`}
                tabIndex={centerTab === tab.id ? 0 : -1}
                onClick={() => setCenterTab(tab.id)}
                onKeyDown={(event) => {
                  const target =
                    event.key === "ArrowRight"
                      ? (index + 1) % centerTabs.length
                      : event.key === "ArrowLeft"
                        ? (index + centerTabs.length - 1) % centerTabs.length
                        : event.key === "Home"
                          ? 0
                          : event.key === "End"
                            ? centerTabs.length - 1
                            : null;
                  if (target !== null) {
                    event.preventDefault();
                    setCenterTab(centerTabs[target]!.id);
                    const tabs =
                      event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                        '[role="tab"]',
                      );
                    tabs?.item(target).focus();
                  }
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div
            role="tabpanel"
            id={`${centerId}-panel-negotiations`}
            aria-labelledby={`${centerId}-tab-negotiations`}
            hidden={centerTab !== "negotiations"}
          >
            <section className="negotiation-overview-section">
              <h3>
                진행 중 <small>{view.cases.filter((n) => !archived(n)).length}</small>
              </h3>
              <div className="negotiation-cases">
                {!view.cases.some((n) => !archived(n)) && (
                  <p className="negotiation-empty">
                    진행 중인 협상이 없습니다. 메인 대화에서 영입·매각·재계약을 지시하세요.
                  </p>
                )}
                {view.cases
                  .filter((n) => !archived(n))
                  .map((n) => (
                    <button
                      key={n.id}
                      className={selected === n.id ? "selected" : ""}
                      disabled={blocked || pending}
                      onClick={() => setSelected(n.id)}
                    >
                      <div className="negotiation-row-heading">
                        <b>
                          {n.playerName} ·{" "}
                          {n.kind === "renewal"
                            ? "재계약"
                            : n.kind === "free"
                              ? "자유계약"
                              : n.sellerId === view.teamId
                                ? "매각"
                                : "영입"}
                        </b>
                        <time>{n.messages.at(-1)?.on ?? n.openedOn}</time>
                        {n.messages.length > n.lastReadMessage && (
                          <span className="negotiation-new" aria-label="새 소식">
                            새 소식
                          </span>
                        )}
                      </div>
                      <span className="negotiation-next">
                        {n.buyerId === view.teamId
                          ? n.kind === "renewal" || n.kind === "free"
                            ? "에이전트 측"
                            : n.sellerName
                          : n.buyerName}{" "}
                        · {caseStatus(n, view.teamId, view.date)}
                      </span>
                    </button>
                  ))}
              </div>
            </section>
            <details className="negotiation-overview-section">
              <summary>
                종료된 협상 <small>{view.cases.filter(archived).length}</small>
              </summary>
              <div className="negotiation-cases">
                {view.cases.filter(archived).map((n) => (
                  <button
                    key={n.id}
                    className={selected === n.id ? "selected" : ""}
                    disabled={blocked || pending}
                    onClick={() => setSelected(n.id)}
                  >
                    <div className="negotiation-row-heading">
                      <b>
                        {n.playerName} ·{" "}
                        {n.kind === "renewal"
                          ? "재계약"
                          : n.kind === "free"
                            ? "자유계약"
                            : n.sellerId === view.teamId
                              ? "매각"
                              : "영입"}
                      </b>
                      <time>{n.messages.at(-1)?.on ?? n.openedOn}</time>
                      {n.messages.length > n.lastReadMessage && (
                        <span className="negotiation-new" aria-label="새 소식">
                          새 소식
                        </span>
                      )}
                    </div>
                    <span className="negotiation-next">
                      {n.buyerId === view.teamId
                        ? n.kind === "renewal" || n.kind === "free"
                          ? "에이전트 측"
                          : n.sellerName
                        : n.buyerName}{" "}
                      · {caseStatus(n, view.teamId, view.date)}
                    </span>
                  </button>
                ))}
              </div>
            </details>
          </div>
          <div
            role="tabpanel"
            id={`${centerId}-panel-search`}
            aria-labelledby={`${centerId}-tab-search`}
            hidden={centerTab !== "search"}
          >
            <AgentCenterSearch
              gameId={gameId}
              refreshKey={JSON.stringify(
                view.cases.map(({ id, status, revision }) => [id, status, revision]),
              )}
              disabled={disabled}
              active={centerTab === "search"}
            />
          </div>
          <div
            role="tabpanel"
            id={`${centerId}-panel-contracts`}
            aria-labelledby={`${centerId}-tab-contracts`}
            hidden={centerTab !== "contracts"}
          >
            <section className="negotiation-overview-section">
              <h3>
                계약 만료 예정 <small>{expiringContracts.length}</small>
              </h3>
              {!expiringContracts.length && (
                <p className="negotiation-empty">1년 안에 만료되는 계약이 없습니다.</p>
              )}
              <div className="agent-table-scroll">
                <table className="agent-player-table">
                  <thead>
                    <tr>
                      <th>선수</th>
                      <th>나이</th>
                      <th>만료일</th>
                      <th>남은 기간</th>
                      <th>주급</th>
                    </tr>
                  </thead>
                  <tbody>
                    {expiringContracts.map((contract) => (
                      <tr data-testid="agent-expiring-contract" key={contract.playerId}>
                        <td>
                          <PlayerName id={contract.playerId} name={contract.name} />
                        </td>
                        <td>{contract.age}</td>
                        <td>{humanDate(contract.until, { year: true, weekday: false })}</td>
                        <td>{contract.daysLeft}일</td>
                        <td>{money(contract.weeklyWage)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
          <div
            role="tabpanel"
            id={`${centerId}-panel-transfers`}
            aria-labelledby={`${centerId}-tab-transfers`}
            hidden={centerTab !== "transfers"}
          >
            <section className="negotiation-overview-section">
              <h3>
                매각 명단 <small>{view.transferList.length}</small>
              </h3>
              {!view.transferList.length && (
                <p className="negotiation-empty">메인 대화에서 매각할 선수를 지정하세요.</p>
              )}
              {view.transferList.map((player) => (
                <div
                  className="negotiation-expiring"
                  data-testid="agent-transfer-listing"
                  key={player.playerId}
                >
                  <div>
                    <PlayerName id={player.playerId} name={player.name} />
                    <span>
                      {player.age}세 · {player.positions.join(" · ")} ·{" "}
                      {humanDate(player.listedOn, { weekday: false })} 등록
                    </span>
                    {player.note && <span>{player.note}</span>}
                  </div>
                  <div>
                    <strong>
                      {player.askingPrice === undefined ? "가격 협의" : money(player.askingPrice)}
                    </strong>
                    {player.negotiationIds.map((id) => (
                      <button key={id} disabled={disabled} onClick={() => onSelect(id)}>
                        매각 대화
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </section>
          </div>
        </aside>
      )}
      <article className="negotiation-detail">
        {!item ? (
          <div className="negotiation-empty">협상 건을 선택하세요.</div>
        ) : (
          <>
            <button className="negotiation-main-return" onClick={onMainChat}>
              메인 대화로
            </button>
            <header className="negotiation-heading">
              <div>
                <h2>
                  {item.playerName} ·{" "}
                  {item.kind === "renewal"
                    ? "재계약"
                    : item.kind === "free"
                      ? "자유계약"
                      : item.sellerId === view.teamId
                        ? "매각"
                        : "영입"}
                </h2>
                <div className="negotiation-header-meta">
                  <span>
                    {channel === "player"
                      ? `${item.playerName} 에이전트 ↔ ${item.buyerName}`
                      : `${item.sellerName} ↔ ${item.buyerName}`}
                  </span>
                  <span className="negotiation-state-badge">
                    {caseStatus(item, view.teamId, view.date)}
                  </span>
                </div>
              </div>
              {item.status === "open" && (
                <div className="negotiation-menu" ref={menuRef}>
                  <button
                    ref={menuTriggerRef}
                    className="negotiation-menu-trigger"
                    type="button"
                    aria-label="협상 더보기"
                    title="협상 더보기"
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    onClick={() => setMenuOpen(!menuOpen)}
                  >
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <circle cx="5" cy="12" r="1.8" />
                      <circle cx="12" cy="12" r="1.8" />
                      <circle cx="19" cy="12" r="1.8" />
                    </svg>
                  </button>
                  {menuOpen && (
                    <div className="negotiation-menu-pop" role="menu">
                      <button
                        role="menuitem"
                        disabled={disabled}
                        onClick={() => {
                          closeMenu();
                          const reason = window.prompt("철회 이유");
                          if (reason) void act({ kind: "withdraw", reason });
                        }}
                      >
                        협상 철회
                      </button>
                    </div>
                  )}
                </div>
              )}
            </header>
            {availableChannels.length > 1 && (
              <div className="negotiation-context-bar">
                <label>
                  대화 상대
                  <select
                    aria-label="대화 상대"
                    value={channel}
                    disabled={disabled}
                    onChange={(event) => setChannel(event.target.value as NegotiationChannel)}
                  >
                    {availableChannels.map((candidate) => (
                      <option key={candidate} value={candidate}>
                        {NEGOTIATION_CHANNEL_LABELS[candidate]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
            <div className="negotiation-thread chat-scroll" ref={timelineRef}>
              {renderMessages?.(
                item.messages.filter(
                  (message) => message.channel === channel || message.channel === "internal",
                ),
              )}
              {!item.messages.some((m) => m.channel === channel || m.channel === "internal") && (
                <p className="muted">
                  아직 대화가 없습니다.{" "}
                  {channel === "player"
                    ? "에이전트와 계약 조건을 논의하세요."
                    : "구단과 이적 조건을 논의하세요."}
                </p>
              )}
              {item.drafts
                .filter((draft) => draft.scope === channel)
                .map((draft) => (
                  <section className="negotiation-progress" key={draft.scope}>
                    <h3>논의 중인 조건</h3>
                    <Terms terms={draft} />
                  </section>
                ))}
              {item.proposals.some((proposal) => proposal.terms.scope === channel) && (
                <section className="negotiation-proposals">
                  <h3>현재 조건</h3>
                  {item.proposals
                    .filter((p) => p.terms.scope === channel)
                    .map((p) => {
                      const index = item.proposals.findIndex((candidate) => candidate.id === p.id);
                      const prev = item.proposals
                        .slice(0, index)
                        .findLast((old) => old.terms.scope === p.terms.scope);
                      return (
                        <details
                          className="negotiation-proposal"
                          key={p.id}
                          open={p.status === "open"}
                        >
                          <summary>
                            {p.terms.scope === "club" ? "이적 조건" : "계약 조건"} ·{" "}
                            {humanDate(p.sentOn, { weekday: false })} ·{" "}
                            {p.terms.expiresOn < view.date || p.status === "expired"
                              ? "기한 만료"
                              : proposalAgreed(item, p)
                                ? "합의 완료"
                                : p.status === "open"
                                  ? p.author === view.teamId
                                    ? "상대 확인 대기"
                                    : "상대 제안 · 확인 대기"
                                  : p.status === "superseded"
                                    ? "이전 조건"
                                    : "거절"}
                          </summary>
                          <Terms terms={p.terms} />
                          {prev && (
                            <p className="muted">
                              이전 대비:{" "}
                              {p.terms.scope === "club"
                                ? `이적료 ${money(p.terms.fee - prev.terms.fee)}`
                                : `주급 ${money(p.terms.weeklyWage - prev.terms.weeklyWage)} · ${duration(p.terms)} · 보너스 ${money(p.terms.signingBonus - prev.terms.signingBonus)}`}
                            </p>
                          )}
                          {p.reason && <p className="muted">{p.reason}</p>}
                          {p.status === "open" &&
                            p.terms.expiresOn >= view.date &&
                            p.author !== view.teamId &&
                            item.status === "open" &&
                            !p.acceptedBy.includes(view.teamId ?? "") &&
                            (p.terms.scope === "club" || item.buyerId === view.teamId) && (
                              <div className="negotiation-actions">
                                <button
                                  disabled={disabled}
                                  onClick={() => void act({ kind: "accept", proposalId: p.id })}
                                >
                                  조건 확인 후 합의
                                </button>
                                <button
                                  disabled={disabled}
                                  onClick={() => {
                                    const reason = window.prompt("거절 이유");
                                    if (reason)
                                      void act({ kind: "reject", proposalId: p.id, reason });
                                  }}
                                >
                                  거절
                                </button>
                              </div>
                            )}
                        </details>
                      );
                    })}
                </section>
              )}
              {(item.medical || item.signed || (isBuyer && agreed) || payments.length > 0) && (
                <section className="negotiation-progress">
                  <h3>{item.signed ? "계약 진행" : item.medical ? "메디컬" : "조건 합의"}</h3>
                  {item.medical && (
                    <>
                      <p>
                        {item.medical.examinedOn
                          ? `검사 완료 · ${item.medical.examinedOn}`
                          : `검사 예정 · ${item.medical.readyOn}`}
                      </p>
                      {item.medical.injuries.map((injury) => (
                        <p key={injury.id}>
                          {injury.bodyPart} · {INJURY_SEVERITY_KO[injury.severity]} · 발생{" "}
                          {injury.occurredOn} · 예상 복귀 {injury.expectedReturn}
                        </p>
                      ))}
                      {item.medical.examinedOn && item.medical.injuries.length === 0 && (
                        <p>현재 부상 기록 없음</p>
                      )}
                    </>
                  )}
                  {agreed && (
                    <div className="negotiation-agreed-terms">
                      {(["club", "player"] as const).map((scope) => {
                        const proposal = currentProposal(item, scope);
                        return proposal && proposalAgreed(item, proposal) ? (
                          <div key={scope}>
                            <h4>{scope === "club" ? "합의한 이적 조건" : "합의한 선수 계약"}</h4>
                            <Terms terms={proposal.terms} />
                          </div>
                        ) : null;
                      })}
                    </div>
                  )}
                  {item.status === "open" && isBuyer && agreed && (
                    <div className="negotiation-actions">
                      {item.kind !== "renewal" && !item.medical && (
                        <button disabled={disabled} onClick={() => void act({ kind: "medical" })}>
                          메디컬 요청
                        </button>
                      )}
                      {item.medical?.examinedOn && !medicalAcknowledged && (
                        <button
                          disabled={disabled}
                          onClick={() => void act({ kind: "acknowledge_medical" })}
                        >
                          검사 결과·위험 확인
                        </button>
                      )}
                      {item.medical?.examinedOn && item.medical.injuries.length > 0 && (
                        <button disabled={disabled} onClick={() => void act({ kind: "medical" })}>
                          추가 검사 요청
                        </button>
                      )}
                      {signReady && (
                        <button disabled={disabled} onClick={() => void act({ kind: "sign" })}>
                          최종 서명
                        </button>
                      )}
                    </div>
                  )}
                  {item.signed && (
                    <p>
                      {item.signed.on} 서명 ·{" "}
                      {item.registration === "registered"
                        ? "등록 완료"
                        : item.status === "signed"
                          ? "합류 대기"
                          : "등록 대기"}
                    </p>
                  )}
                  {isBuyer &&
                    item.signed &&
                    item.status === "completed" &&
                    item.registration !== "registered" && (
                      <button disabled={disabled} onClick={() => void act({ kind: "register" })}>
                        등록 신청
                      </button>
                    )}
                  {payments.map((payment) => (
                    <p key={payment.id}>
                      {payment.dueOn} · {money(payment.amount)} ·{" "}
                      {payment.paidOn ? `${payment.paidOn} 지급` : "지급 예정"}
                    </p>
                  ))}
                </section>
              )}
              {renderPending?.({ text: optimisticText, thinking })}
            </div>
            {renderError?.({ error, onRetry: retry, onDismiss: dismiss, busy: disabled })}
            {item.status === "open" &&
              renderComposer?.({
                text,
                channel,
                onText: setText,
                onSend: () => {
                  if (text.trim() && !disabled) void act({ kind: "message", channel, text });
                },
                busy: disabled,
                inputRef,
              })}
          </>
        )}
      </article>
    </section>
  );
}
function Terms({ terms }: { terms: ProposalTerms }) {
  return (
    <dl className="negotiation-terms">
      <dt>{terms.scope === "club" ? "합류 시 이적료" : "주급"}</dt>
      <dd>{money(terms.scope === "club" ? terms.fee : terms.weeklyWage)}</dd>
      {terms.scope === "club" && (
        <>
          <dt>합류일</dt>
          <dd>{terms.since}</dd>
        </>
      )}
      {terms.scope === "player" && (
        <>
          <dt>계약 보너스</dt>
          <dd>{money(terms.signingBonus)}</dd>
          <dt>기간</dt>
          <dd>{duration(terms)}</dd>
        </>
      )}
      {terms.installments.map((p, i) => (
        <span key={i}>
          분할금 {p.date} · {money(p.amount)}
        </span>
      ))}
      {terms.promises.map((p, i) => (
        <span key={i}>약속 · {p}</span>
      ))}
    </dl>
  );
}
