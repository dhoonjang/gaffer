import { compareCaptainCandidates } from "@gaffer/domain";
import { playersOf, squadLevelOf, type GameState } from "../core/state";

/** 부주장이 먼저 승계하며 지정이 없으면 1군에서 결정적으로 배정한다. */
export function successorCaptainOf(state: GameState, teamId: string): string | null {
  const candidates = playersOf(state, teamId).filter((p) => squadLevelOf(p) === "first");
  return (
    (candidates.find((p) => p.isViceCaptain) ?? candidates.sort(compareCaptainCandidates)[0])?.id ??
    null
  );
}

/** 실제 경기 명단 전체가 후보이며 사회적 그룹이나 순위를 사용하지 않는다. */
export function matchCaptainOf(
  state: GameState,
  teamId: string,
  present: ReadonlySet<string>,
): string | null {
  const candidates = playersOf(state, teamId).filter((p) => present.has(p.id));
  return (
    (
      candidates.find((p) => p.isCaptain) ??
      candidates.find((p) => p.isViceCaptain) ??
      candidates.sort(compareCaptainCandidates)[0]
    )?.id ?? null
  );
}
