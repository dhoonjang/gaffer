import {
  type GameState,
  applyMatchReading,
  type ReadingOccasion,
  awaitingShootout,
} from "@story-fm/engine";
import {
  type MatchToolContext,
  readingPrint,
  MATCH_TOOL_DEFINITIONS,
  TACTIC_ORDERS_TOOL,
} from "../../../match/match-gm";
import { buildToolSpecs } from "../../gm-tools";
import { runMatchReader } from "./match-reader";
import { applyTacticOrders } from "../../../match/tactic-apply";
import { ordersGate } from "../../../common/orders-ops";
import { buildLedgerNote } from "../../../match/context";
import { type MatchEvent, BREAK_EVENT_TYPES, STOP_EVENT_TYPES } from "@story-fm/domain";
import { type GameLLM, type GameToolSpec } from "@story-fm/llm";
import { finalizeMatchTurn } from "./finalize-match";

/**
 * 지시 → 판. 판독기가 두 번 실패하면 **반려로 답한다** — 턴은 이어지고 GM은 반려된
 * 대로 쓴다 (agents.md §3). 호출 실패(시한·혼잡)는 그대로 올라간다.
 *
 * **아무 명령도 시트 변화도 없는 지시 턴은 성공이 아니다** — 판이 그대로인데 "걸었다"가
 * 돌아가면 감독은 걸리지 않은 지시 위에 다음 판단을 쌓는다.
 */
async function runMatchReaderTool(
  state: GameState,
  ctx: MatchToolContext,
  said: string,
): Promise<{ ok: boolean; message: string }> {
  const specs = new Map(buildToolSpecs(state, ctx.calls).map((t) => [t.name, t] as const));
  const live = state.pendingMatch?.live;
  const before = readingPrint(live?.points ?? [], live?.sheet ?? []);
  const read = await runMatchReader(state, specs, {
    occasion: "orders",
    said,
    ...(ctx.boardMoves ? { boardMoves: ctx.boardMoves } : {}),
  });
  if (!read.ok) return { ok: false, message: read.message };
  const reading = read.reading;
  const applied = applyTacticOrders(
    state,
    {
      ops: reading.ops,
      ...(reading.truncated ? { truncated: reading.truncated } : {}),
      ...(reading.unresolved ? { unresolved: reading.unresolved } : {}),
    },
    specs,
  );
  const stored = applyMatchReading(state, reading);
  const changed = readingPrint(stored?.points ?? [], stored?.sheet ?? []) !== before;
  const replies =
    applied.notes.length > 0
      ? ["<core_replies>", ...applied.notes.map((n) => `- ${n}`), "</core_replies>"]
      : [];
  return {
    ok: applied.applied > 0 || changed,
    message: [
      ...replies,
      ...(applied.shootout ? [applied.shootout] : []),
      buildLedgerNote(state, { withState: true }),
    ].join("\n"),
  };
}

/**
 * **정지점 뒤의 판독** — 정지점(`STOP_EVENT_TYPES`)이 확정된 자리의
 * 정지점 턴에서 매치 GM보다 먼저 돈다 (agents.md §3). 판이 사건으로 바뀌었으므로 GM이
 * 중계하기 전에 포인트를 다시 쓴다.
 *
 * **여기서의 실패는 삼킨다** — 지난 포인트·시트가 그대로 다음의 입력이고, 그 사실은
 * 기록에 남는다. 판독 하나 때문에 확정된 구간이 되돌아가면 안 된다.
 */
export async function readMatchAfterStop(
  state: GameState,
  events: readonly MatchEvent[],
  options: { llm?: GameLLM } = {},
): Promise<void> {
  const pending = state.pendingMatch;
  if (!pending || pending.live.ledger.phase === "finished") return;
  const occasion: ReadingOccasion | null = events.some((e) => BREAK_EVENT_TYPES.has(e.type))
    ? "halftime"
    : events.some((e) => STOP_EVENT_TYPES.has(e.type))
      ? "event"
      : null;
  if (!occasion) return;
  const specs = new Map(buildToolSpecs(state, []).map((t) => [t.name, t] as const));
  try {
    const read = await runMatchReader(state, specs, {
      occasion,
      events,
      ...(options.llm ? { llm: options.llm } : {}),
    });
    if (read.ok) applyMatchReading(state, read.reading);
  } catch (error) {
    console.warn("[match-reader] 정지점 뒤 판독을 건너뜁니다 — 지난 시트가 남습니다:", error);
  }
}

/**
 * 이 턴의 경기 도구 — 진행 턴은 둘, 손잡이 턴은 마감 하나. 킥오프 턴은 부르지 않는다.
 */
export function buildMatchTools(
  state: GameState,
  ctx: MatchToolContext,
  options: { operator?: boolean } = {},
): GameToolSpec[] {
  const [orders, finalize] = MATCH_TOOL_DEFINITIONS;
  const tools: GameToolSpec[] = [];
  if (!options.operator) {
    /**
     * 지시 도구는 인자가 없다 — 이번 턴 감독의 말은 `ctx.said`가 쥔다 (agents.md §3).
     * 같은 턴의 두 번째 호출은 같은 말을 다시 옮기므로 문이 닫는다.
     */
    const gate = ordersGate(ctx.said);
    tools.push({
      ...orders!,
      handle: async () => {
        const opened = gate(TACTIC_ORDERS_TOOL);
        if (!opened.ok) return opened;
        return runMatchReaderTool(state, ctx, opened.said);
      },
    });
  }
  tools.push({
    ...finalize!,
    handle: async () => {
      const pending = state.pendingMatch;
      if (!pending) return { ok: false, message: "마감할 경기가 없습니다" };
      if (pending.live.ledger.phase !== "finished" || awaitingShootout(state)) {
        return { ok: false, message: "아직 경기가 끝나지 않았습니다" };
      }
      const minute = pending.live.ledger.minute;
      const outcome = await finalizeMatchTurn(state, ctx.calls, ctx.finalizeLlm);
      if (!outcome) return { ok: false, message: "마감할 경기가 없습니다" };
      ctx.onFinalized?.(minute);
      return {
        ok: true,
        message: [
          `경기 마감 — 결산 ${outcome.settled}명`,
          ...(outcome.closing.length > 0
            ? ["<closing>", outcome.closing, "</closing>"]
            : ["(마무리 중계가 없다 — 직접 닫는다)"]),
        ].join("\n"),
      };
    },
  });
  return tools;
}
