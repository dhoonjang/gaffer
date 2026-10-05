import { playerOverall, positionGroupOf, type GamePlayer } from "@story-fm/domain";
import { groupOf, proficiencyAt } from "../core/state";

/** 빈 전술 자리는 GK 여부·자리 숙련도·기량·id 순으로 채운다. */
export function pickVacancy(
  pool: readonly GamePlayer[],
  position: string,
  eligible: (player: GamePlayer) => boolean,
): GamePlayer | undefined {
  return pool
    .filter(eligible)
    .filter((p) => (groupOf(p) === "GK") === (positionGroupOf(position) === "GK"))
    .sort(
      (a, b) =>
        proficiencyAt(b, position) - proficiencyAt(a, position) ||
        playerOverall(b) - playerOverall(a) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )[0];
}
