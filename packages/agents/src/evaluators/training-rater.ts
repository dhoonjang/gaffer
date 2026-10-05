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

export const TRAINING_RATER_RULES = `축구 구단의 지난 훈련 구간을 선수별로 평가한다.
훈련 내용, 자리·나이·컨디션·폼·성장 여지, 개인 훈련, 그 기간의 대화와 장부 사실을 근거로 삼는다.
전술 적응도는 ${TACTIC_GAIN_MIN}~${TACTIC_GAIN_MAX}, 대부분 0~1이며 지친 선수를 굴려 흐트러졌다면 음수다.
능력치는 훈련 날짜마다 따로 판정한다. 한 날짜에 0~${TRAINING_ATTR_CAP}명에게만 각 한 축 +${ATTR_STEP_MAX} 또는 ${ATTR_STEP_MIN}이고, 한 선수가 여러 날짜에 다른 축을 움직일 수 있다. 눈금은 그런 훈련이 한 주 이어졌을 때의 변화이며 그날의 몫은 코어가 접는다. 아무도 변하지 않는 날짜가 정상이다. ${agingDeclineLine()}
능력치 후보는 팀에서 훈련한 축과 해당 선수의 개인 훈련 축뿐이다. 다른 선수의 개인 훈련을 옮기지 않는다.
자리 적응도는 전향 개인 훈련 중인 선수만 0~${POSITION_TRAIN_MAX}다.
대화는 감독의 주문과 근거이며 장면의 말은 여러 사람의 것이다. 실제 실행은 facts의 장부 줄이 말한다.
실제로 없었던 경험·성과·태도를 만들지 않는다. 갈래가 불명확하면 특정하지 않는다.
수치는 분포의 기대값이며 자신감을 성장량에 곱하지 않는다. 기간·잠재력·인원 한도는 코어가 적용하므로 중복 적용하지 않는다.`;

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
    const who = `선수 ${subject.playerId} (${subject.name})`;
    questions[`p${index}_tactic`] = {
      type: "score",
      instructions: `${who}의 이 구간 전술 적응도 변화(한 주치 눈금). 전체 규칙과 해당 선수 사실로 평가한다.`,
      criteria: Array.from({ length: TACTIC_GAIN_MAX - TACTIC_GAIN_MIN + 1 }, (_, i) =>
        String(i + TACTIC_GAIN_MIN),
      ),
    };
    if (subject.program?.position)
      questions[`p${index}_position`] = {
        type: "score",
        instructions: `${who}의 전향 훈련(${subject.program.position}) 자리 적응도 변화(한 주치 눈금).`,
        criteria: Array.from({ length: POSITION_TRAIN_MAX + 1 }, (_, i) => String(i)),
      };
    const criteria = {
      none: "능력치 변화 없음",
      ...Object.fromEntries(
        attributeOptions(teamAxes, subject).map(({ key, label }) => [key, label]),
      ),
    };
    slots.forEach((slot, j) => {
      const when = slot.dates.length === 1 ? slot.date : `${slot.dates[0]}~${slot.date}`;
      questions[`p${index}_d${j}`] = {
        type: "choice",
        instructions: `${who}의 ${when} 훈련(${slot.sessions}세션)에서의 능력치 변화 한 가지. 날짜당 ${TRAINING_ATTR_CAP}명 상한과 보수적 성장 규칙을 따른다.`,
        criteria,
      };
    });
    questions[`p${index}_mark`] = {
      type: "choice",
      instructions: `${who}가 실제 훈련에서 보인 태도. 근거가 없으면 none.`,
      criteria: {
        none: "특정할 태도 없음",
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
    if (report) deliverTrainingReportMail(state, report);
    return { report };
  }
  let report: TrainingReport | null = null;
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
