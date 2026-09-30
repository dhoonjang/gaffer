import {
  type Contract,
  DEAL_TERM_KO,
  type DealTerm,
  type DealTermKind,
  type GamePlayer,
  type MarketCard,
  type MarketDirection,
  type MarketTerms,
  type MedicalConcern,
  type Negotiation,
  type NegotiationVerdict,
  PRECONTRACT_DAYS,
  type PlayerIssueReason,
  SQUAD_STATUS_KO,
  type SquadStatus,
  type TickSink,
  dealTermLabel,
  isMandated,
  isPlayerDeal,
  josa,
  josaOf,
  mandateLimitText,
  marketDirectionKo,
  naturalPositionOf,
  registrationBlockText,
} from "@story-fm/domain";
import { item } from "../../common/commands/brief";
import { type CommandResult, type MarketCommandResult } from "../../common/commands/result";
import { windowOpenOn } from "../../common/core/calendar";
import { addDays, contractUntil, diffDays, seasonYear } from "../../common/core/dates";
import { pickAnyPlayer, pickOurPlayer, pickSignedPlayer } from "../../common/core/player-ref";
import { pickWeighted } from "../../common/core/rng";
import {
  type GameState,
  activeContract,
  answerTransferRequest,
  competingBidsOn,
  contractYearsLeft,
  pendingContractOf,
  playerById,
  playersOf,
  pushNarrative,
  squadShortfall,
  teamName,
  transferRequestOf,
} from "../../common/core/state";
import { pickTeam } from "../../common/core/team-ref";
import { isClubTeam } from "../../common/data/team-catalog";
import { derivedSquadStatus } from "../../common/players/contract-status";
import { assignSquadNumber, numberLineageOf } from "../../common/players/numbers";
import { canRegisterFor } from "../../common/players/registration";
import { betterAtPosition } from "../../common/players/squad-depth";
import { signingBudgetOf, userWageRoom } from "../finance/board-request";
import { budgetFreezeLabel, formatMoney, settlePlayerFee } from "../finance/finance";
import { personalHolds } from "./counter-bounds";
import { clearDepartedState, isFreeAgent, loanPlayer } from "./departures";
import {
  type DealTerms,
  contractOwnerOf,
  describePending,
  isPrecontractTerms,
  loanLockOf,
  loanedInBy,
  marketValueOf,
  paymentYearsOf,
  precontractBlockerOf,
  precontractStartOf,
  squadShortfallText,
  stageScaleOf,
  suitorWeightOf,
  unilateralSeveranceOf,
  validateDeal,
  windowOpenForTeam,
} from "./market";
import {
  describeMedical,
  isIncomingDeal,
  medicalConcernText,
  medicalNoteText,
  receivingTeamOf,
} from "./medical";
import { pitchNotes } from "./persuasion";
import {
  answerTermAsk,
  describeTermSheet,
  offeredTermsOf,
  refusedTermsOf,
  settleLoanTerms,
  settleTermsOnSigning,
  tableTerms,
  termKindsOf,
} from "./terms";

const dealTerms = (t: MarketTerms): MarketTerms => ({
  ...(t.fee ? { fee: t.fee } : {}),
  ...(t.severance ? { severance: t.severance } : {}),
  ...(t.weeklyWage ? { weeklyWage: t.weeklyWage } : {}),
  ...(t.years ? { years: t.years } : {}),
  // 일시금은 없는 값이다 — 카드에 `1년 분할`이 서면 그것이 조건처럼 읽힌다
  ...(paymentYearsOf(t.paymentYears) ? { paymentYears: t.paymentYears } : {}),
});

export function splitLabel(paymentYears?: number): string {
  const n = paymentYearsOf(paymentYears);
  return n === undefined ? "" : ` · ${n}년 분할`;
}

export function statusLabel(status?: SquadStatus): string {
  return status === undefined ? "" : ` · ${SQUAD_STATUS_KO[status]} 지위`;
}

export function numberLabel(squadNumber?: number): string {
  return squadNumber === undefined ? "" : ` · ${squadNumber}번 요구`;
}

function termsOfKind(kind: Negotiation["kind"], round: MarketTerms): MarketTerms {
  return kind === "release"
    ? dealTerms({ severance: round.fee ?? 0, paymentYears: round.paymentYears })
    : dealTerms(round);
}

export function openNegotiationFor(state: GameState, playerId: string): Negotiation | null {
  return state.negotiations.find((n) => n.gamePlayerId === playerId && n.status === "open") ?? null;
}

export function liveNegotiationFor(state: GameState, playerId: string): Negotiation | null {
  return (
    state.negotiations.find(
      (n) => n.gamePlayerId === playerId && (n.status === "open" || n.status === "agreed"),
    ) ?? null
  );
}

const kindSlug = (kind: Negotiation["kind"]) => kind.replace("_", "");

function directionOfKind(kind: Negotiation["kind"]): MarketDirection | null {
  // 상대가 선수 본인인 갈래에는 방향이 없다 — 배지가 `영입`·`매각`을 달 수 없다
  if (isPlayerDeal(kind)) return null;
  return kind === "buy" || kind === "loan" ? "in" : "out";
}

export function directionField(kind: Negotiation["kind"]): { direction?: MarketDirection } {
  const direction = directionOfKind(kind);
  return direction ? { direction } : {};
}

export const KIND_KO: Record<Negotiation["kind"], string> = {
  buy: marketDirectionKo("in"),
  sell: marketDirectionKo("out"),
  loan: marketDirectionKo("in", true),
  loan_out: marketDirectionKo("out", true),
  renew: "재계약",
  release: "계약 해지",
};

export function negotiationKindKo(negotiation: Negotiation): string {
  return negotiation.precontract ? "사전 계약" : KIND_KO[negotiation.kind];
}

function openNegotiationOfKind(
  state: GameState,
  playerId: string,
  kind: Negotiation["kind"],
  precontract = false,
): Negotiation | null {
  return (
    state.negotiations.find(
      (n) =>
        n.gamePlayerId === playerId &&
        n.kind === kind &&
        n.precontract === precontract &&
        n.status === "open",
    ) ?? null
  );
}

function conflictingNegotiation(
  state: GameState,
  playerId: string,
  kind: Negotiation["kind"],
  precontract = false,
): Negotiation | null {
  return (
    state.negotiations.find(
      (n) =>
        n.gamePlayerId === playerId &&
        (n.kind !== kind || n.precontract !== precontract) &&
        (n.status === "open" || n.status === "agreed"),
    ) ?? null
  );
}

function kindConflictMessage(negotiation: Negotiation, playerName: string): string {
  return (
    `${josa(playerName, "은/는")} 이미 ${negotiationKindKo(negotiation)} 협상이 진행 중입니다 ` +
    `(${negotiation.id}) — 먼저 정리해야 다른 갈래를 열 수 있습니다`
  );
}

export function pendingOffer(negotiation: Negotiation) {
  const last = negotiation.rounds[negotiation.rounds.length - 1];
  return last && last.by === "us" && last.verdict === null ? last : null;
}

export function arrivedResponses(state: GameState): Negotiation[] {
  return state.negotiations.filter((n) => {
    if (n.status !== "open") return false;
    const offer = pendingOffer(n);
    if (offer !== null) return offer.respondsOn !== null && offer.respondsOn <= state.date;
    const personal = personalAwaiting(n);
    return personal !== null && personal.respondsOn <= state.date;
  });
}

export function personalAwaiting(
  negotiation: Negotiation,
): NonNullable<Negotiation["personal"]> | null {
  const personal = negotiation.personal;
  if (!personal || personal.agreedOn !== undefined || personal.counter !== undefined) return null;
  return personal;
}

export function sendOffer(state: GameState, input: DealTerms): MarketCommandResult {
  const pick = pickAnyPlayer(state, input.playerId);
  if (!pick.ok) return { ok: false, message: pick.message };
  const player = pick.player;
  // 감독이 부른 이름이 실려 오므로 여기서 id로 굳힌다 — 아래는 협상 id와
  // `gamePlayerId`를 이 값으로 짓는다
  // 임대료는 한 시즌짜리 돈이라 나눌 기간이 없다 (transfer.md §5-2)
  const { paymentYears: requested, squadStatus: proposed, terms: proposedTerms, ...rest } = input;
  const paymentYears = input.kind === "loan" ? undefined : paymentYearsOf(requested);
  // 빌려 온 선수의 계약은 남의 것이라 임대에는 적을 지위가 없다 (transfer.md §2)
  const squadStatus = input.kind === "loan" ? undefined : proposed;
  const terms: DealTerms = {
    ...rest,
    playerId: player.id,
    ...(paymentYears === undefined ? {} : { paymentYears }),
    ...(squadStatus === undefined ? {} : { squadStatus }),
  };

  // 임대 영입도 같은 테이블을 쓴다 — 방향만 다르다
  const kind: Negotiation["kind"] = terms.kind === "loan" ? "loan" : "buy";
  const precontract = isPrecontractTerms(state, terms);
  // 이 협상에서 이미 통한 논거는 다시 쳐주지 않는다 — 같은 말의 반복은 설득이 아니다
  const existing =
    openNegotiationOfKind(state, terms.playerId, kind, precontract) ??
    state.negotiations.find(
      (n) =>
        n.gamePlayerId === terms.playerId &&
        n.kind === kind &&
        n.status === "open" &&
        n.rounds.length === 0,
    ) ??
    null;
  const withPitched: DealTerms = {
    ...terms,
    pitched: existing?.pitched ?? [],
    terms: previewTerms(existing, proposedTerms),
    refusedTerms: existing ? refusedTermsOf(existing) : 0,
    ...(existing &&
    personalHolds(existing, {
      weeklyWage: terms.weeklyWage,
      contractYears: terms.years,
      ...(squadStatus === undefined ? {} : { squadStatus }),
    })
      ? { personalAgreed: true }
      : {}),
  };
  const odds = validateDeal(state, withPitched);
  if (odds.blockers.length > 0) {
    return { ok: false, message: `오퍼를 넣을 수 없습니다 — ${odds.blockers.join(" / ")}` };
  }

  const conflict = conflictingNegotiation(state, terms.playerId, kind, precontract);
  if (conflict && conflict !== existing)
    return { ok: false, message: kindConflictMessage(conflict, player.name) };
  if (existing) {
    const waiting = pendingOffer(existing);
    if (waiting && waiting.respondsOn !== null && waiting.respondsOn > state.date) {
      return {
        ok: false,
        message: `${player.name} 오퍼는 아직 답을 기다리는 중입니다 — ${describeWait(diffDays(state.date, waiting.respondsOn))}`,
      };
    }
  }

  const window = windowOpenOn(state.windows, state.date);
  const negotiation: Negotiation =
    existing ??
    (() => {
      const created: Negotiation = {
        // id에도 갈래가 든다 — 같은 선수에게 같은 날 두 갈래를 열면 겹친다.
        // 사전 계약은 갈래가 `buy`여도 다른 테이블이라 id도 갈라진다 (§1-4)
        id: `neg-${precontract ? "pre" : kindSlug(kind)}-${terms.playerId}-${state.date}`,
        gamePlayerId: terms.playerId,
        kind,
        precontract,
        buyout: false,
        pitched: [],
        terms: [],
        // 상대는 계약을 가진 구단이다 — 빌려 온 선수의 원소속이 갈라지는 자리다 (§2)
        counterpartTeamId: contractOwnerOf(state, player),
        windowId: window?.id ?? null,
        openedOn: state.date,
        status: "open",
        rounds: [],
      };
      state.negotiations.push(created);
      return created;
    })();

  negotiation.pitched = [...new Set([...negotiation.pitched, ...pitchNotes(terms.pitch ?? [])])];
  // 오퍼에 실린 조건은 조건서에 오른다 — 서지 못한 조건은 결과 줄에 남는다 (§12-3)
  const termNotes = proposedTerms ? tableTerms(state, negotiation, proposedTerms).notes : [];
  if (negotiation.rounds.length === 0) negotiation.precontract = precontract;
  // 앉아만 있던 자리에 오퍼가 오르면 협상의 기한으로 산다 (§12-2)

  const { waitDays } = pushOurRound(state, negotiation, terms, {
    // 같은 조건을 되풀이하면 상대가 지친다 — 답이 그만큼 늦어진다
    repeats: negotiation.rounds.filter((r) => r.by === "us").length,
    ...(terms.pitch ? { pitch: terms.pitch } : {}),
  });

  const pitchNote = terms.pitch?.length ? ` 설득: ${pitchNotes(terms.pitch).join(" · ")}.` : "";
  // 사전 계약에는 이적료 줄이 서지 않는다 — 0이다. 대신 합류일이 선다 (§1-4)
  const head = precontract
    ? `${teamName(player.teamId)}의 ${player.name}에게 사전 계약 제안 — ` +
      `주급 ${formatMoney(terms.weeklyWage)} · ${terms.years}년, ${precontractStartOf(state)}부터` +
      `${statusLabel(squadStatus)}.`
    : terms.kind === "loan"
      ? `${teamName(player.teamId)}에 ${player.name} 임대를 요청 — 임대료 ${formatMoney(terms.fee)} · ` +
        `우리가 낼 주급 ${formatMoney(terms.weeklyWage)}.`
      : `${teamName(player.teamId)}의 ${player.name}에게 오퍼 — 이적료 ${formatMoney(terms.fee)}` +
        `${splitLabel(paymentYears)} · 주급 ${formatMoney(terms.weeklyWage)} · ${terms.years}년` +
        `${statusLabel(squadStatus)}.`;
  const termsLine = termsLabel(negotiation);
  const card: MarketCard = {
    kind: "offer",
    playerId: player.id,
    playerName: player.name,
    counterpart: teamName(player.teamId),
    terms: dealTerms({
      fee: terms.fee,
      weeklyWage: terms.weeklyWage,
      years: terms.years,
      ...(paymentYears === undefined ? {} : { paymentYears }),
    }),

    ...directionField(kind),
    ...(terms.kind === "loan" ? { loan: true } : {}),
    // 배지가 「지금 오는 게 아니라 여름에 온다」를 든다 (market-card.ts)
    ...(precontract ? { precontract: true } : {}),
    // 카드에 지위 칸이 따로 없다 — 조건과 함께 읽히도록 한 줄로 싣는다
    ...(squadStatus === undefined ? {} : { note: `${SQUAD_STATUS_KO[squadStatus]} 지위 제시` }),
  };
  return {
    ok: true,
    payload: card,
    message:
      `${head}${termsLine}${pitchNote} ${describePending(waitDays)}` +
      (termNotes.length > 0 ? ` ${termNotes.join(" ")}` : ""),
  };
}

