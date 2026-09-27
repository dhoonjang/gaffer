import {
  type GameState,
  applyMatchReading,
  type ReadingOccasion,
  awaitingShootout,
} from "@story-fm/engine";
import { type MatchToolContext, MATCH_TOOL_DEFINITIONS } from "../../../match/match-gm";
import { buildToolSpecs } from "../../gm-tools";
import { runMatchReader } from "./match-reader";
import { type MatchEvent, BREAK_EVENT_TYPES, STOP_EVENT_TYPES } from "@story-fm/domain";
import { type GameLLM, type GameToolSpec } from "@story-fm/llm";
import { finalizeMatchTurn } from "./finalize-match";

/** Tactical analysis after typed commands, without a second command interpreter. */
export async function readMatchAfterInstructions(state: GameState, said: string): Promise<void> {
  const read = await runMatchReader(state, { occasion: "orders", said });
  if (read.ok) applyMatchReading(state, read.reading);
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
  try {
    const read = await runMatchReader(state, {
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
  const [finalize] = MATCH_TOOL_DEFINITIONS;
  const tools: GameToolSpec[] = options.operator
    ? []
    : buildToolSpecs(state, ctx.calls).filter((tool) => tool.name === "team_talk");
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
        message: `경기 마감 — 결산 ${outcome.settled}명. 장부를 근거로 마무리 장면을 쓰세요.`,
      };
    },
  });
  return tools;
}
