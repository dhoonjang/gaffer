import { type CounterpartyVoice } from "@story-fm/engine";
export function describeVoices(voices: readonly CounterpartyVoice[]): string[] {
  return voices.map((v) => `${v.speaker} ${v.name} (${v.title}) — ${v.answers.join(" · ")}`);
}
