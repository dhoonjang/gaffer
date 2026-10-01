import {
  type BoardRequest,
  type TickSink,
  type BoardCondition,
  boardRequestAmountText,
  BOARD_REQUEST_LABEL,
  josa,
} from "@story-fm/domain";
import {
  type GameState,
  financeOf,
  clubProfileIn,
  weeklyWagesOf,
  playerById,
} from "../../common/core/state";
import { recordCapitalAsset, STADIUM_ASSET_MONTHS, formatMoney } from "./finance";
import { wageRoomOf, USER_WAGE_HEADROOM } from "../economy/wages";
import { diffDays } from "../../common/core/dates";
export type { RequestBoardInput } from "@story-fm/domain";

export const BOARD_REQUEST = { SEAT_COST: 8_000 } as const;

export function buildingStadium(state: GameState, teamId = state.userTeamId): BoardRequest | null {
  return (
    state.boardRequests.find(
      (r) =>
        r.teamId === teamId && r.kind === "stadium" && r.status === "approved" && !r.deliveredOn,
    ) ?? null
  );
}

/** Unallocated cash, after current spending permissions and active wage grants. */
export function boardAvailableCash(state: GameState, teamId = state.userTeamId): number {
  const finance = financeOf(state, teamId);
  const wages = state.boardRequests
    .filter(
      (r) =>
        r.teamId === teamId &&
        r.kind === "wage-room" &&
        r.status === "approved" &&
        r.validUntil &&
        r.validUntil >= state.date,
    )
    .reduce(
      (sum, r) => sum + ((r.granted ?? 0) * (diffDays(state.date, r.validUntil!) + 1)) / 7,
      0,
    );
  return Math.max(
    0,
    finance.balance - finance.transferBudget - earmarkedTotal(state, teamId) - wages,
  );
}

/** Validate actual execution; no contextual approval score or partial grant formula. */
export function boardExecutionError(state: GameState, request: BoardRequest): string | null {
  if (!state.teams.some((team) => team.id === request.teamId) || !request.authorizedBy)
    return "소유 구단과 기록된 보드 승인이 필요합니다";
  if (financeOf(state, request.teamId).budgetFrozen)
    return "재정 규정으로 예산이 동결되어 있습니다";
  const granted = request.granted ?? 0;
  if (!Number.isSafeInteger(granted) || granted <= 0 || granted > request.amount)
    return "승인액이 요청 범위를 벗어납니다";
  if (request.kind === "signing") {
    const player = request.playerId ? playerById(state, request.playerId) : undefined;
    if (!player || player.teamId === request.teamId) return "영입 대상 선수를 확인해야 합니다";
  }
  if (
    (request.kind === "signing" || request.kind === "wage-room") &&
    (!request.validUntil || request.validUntil < state.date)
  )
    return "유효한 승인 만료일이 필요합니다";
  if (
    request.kind === "stadium" &&
    (!request.deliversOn ||
      request.deliversOn <= state.date ||
      buildingStadium(state, request.teamId))
  )
    return "준공일 또는 진행 중인 공사를 확인해야 합니다";
  const cost =
    request.kind === "stadium"
      ? granted * BOARD_REQUEST.SEAT_COST
      : request.kind === "wage-room"
        ? (granted * (diffDays(state.date, request.validUntil!) + 1)) / 7
        : granted;
  return cost > boardAvailableCash(state, request.teamId)
    ? "기존 예산과 승인을 제외한 현금이 부족합니다"
    : null;
}

export function tickBoardRequests(state: GameState, digest: TickSink): void {
  for (const request of state.boardRequests)
    deliverStadium(state, request, request.teamId === state.userTeamId ? digest : []);
  expireEarmarks(state, digest);
  for (const request of state.boardRequests) {
    const output = request.teamId === state.userTeamId ? digest : [];
    if (request.status !== "pending" && request.status !== "conditional") continue;
    if (!request.decision || state.date < request.respondOn) continue;
    if (request.decision === "rejected") {
      request.status = "rejected";
      request.granted = 0;
      request.resolvedOn = state.date;
      output.push(`보드 요청 거절 — ${describeAsk(state, request)}`);
      continue;
    }
    if (request.decision === "conditional") {
      request.status = "conditional";
      if (!request.condition) continue;
      if (state.date > request.condition.until) {
        request.status = "rejected";
        request.granted = 0;
        request.resolvedOn = state.date;
        output.push(`보드 조건 기한 종료 — ${request.id}`);
        continue;
      }
      if (!conditionMet(state, request.teamId, request.condition)) continue;
    }
    const error = boardExecutionError(state, request);
    if (error) {
      output.push(`보드 승인 실행 대기 — ${request.id} · ${error}`);
      continue;
    }
    apply(state, request, request.granted!);
    request.status = "approved";
    request.resolvedOn = state.date;
    output.push(
      `보드 승인 — ${describeAsk(state, request)} · ${boardRequestAmountText(request.kind, request.granted!)}`,
    );
  }
}

