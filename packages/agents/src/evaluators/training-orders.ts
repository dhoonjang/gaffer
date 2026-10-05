import { type GameState, playerName, squadView } from "@gaffer/engine";
import { tagged } from "./orders-ops";
import { buildRecentTurnsBlock } from "../shared/context";

export const TRAINING_OPS: readonly string[] = [
  "sign_youth",
  "set_development_focus",
  "set_training",
];

/** `<squad_ops>` — 목록 교체 명령이 지금 목록을 알아야 한다 */
function buildSquadOpsBlock(state: GameState): string[] {
  const name = (id: string): string => playerName(state, id);
  const focus = state.developmentFocus;
  const youth = state.youthCandidates.filter((c) => c.teamId === state.userTeamId);
  return tagged(
    "squad_ops",
    [
      `집중 육성: ${focus.length > 0 ? focus.map(name).join("·") : "없음"}`,
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
