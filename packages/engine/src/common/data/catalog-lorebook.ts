import type { LorebookContent, Persona } from "@story-fm/domain";
import { personaRoleLabel } from "@story-fm/domain";

/** The catalog identity owns the name; prose and matching terms remain editable. */
export function namedCatalogBook(name: string, book: LorebookContent): LorebookContent {
  return {
    name,
    keywords: [...book.keywords],
    description: book.description,
    information: book.information,
  };
}

/** Descriptive authoring inputs exist only until a seed is materialized. */
export type PersonaSeed = Omit<Persona, "lorebook"> & {
  lorebook?: LorebookContent;
  archetype: string;
  traits: readonly string[];
  motivation: string;
  speechStyle: { note: string; samples: readonly string[] };
  keywords: readonly string[];
  /** 바뀌지 않는 기본 정보 — 있으면 한 줄 설명이 이것이다(선수의 국적·출생연도·주발·키) */
  facts?: readonly string[];
};

export function personaSeedBook(persona: PersonaSeed): LorebookContent {
  return {
    name: persona.name,
    keywords: [...persona.keywords],
    description: identityLine(persona),
    information: [
      persona.archetype,
      persona.traits.join(". "),
      persona.motivation,
      persona.speechStyle.note,
      ...persona.speechStyle.samples,
    ].join("\n"),
  };
}

/**
 * 한 줄 설명 — **바뀌지 않는 기본 정보만** (lorebook.md §항목). 소속·포지션·나이처럼
 * 바뀌는 사실은 주입이 원장에서 붙이고(`stampLorebook`), 성격·동기는 자유 정보로 간다.
 */
function identityLine(persona: PersonaSeed): string {
  if (persona.facts && persona.facts.length > 0) return persona.facts.join(" · ");
  const role = personaRoleLabel(persona.role) ?? persona.name;
  return persona.outlet ? `${role} · ${persona.outlet}` : role;
}
