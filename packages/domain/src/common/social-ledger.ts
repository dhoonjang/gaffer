import { z } from "zod";
import { DateString } from "./date-string";

export const REACTION_SEASON_CAP = 20;

const response = z.number().min(-1).max(1).default(0);

/** 판단의 근거와 방향은 GM이, 반영 가능한 폭과 대상은 코어가 정한다. */
export const ReactionSchema = z.object({
  reason: z.string().trim().min(1).max(280),
  board: response,
  media: response,
  squad: response,
  target: response,
  team: response,
  rival: response,
});
export type Reaction = z.infer<typeof ReactionSchema>;
export type ReactionInput = z.input<typeof ReactionSchema>;
export type ReactionAxis = Exclude<keyof Reaction, "reason">;

export const BoardAgendaSchema = z.object({
  teamId: z.string().min(1),
  expectations: z.array(z.string().trim().min(1).max(280)).max(6),
  assessment: z.string().max(600),
  reviewedOn: DateString.nullable(),
  warningOn: DateString.optional(),
});
export type BoardAgenda = z.infer<typeof BoardAgendaSchema>;

export const BoardReviewSchema = z.object({
  season: z.number().int().optional().describe("완료된 시즌을 평가할 때 그 시즌 번호"),
  expectations: BoardAgendaSchema.shape.expectations.optional(),
  assessment: z.string().trim().min(1).max(600),
  confidence: z.number().min(-1).max(1),
  decision: z.enum(["continue", "warning", "dismiss"]),
  renewal: z
    .boolean()
    .optional()
    .describe("계약 만료 90일 이내 재계약 제안 여부 — 이번 평가에서 결정할 때만"),
});
export type BoardReview = z.infer<typeof BoardReviewSchema>;

export const InterviewOutcomeSchema = z.object({
  offer: z.boolean(),
  /** 0은 기본 조건, 1은 해당 구단이 허용하는 흥정 상한이다. */
  leverage: z.number().min(0).max(1),
  reason: z.string().trim().min(1).max(280),
});
export type InterviewOutcome = z.infer<typeof InterviewOutcomeSchema>;

/** 현재 기대와 평가의 같은 문장을 화면과 GM에 전달한다. */
export function boardAgendaLines(agenda: BoardAgenda): string[] {
  return [
    ...agenda.expectations.map((text) => `기대: ${text}`),
    ...(agenda.assessment ? [`보드 평가: ${agenda.assessment}`] : []),
    ...(agenda.warningOn ? [`고용 경고: ${agenda.warningOn}`] : []),
  ];
}
