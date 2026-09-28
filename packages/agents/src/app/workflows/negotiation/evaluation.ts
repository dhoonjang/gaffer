import { createGameEvaluator, type GameEvaluator } from "@story-fm/llm";
import {
  type GameState,
  requestNegotiationEvaluation,
  negotiationEvaluationContext,
  negotiationTermsOf,
  applyNegotiationAssessment,
  assessmentText,
  defaultPartyOf,
  dueNegotiationFollowups,
  negotiationVersion,
  resolveMedical,
  playerById,
  partiesOf,
  overLimit,
  acceptDeal,
  negotiationTermsOf as currentTerms,
  pendingVerdicts,
} from "@story-fm/engine";
import { assessNegotiation } from "../../../negotiation/evaluation";
import type { TableSpeaker } from "@story-fm/domain";

export async function evaluateNegotiation(
  state: GameState,
  input: {
    negotiationId: string;
    party?: TableSpeaker;
    exchangeId?: string;
    ending?: boolean;
    said?: string;
  },
  evaluator?: GameEvaluator,
): Promise<{ ok: boolean; message: string }> {
  const n = state.negotiations.find((n) => n.id === input.negotiationId);
  if (!n) return { ok: false, message: "평가할 거래를 찾지 못했습니다" };
  const party = input.party ?? defaultPartyOf(state, n);
  const record = requestNegotiationEvaluation(state, { ...input, party });
  if (!record) return { ok: false, message: "거래의 상대·권한·현재 교환을 확인해야 합니다" };
  if (record.status === "completed") return { ok: true, message: assessmentText(record) };
  const context = negotiationEvaluationContext(state, n, party);
  if (!context) return { ok: false, message: "상대 평가의 사실이 부족합니다" };
  try {
    const result =
      process.env.LLM_MODE === "mock" && !evaluator
        ? {
            position: "review" as const,
            conditions: negotiationTermsOf(n),
            alternatives: [],
            factRefs: ["proposal"],
            followup: null,
          }
        : await assessNegotiation(
            {
              context: JSON.stringify(context),
              party,
              kind: n.kind,
              current: negotiationTermsOf(n),
              factRefs: context.factRefs,
              hasProposal: context.hasProposal,
              ending: input.ending === true,
              medicalAllowed: context.medicalAllowed,
            },
            evaluator ?? createGameEvaluator("negotiation"),
          );
    const applied = applyNegotiationAssessment(state, record.id, result);
    if (!applied.ok) {
      const live = state.negotiationEvaluations.find((e) => e.id === record.id);
      if (live) live.error = applied.message;
    }
    return applied;
  } catch (error) {
    const live = state.negotiationEvaluations.find((e) => e.id === record.id);
    if (live) live.error = (error instanceof Error ? error.message : String(error)).slice(0, 600);
    return {
      ok: false,
      message:
        "협상 평가 처리 대기 — 임의 조건이나 일정은 기록하지 않았습니다. 다시 시도할 수 있습니다",
    };
  }
}
/** Snapshot IDs once: same-day reservations created while processing wait for the next processing unit. */
export async function processNegotiationFollowups(
  state: GameState,
  evaluator?: GameEvaluator,
): Promise<{ events: string[]; pending: boolean }> {
  const events: string[] = [];
  const due = dueNegotiationFollowups(state).map((f) => f.id);
  let pending = false;
  const queued = state.negotiationEvaluations
    .filter((e) => e.status === "pending")
    .map((e) => e.id);
  for (const id of due) {
    const event = state.negotiationFollowups.find((f) => f.id === id)!;
    const n = state.negotiations.find((n) => n.id === event.negotiationId);
    if (!n || !["open", "agreed"].includes(n.status)) {
      event.status = "cancelled";
      continue;
    }
    if (event.version !== negotiationVersion(state, n, event.party)) {
      event.status = "cancelled";
      const reply = await evaluateNegotiation(
        state,
        { negotiationId: n.id, party: event.party, ending: true },
        evaluator,
      );
      events.push(reply.message);
      pending ||= !reply.ok;
      continue;
    }
    if (event.purpose === "medical") {
      const player = playerById(state, n.gamePlayerId);
      if (!player) {
        event.status = "cancelled";
        continue;
      }
      const result = resolveMedical(state, n, player);
      event.status = "completed";
      events.push(`${player.name} 메디컬 ${result.passed ? "완료" : "소견 — 조건 재평가 필요"}`);
      if (!result.passed) {
        const response = await evaluateNegotiation(
          state,
          { negotiationId: n.id, party: event.party, ending: true },
          evaluator,
        );
        events.push(response.message);
        pending ||= !response.ok;
      }
    } else {
      // This scheduled review is a new factual input; do not replay the earlier decision that scheduled it.
      const exchange = state.negotiationExchanges.find((e) => e.id === event.exchangeId);
      if (exchange) exchange.summary = `${event.dueOn} ${event.purpose} 도래`;
      const prior = state.negotiationEvaluations.find((e) => e.id === event.evaluationId);
      if (prior) prior.status = "stale";
      const result = await evaluateNegotiation(
        state,
        { negotiationId: n.id, party: event.party, ending: true },
        evaluator,
      );
      events.push(result.message);
      if (result.ok) {
        const current = state.negotiationFollowups.find((f) => f.id === id)!;
        current.status = "completed";
      } else pending = true;
    }
    pending ||= event.requiresDecision;
  }

  for (const id of queued) {
    const e = state.negotiationEvaluations.find((e) => e.id === id)!;
    const answer = await evaluateNegotiation(
      state,
      {
        negotiationId: e.negotiationId,
        party: e.party,
        exchangeId: e.exchangeId,
        ending: e.ending,
      },
      evaluator,
    );
    events.push(answer.message);
    pending ||= !answer.ok;
  }
  const delegated = await processDelegatedNegotiations(state, evaluator);
  events.push(...delegated.events);
  pending ||= delegated.pending;
  pending ||= pendingVerdicts(state).length > 0;
  return { events, pending };
}

