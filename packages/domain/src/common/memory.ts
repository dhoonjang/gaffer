import { z } from "zod";
import { DateString } from "./date-string";

// ── 이력 압축 ─────────────────────────────────────────
/**
 * 이력 압축의 자국 — **접힌 구간의 요약과 어디까지 접었는가** (agents.md §5).
 *
 * 평시 이력은 글자 수로 잘린다. 창 밖으로 밀려난 대화는 그냥 사라졌었다 — 감독이
 * 3주 전에 한 약속도, 갈등의 발단도. 접을 때 그 구간을 요약해 이 자리에 남기면
 * GM이 계속 읽는다.
 *
 * ⚠️ **`state.chat`은 접지 않는다.** 채팅 화면은 전체 이력을 보여 준다 — 압축이
 * 바꾸는 것은 프롬프트 조립뿐이라 세이브에 남는 것은 여기 넷뿐이다.
 */
export const HistoryDigestSchema = z.object({
  /**
   * 접은 지점 — **평시 턴 몇 개가 요약 뒤로 넘어갔는가.**
   *
   * `state.chat`의 인덱스가 아니라 `inMatch !== true`인 턴만 센 수다. 채팅은 덧붙기만
   * 하고 경기 표식은 뒤늦게 바뀌지 않으므로 이 수는 한 번 정해지면 같은 곳을 가리킨다.
   */
  foldedTurns: z.number().int().min(0),
  /** 접힌 구간의 요약 — **지난 일**. 길이는 `HISTORY_DIGEST_CHARS`가 정한다 */
  text: z.string().min(1),
  /**
   * **열린 일** — 끝나지 않은 대화와 의도 (agents.md §5-1). 길이는
   * `HISTORY_OPEN_CHARS`가 정한다. 열린 일이 없으면 없다.
   */
  open: z.string().min(1).optional(),
  /** 마지막으로 접은 날 */
  at: DateString,
  /**
   * 몇 번 접었는가 — 압축은 이전 요약과 새로 잘린 구간을 함께 읽어 **다시 요약한다**.
   * 요약이 무한정 자라지 않는 것은 길이 상한이 보장하고, 이 값은 몇 겹을 지난
   * 기억인지를 요약 에이전트에게 알린다.
   */
  rounds: z.number().int().min(1),
});

export type HistoryDigest = z.infer<typeof HistoryDigestSchema>;

/**
 * **인물이 소유하는 기억** — 그 사람에게 이번 구간에 벌어진 일 한 줄 (people.md §9).
 *
 * `NarrativeNote`와 같은 결이되 주인이 다르다. 서사 메모리는 세계의 사건을 시간순으로
 * 쌓고, 이쪽은 **한 인물의 것**이라 그 인물이 무대에 설 때 함께 실린다.
 *
 * ⚠️ **성격·동기·말투는 여기 오지 않는다.** 페르소나는 시드로 결정적으로 생성되고
 * (`world/persona.ts`), 그걸 덮어쓰면 "같은 세이브는 같은 사람을 만난다"가 깨진다
 * (AGENTS.md §6.4). 기억은 **그 인물에게 일어난 일**이지 그 인물이 어떤 사람인가가 아니다.
 */
export const CharacterMemorySchema = z.object({
  /** 페르소나의 `characterId` — 전역 유일이다 (people.md §1) */
  characterId: z.string().min(1),
  date: DateString,
  text: z.string().min(1).max(120),
  salience: z.number().int().min(1).max(5),
});

export type CharacterMemory = z.infer<typeof CharacterMemorySchema>;
