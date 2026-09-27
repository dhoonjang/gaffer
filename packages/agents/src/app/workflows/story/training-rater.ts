import {
  type GameState,
  type TrainingBrief,
  recordEmptyTrainingReport,
  trainingSettled,
  applyTrainingOutcomes,
} from "@story-fm/engine";
import { type GameLLM, resolveLlmMode, createGameLLM, agentConfig } from "@story-fm/llm";
import { type TrainingReport } from "@story-fm/domain";
import { retryOnce, readOutput, anchorStands } from "../../../common/retry";
import {
  TRAINING_RATER_SYSTEM,
  buildTrainingPrompt,
  REPORT_TRAINING_INPUT,
  TrainingReportSchema,
} from "../../../story/training-rater";

/**
 * 지나간 훈련을 결산한다 — `advanceTime` **뒤에** 부른다.
 * 한 번 다시 시도하되 **실패는 삼킨다** — 그 구간의 훈련 성과는 없던 일이 된다
 * (코어가 미리 올려 두지 않으므로).
 *
 * ⚠️ **판정이 돌지 않은 구간에도 카드는 남긴다** (빈 결산). "장부가 움직이지
 * 않았다"가 사실이고, 카드가 없으면 다음 턴의 GM은 훈련장의 일을 지어낸다
 * (docs/common/season.md §4).
 */
export async function reportTraining(
  state: GameState,
  brief: TrainingBrief,
  llm?: GameLLM,
): Promise<{ report: TrainingReport | null }> {
  if (brief.sessions.length === 0 || brief.subjects.length === 0) return { report: null };
  /**
   * mock 모드에는 부를 모델이 없다 — 앵커가 그대로 남는다 (agents.md §8). **빈 카드는
   * 그대로 선다**: "판정이 돌지 않았다"가 사실이고, 카드가 없으면 다음 턴의 GM이
   * 훈련장의 일을 지어낸다 (season.md §4).
   */
  if (llm === undefined && resolveLlmMode() === "mock") {
    return { report: recordEmptyTrainingReport(state, brief) };
  }
  let report: TrainingReport | null = null;
  let client = llm;
  await retryOnce(
    "rater:training",
    async () => {
      client ??= createGameLLM(agentConfig("training-rater"));
      const result = await client.runTurn({
        system: TRAINING_RATER_SYSTEM,
        history: [],
        user: buildTrainingPrompt(brief),
        // 산출은 JSON 하나다 — 도구 왕복이 없다 (models.md §3-2)
        outputSchema: REPORT_TRAINING_INPUT,
      });
      const data = readOutput("rater:training", TrainingReportSchema, result);
      // 한 구간은 한 번만 결산된다 — 재시도 가드도 같은 표식을 보지만 여기서 두 번 쌓지 않는다
      if (trainingSettled(state, brief)) return;
      report = applyTrainingOutcomes(
        state,
        brief,
        data.results.map((r) => ({
          playerId: r.playerId,
          tacticGain: r.tacticGain ?? 0,
          positionGain: r.positionGain ?? null,
          attribute: r.attribute ?? null,
          attributeStep: r.attributeStep ?? 1,
          note: r.note ?? "",
          mark: r.mark ?? null,
          ...(r.date ? { date: r.date } : {}),
        })),
      );
    },
    // 이미 반영됐으면 다시 부르지 않는다 — 카드가 비어도(소수로만 움직인 구간)
    // 장부는 이미 움직였으므로 반환값이 아니라 상태의 표식을 본다
    () => trainingSettled(state, brief),
  ).catch(anchorStands("rater:training"));
  // 판정이 한 번도 닿지 않은 구간 — 빈 카드가 그 사실이다
  if (report === null && !trainingSettled(state, brief)) {
    report = recordEmptyTrainingReport(state, brief);
  }
  return { report };
}
