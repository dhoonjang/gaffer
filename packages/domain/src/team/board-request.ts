import { z } from "zod";
import { DateString } from "../core/date-string";
import { formatMoney } from "../core/money";

const BOARD_REQUEST_KINDS = ["stadium"] as const;
const BoardRequestKindSchema = z.enum(BOARD_REQUEST_KINDS);
type BoardRequestKind = z.infer<typeof BoardRequestKindSchema>;

export const BOARD_REQUEST_LABEL: Record<BoardRequestKind, string> = {
  stadium: "구장 증설",
};

const BOARD_REQUEST_UNIT: Record<BoardRequestKind, "money" | "weekly" | "seats"> = {
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

const BoardRequestStatusSchema = z.enum(["pending", "conditional", "approved", "rejected"]);

const BOARD_CONDITION_KINDS = ["context"] as const;
const BoardConditionKindSchema = z.enum(BOARD_CONDITION_KINDS);
type BoardConditionKind = z.infer<typeof BoardConditionKindSchema>;

const BoardConditionSchema = z.object({
  kind: BoardConditionKindSchema,
  amount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  since: DateString,
  until: DateString,
});
type BoardCondition = z.infer<typeof BoardConditionSchema>;

export const BOARD_CONDITION_LABEL: Record<BoardConditionKind, string> = {
  context: "맥락 조건",
};

export function boardConditionAmountText(_condition: BoardCondition): string {
  void _condition;
  return "합의 이행 확인";
}

export const BoardRequestSchema = z.object({
  teamId: z.string().min(1),
  id: z.string().min(1),
  kind: BoardRequestKindSchema,
  askedOn: DateString,
  respondOn: DateString,
  amount: z.number().min(0),
  status: BoardRequestStatusSchema,
  condition: BoardConditionSchema.optional(),
  granted: z.number().min(0).optional(),
  resolvedOn: DateString.optional(),
  deliversOn: DateString.optional(),
  deliveredOn: DateString.optional(),
  decision: z.enum(["approved", "rejected", "conditional"]).optional(),
  authorizedBy: z.string().min(1).optional(),
});
export type BoardRequest = z.infer<typeof BoardRequestSchema>;

export const RequestBoardInputSchema = z.object({
  requestId: z.string().min(1).optional(),
  kind: BoardRequestKindSchema,
  amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  respondOn: DateString.optional(),
  decision: z.enum(["approved", "rejected", "conditional"]).optional(),
  authorizedBy: z.string().min(1).optional(),
  granted: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  deliversOn: DateString.optional(),
  condition: BoardConditionSchema.optional(),
});
export type RequestBoardInput = z.infer<typeof RequestBoardInputSchema>;
