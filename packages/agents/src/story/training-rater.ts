import {
  TACTIC_GAIN_MIN,
  TACTIC_GAIN_MAX,
  TRAINING_ATTR_CAP,
  ATTR_STEP_MAX,
  ATTR_STEP_MIN,
  POSITION_TRAIN_MAX,
  teamAxesOf,
  allowedAxesFor,
  type TrainingBrief,
  type TrainingOutcome,
  type TrainingSubject,
} from "@story-fm/engine";
import {
  attributeAxisOf,
  TRAINING_MARKS,
  TRAINING_MARK_KO,
  AXIS_KO,
  type AttributeAxis,
} from "@story-fm/domain";
import type { EvaluationAnswer, EvaluationRequest, GameEvaluator } from "@story-fm/llm";
import { agingDeclineLine } from "../common/aging-line";
import { validatedAnswer, majorityChoice } from "../common/evaluation-answers";
import { ModelOutputError } from "../common/retry";

export const TRAINING_RATER_RULES = `축구 구단의 지난 훈련 구간을 선수별로 평가한다.
훈련 내용, 자리·나이·컨디션·폼·성장 여지, 개인 훈련과 멘토, 그 기간의 대화와 장부 사실을 근거로 삼는다.
전술 적응도는 ${TACTIC_GAIN_MIN}~${TACTIC_GAIN_MAX}, 대부분 0~1이며 지친 선수를 굴려 흐트러졌다면 음수다.
능력치는 구간 전체에서 0~${TRAINING_ATTR_CAP}명에게만 각 한 축 +${ATTR_STEP_MAX} 또는 ${ATTR_STEP_MIN}. 아무도 변하지 않는 구간이 정상이다. ${agingDeclineLine()}
능력치 후보는 팀에서 훈련한 축과 해당 선수의 개인 훈련 축뿐이다. 다른 선수의 개인 훈련을 옮기지 않는다.
자리 적응도는 전향 개인 훈련 중인 선수만 0~${POSITION_TRAIN_MAX}다.
대화는 감독의 주문과 근거이며 장면의 말은 여러 사람의 것이다. 실제 실행은 facts의 장부 줄이 말한다.
실제로 없었던 경험·성과·태도를 만들지 않는다. 갈래와 날짜가 불명확하면 특정하지 않는다.
수치는 분포의 기대값이며 자신감을 성장량에 곱하지 않는다. 기간·멘토 배율·잠재력·인원 한도는 코어가 적용하므로 중복 적용하지 않는다.`;

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

/** One typed batch for the full interval; identities and candidates are supplied locally. */
export function buildTrainingRequest(brief: TrainingBrief): EvaluationRequest {
  if (new Set(brief.subjects.map((subject) => subject.playerId)).size !== brief.subjects.length)
    throw new Error("훈련 대상이 중복되었습니다");
  const dates = [...new Set(brief.sessions.map((session) => session.date))];
  if (dates.length > 255) throw new Error("훈련 날짜 후보가 평가 한도를 넘었습니다");
  const teamAxes = teamAxesOf(brief.sessions);
  const questions: EvaluationRequest["questions"] = {};
  brief.subjects.forEach((subject, index) => {
    const who = `선수 ${subject.playerId} (${subject.name})`;
    questions[`p${index}_tactic`] = {
      type: "score",
      instructions: `${who}의 이 구간 전술 적응도 변화. 전체 규칙과 해당 선수 사실로 평가한다.`,
      criteria: Array.from({ length: TACTIC_GAIN_MAX - TACTIC_GAIN_MIN + 1 }, (_, i) =>
        String(i + TACTIC_GAIN_MIN),
      ),
    };
    if (subject.program?.position)
      questions[`p${index}_position`] = {
        type: "score",
        instructions: `${who}의 전향 훈련(${subject.program.position}) 자리 적응도 변화.`,
        criteria: Array.from({ length: POSITION_TRAIN_MAX + 1 }, (_, i) => String(i)),
      };
    questions[`p${index}_attribute`] = {
      type: "choice",
      instructions: `${who}의 능력치 변화 한 가지. 전체 구간 ${TRAINING_ATTR_CAP}명 상한과 보수적 성장 규칙을 따른다.`,
      criteria: {
        none: "능력치 변화 없음",
        ...Object.fromEntries(
          attributeOptions(teamAxes, subject).map(({ key, label }) => [key, label]),
        ),
      },
    };
    questions[`p${index}_mark`] = {
      type: "choice",
      instructions: `${who}가 실제 훈련에서 보인 태도. 근거가 없으면 none.`,
      criteria: {
        none: "특정할 태도 없음",
        ...Object.fromEntries(TRAINING_MARKS.map((mark) => [mark, TRAINING_MARK_KO[mark]])),
      },
    };
    questions[`p${index}_date`] = {
      type: "choice",
      instructions: `${who}의 변화·태도가 나타난 실제 훈련 날짜.`,
      criteria: Object.fromEntries(dates.map((date, i) => [`d${i}`, date])),
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
  const dates = [...new Set(brief.sessions.map((session) => session.date))];
  const teamAxes = teamAxesOf(brief.sessions);
  return brief.subjects.map((subject, index) => {
    const selected = choice(`p${index}_attribute`);
    const attribute = attributeOptions(teamAxes, subject).find(({ key }) => key === selected);
    const selectedMark = choice(`p${index}_mark`);
    const mark = TRAINING_MARKS.find((value) => value === selectedMark) ?? null;
    const selectedDate = choice(`p${index}_date`);
    const date = dates.find((_, i) => `d${i}` === selectedDate);
    return {
      playerId: subject.playerId,
      tacticGain: score(`p${index}_tactic`) + TACTIC_GAIN_MIN,
      positionGain: subject.program?.position ? score(`p${index}_position`) : null,
      attribute: attribute?.axis ?? null,
      attributeStep: attribute?.step ?? null,
      mark,
      note: "",
      ...(date ? { date } : {}),
    };
  });
}