function termsLabel(negotiation: Negotiation): string {
  const offered = offeredTermsOf(negotiation);
  return offered.length === 0 ? "" : ` 조건: ${offered.map(dealTermLabel).join(" · ")}.`;
}

function previewTerms(negotiation: Negotiation | null, proposed?: readonly DealTerm[]): DealTerm[] {
  const base = negotiation ? offeredTermsOf(negotiation) : [];
  if (!proposed || proposed.length === 0) return base;
  const kinds = new Set(proposed.map((t) => t.kind));
  return [...base.filter((t) => t.kind === "other" || !kinds.has(t.kind)), ...proposed];
}

function answerTarget(
  state: GameState,
  negotiationId: string,
  pick: (n: Negotiation) => Negotiation["rounds"][number] | null,
  noOfferMessage: string,
  guard?: (n: Negotiation) => string | null,
):
  | { ok: false; message: string }
  | {
      ok: true;
      negotiation: Negotiation;
      offer: Negotiation["rounds"][number];
      player: GamePlayer;
    } {
  const negotiation = state.negotiations.find((n) => n.id === negotiationId);
  if (!negotiation) {
    return {
      ok: false,
      message: `협상 "${negotiationId}"${josaOf(negotiationId, "을/를")} 찾지 못했습니다`,
    };
  }
  const blocked = guard?.(negotiation);
  if (blocked !== undefined && blocked !== null) return { ok: false, message: blocked };
  if (negotiation.status !== "open") {
    return { ok: false, message: `이미 끝난 협상입니다 (${negotiation.status})` };
  }
  const offer = pick(negotiation);
  if (!offer) return { ok: false, message: noOfferMessage };
  const player = playerById(state, negotiation.gamePlayerId);
  if (!player) return { ok: false, message: "선수를 찾지 못했습니다" };
  return { ok: true, negotiation, offer, player };
}

export function counterpartOf(negotiation: Negotiation, player: GamePlayer): string {
  // 재계약·해지의 상대는 구단이 아니라 선수 본인이다
  if (isPlayerDeal(negotiation.kind)) return player.name;
  if (negotiation.precontract) return player.name;
  const selling = negotiation.kind === "sell" || negotiation.kind === "loan_out";
  return teamName(selling ? (negotiation.counterpartTeamId ?? player.teamId) : player.teamId);
}

function verdictCardOf(input: {
  player: GamePlayer;
  counterpart: string;
  kind: Negotiation["kind"];
  verdict: NegotiationVerdict;
  offer: Negotiation["rounds"][number];
  loan?: boolean;
  note?: string;
  counterTerms?: MarketTerms;
  dueOn?: string;
}): MarketCard {
  return {
    kind: "verdict",
    playerId: input.player.id,
    playerName: input.player.name,
    counterpart: input.counterpart,
    verdict: input.verdict,
    terms: termsOfKind(input.kind, {
      fee: input.offer.fee,
      weeklyWage: input.offer.weeklyWage,
      years: input.offer.contractYears,
      ...(input.offer.paymentYears === undefined ? {} : { paymentYears: input.offer.paymentYears }),
    }),
    ...directionField(input.kind),
    ...(input.loan === true ? { loan: true } : {}),
    ...(input.note ? { note: input.note } : {}),
    ...(input.counterTerms ? { counterTerms: input.counterTerms } : {}),
    ...(input.dueOn ? { dueOn: input.dueOn } : {}),
  };
}

function roundTermsOf(negotiation: Negotiation): { terms?: DealTerm[] } {
  const offered = offeredTermsOf(negotiation);
  return offered.length === 0 ? {} : { terms: offered.map((t) => ({ ...t })) };
}

function pushOurRound(
  state: GameState,
  negotiation: Negotiation,
  terms: DealTerms,
  opts: { repeats?: number; note?: string; pitch?: DealTerms["pitch"] } = {},
): { waitDays: number; respondsOn: string } {
  const waitDays = 0;
  const respondsOn = addDays(state.date, waitDays);
  const paymentYears = paymentYearsOf(terms.paymentYears);
  negotiation.rounds.push({
    date: state.date,
    by: "us",
    fee: terms.fee,
    weeklyWage: terms.weeklyWage,
    contractYears: terms.years,
    // 일시금은 라운드에 남기지 않는다 — 없는 값이 조건으로 굳는다
    ...(paymentYears === undefined ? {} : { paymentYears }),
    // 지위는 **나르기만 한다** — 계약에 적히는 것은 합의되는 순간이다 (transfer.md §11)
    ...(terms.squadStatus === undefined ? {} : { squadStatus: terms.squadStatus }),
    // 조건서의 사본 — 이 오퍼가 무엇을 싣고 나갔는지 (§12-3)
    ...roundTermsOf(negotiation),
    respondsOn: null,

    verdict: null,
    ...(opts.note ? { note: opts.note } : {}),
    ...(opts.pitch && opts.pitch.length > 0 ? { pitch: [...opts.pitch] } : {}),
  });
  return { waitDays, respondsOn };
}

export function respondOffer(
  state: GameState,
  input: {
    negotiationId: string;
    verdict: NegotiationVerdict;
    fee?: number;
    weeklyWage?: number;
    contractYears?: number;
    squadStatus?: SquadStatus;
    paymentYears?: number;
    feeOnly?: boolean;
    deadlineOn?: string;
    note?: string;
  },
): MarketCommandResult {
  const target = answerTarget(
    state,
    input.negotiationId,
    pendingOffer,
    "답할 오퍼가 없습니다 — 먼저 오퍼를 넣어야 합니다",
  );
  if (!target.ok) return target;
  const { negotiation, offer, player } = target;
  // 우리 오퍼만의 관문 — 상대는 답할 날이 오기 전에 답하지 않는다
  if (offer.respondsOn !== null && offer.respondsOn > state.date) {
    return {
      ok: false,
      message: `아직 답이 오지 않았습니다 — ${describeWait(diffDays(state.date, offer.respondsOn))}`,
    };
  }

  const renewing = negotiation.kind === "renew";
  const releasing = negotiation.kind === "release";
  const loaning = negotiation.kind === "loan";
  const countering = input.verdict === "counter";
  const counterYears = paymentYearsOf(input.paymentYears);
  const feeAsked = input.fee ?? offer.fee;
  const wageAsked = input.weeklyWage ?? offer.weeklyWage;
  const yearsAsked = input.contractYears ?? offer.contractYears;
  const statusAsked = input.squadStatus;
  const numberAsked = undefined;
  if (
    ![feeAsked, wageAsked].every((v) => Number.isFinite(v) && v >= 0) ||
    feeAsked > 1_000_000_000_000 ||
    wageAsked > 1_000_000_000 ||
    !Number.isInteger(yearsAsked) ||
    yearsAsked < 0 ||
    yearsAsked > 6
  )
    return { ok: false, message: "조건의 금액·기간 표현 범위를 확인해야 합니다" };
  const counterSeverance = releasing ? feeAsked : 0;
  const counterFee = renewing || releasing ? 0 : feeAsked;
  const counterWageDemand = renewing ? wageAsked : 0;
  const counterWage = renewing || releasing ? 0 : wageAsked;

  offer.verdict = input.verdict;
  if (input.note) offer.note = input.note;

  const deadlineOn = ((): string | undefined => {
    const asked = countering ? input.deadlineOn : undefined;
    if (asked === undefined || asked <= state.date) return undefined;
    const pulled = negotiation.expiresOn ? minDate(asked, negotiation.expiresOn) : asked;
    return pulled === negotiation.expiresOn ? undefined : pulled;
  })();
  if (deadlineOn !== undefined) negotiation.expiresOn = deadlineOn;
  const deadlineNote = deadlineOn === undefined ? "" : ` ${deadlineOn}까지 답을 달라고 합니다.`;

  const counterpart = counterpartOf(negotiation, player);
  const verdictCard = (rest: Partial<MarketCard>): MarketCard => ({
    ...verdictCardOf({
      player,
      counterpart,
      kind: negotiation.kind,
      verdict: input.verdict,
      offer,
      loan: loaning,
      // 기한이 걸린 조정은 그날이 곧 우리가 답해야 하는 날이다
      ...(deadlineOn === undefined ? {} : { dueOn: deadlineOn }),
      ...(input.note ? { note: input.note } : {}),
    }),
    ...rest,
  });

  if (input.verdict === "accept" && input.feeOnly && !releasing && !renewing) {
    negotiation.feeAgreed = {
      fee: offer.fee,
      ...(offer.paymentYears === undefined ? {} : { paymentYears: offer.paymentYears }),
      on: state.date,
    };
    if (negotiation.personal?.agreedOn) {
      offer.weeklyWage = negotiation.personal.weeklyWage;
      offer.contractYears = negotiation.personal.contractYears;
      offer.squadStatus = negotiation.personal.squadStatus;
      offer.terms = offeredTermsOf(negotiation);
      negotiation.status = "agreed";
    }
    pushNarrative(
      state,
      `${player.name} 이적료 합의 (${formatMoney(offer.fee)}) — 개인 조건 남음`,
      3,
    );
    return {
      ok: true,
      payload: verdictCard({}),
      message:
        `${josa(counterpart, "이/가")} 이적료 ${formatMoney(offer.fee)}${splitLabel(offer.paymentYears)}에 합의했습니다 — ` +
        `${player.name} 쪽과 개인 조건을 맞춰야 계약이 섭니다`,
    };
  }
  if (input.verdict === "accept") {
    negotiation.status = "agreed";
    if (releasing) {
      pushNarrative(state, `${player.name} 상호 계약 해지 합의 (${formatMoney(offer.fee)})`, 4);
      return {
        ok: true,
        payload: verdictCard({}),
        message:
          `${josa(player.name, "이/가")} 정산금 ${formatMoney(offer.fee)}${splitLabel(offer.paymentYears)}에 계약 해지를 받아들였습니다. ` +
          "계약서 서명이 남았습니다",
      };
    }
    if (renewing) {
      pushNarrative(state, `${player.name} 재계약 합의 (주급 ${formatMoney(offer.weeklyWage)})`, 4);
      return {
        ok: true,
        payload: verdictCard({}),
        message:
          `${josa(player.name, "이/가")} 주급 ${formatMoney(offer.weeklyWage)} · ${offer.contractYears}년 재계약을 받아들였습니다. ` +
          "계약서 서명이 남았습니다",
      };
    }
    pushNarrative(state, `${player.name} 이적 합의 (${formatMoney(offer.fee)})`, 4);
    return {
      ok: true,
      payload: verdictCard({}),
      message:
        `${josa(counterpart, "이/가")} 오퍼를 받아들였습니다 — ${player.name}, ${formatMoney(offer.fee)}${splitLabel(offer.paymentYears)}. ` +
        "계약서 서명이 남았습니다",
    };
  }

  if (input.verdict === "reject") {
    negotiation.status = "rejected";
    if (releasing) {
      return {
        ok: true,
        payload: verdictCard({}),
        message:
          `${josa(player.name, "이/가")} 해지를 거부했습니다 — 남은 길은 잔여 급여 전액을 무는 ` +
          `일방 해지(release_player · ${formatMoney(unilateralSeveranceOf(state, player.id))})입니다`,
      };
    }
    return {
      ok: true,
      payload: verdictCard({}),
      message: `${josa(counterpart, "이/가")} 거절했습니다 — ${player.name} 협상은 이번 창에서 끝났습니다`,
    };
  }

  // 조정 — 상대가 부르는 값 (범위는 위에서 이미 검증했다)
  if (releasing) {
    negotiation.rounds.push({
      date: state.date,
      by: "them",
      fee: counterSeverance,
      weeklyWage: 0,
      contractYears: 0,
      respondsOn: null,

      verdict: "counter",
      note: input.note,
      ...(counterYears === undefined ? {} : { paymentYears: counterYears }),
      ...(deadlineOn === undefined ? {} : { deadlineOn }),
    });
    return {
      ok: true,
      payload: verdictCard({
        counterTerms: dealTerms({
          severance: counterSeverance,
          ...(counterYears === undefined ? {} : { paymentYears: counterYears }),
        }),
      }),
      message:
        `${josa(player.name, "은/는")} 정산금 ${josa(`${formatMoney(counterSeverance)}${splitLabel(counterYears)}`, "을/를")} 원합니다. ` +
        `그 조건으로 다시 제안하면 받아들일 것입니다.${deadlineNote}`,
    };
  }
  if (renewing) {
    negotiation.rounds.push({
      date: state.date,
      by: "them",
      fee: 0,
      weeklyWage: counterWageDemand,
      contractYears: yearsAsked,
      respondsOn: null,

      verdict: "counter",
      note: input.note,
      ...(statusAsked === undefined ? {} : { squadStatus: statusAsked }),
      ...roundTermsOf(negotiation),
      ...(deadlineOn === undefined ? {} : { deadlineOn }),
    });
    return {
      ok: true,
      payload: verdictCard({
        counterTerms: dealTerms({ weeklyWage: counterWageDemand, years: yearsAsked }),
      }),
      message:
        `${josa(player.name, "은/는")} 주급 ${formatMoney(counterWageDemand)} · ${yearsAsked}년 계약` +
        `${josa(statusLabel(statusAsked), "을/를")} 원합니다. 그 조건으로 다시 제안하면 받아들일 것입니다.` +
        deadlineNote,
    };
  }
  negotiation.rounds.push({
    date: state.date,
    by: "them",
    fee: counterFee,
    weeklyWage: counterWage,
    contractYears: offer.contractYears,
    respondsOn: null,

    verdict: "counter",
    note: input.note,
    ...(counterYears === undefined ? {} : { paymentYears: counterYears }),
    ...(statusAsked === undefined ? {} : { squadStatus: statusAsked }),
    ...(numberAsked === undefined ? {} : { squadNumber: numberAsked }),
    ...roundTermsOf(negotiation),
    ...(deadlineOn === undefined ? {} : { deadlineOn }),
  });
  return {
    ok: true,
    payload: verdictCard({
      counterTerms: dealTerms({
        fee: counterFee,
        weeklyWage: counterWage,
        ...(counterYears === undefined ? {} : { paymentYears: counterYears }),
      }),
    }),
    message:
      `${counterpart}의 조정 — 이적료 ${formatMoney(counterFee)}${splitLabel(counterYears)} · 주급 ${formatMoney(counterWage)}` +
      `${statusLabel(statusAsked)}${numberLabel(numberAsked)}. 받아들이려면 그 조건으로 오퍼를 다시 넣으세요.` +
      deadlineNote,
  };
}

