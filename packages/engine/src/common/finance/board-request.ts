import {
  BOARD_REQUEST_LABEL,
  boardRequestAmountText,
  type BoardRequest,
  type TickSink,
} from "@story-fm/domain";
import { type GameState, financeOf, clubProfileIn } from "../core/state";
import { recordCapitalAsset, STADIUM_ASSET_MONTHS } from "./finance";
export type { RequestBoardInput } from "@story-fm/domain";

export const BOARD_REQUEST = { SEAT_COST: 8_000 } as const;
export function openBoardRequest(state: GameState): BoardRequest | null {
  return (
    state.boardRequests.find(
      (r) =>
        r.teamId === state.userTeamId && (r.status === "pending" || r.status === "conditional"),
    ) ?? null
  );
}
export function buildingStadium(state: GameState, teamId = state.userTeamId): BoardRequest | null {
  return (
    state.boardRequests.find(
      (r) => r.teamId === teamId && r.status === "approved" && !r.deliveredOn,
    ) ?? null
  );
}
export function boardExecutionError(state: GameState, request: BoardRequest): string | null {
  if (!state.teams.some((team) => team.id === request.teamId) || !request.authorizedBy)
    return "소유 구단과 기록된 보드 승인이 필요합니다";
  const granted = request.granted ?? 0;
  if (!Number.isSafeInteger(granted) || granted <= 0 || granted > request.amount)
    return "승인액이 요청 범위를 벗어납니다";
  if (
    !request.deliversOn ||
    request.deliversOn <= state.date ||
    buildingStadium(state, request.teamId)
  )
    return "준공일 또는 진행 중인 공사를 확인해야 합니다";
  return granted * BOARD_REQUEST.SEAT_COST > financeOf(state, request.teamId).balance
    ? "공사비를 지급할 현금이 부족합니다"
    : null;
}
export function describeAsk(state: GameState, request: BoardRequest): string {
  return `${BOARD_REQUEST_LABEL[request.kind]} ${boardRequestAmountText(request.kind, request.amount)}`;
}
export function tickBoardRequests(state: GameState, digest: TickSink): void {
  for (const request of state.boardRequests) {
    const output = request.teamId === state.userTeamId ? digest : [];
    if (
      request.status === "approved" &&
      !request.deliveredOn &&
      request.deliversOn &&
      state.date >= request.deliversOn
    ) {
      const team = state.teams.find((team) => team.id === request.teamId);
      if (team) {
        team.capacity = clubProfileIn(state, team.id).capacity + (request.granted ?? 0);
        request.deliveredOn = state.date;
        output.push(`구장 증설 완료 — ${request.granted ?? 0}석`);
      }
    }
    if (
      !["pending", "conditional"].includes(request.status) ||
      !request.decision ||
      state.date < request.respondOn
    )
      continue;
    if (request.decision === "conditional") {
      request.status = "conditional";
      continue;
    }
    if (request.decision === "rejected") {
      request.status = "rejected";
      request.granted = 0;
      request.resolvedOn = state.date;
      output.push(`보드 요청 거절 — ${describeAsk(state, request)}`);
      continue;
    }
    if (boardExecutionError(state, request)) continue;
    recordCapitalAsset(state, request.teamId, {
      id: `asset-${request.id}`,
      label: `구장 증설 (${request.granted}석)`,
      cost: request.granted! * BOARD_REQUEST.SEAT_COST,
      months: STADIUM_ASSET_MONTHS,
    });
    request.status = "approved";
    request.resolvedOn = state.date;
    output.push(`보드 요청 승인 — ${describeAsk(state, request)}`);
  }
}
export function describeBoardRequests(state: GameState): string | null {
  const lines = state.boardRequests
    .filter(
      (r) =>
        r.teamId === state.userTeamId &&
        (r.status === "pending" ||
          r.status === "conditional" ||
          (r.status === "approved" && !r.deliveredOn)),
    )
    .map(
      (r) => `- [${r.id}] ${describeAsk(state, r)} · ${r.status} · ${r.deliversOn ?? r.respondOn}`,
    );
  return lines.length ? lines.join("\n") : null;
}
