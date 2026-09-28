import { type GameState, buildRatingBrief, finalizeMatch, pushNews } from "@story-fm/engine";
import { type GmToolCall } from "../../../common/gm-types";
import { type GameEvaluator } from "@story-fm/llm";
import { type FinalizeOutcome, runFinalizeMatch } from "../../../match/finalize-match";
import { type MatchClosing } from "../../../match/match-closing";

/**
 * **경기 마감 한 걸음** — `finalize_match` 도구의 핸들러이자, GM이 마감을 부르지 않은
 * 턴에 코어가 대신 도는 안전망이다 (agents.md §3 「경기 마감」).
 *
 * 순서가 계약이다: 평점 브리프(장부가 살아 있을 때) → `finalizeMatch`(앵커) → 마감
 * 타입 평가. 마감 기록은 말풍선(**대회 · "경기 종료"**)으로 서고, 결산은 감독이 부른
 * 적 없는 내부 판정이라 칩으로 세우지 않는다. `null`이면 마감할 장부가 없었다.
 */
export async function finalizeMatchTurn(
  state: GameState,
  calls: GmToolCall[],
  evaluator?: GameEvaluator,
  closing: MatchClosing = {},
): Promise<FinalizeOutcome | null> {
  const brief = buildRatingBrief(state);
  if (!brief) return null;
  const digest = finalizeMatch(state);
  /**
   * 말풍선에는 **우리 경기만** 선다 — 재정과 같은 라운드 다른 경기는 감독이
   * 확인하러 갈 화면(재정·대회)이 이미 갖고 있다. 대신 모델은 다음 평시 턴에
   * 셋을 다 읽는다 (`pendingNews` → `buildGmStateNote`).
   */
  calls.push({
    name: "finalize_match",
    // 요약은 **머리줄 하나**다 — 항목은 `brief`가 싣는다. 여기서 이어 붙이면 장부 줄도
    // 화면도 한 문자열을 받아 도로 쪼개야 한다 (overview.md §2)
    summary: "경기 종료",
    brief: { head: "경기 종료", items: digest.ours.map((text) => ({ text })) },
  });
  pushNews(state, [...digest.finance, ...digest.others]);
  const outcome = await runFinalizeMatch(state, brief, evaluator, closing);
  if (outcome.settled > 0) {
    calls.push({
      // 기록의 이름 — 코어 걸음(`settleMatchRating`)의 이름이지 모델이 보는 도구가 아니다
      name: "settle_match",
      summary: `경기 결산 ${outcome.settled}명`,
      silent: true,
    });
  }
  return outcome;
}