export function clearIssueReason(
  state: GameState,
  playerId: string,
  reason: PlayerIssueReason,
): boolean {
  const before = state.issues.length;
  state.issues = state.issues.filter((i) => !(i.gamePlayerId === playerId && i.reason === reason));
  return state.issues.length !== before;
}

export function listingOf(state: GameState, playerId: string) {
  return state.transferList.find((l) => l.gamePlayerId === playerId) ?? null;
}

export function setTransferList(
  state: GameState,
  input: { playerId: string; listed: boolean; askingPrice?: number; note?: string },
): CommandResult {
  const pick = pickSignedPlayer(state, input.playerId);
  if (!pick.ok) return { ok: false, message: pick.message };
  const player = pick.player;
  // 임대는 양방향 다 막힌다 — 나간 선수는 `teamId`가 남의 팀이고, 온 선수는 남의 계약이다
  const locked = loanLockOf(player);
  if (locked) return { ok: false, message: locked };

  const index = state.transferList.findIndex((l) => l.gamePlayerId === player.id);
  if (!input.listed) {
    if (index < 0)
      return { ok: false, message: `${josa(player.name, "은/는")} 이적 리스트에 없습니다` };
    state.transferList.splice(index, 1);
    const freed = clearIssueReason(state, player.id, "listed");
    return {
      ok: true,
      message:
        `${josa(player.name, "을/를")} 이적 리스트에서 뺐습니다` +
        (freed ? " · 등재 불만이 풀렸습니다" : ""),
      brief: { head: "이적 리스트", items: [item({ label: "해제", text: player.name })] },
    };
  }

  const askingPrice =
    input.askingPrice === undefined ? undefined : Math.max(0, Math.round(input.askingPrice));
  const listing = {
    gamePlayerId: player.id,
    ...(askingPrice === undefined ? {} : { askingPrice }),
    listedOn: state.date,
    ...(input.note === undefined ? {} : { note: input.note }),
  };
  if (index >= 0) state.transferList[index] = listing;
  else state.transferList.push(listing);

  const price = askingPrice === undefined ? "호가 미정" : `호가 ${formatMoney(askingPrice)}`;
  pushNarrative(state, `${player.name} 이적 리스트 등재 · ${price}`, 3);
  return {
    ok: true,
    message: `${player.name} 이적 리스트 등재 · ${price}`,
    brief: {
      head: "이적 리스트",
      items: [
        item({ label: "등재", text: player.name }),
        item({
          label: "호가",
          text: askingPrice === undefined ? "미정" : formatMoney(askingPrice),
        }),
      ],
    },
  };
}

const REQUEST_ANSWER_KO: Record<"accept" | "refuse", string> = {
  accept: "수락",
  refuse: "거부",
};

export function respondTransferRequest(
  state: GameState,
  input: {
    playerId: string;
    answer: "accept" | "refuse";
    askingPrice?: number;
    note?: string;
  },
): CommandResult {
  const pick = pickOurPlayer(state, input.playerId);
  if (!pick.ok) return { ok: false, message: pick.message };
  const player = pick.player;
  const found = transferRequestOf(state, player.id);
  if (!found) {
    return { ok: false, message: `${josa(player.name, "은/는")} 이적을 요청하지 않았습니다` };
  }
  if (found.answer !== undefined) {
    return {
      ok: false,
      message: `${player.name}의 이적 요청에는 이미 답했습니다 (${found.answeredOn} · ${REQUEST_ANSWER_KO[found.answer]})`,
    };
  }

  if (input.answer === "accept") {
    const listed = setTransferList(state, {
      playerId: player.id,
      listed: true,
      askingPrice: input.askingPrice,
      note: input.note,
    });
    if (!listed.ok) return listed;
  }
  answerTransferRequest(state, player.id, input.answer);
  const label = REQUEST_ANSWER_KO[input.answer];
  pushNarrative(state, `${player.name} 이적 요청 ${label}`, 4);
  return {
    ok: true,
    message: `${player.name} 이적 요청 ${label}${input.answer === "accept" ? " — 이적 리스트에 올렸습니다" : " — 거절 사실을 기록했습니다"}`,
  };
}

export function offerPlayerOut(
  state: GameState,
  input: {
    playerId: string;
    teamId: string;
    fee: number;
    weeklyWage?: number;
    years?: number;
    loan?: boolean;
    paymentYears?: number;
  },
): MarketCommandResult {
  const pick = pickSignedPlayer(state, input.playerId);
  if (!pick.ok) return { ok: false, message: pick.message };
  const player = pick.player;
  const locked = loanLockOf(player);
  if (locked) return { ok: false, message: locked };
  // 감독이 부른 구단 이름이 그대로 실려 온다 — 여기서 id로 굳힌다 (core/team-ref.ts)
  const picked = pickTeam(state, input.teamId);
  if (!picked.ok) return { ok: false, message: picked.message };
  const buyer = state.teams.find((t) => t.id === picked.teamId);
  if (!buyer)
    return {
      ok: false,
      message: `"${input.teamId}"${josaOf(input.teamId, "이라는/라는")} 구단을 찾지 못했습니다`,
    };
  if (buyer.id === state.userTeamId) {
    return { ok: false, message: "우리 구단에 팔 수는 없습니다" };
  }
  // 무소속은 구단이 아니라 구단이 없는 상태다 — 받을 장부가 없다 (transfer.md §2)
  if (!isClubTeam(buyer.id)) {
    return {
      ok: false,
      message: `${josa(teamName(buyer.id), "은/는")} 구단이 아닙니다 — 넘길 수 없습니다`,
    };
  }

  const kind: Negotiation["kind"] = input.loan ? "loan_out" : "sell";
  const conflict = conflictingNegotiation(state, player.id, kind);
  if (conflict) return { ok: false, message: kindConflictMessage(conflict, player.name) };
  const existing = state.negotiations.find(
    (n) =>
      n.gamePlayerId === player.id &&
      n.kind === kind &&
      n.counterpartTeamId === buyer.id &&
      n.status === "open",
  );
  if (existing) {
    const waiting = pendingOffer(existing);
    if (waiting && waiting.respondsOn !== null && waiting.respondsOn > state.date) {
      return {
        ok: false,
        message: `${player.name} 건은 아직 답을 기다리는 중입니다 — ${describeWait(diffDays(state.date, waiting.respondsOn))}`,
      };
    }
    if (existing.counterpartTeamId !== buyer.id) {
      return {
        ok: false,
        message: `${josa(player.name, "은/는")} ${josa(teamName(existing.counterpartTeamId ?? ""), "과/와")} 협상 중입니다 — 먼저 정리해야 합니다`,
      };
    }
  }

  const fee = Math.max(0, Math.round(input.fee));
  const weeklyWage = Math.round(input.weeklyWage ?? 0);
  const years = input.years ?? 0;
  const paymentYears = input.loan ? undefined : paymentYearsOf(input.paymentYears);
  const terms: DealTerms = {
    playerId: player.id,
    fee,
    weeklyWage,
    years,
    kind,
    counterpartTeamId: buyer.id,
    ...(paymentYears === undefined ? {} : { paymentYears }),
  };
  const odds = validateDeal(state, terms);
  if (odds.blockers.length > 0) {
    return { ok: false, message: `오퍼를 넣을 수 없습니다 — ${odds.blockers.join(" / ")}` };
  }

  const window = windowOpenForTeam(state, buyer.id);
  const negotiation: Negotiation =
    existing ??
    (() => {
      const created: Negotiation = {
        // id에도 갈래가 든다 — 같은 선수에게 같은 날 두 갈래를 열면 겹친다
        id: `neg-${kindSlug(kind)}-${player.id}-${buyer.id}-${state.date}-${state.negotiations.length + 1}`,
        gamePlayerId: player.id,
        kind,
        precontract: false,
        buyout: false,
        pitched: [],
        terms: [],
        counterpartTeamId: buyer.id,
        windowId: window?.id ?? null,
        openedOn: state.date,
        status: "open",
        rounds: [],
      };
      state.negotiations.push(created);
      return created;
    })();

  const { waitDays } = pushOurRound(state, negotiation, terms, {
    repeats: negotiation.rounds.filter((r) => r.by === "us").length,
  });

  const head = input.loan
    ? `${teamName(buyer.id)}에 ${player.name} 임대를 제안했습니다 — 임대료 ${formatMoney(fee)} · ` +
      `그쪽이 낼 주급 ${formatMoney(weeklyWage)}.`
    : `${teamName(buyer.id)}에 ${player.name} 매각을 제안했습니다 — 이적료 ${formatMoney(fee)}` +
      `${splitLabel(paymentYears)} · 주급 ${formatMoney(weeklyWage)} · ${years}년.`;
  const card: MarketCard = {
    kind: "offer",
    playerId: player.id,
    playerName: player.name,
    // 내보내는 오퍼의 상대는 **사려는 구단**이다 (market-card.ts의 `counterpart`)
    counterpart: teamName(buyer.id),
    terms: dealTerms({
      fee,
      weeklyWage,
      years,
      ...(paymentYears === undefined ? {} : { paymentYears }),
    }),

    ...directionField(kind),
    ...(input.loan ? { loan: true } : {}),
  };
  return {
    ok: true,
    payload: card,
    message: `${head} ${describePending(waitDays)}`,
  };
}

