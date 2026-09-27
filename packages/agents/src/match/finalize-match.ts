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
  applyMoodNotes,
  matchRated,
} from "@story-fm/engine";
import { ATTRIBUTE_AXES, AXIS_KO } from "@story-fm/domain";
import { agingDeclineLine } from "../common/aging-line";
import { TURN_EXCERPT_CHARS } from "../common/context";
import { ModelOutputError, retryOnce, anchorStands } from "../common/retry";
import { validatedAnswer, majorityChoice } from "../common/evaluation-answers";
import { MatchClosingSchema, type MatchClosing } from "./match-closing";
import {
  type EvaluationRequest,
  type EvaluationAnswer,
  type GameEvaluator,
  resolveLlmMode,
  createGameEvaluator,
} from "@story-fm/llm";

/** Score API indices map to evenly spaced values inside existing core bounds. */
const RATING_LEVELS = 7;
const DRILL_LEVELS = 6;
const SCORE_LABEL_DECIMALS = 2;

export const FINALIZE_MATCH_RULES = `방금 끝난 축구 경기의 출전 선수 전원을 결산한다.
brief는 확정 기록·출전시간·자리·평점 앵커·성장 여지이고 commentary는 이 경기의 중계다.
골·도움·슛·선방·카드는 이미 앵커에 반영되어 있으므로 중복 가산하지 않는다. 기록에 남지 않은 지배력·위기 관리·실점 책임·교체 후 영향만 보정한다.
출전 시간과 자리를 고려하고 팀 결과만으로 개인을 판단하지 않는다. 실제로 없었던 경험이나 성과를 만들지 않는다.
평점은 ${RATING_MIN}~${RATING_MAX}, 앵커 ±${RATING_BAND} 이내다. Score는 앵커에 더할 보정치다.
전술 적응도는 ${MATCH_FAMILIARITY_MIN}~${MATCH_FAMILIARITY_MAX}. 오래 뛰었다는 사실만으로 성장을 보장하지 않는다.
능력치는 전체 경기에서 0~${MATCH_ATTR_CAP}명, 각 한 축 +${ATTR_STEP_MAX} 또는 ${ATTR_STEP_MIN}. 변화가 없으면 none. ${agingDeclineLine()}
수치는 확률 분포의 기대값이고 분류 자신감을 성장량에 곱하지 않는다. 최종 한도·잠재력·반올림·중복 결산은 코어가 검증한다.`;

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
    const who = `선수 ${player.playerId} (${player.name})`;
    questions[`p${index}_rating`] = {
      type: "score",
      instructions: `${who}의 기준 평점 ${player.anchor}에 더할 보정치. 이미 반영된 기록을 중복 평가하지 않는다.`,
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
      instructions: `${who}가 이 경기에서 얻거나 잃은 전술 적응도.`,
      criteria: Array.from({ length: DRILL_LEVELS }, (_, i) =>
        String(
          MATCH_FAMILIARITY_MIN +
            (i * (MATCH_FAMILIARITY_MAX - MATCH_FAMILIARITY_MIN)) / (DRILL_LEVELS - 1),
        ),
      ),
    };
    questions[`p${index}_attribute`] = {
      type: "choice",
      instructions: `${who}가 실제로 겪은 경기에서 달라진 능력치 한 축과 방향. 전체 경기 ${MATCH_ATTR_CAP}명 이내이며 근거가 부족하면 none.`,
      criteria: {
        none: "능력치 변화 없음",
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
export function buildCommentaryBlock(state: GameState, matchId: string): string {
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
export interface FinalizeOutcome {
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
      applyMoodNotes(state, parsed.data.moods ?? [], allowed);
      settled = result.applied;
    },
    () => matchRated(state, brief.matchId),
  ).catch(anchorStands("finalize:match"));
  return { settled };
}
