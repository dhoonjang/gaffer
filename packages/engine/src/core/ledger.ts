import type { FinanceCategory, LedgerEntry } from "@gaffer/domain";
import { type GameState, financeOf } from "./state";

// ── 원장 기록 ───────────────────────────────────────────

interface RecordFinanceInput {
  kind: "income" | "expense";
  category: FinanceCategory;
  label: string;
  amount: number;
  ref?: LedgerEntry["ref"];
  /** 자산 상각·매각 손익은 noncash */
  accounting?: "cash" | "noncash";
  time?: string;
  /** 서사가 만든 항목인가 (apply_finance_event) */
  source?: "narrative";
}

/**
 * 재정 변화 기록 — **모든 금액 이동의 유일한 입구**.
 *
 * 잔고는 언제나 갱신하지만 **상세 엔트리는 유저 팀만** 남긴다. AI 팀 재정은
 * 잔고만 읽히므로 96팀 분량의 원장을 쌓을 이유가 없다 (finance.md §4.5).
 * 상각(noncash)은 장부에만 잡히므로 잔고를 건드리지 않는다.
 */
export function recordFinance(state: GameState, teamId: string, input: RecordFinanceInput): void {
  const f = financeOf(state, teamId);
  const value = Math.max(0, Math.round(input.amount));
  if (value === 0) return;
  const noncash = input.accounting === "noncash";
  if (!noncash) f.balance += input.kind === "income" ? value : -value;
  if (teamId !== state.userTeamId) return;

  const sameDay = f.ledger.filter((e) => e.date === state.date).length;
  f.ledger.push({
    id: `led-${state.date}-${input.category}-${sameDay + 1}`,
    date: state.date,
    ...(input.time ? { time: input.time } : {}),
    kind: input.kind,
    category: input.category,
    label: input.label,
    amount: value,
    ...(input.ref ? { ref: input.ref } : {}),
    ...(noncash ? { accounting: "noncash" as const } : {}),
    ...(input.source ? { source: input.source } : {}),
  });
}

/** 1회성 항목(상금 등)을 중복 지급하지 않고 지급한다 — 원장은 절단되므로 키로 관리 */
export function payOnce(
  state: GameState,
  teamId: string,
  key: string,
  input: RecordFinanceInput,
): boolean {
  const f = financeOf(state, teamId);
  if (input.amount <= 0 || f.prizesPaid.includes(key)) return false;
  f.prizesPaid.push(key);
  recordFinance(state, teamId, input);
  return true;
}