export function incomingOffer(negotiation: Negotiation) {
  const last = negotiation.rounds[negotiation.rounds.length - 1];
  return last && last.by === "them" && last.verdict === null ? last : null;
}

export function incomingOffers(state: GameState): Negotiation[] {
  return state.negotiations.filter(
    (n) =>
      (n.kind === "sell" || n.kind === "loan_out") &&
      n.status === "open" &&
      incomingOffer(n) !== null,
  );
}

export function pickBuyer(state: GameState, player: GamePlayer, rng: () => number): string | null {
  const position = naturalPositionOf(player).position;
  const value = marketValueOf(state, player);
  const options: string[] = [];
  const covered = new Set<string>();
  for (const p of state.players) {
    if (p.attributes.overall < player.attributes.overall) continue;
    if (naturalPositionOf(p).position !== position) continue;
    covered.add(p.teamId);
  }
  const financeOfTeam = new Map(state.finances.map((f) => [f.teamId, f] as const));
  for (const team of state.teams) {
    if (team.id === state.userTeamId) continue;
    // 사는 쪽 협회의 창이 열려 있어야 한다 — 우리 창과 다를 수 있다
    if (windowOpenForTeam(state, team.id) === null) continue;
    const finance = financeOfTeam.get(team.id);
    if (!finance || finance.transferBudget < value) continue;
    // 그 자리에 우리 선수보다 나은 자원이 없는 팀이 노린다
    if (covered.has(team.id)) continue;
    options.push(team.id);
  }
  if (options.length === 0) return null;
  const scale = stageScaleOf(state);
  const blockedHere = betterAtPosition(state, state.userTeamId, player);
  return pickWeighted(rng, options, (id) => suitorWeightOf(state, id, player, scale, blockedHere));
}

export function answerIncomingOffer(
  state: GameState,
  input: {
    negotiationId: string;
    verdict: NegotiationVerdict;
    fee?: number;
    weeklyWage?: number;
    note?: string;
  },
): MarketCommandResult {
  const target = answerTarget(
    state,
    input.negotiationId,
    incomingOffer,
    "답할 오퍼가 없습니다",
    // **내보내는 갈래는 둘 다 감독이 답한다.** 매각만 통과시키면 임대 송출에 붙은
    // 메디컬 재제안에 감독이 답할 길이 없어 철회밖에 남지 않는다 (transfer.md §5)
    (n) =>
      n.kind === "sell" || n.kind === "loan_out"
        ? null
        : "들어온 오퍼가 아닙니다 — 우리가 넣은 오퍼는 상대가 답합니다",
  );
  if (!target.ok) return target;
  const { negotiation, offer, player } = target;
  const counterpart = counterpartOf(negotiation, player);
  if (negotiation.buyout) {
    return {
      ok: false,
      message: `${player.name} 건은 바이아웃 조항 금액의 오퍼입니다 — 구단이 막을 수 없습니다`,
    };
  }
  const onTable = {
    playerId: player.id,
    fee: offer.fee,
    weeklyWage: offer.weeklyWage,
    years: offer.contractYears,
    // 분할 연수도 넘긴다 — 일시금으로 되부르면 예산 관문이 같은 분할 조정을 다시 세운다
    ...(offer.paymentYears === undefined ? {} : { paymentYears: offer.paymentYears }),
    // 갈래를 그대로 넘긴다 — 임대 송출을 매각으로 재면 임대료가 이적료 눈금에 걸린다
    kind: negotiation.kind,
    ...(negotiation.counterpartTeamId ? { counterpartTeamId: negotiation.counterpartTeamId } : {}),
  };

  if (input.verdict === "reject") {
    // 메디컬 재협상 여부는 상대가 적어 둔 메모로 갈린다 — 감독의 메모로 덮지 않는다
    const card = verdictCardOf({
      player,
      counterpart,
      kind: negotiation.kind,
      verdict: "reject",
      offer,
      ...(input.note ? { note: input.note } : {}),
    });
    offer.verdict = "reject";
    negotiation.status = "rejected";
    pushNarrative(
      state,
      `${player.name} 이적 제안 거절 — ${counterpart} ${formatMoney(offer.fee)}`,
      3,
    );
    return {
      ok: true,
      payload: card,
      message: `${counterpart}의 ${player.name} 오퍼를 거절했습니다`,
    };
  }

  if (input.verdict === "accept") {
    const shortfall = squadShortfall(state, state.userTeamId, player);
    if (shortfall) return { ok: false, message: `우리 ${squadShortfallText(shortfall, "sell")}` };
    // 메디컬을 보고 깎아 다시 부른 오퍼인가 — 소견 문구가 아니라 코드가 가른다
    const renegotiated = offer.origin === "medical";
    const card = verdictCardOf({
      player,
      counterpart,
      kind: negotiation.kind,
      verdict: "accept",
      offer,
      ...(input.note ? { note: input.note } : {}),
    });
    offer.verdict = "accept";
    negotiation.status = "agreed";
    return {
      ok: true,
      payload: card,
      message: renegotiated
        ? `${player.name} 메디컬 재협상안을 수락했습니다 — ${formatMoney(offer.fee)}. 계약서 서명이 남았습니다`
        : `${player.name} 매각에 합의했습니다 — ${formatMoney(offer.fee)}. 계약서 서명이 남았습니다`,
    };
  }

  if (input.fee === undefined || !Number.isFinite(input.fee) || input.fee < 0)
    return { ok: false, message: "감독이 명시한 조정 금액이 필요합니다" };
  const demanded = Math.round(input.fee);
  const wage = Math.round(input.weeklyWage ?? offer.weeklyWage);
  offer.verdict = "counter";
  const terms = { ...onTable, fee: demanded, weeklyWage: wage };
  const { waitDays } = pushOurRound(state, negotiation, terms, {
    ...(input.note ? { note: input.note } : {}),
  });
  return {
    ok: true,
    payload: verdictCardOf({
      player,
      counterpart,
      kind: negotiation.kind,
      verdict: "counter",
      offer,

      counterTerms: dealTerms({
        fee: demanded,
        weeklyWage: wage,
        paymentYears: terms.paymentYears,
      }),

      ...(input.note ? { note: input.note } : {}),
    }),
    message:
      `${player.name} 값으로 ${josa(formatMoney(demanded), "을/를")} 불렀습니다 — ` +
      describePending(waitDays),
  };
}

// ── 재계약 — 상대가 선수 본인이다 ─────────────────────────

export function expiringContracts(state: GameState, withinDays = 180) {
  const limit = addDays(state.date, withinDays);
  return playersOf(state, state.userTeamId)
    .map((player) => ({ player, contract: activeContract(state, player.id) }))
    .filter(
      (row): row is { player: GamePlayer; contract: NonNullable<typeof row.contract> } =>
        row.contract !== null && row.contract.until <= limit,
    )
    .sort((a, b) => (a.contract.until < b.contract.until ? -1 : 1));
}

export function openRenewal(
  state: GameState,
  input: {
    playerId: string;
    weeklyWage: number;
    years: number;
    squadStatus?: SquadStatus;
    terms?: readonly DealTerm[];
  },
): MarketCommandResult {
  // 임대 나간 선수도 계약은 우리 것이라 문을 지난다 — 그에게 맞는 답은 `validateDeal`의
  // 임대 잠금이 낸다("임대 중"), "우리 선수가 아니다"가 아니다 (transfer.md §2)
  const pick = pickSignedPlayer(state, input.playerId);
  if (!pick.ok) return { ok: false, message: pick.message };
  const player = pick.player;
  const promised = pendingContractOf(state, player.id);
  if (promised && promised.teamId !== state.userTeamId) {
    return {
      ok: false,
      message:
        `${josa(player.name, "은/는")} 이미 다른 구단과 약속했습니다 — ` +
        `${josa(teamName(promised.teamId), "과/와")} 사전 계약을 맺어 ${promised.since}에 떠납니다`,
    };
  }
  const conflict = conflictingNegotiation(state, player.id, "renew");
  if (conflict) return { ok: false, message: kindConflictMessage(conflict, player.name) };
  const existing = openNegotiationOfKind(state, player.id, "renew");
  const terms: DealTerms = {
    playerId: player.id,
    fee: 0,
    weeklyWage: input.weeklyWage,
    years: input.years,
    kind: "renew",
    ...(input.squadStatus === undefined ? {} : { squadStatus: input.squadStatus }),
    terms: previewTerms(existing, input.terms),
    refusedTerms: existing ? refusedTermsOf(existing) : 0,
  };
  const odds = validateDeal(state, terms);
  if (odds.blockers.length > 0) {
    return { ok: false, message: `재계약 협상을 열 수 없습니다 — ${odds.blockers.join(" / ")}` };
  }
  if (existing) {
    const waiting = pendingOffer(existing);
    if (waiting && waiting.respondsOn !== null && waiting.respondsOn > state.date) {
      return {
        ok: false,
        message: `${player.name} 재계약 제안은 아직 답을 기다리는 중입니다 — ${describeWait(diffDays(state.date, waiting.respondsOn))}`,
      };
    }
  }
  const negotiation: Negotiation =
    existing ??
    (() => {
      const created: Negotiation = {
        id: `neg-renew-${player.id}-${state.date}`,
        gamePlayerId: player.id,
        kind: "renew",
        precontract: false,
        buyout: false,
        pitched: [],
        terms: [],
        counterpartTeamId: null, // 상대는 선수 본인이다
        windowId: null, // 이적창과 무관
        openedOn: state.date,

        status: "open",
        rounds: [],
      };
      state.negotiations.push(created);
      return created;
    })();

  const termNotes = input.terms ? tableTerms(state, negotiation, input.terms).notes : [];
  const { waitDays } = pushOurRound(state, negotiation, terms, {
    repeats: negotiation.rounds.filter((r) => r.by === "us").length,
  });
  const until = activeContract(state, player.id)?.until;
  const cardNote = [
    ...(until ? [`현 계약 ${until} 만료`] : []),
    ...(input.squadStatus === undefined ? [] : [`${SQUAD_STATUS_KO[input.squadStatus]} 지위 제시`]),
  ].join(" · ");
  const card: MarketCard = {
    kind: "renewal",
    playerId: player.id,
    playerName: player.name,
    // 상대는 구단이 아니라 선수 본인이다 — 카드도 그렇게 말한다
    counterpart: player.name,
    terms: dealTerms({ weeklyWage: input.weeklyWage, years: input.years }),

    ...(cardNote ? { note: cardNote } : {}),
  };
  return {
    ok: true,
    payload: card,
    message:
      `${player.name}에게 재계약 제안 — 주급 ${formatMoney(input.weeklyWage)} · ${input.years}년` +
      `${statusLabel(input.squadStatus)}` +
      `${until ? ` (현 계약 ${until} 만료)` : ""}.${termsLabel(negotiation)} ${describePending(waitDays)}` +
      (termNotes.length > 0 ? ` ${termNotes.join(" ")}` : ""),
  };
}

// ── 계약 해지 — 상대가 선수 본인이다 ──────────────────

