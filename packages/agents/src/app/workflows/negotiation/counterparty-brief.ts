import { type GameState, buildCounterpartyBrief, characterEntryOf } from "@story-fm/engine";
import { type Negotiation, type TableSpeaker } from "@story-fm/domain";
import { describeCharacters } from "../../../common/context";
import { describeVoices } from "../../../negotiation/counterparty-brief";

/**
 * `<counterparty>` 블록 — 협상 하나의 서류. 앵커는 싣지 않는다 — 그것은 대화 뒤에 따로
 * 선다(`describeSeatAnchor`). 열린 협상이 아니면 `null`.
 *
 * `dossier: false`면 라운드마다 바뀌는 `<dossier>`(오퍼 이력·값의 자·조건서·개인 조건)를
 * 뺀다 — 협상 방의 레퍼런스가 그 꼴이고, 뺀 것은 `<table>` 스냅샷이 싣는다 (agents.md §5).
 */
export function buildCounterpartyBlock(
  state: GameState,
  negotiation: Negotiation,
  options: { dossier?: boolean; party?: TableSpeaker } = {},
): string | null {
  const brief = buildCounterpartyBrief(state, negotiation);
  if (!brief) return null;
  /**
   * **방에는 한 사람이 앉는다** (transfer.md §12-2) — 자리를 적으면 그 목소리와 그 사람의
   * 카드만 싣는다. 선수의 카드는 어느 자리든 선다: 이야기의 대상이다.
   */
  const voices =
    options.party === undefined
      ? brief.voices
      : brief.voices.filter((v) => v.speaker === options.party);
  const seated = new Set(voices.map((v) => v.name));
  const player = state.players.find((p) => p.id === negotiation.gamePlayerId);
  const characterIds =
    options.party === undefined
      ? brief.characterIds
      : brief.characterIds.filter((id) => seated.has(id) || id === player?.name);
  // 데이터 블록은 영어 태그로 싼다 (prompts.md §5) — 서류의 줄 안 레이블은 그대로다
  const cards = describeCharacters(
    characterIds.map((id) => characterEntryOf(state, id, "full")).filter((entry) => entry !== null),
  );
  return [
    `<counterparty id="${negotiation.id}">`,
    `<negotiation>${brief.kindKo} · 건너편: ${brief.counterpart} · 감독의 구단: ${brief.ourClub}</negotiation>`,
    ...describeVoices(voices),
    `<player>`,
    ...brief.playerFacts,
    `</player>`,
    ...(options.dossier === false ? [] : [`<dossier>`, ...brief.dossier, `</dossier>`]),
    ...(cards !== null ? [cards] : []),
    `</counterparty>`,
  ].join("\n");
}
