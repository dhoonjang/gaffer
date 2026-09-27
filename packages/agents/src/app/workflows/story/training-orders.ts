import { type GameState, playerName, squadView } from "@story-fm/engine";
import { tagged, runOpsOrders } from "../../../common/orders-ops";
import { buildRecentTurnsBlock } from "../../../common/context";
import { type GameToolSpec, type GameLLM } from "@story-fm/llm";
import { type TrainingOrders, TRAINING_ORDERS_SPEC } from "../../../story/training-orders";
import { mockOrdersLlm } from "../../mock-gm";

/** `<squad_ops>` — 목록 교체 명령이 지금 목록을 알아야 한다 */
export function buildSquadOpsBlock(state: GameState): string[] {
  const name = (id: string): string => playerName(state, id);
  const mentoring = state.mentoring.filter((m) => m.until === undefined);
  const byMentor = new Map<string, string[]>();
  for (const m of mentoring)
    byMentor.set(m.mentorId, [...(byMentor.get(m.mentorId) ?? []), m.menteeId]);
  const focus = state.developmentFocus;
  const youth = state.youthCandidates.filter((c) => c.teamId === state.userTeamId);
  return tagged(
    "squad_ops",
    [
      `멘토링: ${
        byMentor.size > 0
          ? [...byMentor].map(([m, ids]) => `${name(m)} → ${ids.map(name).join("·")}`).join(" / ")
          : "없음"
      }`,
      `집중 육성: ${focus.length > 0 ? focus.map(name).join("·") : "없음"}`,
      `2군 훈련 방침: ${state.reserveTraining ?? "balanced"}`,
      ...(youth.length > 0
        ? [
            `유스 후보 (${youth[0]!.deadline}까지): ${youth
              .map((c) => `${c.player.id} ${c.player.name}`)
              .join(" · ")}`,
          ]
        : []),
    ].join("\n"),
  );
}

/** 해석기의 입력 — 이번 주 일정·지금 걸린 목록·명단·지난 다섯 턴 */
export function buildTrainingContext(state: GameState, schedule: string): string[] {
  return [
    ...tagged("schedule", schedule),
    ...buildSquadOpsBlock(state),
    ...tagged("squad", squadView(state, { level: "all" }).message),
    ...tagged("recent_turns", buildRecentTurnsBlock(state)),
  ];
}

/**
 * 감독의 말 → 선수단 운영 명령의 인자. 전술 해석과 같은 계약이다(agents.md §1) —
 * 산출이 나온 뒤의 실패는 실패가 아니고, 산출 없이 두 번 실패하면 도구가 반려로 답한다.
 */
export async function runTrainingOrders(
  state: GameState,
  specs: ReadonlyMap<string, GameToolSpec>,
  schedule: string,
  message: string,
  llm?: GameLLM,
): Promise<{ ok: true; orders: TrainingOrders } | { ok: false; message: string }> {
  const user = [...buildTrainingContext(state, schedule), ``, `@감독: ${message}`].join("\n");
  return runOpsOrders(
    TRAINING_ORDERS_SPEC,
    specs,
    user,
    llm ?? mockOrdersLlm(state, TRAINING_ORDERS_SPEC, message),
    message,
  );
}