export function openRelease(
  state: GameState,
  input: { playerId: string; severance: number; paymentYears?: number },
): MarketCommandResult {
  // 재계약과 같은 자격이다 — 계약이 우리 것이면 문을 지나고, 임대 잠금은 `validateDeal`가 낸다
  const pick = pickSignedPlayer(state, input.playerId);
  if (!pick.ok) return { ok: false, message: pick.message };
  const player = pick.player;
  const paymentYears = paymentYearsOf(input.paymentYears);
  const terms: DealTerms = {
    playerId: player.id,
    fee: Math.max(0, Math.round(input.severance)),
    weeklyWage: 0,
    // 해지는 쓸 계약이 없는 협상이다 — 라운드의 연수도 0으로 남는다
    years: 0,
    kind: "release",
    ...(paymentYears === undefined ? {} : { paymentYears }),
  };
  const odds = validateDeal(state, terms);
  if (odds.blockers.length > 0) {
    return { ok: false, message: `해지 협상을 열 수 없습니다 — ${odds.blockers.join(" / ")}` };
  }
  const conflict = conflictingNegotiation(state, player.id, "release");
  if (conflict) return { ok: false, message: kindConflictMessage(conflict, player.name) };
  const existing = openNegotiationOfKind(state, player.id, "release");
  if (existing) {
    const waiting = pendingOffer(existing);
    if (waiting && waiting.respondsOn !== null && waiting.respondsOn > state.date) {
      return {
        ok: false,
        message: `${player.name} 해지 제안은 아직 답을 기다리는 중입니다 — ${describeWait(diffDays(state.date, waiting.respondsOn))}`,
      };
    }
  }
  const negotiation: Negotiation =
    existing ??
    (() => {
      const created: Negotiation = {
        id: `neg-release-${player.id}-${state.date}`,
        gamePlayerId: player.id,
        kind: "release",
        precontract: false,
        buyout: false,
        pitched: [],
        terms: [],
        counterpartTeamId: null, // 상대는 선수 본인이다
        windowId: null, // 이적창과 무관 — 옮겨 갈 구단이 없다
        openedOn: state.date,

        status: "open",
        rounds: [],
      };
      state.negotiations.push(created);
      return created;
    })();

  const { waitDays } = pushOurRound(state, negotiation, terms, {
    repeats: negotiation.rounds.filter((r) => r.by === "us").length,
  });
  const full = unilateralSeveranceOf(state, player.id);
  const card: MarketCard = {
    kind: "release",
    playerId: player.id,
    playerName: player.name,
    counterpart: player.name,
    terms: dealTerms({
      severance: terms.fee,
      ...(paymentYears === undefined ? {} : { paymentYears }),
    }),

    // 바깥값을 카드에 세운다 — 합의가 깨졌을 때 무는 값이 감독의 다음 판단이다
    note: `합의가 안 되면 일방 해지 ${formatMoney(full)}`,
  };
  return {
    ok: true,
    payload: card,
    message:
      `${player.name}에게 상호 계약 해지를 제안 — 정산금 ${formatMoney(terms.fee)}${splitLabel(paymentYears)} ` +
      `(합의가 안 되면 일방 해지는 ${formatMoney(full)}). ${describePending(waitDays, "release")}`,
  };
}

export function executeLoanOut(
  state: GameState,
  negotiation: Negotiation,
  agreed: Negotiation["rounds"][number],
): CommandResult {
  const player = playerById(state, negotiation.gamePlayerId);
  if (!player) return { ok: false, message: "선수를 찾지 못했습니다" };
  const borrowerTeamId = negotiation.counterpartTeamId;
  const borrowerFinance = state.finances.find((f) => f.teamId === borrowerTeamId);
  if (agreed.fee > 0 && borrowerFinance && agreed.fee > borrowerFinance.transferBudget) {
    negotiation.status = "expired";
    return {
      ok: false,
      message:
        `${josa(teamName(borrowerTeamId ?? ""), "이/가")} 임대료 ${josa(formatMoney(agreed.fee), "을/를")} 마련하지 못했습니다 — ` +
        `가용 ${formatMoney(borrowerFinance.transferBudget)}. 이 건은 무산됐습니다`,
    };
  }
  const contract = activeContract(state, player.id);
  const share = contract ? agreed.weeklyWage / Math.max(1, contract.weeklyWage) : 0.5;
  const res = loanPlayer(state, {
    playerId: player.id,
    teamId: negotiation.counterpartTeamId ?? "",
    wageShare: Math.max(0, Math.min(1, share)),
  });
  if (!res.ok) return res;
  negotiation.status = "completed";
  settlePlayerFee(state, {
    kind: "loan",
    player,
    payerTeamId: negotiation.counterpartTeamId ?? state.userTeamId,
    payeeTeamId: state.userTeamId,
    fee: agreed.fee,
  });
  return {
    ok: true,
    message: `${res.message} · 임대료 ${formatMoney(agreed.fee)}`,
    brief: {
      head: res.brief?.head ?? "임대",
      items: [
        ...(res.brief?.items ?? []),
        item({ label: "임대료", text: formatMoney(agreed.fee) }),
      ],
    },
  };
}

export function executeLoanIn(
  state: GameState,
  negotiation: Negotiation,
  agreed: Negotiation["rounds"][number],
): CommandResult {
  const player = playerById(state, negotiation.gamePlayerId);
  if (!player) return { ok: false, message: "선수를 찾지 못했습니다" };
  const from = negotiation.counterpartTeamId ?? player.teamId;
  if (player.teamId === state.userTeamId) {
    negotiation.status = "expired";
    return { ok: false, message: `${josa(player.name, "은/는")} 이미 우리 선수입니다` };
  }
  // 빌린 구단은 그 선수를 다시 빌려줄 수 없다 — 계약이 그쪽에 없다
  const locked = loanLockOf(player);
  if (locked) {
    negotiation.status = "expired";
    return { ok: false, message: locked };
  }
  const contract = activeContract(state, player.id);
  if (!contract) return { ok: false, message: `${josa(player.name, "은/는")} 계약이 없습니다` };
  const until = minDate(`${seasonYear(state.season) + 1}-06-30`, contract.until);

  const gate = affordabilityGate(state, {
    fee: agreed.fee,
    weeklyWage: agreed.weeklyWage,
    what: "임대",
  });
  if (gate) return gate;

  settlePlayerFee(state, {
    kind: "loan",
    player,
    payerTeamId: state.userTeamId,
    payeeTeamId: from,
    fee: agreed.fee,
  });

  // 우리가 내는 주급 비율 — `weeklyWagesOf`가 이 값으로 양쪽 부담을 가른다
  const wageShare = Math.max(0, Math.min(1, agreed.weeklyWage / Math.max(1, contract.weeklyWage)));
  state.transfers.push({
    id: `tr-loanin-${player.id}-${state.date}`,
    gamePlayerId: player.id,
    windowId: windowOpenOn(state.windows, state.date)?.id ?? null,
    fromTeamId: from,
    toTeamId: state.userTeamId,
    date: state.date,
    type: "loan",
    // 임대 행은 fee 0이 규약이다 (transfer.md §2) — 임대료는 settlePlayerFee가
    // 정산했고, 여기 실으면 매각 잔존가 훑기가 임대를 매각으로 읽는다
    fee: 0,
  });
  clearDepartedState(state, player, from);
  player.teamId = state.userTeamId;
  player.squadNumber = undefined;
  const squadNumber = assignSquadNumber(state.players, player);
  const numberAfter = numberLineageOf(state, state.userTeamId, squadNumber).past[0];
  player.loan = { fromTeamId: from, until, wageShare };
  // 임대의 조건은 출전 보장 하나다 — 빌려 온 선수에게 열 수 있는 약속이 그것뿐이다 (§12-3)
  const termNotes = settleLoanTerms(state, player, agreedTermsOf(negotiation, agreed));
  const slot = canRegisterFor(state, player, state.userTeamId);
  player.squadLevel = slot.ok ? "first" : "reserve";
  negotiation.status = "completed";

  pushNarrative(state, `${player.name} 임대 영입 (${teamName(from)} · ${until}까지)`, 4);
  return {
    ok: true,
    message:
      `${josa(player.name, "을/를")} ${teamName(from)}에서 임대로 데려왔습니다 — ${until}까지 · ` +
      `임대료 ${formatMoney(agreed.fee)} · 주급 ${Math.round(wageShare * 100)}% 부담` +
      ` · 등번호 ${squadNumber}번` +
      (slot.ok ? "" : ` ${registrationBlockText(slot.block)} — 2군으로 들어왔습니다`) +
      (termNotes.length > 0 ? ` · ${termNotes.join(" · ")}` : ""),
    brief: {
      head: "임대 영입",
      items: [
        item({ label: "영입", text: player.name, note: `${teamName(from)} · ${until}까지` }),
        item({ label: "임대료", text: formatMoney(agreed.fee) }),
        item({ label: "주급 부담", text: `${Math.round(wageShare * 100)}%` }),
        item({
          label: "등번호",
          text: `${squadNumber}번`,
          ...(numberAfter ? { note: `${numberAfter.name} 뒤 · ${numberAfter.seasons}시즌` } : {}),
        }),
        ...(slot.ok
          ? []
          : [item({ label: "등록", text: "2군", note: registrationBlockText(slot.block) })]),
      ],
    },
  };
}

export function agreedSquadStatus(
  state: GameState,
  negotiation: Negotiation,
  agreed: Negotiation["rounds"][number],
  player: GamePlayer,
): SquadStatus {
  if (agreed.squadStatus) return agreed.squadStatus;
  return derivedSquadStatus(state, player, state.userTeamId);
}

export function agreedSquadNumber(negotiation: Negotiation): number | undefined {
  return [...negotiation.rounds].reverse().find((r) => r.squadNumber !== undefined)?.squadNumber;
}

export function agreedTermsOf(
  negotiation: Negotiation,
  agreed: Negotiation["rounds"][number],
): DealTerm[] {
  return agreed.terms ?? offeredTermsOf(negotiation);
}

export function standingCounter(negotiation: Negotiation): Negotiation["rounds"][number] | null {
  if (negotiation.status !== "open") return null;
  const last = negotiation.rounds[negotiation.rounds.length - 1];
  return last && last.by === "them" && last.verdict === "counter" ? last : null;
}

export function acceptCounterTerms(
  state: GameState,
  negotiation: Negotiation,
  counter: Negotiation["rounds"][number],
): CommandResult {
  const player = playerById(state, negotiation.gamePlayerId);
  if (!player) return { ok: false, message: "선수를 찾지 못했습니다" };
  const playerId = negotiation.gamePlayerId;
  const paymentYears = counter.paymentYears;
  const status = counter.squadStatus;
  const resent: MarketCommandResult =
    negotiation.kind === "renew"
      ? openRenewal(state, {
          playerId,
          weeklyWage: counter.weeklyWage,
          years: counter.contractYears,
          terms: counter.terms,
          ...(status === undefined ? {} : { squadStatus: status }),
        })
      : negotiation.kind === "release"
        ? openRelease(state, {
            playerId,
            severance: counter.fee,
            ...(paymentYears === undefined ? {} : { paymentYears }),
          })
        : negotiation.kind === "sell" || negotiation.kind === "loan_out"
          ? offerPlayerOut(state, {
              playerId,
              // 내보내는 갈래의 상대는 선수의 소속이 아니라 거래 상대다 (§1)
              teamId: negotiation.counterpartTeamId ?? "",
              fee: counter.fee,
              weeklyWage: counter.weeklyWage,
              years: counter.contractYears,
              ...(negotiation.kind === "loan_out" ? { loan: true } : {}),
              ...(paymentYears === undefined ? {} : { paymentYears }),
            })
          : sendOffer(state, {
              playerId,
              fee: counter.fee,
              weeklyWage: counter.weeklyWage,
              years: counter.contractYears,
              terms: counter.terms,
              kind: negotiation.kind === "loan" ? "loan" : "buy",
              ...(paymentYears === undefined ? {} : { paymentYears }),
              ...(status === undefined ? {} : { squadStatus: status }),
            });
  if (resent.ok && counter.terms) {
    negotiation.terms = counter.terms.map((term) => ({ term, by: "us", on: state.date }));
    const last = negotiation.rounds.at(-1);
    if (last) last.terms = [...counter.terms];
  }
  const counterpart = counterpartOf(negotiation, player);
  if (!resent.ok) {
    return {
      ok: false,
      message: `${counterpart}의 조정을 그대로 받지 못했습니다 — ${resent.message}`,
    };
  }
  return {
    ok: true,
    message: `${counterpart}의 조정을 그대로 받아 다시 넣었습니다. ${resent.message}`,
  };
}