function conditionMet(state: GameState, teamId: string, condition: BoardCondition): boolean {
  if (state.date < condition.since) return false;
  switch (condition.kind) {
    case "raise":
      return raisedSince(state, teamId, condition.since) >= condition.amount;
    case "wage-cut":
      return weeklyWagesOf(state, teamId) <= condition.amount;
    case "context":
      return false;
  }
}
function raisedSince(state: GameState, teamId: string, since: string): number {
  return state.transfers
    .filter(
      (t) =>
        t.fromTeamId === teamId && t.date >= since && (t.type === "transfer" || t.type === "loan"),
    )
    .reduce((sum, t) => sum + t.fee, 0);
}
function apply(state: GameState, request: BoardRequest, granted: number): void {
  const finance = financeOf(state, request.teamId);
  switch (request.kind) {
    case "transfer-budget":
      finance.transferBudget += granted;
      return;
    case "signing":
      finance.earmarked.push({
        requestId: request.id,
        gamePlayerId: request.playerId!,
        amount: granted,
        until: request.validUntil!,
      });
      return;
    case "wage-room":
      return;
    case "stadium":
      recordCapitalAsset(state, request.teamId, {
        id: `asset-${request.id}`,
        label: `구장 증설 (${granted}석)`,
        cost: granted * BOARD_REQUEST.SEAT_COST,
        months: STADIUM_ASSET_MONTHS,
      });
  }
}

// ── 건별 영입 승인분 (`earmarked`) ─────────────────────────────

/** 오늘 살아 있는 승인분 — 기한이 지난 줄은 tick이 지우기 전에도 세지 않는다 */
function liveEarmarks(state: GameState, teamId = state.userTeamId) {
  return financeOf(state, teamId).earmarked.filter((e) => state.date <= e.until);
}

/** 지금 걸려 있는 승인분의 합 — `signing` 여력이 이것을 뺀다 */
export function earmarkedTotal(state: GameState, teamId = state.userTeamId): number {
  return liveEarmarks(state, teamId).reduce((sum, e) => sum + e.amount, 0);
}

/** 그 선수 앞으로 걸려 있는 승인분 — 없으면 0 */
export function earmarkedFor(state: GameState, gamePlayerId: string): number {
  return liveEarmarks(state)
    .filter((e) => e.gamePlayerId === gamePlayerId)
    .reduce((sum, e) => sum + e.amount, 0);
}

/**
 * **그 선수를 살 수 있는 돈** — 관문 둘의 유일한 자다 (transfer.md §11).
 *
 * 딜 확률의 예산 항(`market.ts`)과 계약 확정의 관문(`negotiation.ts`)이 같은 값을
 * 봐야 한다: 갈리면 "가능하다"고 말한 오퍼가 도장 앞에서 막힌다. 주급 쪽에서
 * `userWageRoom`이 하는 일을 이적료 쪽에서 하는 자다.
 */
export function signingBudgetOf(state: GameState, gamePlayerId: string): number {
  return financeOf(state, state.userTeamId).transferBudget + earmarkedFor(state, gamePlayerId);
}

/**
 * 딜이 확정되는 날 — 오늘 나갈 만큼을 예산으로 옮기고 **줄을 지운다.**
 *
 * 남은 몫이 예산으로 남으면 다음 영입이 그 돈을 쓴다. 허가는 그 영입에 대한 것이었고
 * 영입은 일어났다 (finance.md §9.6). 분할의 남은 회분은 다른 이적과 똑같이 예산에서
 * 나간다.
 *
 * @returns 이적 예산에 얹힌 금액 — 검사한 값과 빠지는 값을 맞추는 자다
 */
