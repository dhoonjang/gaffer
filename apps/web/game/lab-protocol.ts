import { z } from "zod";
import {
  FormationSchema,
  KEEPER_DISTRIBUTIONS,
  TACKLING_LEVELS,
  TRANSITION_MODES,
} from "@gaffer/domain";
import type { LabView } from "@gaffer/engine";
import type { GamePayload } from "./store";

/**
 * 경기 실험실의 요청 — 화면과 라우트가 같은 모양을 읽는다 (live-match.md §8.6).
 * 전술판 저장·실시간 경기는 게임의 라우트를 그대로 쓰므로 여기 없다.
 */

const Scale5 = z.number().int().min(1).max(5);

/** 여섯 축과 갈래 넷 — 실험실은 상대 판까지 고치므로 갈래도 화면에서 받는다 */
const LabTacticsSchema = z
  .object({
    mentality: Scale5,
    defensiveLine: Scale5,
    pressing: Scale5,
    tempo: Scale5,
    width: Scale5,
    passStyle: Scale5,
    transition: z.enum(TRANSITION_MODES),
    offsideTrap: z.boolean(),
    tackling: z.enum(TACKLING_LEVELS),
    keeperDistribution: z.enum(KEEPER_DISTRIBUTIONS),
  })
  .partial();
export type LabTactics = z.infer<typeof LabTacticsSchema>;

const LabSideSchema = z.enum(["ours", "theirs"]);

export const LabCreateSchema = z.object({
  homeTeamId: z.string().min(1),
  awayTeamId: z.string().min(1),
  managed: z.enum(["home", "away"]),
  seed: z.number().int().min(1).optional(),
});
export type LabCreate = z.infer<typeof LabCreateSchema>;

export const LabActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("formation"), side: LabSideSchema, formation: FormationSchema }),
  z.object({ kind: z.literal("tactics"), side: LabSideSchema, tactics: LabTacticsSchema }),
  /** `familiarity`가 있으면 두 팀의 적응도를 그 값으로 맞춘다 — `null`은 판 그대로 */
  z.object({
    kind: z.literal("kickoff"),
    familiarity: z.number().int().min(0).max(100).nullable(),
  }),
  /** 정지점의 사건을 읽었다 — 실험실에는 그것을 중계할 턴이 없다 */
  z.object({ kind: z.literal("seen") }),
  z.object({ kind: z.literal("rewind") }),
]);
export type LabAction = z.infer<typeof LabActionSchema>;

/** 판 한 장 — 화면이 그리는 게임 payload와 실험실의 두 팀 */
export interface LabSnapshot {
  game: GamePayload;
  lab: LabView;
}
