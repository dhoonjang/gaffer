import { type GameState, squadView } from "@story-fm/engine";
import { buildRecentTurnsBlock } from "../../../common/context";
import { buildStandingBlock, buildBoardMovesBlock } from "../../../match/context";
import { type GameToolSpec, type GameLLM } from "@story-fm/llm";
import { type BoardMove } from "@story-fm/domain";
import { type TacticOrders, TACTIC_ORDERS_SPEC } from "../../../match/tactic-orders";
import { runOpsOrders } from "../../../common/orders-ops";
import { mockOrdersLlm } from "../../mock-gm";

/**
 * 평시의 판 — `<standing>`(지금 걸려 있는 것 전부: 6축·갈래·역할·완장·세트피스 키커 —
 * 경기 장부 노트와 같은 블록) · `<squad>`(선발·벤치·예비와 자리) ·
 * `<recent_turns>`(지난 다섯 턴).
 */
export function buildPeaceContext(state: GameState): string[] {
  const squad = squadView(state, {});
  const recent = buildRecentTurnsBlock(state);
  return [
    ...buildStandingBlock(state),
    `<squad>`,
    squad.message,
    `</squad>`,
    ...(recent.length > 0 ? [`<recent_turns>`, recent, `</recent_turns>`] : []),
  ];
}

/**
 * 감독의 말 → 부를 명령과 그 인자.
 *
 * **산출이 나온 뒤의 실패는 실패가 아니다** (agents.md §3 ②) — 산출은 이미 완성돼
 * 있으므로 받은 것으로 진행한다. **산출 없이 두 번 실패하면 도구가 반려로 답한다** —
 * 해석하지 못한 턴에 무언가를 짐작해 적용하면 감독이 내리지 않은 지시가 판에 오르고,
 * 그것은 아무 일도 일어나지 않는 것보다 나쁘다. 뼈대는 해석기 넷이 함께 쓴다.
 */
export async function runTacticOrders(
  state: GameState,
  specs: ReadonlyMap<string, GameToolSpec>,
  message: string,
  options: {
    llm?: GameLLM;
    /** 이번 턴 전술판이 이미 움직인 것 — `<board_moves>`가 된다 */
    boardMoves?: readonly BoardMove[];
  } = {},
): Promise<{ ok: true; intent: TacticOrders } | { ok: false; message: string }> {
  /**
   * 판이 이번 턴에 움직인 것은 **감독의 말 바로 앞**에 선다 — 되풀이를 가리는 판정이
   * 그 말을 읽는 자리에서 이뤄진다 (agents.md §3).
   */
  const boardMoves = buildBoardMovesBlock(state, options.boardMoves ?? []);
  // 해석기에는 감독의 이름이 없다 — 자리 태그 하나로 감독의 말을 세운다
  const user = [...buildPeaceContext(state), ...boardMoves, ``, `@감독: ${message}`].join("\n");
  const answered = await runOpsOrders(
    TACTIC_ORDERS_SPEC,
    specs,
    user,
    options.llm ?? mockOrdersLlm(state, TACTIC_ORDERS_SPEC, message),
    message,
  );
  return answered.ok ? { ok: true, intent: answered.orders } : answered;
}
