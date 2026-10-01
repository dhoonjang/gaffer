import {
  CharacterBookEditSchema,
  CharacterUpdateSchema,
  type CharacterBookContent,
  type Persona,
  type CharacterBookEntry,
  type CharacterBookInjection,
  type CharacterBookJob,
  type CharacterCandidate,
} from "@story-fm/domain";
import type { GameState } from "../core/state";
import type { CommandResult } from "../commands/result";

/** Seed prose is only a fallback for a person not yet registered in the save. */
export function personaBookOf(
  state: Pick<GameState, "characterBook">,
  persona: Persona,
): CharacterBookContent {
  return (
    state.characterBook.find((entry) => entry.id === `person:${persona.characterId}`) ??
    persona.characterBook
  );
}

export function selectCharacterBook(
  entries: readonly CharacterBookEntry[],
  text: string,
  injected: readonly CharacterBookInjection[],
): CharacterBookInjection[] {
  const normalized = text.normalize("NFKC").toLowerCase();
  const present = new Map<string, number>();
  for (const entry of injected)
    present.set(entry.id, Math.max(present.get(entry.id) ?? 0, entry.version));
  return entries
    .filter(
      (entry) =>
        present.get(entry.id) !== entry.version &&
        [entry.name, ...entry.keywords].some((keyword) =>
          normalized.includes(keyword.normalize("NFKC").toLowerCase()),
        ),
    )
    .map((entry) => ({ ...entry, keywords: [...entry.keywords] }));
}

type CharacterBookState = Pick<
  GameState,
  "characterBook" | "characterBookJobs" | "characterBookJobSequence"
>;

export function requestCharacterUpdate(state: CharacterBookState, raw: unknown): CommandResult {
  const parsed = CharacterUpdateSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "유효한 캐릭터북 갱신 정보가 필요합니다" };
  const input = parsed.data;
  const exact = state.characterBook.find((entry) => entry.id === input.characterId);
  const matches = exact
    ? [exact]
    : state.characterBook.filter((entry) => entry.name === input.characterId);
  if (matches.length > 1) return { ok: false, message: "동명이인은 캐릭터북 id로 지정해야 합니다" };
  let entry = matches[0];
  if (!entry) {
    if (!input.newCharacter || input.newCharacter.name !== input.characterId)
      return { ok: false, message: "새 인물은 이름과 캐릭터북 초기 정보가 필요합니다" };
    const draft = input.newCharacter;
    entry = { ...draft, id: `person:${draft.name}`, kind: "person", version: 1 };
    if (state.characterBook.some((row) => row.id === `person:${draft.name}`))
      return { ok: false, message: "이미 등록된 인물입니다" };
    state.characterBook.push(entry);
  } else if (input.newCharacter)
    return { ok: false, message: "기존 항목의 이름은 바꿀 수 없습니다" };
  state.characterBookJobSequence += 1;
  const job: CharacterBookJob = {
    id: `character-update-${state.characterBookJobSequence}`,
    characterId: entry.id,
    additionalInformation: input.additionalInformation,
    status: "pending",
    attempts: 0,
  };
  state.characterBookJobs.push(job);
  return { ok: true, message: `${entry.name} 캐릭터북 갱신 접수` };
}

/** A late editor result must never overwrite an intervening edit. */
export function completeCharacterUpdate(
  state: CharacterBookState,
  jobId: string,
  version: number,
  raw: unknown,
): boolean {
  const job = state.characterBookJobs.find((row) => row.id === jobId);
  const entry = state.characterBook.find((row) => row.id === job?.characterId);
  const parsed = CharacterBookEditSchema.safeParse(raw);
  if (!job || !entry || entry.version !== version || !parsed.success) return false;
  Object.assign(entry, parsed.data, { version: entry.version + 1 });
  state.characterBookJobs = state.characterBookJobs.filter((row) => row.id !== jobId);
  return true;
}

export const CHARACTER_CANDIDATE_POOL_MAX = 240;

/** Keep familiar people and rotate fresh catalog entries without loading their full records. */
export function characterCandidates(
  state: Pick<
    GameState,
    "characterBook" | "players" | "personas" | "userTeamId" | "chat" | "historyDigest"
  >,
): CharacterCandidate[] {
  const entries = state.characterBook.filter((entry) => entry.kind !== "team");
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const picked = new Map<string, CharacterCandidate>();
  const add = (entry: CharacterBookEntry | undefined) => {
    if (entry && picked.size < CHARACTER_CANDIDATE_POOL_MAX && !picked.has(entry.name))
      picked.set(entry.name, { name: entry.name, description: entry.description });
  };
  for (const candidate of state.historyDigest?.candidates ?? []) add(byName.get(candidate.name));
  for (const turn of state.chat.slice(-30))
    for (const entry of turn.characterBook ?? []) add(byId.get(entry.id));
  for (const player of state.players)
    if (player.teamId === state.userTeamId) add(byId.get(`player:${player.id}`));
  for (const persona of state.personas) add(byId.get(`person:${persona.characterId}`));
  const start =
    ((state.historyDigest?.rounds ?? 0) * CHARACTER_CANDIDATE_POOL_MAX) %
    Math.max(1, entries.length);
  for (let i = 0; i < entries.length && picked.size < CHARACTER_CANDIDATE_POOL_MAX; i += 1)
    add(entries[(start + i) % entries.length]);
  return [...picked.values()];
}
