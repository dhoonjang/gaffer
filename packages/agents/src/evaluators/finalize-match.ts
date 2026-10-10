import {
  RATING_MIN,
  RATING_MAX,
  RATING_BAND,
  MATCH_FAMILIARITY_MIN,
  MATCH_FAMILIARITY_MAX,
  MATCH_ATTR_CAP,
  ATTR_STEP_MAX,
  ATTR_STEP_MIN,
  type MatchRatingBrief,
  type MatchSettlementEntry,
  type GameState,
  settleMatchRating,
  matchRated,
  buildRatingBrief,
  finalizeMatch,
  pushNews,
} from "@gaffer/engine";
import { ATTRIBUTE_AXES, AXIS_KO } from "@gaffer/domain";
import { agingDeclineLine } from "../shared/aging-line";
import { TURN_EXCERPT_CHARS } from "../shared/context";
import { ModelOutputError, retryOnce, anchorStands } from "../shared/retry";
import { validatedAnswer, majorityChoice } from "../shared/evaluation-answers";
import { MatchClosingSchema, type MatchClosing } from "./match-closing";
import {
  type EvaluationRequest,
  type EvaluationAnswer,
  type GameEvaluator,
  resolveLlmMode,
  createGameEvaluator,
} from "@gaffer/llm";
import { type GmToolCall } from "../shared/gm-types";

/** Score API indices map to evenly spaced values inside existing core bounds. */
const RATING_LEVELS = 7;
const DRILL_LEVELS = 6;
const SCORE_LABEL_DECIMALS = 2;

export const FINALIZE_MATCH_RULES = `Settle every player who appeared in the football match that just ended.
brief holds the confirmed records, minutes, position, rating anchor and room to grow; commentary is this match's commentary.
The anchor already holds the team result, goals, assists, the clean sheet or goals conceded, and cards, so do not add them again. Adjust for what it does not hold: shots and saves, dominance, handling danger, a player's own fault in a goal conceded, impact after a substitution.
Weigh minutes and position, and do not judge an individual by the team result alone. Do not invent experiences or achievements that did not happen.
The rating is ${RATING_MIN}~${RATING_MAX}, within ±${RATING_BAND} of the anchor. Score is the adjustment added to the anchor.
Tactical adaptation is ${MATCH_FAMILIARITY_MIN}~${MATCH_FAMILIARITY_MAX}. Having played long does not by itself guarantee growth.
Attributes: 0~${MATCH_ATTR_CAP} players across the whole match, one axis each by +${ATTR_STEP_MAX} or ${ATTR_STEP_MIN}. none if there is no change. ${agingDeclineLine()}
The numbers are the expected value of a probability distribution; do not multiply classification confidence into the growth. The core checks the final limits, potential, rounding and duplicate settlement.`;

const attributeOptions = ATTRIBUTE_AXES.flatMap((axis) =>
  [ATTR_STEP_MIN, ATTR_STEP_MAX].map((step) => ({
    key: `${axis}_${step < 0 ? "down" : "up"}`,
    axis,
    step,
    label: `${AXIS_KO[axis]} ${step > 0 ? "+" : ""}${step}`,
  })),
);

export function buildSettlementRequest(
  brief: MatchRatingBrief,
  commentary: string,
): EvaluationRequest {
  if (new Set(brief.players.map((player) => player.playerId)).size !== brief.players.length)
    throw new Error("경기 결산 대상이 중복되었습니다");
  const questions: EvaluationRequest["questions"] = {};
  brief.players.forEach((player, index) => {
    const who = `player ${player.playerId} (${player.name})`;
    questions[`p${index}_rating`] = {
      type: "score",
      instructions: `Adjustment added to the base rating ${player.anchor} of ${who}. Do not rate records already reflected a second time.`,
      criteria: Array.from({ length: RATING_LEVELS }, (_, i) =>
        String(
          Number(
            (-RATING_BAND + (i * (2 * RATING_BAND)) / (RATING_LEVELS - 1)).toFixed(
              SCORE_LABEL_DECIMALS,
            ),
          ),
        ),
      ),
    };
    questions[`p${index}_drill`] = {
      type: "score",
      instructions: `Tactical adaptation ${who} gained or lost in this match.`,
      criteria: Array.from({ length: DRILL_LEVELS }, (_, i) =>
        String(
          MATCH_FAMILIARITY_MIN +
            (i * (MATCH_FAMILIARITY_MAX - MATCH_FAMILIARITY_MIN)) / (DRILL_LEVELS - 1),
        ),
      ),
    };
    questions[`p${index}_attribute`] = {
      type: "choice",
      instructions: `One attribute axis and direction that changed for ${who} in the match they actually played. At most ${MATCH_ATTR_CAP} players across the whole match; none if the grounds are thin.`,
      criteria: {
        none: "no attribute change",
        ...Object.fromEntries(attributeOptions.map(({ key, label }) => [key, label])),
      },
    };
  });
  return { state: JSON.stringify({ rules: FINALIZE_MATCH_RULES, brief, commentary }), questions };
}