export function consumeEarmark(state: GameState, gamePlayerId: string, dueNow: number): number {
  const finance = financeOf(state, state.userTeamId);
  const rows = finance.earmarked;
  if (rows.length === 0) return 0;
  const mine = rows.filter((e) => e.gamePlayerId === gamePlayerId);
  if (mine.length === 0) return 0;
  finance.earmarked = rows.filter((e) => e.gamePlayerId !== gamePlayerId);
  const live = mine.filter((e) => state.date <= e.until).reduce((sum, e) => sum + e.amount, 0);
  const used = Math.max(0, Math.min(dueNow, live));
  finance.transferBudget += used;
  return used;
}

/** 기한이 지난 승인분을 지운다 — 만료가 없으면 허가가 아니라 예산이다 */
function expireEarmarks(state: GameState, digest: TickSink): void {
  for (const finance of state.finances) {
    const gone = finance.earmarked.filter((e) => state.date > e.until);
    finance.earmarked = finance.earmarked.filter((e) => state.date <= e.until);
    if (finance.teamId !== state.userTeamId) continue;
    for (const row of gone) {
      digest.push(
        `보드 영입 승인 만료 — ${playerName(state, row.gamePlayerId)} ${formatMoney(row.amount)}`,
      );
    }
  }
}

/**
 * 공기가 찬 공사의 좌석을 세운다 — `state.teams[].capacity`가 오르는 유일한 자리.
 *
 * 세이브의 구단 카드는 셋(구장·수용인원·상업 등급)이 함께 있어야 카탈로그를
 * 덮으므로(`clubProfileIn`), 지금 값 그대로 셋을 다 적는다.
 */
function deliverStadium(state: GameState, request: BoardRequest, digest: TickSink): void {
  if (request.kind !== "stadium" || request.status !== "approved") return;
  if (request.deliveredOn !== undefined || !request.deliversOn) return;
  if (state.date < request.deliversOn) return;
  const seats = request.granted ?? 0;
  const team = state.teams.find((t) => t.id === request.teamId);
  if (!team) return;
  const profile = clubProfileIn(state, request.teamId);
  team.stadium = profile.stadium;
  team.commercialTier = profile.commercialTier;
  team.capacity = profile.capacity + seats;
  request.deliveredOn = state.date;
  const line = `구장 증설 완공 — ${seats.toLocaleString("en-US")}석 · 수용인원 ${team.capacity.toLocaleString("en-US")}`;
  digest.push(line);
}

// ── 사실 카드 ──────────────────────────────────────────────────

/** 이름이 사라진 선수도 있다 — 카드가 빈칸을 내지 않게 id를 폴백으로 든다 */
function playerName(state: GameState, gamePlayerId: string): string {
  return playerById(state, gamePlayerId)?.name ?? gamePlayerId;
}

/** 부른 값 한 덩이 — `signing`만 선수 이름이 앞에 붙는다 */
export function askText(state: GameState, request: BoardRequest): string {
  const amount = boardRequestAmountText(request.kind, request.amount);
  if (request.kind !== "signing" || !request.playerId) return amount;
  return `${playerName(state, request.playerId)} ${amount}`;
}

/** 요청 한 줄 — 라벨에 부른 값을 붙인다. 문장은 읽는 쪽이 쓴다 */
export function describeAsk(state: GameState, request: BoardRequest): string {
  return `${BOARD_REQUEST_LABEL[request.kind]} ${askText(state, request)}`;
}

/** 되건 조건 한 줄 — 갈래와 금액뿐이다. "판다면 준다"는 GM이 쓴다 */
function conditionText(condition: BoardCondition): string {
  switch (condition.kind) {
    case "context":
      return "GM이 맥락과 합의 이행을 확인";
    case "raise":
      return `매각으로 ${josa(formatMoney(condition.amount), "을/를")} 만들면 승인`;
    case "wage-cut":
      return `주급 총액을 ${formatMoney(condition.amount)}/주 아래로 내리면 승인`;
  }
}

/** 조건이 지금 어디까지 찼는가 — 사실이지 평가가 아니다 */
function conditionProgress(state: GameState, teamId: string, condition: BoardCondition): string {
  switch (condition.kind) {
    case "context":
      return "명시적 결정 대기";
    case "raise":
      return `지금까지 매각 ${formatMoney(raisedSince(state, teamId, condition.since))}`;
    case "wage-cut":
      return `지금 주급 총액 ${formatMoney(weeklyWagesOf(state, teamId))}/주`;
  }
}

