import { OUTPUT_LANGUAGE } from "./output-language";

/** 평시 GM이 쓰는 목소리 커맨드 — 공용 채팅 렌더러가 읽는 문법이다 (prompts.md §1). */
export const SCENE_OUTPUT_GRAMMAR = `- <speak name="Name">…</speak> — a person's words. name is that person's name; the screen adds the job title. Write players' names in ${OUTPUT_LANGUAGE} too. Inside, what is wrapped in *single asterisks* is action and staging.
- <narration>…</narration> — narration without a speaker, written without asterisks.
- While the same person keeps talking, change lines inside one <speak>. Open a new command whenever the speaker changes, and close each command before the next.`;
