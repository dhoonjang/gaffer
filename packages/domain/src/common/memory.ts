import { z } from "zod";
import { CharacterCandidateSchema, CHARACTER_CANDIDATES_MAX } from "./lorebook";
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
  candidates: z.array(CharacterCandidateSchema).max(CHARACTER_CANDIDATES_MAX).optional(),
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
