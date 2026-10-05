import { readPersona } from "../../people/lorebook";
import {
  CLUB_TIER_KO,
  ageOf,
  naturalPositionOf,
  type LorebookContent,
  type LorebookEntry,
  type LorebookInjection,
} from "@gaffer/domain";
import { type GameState, savedClubProfile, teamNameIn } from "../../core/state";
import { leagueName } from "../../core/catalog/league-catalog";
import { isFreeAgent } from "../../team/free-agency";
import { clubHonoursLine } from "../../season/records";
import { teamCatalog, teamSeedBook } from "../../core/catalog/team-catalog";
import { playerCatalog } from "../../players/catalog/catalog";
import { personaCatalog } from "../../people/catalog/persona-catalog";
import { generateVirtualManager, generateDirector, generateOwner } from "../../people/persona";
import { generatePlayerPersona, retiredPersona } from "../../players/catalog/player-persona";

/** New catalog entities and academy players join the same book without changing existing entries. */
export function syncLorebook(state: GameState): void {
  const existing = new Set(state.lorebook.map((entry) => entry.id));
  const add = (id: string, kind: LorebookEntry["kind"], content: LorebookContent) => {
    if (existing.has(id)) return;
    existing.add(id);
    state.lorebook.push({ ...content, id, kind, version: 1 });
  };
  for (const team of teamCatalog())
    add(`team:${team.id}`, "team", team.lorebook ?? teamSeedBook(team));
  const catalog = new Map(playerCatalog().map((entry) => [entry.id, entry]));
  for (const player of state.players.filter((player) => !existing.has(`player:${player.id}`)))
    add(
      `player:${player.id}`,
      "player",
      catalog.get(player.catalogId ?? "")?.lorebook ??
        generatePlayerPersona(state.seed, player).lorebook,
    );
  for (const retired of state.retired.filter(
    (retired) => !existing.has(`player:${retired.gamePlayerId}`),
  ))
    add(`player:${retired.gamePlayerId}`, "player", retiredPersona(state.seed, retired).lorebook);
  const personas = [
    ...state.personas.map((p) => readPersona(state, p)),
    ...personaCatalog(state.seed),
  ];
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
    add(`person:${persona.characterId}`, "person", persona.lorebook);
  }
}

/**
 * 주입하는 항목에 **그 순간의 원장 사실 한 줄**을 붙인다 (lorebook.md §주입). 한 줄
 * 설명은 바뀌지 않는 기본 정보뿐이라, 소속·포지션·나이·리그처럼 바뀌는 사실은 여기서
 * 원장을 읽어 붙인다. 주입한 턴의 기록에 함께 남아 이력을 다시 그려도 같은 글자다.
 */
export function stampLorebook(
  state: GameState,
  entries: readonly LorebookEntry[],
): LorebookInjection[] {
  return entries.map((entry) => ({
    ...entry,
    keywords: [...entry.keywords],
    now: lorebookNow(state, entry),
  }));
}

function lorebookNow(state: GameState, entry: LorebookEntry): string {
  if (entry.kind === "player") return playerNow(state, entry.id.slice("player:".length));
  if (entry.kind === "team") return teamNow(state, entry.id.slice("team:".length));
  return personNow(state, entry);
}

function playerNow(state: GameState, playerId: string): string {
  const player = state.players.find((p) => p.id === playerId);
  if (player) {
    const club = isFreeAgent(player)
      ? "무소속"
      : player.teamId === state.userTeamId
        ? `${teamNameIn(state, player.teamId)} ${player.squadLevel === "reserve" ? "2군" : "1군"}`
        : teamNameIn(state, player.teamId);
    return [
      club,
      naturalPositionOf(player).position,
      `${ageOf(player.birthdate, state.date)}세`,
    ].join(" · ");
  }
  const retired = state.retired.find((r) => r.gamePlayerId === playerId);
  return retired ? `은퇴 (${retired.on} · ${teamNameIn(state, retired.teamId)})` : "";
}

function teamNow(state: GameState, teamId: string): string {
  const team = state.teams.find((t) => t.id === teamId);
  if (!team) return "";
  const stadium = savedClubProfile(state, teamId)?.stadium.trim();
  const honours = clubHonoursLine(state, teamId);
  return [
    leagueName(team.leagueId),
    CLUB_TIER_KO[team.tier],
    ...(stadium ? [`홈구장 ${stadium}`] : []),
    ...(honours ? [`역대 ${honours}`] : []),
  ].join(" · ");
}

/** 인물 — 지금 고용된 구단과 직함. 구단주·단장·감독은 구단 쪽 기록에서 찾는다 */
function personNow(state: GameState, entry: LorebookEntry): string {
  const stored = state.personas.find((p) => p.lorebookId === entry.id);
  if (stored?.employment)
    return `${teamNameIn(state, stored.employment.teamId)} ${stored.employment.title}`;
  for (const team of state.teams) {
    if (team.managerName === entry.name) return `${teamNameIn(state, team.id)} 감독`;
    if (generateOwner(state.seed, team.id).name === entry.name)
      return `${teamNameIn(state, team.id)} 구단주`;
    if (generateDirector(state.seed, team.id).name === entry.name)
      return `${teamNameIn(state, team.id)} 단장`;
  }
  return "";
}