export function passMedicalGate(
  state: GameState,
  negotiation: Negotiation,
  _player: GamePlayer,
): CommandResult | null {
  void _player;
  const medical = negotiation.medical;
  if (!medical) return null;
  if (medical.status === "scheduled")
    return { ok: false, message: `메디컬 결과를 기다립니다 — ${medical.onDate}` };
  if (medical.status === "flagged" && !medical.overridden)
    return { ok: false, message: "메디컬 소견의 조건 영향을 재평가해야 합니다" };
  return null;
}

export function medicalFlagResult(
  state: GameState,
  negotiation: Negotiation,
  player: GamePlayer,
  concern: MedicalConcern,
): CommandResult {
  const note = medicalConcernText(concern);
  pushNarrative(state, `${player.name} 메디컬 소견 — ${note}`, 4);
  return {
    ok: true,
    message: `${player.name} 메디컬 소견 — ${note}. 조건을 재평가하고 감독의 결정을 기다립니다`,
  };
}

export function affordabilityGate(
  state: GameState,
  deal: {
    fee: number;
    weeklyWage: number;
    what: "영입" | "임대";
    skipWindow?: boolean;
    gamePlayerId?: string;
  },
): CommandResult | null {
  if (deal.skipWindow !== true && !windowOpenOn(state.windows, state.date)) {
    return {
      ok: false,
      message: `이적시장이 닫혀 있어 ${josa(deal.what, "을/를")} 확정할 수 없습니다`,
    };
  }
  const finance = state.finances.find((f) => f.teamId === state.userTeamId);
  if (!finance) return { ok: false, message: "재정 정보를 찾지 못했습니다" };
  if (finance.budgetFrozen && deal.fee > 0) {
    // 동결에는 두 출구가 있다 — PSR과 부채 (finance.md §9.2·§9.4)
    return {
      ok: false,
      message: `보드가 이적 예산을 동결했습니다${budgetFreezeLabel(state, state.userTeamId)} — 매각으로 예산을 만들어야 합니다`,
    };
  }
  // 오퍼 때 `validateDeal`가 잰 자와 같아야 한다 (transfer.md §11)
  const budget =
    deal.gamePlayerId === undefined
      ? finance.transferBudget
      : signingBudgetOf(state, deal.gamePlayerId);
  if (deal.fee > budget) {
    return {
      ok: false,
      message: `이적 예산이 부족합니다 — 필요 ${formatMoney(deal.fee)} / 가용 ${formatMoney(budget)}`,
    };
  }
  return wageRoomGate(state, deal.weeklyWage);
}

function wageRoomGate(state: GameState, weeklyWage: number): CommandResult | null {
  const room = userWageRoom(state);
  if (weeklyWage <= room) return null;
  return {
    ok: false,
    message:
      room <= 0
        ? "주급 여력이 없습니다 — 임금 총액이 이미 구단 한도를 넘었습니다"
        : `주급 여력이 부족합니다 — 주당 ${formatMoney(room)}까지 가능합니다`,
  };
}

export function executePrecontract(
  state: GameState,
  negotiation: Negotiation,
  agreed: Negotiation["rounds"][number],
  player: GamePlayer,
): CommandResult {
  const blocker = precontractBlockerOf(state, player);
  if (blocker) {
    negotiation.status = "expired";
    return { ok: false, message: `${blocker} — 이 사전 계약은 무산됐습니다` };
  }
  const gate = wageRoomGate(state, agreed.weeklyWage);
  if (gate) return gate;

  const fromTeamId = player.teamId;
  const since = precontractStartOf(state);
  const squadStatus = agreedSquadStatus(state, negotiation, agreed, player);
  const contract: Contract = {
    id: `c-pre-${player.id}-${state.date}`,
    gamePlayerId: player.id,
    teamId: state.userTeamId,
    weeklyWage: agreed.weeklyWage,
    since,
    until: contractUntil(since, agreed.contractYears),
    status: "pending",
    // 감독이 자리를 두고 흥정한 계약이다 — 빈 칸을 남기지 않는다 (people.md §5-2)
    squadStatus,
  };
  state.contracts.push(contract);
  // 조항과 사본은 지금 서고, 약속은 합류일에 장부에 선다 (§12-3)
  settleTermsOnSigning(state, contract, player, agreedTermsOf(negotiation, agreed), {
    pending: true,
  });
  negotiation.status = "completed";

  pushNarrative(state, `${player.name} 사전 계약 — ${teamName(fromTeamId)}에서 ${since} 합류`, 4);
  return {
    ok: true,
    message:
      `${player.name} 사전 계약 체결 — ${teamName(fromTeamId)}에서 ${since}에 합류합니다. ` +
      `주급 ${formatMoney(agreed.weeklyWage)} ${agreed.contractYears}년${statusLabel(squadStatus)}` +
      ` · 이적료는 없습니다` +
      ((contract.terms?.length ?? 0) > 0
        ? ` · 조건: ${(contract.terms ?? []).map(dealTermLabel).join(" · ")} (약속은 합류일에 장부에 섭니다)`
        : ""),
    brief: {
      head: "사전 계약 체결",
      items: [
        item({ label: "사전 계약", text: player.name, note: teamName(fromTeamId) }),
        item({
          label: "주급",
          text: formatMoney(agreed.weeklyWage),
          note: `${agreed.contractYears}년`,
        }),
        item({ label: "계약 지위", text: SQUAD_STATUS_KO[squadStatus] }),
        item({ label: "합류일", text: since }),
      ],
    },
  };
}

export function withdrawOffer(state: GameState, negotiationId: string): MarketCommandResult {
  const negotiation = state.negotiations.find((n) => n.id === negotiationId);
  if (!negotiation)
    return {
      ok: false,
      message: `협상 "${negotiationId}"${josaOf(negotiationId, "을/를")} 찾지 못했습니다`,
    };
  if (negotiation.status === "completed") {
    return { ok: false, message: "이미 완료된 이적입니다" };
  }
  const player = playerById(state, negotiation.gamePlayerId);
  const who = player?.name ?? negotiation.gamePlayerId;
  // 조항이 발동한 매각은 감독이 접을 수 없다 — 계약서가 그를 내보냈다 (transfer.md §12-3)
  if (negotiation.buyout) {
    return {
      ok: false,
      message: `${who} 건은 바이아웃 조항이 발동한 매각입니다 — 철회할 수 없습니다`,
    };
  }
  const card = (note?: string): MarketCard => ({
    kind: "withdraw",
    playerId: negotiation.gamePlayerId,
    playerName: who,
    // 상대가 선수 본인인 갈래는 구단 이름을 세우면 우리 팀에서 물러선 것처럼 읽힌다
    counterpart: isPlayerDeal(negotiation.kind)
      ? who
      : teamName(negotiation.counterpartTeamId ?? player?.teamId ?? ""),
    ...directionField(negotiation.kind),
    // 배지가 갈래를 말한다 — 예약을 접은 것과 영입을 접은 것은 다른 일이다 (§1-4)
    ...(negotiation.precontract ? { precontract: true } : {}),
    ...(note ? { note } : {}),
  });
  if (negotiation.rounds.length === 0 && negotiation.status === "open") {
    negotiation.status = "expired";
    return {
      ok: true,
      payload: card("오퍼 없이 접었다"),
      message: `${who}와 마주 앉은 자리를 접었습니다 — 오퍼는 없었습니다`,
    };
  }
  if (negotiation.medical?.status === "flagged") {
    negotiation.status = "expired";
    return {
      ok: true,
      payload: card("메디컬 소견 — 조건을 다시 짜서 부를 수는 있습니다"),
      message: `${who} 영입에서 물러섰습니다 — 메디컬 소견 때문입니다. 조건을 다시 짜서 부를 수는 있습니다`,
    };
  }
  negotiation.status = "rejected";
  return { ok: true, payload: card(), message: `${who} 협상을 철회했습니다` };
}

function medicalDecisionOutOfWindow(state: GameState, negotiation: Negotiation): boolean {
  const medical = negotiation.medical;
  if (!medical || medical.status !== "flagged" || medical.overridden === true) return false;
  if (!isIncomingDeal(negotiation)) {
    return windowOpenForTeam(state, receivingTeamOf(state, negotiation)) === null;
  }
  // 무소속 영입은 창과 무관하다 — 계약이 없는 선수는 언제든 데려온다
  const player = playerById(state, negotiation.gamePlayerId);
  if (player && !activeContract(state, player.id)) return false;
  return windowOpenOn(state.windows, state.date) === null;
}

export function standingDeadlineOf(negotiation: Negotiation): string | null {
  return negotiation.rounds.some((r) => r.by === "them" && r.deadlineOn === negotiation.expiresOn)
    ? (negotiation.expiresOn ?? null)
    : null;
}

export function expireNegotiations(state: GameState, digest: TickSink): void {
  for (const negotiation of state.negotiations) {
    if (negotiation.status !== "open" && negotiation.status !== "agreed") continue;
    if (medicalDecisionOutOfWindow(state, negotiation)) {
      negotiation.status = "expired";
      const player = playerById(state, negotiation.gamePlayerId);
      digest.push(
        `${player?.name ?? negotiation.gamePlayerId} 건은 메디컬 소견을 안은 채 이적창이 ` +
          `닫혔습니다 — 이 건은 무산됐습니다`,
      );
      pushNarrative(
        state,
        `${player?.name ?? negotiation.gamePlayerId} 메디컬 소견을 안은 채 창이 닫혀 무산`,
        4,
      );
      continue;
    }
    const deadline = standingDeadlineOf(negotiation);
    if (
      !isMandated(negotiation) &&
      negotiation.rounds.length > 0 &&
      negotiation.expiresOn === addDays(state.date, 1)
    ) {
      const player = playerById(state, negotiation.gamePlayerId);
      digest.push(
        deadline
          ? `${player?.name ?? negotiation.gamePlayerId} — 상대가 건 기한이 내일입니다. ` +
              `넘기면 협상이 끝납니다`
          : `${player?.name ?? negotiation.gamePlayerId} 협상이 내일 만료됩니다 — 오늘 안에 결정해야 합니다`,
      );
    }
    if (!negotiation.expiresOn || state.date <= negotiation.expiresOn) continue;
    const player = playerById(state, negotiation.gamePlayerId);
    const name = player?.name ?? negotiation.gamePlayerId;
    if (negotiation.rounds.length === 0) {
      negotiation.status = "expired";
      digest.push(`${name}와 마주 앉은 자리가 오퍼 없이 닫혔습니다`);
      continue;
    }
    if (deadline) {
      negotiation.status = "rejected";
      digest.push(`${name} — 상대가 건 기한이 지났습니다. 협상은 이번 창에서 끝났습니다`);
      // 이번 창에 다시 못 여는 문이라 기한 초과(3)보다 무겁다 (people.md §9)
      pushNarrative(state, `${name} 협상 결렬 — 상대가 건 기한 경과`, 4);
      continue;
    }
    negotiation.status = "expired";
    digest.push(`${name} 협상이 기한을 넘겨 무효가 됐습니다`);
    // 기한은 다시 열 수 있는 문이라 3 — 창이 닫힌 위의 건(4)보다 한 눈금 가볍다
    pushNarrative(state, `${name} 협상 기한 초과로 무효`, 3);
  }
}

