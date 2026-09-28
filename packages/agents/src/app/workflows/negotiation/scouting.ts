import type { ScoutingInput, ScoutingRequest, ScoutingReport } from "@story-fm/domain";
import {
  type GameState,
  changeScoutingRequest,
  scoutingEvidence,
  applyScoutingPlan,
  captureScoutingEvidence,
  completeScoutingReport,
  failScouting,
  scoutingLookup,
} from "@story-fm/engine";
import { createGameEvaluator, resolveLlmMode, type GameEvaluator } from "@story-fm/llm";
import { evaluateScoutingPlan, evaluateScoutingReport } from "../../../negotiation/scouting";

function planContext(state: GameState, request: ScoutingRequest): string {
  const evidence = scoutingEvidence(state, request);
  const targetTeams = new Set(evidence.map((p) => p.teamId));
  return JSON.stringify({
    today: state.date,
    candidates: evidence.map((p) => ({
      playerId: p.playerId,
      name: p.name,
      team: p.team,
      position: p.position,
      age: p.age,
      sourceCount: p.sources.length,
      matches: p.sources
        .filter((s) => s.id.startsWith("match:"))
        .map((s) => ({ id: s.id, date: s.date })),
    })),
    upcomingMatches: state.matches
      .filter(
        (m) =>
          m.date >= state.date &&
          !m.result &&
          (targetTeams.has(m.homeTeamId) || targetTeams.has(m.awayTeamId)),
      )
      .map((m) => ({ id: m.id, date: m.date, homeTeamId: m.homeTeamId, awayTeamId: m.awayTeamId })),
    workload: state.scoutingRequests
      .filter((r) => r.id !== request.id && ["scheduled", "ready", "failed"].includes(r.status))
      .map((r) => ({ id: r.id, question: r.question, dueOn: r.dueOn })),
    staff: state.personas
      .filter((p) => p.role === "scout" && p.employment?.teamId === state.userTeamId)
      .map((p) => ({ id: p.characterId, name: p.name })),
  });
}

export async function requestScouting(
  state: GameState,
  input: ScoutingInput,
  source: string,
  evaluator?: GameEvaluator,
): Promise<{ ok: boolean; message: string; requestId?: string; reports?: ScoutingReport[] }> {
  const changed = changeScoutingRequest(state, input, source);
  if (!changed.ok) return changed;
  const request = changed.request;
  const revision = request.revision;
  if (request.status === "failed" && input.action !== "retry")
    return {
      ok: false,
      requestId: request.id,
      message:
        "이 의뢰의 평가를 완료하지 못했습니다. 보관된 자료로 명시적으로 다시 시도할 수 있습니다",
    };
  if (["completed", "cancelled", "held"].includes(request.status))
    return {
      ok: true,
      requestId: request.id,
      message: scoutingLookup(state, { requestId: request.id }).message,
    };
  try {
    if (!request.plan) {
      if (!evaluator && resolveLlmMode() === "mock") {
        // Explicit development adapter: no fabricated investigation result or fallback facts.
        applyScoutingPlan(state, request.id, revision, {
          status: "ready",
          days: 0,
          depth: "public_records",
          focus: ["contract"],
          expectations: [],
          evidenceRefs: [],
          limitations: ["limited_access"],
        });
      } else {
        const plan = await evaluateScoutingPlan(
          structuredClone(request),
          planContext(state, request),
          evaluator ?? createGameEvaluator("scouting"),
        );
        applyScoutingPlan(state, request.id, revision, plan);
      }
    }
    captureScoutingEvidence(state);
    const reports = await processScoutingReports(state, evaluator, request.id);
    return {
      ok: request.status !== "failed",
      requestId: request.id,
      message: scoutingLookup(state, { requestId: request.id }).message,
      reports,
    };
  } catch (error) {
    failScouting(
      state,
      request.id,
      revision,
      error instanceof Error ? error.message : String(error),
    );
    return {
      ok: false,
      requestId: request.id,
      message: "조사 평가를 완료하지 못했습니다. 의뢰와 자료는 보관되며 다시 시도할 수 있습니다",
    };
  }
}

export async function processScoutingReports(
  state: GameState,
  evaluator?: GameEvaluator,
  requestId?: string,
): Promise<ScoutingReport[]> {
  const reports: ScoutingReport[] = [];
  for (const request of state.scoutingRequests) {
    if (requestId && request.id !== requestId) continue;
    if (
      !(request.status === "ready" || (requestId && request.status === "failed")) ||
      !request.evidenceOn
    )
      continue;
    const revision = request.revision;
    try {
      const assessment =
        !evaluator && resolveLlmMode() === "mock"
          ? request.evidence.map((p) => ({
              playerId: p.playerId,
              fit: "unknown" as const,
              overall: null,
              potential: null,
              attributes: {},
              evidenceRefs: p.sources.map((s) => s.id),
              strengths: [],
              concerns: ["insufficient_evidence" as const],
            }))
          : await evaluateScoutingReport(
              structuredClone(request),
              evaluator ?? createGameEvaluator("scouting"),
            );
      const report = completeScoutingReport(state, request.id, revision, assessment);
      if (report) reports.push(report);
    } catch (error) {
      failScouting(
        state,
        request.id,
        revision,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return reports;
}
