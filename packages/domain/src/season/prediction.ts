import { z } from "zod";

// ── 시즌 예상 순위 — 언론이 개막 전에 매긴 줄 ──────────
/**
 * 언론의 시즌 예상 (`SEASON_PREDICTION`) — **개막 전 스쿼드가 원본이라 되돌릴 수
 * 없는 얇은 장부다** (season.md §2 「시즌 예상 순위」).
 *
 * 다른 파생과 다르다: `preseasonPrediction`은 결정적 순수 함수지만 **소집일의**
 * 스쿼드를 읽으므로, 여름 창이 닫히고 나면 같은 함수가 같은 답을 내지 못한다.
 * 그래서 그날 세워 여기 적어 둔다 — 리그 하나에 한 줄, 시즌마다 5행이다.
 *
 * ⚠️ **순서만 든다.** 점수도 항의 값도 적지 않는다 — 화면과 기사가 쓰는 것은 순위
 * 하나이고, 점수를 남기면 공식을 조율한 날 옛 시즌의 줄이 새 점수와 어긋난다.
 */
export const SeasonPredictionSchema = z.object({
  season: z.number().int(),
  leagueId: z.string().min(1),
  /** 예상 순서 — 1위부터. `GameTeam.id` */
  order: z.array(z.string().min(1)).min(1),
});

export type SeasonPrediction = z.infer<typeof SeasonPredictionSchema>;
