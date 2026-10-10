import {
  ATTRIBUTE_AXES,
  currentProposal,
  mirrorBaseOf,
  playerCardType,
  proposalParties,
  totalTransferFee,
  type AttributeAxis,
  type ExhibitTag,
  type GrowthOutlook,
  type InjuryHistory,
  type PlayerCardType,
  type SquadStatus,
  type Negotiation,
  type ProposalTerms,
} from "@gaffer/domain";
import {
  type GameState,
  activeContract,
  financeOf,
  managedTeamId,
  playerName,
  teamNameIn,
  weeklyWagesOf,
} from "../core/state";
import { pickPlayerAmong } from "../core/player-ref";
import type { Knowledge } from "../players/observation";
import { clubWageBudget } from "../team/wages";
import { buildFinanceView, type FinanceView } from "../team/finance-view";
import { buildPlayerCard } from "./views/player-card";
import type { RecentRatingView } from "./views/squad";

/**
 * ── 자료 카드 — 모델이 고른 카드를 코어가 장부로 채운다 ─────────────
 *
 * 모델은 `<player_card players="…" />` 같은 참조만 쓰고, 값은 턴이 닫힐 때 여기서
 * 풀어 그 턴에 저장한다(`ChatTurn.exhibits`) — 지난 대화의 카드는 그때의 장부로
 * 남는다 (docs/agents/prompts.md §1 「자료 카드」). 풀리지 않는 참조는 `null`이고,
 * 그 카드는 본문에서 걷힌다.
 */

/** 한 장에 견주는 선수의 상한 — 넘으면 표가 채팅 폭을 넘어 스크롤이 된다 */
export const EXHIBIT_PLAYERS_MAX = 8;

/** 능력 갈래의 표가 세우는 강점 축 수 — 한 칸에 이름 셋이면 표 폭에 든다 */
const STRENGTHS_SHOWN = 3;

/** 능력 갈래가 세우는 다른 자리 수 — 주 자리 밖에서 소화하는 자리, 전력이 높은 것부터 */
const OTHER_POSITIONS_SHOWN = 2;

/** 선수 한 명 — 선수 카드(`buildPlayerCard`)와 같은 안개를 지난 값이다 */
export interface PlayerExhibitEntry {
  id: string;
  name: string;
  age: number;
  team: string;
  position: string;
  /** 골키퍼인가 — 선방·무실점 칸이 서는 선수 */
  goalkeeper: boolean;
  /** 주 자리 밖에서 소화하는 자리와 그 자리에 세웠을 때의 관측 전력 (`observedFit`) */
  otherPositions: Array<{ position: string; overall: number }>;
  /** 이 값들을 얼마나 믿을지 — 화면은 꼬리표 하나로 세운다 (player.md §9.5) */
  knowledge: Knowledge;
  overall: number;
  overallMargin: number;
  attributes: Array<{ key: string; value: number }>;
  /** 관측값이 가장 높은 축 — 같으면 축의 순서대로 */
  strengths: AttributeAxis[];
  growth: GrowthOutlook | null;
  weeklyWage: number | null;
  contractUntil: string | null;
  injury: { bodyPart: string; severity: string; expectedReturn: string } | null;
  suspended: number;
  /** 2시즌 창의 부상 이력 — 공개 기록이라 남의 선수도 그대로다 */
  injuryHistory: InjuryHistory;
  height: number | null;
  weight: number | null;
  season: {
    apps: number;
    minutes: number;
    goals: number;
    assists: number;
    rating: number | null;
    shots: number;
    xg: number;
    yellows: number;
    reds: number;
    saves: number;
    cleanSheets: number;
  };
  /** 아래는 우리 선수만 — 남의 선수는 우리 훈련장과 우리 원장이 모르는 값이다 */
  condition: { value: number; margin: number; label: string } | null;
  fatigue: number | null;
  form: { label: string; tone: "up" | "flat" | "down" } | null;
  recentRatings: RecentRatingView[];
  squadStatus: SquadStatus | null;
}

/** 조건 한 갈래 — 구단 간(이적료) 또는 선수(주급·기간) */
export interface NegotiationExhibitTerms {
  scope: ProposalTerms["scope"];
  /** 낸 제안이면 `proposal`, 아직 초안이면 `draft`, 아무것도 없으면 조건 칸이 비었다 */
  state: "proposal" | "draft" | "none";
  terms: ProposalTerms | null;
  /** 낸 쪽 — 초안이나 빈 칸이면 null */
  from: string | null;
  sentOn: string | null;
  /** 이 조건의 당사자와 동의 여부 */
  parties: Array<{ name: string; agreed: boolean }>;
}

