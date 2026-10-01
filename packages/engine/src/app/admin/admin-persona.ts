import {
  CharacterBookContentSchema,
  type CharacterBookContent,
  type PersonaRole,
} from "@story-fm/domain";
import {
  clearPersonaBooks,
  readPersonaBooks,
  writePersonaBooks,
} from "../../common/data/persona-override";
import { namedCatalogBook } from "../../common/data/catalog-character-book";
import { personaCatalog } from "../../common/people/persona-catalog";
import type { AdminResult } from "./admin";

export interface AdminPersonaRow {
  characterId: string;
  name: string;
  role: PersonaRole;
  characterBook: CharacterBookContent;
  edited: boolean;
}

export function adminPersonaCatalog(seed = 0): AdminPersonaRow[] {
  const overrides = readPersonaBooks();
  return personaCatalog(seed).map((person) => {
    if (!person.characterBook)
      throw new Error(`인물 카탈로그에 캐릭터북이 없습니다: ${person.name}`);
    return {
      characterId: person.characterId,
      name: person.name,
      role: person.role,
      characterBook: person.characterBook,
      edited: Object.hasOwn(overrides, person.characterId),
    };
  });
}

export function adminUpdatePersonaBook(characterId: string, raw: unknown, seed = 0): AdminResult {
  const parsed = CharacterBookContentSchema.safeParse(raw);
  if (!parsed.success)
    return { ok: false, message: parsed.error.issues[0]?.message ?? "입력 오류" };
  const person = personaCatalog(seed).find((entry) => entry.characterId === characterId);
  if (!person) return { ok: false, message: `카탈로그에 없는 인물입니다: ${characterId}` };
  writePersonaBooks({
    ...readPersonaBooks(),
    [characterId]: namedCatalogBook(person.name, parsed.data),
  });
  return { ok: true, message: `${person.name} 캐릭터북 갱신` };
}

export function adminResetPersonaCatalog(): AdminResult {
  clearPersonaBooks();
  return { ok: true, message: "인물 캐릭터북을 시드 기본값으로 되돌렸습니다" };
}
