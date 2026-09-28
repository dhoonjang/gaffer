import { z } from "zod";
import { MatchSideSchema } from "../common/match-events";
import {
  LiveBandSchema,
  LiveBehaviorActionSchema,
  LiveBehaviorWhenSchema,
  LiveLaneSchema,
} from "./live-match";

/**
 * 경기 지시의 출처와 시트. Point는 감독 원문을 길이 제한해 보관하는 메타데이터다.
 * Jev는 시트의 타입 값을 판독하고 코어가 실재·예산·대가와 적용 가능성을 검증한다.
 */

export const PointImportanceSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export type PointImportance = z.infer<typeof PointImportanceSchema>;

/** 화면과 기록에 보관하는 감독 원문의 길이 상한 */
export const POINT_TEXT_MAX = 120;

/**
 * 코어가 정한 id와 감독 원문, 효과가 겨냥한 사람·편을 함께 보관한다.
 * 생성형 판독기의 비교 하네스도 같은 저장 그릇을 사용한다.
 */
export const PointSchema = z.object({
  id: z.string().min(1).max(40),
  text: z.string().min(1).max(POINT_TEXT_MAX),
  about: z.array(z.string().min(1)).default([]),
  importance: PointImportanceSchema,
});
export type Point = z.infer<typeof PointSchema>;

/**
 * 시트의 모양 여섯 — **전부 말의 규칙에 이미 있는 손잡이다** (live-match.md §6.2).
 *
 * `behavior`는 개인 지시, `edge`는 그 선수의 경기 계수, `focus`는 팀의 공격 방향 선호,
 * `temper`는 파울 확률, `legs`는 부하가 체력으로 바뀌는 배율, `cohesion`은 형태 오차.
 * 새 모양은 말의 규칙에서 움직이는 자리가 여섯과 다를 때만 선다.
 */
export const SHEET_SHAPES = ["behavior", "edge", "focus", "temper", "legs", "cohesion"] as const;
export const SheetShapeSchema = z.enum(SHEET_SHAPES);
export type SheetShape = z.infer<typeof SheetShapeSchema>;

export const SHEET_SHAPE_KO: Record<SheetShape, string> = {
  behavior: "개인 지시",
  edge: "실행 품질",
  focus: "공격 방향",
  temper: "거칠기",
  legs: "체력 소모",
  cohesion: "형태 유지",
};

/**
 * 한 줄의 표적 — 모양에 따라 채워지는 칸이 다르다.
 *
 * - `behavior` · `edge` · `temper` · `legs`: `player`.
 * - `focus`: `side` + `lane`.
 * - `cohesion`: `side`.
 *
 * 합집합이 아니라 한 객체인 것은 제공자마다 받는 스키마 부분집합이 달라서다
 * (`anyOf`를 쓰지 않는다 — agents `tool-schema.ts`). 모양과 표적의 짝이 맞는지는 코어가
 * 확인하고 어긋난 줄은 노트로 남긴다 (sim `sheet.ts`).
 */
export const SheetTargetSchema = z.object({
  player: z.string().min(1).optional(),
  side: MatchSideSchema.optional(),
  lane: LiveLaneSchema.optional(),
});
export type SheetTarget = z.infer<typeof SheetTargetSchema>;

export const SheetSignSchema = z.union([z.literal(1), z.literal(-1)]);
export type SheetSign = z.infer<typeof SheetSignSchema>;
export const SheetStepSchema = z.number().min(0).max(3);
export type SheetStep = z.infer<typeof SheetStepSchema>;

/**
 * 시트의 한 줄 — 포인트 하나의 수치 독해.
 *
 * `sign`은 **손잡이의 방향**이다: `edge` +는 그 말의 실행 품질이 오르고, `focus` +는 그
 * 레인으로 공이 더 가고, `temper` +는 파울 확률이 오르고, `legs` +는 소모가 늘고,
 * `cohesion` +는 형태가 단단해진다. `behavior`는 부호가 없다 — `action`이 무엇을 할지,
 * `when`이 어느 국면에, `targetPlayer`·`lane`·`band`가 누구를·어디를 가리킨다.
 * 어느 편에 이로운가는 부호와 표적의 편에서 코어가 파생한다.
 */
export const SheetLineSchema = z.object({
  pointId: z.string().min(1).max(40),
  target: SheetTargetSchema,
  shape: SheetShapeSchema,
  sign: SheetSignSchema,
  step: SheetStepSchema,
  /** `behavior`에만 — 개인 지시의 내용 */
  action: LiveBehaviorActionSchema.optional(),
  when: LiveBehaviorWhenSchema.optional(),
  targetPlayer: z.string().min(1).optional(),
  band: LiveBandSchema.optional(),
});
export type SheetLine = z.infer<typeof SheetLineSchema>;

/** 어느 편이 이로운가 — **표적 편의 이득이 되는 부호**인가 (live-match.md §6.2) */
export function sheetLineBenefits(line: Pick<SheetLine, "shape" | "sign">): boolean {
  switch (line.shape) {
    case "behavior":
      return true;
    case "edge":
    case "focus":
    case "cohesion":
      return line.sign > 0;
    case "temper":
    case "legs":
      return line.sign < 0;
  }
}
