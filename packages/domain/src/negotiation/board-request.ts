import { z } from "zod";
import { DateString } from "../common/date-string";
import { formatMoney } from "../common/money";

export const BOARD_REQUEST_KINDS = ["transfer-budget", "signing", "wage-room", "stadium"] as const;
export const BoardRequestKindSchema = z.enum(BOARD_REQUEST_KINDS);
export type BoardRequestKind = z.infer<typeof BoardRequestKindSchema>;

export const BOARD_REQUEST_LABEL: Record<BoardRequestKind, string> = {
  "transfer-budget": "이적 예산 증액",
  signing: "영입 승인",
  "wage-room": "주급 한도 상향",
  stadium: "구장 증설",
};

export const BOARD_REQUEST_UNIT: Record<BoardRequestKind, "money" | "weekly" | "seats"> = {
  "transfer-budget": "money",
  signing: "money",
  "wage-room": "weekly",
  stadium: "seats",
};

export function boardRequestAmountText(kind: BoardRequestKind, value: number): string {
  switch (BOARD_REQUEST_UNIT[kind]) {
    case "money":
      return formatMoney(value);
    case "weekly":
      return `${formatMoney(value)}/주`;
    case "seats":
      return `${value.toLocaleString("en-US")}석`;
  }
}

export const BoardRequestStatusSchema = z.enum(["pending", "conditional", "approved", "rejected"]);
export type BoardRequestStatus = z.infer<typeof BoardRequestStatusSchema>;

export const BOARD_CONDITION_KINDS = ["raise", "wage-cut", "context"] as const;
export const BoardConditionKindSchema = z.enum(BOARD_CONDITION_KINDS);
export type BoardConditionKind = z.infer<typeof BoardConditionKindSchema>;

export const BoardConditionSchema = z.object({
  kind: BoardConditionKindSchema,
  amount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  since: DateString,
  until: DateString,
});
export type BoardCondition = z.infer<typeof BoardConditionSchema>;

export const BOARD_CONDITION_LABEL: Record<BoardConditionKind, string> = {
  raise: "매각으로 마련",
  "wage-cut": "주급 총액 감축",
  context: "맥락 조건",
};

export function boardConditionAmountText(condition: BoardCondition): string {
  if (condition.kind === "context") return "합의 이행 확인";
  return condition.kind === "wage-cut"
    ? `${formatMoney(condition.amount)}/주 아래로`
    : formatMoney(condition.amount);
}

export const BoardRequestSchema = z.object({
  teamId: z.string().min(1),
  id: z.string().min(1),
  kind: BoardRequestKindSchema,
  askedOn: DateString,
  respondOn: DateString,
  amount: z.number().min(0),
  playerId: z.string().min(1).optional(),
  status: BoardRequestStatusSchema,
  condition: BoardConditionSchema.optional(),
  granted: z.number().min(0).optional(),
  resolvedOn: DateString.optional(),
  deliversOn: DateString.optional(),
  deliveredOn: DateString.optional(),
  decision: z.enum(["approved", "rejected", "conditional"]).optional(),
  authorizedBy: z.string().min(1).optional(),
  validUntil: DateString.optional(),
});
export type BoardRequest = z.infer<typeof BoardRequestSchema>;

export const RequestBoardInputSchema = z.object({
  requestId: z.string().min(1).optional(),
  kind: BoardRequestKindSchema,
  amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  playerId: z.string().min(1).optional(),
  respondOn: DateString.optional(),
  decision: z.enum(["approved", "rejected", "conditional"]).optional(),
  authorizedBy: z.string().min(1).optional(),
  granted: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  validUntil: DateString.optional(),
  deliversOn: DateString.optional(),
  condition: BoardConditionSchema.optional(),
});
export type RequestBoardInput = z.infer<typeof RequestBoardInputSchema>;
