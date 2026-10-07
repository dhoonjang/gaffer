import {
  TACTIC_GAIN_MIN,
  TACTIC_GAIN_MAX,
  TRAINING_ATTR_CAP,
  ATTR_STEP_MAX,
  ATTR_STEP_MIN,
  POSITION_TRAIN_MAX,
  teamAxesOf,
  allowedAxesFor,
  trainingSlots,
  type TrainingBrief,
  type TrainingOutcome,
  type TrainingSubject,
  deliverTrainingReportMail,
  type GameState,
  recordEmptyTrainingReport,
  trainingSettled,
  applyTrainingOutcomes,
} from "@gaffer/engine";
import {
  attributeAxisOf,
  TRAINING_MARKS,
  TRAINING_MARK_KO,
  AXIS_KO,
  type AttributeAxis,
  type TrainingReport,
} from "@gaffer/domain";
import {
  type EvaluationAnswer,
  type EvaluationRequest,
  type GameEvaluator,
  resolveLlmMode,
  createGameEvaluator,
} from "@gaffer/llm";
import { agingDeclineLine } from "../shared/aging-line";
import { validatedAnswer, majorityChoice } from "../shared/evaluation-answers";
import { ModelOutputError, retryOnce, anchorStands } from "../shared/retry";

export const TRAINING_RATER_RULES = `Rate a football club's past training interval player by player.
Ground it in the training content, position, age, condition, form and room to grow, individual training, and the conversations and ledger facts of that period.
Tactical adaptation is ${TACTIC_GAIN_MIN}~${TACTIC_GAIN_MAX}, mostly 0~1, and negative if a tired player was driven until it fell apart.
Attributes are judged separately for each training date. On one date only 0~${TRAINING_ATTR_CAP} players move one axis each by +${ATTR_STEP_MAX} or ${ATTR_STEP_MIN}, and one player may move different axes on different dates. The scale is the change if such training ran for a week; the core folds in that day's share. A date on which nobody changes is normal. ${agingDeclineLine()}
Attribute candidates are only the axes the team trained and that player's individual training axes. Do not carry over another player's individual training.
Position adaptation is 0~${POSITION_TRAIN_MAX}, only for players in individual position-conversion training.
Conversations are the manager's orders and grounds, and the lines in a scene belong to many people. What was actually carried out is told by the ledger lines in facts.
Do not invent experiences, achievements or attitudes that did not happen. If the kind is unclear, do not specify it.
The numbers are the expected value of the distribution; do not multiply confidence into the growth. The core applies the period, potential and headcount limits, so do not apply them twice.`;

function attributeOptions(teamAxes: ReadonlySet<AttributeAxis>, subject: TrainingSubject) {
  return [...allowedAxesFor(teamAxes, attributeAxisOf(subject.program?.axis))].flatMap((axis) =>
    [ATTR_STEP_MIN, ATTR_STEP_MAX].map((step) => ({
      key: `${axis}_${step < 0 ? "down" : "up"}`,
      axis,
      step,
      label: `${AXIS_KO[axis]} ${step > 0 ? "+" : ""}${step}`,
    })),
  );
}

/** One typed batch for the full interval; attribute questions stand per training date (slot). */
export function buildTrainingRequest(brief: TrainingBrief): EvaluationRequest {
  if (new Set(brief.subjects.map((subject) => subject.playerId)).size !== brief.subjects.length)
    throw new Error("훈련 대상이 중복되었습니다");
  const slots = trainingSlots(brief);
  const teamAxes = teamAxesOf(brief.sessions);
  const questions: EvaluationRequest["questions"] = {};
  brief.subjects.forEach((subject, index) => {
    const who = `player ${subject.playerId} (${subject.name})`;
    questions[`p${index}_tactic`] = {
      type: "score",
      instructions: `Tactical adaptation change of ${who} over this interval (one-week scale). Rate it from the overall rules and that player's facts.`,
      criteria: Array.from({ length: TACTIC_GAIN_MAX - TACTIC_GAIN_MIN + 1 }, (_, i) =>
        String(i + TACTIC_GAIN_MIN),
      ),
    };
    if (subject.program?.position)
      questions[`p${index}_position`] = {
        type: "score",
        instructions: `Position adaptation change of ${who} from conversion training (${subject.program.position}) (one-week scale).`,
        criteria: Array.from({ length: POSITION_TRAIN_MAX + 1 }, (_, i) => String(i)),
      };
    const criteria = {
      none: "no attribute change",
      ...Object.fromEntries(
        attributeOptions(teamAxes, subject).map(({ key, label }) => [key, label]),
      ),
    };
    slots.forEach((slot, j) => {
      const when = slot.dates.length === 1 ? slot.date : `${slot.dates[0]}~${slot.date}`;
      questions[`p${index}_d${j}`] = {
        type: "choice",
        instructions: `One attribute change of ${who} from training on ${when} (${slot.sessions} sessions). Follow the cap of ${TRAINING_ATTR_CAP} players per date and the conservative growth rules.`,
        criteria,
      };
    });
    questions[`p${index}_mark`] = {
      type: "choice",
      instructions: `The attitude ${who} actually showed in training. none if there are no grounds.`,
      criteria: {
        none: "no attitude to single out",
        ...Object.fromEntries(TRAINING_MARKS.map((mark) => [mark, TRAINING_MARK_KO[mark]])),
      },
    };
  });
  return { state: JSON.stringify({ rules: TRAINING_RATER_RULES, brief }), questions };
}

