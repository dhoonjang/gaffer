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
import { answerPersonal, pendingOffer, respondOffer } from "./negotiation";
import {
  contactIdentity,
  ensureNegotiationExchange,
  recordExchangeLine,
  tableOf,
  partiesOf,
} from "./table";
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
  return JSON.stringify({
    party,
    rounds: n.rounds,
    personal: n.personal,
    terms: n.terms,
    feeAgreed: n.feeAgreed,
    facts: context
      ? { ...context.facts, history: context.facts.history.filter((l) => l.by === "us") }
      : null,
  });
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
    history:
      tableOf(state, n, party)?.lines.map((l) => ({
        date: l.date,
        by: l.by,
        text: l.text,
        deal: l.negotiationId,
      })) ?? [],
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
    said?: string;
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
  if (input.said?.trim()) {
    const last = tableOf(state, n, input.party)
      ?.lines.filter((l) => l.by === "us" && l.negotiationId === n.id)
      .at(-1);
    if (last?.text !== input.said.trim().slice(0, 600))
      recordExchangeLine(state, exchange.id, "us", input.said);
  }
  const version = negotiationVersion(state, n, input.party);
  const existing = state.negotiationEvaluations.find(
    (e) =>
      e.negotiationId === n.id &&
      e.party === input.party &&
      e.version === version &&
      e.status !== "stale",
  );
  if (existing) {
    existing.ending ||= input.ending === true;
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
  const conditions = !e.hasProposal && e.result.position !== "counter" ? "조건 미정" : describe(c);
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
  if (!context || result.factRefs.some((r) => !context.factRefs.includes(r)))
    return { ok: false, message: "평가의 근거 참조가 실제 사실을 가리켜야 합니다" };
  if (result.position === "agree" && !context.hasProposal)
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
  if (result.position === "agree" && !exact)
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
  stored.status = "completed";
  stored.result = result;
  stored.error = null;
  // The completed version follows this reply so reopening does not reroll its outcome.
  stored.version = negotiationVersion(draft, transaction, e.party);
  recordExchangeLine(draft, e.exchangeId, "ledger", assessmentText(stored));
  const next = result.followup;
  if (
    next?.purpose === "medical" &&
    (transaction.status !== "agreed" ||
      transaction.kind === "renew" ||
      transaction.kind === "release")
  )
    return { ok: false, message: "이적 합의가 있어야 메디컬 일정을 예약할 수 있습니다" };
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