export interface NegotiationExhibit {
  kind: "negotiation";
  asOf: string;
  playerId: string;
  player: string;
  type: Negotiation["kind"];
  buyer: string;
  seller: string;
  /** 우리가 사는 쪽인가 — 여력 줄은 사는 쪽에만 선다 */
  buying: boolean;
  status: Negotiation["status"];
  closedReason: string | null;
  conditions: NegotiationExhibitTerms[];
  medical: { readyOn: string; examinedOn: string | null; injuries: number } | null;
  signedOn: string | null;
  registration: Negotiation["registration"];
  mandate: { stage: string; decideOn: string; maxFee: number; maxWeeklyWage: number } | null;
  /**
   * **이 조건으로 서명하면** — 사는 쪽에만. 주급 예산(`clubWageBudget`)에서 지금 주급
   * 총액과 이 계약의 주급 증가분을 뺀 여유, 그리고 잔고와 이적료 총액.
   */
  room: {
    wageBudget: number;
    weeklyWages: number;
    /** 서명 뒤 주간 여유 — 선수 조건이 아직 없으면 null */
    wageRoomAfter: number | null;
    balance: number;
    /** 이적료 총액(분할 포함) — 구단 간 조건이 없으면 null */
    fee: number | null;
    signingBonus: number | null;
  } | null;
}

type FinanceMonth = FinanceView["current"];

export interface FinanceExhibit {
  kind: "finance";
  asOf: string;
  month: FinanceMonth;
  balance: number;
  weeklyWages: number;
  wageBudget: number;
  /** 시즌 누계 급여 비중과 그 구간 */
  wageRatio: number;
  wageTone: FinanceView["wageTone"];
  debt: FinanceView["debt"];
  /** 아직 오가지 않은 이적료 분할금 — 낼 것과 받을 것의 합, 가장 가까운 한 건 */
  commitments: {
    payable: number;
    receivable: number;
    next: { dueOn: string; amount: number; direction: "payable" | "receivable" } | null;
  };
  /** 1년 안에 끝나는 우리 계약 수 */
  expiringContracts: number;
  /** 보드가 답을 미룬 요청 — 없으면 null */
  boardRequest: FinanceView["board"]["request"];
}

export interface PlayerExhibit {
  kind: "player";
  asOf: string;
  /** 어느 갈래의 칸을 세우나 — 값은 갈래와 무관하게 다 싣는다 */
  view: PlayerCardType;
  players: PlayerExhibitEntry[];
}

export type Exhibit = PlayerExhibit | NegotiationExhibit | FinanceExhibit;

/** 풀린 카드 — 본문에 다시 적을 참조(이름으로 편 것)와 저장할 값 */
export interface ResolvedExhibit {
  attrs: Record<string, string>;
  exhibit: Exhibit;
}

/** 이름 목록을 가른다 — 이름에 공백이 있으므로 쉼표·가운뎃점만 경계다 */
function refsOf(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[,·]/u)
    .map((ref) => ref.trim())
    .filter((ref) => ref.length > 0);
}

function pickPlayer(state: GameState, ref: string): string | null {
  const picked = pickPlayerAmong(state, state.players, ref, "이 세계 선수 명단");
  return picked.ok ? picked.player.id : null;
}

function playerEntry(state: GameState, playerId: string): PlayerExhibitEntry | null {
  const card = buildPlayerCard(state, playerId);
  if (!card) return null;
  return {
    id: card.id,
    name: card.name,
    age: card.age,
    team: card.team,
    position: card.position,
    goalkeeper: card.positionGroup === "GK",
    otherPositions: otherPositionsOf(card.position, card.positions),
    knowledge: card.knowledge,
    overall: card.overall,
    overallMargin: card.overallMargin,
    attributes: card.attributes.map(({ key, value }) => ({ key, value })),
    strengths: [...card.attributes]
      .sort(
        (a, b) =>
          b.value - a.value || ATTRIBUTE_AXES.indexOf(a.key) - ATTRIBUTE_AXES.indexOf(b.key),
      )
      .slice(0, STRENGTHS_SHOWN)
      .map((a) => a.key),
    growth: card.growth,
    weeklyWage: card.weeklyWage,
    contractUntil: card.contractUntil,
    injury: card.injury,
    suspended: card.suspended,
    injuryHistory: card.injuryHistory,
    height: card.height,
    weight: card.weight,
    season: {
      apps: card.season.apps,
      minutes: card.season.minutes,
      goals: card.season.goals,
      assists: card.season.assists,
      rating: card.season.rating,
      shots: card.season.shots,
      xg: card.season.xg,
      yellows: card.season.yellows,
      reds: card.season.reds,
      saves: card.season.saves,
      cleanSheets: card.season.cleanSheets,
    },
    condition: card.ours
      ? {
          value: card.ours.condition.value,
          margin: card.ours.condition.margin,
          label: card.ours.condition.label,
        }
      : null,
    fatigue: card.ours?.fatigue ?? null,
    form: card.ours ? { label: card.ours.formLabel, tone: card.ours.formTone } : null,
    recentRatings: card.ours?.recentRatings ?? [],
    squadStatus: card.ours?.squadStatus ?? null,
  };
}

