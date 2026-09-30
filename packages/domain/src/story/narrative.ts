import { z } from "zod";
import { DateString } from "../common/date-string";

// ── 서사 ──────────────────────────────────────────────
/**
 * 서사 줄의 갈래 — **하루 한도를 세는 열쇠.**
 *
 * GM이 부른 서사 이벤트만 하루 상한이 걸리는데, 그것을 문장 접두사(`[서사]`)로
 * 가르면 접두사를 고치는 순간 상한이 사라진다 (overview.md §1 철칙 4).
 */
export const NarrativeKindSchema = z.enum([
  /** 경기 결과 */
  "match",
  /** 시즌 결산·우승·순위 */
  "season",
  /** 계약·선수단의 들고 남 */
  "contract",
  /** GM의 `record_incident` — 하루 한도가 걸리는 유일한 갈래 (people.md §6) */
  "incident",
  /** 그 밖의 호출 결과·tick 사건 */
  "other",
]);

export type NarrativeKind = z.infer<typeof NarrativeKindSchema>;

/**
 * **감독이 말로 만든 사건의 갈래 — 사건의 이름이 아니라 효과의 모양이다**
 * (→ docs/story/people.md §6 「사건 기록」).
 *
 * 벌금과 출전 정지는 둘 다 `discipline`이고 보너스와 휴가는 둘 다 `reward`다. 무슨
 * 일이었는지는 `summary`와 장면이 갖고, 코어는 갈래·당사자·세기만 들어 효과표를 편다.
 * 이름으로 가르면 갈래가 사건 수만큼 늘고, 표에 없는 사건은 장부에 설 길이 없다.
 */
export const INCIDENT_KINDS = [
  /** 벌금 · 출전 정지 · 훈련 열외 */
  "discipline",
  /** 포상 · 휴가 · 특별 대우 */
  "reward",
  /** 병문안 · 가족 배려 · 개인 사정을 봐줌 */
  "care",
  /** 언론·라커룸 앞의 칭찬 */
  "public-praise",
  /** 언론·라커룸 앞의 질책 */
  "public-criticism",
  /** 감독의 사과 */
  "apology",
  /** 선수 둘 사이의 중재 */
  "mediation",
  /** 라커룸 규칙 · 통금 · 휴대폰 금지 */
  "rule",
  /** 회식 · 단합 · 견학 */
  "outing",
  /** 표에 없는 것 — 기록만 남는다 */
  "other",
] as const;

export const IncidentKindSchema = z.enum(INCIDENT_KINDS);

export type IncidentKind = z.infer<typeof IncidentKindSchema>;

/** 갈래 → 사람이 읽는 말 — 회견 카드·말풍선이 같은 표를 읽는다 */
export const INCIDENT_KIND_KO: Record<IncidentKind, string> = {
  discipline: "징계",
  reward: "포상",
  care: "배려",
  "public-praise": "공개 칭찬",
  "public-criticism": "공개 질책",
  apology: "사과",
  mediation: "중재",
  rule: "라커룸 규칙",
  outing: "회식",
  other: "사건",
};

/** 장부에 남는 사건 한 줄 (`state.incidents`) — 회견 카드와 하루 한도가 읽는다 */
export const IncidentSchema = z.object({
  date: DateString,
  kind: IncidentKindSchema,
  /** 당사자 (`GAME_PLAYER.id`) — 하나 이상 */
  playerIds: z.array(z.string().min(1)).min(1),
  /** 세기 1~3 — 면담의 강도와 같은 눈금 */
  intensity: z.number().int().min(1).max(3),
  /** 무슨 일이었나 — 한 줄. 장면의 것이지 판정의 것이 아니다 */
  summary: z.string().min(1).max(200),
});

export type Incident = z.infer<typeof IncidentSchema>;

/** GM 프롬프트에 주입되는 서사 기억 (일지는 기록 테이블에서 파생) */
export const NarrativeNoteSchema = z.object({
  date: DateString,
  text: z.string().min(1),
  salience: z.number().int().min(1).max(5),
  /** 갈래 — 갈래를 말하지 않은 줄은 `other`다 */
  kind: NarrativeKindSchema,
});

export type NarrativeNote = z.infer<typeof NarrativeNoteSchema>;
