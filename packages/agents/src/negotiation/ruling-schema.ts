import { SQUAD_STATUSES, SQUAD_STATUS_KO } from "@story-fm/domain";
import { z } from "zod";
export const MONEY_MAX = 1_000_000_000_000;
/** 주급의 상한 */
export const WAGE_MAX = 1_000_000_000;
export const money = (max: number) => z.number().int().min(0).max(max);

/**
 * 지위 다섯의 낱말 — **코어의 표에서 온다** (prompts.md §2). 서류는 지위를 낱말로
 * 적고(`describeAnchor` — "기준 주전, 로테이션~핵심 안에서") 모델은 토큰으로 답하므로,
 * 둘을 잇는 표가 없으면 모델은 「핵심」이 `key`인지 `starter`인지를 짐작한다.
 * 오퍼·재계약이 싣는 지위 인자와 **한 자리에서 나온다**.
 */
export const SQUAD_STATUS_LINE = SQUAD_STATUSES.map((s) => `${s}(${SQUAD_STATUS_KO[s]})`).join(
  " · ",
);
