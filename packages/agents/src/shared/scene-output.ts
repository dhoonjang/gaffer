import { OUTPUT_LANGUAGE } from "./output-language";

/** The story GM speaks the grammar consumed by the shared chat renderer. */
export const SCENE_OUTPUT_GRAMMAR = `- @Name: line — the speaker tag is that person's name. The screen adds the job title. Write players' names in ${OUTPUT_LANGUAGE} too.
- @: narration without a speaker.
- When the same speaker keeps talking, do not write the tag again.
- What is wrapped in *single asterisks* is action and staging.`;
