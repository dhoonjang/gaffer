import { peekReportCards, type GameState } from "@story-fm/engine";
import type { ScoutingReport } from "@story-fm/domain";

export const MAX_REPORT_CARDS = 3;
export interface ArrivedCards {
  reports: ScoutingReport[];
}
export const NO_CARDS: ArrivedCards = { reports: [] };

/** Read archived snapshots. Missing cards stay queued; roster changes cannot erase a report. */
export function takeArrivedReports(
  state: GameState,
  limit: number,
  stuck: Set<string> = new Set(),
): ArrivedCards {
  const reports: ScoutingReport[] = [];
  for (const id of peekReportCards(state, state.pendingReportCards.length, stuck)) {
    if (reports.length >= Math.max(0, limit)) break;
    const report = state.scoutReports.find((row) => row.id === id);
    if (report) reports.push(structuredClone(report));
    stuck.add(id);
  }
  return { reports };
}
