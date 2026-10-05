import { type OpsCaps } from "./orders-ops";
import { MATCHDAY_BENCH } from "@gaffer/domain";
import { buildStandingBlock } from "../shared/match-context";
import { type GameState, squadView } from "@gaffer/engine";
import { buildRecentTurnsBlock } from "../shared/context";

/** Live-match commands in application order; lineup/captain are pre-match only. */
export const MATCH_OPS: readonly string[] = [
  "substitute",
  "set_tactics",
  "set_player_tactic",
  "set_set_piece_takers",
  "set_set_piece_routine",
  "set_shootout_order",
];

/** Domain-owned direct commands, ordered for dependent changes. */
export const TACTIC_OPS: readonly string[] = [
  "set_lineup",
  "set_squad_level",
  "set_captain",
  ...MATCH_OPS,
];

/**
 * 명령마다 다른 상한 — **규칙이 정한 수가 있는 자리는 그 수를 쓴다** (match.md §5).
 * 교체는 벤치 전체를 옮길 수 있다. 대회별 교체 한도는 장부가 검증한다.
 */
export const TACTIC_CAPS: OpsCaps = {
  substitute: MATCHDAY_BENCH,
  set_player_tactic: 11,
};

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