/** Limits grant authority only for named axes. A new promise or role always returns to the manager. */
async function processDelegatedNegotiations(
  state: GameState,
  evaluator?: GameEvaluator,
): Promise<{ events: string[]; pending: boolean }> {
  const ids = state.negotiations
    .filter((n) => (n.status === "open" || n.status === "agreed") && n.mandate != null)
    .map((n) => n.id);
  const events: string[] = [];
  let pending = false;
  for (const id of ids) {
    let n = state.negotiations.find((n) => n.id === id)!;
    const player = playerById(state, n.gamePlayerId);
    if (!player) continue;
    const party =
      partiesOf(state, n).find((p) => (p === "club" ? !n.feeAgreed : !n.personal?.agreedOn)) ??
      defaultPartyOf(state, n);
    const result = await evaluateNegotiation(
      state,
      { negotiationId: id, party, ending: true },
      evaluator,
    );
    if (!result.ok) {
      pending = true;
      events.push(result.message);
      continue;
    }
    n = state.negotiations.find((n) => n.id === id)!;
    const e = [...state.negotiationEvaluations]
      .reverse()
      .find((e) => e.negotiationId === id && e.party === party && e.status === "completed");
    if (!e?.result || !["counter", "agree"].includes(e.result.position)) continue;
    const terms = e.result.conditions;
    const missing = overLimit(state, n, player, terms);
    const old = currentTerms(n);
    const authorizedRole = [...n.rounds].reverse().find((r) => r.by === "us")?.squadStatus;
    const additional =
      terms.squadStatus !== authorizedRole ||
      JSON.stringify(terms.terms) !== JSON.stringify(old.terms);
    if (missing || additional) {
      n.mandate = null;
      events.push(`${player.name}: ${missing ?? "역할·약속·조항에 대한 감독 결정이 필요합니다"}`);
      pending = true;
      continue;
    }
    if (n.medical?.status === "scheduled") continue;
    const applied = acceptDeal(state, id);
    events.push(applied.message);
    pending ||= !applied.ok;
  }
  return { events, pending };
}
