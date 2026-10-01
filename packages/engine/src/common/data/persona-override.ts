import { z } from "zod";
import {
  CharacterBookContentSchema,
  type CharacterBookContent,
  type Persona,
} from "@story-fm/domain";
import { personaCatalogPath } from "../core/paths";
import { catalogSource, clearOverride, readOverride, writeOverride } from "./catalog-source";
import { namedCatalogBook, personaSeedBook, type PersonaSeed } from "./catalog-character-book";

const PersonaBooksSchema = z.record(z.string().min(1), CharacterBookContentSchema);
export type PersonaBooks = z.infer<typeof PersonaBooksSchema>;

const load = catalogSource<PersonaBooks>(() => {
  const parsed = PersonaBooksSchema.safeParse(readOverride(personaCatalogPath()));
  return parsed.success ? parsed.data : {};
});
const defaults = catalogSource(() => new Map<string, CharacterBookContent>());

export function readPersonaBooks(): PersonaBooks {
  return load();
}

/** Materialize at persona construction, retaining a book across repeated reads. */
export function withPersonaBook(seed: PersonaSeed): Persona {
  const { archetype, traits, motivation, speechStyle, keywords, characterBook, ...persona } = seed;
  const override = readPersonaBooks()[persona.characterId];
  if (override) return { ...persona, characterBook: namedCatalogBook(persona.name, override) };
  if (characterBook) {
    return { ...persona, characterBook: namedCatalogBook(persona.name, characterBook) };
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
  return { ...persona, characterBook: namedCatalogBook(persona.name, book) };
}

export function writePersonaBooks(books: PersonaBooks): void {
  writeOverride(personaCatalogPath(), books);
}

export function clearPersonaBooks(): void {
  clearOverride(personaCatalogPath());
}
