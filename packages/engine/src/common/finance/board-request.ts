import {
  type BoardRequestKind,
  type BoardRequest,
  type TickSink,
  boardRequestAmountText,
  BOARD_REQUEST_LABEL,
} from "@story-fm/domain";
import { type GameState, financeOf, clubProfileIn, pushNarrative } from "../core/state";
import { seasonWageRatio, recordCapitalAsset, STADIUM_ASSET_MONTHS } from "./finance";
import { addDays } from "../core/dates";

/**
 * 감독의 구장 증설 요청. 요청 결과는 재정 원장에 반영하며 보드 평판을 바꾸지 않는다.
 * 보드의 기대·평가·경고는 별도의 서사 장면에서 다룬다 (finance.md §9.3).
 */
export const BOARD_REQUEST = {
  /** 답이 오는 데 걸리는 날 — 구장은 이사회 안건이다 */
  RESPOND_DAYS: { stadium: 10 } as Record<BoardRequestKind, number>,
  /** 같은 종류를 다시 걸기까지 */
  COOLDOWN_DAYS: 60,
  /** 신뢰 계수의 바닥 보드 평판 — 이 아래는 무엇을 물어도 0이다 */
  TRUST_FLOOR: 30,
  /** 신뢰 계수가 1.0에 닿는 눈금 폭 — 평판 80이 1.0이다 */
  TRUST_SPAN: 50,
  /** 신뢰 계수의 상한 — 평판 100이어도 여력의 1.2배까지다 */
  TRUST_MAX: 1.2,
  /** 살림 계수의 계단 — 시즌 급여 비중 (finance.md §9.1의 경고선 그대로) */
  WAGE_RATIO_CAUTION: 0.65,
  WAGE_RATIO_DANGER: 0.75,
  /** 구장 증설 여력 = 지금 수용인원 × 이것 */
  SEATS_OF_CAPACITY: 0.2,
  /** 좌석 하나를 얹는 공사비 — 신축(석당 £16k)보다 싼 증설의 값 */
  SEAT_COST: 8_000,
  /** 공사비가 잔고에서 가져갈 수 있는 몫 */
  BUILD_OF_BALANCE: 0.5,
  /** 착공에서 개장까지 — 한 시즌 안에는 열리지 않는다 */
  BUILD_DAYS: 270,
  /** 상태에 남기는 지난 요청 수 — 다가옴과 같은 규약 */
  KEPT: 20,
} as const;

/** **답이 끝나지 않은 요청** — 한 번에 하나라 언제나 하나뿐이다 */
export function openBoardRequest(state: GameState): BoardRequest | null {
  return state.boardRequests.find((r) => r.status === "pending") ?? null;
}

/** 아직 좌석이 서지 않은 승인된 공사 — 있으면 구장을 다시 걸 수 없다 */
export function buildingStadium(state: GameState): BoardRequest | null {
  return (
    state.boardRequests.find(
      (r) => r.kind === "stadium" && r.status === "approved" && r.deliveredOn === undefined,
    ) ?? null
  );
}

// ── 한도 ───────────────────────────────────────────────────────

/**
 * 보드가 이 감독을 얼마나 믿는가 — 0 \~ 1.2.
 *
 * 평판 30 이하면 0이라 무엇을 물어도 거절이고, 80이면 여력 그대로, 100이면 1.2배다.
 */
export function boardTrustFactor(boardReputation: number): number {
  const raw = (boardReputation - BOARD_REQUEST.TRUST_FLOOR) / BOARD_REQUEST.TRUST_SPAN;
  return Math.min(BOARD_REQUEST.TRUST_MAX, Math.max(0, raw));
}

/**
 * 살림이 새고 있는가 — 1.0 · 0.5 · 0.
 *
 * 시즌 급여 비중이 위험선(75%)을 넘은 구단에는 더 얹지 않는다. 경고선은 월간
 * 보고서 노트가 쓰는 그 값이다 (finance.md §9.1).
 */
export function boardThriftFactor(wageRatio: number): number {
  if (wageRatio >= BOARD_REQUEST.WAGE_RATIO_DANGER) return 0;
  if (wageRatio >= BOARD_REQUEST.WAGE_RATIO_CAUTION) return 0.5;
  return 1;
}

/**
 * 여력 — 계수가 걸리기 전의 날것. 좌석은 허가가 아니라 공사비라 그날 현금이 실제로
 * 나가므로 잔고를 본다.
 */
function headroomOf(state: GameState): number {
  const teamId = state.userTeamId;
  const balance = Math.max(0, financeOf(state, teamId).balance);
  const seats = clubProfileIn(state, teamId).capacity * BOARD_REQUEST.SEATS_OF_CAPACITY;
  // 공사비가 잔고의 절반을 넘지 못한다 — 여력이 좌석이어도 나가는 것은 현금이다
  const affordable = (balance * BOARD_REQUEST.BUILD_OF_BALANCE) / BOARD_REQUEST.SEAT_COST;
  return Math.min(seats, affordable);
}

