import { createHash } from "node:crypto";
import { contractOwnerOf } from "./market";
import { agentForPlayer, directorOf } from "../../common/people/persona";
import {
  NegotiationAssessmentSchema,
  normalizeDealTerm,
  dealTermLabel,
  type Negotiation,
  type NegotiationAssessment,
  type NegotiationEvaluation,
  type NegotiationTermsBundle,
  type TableSpeaker,
  type MarketCard,
} from "@story-fm/domain";
import {
  type GameState,
  activeContract,
  playerById,
  openInjury,
  seasonStatOf,
} from "../../common/core/state";
import { addDays } from "../../common/core/dates";
import { observedPlayerFacts } from "../../common/players/observation";
import {
  acceptCounterTerms,
  agreedTermsOf,
  answerPersonal,
  counterpartOf,
  directionField,
  pendingOffer,
  proposePersonal,
  respondOffer,
  standingCounter,
} from "./negotiation";
import { roundTermsOf } from "../views/room";
import { type CommandResult } from "../../common/commands/result";
import { contactIdentity, ensureNegotiationExchange, negotiationChat, partiesOf } from "./table";
import { offeredTermsOf, termKindsOf } from "./terms";

export function negotiationTermsOf(n: Negotiation): NegotiationTermsBundle {
  const offer = pendingOffer(n) ?? n.rounds.at(-1);
  return {
    fee: offer?.fee ?? 0,
    weeklyWage: n.personal?.weeklyWage ?? offer?.weeklyWage ?? 0,
    contractYears: n.personal?.contractYears ?? offer?.contractYears ?? 0,
    ...(offer?.paymentYears ? { paymentYears: offer.paymentYears } : {}),
    ...((n.personal?.squadStatus ?? offer?.squadStatus)
      ? { squadStatus: n.personal?.squadStatus ?? offer?.squadStatus }
      : {}),
    terms: offeredTermsOf(n),
  };
}
/** Signature contains immutable deal versions and relevant changing facts, never a reroll counter. */
export function negotiationVersion(state: GameState, n: Negotiation, party: TableSpeaker): string {
  const context = negotiationEvaluationContext(state, n, party);
  const facts = JSON.stringify({
    party,
    rounds: n.rounds,
    personal: n.personal,
    terms: n.terms,
    feeAgreed: n.feeAgreed,
    facts: context
      ? { ...context.facts, history: context.facts.history.filter((l) => l.by === "user") }
      : null,
  });
  return createHash("sha256").update(facts).digest("hex");
}
export function negotiationEvaluationContext(
  state: GameState,
  n: Negotiation,
  party: TableSpeaker,
) {
  const player = playerById(state, n.gamePlayerId);
  if (!player) return null;
  const owner = contractOwnerOf(state, player);
  if (
    n.kind === "renew" || n.kind === "release" || n.kind === "sell" || n.kind === "loan_out"
      ? owner !== state.userTeamId
      : owner !== n.counterpartTeamId
  )
    return null;
  const identity = contactIdentity(state, n, party);
  if (!identity) return null;
  const contract = activeContract(state, player.id);
  const terms = negotiationTermsOf(n);
  const proposal =
    party === "club"
      ? { fee: terms.fee, paymentYears: terms.paymentYears }
      : {
          weeklyWage: terms.weeklyWage,
          contractYears: terms.contractYears,
          squadStatus: terms.squadStatus,
          terms: terms.terms,
          ...(n.kind === "release" ? { severance: terms.fee } : {}),
        };
  const facts = {
    player: {
      id: player.id,
      name: player.name,
      birthdate: player.birthdate,
      ...observedPlayerFacts(state, player),
      form: player.state.form,
      fitness: player.state.condition,
      matches: seasonStatOf(state, player.id),
      injury: openInjury(state, player.id),
    },
    contract: contract
      ? {
          weeklyWage: contract.weeklyWage,
          since: contract.since,
          until: contract.until,
          squadStatus: contract.squadStatus,
        }
      : null,
    authority: identity,
    persona:
      party === "club"
        ? directorOf(state, n.counterpartTeamId!)
        : (agentForPlayer(state, player.id) ??
          state.personas.find((p) => p.characterId === player.id)),
    registration: state.windows,
    counterparty:
      party === "club"
        ? {
            teamId: n.counterpartTeamId,
            finances: state.finances.find((f) => f.teamId === n.counterpartTeamId),
            squad: state.players
              .filter((p) => p.teamId === n.counterpartTeamId)
              .map((p) => ({ id: p.id, positions: p.positions })),
          }
        : null,
    medical: n.medical ?? null,
    history: negotiationChat(state, n, party).map((turn) => ({
      date: turn.at,
      by: turn.role,
      text: turn.text,
      deal: turn.negotiationId,
    })),
    listing: state.transferList.filter((l) => l.gamePlayerId === player.id),
    recordedInterest: state.interests.filter((i) => i.gamePlayerId === player.id),
    proposal,
    availableTerms: party === "agent" ? termKindsOf(n) : [],
  };
  return {
    today: state.date,
    negotiationId: n.id,
    kind: n.kind,
    party,
    hasProposal:
      n.status === "agreed" ||
      (party === "club"
        ? !!pendingOffer(n)
        : (!!n.personal && !n.personal.counter) ||
          (!!pendingOffer(n) && (n.kind === "release" || terms.contractYears > 0))),
    medicalAllowed:
      n.kind !== "renew" &&
      n.kind !== "release" &&
      (n.status === "agreed" ||
        (party === "agent" && (!!n.feeAgreed || !partiesOf(state, n).includes("club")))),
    facts,
    factRefs: Object.keys(facts),
  };
}
export function requestNegotiationEvaluation(
  state: GameState,
  input: {
    negotiationId: string;
    party: TableSpeaker;
    exchangeId?: string;
    ending?: boolean;
  },
): NegotiationEvaluation | null {
  const n = state.negotiations.find((n) => n.id === input.negotiationId);
  if (!n || !["open", "agreed"].includes(n.status)) return null;
  if (!negotiationEvaluationContext(state, n, input.party)) {
    n.status = "expired";
    return null;
  }
  const exchange = input.exchangeId
    ? state.negotiationExchanges.find(
        (e) => e.id === input.exchangeId && e.negotiationId === n.id && e.party === input.party,
      )
    : ensureNegotiationExchange(state, n, input.party);
  if (!exchange) return null;
  const version = negotiationVersion(state, n, input.party);
  const existing = state.negotiationEvaluations.find(
    (e) =>
      e.negotiationId === n.id &&
      e.party === input.party &&
      e.version === version &&
      e.ending === (input.ending === true) &&
      e.status !== "stale",
  );
  if (existing) {
    exchange.evaluationId = existing.id;
    return existing;
  }
  const evaluation: NegotiationEvaluation = {
    kind: n.kind,
    id: `evaluation-${state.negotiationEvaluations.length + 1}`,
    negotiationId: n.id,
    exchangeId: exchange.id,
    party: input.party,
    version,
    requestedOn: state.date,
    hasProposal: negotiationEvaluationContext(state, n, input.party)!.hasProposal,
    status: "pending",
    ending: input.ending === true,
    result: null,
    error: null,
  };
  state.negotiationEvaluations.push(evaluation);
  exchange.evaluationId = evaluation.id;
  return evaluation;
}
/** Closing an unchanged exchange plans its next contact without rerolling the reply. */
export function settledNegotiationAssessment(state: GameState, evaluation: NegotiationEvaluation) {
  return evaluation.ending
    ? (state.negotiationEvaluations.find(
        (prior) =>
          prior.id !== evaluation.id &&
          !prior.ending &&
          prior.status === "completed" &&
          prior.negotiationId === evaluation.negotiationId &&
          prior.party === evaluation.party &&
          prior.version === evaluation.version,
      )?.result ?? undefined)
    : undefined;
}
export function assessmentText(e: NegotiationEvaluation): string {
  if (!e.result) return "협상 평가 처리 대기 — 조건과 후속 일정은 아직 확정되지 않았습니다";
  const c = e.result.conditions;
  const describe = (c: NegotiationTermsBundle) =>
    e.party === "club"
      ? `이적료 £${c.fee}${c.paymentYears ? ` · ${c.paymentYears}년 분할` : ""}`
      : e.kind === "release"
        ? `정산금 £${c.fee}`
        : `주급 £${c.weeklyWage} · ${c.contractYears}년${c.squadStatus ? ` · ${c.squadStatus}` : ""}${c.terms.length ? ` · 조건 ${c.terms.map(dealTermLabel).join(" / ")}` : ""}`;
  const position = { agree: "동의", counter: "조건 제안", review: "검토 중", end: "협의 종료" }[
    e.result.position
  ];
  const conditions =
    !e.hasProposal && e.result.position !== "counter" && e.result.position !== "agree"
      ? "조건 미정"
      : describe(c);
  return `${position} · ${conditions}${e.result.alternatives.length ? ` · 대안 ${e.result.alternatives.map(describe).join(" 또는 ")}` : ""} · 근거 ${e.result.factRefs.join(", ")}${e.result.followup ? ` · ${e.result.followup.days}일 뒤 ${e.result.followup.purpose}` : " · 예정된 후속 일 없음"}`;
}
/** The entire assessment, reply and reservation commit together or remain retryable. */
export function applyNegotiationAssessment(
  state: GameState,
  evaluationId: string,
  raw: unknown,
): { ok: boolean; message: string } {
  const parsed = NegotiationAssessmentSchema.safeParse(raw);
  const e = state.negotiationEvaluations.find((e) => e.id === evaluationId);
  if (!e) return { ok: false, message: "평가 요청을 찾지 못했습니다" };
  if (e.status === "completed") return { ok: true, message: assessmentText(e) };
  const n = state.negotiations.find((n) => n.id === e.negotiationId);
  if (!parsed.success || !n || !["open", "agreed"].includes(n.status))
    return { ok: false, message: "평가 결과와 거래 상태를 다시 확인해야 합니다" };
  if (e.version !== negotiationVersion(state, n, e.party)) {
    e.status = "stale";
    return { ok: false, message: "조건이나 사실이 바뀌어 재평가해야 합니다" };
  }
  const context = negotiationEvaluationContext(state, n, e.party);
  const result = parsed.data;
  const settled = settledNegotiationAssessment(state, e);
  if (settled && JSON.stringify({ ...result, followup: null }) !== JSON.stringify(settled))
    return { ok: false, message: "새 사실 없이 종료 평가로 상대의 답을 바꿀 수 없습니다" };
  if (!e.ending && result.followup)
    return { ok: false, message: "후속 일정은 교환을 마칠 때만 예약할 수 있습니다" };
  if (!context || result.factRefs.some((r) => !context.factRefs.includes(r)))
    return { ok: false, message: "평가의 근거 참조가 실제 사실을 가리켜야 합니다" };
  if (!settled && result.position === "agree" && !context.hasProposal)
    return { ok: false, message: "발송된 조건 없이 동의할 수 없습니다" };
  const current = negotiationTermsOf(n);
  const exact =
    e.party === "club"
      ? result.conditions.fee === current.fee &&
        (result.conditions.paymentYears ?? 1) === (current.paymentYears ?? 1)
      : result.conditions.weeklyWage === current.weeklyWage &&
        result.conditions.contractYears === current.contractYears &&
        result.conditions.squadStatus === current.squadStatus &&
        JSON.stringify(result.conditions.terms) === JSON.stringify(current.terms) &&
        (n.kind !== "release" ||
          (result.conditions.fee === current.fee &&
            (result.conditions.paymentYears ?? 1) === (current.paymentYears ?? 1)));
  if (
    e.party === "club" &&
    (result.conditions.weeklyWage !== current.weeklyWage ||
      result.conditions.contractYears !== current.contractYears ||
      result.conditions.squadStatus !== current.squadStatus ||
      JSON.stringify(result.conditions.terms) !== JSON.stringify(current.terms))
  )
    return { ok: false, message: "구단은 선수 개인 조건을 변경할 수 없습니다" };
  if (
    e.party === "agent" &&
    n.kind !== "release" &&
    (result.conditions.fee !== current.fee ||
      result.conditions.paymentYears !== current.paymentYears)
  )
    return { ok: false, message: "선수 측은 구단의 이적료 조건을 변경할 수 없습니다" };
  if (!settled && result.position === "agree" && !exact)
    return { ok: false, message: "동의는 제안한 조건의 정확한 버전이어야 합니다" };
  for (const bundle of [result.conditions, ...result.alternatives]) {
    if (
      e.party === "agent" &&
      ((n.kind !== "release" && bundle.fee !== current.fee) ||
        (bundle.paymentYears ?? 1) !== (current.paymentYears ?? 1))
    )
      return {
        ok: false,
        message: "선수 측의 대안은 구단의 이적료·분할 조건을 변경할 수 없습니다",
      };
    if (bundle.terms.some((t) => normalizeDealTerm(t) === null || !termKindsOf(n).includes(t.kind)))
      return { ok: false, message: "조건 묶음의 약속·조항 값을 확인해야 합니다" };
    if (
      e.party === "club" &&
      (bundle.weeklyWage !== current.weeklyWage ||
        bundle.contractYears !== current.contractYears ||
        bundle.squadStatus !== current.squadStatus ||
        JSON.stringify(bundle.terms) !== JSON.stringify(current.terms))
    )
      return { ok: false, message: "구단의 대안은 이적료·분할만 변경할 수 있습니다" };
  }
  const draft = structuredClone(state);
  const transaction = draft.negotiations.find((t) => t.id === n.id)!;
  const stored = draft.negotiationEvaluations.find((t) => t.id === e.id)!;
  if (!settled) {
    if (result.position === "agree" && transaction.medical?.status === "flagged")
      transaction.medical.overridden = true;
    if (result.position === "counter" && e.party === "agent") {
      const allowed = termKindsOf(transaction);
      for (const term of result.conditions.terms) {
        if (!allowed.includes(term.kind))
          return { ok: false, message: "거래 갈래에 맞지 않는 계약 조건입니다" };
        const existing = transaction.terms.find(
          (t) => t.term.kind === term.kind && JSON.stringify(t.term) === JSON.stringify(term),
        );
        if (!existing) transaction.terms.push({ term, by: "them", on: state.date });
      }
    }
    if (transaction.status === "agreed" && result.position === "counter") {
      transaction.status = "open";
      if (e.party === "club") delete transaction.feeAgreed;
      if (e.party === "agent" && transaction.personal) delete transaction.personal.agreedOn;
      const accepted = [...transaction.rounds]
        .reverse()
        .find((r) => r.by === "us" && r.verdict === "accept");
      if (accepted) accepted.verdict = null;
    }
    const answer =
      transaction.status === "agreed" && result.position === "agree"
        ? { ok: true, message: "현재 조건 유지" }
        : applyReply(draft, transaction, e.party, result);
    if (!answer.ok) return answer;
    if (result.position === "counter") {
      const last = transaction.rounds.at(-1);
      if (last?.by === "them") last.terms = structuredClone(result.conditions.terms);
    }
  }
  stored.status = "completed";
  stored.result = result;
  stored.error = null;
  // The completed version follows this reply so reopening does not reroll its outcome.
  stored.version = negotiationVersion(draft, transaction, e.party);
  const next = result.followup;
  if (
    next?.purpose === "medical" &&
    (transaction.status !== "agreed" ||
      transaction.kind === "renew" ||
      transaction.kind === "release")
  )
    return { ok: false, message: "이적 합의가 있어야 메디컬 일정을 예약할 수 있습니다" };
  if (e.ending) {
    for (const event of draft.negotiationFollowups) {
      if (
        event.negotiationId === n.id &&
        event.party === e.party &&
        event.status === "pending" &&
        (event.purpose !== "medical" || next?.purpose === "medical")
      )
        event.status = "cancelled";
    }
  }
  if (next) {
    const id = `followup-${e.id}`;
    if (!draft.negotiationFollowups.some((f) => f.id === id))
      draft.negotiationFollowups.push({
        id,
        negotiationId: n.id,
        exchangeId: e.exchangeId,
        evaluationId: e.id,
        party: e.party,
        version: stored.version,
        dueOn: addDays(state.date, next.days),
        createdOn: state.date,
        purpose: next.purpose,
        requiresDecision: next.requiresDecision,
        status: "pending",
      });
    if (next.purpose === "medical")
      transaction.medical = { onDate: addDays(state.date, next.days), status: "scheduled" };
  }
  stored.version = negotiationVersion(draft, transaction, e.party);
  const scheduled = draft.negotiationFollowups.find((f) => f.evaluationId === stored.id);
  if (scheduled) scheduled.version = stored.version;
  Object.assign(state, draft);
  return { ok: true, message: assessmentText(stored) };
}
/**
 * **대화에서 닿은 합의를 장부에 적는다** — 협상 GM의 `accept_negotiation` (transfer.md §7).
 * `manager`는 감독이 상대의 최신 조건을, `counterparty`는 상대가 우리 최신 조건을 받아들인
 * 것이다. 받아들일 조건이 우리 오퍼로 서 있지 않으면 그 조건으로 다시 넣고 그 자리에서
 * 동의를 적는다. 서명은 하지 않는다 — 합의가 서면 계약서 카드가 서고 확정은 감독의 서명이 한다.
 */
