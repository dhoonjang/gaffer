import { z } from "zod";
import { LorebookContentSchema, type LorebookContent, type Persona } from "@gaffer/domain";
import { personaCatalogPath } from "../../core/catalog/paths";
import {
  catalogSource,
  clearOverride,
  readOverride,
  writeOverride,
} from "../../core/catalog/catalog-source";
import {
  namedCatalogBook,
  personaSeedBook,
  type PersonaSeed,
} from "../../core/catalog/catalog-lorebook";

const PersonaBooksSchema = z.record(z.string().min(1), LorebookContentSchema);
type PersonaBooks = z.infer<typeof PersonaBooksSchema>;

const load = catalogSource<PersonaBooks>(() => {
  const parsed = PersonaBooksSchema.safeParse(readOverride(personaCatalogPath()));
  return parsed.success ? parsed.data : {};
});
const defaults = catalogSource(() => new Map<string, LorebookContent>());

export function readPersonaBooks(): PersonaBooks {
  return load();
}

/** Materialize at persona construction, retaining a book across repeated reads. */
export function withPersonaBook(seed: PersonaSeed): Persona {
  const { archetype, traits, motivation, speechStyle, keywords, lorebook, ...persona } = seed;
  const override = readPersonaBooks()[persona.characterId];
  if (override) return { ...persona, lorebook: namedCatalogBook(persona.name, override) };
  if (lorebook) {
    return { ...persona, lorebook: namedCatalogBook(persona.name, lorebook) };
  }
  const key = JSON.stringify([
    persona.characterId,
    persona.seed,
    persona.role,
    archetype,
    traits,
    motivation,
    speechStyle,
    keywords,
    persona.outlet,
  ]);
  const books = defaults();
  let book = books.get(key);
  if (!book) {
    book = personaSeedBook(seed);
    books.set(key, book);
  }
  return { ...persona, lorebook: namedCatalogBook(persona.name, book) };
}

export function writePersonaBooks(books: PersonaBooks): void {
  writeOverride(personaCatalogPath(), books);
}

export function clearPersonaBooks(): void {
  clearOverride(personaCatalogPath());
}
