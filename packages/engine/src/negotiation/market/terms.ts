import type {
  Contract,
  ContractTerm,
  DealTerm,
  DealTermKind,
  GamePlayer,
  Negotiation,
  TabledTerm,
  TickSink,
} from "@story-fm/domain";
import {
  DEAL_TERM_KO,
  ESCALATOR_TRIGGER_KO,
  dealTermKindsFor,
  dealTermLabel,
  formatMoney,
  normalizeDealTerm,
  normalizePositionCode,
  sameTermKind,
} from "@story-fm/domain";
import { recordFinance } from "../finance/finance";
import { activeContract, financeOf, playerById, type GameState } from "../../common/core/state";

/** 이 협상에서 걸 수 있는 조건의 갈래 — 협상의 종류가 정한다 */
export function termKindsOf(
  negotiation: Pick<Negotiation, "kind" | "precontract">,
): readonly DealTermKind[] {
  return dealTermKindsFor(negotiation.kind, negotiation.precontract === true);
}

/** 조건서 */
export function termSheetOf(negotiation: Pick<Negotiation, "terms">): TabledTerm[] {
  return negotiation.terms;
}

/**
 * 감독이 제시한 조건과 수락한 상대 요구. 라운드는 이 목록을 보존하고,
 * 합의 후 서명하면 계약의 조건 기록이 된다.
 */
export function offeredTermsOf(negotiation: Pick<Negotiation, "terms">): DealTerm[] {
  return termSheetOf(negotiation)
    .filter((row) => row.by === "us" || row.answer === "granted")
    .map((row) => row.term);
}

/** 상대가 불렀는데 아직 답이 없는 요구 */
export function openAsksOf(negotiation: Pick<Negotiation, "terms">): TabledTerm[] {
  return termSheetOf(negotiation).filter((row) => row.by === "them" && row.answer === undefined);
}

/** 감독이 거절한 요구의 수. */
export function refusedTermsOf(negotiation: Pick<Negotiation, "terms">): number {
  return termSheetOf(negotiation).filter((row) => row.by === "them" && row.answer === "refused")
    .length;
}

export interface TermsTabled {
  /** 장부에 선 조건 */
  tabled: DealTerm[];
  /** 서지 못한 조건과 그 이유 — 감독이 읽는다 */
  notes: string[];
}

/**
 * 감독이 조건을 올린다 — **같은 갈래는 하나이고, 상대가 부른 갈래면 그 요구를 들어준
 * 것이다.** 갈래가 협상의 종류에 맞지 않거나 값이 비었으면 서지 않고 그 이유가 돌아간다.
 */
export function tableTerms(
  state: GameState,
  negotiation: Negotiation,
  terms: readonly DealTerm[],
): TermsTabled {
  const allowed = termKindsOf(negotiation);
  const sheet = negotiation.terms;
  const tabled: DealTerm[] = [];
  const notes: string[] = [];
  for (const raw of terms) {
    const term = normalizeDealTerm(raw);
    if (term === null) {
      notes.push(`${DEAL_TERM_KO[raw.kind]} 조건은 값이 비어 서지 않았습니다`);
      continue;
    }
    if (!allowed.includes(term.kind)) {
      notes.push(`${dealTermLabel(term)} — 이 협상에서는 걸 수 없는 조건입니다`);
      continue;
    }
    if (term.kind === "signing") {
      const code = normalizePositionCode(term.position ?? "");
      if (code === null) {
        notes.push(`${term.position}은 자리 표기가 아닙니다 — 포지션 코드로 말해야 합니다`);
        continue;
      }
      term.position = code;
    }
    // 상대가 부른 갈래를 감독이 올리면 그 요구를 들어준 것이다 — 값은 감독이 부른 것으로
    const asked = sheet.find(
      (row) => row.by === "them" && row.answer === undefined && sameTermKind(row.term, term),
    );
    if (asked) {
      asked.answer = "granted";
      asked.term = term;
      tabled.push(term);
      continue;
    }
    const mine = sheet.findIndex((row) => row.by === "us" && sameTermKind(row.term, term));
    if (mine >= 0) {
      // 다시 올리는 것은 값을 고치는 것이다 — 조항을 올려 부르는 자리
      sheet[mine] = { term, by: "us", on: state.date };
      tabled.push(term);
      continue;
    }
    sheet.push({ term, by: "us", on: state.date });
    tabled.push(term);
  }
  return { tabled, notes };
}

