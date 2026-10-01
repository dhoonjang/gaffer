import { z } from "zod";
import { DateString } from "../common/date-string";

export const WorldFactDataSchema = z.object({
  text: z.string().max(600).optional(),
  refId: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  values: z.record(z.string(), z.number()).optional(),
  tags: z.array(z.string().min(1)).optional(),
  date: DateString.optional(),
});
export const InterviewFactSchema = z.object({
  kind: z.enum(["standing", "vacancy", "key-player", "finance-grade"]),
  data: WorldFactDataSchema,
});
export type InterviewFact = z.infer<typeof InterviewFactSchema>;
export const ManagerInterviewContextSchema = z.object({
  code: z.literal("interview"),
  value: z.number().optional(),
});
export type ManagerInterviewContext = z.infer<typeof ManagerInterviewContextSchema>;
export const ManagerInterviewSchema = z.object({
  id: z.string().min(1),
  date: DateString,
  speakerId: z.string().min(1),
  teamId: z.string().min(1),
  contextCard: ManagerInterviewContextSchema,
  facts: z.array(InterviewFactSchema).min(1),
  status: z.enum(["pending", "answered", "declined", "expired"]),
});
export type ManagerInterview = z.infer<typeof ManagerInterviewSchema>;
const FINANCE_GRADE_KO: Record<string, string> = {
  ok: "여유",
  caution: "주의 구간",
  danger: "위험 구간",
  rich: "리그 위쪽",
  mid: "리그 가운데",
  tight: "리그 아래쪽",
};
export const MANAGER_EXIT_KO: Record<string, string> = {
  sacked: "경질",
  expired: "계약 만료",
  resigned: "사임",
  moved: "이적",
};

export function interviewFactText(fact: InterviewFact): string {
  const d = fact.data;
  const v = d.values ?? {};
  const tags = d.tags ?? [];
  const sub = tags[0];
  const name = d.name ?? "";
  switch (fact.kind) {
    case "standing":
      return `현재 리그 ${v.rank ?? 0}위`;
    case "key-player":
      return (
        `1군 핵심 ${name}${sub ? ` (${sub})` : ""} · 만 ${v.age ?? 0}세` +
        (v.contractDays === undefined ? "" : ` · 계약 만료 D-${v.contractDays}`)
      );
    case "vacancy":
      return (
        `공석 ${v.days ?? 0}일째` +
        (v.position === undefined ? "" : ` — 전임 퇴장 당시 리그 ${v.position}위`)
      );
    case "finance-grade":
      return `${sub === "transfer-budget" ? "이적 예산" : "급여 비중"} — ${FINANCE_GRADE_KO[tags[1] ?? ""] ?? tags[1] ?? ""}`;
  }
}
export function managerInterviewContextText(
  context: ManagerInterviewContext,
  labels: { subject?: string } = {},
): string {
  return `${labels.subject ?? ""} 감독직 면접${context.value === undefined ? "" : ` · 현재 ${context.value}위`}`.trim();
}
export const MEDIA_FACT_KINDS = ["sacking", "appointment"] as const;
export const MediaFactKindSchema = z.enum(MEDIA_FACT_KINDS);
export type MediaFactKind = z.infer<typeof MediaFactKindSchema>;

/**
 * 기사 한 장 — **사실 한 줄.** 문장은 GM이 쓴다 (people.md §4-1).
 *
 * `data`가 회견 카드와 같은 모양(`WorldFactData`)인 것은 재는 것이 같아서다:
 * 수치와 코드와 「그때의 이름」. 한 줄의 한국어는 `mediaFactText` 하나가 만든다.
 */
export const MediaFactSchema = z.object({
  kind: MediaFactKindSchema,
  /** 실린 날 */
  date: DateString,
  /**
   * 이름이 걸린 사람 (`Persona.characterId`) — 없으면 지면 전체의 사실이다.
   * 화자가 있는 기사는 회견의 기자처럼 그 턴 인물 사전에 지목된다 (people.md §6).
   */
  speakerId: z.string().min(1).optional(),
  data: WorldFactDataSchema,
});
export type MediaFact = z.infer<typeof MediaFactSchema>;

/**
 * 기사 한 줄 — **화면·스냅샷·테스트가 같은 함수를 부른다** (people.md §4-1).
 * 물음표도 평가어도 없다: 무엇이 실렸는가라는 사실이다.
 */
export function mediaFactText(fact: MediaFact): string {
  const v = fact.data.values ?? {};
  const tags = fact.data.tags ?? [];
  const name = fact.data.name ?? "";
  switch (fact.kind) {
    case "sacking":
      return (
        `${name} 감독 ${MANAGER_EXIT_KO[tags[0] ?? ""] ?? "떠남"}` +
        (v.position === undefined ? "" : ` · 그날 ${v.position}위`) +
        (v.days === undefined ? "" : ` · 재임 ${v.days}일`)
      );
    case "appointment":
      // `tags[1]`이 그 구단의 이름이다 — 카드 하나가 이름 둘을 들어야 하는 자리라,
      // 더비 이름을 `tags[1]`에 싣는 `result` 카드와 같은 규약을 쓴다
      return (
        `${tags[1] ?? ""} 새 감독 ${name}` +
        (tags[0] === "pool" ? " (다른 벤치에 있던 사람)" : "") +
        (v.position === undefined ? "" : ` · 그 구단 ${v.position}위`)
      );
  }
}
