import {
  ScoutingInputSchema,
  ScoutingPlanSchema,
  ScoutingReportSchema,
  ScoutingAssessmentSchema,
  POSITION_CODES,
  ageOf,
  naturalPositionOf,
  ATTRIBUTE_AXES,
  type ScoutingInput,
  type ScoutingRequest,
  type ScoutingPlan,
  type ScoutingEvidence,
  type ScoutingAssessment,
  type ScoutingReport,
} from "@story-fm/domain";
import {
  type GameState,
  playerById,
  teamNameIn,
  activeContract,
  isOurPlayer,
} from "../../common/core/state";
import { pickAnyPlayer } from "../../common/core/player-ref";
import { addDays } from "../../common/core/dates";
import { observedMarketValue } from "../market/market";
import { inPlayerPool, playerPoolOf, resolveCompetition } from "../players/player-pool";

export function changeScoutingRequest(
  state: GameState,
  raw: ScoutingInput,
  source: string,
): { ok: true; request: ScoutingRequest; message: string } | { ok: false; message: string } {
  const parsed = ScoutingInputSchema.safeParse(raw);
  if (!parsed.success || !source.trim())
    return { ok: false, message: "조사 의뢰와 원문을 확인해 주세요" };
  const input = parsed.data;
  const existing = input.requestId
    ? state.scoutingRequests.find((r) => r.id === input.requestId)
    : undefined;
  if (input.action !== "request" && !existing)
    return { ok: false, message: "조사 의뢰를 찾을 수 없습니다" };
  if (input.action === "cancel" && existing) {
    if (existing.status !== "completed" && existing.status !== "cancelled") {
      existing.revision += 1;
      existing.status = "cancelled";
      existing.error = null;
    }
    return {
      ok: true,
      request: existing,
      message: "조사 의뢰를 종료했습니다. 기존 보고서는 보관됩니다",
    };
  }
  if (input.action === "retry" && existing) {
    return { ok: true, request: existing, message: "같은 조사 기록에서 다시 시도합니다" };
  }
  if (input.action === "revise" && existing && ["completed", "cancelled"].includes(existing.status))
    return { ok: false, message: "종료된 조사는 보관됩니다. 후속 조사를 새로 의뢰해 주세요" };
  const resolved = resolveCompetition(input.competition);
  if (!resolved.ok) return resolved;
  const prior = input.action === "revise" ? existing : undefined;
  const scope = {
    playerIds: input.playerIds ?? prior?.scope.playerIds ?? [],
    competitionId:
      input.competition === undefined
        ? (prior?.scope.competitionId ?? null)
        : resolved.competitionId,
    position: input.position?.toUpperCase() ?? prior?.scope.position ?? null,
    minAge: input.minAge ?? prior?.scope.minAge ?? null,
    maxAge: input.maxAge ?? prior?.scope.maxAge ?? null,
    maxValue: input.maxValue ?? prior?.scope.maxValue ?? null,
  };
  const ids: string[] = [];
  for (const ref of scope.playerIds) {
    const selected = pickAnyPlayer(state, ref);
    if (!selected.ok) return selected;
    ids.push(selected.player.id);
  }
  scope.playerIds = ids;
  const question = input.question ?? prior?.question;
  const deadline = input.deadline ?? prior?.deadline ?? null;
  const previousReportId = input.previousReportId ?? prior?.previousReportId ?? null;
  if (!question?.trim()) return { ok: false, message: "조사할 내용을 알려 주세요" };
  if (scope.position && !POSITION_CODES.includes(scope.position))
    return { ok: false, message: "존재하지 않는 포지션입니다" };
  if (
    new Set(scope.playerIds).size !== scope.playerIds.length ||
    scope.playerIds.some((id) => !playerById(state, id))
  )
    return { ok: false, message: "조사 대상 선수를 확인해 주세요" };
  if (scope.minAge !== null && scope.maxAge !== null && scope.minAge > scope.maxAge)
    return { ok: false, message: "나이 하한이 상한보다 큽니다" };
  if (deadline && deadline < state.date)
    return { ok: false, message: "지난 날짜를 조사 기한으로 정할 수 없습니다" };
  if (previousReportId && !state.scoutReports.some((r) => r.id === previousReportId))
    return { ok: false, message: "이전 보고서를 찾을 수 없습니다" };
  const twin =
    !prior &&
    state.scoutingRequests.find(
      (r) =>
        r.requestedOn === state.date &&
        r.source === source &&
        r.question === question &&
        JSON.stringify(r.scope) === JSON.stringify(scope) &&
        r.deadline === deadline &&
        r.previousReportId === previousReportId &&
        r.status !== "cancelled",
    );
  if (twin) return { ok: true, request: twin, message: "이미 접수한 조사 의뢰입니다" };
  const request: ScoutingRequest = {
    id: prior?.id ?? `scouting-${state.id}-${state.scoutingRequests.length}`,
    revision: (prior?.revision ?? 0) + 1,
    requestedOn: state.date,
    source,
    question,
    scope,
    deadline,
    previousReportId,
    plan: null,
    dueOn: null,
    status: "planning",
    evidenceOn: null,
    evidence: [],
    reportId: null,
    error: null,
  };
  if (prior) Object.assign(prior, request);
  else state.scoutingRequests.push(request);
  return { ok: true, request: prior ?? request, message: "조사 의뢰를 접수했습니다" };
}

