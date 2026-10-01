import type { CharacterBookContent, CharacterBookEntry } from "@story-fm/domain";
import type { GameState } from "../../../common/core/state";
import { teamCatalog } from "../../../common/data/team-catalog";
import { playerCatalog } from "../../../common/world/catalog";
import { personaCatalog } from "../../../common/people/persona-catalog";
import {
  generateVirtualManager,
  generateDirector,
  generateOwner,
} from "../../../common/people/persona";
import { generatePlayerPersona, retiredPersona } from "../../../common/people/player-persona";

/** New catalog entities and academy players join the same book without changing existing entries. */
export function syncCharacterBook(state: GameState): void {
  const existing = new Set(state.characterBook.map((entry) => entry.id));
  const add = (id: string, kind: CharacterBookEntry["kind"], content: CharacterBookContent) => {
    if (existing.has(id)) return;
    existing.add(id);
    state.characterBook.push({ ...content, id, kind, version: 1 });
  };
  for (const team of teamCatalog())
    add(
      `team:${team.id}`,
      "team",
      team.characterBook ?? {
        name: team.name,
        keywords: [team.name, team.shortName],
        description: `${team.name} · 축구 구단`,
        information: `${team.name} (${team.shortName}) · ${team.leagueId}`,
      },
    );
  const catalog = new Map(playerCatalog().map((entry) => [entry.id, entry]));
  for (const player of state.players.filter((player) => !existing.has(`player:${player.id}`)))
    add(
      `player:${player.id}`,
      "player",
      catalog.get(player.catalogId ?? "")?.characterBook ??
        generatePlayerPersona(state.seed, player).characterBook,
    );
  for (const retired of state.retired.filter(
    (retired) => !existing.has(`player:${retired.gamePlayerId}`),
  ))
    add(
      `player:${retired.gamePlayerId}`,
      "player",
      retiredPersona(state.seed, retired).characterBook,
    );
  const personas = [...state.personas, ...personaCatalog(state.seed)];
  for (const team of state.teams) {
    if (team.managerName && team.managerName !== state.manager.name)
      personas.push(generateVirtualManager(state.seed, team.managerName));
    personas.push(generateDirector(state.seed, team.id), generateOwner(state.seed, team.id));
  }
  const playerNames = new Set([
    ...state.players.map((player) => player.name),
    ...state.retired.map((player) => player.name),
  ]);
  for (const persona of personas) {
    if ((persona.role === "player" || persona.role === "manager") && playerNames.has(persona.name))
      continue;
    add(`person:${persona.characterId}`, "person", persona.characterBook);
  }
}