/** **보드가 이번에 내줄 수 있는 최대치** — `여력 × 신뢰 계수 × 살림 계수`. 굴리지 않는다 */
export function boardRequestCeiling(state: GameState): number {
  const factor =
    boardTrustFactor(state.manager.reputation.board) * boardThriftFactor(seasonWageRatio(state));
  return Math.floor(headroomOf(state) * factor);
}

// ── 접수 (명령) ────────────────────────────────────────────────

export interface RequestBoardInput {
  kind: BoardRequestKind;
  amount: number;
}

// ── 판정·반영 (tick) ───────────────────────────────────────────

/**
 * 하루치 보드 요청 — tick이 매일 부른다 (감독이 있는 날만).
 *
 * 두 일을 한다: 답이 도착한 요청을 판정해 그 자리에서 반영하고, 공기가 찬 공사의
 * 좌석을 세운다. 공사가 먼저다 — 오늘 좌석이 서야 오늘 거는 새 요청의 여력이
 * 늘어난 수용인원을 읽는다.
 */
export function tickBoardRequests(state: GameState, digest: TickSink): void {
  const requests = state.boardRequests;
  for (const request of requests) deliverStadium(state, request, digest);
  const open = requests.find((r) => r.status === "pending");
  if (open && state.date >= open.respondOn) judgeRequest(state, open, digest);
  if (requests.length > BOARD_REQUEST.KEPT) {
    state.boardRequests = requests.slice(-BOARD_REQUEST.KEPT);
  }
}

/** 답이 도착했다 — 오늘의 한도와 부른 값을 견준다 */
function judgeRequest(state: GameState, request: BoardRequest, digest: TickSink): void {
  const granted = Math.min(request.amount, boardRequestCeiling(state));
  if (granted <= 0) {
    request.status = "rejected";
    request.granted = 0;
    request.resolvedOn = state.date;
    const line = `보드 요청 거절 — ${describeAsk(request)}`;
    digest.push(line);
    pushNarrative(state, line, 4);
    return;
  }
  request.status = "approved";
  request.granted = granted;
  request.resolvedOn = state.date;
  /**
   * 공사비는 **자본 지출**이다 — 현금은 오늘 나가지만 손익은 내용연수에 나눠 문다
   * (finance.md §6.1).
   */
  recordCapitalAsset(state, state.userTeamId, {
    id: `asset-${request.id}`,
    label: `구장 증설 (${granted.toLocaleString("en-US")}석)`,
    cost: granted * BOARD_REQUEST.SEAT_COST,
    months: STADIUM_ASSET_MONTHS,
  });
  request.deliversOn = addDays(state.date, BOARD_REQUEST.BUILD_DAYS);
  const partial = granted < request.amount;
  const line = partial
    ? `보드 요청 부분 승인 — ${describeAsk(request)} 중 ${boardRequestAmountText(request.kind, granted)}`
    : `보드 요청 승인 — ${describeAsk(request)}`;
  digest.push(line);
  pushNarrative(state, line, partial ? 3 : 4);
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
  const team = state.teams.find((t) => t.id === state.userTeamId);
  if (!team) return;
  const profile = clubProfileIn(state, state.userTeamId);
  team.stadium = profile.stadium;
  team.commercialTier = profile.commercialTier;
  team.capacity = profile.capacity + seats;
  request.deliveredOn = state.date;
  const line = `구장 증설 완공 — ${seats.toLocaleString("en-US")}석 · 수용인원 ${team.capacity.toLocaleString("en-US")}`;
  digest.push(line);
  pushNarrative(state, line, 4);
}

// ── 사실 카드 ──────────────────────────────────────────────────

/** 요청 한 줄 — 라벨에 부른 값을 붙인다. 문장은 읽는 쪽이 쓴다 */
export function describeAsk(request: BoardRequest): string {
  return `${BOARD_REQUEST_LABEL[request.kind]} ${boardRequestAmountText(request.kind, request.amount)}`;
}

/**
 * GM 스냅샷의 블록 — **지금 서 있는 것이 있을 때만 선다.**
 *
 * 이 줄이 없으면 모델은 요청이 걸려 있다는 사실 자체를 모르고, 감독이 "그건 어떻게
 * 됐나"라고 물을 때 기억으로 메운다. 답이 도착한 날은 digest가 나른다.
 */
export function describeBoardRequests(state: GameState): string | null {
  const lines: string[] = [];
  const request = openBoardRequest(state);
  if (request) {
    lines.push(
      `- 답 대기: ${describeAsk(request)} · ${request.askedOn} 접수 · ${request.respondOn}에 답이 온다 ` +
        `(아직 답은 없다 — 결과를 앞질러 쓰지 마라)`,
    );
  }
  const building = buildingStadium(state);
  if (building?.deliversOn) {
    lines.push(
      `- 공사 중: 구장 ${(building.granted ?? 0).toLocaleString("en-US")}석 · ${building.deliversOn} 완공`,
    );
  }
  return lines.length > 0 ? lines.join("\n") : null;
}