export async function evaluateTraining(
  brief: TrainingBrief,
  evaluator: GameEvaluator,
): Promise<TrainingOutcome[]> {
  if (brief.subjects.length === 0 || brief.sessions.length === 0) return [];
  const request = buildTrainingRequest(brief);
  const result = await evaluator.evaluate(request);
  const keys = Object.keys(request.questions);
  if (
    Object.keys(result.answers).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(result.answers, key))
  )
    throw new ModelOutputError("훈련 평가 응답 목록이 요청과 다릅니다");
  const answers: Record<string, EvaluationAnswer> = {};
  for (const key of keys) {
    const answer = validatedAnswer(request.questions[key]!, result.answers[key]);
    if (!answer) throw new ModelOutputError(`훈련 평가 응답이 유효하지 않습니다: ${key}`);
    answers[key] = answer;
  }
  const score = (key: string): number => {
    const answer = answers[key];
    if (answer?.type !== "score") throw new ModelOutputError(`훈련 수치 응답이 없습니다: ${key}`);
    return answer.score;
  };
  const choice = (key: string): string | undefined => {
    const answer = answers[key];
    if (answer?.type !== "choice") throw new ModelOutputError(`훈련 선택 응답이 없습니다: ${key}`);
    return majorityChoice(answer);
  };
  const slots = trainingSlots(brief);
  const teamAxes = teamAxesOf(brief.sessions);
  return brief.subjects.map((subject, index) => {
    const options = attributeOptions(teamAxes, subject);
    const attributes = slots.flatMap((slot, j) => {
      const selected = choice(`p${index}_d${j}`);
      const option = options.find(({ key }) => key === selected);
      return option ? [{ date: slot.date, axis: option.axis, step: option.step }] : [];
    });
    const selectedMark = choice(`p${index}_mark`);
    const mark = TRAINING_MARKS.find((value) => value === selectedMark) ?? null;
    return {
      playerId: subject.playerId,
      tacticGain: score(`p${index}_tactic`) + TACTIC_GAIN_MIN,
      positionGain: subject.program?.position ? score(`p${index}_position`) : null,
      attributes,
      mark,
      note: "",
    };
  });
}

/**
 * 지나간 훈련을 결산한다 — `advanceTime` **뒤에** 부른다.
 * 한 번 다시 시도하되 **실패는 삼킨다** — 그 구간의 훈련 성과는 없던 일이 된다
 * (코어가 미리 올려 두지 않으므로).
 *
 * ⚠️ **판정이 돌지 않은 구간에도 카드는 남긴다** (빈 결산). "장부가 움직이지
 * 않았다"가 사실이고, 카드가 없으면 다음 턴의 GM은 훈련장의 일을 지어낸다
 * (docs/players/training.md).
 */
export async function reportTraining(
  state: GameState,
  brief: TrainingBrief,
  evaluator?: GameEvaluator,
): Promise<{ report: TrainingReport | null }> {
  if (brief.sessions.length === 0 || brief.subjects.length === 0 || trainingSettled(state, brief))
    return { report: null };
  /**
   * mock 모드에는 부를 모델이 없다 — 앵커가 그대로 남는다 (agents.md §8). **빈 카드는
   * 그대로 선다**: "판정이 돌지 않았다"가 사실이고, 카드가 없으면 다음 턴의 GM이
   * 훈련장의 일을 지어낸다 (training.md).
   */
  if (evaluator === undefined && resolveLlmMode() === "mock") {
    const report = recordEmptyTrainingReport(state, brief);
    deliverTrainingReportMail(state, report);
    return { report };
  }
  // 재시도 콜백 안에서 채워진다 — 흐름 분석이 콜백 속 대입을 보지 못한다
  let report = null as TrainingReport | null;
  let client = evaluator;
  await retryOnce(
    "rater:training",
    async () => {
      if (trainingSettled(state, brief)) return;
      client ??= createGameEvaluator("training-rater");
      const outcomes = await evaluateTraining(brief, client);
      // 한 구간은 한 번만 결산된다 — 재시도 가드도 같은 표식을 보지만 여기서 두 번 쌓지 않는다
      if (trainingSettled(state, brief)) return;
      report = applyTrainingOutcomes(state, brief, outcomes);
    },
    // 이미 반영됐으면 다시 부르지 않는다 — 카드가 비어도(소수로만 움직인 구간)
    // 장부는 이미 움직였으므로 반환값이 아니라 상태의 표식을 본다
    () => trainingSettled(state, brief),
  ).catch(anchorStands("rater:training"));
  // 판정이 한 번도 닿지 않은 구간 — 빈 카드가 그 사실이다
  if (report === null && !trainingSettled(state, brief)) {
    report = recordEmptyTrainingReport(state, brief);
  }
  if (report) deliverTrainingReportMail(state, report);
  return { report };
}