/**
 * 주 자리 밖의 자리 — 좌우 변형(RCM·LCM)은 중앙 표기 하나로 접고 그중 높은 전력을 쓴다.
 * 주 자리와 같은 묶음은 다른 자리가 아니다.
 */
function otherPositionsOf(
  main: string,
  positions: ReadonlyArray<{ position: string; overall: number }>,
): PlayerExhibitEntry["otherPositions"] {
  const home = mirrorBaseOf(main);
  const best = new Map<string, number>();
  for (const { position, overall } of positions) {
    const base = mirrorBaseOf(position);
    if (base !== home) best.set(base, Math.max(best.get(base) ?? 0, overall));
  }
  return [...best]
    .map(([position, overall]) => ({ position, overall }))
    .sort((a, b) => b.overall - a.overall)
    .slice(0, OTHER_POSITIONS_SHOWN);
}

function resolvePlayers(state: GameState, attrs: Record<string, string>): ResolvedExhibit | null {
  const ids = [
    ...new Set(
      refsOf(attrs.players)
        .map((ref) => pickPlayer(state, ref))
        .filter((id) => id !== null),
    ),
  ].slice(0, EXHIBIT_PLAYERS_MAX);
  const players = ids
    .map((id) => playerEntry(state, id))
    .filter((entry): entry is PlayerExhibitEntry => entry !== null);
  if (players.length === 0) return null;
  const view = playerCardType(attrs.type);
  return {
    attrs: {
      players: players.map((p) => p.name).join(", "),
      ...(view === "overview" ? {} : { type: view }),
    },
    exhibit: { kind: "player", asOf: state.date, view, players },
  };
}

/** 협상 당사자의 이름 — 구단 id면 구단, 아니면 선수(대리인이 대리한다) */
function partyName(state: GameState, partyId: string): string {
  return state.players.some((p) => p.id === partyId)
    ? playerName(state, partyId)
    : teamNameIn(state, partyId);
}

/** 이 협상에 서는 조건 갈래 — 우리가 파는 이적은 구단 간 조건뿐이다 */
function scopesOf(n: Negotiation, teamId: string): Array<ProposalTerms["scope"]> {
  if (n.kind !== "transfer") return ["player"];
  return n.sellerId === teamId && n.buyerId !== teamId ? ["club"] : ["club", "player"];
}

function conditionOf(
  state: GameState,
  n: Negotiation,
  scope: ProposalTerms["scope"],
): NegotiationExhibitTerms {
  const proposal = currentProposal(n, scope);
  const draft = n.drafts.find((d) => d.scope === scope);
  const parties = proposalParties(n, scope).map((id) => ({
    name: partyName(state, id),
    agreed: proposal?.acceptedBy.includes(id) ?? false,
  }));
  if (proposal)
    return {
      scope,
      state: "proposal",
      terms: proposal.terms,
      from: partyName(state, proposal.author),
      sentOn: proposal.sentOn,
      parties,
    };
  return {
    scope,
    state: draft ? "draft" : "none",
    terms: draft ?? null,
    from: null,
    sentOn: null,
    parties,
  };
}

function roomOf(
  state: GameState,
  n: Negotiation,
  teamId: string,
  conditions: readonly NegotiationExhibitTerms[],
): NegotiationExhibit["room"] {
  if (n.buyerId !== teamId) return null;
  const club = conditions.find((c) => c.scope === "club")?.terms ?? null;
  const player = conditions.find((c) => c.scope === "player")?.terms ?? null;
  const wageBudget = Math.round(clubWageBudget(teamId, undefined, state));
  const weeklyWages = weeklyWagesOf(state, teamId);
  // 재계약은 지금 받는 주급이 이미 총액에 들어 있다 — 늘어나는 몫만 새로 든다
  const current = n.kind === "renewal" ? (activeContract(state, n.playerId)?.weeklyWage ?? 0) : 0;
  return {
    wageBudget,
    weeklyWages,
    wageRoomAfter: player ? wageBudget - weeklyWages - (player.weeklyWage - current) : null,
    balance: financeOf(state, teamId).balance,
    fee: club ? totalTransferFee(club) : null,
    signingBonus: player ? player.signingBonus : null,
  };
}

