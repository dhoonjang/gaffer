import { z } from "zod";
import {
  FormationSchema,
  KEEPER_DISTRIBUTIONS,
  TACKLING_LEVELS,
  TRANSITION_MODES,
} from "@gaffer/domain";

/**
 * 경기 실험실의 요청 — 화면과 라우트가 같은 모양을 읽는다 (live-match.md §8.6).
 * 우리 판과 경기는 게임 화면이 게임의 라우트로 다루므로 여기 없다.
 */

/** 남겨 두는 실험실 판 — 다시 치른 판과 탭 두셋을 오가는 동안 앞의 판이 지워지지 않을 만큼 */
export const LAB_KEPT = 3;

const Scale5 = z.number().int().min(1).max(5);

/** 상대의 여섯 축과 갈래 넷 */
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

export const LabCreateSchema = z.object({
  homeTeamId: z.string().min(1),
  awayTeamId: z.string().min(1),
  managed: z.enum(["home", "away"]),
  seed: z.number().int().min(1).optional(),
});
export type LabCreate = z.infer<typeof LabCreateSchema>;

export const LabActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("formation"), formation: FormationSchema }),
  z.object({ kind: z.literal("tactics"), tactics: LabTacticsSchema }),
  /** 경기 판을 세운다 — `familiarity`가 있으면 두 팀의 적응도를 그 값으로 맞춘다. `null`은 판 그대로 */
  z.object({
    kind: z.literal("open"),
    familiarity: z.number().int().min(0).max(100).nullable(),
  }),
  /** 같은 조합·같은 판으로 새 실험실 판을 짓는다 — 응답은 새 판의 id다 */
  z.object({ kind: z.literal("replay") }),
]);
export type LabAction = z.infer<typeof LabActionSchema>;
