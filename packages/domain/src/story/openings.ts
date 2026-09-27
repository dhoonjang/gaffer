import { z } from "zod";
import { DateString } from "../common/date-string";

// ── 시작 사건 ─────────────────────────────────────────

export const OPENING_KINDS = [
  /** 구단주·보드의 시선 — 무엇을 지켜보는가 */
  "board",
  /** 라커룸 — 누가 새 감독을 재는가 */
  "dressing-room",
  /** 언론 — 어떤 이름표가 붙었는가 */
  "press",
  /** 감독 개인사 — 배경이 남긴 것 */
  "personal",
] as const;

export const OpeningKindSchema = z.enum(OPENING_KINDS);

export type OpeningKind = z.infer<typeof OpeningKindSchema>;

export const OPENING_KIND_KO: Record<OpeningKind, string> = {
  board: "보드",
  "dressing-room": "라커룸",
  press: "언론",
  personal: "개인사",
};

/**
 * 실마리가 닫힌 사유 — **지나간 것과 해결된 것은 다른 사실이다** (career.md §1).
 * `handled`는 감독이 그 실마리에 걸린 일을 했다는 뜻이고, `expired`는 기한이 지났다는
 * 뜻이다.
 */
export const OPENING_CLOSES = ["handled", "expired"] as const;

export const OpeningCloseSchema = z.enum(OPENING_CLOSES);

export type OpeningClose = z.infer<typeof OpeningCloseSchema>;

export const OPENING_TITLE_MAX = 40;

export const OPENING_LINE_MAX = 160;

export const OpeningSchema = z.object({
  id: z.string().min(1),
  kind: OpeningKindSchema,
  /** 한 줄 이름 */
  title: z.string().min(1).max(OPENING_TITLE_MAX),
  /** 사실의 꼴로 적은 실마리 — 문장은 GM이 쓴다 */
  line: z.string().min(1).max(OPENING_LINE_MAX),
  /** 걸린 사람 — 우리 선수의 id 또는 인물의 characterId. 없을 수 있다 */
  subjectId: z.string().min(1).optional(),
  openedOn: DateString,
  /** 이 날이 지나면 닫힌다 — 실마리는 첫 몇 주의 것이다 */
  dueOn: DateString,
  /** null = 아직 열려 있다 */
  resolvedOn: DateString.nullable(),
  /** 왜 닫혔는가 — 열려 있으면 서지 않는다 */
  resolvedBy: OpeningCloseSchema.optional(),
});

export type Opening = z.infer<typeof OpeningSchema>;
