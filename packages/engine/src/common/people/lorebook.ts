import {
  LorebookEditSchema,
  CharacterUpdateSchema,
  type LorebookContent,
  type Persona,
  type StoredPersona,
  type StaffPoolEntry,
  type StoredStaffPoolEntry,
  type LorebookEntry,
  type LorebookInjection,
  type LorebookJob,
  type CharacterCandidate,
} from "@story-fm/domain";
import type { GameState } from "../core/state";
import type { CommandResult } from "../commands/result";

/** Seed prose is used only before an identity has been registered in the save. */
export function personaBookOf(
  state: Pick<GameState, "lorebook">,
  persona: Persona | StoredPersona,
): LorebookContent {
  const id = "lorebookId" in persona ? persona.lorebookId : `person:${persona.characterId}`;
  const book = state.lorebook.find((entry) => entry.id === id);
  if (book) return book;
  if ("lorebook" in persona) return persona.lorebook;
  throw new Error(`로어북 누락: ${id}`);
}

export function registerPersonBook(
  state: Pick<GameState, "lorebook">,
  name: string,
  book: LorebookContent,
): string {
  const id = `person:${name}`;
  if (state.lorebook.some((entry) => entry.id === id)) return id;
  state.lorebook.push({
    ...book,
    name,
    keywords: [...book.keywords],
    id,
    kind: "person",
    version: 1,
  });
  return id;
}

/** Read views carry prose, never a mutable reference to the canonical entry. */
function bookContent(book: LorebookContent): LorebookContent {
  return {
    name: book.name,
    keywords: [...book.keywords],
    description: book.description,
    information: book.information,
  };
}

export function storePersona(state: Pick<GameState, "lorebook">, persona: Persona): StoredPersona {
  const { lorebook, ...identity } = persona;
  return { ...identity, lorebookId: registerPersonBook(state, persona.name, lorebook) };
}

export function readPersona(state: Pick<GameState, "lorebook">, persona: StoredPersona): Persona {
  const { lorebookId, ...identity } = persona;
  return {
    ...identity,
    lorebook: bookContent(personaBookOf(state, { ...identity, lorebookId })),
  };
}

export function storeStaffCandidate(
  state: Pick<GameState, "lorebook">,
  entry: StaffPoolEntry,
): StoredStaffPoolEntry {
  const { lorebook, ...terms } = entry;
  return { ...terms, lorebookId: registerPersonBook(state, entry.name, lorebook) };
}

export function readStaffCandidate(
  state: Pick<GameState, "lorebook">,
  entry: StoredStaffPoolEntry,
): StaffPoolEntry {
  const { lorebookId, ...terms } = entry;
  const lorebook = state.lorebook.find((book) => book.id === lorebookId);
  if (!lorebook) throw new Error(`로어북 누락: ${lorebookId}`);
  return { ...terms, lorebook: bookContent(lorebook) };
}

export function selectLorebook(
  entries: readonly LorebookEntry[],
  text: string,
  injected: readonly LorebookInjection[],
): LorebookEntry[] {
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

type LorebookState = Pick<
  GameState,
  "lorebook" | "lorebookJobs" | "lorebookJobSequence" | "lorebookRevisions"
>;

export function requestCharacterUpdate(state: LorebookState, raw: unknown): CommandResult {
  const parsed = CharacterUpdateSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "유효한 로어북 갱신 정보가 필요합니다" };
  const input = parsed.data;
  const exact = state.lorebook.find((entry) => entry.id === input.characterId);
  const matches = exact
    ? [exact]
    : state.lorebook.filter((entry) => entry.name === input.characterId);
  if (matches.length > 1) return { ok: false, message: "동명이인은 로어북 id로 지정해야 합니다" };
  let entry = matches[0];
  if (!entry) {
    if (!input.newCharacter || input.newCharacter.name !== input.characterId)
      return { ok: false, message: "새 인물은 이름과 로어북 초기 정보가 필요합니다" };
    const draft = input.newCharacter;
    entry = { ...draft, id: `person:${draft.name}`, kind: "person", version: 1 };
    if (state.lorebook.some((row) => row.id === `person:${draft.name}`))
      return { ok: false, message: "이미 등록된 인물입니다" };
    state.lorebook.push(entry);
  } else if (input.newCharacter)
    return { ok: false, message: "기존 항목의 이름은 바꿀 수 없습니다" };
  state.lorebookJobSequence += 1;
  const job: LorebookJob = {
    id: `character-update-${state.lorebookJobSequence}`,
    characterId: entry.id,
    additionalInformation: input.additionalInformation,
    status: "pending",
    attempts: 0,
  };
  state.lorebookJobs.push(job);
  return { ok: true, message: `${entry.name} 로어북 갱신 접수` };
}

/** A late editor result must never overwrite an intervening edit. */
export function completeCharacterUpdate(
  state: LorebookState,
  jobId: string,
  version: number,
  raw: unknown,
): boolean {
  const job = state.lorebookJobs.find((row) => row.id === jobId);
  const entry = state.lorebook.find((row) => row.id === job?.characterId);
  const parsed = LorebookEditSchema.safeParse(raw);
  if (!job || !entry || entry.version !== version || !parsed.success) return false;
  state.lorebookRevisions.push({
    jobId: job.id,
    previous: { ...entry, keywords: [...entry.keywords] },
    additionalInformation: job.additionalInformation,
  });
  Object.assign(entry, parsed.data, { version: entry.version + 1 });
  state.lorebookJobs = state.lorebookJobs.filter((row) => row.id !== jobId);
  return true;
}

export const CHARACTER_CANDIDATE_POOL_MAX = 240;

/** Keep familiar people and rotate fresh catalog entries without loading their full records. */
export function characterCandidates(
  state: Pick<
    GameState,
    "lorebook" | "players" | "personas" | "userTeamId" | "chat" | "historyDigest"
  >,
): CharacterCandidate[] {
  const entries = state.lorebook.filter((entry) => entry.kind !== "team");
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const picked = new Map<string, CharacterCandidate>();
  const add = (entry: LorebookEntry | undefined) => {
    if (entry && picked.size < CHARACTER_CANDIDATE_POOL_MAX && !picked.has(entry.name))
      picked.set(entry.name, { name: entry.name, description: entry.description });
  };
  for (const candidate of state.historyDigest?.candidates ?? []) add(byName.get(candidate.name));
  for (const turn of state.chat.slice(-30))
    for (const entry of turn.lorebook ?? []) add(byId.get(entry.id));
  for (const player of state.players)
    if (player.teamId === state.userTeamId) add(byId.get(`player:${player.id}`));
  for (const persona of state.personas) add(byId.get(persona.lorebookId));
  const start =
    ((state.historyDigest?.rounds ?? 0) * CHARACTER_CANDIDATE_POOL_MAX) %
    Math.max(1, entries.length);
  for (let i = 0; i < entries.length && picked.size < CHARACTER_CANDIDATE_POOL_MAX; i += 1)
    add(entries[(start + i) % entries.length]);
  return [...picked.values()];
}