/**
 * GM 스냅샷의 블록 — **지금 서 있는 것이 있을 때만 선다.**
 *
 * 답을 기다리는 요청과, 보드가 이미 내준 주급 한도 상향 둘이다. 이 줄이 없으면
 * 모델은 요청이 걸려 있다는 사실 자체를 모르고, 감독이 "그건 어떻게 됐나"라고
 * 물을 때 기억으로 메운다. 답이 도착한 날은 digest가 나른다.
 */
export function describeBoardRequests(state: GameState): string | null {
  const lines: string[] = [];
  for (const request of state.boardRequests) {
    if (request.teamId !== state.userTeamId) continue;
    if (request?.status === "pending") {
      lines.push(
        `- 답 대기 [${request.id}]: ${describeAsk(state, request)} · ${request.askedOn} 접수 · ${request.respondOn}에 답이 온다 ` +
          `(아직 답은 없다 — 결과를 앞질러 쓰지 마라)`,
      );
    }
    if (request?.status === "conditional" && request.condition) {
      lines.push(
        `- 조건부 승인 [${request.id}]: ${describeAsk(state, request)} — ${conditionText(request.condition)} · ` +
          `기한 ${request.condition.until} · ${conditionProgress(state, request.teamId, request.condition)}`,
      );
    }
  }
  for (const row of liveEarmarks(state)) {
    lines.push(
      `- 영입 승인분: ${playerName(state, row.gamePlayerId)} ${formatMoney(row.amount)} ` +
        `(${row.until}까지 · 그 선수 영입에만 쓴다)`,
    );
  }
  const building = buildingStadium(state);
  if (building?.deliversOn) {
    lines.push(
      `- 공사 중: 구장 ${(building.granted ?? 0).toLocaleString("en-US")}석 · ${building.deliversOn} 완공`,
    );
  }
  const lift = wageLiftLine(state);
  if (lift) lines.push(`- ${lift}`);
  return lines.length > 0 ? lines.join("\n") : null;
}

// ── 주급 천장에 얹히는 몫 ──────────────────────────────────────

/**
 * 감독의 구단에 얹혀 있는 주급 한도 — 만료됐으면 0이다.
 *
 * `wageRoomOf`가 곱으로 재는 천장 **위에 더해지는 절대액**이다. 감독이 부른 값이
 * 주급이었으므로 나온 것도 주급이어야 한다 — 배수로 돌려주면 같은 승인이 구단
 * 규모에 따라 다른 값이 된다. 승인한 구단이 감독의 이직 뒤에도 이 몫을 소유한다.
 */
export function wageLiftOf(state: GameState, teamId: string): number {
  return state.boardRequests
    .filter(
      (r) =>
        r.teamId === teamId &&
        r.kind === "wage-room" &&
        r.status === "approved" &&
        r.validUntil !== undefined &&
        state.date <= r.validUntil,
    )
    .reduce((sum, r) => sum + (r.granted ?? 0), 0);
}

/**
 * **감독의 구단이 지금 주급 총액 위에 더 얹을 수 있는 돈** — 관문 둘의 유일한 자다.
 *
 * 영입 확률(`market.ts`)과 계약 확정(`negotiation.ts`)이 같은 값을 봐야 한다:
 * 갈리면 "가능하다"고 말한 오퍼가 도장 앞에서 막힌다.
 */
export function userWageRoom(state: GameState): number {
  return (
    wageRoomOf(
      state.userTeamId,
      weeklyWagesOf(state, state.userTeamId),
      USER_WAGE_HEADROOM,
      state,
    ) + wageLiftOf(state, state.userTeamId)
  );
}

/** 주급 여력 한 줄 — 보드가 내준 상향이 열려 있을 때만 (`get_finance`가 싣는다) */
export function wageLiftLine(state: GameState): string | null {
  const lift = wageLiftOf(state, state.userTeamId);
  if (lift <= 0) return null;
  const until = state.boardRequests
    .filter(
      (r) =>
        r.teamId === state.userTeamId &&
        r.kind === "wage-room" &&
        r.status === "approved" &&
        r.validUntil &&
        r.validUntil >= state.date,
    )
    .map((r) => r.validUntil)
    .join(", ");
  return `보드 승인 주급 한도 상향 ${formatMoney(lift)}/주 (${until}까지) · 남은 주급 여력 ${formatMoney(Math.max(0, userWageRoom(state)))}/주`;
}