/** 감독이 상대의 요구에 답한다 — 들어주거나 거절한다. 열린 요구가 없으면 반려다 */
export function answerTermAsk(
  negotiation: Negotiation,
  kind: DealTermKind,
  answer: "granted" | "refused",
): { ok: true; term: DealTerm } | { ok: false; message: string } {
  const row = openAsksOf(negotiation).find((r) => r.term.kind === kind);
  if (!row) return { ok: false, message: `답할 ${DEAL_TERM_KO[kind]} 요구가 없습니다` };
  row.answer = answer;
  return { ok: true, term: row.term };
}

/** 조건서 한 줄 — 누가 올렸고 어떻게 됐나. 서류·요약·화면이 같은 문형을 쓴다 */
export function tabledTermLine(row: TabledTerm, us: string, them: string): string {
  const who = row.by === "us" ? us : them;
  const status =
    row.by === "us"
      ? ""
      : row.answer === "granted"
        ? ` — ${us}가 들어줬다`
        : row.answer === "refused"
          ? ` — ${us}가 거절했다`
          : " — 답을 기다린다";
  return `${who}: ${dealTermLabel(row.term)}${status}`;
}

/** 감독이 읽는 조건서 — 협상 요약이 붙인다 */
export function describeTermSheet(negotiation: Negotiation): string[] {
  const sheet = termSheetOf(negotiation);
  return sheet.length === 0
    ? []
    : ["조건서:", ...sheet.map((row) => `  ${tabledTermLine(row, "우리", "상대")}`)];
}

/** 합의 라운드의 조건에서 감독이 약속한 등번호 — 도착일 배정이 읽는다 */
export function promisedNumberOf(terms: readonly DealTerm[] | undefined): number | undefined {
  return terms?.find((t) => t.kind === "number")?.number;
}

/** 합의 조건을 계약에 보존하고, 즉시 집행할 금전 조항을 정산한다. */
export function settleTermsOnSigning(
  state: GameState,
  contract: Contract,
  player: GamePlayer,
  terms: readonly DealTerm[],
  options: { pending?: boolean } = {},
): string[] {
  const notes: string[] = [];
  if (terms.length === 0) return notes;
  const copy: ContractTerm[] = terms.map((term) => ({ ...term }));
  for (const term of copy) {
    if (options.pending && term.kind !== "buyout") continue;
    switch (term.kind) {
      case "buyout":
        contract.buyoutClause = term.fee;
        break;
      case "bonus": {
        const amount = term.fee ?? 0;
        if (amount <= 0) break;
        recordFinance(state, state.userTeamId, {
          kind: "expense",
          category: "signing_bonus",
          label: `사이닝 보너스 — ${player.name}`,
          amount,
          ref: { type: "player", id: player.id },
        });
        // 이적료와 같은 주머니에서 나간다 — 예산 관문이 잰 자리가 여기다 (transfer.md §11)
        const finance = financeOf(state, state.userTeamId);
        finance.transferBudget = Math.max(0, finance.transferBudget - amount);
        term.settledOn = state.date;
        notes.push(`사이닝 보너스 ${formatMoney(amount)} 지급`);
        break;
      }
      case "signing":
      case "captain":
      case "minutes":
      case "number":
      case "points":
      case "escalator":
      case "other":
        break;
    }
  }
  contract.terms = copy;
  return notes;
}