/** The only inputs to Jev are public records, actual observations and past reports. */
export function scoutingEvidence(state: GameState, request: ScoutingRequest): ScoutingEvidence[] {
  const scope = request.scope;
  const pool = playerPoolOf(state, {
    competitionId: scope.competitionId,
    ...(scope.position ? { position: scope.position } : {}),
    ...(scope.minAge === null ? {} : { minAge: scope.minAge }),
    ...(scope.maxAge === null ? {} : { maxAge: scope.maxAge }),
  });
  const players = state.players.filter(
    (p) =>
      (scope.playerIds.length ? scope.playerIds.includes(p.id) : !isOurPlayer(state, p)) &&
      inPlayerPool(state, p, pool),
  );
  return players
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((p): ScoutingEvidence => {
      const contract = activeContract(state, p.id);
      const sources: ScoutingEvidence["sources"] = [
        {
          id: `profile:${p.id}:${state.date}`,
          date: state.date,
          text: `${p.name} · ${teamNameIn(state, p.teamId)} · ${ageOf(p.birthdate, state.date)}세 · ${naturalPositionOf(p).position}`,
        },
      ];
      for (const m of state.matches) {
        if (m.date > state.date || !m.result) continue;
        const r = m.result;
        if (!r.homeLineup.includes(p.id) && !r.awayLineup.includes(p.id)) continue;
        const rating = r.ratings?.[p.id];
        const goals = r.scorers.filter((id) => id.endsWith(`:${p.id}`)).length;
        const assists = r.assists.filter((id) => id.endsWith(`:${p.id}`)).length;
        sources.push({
          id: `match:${m.id}:${p.id}`,
          date: m.date,
          text: `${m.date} ${teamNameIn(state, m.homeTeamId)} ${r.homeGoals}-${r.awayGoals} ${teamNameIn(state, m.awayTeamId)} 출전 · ${goals}골 ${assists}도움${rating === undefined ? "" : ` · 평점 ${rating}`}`,
        });
      }
      for (const stat of state.seasonStats.filter((v) => v.gamePlayerId === p.id && v.apps > 0)) {
        sources.push({
          id: `season:${stat.season}:${stat.teamId}:${stat.competitionId}:${p.id}`,
          date: state.date,
          text: `시즌 ${stat.season} · ${stat.apps}경기 ${stat.goals}골 ${stat.assists}도움 · 평점 합 ${stat.ratingSum}`,
        });
      }
      for (const i of state.injuries.filter((i) => i.gamePlayerId === p.id)) {
        if (i.occurredOn > state.date) continue;
        sources.push({
          id: `injury:${i.id}`,
          date: i.occurredOn,
          text: `${i.bodyPart} 부상 · 복귀 예정 ${i.expectedReturn}`,
        });
      }
      for (const transfer of state.transfers) {
        if (
          transfer.gamePlayerId !== p.id ||
          transfer.date > state.date ||
          transfer.type !== "transfer"
        )
          continue;
        sources.push({
          id: `transfer:${transfer.id}`,
          date: transfer.date,
          text: `${transfer.fromTeamId ? teamNameIn(state, transfer.fromTeamId) : "무소속"} → ${transfer.toTeamId ? teamNameIn(state, transfer.toTeamId) : "무소속"} · 기록 이적료 £${transfer.fee}. 현재 요구 가격이 아님`,
        });
      }
      for (const report of state.scoutReports) {
        const old = report.candidates.find((c) => c.evidence.playerId === p.id);
        if (!old || report.completedOn > state.date) continue;
        sources.push({
          id: `report:${report.id}:${p.id}`,
          date: report.completedOn,
          text: JSON.stringify({ question: report.question, assessment: old.assessment }),
        });
      }
      return {
        playerId: p.id,
        name: p.name,
        teamId: p.teamId,
        team: teamNameIn(state, p.teamId),
        age: ageOf(p.birthdate, state.date),
        position: naturalPositionOf(p).position,
        positions: p.positions.map((v) => v.position),
        contractUntil: contract?.until ?? null,
        weeklyWage: contract?.weeklyWage ?? null,
        listed: state.transferList.some((l) => l.gamePlayerId === p.id),
        marketEstimate: observedMarketValue(state, p),
        sources,
      };
    });
}

