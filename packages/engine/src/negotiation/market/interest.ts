import type { GamePlayer, Interest } from "@story-fm/domain";
import { INTEREST_STAGE_KO } from "@story-fm/domain";
import {
  competingBidsOn,
  interestsOn,
  playerById,
  teamNameIn,
  type GameState,
} from "../../common/core/state";

export function interestLabel(state: GameState, interest: Interest): string {
  return `${teamNameIn(state, interest.teamId)} (${INTEREST_STAGE_KO[interest.stage]})`;
}

/** 이 선수에게 서 있는 관심을 한 줄로 — 없으면 `null` */
export function interestLine(state: GameState, playerId: string): string | null {
  const rows = interestsOn(state, playerId);
  return rows.length === 0 ? null : rows.map((row) => interestLabel(state, row)).join(" · ");
}

/**
 * 이 선수에게 선 **경쟁 입찰**을 한 줄로 — 없으면 `null` (`interestLine`과 같은 결).
 * 구단·날짜와 지금까지 오른 폭뿐이다. 문장은 읽는 쪽이 만든다.
 */
export function competingBidLine(state: GameState, playerId: string): string | null {
  const bids = competingBidsOn(state, playerId);
  if (bids.length === 0) return null;
  return bids.map((bid) => `${teamNameIn(state, bid.teamId)} (${bid.date})`).join(" · ");
}

/**
 * 상태 스냅샷의 `<interest>` 블록 — 우리 선수와 우리가 노리는 선수, 두 결이다
 * (→ docs/common/llm/agents.md §6). 없으면 빈 배열이라 덩어리가 서지 않는다.
 */
export function describeInterests(state: GameState): string[] {
  const seen = new Map<string, GamePlayer>();
  for (const row of state.interests) {
    const player = playerById(state, row.gamePlayerId);
    if (player) seen.set(player.id, player);
  }
  const lines: string[] = [];
  for (const player of [...seen.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const label = interestLine(state, player.id);
    if (label === null) continue;
    const ours = player.teamId === state.userTeamId;
    // 값을 부른 사실은 보고 있는 사실과 다르다 — 같은 줄에 이어 붙인다 (§1-2)
    const bids = competingBidLine(state, player.id);
    lines.push(
      `- ${player.name}${ours ? "" : " (영입 대상)"} ← ${label}` +
        (bids === null ? "" : ` · 입찰 ${bids}`),
    );
  }
  return lines;
}