/** Validate the entire batch before returning any ledger entries. Identities are never generated. */
export async function evaluateSettlement(
  brief: MatchRatingBrief,
  commentary: string,
  evaluator: GameEvaluator,
): Promise<MatchSettlementEntry[]> {
  if (brief.players.length === 0) return [];
  const request = buildSettlementRequest(brief, commentary);
  const result = await evaluator.evaluate(request);
  const keys = Object.keys(request.questions);
  if (
    Object.keys(result.answers).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(result.answers, key))
  )
    throw new ModelOutputError("경기 결산 응답 목록이 요청과 다릅니다");
  const answers: Record<string, EvaluationAnswer> = {};
  for (const key of keys) {
    const answer = validatedAnswer(request.questions[key]!, result.answers[key]);
    if (!answer) throw new ModelOutputError(`경기 결산 응답이 유효하지 않습니다: ${key}`);
    answers[key] = answer;
  }
  return brief.players.map((player, index) => {
    const rating = answers[`p${index}_rating`];
    const drill = answers[`p${index}_drill`];
    const attribute = answers[`p${index}_attribute`];
    if (rating?.type !== "score" || drill?.type !== "score" || attribute?.type !== "choice")
      throw new ModelOutputError("경기 결산 응답 유형이 다릅니다");
    const selected = majorityChoice(attribute);
    const option = attributeOptions.find(({ key }) => key === selected);
    return {
      playerId: player.playerId,
      rating:
        player.anchor - RATING_BAND + (rating.score * (2 * RATING_BAND)) / (RATING_LEVELS - 1),
      drill:
        MATCH_FAMILIARITY_MIN +
        (drill.score * (MATCH_FAMILIARITY_MAX - MATCH_FAMILIARITY_MIN)) / (DRILL_LEVELS - 1),
      attribute: option?.axis ?? null,
      attributeStep: option?.step ?? null,
    };
  });
}

/** Existing match commentary only; closing prose never becomes numeric evaluation input. */
function buildCommentaryBlock(state: GameState, matchId: string): string {
  const lines = state.chat
    .filter(
      (t) =>
        t.inMatch === true &&
        t.role === "model" &&
        (t.matchId === undefined || t.matchId === matchId),
    )
    .map((t) => t.text.slice(0, TURN_EXCERPT_CHARS));
  return ["<commentary>", ...(lines.length > 0 ? lines : ["(중계가 없다)"]), "</commentary>"].join(
    "\n",
  );
}

/** Number of participants whose settlement reached the core. */
interface FinalizeOutcome {
  settled: number;
}

/** The core has already established anchors. Invalid evaluation leaves them untouched. */
export async function runFinalizeMatch(
  state: GameState,
  brief: MatchRatingBrief,
  evaluator?: GameEvaluator,
  closing: MatchClosing = {},
): Promise<FinalizeOutcome> {
  if (brief.players.length === 0 || matchRated(state, brief.matchId)) return { settled: 0 };
  if (evaluator === undefined && resolveLlmMode() === "mock") return { settled: 0 };
  const parsed = MatchClosingSchema.safeParse(closing);
  if (!parsed.success) {
    anchorStands("finalize:match")(
      new ModelOutputError("경기 마감 문장이 스키마를 지나지 못했습니다"),
    );
    return { settled: 0 };
  }
  let settled = 0;
  let client = evaluator;
  await retryOnce(
    "finalize:match",
    async () => {
      if (matchRated(state, brief.matchId)) return;
      client ??= createGameEvaluator("finalize-match");
      const entries = await evaluateSettlement(
        brief,
        buildCommentaryBlock(state, brief.matchId),
        client,
      );
      if (matchRated(state, brief.matchId)) return;
      const played =
        state.matches.find((match) => match.id === brief.matchId)?.result?.ratings ?? {};
      const allowed = new Set(
        brief.players
          .filter((player) => Object.hasOwn(played, player.playerId))
          .map((player) => player.playerId),
      );
      const notes = new Map<string, string>();
      for (const entry of parsed.data.notes ?? [])
        if (allowed.has(entry.playerId) && !notes.has(entry.playerId))
          notes.set(entry.playerId, entry.note);
      const result = settleMatchRating(
        state,
        brief.matchId,
        entries.map((entry) => ({
          ...entry,
          ...(notes.has(entry.playerId) ? { note: notes.get(entry.playerId)! } : {}),
        })),
      );
      if (result.already) return;
      if (result.applied === 0) throw new ModelOutputError("반영된 경기 평점이 없습니다");
      settled = result.applied;
    },
    () => matchRated(state, brief.matchId),
  ).catch(anchorStands("finalize:match"));
  return { settled };
}

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
