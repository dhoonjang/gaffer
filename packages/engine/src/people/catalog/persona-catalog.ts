import type { Persona } from "@gaffer/domain";
import { buildSeasonCalendar, FIRST_SEASON } from "../../core/calendar";
import { catalogCacheKey } from "../../core/catalog/catalog-source";
import { teamCatalog } from "../../core/catalog/team-catalog";
import {
  generateDirector,
  generateHeadCoach,
  generateOwner,
  generateReporters,
  generateStaff,
  worldFigures,
} from "../persona";

let cache: { key: string; seed: number; entries: Persona[] } | null = null;

/** Preview the same named people used by a game's deterministic seed. */
export function personaCatalog(seed = 0): Persona[] {
  const key = catalogCacheKey();
  if (cache?.key === key && cache.seed === seed) return cache.entries;
  const today = buildSeasonCalendar(FIRST_SEASON).preseasonStart;
  const people = new Map<string, Persona>();
  for (const person of worldFigures({ userTeamId: "" })) people.set(person.characterId, person);
  for (const team of teamCatalog()) {
    if (team.leagueId === "free") continue;
    for (const person of [
      generateHeadCoach(seed, team.id, today),
      generateOwner(seed, team.id),
      generateDirector(seed, team.id),
      ...generateStaff(seed, team.id, today),
      ...generateReporters(seed, team.id),
    ]) {
      if (!people.has(person.characterId)) people.set(person.characterId, person);
    }
  }
  const entries = [...people.values()];
  cache = { key, seed, entries };
  return entries;
}
