import { type GameState, awaitingShootout } from "@story-fm/engine";
import { type MatchToolContext, MATCH_TOOL_DEFINITIONS } from "../../../match/match-gm";
import { buildToolSpecs, dismissed } from "../../gm-tools";
import { createInstructionTool } from "../instructions";
import { type GameToolSpec } from "@story-fm/llm";
import { finalizeMatchTurn } from "./finalize-match";
import { MatchClosingSchema } from "../../../match/match-closing";

/**
 * 이 턴의 경기 도구 — 감독 발화에는 지시·대화·마감, 손잡이 턴에는 마감. 킥오프 턴은 부르지 않는다.
 */
export function buildMatchTools(
  state: GameState,
  ctx: MatchToolContext,
  options: { operator?: boolean } = {},
): GameToolSpec[] {
  const finalize = MATCH_TOOL_DEFINITIONS.find((tool) => tool.name === "finalize_match")!;
  const tools: GameToolSpec[] = options.operator
    ? []
    : buildToolSpecs(state, ctx.calls).filter((tool) => tool.name === "update_character");
  if (!options.operator)
    tools.push(
      createInstructionTool(state, ctx.calls, {
        name: "tactic_orders",
        agent: "match-reader",
        said: ctx.said,
        boardMoves: ctx.boardMoves,
        allowed: () => dismissed(state, true) ?? undefined,
        description: MATCH_TOOL_DEFINITIONS.find((tool) => tool.name === "tactic_orders")!
          .description,
      }),
    );
  tools.push({
    ...finalize!,
    handle: async (args: unknown) => {
      const parsed = MatchClosingSchema.safeParse(args);
      if (!parsed.success)
        return { ok: false, message: "경기 마감에는 출전 선수의 평점 설명만 제출하세요" };
      const pending = state.pendingMatch;
      if (!pending) return { ok: false, message: "마감할 경기가 없습니다" };
      if (pending.live.ledger.phase !== "finished" || awaitingShootout(state)) {
        return { ok: false, message: "아직 경기가 끝나지 않았습니다" };
      }
      const minute = pending.live.ledger.minute;
      const outcome = await finalizeMatchTurn(state, ctx.calls, ctx.finalizeEvaluator, parsed.data);
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
