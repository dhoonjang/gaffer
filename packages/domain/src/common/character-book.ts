import { z } from "zod";

export const CHARACTER_INFORMATION_MAX = 12_000;
export const CHARACTER_CANDIDATES_MAX = 30;

export const CharacterBookContentSchema = z.object({
  name: z.string().trim().min(1).max(120),
  keywords: z.array(z.string().trim().min(1).max(120)).max(40),
  description: z.string().trim().min(1).max(240),
  information: z.string().trim().min(1).max(CHARACTER_INFORMATION_MAX),
});
export type CharacterBookContent = z.infer<typeof CharacterBookContentSchema>;
export const CharacterBookEditSchema = CharacterBookContentSchema.omit({ name: true });
export type CharacterBookEdit = z.infer<typeof CharacterBookEditSchema>;
export const CharacterBookEntrySchema = CharacterBookContentSchema.extend({
  id: z.string().min(1),
  version: z.number().int().min(1),
  kind: z.enum(["team", "player", "person"]),
});
export type CharacterBookEntry = z.infer<typeof CharacterBookEntrySchema>;
export const CharacterBookInjectionSchema = CharacterBookEntrySchema;
export type CharacterBookInjection = CharacterBookEntry;
export const CharacterCandidateSchema = CharacterBookContentSchema.pick({
  name: true,
  description: true,
});
export type CharacterCandidate = z.infer<typeof CharacterCandidateSchema>;
export const CharacterBookJobSchema = z.object({
  id: z.string().min(1),
  characterId: z.string().min(1),
  additionalInformation: z.string().trim().min(1).max(CHARACTER_INFORMATION_MAX),
  status: z.enum(["pending", "failed"]),
  attempts: z.number().int().min(0),
  error: z.string().optional(),
});
export type CharacterBookJob = z.infer<typeof CharacterBookJobSchema>;
export const CharacterUpdateSchema = z.object({
  characterId: z.string().min(1).describe("캐릭터북 항목 id 또는 이름"),
  additionalInformation: CharacterBookJobSchema.shape.additionalInformation,
  newCharacter: CharacterBookContentSchema.optional().describe(
    "처음 등장한 인물의 항목. 기존 인물에는 생략",
  ),
});

/** Stable rendering is also used to measure the history budget. */
export function characterBookText(entries: readonly CharacterBookInjection[]): string {
  if (entries.length === 0) return "";
  return `<character_book>\n${entries
    .map((entry) =>
      JSON.stringify({
        id: entry.id,
        name: entry.name,
        description: entry.description,
        information: entry.information,
      }),
    )
    .join("\n")}\n</character_book>`;
}