/** 시즌 전환이 넘기는 사실 — 조항의 사건이 이번 시즌에 있었는가 */
export interface EscalatorFacts {
  europe: boolean;
  title: boolean;
  promotion: boolean;
}

/**
 * **주급 인상 조항의 집행** — 시즌 전환에서 한 번 (transfer.md §12-3).
 *
 * 우리 구단의 활성 계약 중 아직 집행되지 않은 조항의 사건이 이번 시즌에 있었으면 주급이
 * 그만큼 오르고 `settledOn`이 찍힌다 — 같은 조항이 다음 시즌에 다시 오르지 않는다.
 */
export function settleEscalators(state: GameState, facts: EscalatorFacts, digest: TickSink): void {
  for (const contract of state.contracts) {
    if (contract.status !== "active" || contract.teamId !== state.userTeamId) continue;
    for (const term of contract.terms ?? []) {
      if (term.kind !== "escalator" || term.settledOn !== undefined) continue;
      if (term.trigger === undefined || term.pct === undefined) continue;
      if (!facts[term.trigger]) continue;
      const before = contract.weeklyWage;
      contract.weeklyWage = Math.round(before * (1 + term.pct / 100));
      term.settledOn = state.date;
      const player = playerById(state, contract.gamePlayerId);
      const name = player?.name ?? contract.gamePlayerId;
      digest.push(
        `${name} 주급 인상 조항 발동 — ${ESCALATOR_TRIGGER_KO[term.trigger]}으로 ` +
          `${formatMoney(before)} → ${formatMoney(contract.weeklyWage)}`,
      );
    }
  }
}

/**
 * **공격 포인트 보너스의 집행** — 우리 팀의 경기가 마감될 때마다 (transfer.md §12-3).
 *
 * 그 선수의 활성 계약에 조항이 있으면 이 경기의 골과 도움을 더한 포인트 × 금액을
 * `bonus`(성적 보너스)로 낸다. 서명 때 나가는 `signing_bonus`와 갈리는 이유는 이것이
 * 시즌 내내 되풀이되는 성적의 값이기 때문이다. 포인트가 없으면 아무것도 적지 않는다.
 * 낸 금액을 돌려주고, 조항이 없거나 포인트가 없으면 0이다.
 */
export function settlePointsBonus(state: GameState, player: GamePlayer, points: number): number {
  if (points <= 0) return 0;
  const contract = activeContract(state, player.id);
  if (!contract || contract.teamId !== state.userTeamId) return 0;
  const term = (contract.terms ?? []).find((t) => t.kind === "points");
  if (!term || term.fee === undefined || term.fee <= 0) return 0;
  const amount = term.fee * points;
  recordFinance(state, state.userTeamId, {
    kind: "expense",
    category: "bonus",
    label: `공격 포인트 보너스 — ${player.name} (${points}P)`,
    amount,
    ref: { type: "player", id: player.id },
  });
  return amount;
}

/** 계약에 적힌 조건의 줄 — 카드·조회가 같은 문형을 쓴다. 조항 칸이 있으면 함께 든다 */
export function contractTermLines(contract: Pick<Contract, "buyoutClause" | "terms">): string[] {
  const lines: string[] = [];
  if (contract.buyoutClause !== undefined && contract.buyoutClause > 0) {
    lines.push(`바이아웃 조항 ${formatMoney(contract.buyoutClause)}`);
  }
  for (const term of contract.terms ?? []) {
    if (term.kind === "buyout") continue;
    lines.push(dealTermLabel(term) + (term.settledOn ? ` (${term.settledOn} 집행)` : ""));
  }
  return lines;
}

/** 이 선수의 계약에 적힌 조건 — 없으면 빈 배열 */
export function contractTermsOf(state: GameState, playerId: string): string[] {
  const contract = activeContract(state, playerId);
  return contract ? contractTermLines(contract) : [];
}
