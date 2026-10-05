import { LorebookContentSchema, type LorebookContent, type PersonaRole } from "@story-fm/domain";
import {
  clearPersonaBooks,
  readPersonaBooks,
  writePersonaBooks,
} from "../../people/catalog/persona-override";
import { namedCatalogBook } from "../../core/catalog/catalog-lorebook";
import { personaCatalog } from "../../people/catalog/persona-catalog";
import type { AdminResult } from "./admin";

export interface AdminPersonaRow {
  characterId: string;
  name: string;
  role: PersonaRole;
  lorebook: LorebookContent;
  edited: boolean;
}

export function adminPersonaCatalog(seed = 0): AdminPersonaRow[] {
  const overrides = readPersonaBooks();
  return personaCatalog(seed).map((person) => {
    if (!person.lorebook) throw new Error(`인물 카탈로그에 로어북이 없습니다: ${person.name}`);
    return {
      characterId: person.characterId,
      name: person.name,
      role: person.role,
      lorebook: person.lorebook,
      edited: Object.hasOwn(overrides, person.characterId),
    };
  });
}

export function adminUpdatePersonaBook(characterId: string, raw: unknown, seed = 0): AdminResult {
  const parsed = LorebookContentSchema.safeParse(raw);
  if (!parsed.success)
    return { ok: false, message: parsed.error.issues[0]?.message ?? "입력 오류" };
  const person = personaCatalog(seed).find((entry) => entry.characterId === characterId);
  if (!person) return { ok: false, message: `카탈로그에 없는 인물입니다: ${characterId}` };
  writePersonaBooks({
    ...readPersonaBooks(),
    [characterId]: namedCatalogBook(person.name, parsed.data),
  });
  return { ok: true, message: `${person.name} 로어북 갱신` };
}

export function adminResetPersonaCatalog(): AdminResult {
  clearPersonaBooks();
  return { ok: true, message: "인물 로어북을 시드 기본값으로 되돌렸습니다" };
}
