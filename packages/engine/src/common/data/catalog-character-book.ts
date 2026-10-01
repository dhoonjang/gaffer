import type { CharacterBookContent, Persona } from "@story-fm/domain";
import { personaRoleLabel } from "@story-fm/domain";

/** The catalog identity owns the name; prose and matching terms remain editable. */
export function namedCatalogBook(name: string, book: CharacterBookContent): CharacterBookContent {
  return {
    name,
    keywords: [...book.keywords],
    description: book.description,
    information: book.information,
  };
}

/** Descriptive authoring inputs exist only until a seed is materialized. */
export type PersonaSeed = Omit<Persona, "characterBook"> & {
  characterBook?: CharacterBookContent;
  archetype: string;
  traits: readonly string[];
  motivation: string;
  speechStyle: { note: string; samples: readonly string[] };
  keywords: readonly string[];
};

export function personaSeedBook(persona: PersonaSeed): CharacterBookContent {
  return {
    name: persona.name,
    keywords: [...persona.keywords],
    description: [personaRoleLabel(persona.role), persona.outlet ?? persona.motivation].join(" · "),
    information: [
      persona.archetype,
      persona.traits.join(". "),
      persona.motivation,
      persona.speechStyle.note,
      ...persona.speechStyle.samples,
    ].join("\n"),
  };
}