export function pendingVerdicts(state: GameState): Array<{
  negotiation: Negotiation;
  action: "respond_offer" | "start_negotiation";
  label: string;
  subject: string;
}> {
  const out: Array<{
    negotiation: Negotiation;
    action: "respond_offer" | "start_negotiation";
    label: string;
    subject: string;
  }> = [];
  for (const negotiation of state.negotiations) {
    if (isMandated(negotiation)) continue;
    const player = playerById(state, negotiation.gamePlayerId);
    // 라벨은 방향을 함께 싣는다 — 이름만 서면 GM이 사는 건지 파는 건지 뒤집는다
    const deadline = standingDeadlineOf(negotiation);
    // 상대가 건 기한은 **오늘 답해야 하는 이유**라 주의 줄이 그것을 함께 든다 (§12-1)
    const who =
      `${player?.name ?? negotiation.gamePlayerId} ${negotiationKindKo(negotiation)}` +
      (deadline ? ` (상대가 건 기한 ${deadline})` : "");
    if (negotiation.status === "agreed") {
      const medical = negotiation.medical;
      if (medical?.status === "scheduled") continue;
      out.push({
        negotiation,
        action: "start_negotiation",
        subject: who,
        label:
          medical?.status === "flagged"
            ? isIncomingDeal(negotiation)
              ? `${who} 메디컬 소견 — ${medicalNoteText(medical)} · 강행하려면 start_negotiation으로 테이블을 열어 서명, 물러서려면 withdraw_offer`
              : // 상대 구단의 소견이라 우리가 강행할 것이 없다 — 깎인 값에 합의한 상태다
                `${who} 상대 메디컬 소견을 반영한 값에 합의했습니다 — start_negotiation으로 테이블을 열어 서명해야 합니다`
            : // 검진은 통과했는데 아직 합의 상태다 = 계약이 걸렸다 (예산·명단 등)
              medical?.status === "passed"
              ? `${who} 메디컬은 통과했으나 계약이 확정되지 않았습니다 — start_negotiation으로 테이블을 열어 다시 서명`
              : `${who} 합의됨 — start_negotiation으로 테이블을 열어 서명해야 합니다`,
      });
      continue;
    }
    if (negotiation.status !== "open") continue;
    if (incomingOffer(negotiation)) {
      out.push({
        negotiation,
        action: "respond_offer",
        subject: who,
        label: `${who} 상대 오퍼 도착 — respond_offer로 답해야 합니다`,
      });
      continue;
    }
    if (standingCounter(negotiation)) {
      out.push({
        negotiation,
        action: "start_negotiation",
        subject: who,
        label: `${who} 상대가 조정을 되불렀습니다 — 그대로 받으려면 start_negotiation으로 테이블을 열어 받는다, 아니면 다시 제안`,
      });
      continue;
    }
    // 선수 쪽이 되부른 개인 조건 — 감독의 차례다 (§12-3)
    if (
      !pendingOffer(negotiation) &&
      negotiation.personal?.counter &&
      negotiation.personal.agreedOn === undefined
    ) {
      out.push({
        negotiation,
        action: "start_negotiation",
        subject: who,
        label: `${who} 선수 쪽이 개인 조건을 되불렀습니다 — 그대로 받으려면 start_negotiation으로 테이블을 열어 받는다, 아니면 다시 제안`,
      });
    }
  }
  return out;
}

export function describeNegotiations(state: GameState): string {
  const live = state.negotiations.filter((n) => n.status === "open" || n.status === "agreed");
  if (live.length === 0) return "진행 중인 협상 없음";
  return live
    .map((n) => {
      const player = playerById(state, n.gamePlayerId);
      const last = n.rounds[n.rounds.length - 1];
      const name = player?.name ?? n.gamePlayerId;
      const counterpart = teamName(n.counterpartTeamId ?? "");
      const who = isPlayerDeal(n.kind)
        ? name
        : directionOfKind(n.kind) === "out"
          ? `${name} → ${counterpart}`
          : `${name}(${counterpart})`;
      const moneyKo = n.kind === "release" ? "정산금" : "오퍼";
      const direction = negotiationKindKo(n);
      const deadline = standingDeadlineOf(n);
      const bids = competingBidsOn(state, n.gamePlayerId).length;
      const marks =
        (deadline === null ? "" : ` · 상대가 건 기한 ${deadline}`) +
        (bids === 0 ? "" : ` · 경쟁 입찰 ${bids}건`) +
        (n.feeAgreed ? ` · 이적료 합의 ${formatMoney(n.feeAgreed.fee)}` : "") +
        // 맡긴 협상은 감독이 답할 자리가 아니다 — 그 사실이 줄에 서야 GM이 다시 묻지 않는다 (§12-4)
        (isMandated(n) ? ` · 단장에게 맡김 (${mandateLimitText(n.mandate!, n.kind)})` : "");
      if (n.status === "agreed") {
        const medical = describeMedical(state, n);
        return `${n.id} ${who} ${direction}${marks} — 합의됨, ${medical ?? "확정 대기"}`;
      }
      if (!last) {
        const personal = n.personal;
        if (personal?.agreedOn) {
          return `${n.id} ${who} ${direction}${marks} — 개인 조건 합의 (주급 ${formatMoney(personal.weeklyWage)} · ${personal.contractYears}년), 이적료 오퍼를 기다립니다`;
        }
        if (personal?.counter) {
          return `${n.id} ${who} ${direction}${marks} — 개인 조건 조정 도착 (주급 ${formatMoney(personal.counter.weeklyWage)} · ${personal.counter.contractYears}년)`;
        }
        if (personal) {
          return `${n.id} ${who} ${direction}${marks} — 개인 조건 제안 중 (주급 ${formatMoney(personal.weeklyWage)} · ${personal.contractYears}년)`;
        }
        return `${n.id} ${who} ${direction}${marks} — 조건 문의 중`;
      }
      // 분할은 방향과 같은 이유로 어느 줄에서든 함께 적는다 (transfer.md §1·§5-2)
      const split = splitLabel(last.paymentYears);
      if (last.by === "them") {
        // 내보내는 갈래는 상대가 **오퍼**를 낸 것이고, 데려오는 갈래는 **조정**이다
        if (n.kind === "sell" || n.kind === "loan_out") {
          return `${n.id} ${who} ${direction}${marks} — 상대 오퍼 ${formatMoney(last.fee)}${split} 도착, 답이 필요합니다`;
        }
        // 재계약의 조정은 이적료가 아니라 주급과 연수다
        if (n.kind === "renew") {
          return `${n.id} ${who} ${direction}${marks} — 조정 주급 ${formatMoney(last.weeklyWage)} · ${last.contractYears}년 도착`;
        }
        return `${n.id} ${who} ${direction}${marks} — 조정 ${moneyKo} ${formatMoney(last.fee)}${split} 도착`;
      }
      const waiting =
        last.respondsOn !== null && last.respondsOn > state.date
          ? describeWait(diffDays(state.date, last.respondsOn))
          : "답 도착 — 판정 필요";
      return `${n.id} ${who} ${direction}${marks} — 우리 ${moneyKo} ${formatMoney(last.fee)}${split} (${waiting})`;
    })
    .join("\n");
}

export function describeNegotiation(state: GameState, negotiationId: string): string {
  const negotiation = state.negotiations.find((n) => n.id === negotiationId);
  if (!negotiation)
    return `협상 "${negotiationId}"${josaOf(negotiationId, "을/를")} 찾지 못했습니다`;
  const player = playerById(state, negotiation.gamePlayerId);
  const name = player?.name ?? negotiation.gamePlayerId;
  const kindKo = negotiationKindKo(negotiation);
  const lines = [
    // 상대가 선수 본인인 갈래는 구단 칸이 비어 `()`만 남는다 — 갈래는 어느 쪽이든 선다
    (isPlayerDeal(negotiation.kind)
      ? `${name} (${kindKo})`
      : `${name} (${teamName(negotiation.counterpartTeamId ?? "")}) ${kindKo}`) +
      ` — ${negotiation.status}`,
    ...(negotiation.expiresOn ? [`기한 ${negotiation.expiresOn}`] : []),
    ...negotiation.rounds.map(
      (r) =>
        `  ${r.date} ${r.by === "us" ? "우리" : "상대"} ` +
        (negotiation.kind === "release"
          ? `정산금 ${formatMoney(r.fee)}`
          : `${formatMoney(r.fee)} / ${formatMoney(r.weeklyWage)} ${r.contractYears}년`) +
        splitLabel(r.paymentYears) +
        `${r.verdict ? ` → ${r.verdict}` : r.respondsOn ? ` (답 ${r.respondsOn})` : ""}` +
        `${r.note ? ` — ${r.note}` : ""}` +
        (r.pitch && r.pitch.length > 0
          ? `\n      설득: ${r.pitch.map((c) => c.note).join(" · ")}`
          : ""),
    ),
  ];
  const medical = describeMedical(state, negotiation);
  if (medical) lines.push(`메디컬: ${medical}`);
  lines.push(...describeTermSheet(state, negotiation));
  lines.push(...describePersonal(negotiation, state.date));
  if (negotiation.pitched.length > 0)
    lines.push(`감독이 한 설득: ${negotiation.pitched.join(" · ")}`);
  return lines.join("\n");
}

function describePersonal(negotiation: Negotiation, today: string): string[] {
  const personal = negotiation.personal;
  if (!personal) return [];
  const line = (t: { weeklyWage: number; contractYears: number; squadStatus?: SquadStatus }) =>
    `주급 ${formatMoney(t.weeklyWage)} · ${t.contractYears}년${statusLabel(t.squadStatus)}`;
  if (personal.agreedOn) return [`개인 조건: ${personal.agreedOn} 합의 — ${line(personal)}`];
  return [
    `개인 조건: ${personal.proposedOn} 제안 — ${line(personal)}` +
      (personal.counter
        ? ` → 선수 쪽 조정 ${line(personal.counter)}`
        : personal.respondsOn > today
          ? ` (답 ${personal.respondsOn})`
          : " (답 도착 — 판정 필요)"),
  ];
}

export function minDate(a: string, b: string): string {
  return a <= b ? a : b;
}

// ── AI 구단의 계약 관리 ─────────────────────────────────

export const AI_RENEWAL_WINDOW_DAYS = 240;

export const AI_RENEWAL_CHANCE = 0.02;

export const RENEWAL_URGENCY_STARTER = 2.2;

export const RENEWAL_URGENCY_ROTATION = 1.2;

export const RENEWAL_URGENCY_FRINGE = 0.5;

export const RENEWAL_VETERAN_AGE = 33;

export const RENEWAL_VETERAN_URGENCY = 0.3;

export const RENEWAL_YOUNG_AGE = 24;

export const RENEWAL_YOUNG_URGENCY = 1.4;

export const RENEWAL_YEARS_MIN = 2;

export const RENEWAL_YEARS_SPAN = 3;

export const RENEWAL_WAGE_BASE = 1.05;

export const RENEWAL_WAGE_SPAN = 0.25;

// ── 마주 앉기 · 조건서 · 개인 조건 (transfer.md §12-2 · §12-3) ──────────────

export type TalksKind = Negotiation["kind"];

export function openTalks(
  state: GameState,
  input: { playerId: string; kind?: TalksKind; counterpartTeamId?: string },
): { ok: false; message: string } | { ok: true; negotiation: Negotiation; opened: boolean } {
  const pick = pickAnyPlayer(state, input.playerId);
  if (!pick.ok) return { ok: false, message: pick.message };
  const player = pick.player;
  // 빌려 온 선수는 우리 스쿼드에 있어도 우리 선수가 아니다 — 원소속과 영입을 이야기한다 (§2)
  const loanee = loanedInBy(state, player);
  const ours = player.teamId === state.userTeamId && !loanee;
  const kind: TalksKind = input.kind ?? (ours ? "renew" : "buy");
  const outgoing = kind === "sell" || kind === "loan_out";
  let counterpartTeamId =
    kind === "renew" || kind === "release" ? null : contractOwnerOf(state, player);
  if (outgoing) {
    if (!ours || !input.counterpartTeamId)
      return { ok: false, message: "소유 선수와 상대 구단을 지정해야 합니다" };
    const picked = pickTeam(state, input.counterpartTeamId);
    if (!picked.ok) return picked;
    if (picked.teamId === state.userTeamId || !isClubTeam(picked.teamId))
      return { ok: false, message: "다른 구단을 지정해야 합니다" };
    counterpartTeamId = picked.teamId;
  }
  const already = state.negotiations.find(
    (n) =>
      n.gamePlayerId === player.id &&
      n.kind === kind &&
      n.counterpartTeamId === counterpartTeamId &&
      (n.status === "open" || n.status === "agreed"),
  );
  if (already) return { ok: true, negotiation: already, opened: false };

  const lock = loanLockOf(player);
  if (lock && !(kind === "buy" && loanee)) return { ok: false, message: lock };
  if (kind === "renew" || kind === "release") {
    if (!ours) return { ok: false, message: `${josa(player.name, "은/는")} 우리 선수가 아닙니다` };
    if (!activeContract(state, player.id)) {
      return { ok: false, message: `${player.name}에게 재계약할 계약이 없습니다` };
    }
  } else if (!outgoing) {
    if (ours) return { ok: false, message: `${josa(player.name, "은/는")} 이미 우리 선수입니다` };
    const window = windowOpenOn(state.windows, state.date);
    // 사전 계약의 창은 계약의 만료일이 연다 — 협회의 창이 닫혀 있어도 앉을 수 있다 (§1-4)
    const precontractOpen =
      kind === "buy" && contractYearsLeft(state, player.id) * 365 <= PRECONTRACT_DAYS;
    if (!window && !precontractOpen && !isFreeAgent(player)) {
      return { ok: false, message: "이적시장이 닫혀 있습니다" };
    }
  }
  const conflict = outgoing ? null : conflictingNegotiation(state, player.id, kind);
  if (conflict) return { ok: false, message: kindConflictMessage(conflict, player.name) };
  const negotiation: Negotiation = {
    id: `neg-${kindSlug(kind)}-${player.id}-${counterpartTeamId ?? "player"}-${state.date}-${state.negotiations.length + 1}`,
    gamePlayerId: player.id,
    kind,
    precontract:
      kind === "buy" &&
      !windowOpenOn(state.windows, state.date) &&
      !isFreeAgent(player) &&
      contractYearsLeft(state, player.id) * 365 <= PRECONTRACT_DAYS,
    buyout: false,
    pitched: [],
    terms: [],
    counterpartTeamId,
    windowId:
      kind === "renew" || kind === "release"
        ? null
        : (windowOpenOn(state.windows, state.date)?.id ?? null),
    openedOn: state.date,

    status: "open",
    rounds: [],
  };
  state.negotiations.push(negotiation);
  pushNarrative(state, `${player.name} ${KIND_KO[kind]} — 마주 앉았다`, 2);
  return { ok: true, negotiation, opened: true };
}