export function applyScoutingPlan(
  state: GameState,
  id: string,
  revision: number,
  raw: ScoutingPlan,
): boolean {
  const request = state.scoutingRequests.find((r) => r.id === id);
  if (
    !request ||
    request.revision !== revision ||
    !["planning", "failed"].includes(request.status) ||
    request.evidenceOn
  )
    return false;
  const plan = ScoutingPlanSchema.parse(raw);
  const dueOn = addDays(state.date, plan.days);
  if (dueOn < state.date) throw new Error("Invalid scouting date");
  if (
    plan.expectations.some((entry) => !plan.focus.includes(entry.topic)) ||
    new Set(plan.expectations.map((entry) => entry.topic)).size !== plan.expectations.length
  )
    throw new Error("Scouting precision must refer to distinct planned topics");
  if (request.deadline && plan.status === "ready" && dueOn > request.deadline)
    plan.status = "needs_revision";
  request.plan = plan;
  request.dueOn = plan.status === "ready" ? dueOn : null;
  request.status = plan.status === "ready" ? "scheduled" : "held";
  request.error = null;
  return true;
}

/** Pure date boundary: freeze evidence now; the application runs the evaluator later. */
export function captureScoutingEvidence(state: GameState): void {
  for (const request of state.scoutingRequests) {
    if (request.status !== "scheduled" || !request.dueOn || request.dueOn > state.date) continue;
    request.evidence = scoutingEvidence(state, request);
    request.evidenceOn = state.date;
    request.status = "ready";
  }
}

export function completeScoutingReport(
  state: GameState,
  id: string,
  revision: number,
  raw: ScoutingAssessment[],
): ScoutingReport | null {
  const request = state.scoutingRequests.find((r) => r.id === id);
  if (
    !request ||
    request.revision !== revision ||
    !["ready", "failed"].includes(request.status) ||
    !request.evidenceOn ||
    !request.plan
  )
    return null;
  const assessments = raw.map((a) => ScoutingAssessmentSchema.parse(a));
  if (
    assessments.length !== request.evidence.length ||
    new Set(assessments.map((a) => a.playerId)).size !== assessments.length
  )
    throw new Error("Scouting must account for each investigated player exactly once");
  const candidates = request.evidence.map((evidence) => {
    const assessment = assessments.find((a) => a.playerId === evidence.playerId);
    if (
      !assessment ||
      assessment.evidenceRefs.some((id) => !evidence.sources.some((s) => s.id === id))
    )
      throw new Error("Unverified scouting evidence");
    if (
      Object.keys(assessment.attributes).some(
        (axis) => !(ATTRIBUTE_AXES as readonly string[]).includes(axis),
      )
    )
      throw new Error("Unknown observed attribute");
    if (
      (assessment.overall ||
        assessment.potential ||
        Object.keys(assessment.attributes).length > 0) &&
      !assessment.evidenceRefs.some(
        (id) => id.startsWith("match:") || id.startsWith("report:") || id.startsWith("season:"),
      )
    )
      throw new Error("Ability assessment without observation");
    if (
      (assessment.fit === "recommended" || assessment.strengths.length > 0) &&
      assessment.evidenceRefs.length === 0
    )
      throw new Error("Recommendation without evidence");
    return { evidence, assessment };
  });
  const report = ScoutingReportSchema.parse({
    id: `report-${id}-${revision}`,
    requestId: id,
    revision,
    requestedOn: request.requestedOn,
    completedOn: state.date,
    evidenceOn: request.evidenceOn,
    question: request.question,
    plan: request.plan,
    candidates,
  });
  if (state.scoutReports.some((r) => r.id === report.id)) return null;
  state.scoutReports.push(structuredClone(report));
  request.reportId = report.id;
  request.status = "completed";
  request.error = null;
  request.evidence = [];
  if (!state.pendingReportCards.includes(report.id)) state.pendingReportCards.push(report.id);
  return report;
}

export function failScouting(state: GameState, id: string, revision: number, error: string): void {
  const request = state.scoutingRequests.find((r) => r.id === id);
  if (
    !request ||
    request.revision !== revision ||
    ["completed", "cancelled"].includes(request.status)
  )
    return;
  request.status = "failed";
  request.error = error;
}
