import { z } from "zod";
import { DateString } from "../common/date-string";

export const SEARCH_MIN_AGE = 15;
export const SEARCH_MAX_AGE = 45;

export const ScoutingScopeSchema = z.object({
  playerIds: z.array(z.string().min(1)),
  competitionId: z.string().min(1).nullable(),
  position: z.string().min(1).nullable(),
  minAge: z.number().int().min(SEARCH_MIN_AGE).max(SEARCH_MAX_AGE).nullable(),
  maxAge: z.number().int().min(SEARCH_MIN_AGE).max(SEARCH_MAX_AGE).nullable(),
  maxValue: z.number().finite().nonnegative().nullable(),
});
export type ScoutingScope = z.infer<typeof ScoutingScopeSchema>;

export const ScoutingPlanSchema = z.object({
  status: z.enum(["ready", "needs_revision", "unavailable"]),
  days: z.number().int().nonnegative().max(36525),
  depth: z.enum(["public_records", "match_review", "extended_review"]),
  focus: z.array(z.enum(["ability", "role", "development", "availability", "contract"])).min(1),
  expectations: z.array(
    z.object({
      topic: z.enum(["ability", "role", "development", "availability", "contract"]),
      precision: z.enum(["unknown", "broad", "supported"]),
    }),
  ),
  evidenceRefs: z.array(z.string().min(1)),
  limitations: z.array(
    z.enum([
      "no_matches",
      "no_recent_matches",
      "limited_access",
      "workload",
      "deadline",
      "no_candidates",
    ]),
  ),
});
export type ScoutingPlan = z.infer<typeof ScoutingPlanSchema>;

export const ScoutingRangeSchema = z
  .object({
    low: z.number().finite().min(1).max(99),
    high: z.number().finite().min(1).max(99),
  })
  .refine((r) => r.low <= r.high, "Inverted observation range");

// Public evidence never contains hidden attributes or true potential. It is frozen at the due date.
export const ScoutingEvidenceSchema = z.object({
  playerId: z.string().min(1),
  name: z.string().min(1),
  teamId: z.string().min(1),
  team: z.string().min(1),
  age: z.number().int().nonnegative(),
  position: z.string().min(1),
  positions: z.array(z.string().min(1)),
  contractUntil: DateString.nullable(),
  weeklyWage: z.number().finite().nonnegative().nullable(),
  listed: z.boolean(),
  marketEstimate: z.number().finite().nonnegative().nullable(),
  sources: z.array(z.object({ id: z.string().min(1), date: DateString, text: z.string().min(1) })),
});
export type ScoutingEvidence = z.infer<typeof ScoutingEvidenceSchema>;

export const ScoutingAssessmentSchema = z.object({
  playerId: z.string().min(1),
  fit: z.enum(["recommended", "consider", "unsuitable", "unknown"]),
  overall: ScoutingRangeSchema.nullable(),
  potential: ScoutingRangeSchema.nullable(),
  attributes: z.record(ScoutingRangeSchema),
  evidenceRefs: z.array(z.string().min(1)),
  strengths: z.array(z.enum(["performance", "role", "development", "availability", "contract"])),
  concerns: z.array(
    z.enum([
      "performance",
      "role",
      "development",
      "availability",
      "contract",
      "insufficient_evidence",
    ]),
  ),
});
export type ScoutingAssessment = z.infer<typeof ScoutingAssessmentSchema>;

export const ScoutingRequestSchema = z.object({
  id: z.string().min(1),
  revision: z.number().int().positive(),
  requestedOn: DateString,
  source: z.string().min(1),
  question: z.string().min(1),
  scope: ScoutingScopeSchema,
  deadline: DateString.nullable(),
  previousReportId: z.string().min(1).nullable(),
  plan: ScoutingPlanSchema.nullable(),
  dueOn: DateString.nullable(),
  status: z.enum(["planning", "scheduled", "held", "ready", "failed", "completed", "cancelled"]),
  evidenceOn: DateString.nullable(),
  evidence: z.array(ScoutingEvidenceSchema),
  reportId: z.string().min(1).nullable(),
  error: z.string().nullable(),
});
export type ScoutingRequest = z.infer<typeof ScoutingRequestSchema>;

export const ScoutingReportSchema = z.object({
  id: z.string().min(1),
  requestId: z.string().min(1),
  revision: z.number().int().positive(),
  requestedOn: DateString,
  completedOn: DateString,
  evidenceOn: DateString,
  question: z.string().min(1),
  plan: ScoutingPlanSchema,
  candidates: z.array(
    z.object({ evidence: ScoutingEvidenceSchema, assessment: ScoutingAssessmentSchema }),
  ),
});
export type ScoutingReport = z.infer<typeof ScoutingReportSchema>;

export const ScoutingInputSchema = z.object({
  action: z.enum(["request", "revise", "cancel", "retry"]),
  requestId: z.string().min(1).optional(),
  question: z.string().min(1).optional(),
  playerIds: z.array(z.string().min(1)).optional(),
  competition: z.string().min(1).optional(),
  position: z.string().min(1).optional(),
  minAge: z.number().int().min(SEARCH_MIN_AGE).max(SEARCH_MAX_AGE).optional(),
  maxAge: z.number().int().min(SEARCH_MIN_AGE).max(SEARCH_MAX_AGE).optional(),
  maxValue: z.number().finite().nonnegative().optional(),
  deadline: DateString.optional(),
  previousReportId: z.string().min(1).optional(),
});
export type ScoutingInput = z.infer<typeof ScoutingInputSchema>;

export const SCOUTING_DEPTH_LABELS: Record<ScoutingPlan["depth"], string> = {
  public_records: "공개 기록 중심",
  match_review: "경기 자료 분석",
  extended_review: "여러 경기와 이력 검토",
};
export const SCOUTING_FIT_LABELS: Record<ScoutingAssessment["fit"], string> = {
  recommended: "추천",
  consider: "검토할 만함",
  unsuitable: "요구에 맞지 않음",
  unknown: "판단 보류",
};
export const SCOUTING_TOPIC_LABELS = {
  ability: "능력",
  performance: "경기력",
  role: "역할 적합성",
  development: "성장 가능성",
  availability: "출전·부상 이력",
  contract: "계약",
  insufficient_evidence: "근거 부족",
  no_matches: "관측할 경기 기록 없음",
  no_recent_matches: "최근 경기 기록 부족",
  limited_access: "자료 접근 제한",
  workload: "진행 중인 조사",
  deadline: "기한 제약",
  no_candidates: "조건에 맞는 후보 없음",
} as const;