export function offerTerms(
  state: GameState,
  input: { negotiationId: string; terms: readonly DealTerm[] },
): CommandResult {
  const negotiation = state.negotiations.find((n) => n.id === input.negotiationId);
  if (!negotiation) {
    return {
      ok: false,
      message: `협상 "${input.negotiationId}"${josaOf(input.negotiationId, "을/를")} 찾지 못했습니다`,
    };
  }
  if (negotiation.status !== "open") {
    return { ok: false, message: `이미 끝난 협상입니다 (${negotiation.status})` };
  }
  if (termKindsOf(negotiation).length === 0) {
    return { ok: false, message: `${negotiationKindKo(negotiation)} 협상에는 걸 조건이 없습니다` };
  }
  const { tabled, notes } = tableTerms(state, negotiation, input.terms);
  if (tabled.length && negotiation.personal) delete negotiation.personal.agreedOn;
  if (tabled.length === 0) {
    return { ok: false, message: notes.join(" ") || "올릴 조건이 없습니다" };
  }
  const player = playerById(state, negotiation.gamePlayerId);
  const name = player?.name ?? negotiation.gamePlayerId;
  return {
    ok: true,
    message:
      `${name} 조건서에 올렸습니다 — ${tabled.map(dealTermLabel).join(" · ")}. ` +
      `조건서: ${offeredTermsOf(negotiation).map(dealTermLabel).join(" · ")}` +
      (notes.length > 0 ? ` (${notes.join(" / ")})` : ""),
    brief: {
      head: "조건",
      items: tabled.map((term) =>
        item({ label: DEAL_TERM_KO[term.kind], text: dealTermLabel(term) }),
      ),
    },
  };
}

export function answerTerm(
  state: GameState,
  input: { negotiationId: string; kind: DealTermKind; answer: "granted" | "refused" },
): CommandResult {
  const negotiation = state.negotiations.find((n) => n.id === input.negotiationId);
  if (!negotiation) {
    return {
      ok: false,
      message: `협상 "${input.negotiationId}"${josaOf(input.negotiationId, "을/를")} 찾지 못했습니다`,
    };
  }
  if (negotiation.status !== "open") {
    return { ok: false, message: `이미 끝난 협상입니다 (${negotiation.status})` };
  }
  const answered = answerTermAsk(negotiation, input.kind, input.answer);
  if (!answered.ok) return { ok: false, message: answered.message };
  if (negotiation.personal) delete negotiation.personal.agreedOn;
  const player = playerById(state, negotiation.gamePlayerId);
  const name = player?.name ?? negotiation.gamePlayerId;
  return {
    ok: true,
    message:
      input.answer === "granted"
        ? `${name} 쪽이 부른 ${dealTermLabel(answered.term)}${josaOf(dealTermLabel(answered.term), "을/를")} 들어줬습니다 — 조건서에 섰습니다`
        : `${name} 쪽이 부른 ${dealTermLabel(answered.term)}${josaOf(dealTermLabel(answered.term), "을/를")} 거절했습니다`,
  };
}

export function proposePersonal(
  state: GameState,
  input: {
    negotiationId?: string;
    playerId?: string;
    weeklyWage: number;
    years: number;
    squadStatus?: SquadStatus;
    terms?: readonly DealTerm[];
  },
): CommandResult {
  let negotiation = input.negotiationId
    ? (state.negotiations.find((n) => n.id === input.negotiationId) ?? null)
    : null;
  if (!negotiation) {
    if (!input.playerId) return { ok: false, message: "누구와의 개인 조건인지 알 수 없습니다" };
    const talks = openTalks(state, { playerId: input.playerId, kind: "buy" });
    if (!talks.ok) return { ok: false, message: talks.message };
    negotiation = talks.negotiation;
  }
  if (negotiation.status !== "open") {
    return { ok: false, message: `이미 끝난 협상입니다 (${negotiation.status})` };
  }
  if (negotiation.kind !== "buy" && negotiation.kind !== "loan") {
    return {
      ok: false,
      message: `${negotiationKindKo(negotiation)} 협상에는 개인 조건을 따로 제안할 자리가 없습니다 — 제안 자체가 개인 조건입니다`,
    };
  }
  const player = playerById(state, negotiation.gamePlayerId);
  if (!player) return { ok: false, message: "선수를 찾지 못했습니다" };
  if (!Number.isFinite(input.weeklyWage) || input.weeklyWage < 0 || input.years < 1) {
    return { ok: false, message: "주급과 연수가 있어야 개인 조건입니다" };
  }
  const termNotes = input.terms ? tableTerms(state, negotiation, input.terms).notes : [];
  const squadStatus = negotiation.kind === "loan" ? undefined : input.squadStatus;
  const terms: DealTerms = {
    playerId: player.id,
    fee: 0,
    weeklyWage: input.weeklyWage,
    years: input.years,
    kind: negotiation.kind,
    counterpartTeamId: negotiation.counterpartTeamId ?? player.teamId,
    ...(squadStatus === undefined ? {} : { squadStatus }),
    pitched: negotiation.pitched,
    terms: offeredTermsOf(negotiation),
    refusedTerms: refusedTermsOf(negotiation),
  };
  const odds = validateDeal(state, terms);
  // 무소속·창·주급 여력의 문은 오퍼와 같다 — 이적료가 없어 예산 문만 비어 있다
  const blockers = odds.blockers.filter((b) => !b.startsWith("이적 예산"));
  if (blockers.length > 0) {
    return { ok: false, message: `개인 조건을 제안할 수 없습니다 — ${blockers.join(" / ")}` };
  }
  const waitDays = 0;
  negotiation.personal = {
    weeklyWage: Math.round(input.weeklyWage),
    contractYears: input.years,
    ...(squadStatus === undefined ? {} : { squadStatus }),
    proposedOn: state.date,
    respondsOn: addDays(state.date, waitDays),
  };
  return {
    ok: true,
    message:
      `${player.name} 쪽에 개인 조건 제안 — 주급 ${formatMoney(input.weeklyWage)} · ${input.years}년` +
      `${statusLabel(squadStatus)}.${termsLabel(negotiation)} 평가 처리 대기. ` +
      describePending(waitDays) +
      (termNotes.length > 0 ? ` ${termNotes.join(" ")}` : ""),
    brief: {
      head: "개인 조건 제안",
      items: [
        item({ label: "선수", text: player.name }),
        item({ label: "주급", text: formatMoney(input.weeklyWage), note: `${input.years}년` }),
        ...(squadStatus === undefined
          ? []
          : [item({ label: "계약 지위", text: SQUAD_STATUS_KO[squadStatus] })]),
      ],
    },
  };
}

export function answerPersonal(
  state: GameState,
  input: {
    negotiationId: string;
    verdict: NegotiationVerdict;
    weeklyWage?: number;
    contractYears?: number;
    squadStatus?: SquadStatus;
    note?: string;
    terms?: DealTerm[];
    hopeless?: boolean;
  },
): MarketCommandResult {
  const negotiation = state.negotiations.find((n) => n.id === input.negotiationId);
  if (!negotiation) {
    return {
      ok: false,
      message: `협상 "${input.negotiationId}"${josaOf(input.negotiationId, "을/를")} 찾지 못했습니다`,
    };
  }
  if (negotiation.status !== "open") {
    return { ok: false, message: `이미 끝난 협상입니다 (${negotiation.status})` };
  }
  const personal = personalAwaiting(negotiation);
  if (!personal) return { ok: false, message: "답할 개인 조건 제안이 없습니다" };
  if (personal.respondsOn > state.date) {
    return {
      ok: false,
      message: `아직 답이 오지 않았습니다 — ${describeWait(diffDays(state.date, personal.respondsOn))}`,
    };
  }
  const player = playerById(state, negotiation.gamePlayerId);
  if (!player) return { ok: false, message: "선수를 찾지 못했습니다" };
  const line = (t: { weeklyWage: number; contractYears: number; squadStatus?: SquadStatus }) =>
    `주급 ${formatMoney(t.weeklyWage)} · ${t.contractYears}년${statusLabel(t.squadStatus)}`;
  const card = (verdict: NegotiationVerdict, counterTerms?: MarketTerms): MarketCard => ({
    kind: "verdict",
    playerId: player.id,
    playerName: player.name,
    counterpart: counterpartOf(negotiation, player),
    terms: dealTerms({ weeklyWage: personal.weeklyWage, years: personal.contractYears }),
    verdict,
    ...(counterTerms ? { counterTerms } : {}),
    ...directionField(negotiation.kind),
    ...(negotiation.kind === "loan" ? { loan: true } : {}),
    ...(input.note ? { note: input.note } : {}),
  });
  if (input.verdict === "accept") {
    personal.agreedOn = state.date;
    delete personal.counter;
    if (negotiation.feeAgreed) {
      const accepted = [...negotiation.rounds]
        .reverse()
        .find((r) => r.by === "us" && r.verdict === "accept");
      if (accepted) {
        accepted.weeklyWage = personal.weeklyWage;
        accepted.contractYears = personal.contractYears;
        accepted.squadStatus = personal.squadStatus;
        accepted.terms = offeredTermsOf(negotiation);
      }
      negotiation.status = "agreed";
      pushNarrative(
        state,
        `${player.name} 이적 합의 (${formatMoney(negotiation.feeAgreed.fee)})`,
        4,
      );
      return {
        ok: true,
        payload: card("accept"),
        message:
          `${player.name} 쪽이 개인 조건을 받아들였습니다 — ${line(personal)}. 이적료는 이미 합의돼 있습니다. ` +
          "계약서 서명이 남았습니다",
      };
    }
    return {
      ok: true,
      payload: card("accept"),
      message: `${player.name} 쪽이 개인 조건을 받아들였습니다 — ${line(personal)}. 남은 것은 ${teamName(negotiation.counterpartTeamId ?? player.teamId)}과의 값입니다`,
    };
  }
  if (input.verdict === "reject") {
    if (input.hopeless) {
      negotiation.status = "rejected";
      pushNarrative(state, `${player.name} 개인 조건 결렬`, 3);
      return {
        ok: true,
        payload: card("reject"),
        message: `${player.name} 쪽이 개인 조건을 물렸습니다 — 협상은 이번 창에서 끝났습니다`,
      };
    }
    delete negotiation.personal;
    return {
      ok: true,
      payload: card("reject"),
      message: `${player.name} 쪽이 개인 조건을 물렸습니다 — 다시 제안할 수 있습니다`,
    };
  }
  const wage = input.weeklyWage ?? personal.weeklyWage;
  const status = input.squadStatus;
  if (!Number.isFinite(wage) || wage < 0 || wage > 1_000_000_000)
    return { ok: false, message: "유효한 주급이 필요합니다" };
  personal.counter = {
    weeklyWage: wage ?? personal.weeklyWage,
    contractYears: input.contractYears ?? personal.contractYears,
    ...(status === undefined ? {} : { squadStatus: status }),
    on: state.date,
    terms: input.terms,
    ...(input.note ? { note: input.note } : {}),
  };
  return {
    ok: true,
    payload: card(
      "counter",
      dealTerms({ weeklyWage: personal.counter.weeklyWage, years: personal.counter.contractYears }),
    ),
    message: `${player.name} 쪽의 조정 — ${line(personal.counter)}. 그 조건으로 다시 제안하면 받아들일 것입니다`,
  };
}

function describeWait(days: number): string {
  return `${days}일 뒤 예약된 응답`;
}
