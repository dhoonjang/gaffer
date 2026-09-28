import {
  SCOUTING_DEPTH_LABELS,
  SCOUTING_FIT_LABELS,
  SCOUTING_TOPIC_LABELS,
  type ScoutingReport,
} from "@story-fm/domain";
import type { GameState } from "../../common/core/state";

export function scoutingReportsFor(state: GameState, playerId: string): ScoutingReport[] {
  return state.scoutReports
    .filter((r) => r.candidates.some((c) => c.evidence.playerId === playerId))
    .map((r) => ({
      ...r,
      candidates: r.candidates.filter((c) => c.evidence.playerId === playerId),
    }));
}

export function scoutReportCard(state: GameState, id: string): ScoutingReport | null {
  return (
    state.scoutReports.find((r) => r.id === id) ??
    [...state.scoutReports]
      .reverse()
      .find((r) => r.candidates.some((c) => c.evidence.playerId === id)) ??
    null
  );
}

export function scoutReportLine(state: GameState, id: string): string | null {
  const report = scoutReportCard(state, id);
  return report ? scoutingReportLine(report) : null;
}

export function scoutingReportLine(report: ScoutingReport): string {
  return [
    `${report.id} · ${report.question} · 작성 ${report.completedOn} · 관측 기준 ${report.evidenceOn}`,
    `계획: ${SCOUTING_DEPTH_LABELS[report.plan.depth]} · ${report.plan.focus.map((v) => SCOUTING_TOPIC_LABELS[v]).join("·")}`,
    ...report.candidates.map(({ evidence: e, assessment: a }) =>
      [
        `${e.name} (${e.team}) · ${e.age}세 ${e.position} · ${SCOUTING_FIT_LABELS[a.fit]}`,
        a.overall ? `종합 추정 ${a.overall.low}~${a.overall.high}` : "종합 판단 보류",
        a.potential
          ? `잠재력 추정 ${a.potential.low}~${a.potential.high}`
          : "성장 가능성 판단 보류",
        `장점: ${a.strengths.map((v) => SCOUTING_TOPIC_LABELS[v]).join("·") || "미확인"}`,
        `제약: ${a.concerns.map((v) => SCOUTING_TOPIC_LABELS[v]).join("·") || "추가 확인 필요"}`,
        ...e.sources
          .filter((s) => a.evidenceRefs.includes(s.id))
          .map((s) => `${s.id} (${s.date}): ${s.text}`),
      ].join(" · "),
    ),
    ...(report.candidates.length ? [] : ["이번 조사에서 보고할 후보를 찾지 못했습니다"]),
  ].join("\n");
}

export function scoutingLookup(
  state: GameState,
  input: { requestId?: string; reportId?: string; playerId?: string } = {},
) {
  const reports = state.scoutReports.filter(
    (r) =>
      (!input.requestId || r.requestId === input.requestId) &&
      (!input.reportId || r.id === input.reportId) &&
      (!input.playerId || r.candidates.some((c) => c.evidence.playerId === input.playerId)),
  );
  const requests = state.scoutingRequests.filter(
    (r) =>
      (!input.requestId || r.id === input.requestId) &&
      (!input.reportId || r.reportId === input.reportId) &&
      (!input.playerId || r.scope.playerIds.includes(input.playerId)),
  );
  const message = [
    ...requests.map(
      (r) =>
        `${r.id} · ${r.question} · ${r.status}${r.dueOn ? ` · 보고 예정 ${r.dueOn}` : ""}${r.plan ? ` · ${SCOUTING_DEPTH_LABELS[r.plan.depth]} · ${r.plan.limitations.map((v) => SCOUTING_TOPIC_LABELS[v]).join("·")}` : ""}${r.error ? " · 평가 오류, 재시도 필요" : ""}`,
    ),
    ...reports.map(scoutingReportLine),
  ].join("\n");
  return {
    ok: true,
    message: message || "해당 조사 기록이 없습니다",
    requests: structuredClone(requests),
    reports: structuredClone(reports),
  };
}
