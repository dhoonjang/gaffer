import { buildStandingBlock } from "../../../match/context";
import { type GameState, squadView } from "@story-fm/engine";
import { buildRecentTurnsBlock } from "../../../common/context";

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