export function acceptTableTerms(
  state: GameState,
  input: { negotiationId: string; party: TableSpeaker; side: "manager" | "counterparty" },
): CommandResult {
  const n = state.negotiations.find((n) => n.id === input.negotiationId);
  if (!n) return { ok: false, message: "협상을 찾지 못했습니다" };
  if (n.status === "agreed") return agreedContract(state, n, "이미 합의된 조건입니다");
  if (n.status !== "open") return { ok: false, message: `이미 끝난 협상입니다 (${n.status})` };
  const personalRoute =
    input.party === "agent" && !isDirectPlayerDeal(n) && partiesOf(state, n).includes("club");
  const staged = personalRoute
    ? stagePersonal(state, n, input.side)
    : stageRound(state, n, input.side);
  if (!staged.ok) return staged;
  const answer = applyReply(state, n, input.party, {
    position: "agree",
    conditions: negotiationTermsOf(n),
    alternatives: [],
    factRefs: ["proposal"],
    followup: null,
  });
  if (!answer.ok) return answer;
  // 답이 상태를 옮겼다 — 위에서 좁힌 `open`은 더 이상 사실이 아니다
  const status = n.status as Negotiation["status"];
  return status === "agreed"
    ? agreedContract(state, n, "합의했습니다")
    : { ok: true, message: answer.message };
}
/** 받아들일 조건을 우리 오퍼 자리에 세운다 — 이미 서 있으면 그대로 둔다 */
function stageRound(
  state: GameState,
  n: Negotiation,
  side: "manager" | "counterparty",
): { ok: boolean; message: string } {
  if (side === "manager") {
    const counter = standingCounter(n);
    if (!counter) return { ok: false, message: "받아들일 상대의 조정안이 없습니다" };
    return acceptCounterTerms(state, n, counter);
  }
  if (pendingOffer(n)) return { ok: true, message: "우리 오퍼가 서 있습니다" };
  const ours = [...n.rounds].reverse().find((r) => r.by === "us");
  if (!ours) return { ok: false, message: "상대가 받아들일 우리 제안이 없습니다" };
  return acceptCounterTerms(state, n, ours);
}
function stagePersonal(
  state: GameState,
  n: Negotiation,
  side: "manager" | "counterparty",
): { ok: boolean; message: string } {
  const personal = n.personal;
  if (side === "manager") {
    const counter = personal?.counter;
    if (!counter) return { ok: false, message: "받아들일 선수 측의 개인 조건이 없습니다" };
    const result = proposePersonal(state, {
      negotiationId: n.id,
      weeklyWage: counter.weeklyWage,
      years: counter.contractYears,
      squadStatus: counter.squadStatus,
      terms: counter.terms,
    });
    if (result.ok && counter.terms)
      n.terms = counter.terms.map((term) => ({ term, by: "us", on: state.date }));
    return result;
  }
  if (!personal?.counter) return { ok: true, message: "우리 개인 조건이 서 있습니다" };
  return proposePersonal(state, {
    negotiationId: n.id,
    weeklyWage: personal.weeklyWage,
    years: personal.contractYears,
    squadStatus: personal.squadStatus,
  });
}
/** 합의한 조건의 계약서 카드 — 서명을 기다린다 */
function agreedContract(state: GameState, n: Negotiation, head: string): CommandResult {
  const player = playerById(state, n.gamePlayerId);
  const agreed = [...n.rounds].reverse().find((r) => r.verdict === "accept");
  if (!player || !agreed) return { ok: false, message: "합의된 조건을 찾지 못했습니다" };
  const clauses = agreedTermsOf(n, agreed).map(dealTermLabel);
  const card: MarketCard = {
    kind: "contract",
    negotiationId: n.id,
    playerId: player.id,
    playerName: player.name,
    counterpart: counterpartOf(n, player),
    ...(roundTermsOf(n, agreed) ? { terms: roundTermsOf(n, agreed)! } : {}),
    ...(agreed.squadStatus ? { squadStatus: agreed.squadStatus } : {}),
    ...(clauses.length > 0 ? { clauses } : {}),
    ...directionField(n.kind),
    ...(n.kind === "loan" || n.kind === "loan_out" ? { loan: true } : {}),
    ...(n.precontract ? { precontract: true } : {}),
  };
  return {
    ok: true,
    payload: card,
    message: `${head} — ${player.name} 계약서가 서명을 기다립니다. 서명은 감독이 합니다`,
  };
}
function applyReply(
  state: GameState,
  n: Negotiation,
  party: TableSpeaker,
  result: NegotiationAssessment,
): { ok: boolean; message: string } {
  if (result.position === "review") return { ok: true, message: "검토 중" };
  if (result.position === "end") {
    n.status = "rejected";
    return { ok: true, message: "이번 협의를 중단했습니다" };
  }
  const verdict = result.position === "agree" ? "accept" : "counter";
  const c = result.conditions;
  if (party === "agent" && !isDirectPlayerDeal(n) && partiesOf(state, n).includes("club")) {
    if (!n.personal) {
      const offer = pendingOffer(n) ?? n.rounds.at(-1);
      if (!offer) {
        if (result.position === "counter")
          n.personal = {
            weeklyWage: c.weeklyWage,
            contractYears: c.contractYears,
            proposedOn: state.date,
            respondsOn: state.date,
            counter: {
              weeklyWage: c.weeklyWage,
              contractYears: c.contractYears,
              squadStatus: c.squadStatus,
              terms: c.terms,
              on: state.date,
            },
          };
        return { ok: true, message: "개인 조건 문의 결과를 기록했습니다" };
      }
      n.personal = {
        weeklyWage: offer.weeklyWage,
        contractYears: offer.contractYears,
        squadStatus: offer.squadStatus,
        proposedOn: state.date,
        respondsOn: state.date,
      };
    }
    n.personal.respondsOn = state.date;
    return answerPersonal(state, {
      negotiationId: n.id,
      verdict,
      weeklyWage: c.weeklyWage,
      contractYears: c.contractYears,
      squadStatus: c.squadStatus,
      terms: c.terms,
    });
  }
  const offer = pendingOffer(n);
  if (!offer) {
    if (result.position === "counter")
      n.rounds.push({
        date: state.date,
        by: "them",
        fee: c.fee,
        weeklyWage: c.weeklyWage,
        contractYears: c.contractYears,
        squadStatus: c.squadStatus,
        paymentYears: c.paymentYears,
        verdict: "counter",
        respondsOn: null,
        terms: c.terms,
      });
    return { ok: true, message: "조건 문의 결과를 기록했습니다" };
  }
  offer.respondsOn = state.date;
  return respondOffer(state, {
    negotiationId: n.id,
    verdict,
    fee: c.fee,
    weeklyWage: c.weeklyWage,
    contractYears: c.contractYears,
    paymentYears: c.paymentYears,
    squadStatus: c.squadStatus,
    ...(party === "club" ? { feeOnly: true } : {}),
  });
}
function isDirectPlayerDeal(n: Negotiation) {
  return n.kind === "renew" || n.kind === "release" || n.precontract;
}
export function dueNegotiationFollowups(state: GameState) {
  return state.negotiationFollowups
    .filter((f) => f.status === "pending" && f.dueOn <= state.date)
    .sort((a, b) => a.dueOn.localeCompare(b.dueOn) || a.id.localeCompare(b.id));
}