/**
 * 선수 이름 → **우리가 당사자인 협상 하나** — 열린 것이 먼저, 그다음 최근에 연 것.
 * 협상 id는 서사에 쓰지 않으므로(prompts.md §1) 카드는 선수로 협상을 찾는다.
 */
function resolveNegotiation(
  state: GameState,
  attrs: Record<string, string>,
): ResolvedExhibit | null {
  const teamId = managedTeamId(state);
  const playerId = attrs.player ? pickPlayer(state, attrs.player) : null;
  if (teamId === null || playerId === null) return null;
  const n = state.negotiations
    .filter((x) => x.playerId === playerId && [x.buyerId, x.sellerId].includes(teamId))
    .sort(
      (a, b) =>
        Number(b.status === "open") - Number(a.status === "open") ||
        b.openedOn.localeCompare(a.openedOn),
    )[0];
  if (!n) return null;
  const conditions = scopesOf(n, teamId).map((scope) => conditionOf(state, n, scope));
  const player = playerName(state, n.playerId);
  return {
    attrs: { player },
    exhibit: {
      kind: "negotiation",
      asOf: state.date,
      playerId: n.playerId,
      player,
      type: n.kind,
      buyer: teamNameIn(state, n.buyerId),
      seller: teamNameIn(state, n.sellerId),
      buying: n.buyerId === teamId,
      status: n.status,
      closedReason: n.closed?.reason ?? null,
      conditions,
      medical: n.medical
        ? {
            readyOn: n.medical.readyOn,
            examinedOn: n.medical.examinedOn,
            injuries: n.medical.injuries.length,
          }
        : null,
      signedOn: n.signed?.on ?? null,
      registration: n.registration,
      mandate: n.mandate
        ? {
            stage: n.mandate.stage,
            decideOn: n.mandate.decideOn,
            maxFee: n.mandate.maxFee,
            maxWeeklyWage: n.mandate.maxWeeklyWage,
          }
        : null,
      room: roomOf(state, n, teamId, conditions),
    },
  };
}

function commitmentsOf(rows: FinanceView["transferCommitments"]): FinanceExhibit["commitments"] {
  const sum = (direction: "payable" | "receivable") =>
    rows.filter((r) => r.direction === direction).reduce((total, r) => total + r.amount, 0);
  const next = [...rows].sort((a, b) => a.dueOn.localeCompare(b.dueOn))[0];
  return {
    payable: sum("payable"),
    receivable: sum("receivable"),
    next: next ? { dueOn: next.dueOn, amount: next.amount, direction: next.direction } : null,
  };
}

/** 달 — 없거나 이번 달이면 진행 중인 달, 지난 달이면 그 달의 보고서. 없는 달은 서지 않는다 */
function resolveFinance(state: GameState, attrs: Record<string, string>): ResolvedExhibit | null {
  if (managedTeamId(state) === null) return null;
  const view = buildFinanceView(state);
  const asked = attrs.month?.trim();
  const month =
    !asked || asked === view.current.month
      ? view.current
      : view.reports.find((r) => r.month === asked);
  if (!month) return null;
  return {
    attrs: month === view.current ? {} : { month: month.month },
    exhibit: {
      kind: "finance",
      asOf: state.date,
      month,
      balance: view.balance,
      weeklyWages: view.weeklyWages,
      wageBudget: Math.round(clubWageBudget(state.userTeamId, undefined, state)),
      wageRatio: view.wageRatio,
      wageTone: view.wageTone,
      debt: view.debt,
      commitments: commitmentsOf(view.transferCommitments),
      expiringContracts: view.expiringContracts.length,
      boardRequest: view.board.request,
    },
  };
}

/** 카드 하나를 장부로 푼다 — 못 풀면 null */
export function resolveExhibit(
  state: GameState,
  tag: ExhibitTag,
  attrs: Record<string, string>,
): ResolvedExhibit | null {
  switch (tag) {
    case "player_card":
      return resolvePlayers(state, attrs);
    case "negotiation_card":
      return resolveNegotiation(state, attrs);
    case "finance_card":
      return resolveFinance(state, attrs);
  }
}
