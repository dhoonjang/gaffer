import {
  type GameState,
  assignmentsOf,
  playerById,
  recordGrowth,
} from "../../../../common/core/state";
import {
  type TrainingBrief,
  type TrainingOutcome,
  trainingSettled,
  type TrainedSession,
  teamAxesOf,
  settlementWeeks,
  TRAINING_ATTR_CAP,
  clampGain,
  POSITION_TRAIN_MAX,
  allowedAxesFor,
  markOf,
  oneLine,
  cardFor,
} from "../../../../story/players/training-report";
import {
  type TrainingReport,
  applyFamiliarityGain,
  tacticalUptake,
  storedProficiencyFor,
  PROFICIENCY_MAX,
  positionGrowthTarget,
  naturalPositionOf,
  attributeAxisOf,
} from "@story-fm/domain";
import { setPlayerPosition } from "../../../../match/commands/lineup";
import { applyAttributeStep } from "../../../../common/players/attribute-growth";

/**
 * 훈련 판정을 검증하고 앵커·성장 한도 안에서 장부에 반영한다.
 * @return state.trainingReports에 저장한 결산 카드. 이미 반영한 구간이면 null.
 */
export function applyTrainingOutcomes(
  state: GameState,
  brief: TrainingBrief,
  outcomes: readonly TrainingOutcome[],
): TrainingReport | null {
  /**
   * **한 결산은 장부를 한 번만 움직인다** — 도구 루프는 같은 결산을 여러 번
   * 제출할 수 있고, 그때마다 반영하면 적응도·능력치가 호출 횟수만큼 쌓여
   * "코어 앵커 ± 한도"가 뚫린다 (docs/common/llm/agents.md §4). 카드도 같은 문을
   * 지난다 — 한 구간에 한 장이다.
   */
  if (trainingSettled(state, brief)) return null;
  /**
   * 판정이 가리킨 훈련 날짜 → 그 세션 (없으면 마지막 세션).
   * 하루에 두 세션이면 **먼저 있던 쪽**(오전)에 붙인다 — 판정은 날짜까지만 답한다.
   */
  const sessionsByDate = new Map<string, TrainedSession>();
  for (const s of brief.sessions) if (!sessionsByDate.has(s.date)) sessionsByDate.set(s.date, s);
  const fallback = brief.sessions[brief.sessions.length - 1]!;
  const sessionFor = (date?: string) => (date && sessionsByDate.get(date)) || fallback;
  const assignments = new Map(
    assignmentsOf(state, state.userTeamId).map((a) => [a.playerId, a] as const),
  );
  // 팀 세션의 축 — 개인 훈련 축은 걸어 둔 선수에게만 얹는다 (`allowedAxesFor`)
  const teamAxes = teamAxesOf(brief.sessions);
  const subjects = new Map(brief.subjects.map((s) => [s.playerId, s] as const));
  /**
   * 카드에 실릴 것 — **장부가 실제로 움직인 것만.** 판정이 낸 값이 아니라
   * `recordGrowth`가 남긴 줄과 같은 눈금이라, 천장에 막혀 한 칸도 안 오른 `+2`는
   * 여기에도 없다.
   */
  const moved: TrainingReport["moved"] = [];
  const marks: TrainingReport["marks"] = [];
  let attrSpent = 0;
  /**
   * 이 결산의 폭 — 판정의 눈금은 한 주치이고, 소화된 세션 수만큼만 접어 반영한다.
   * 표식(`marks`)에는 곱하지 않는다 — 눈에 띈 것은 사실이지 양이 아니다.
   */
  const weeks = settlementWeeks(brief.sessions.length);
  const attrCap = TRAINING_ATTR_CAP;

  // 같은 판정에 같은 선수가 두 줄로 오면 **첫 줄만** 받는다 — 두 줄째까지 받으면
  // 한 결산이 그 선수에게 밴드의 두 배를 남긴다 (docs/common/llm/agents.md §4)
  const taken = new Set<string>();
  for (const outcome of outcomes) {
    if (taken.has(outcome.playerId)) continue;
    taken.add(outcome.playerId);
    const subject = subjects.get(outcome.playerId);
    const player = playerById(state, outcome.playerId);
    if (!subject || !player) continue; // 명단 밖 선수는 무시한다
    /**
     * 판정을 받는 사이에 **팀을 떠난 선수**는 더 이상 우리 장부의 대상이 아니다.
     * 브리프는 구간이 끝난 자리에서 짓지만 판정은 그 뒤에 돌아오므로, 그 사이의
     * 이적·임대가 남긴 선수를 여기서 다시 걸러 낸다.
     */
    if (player.teamId !== state.userTeamId) continue;

    // ① 전술 적응도 — **여기가 유일한 변화 경로다.** 코어는 훈련 중에 아무것도
    //    올리지 않았다. 얼마나 스몄는지는 이 판정이 정하고, 코어는 −1~3으로 가둔다.
    const assignment = assignments.get(outcome.playerId);
    // 이 변화가 나온 훈련 날짜 — 판정이 가리킨 세션 (없으면 마지막)
    const session = sessionFor(outcome.date);
    if (assignment) {
      const gain = clampGain(outcome.tacticGain);
      if (gain !== 0) {
        const before = assignment.familiarity;
        // 상승은 **위로 갈수록 깎이고, 잘 읽는 선수가 더 가져간다** — 소수로 쌓인다.
        assignment.familiarity = applyFamiliarityGain(
          before,
          gain * weeks,
          "training",
          tacticalUptake(player.attributes),
        );
        // 장부·요약은 **눈금이 실제로 넘어갔을 때만** 남긴다 (성장 로그는 정수다).
        // 87.4 → 87.7은 감독의 화면에서 아무 일도 아니므로 일지에도 없다
        const notches = Math.round(assignment.familiarity) - Math.round(before);
        if (notches !== 0) {
          recordGrowth(
            state,
            player.id,
            session.entryId,
            "training",
            "tactical",
            notches,
            "training-settlement",
            session.date,
          );
          moved.push({ gamePlayerId: player.id, target: "tactical", delta: notches });
        }
      }
    }

    // ② 자리 — **개인 훈련으로 배우는 중일 때만.** 코어가 날짜를 세어 올리던
    //    자리를 결산에 넘겼다: 전술 적응도·능력치와 같은 눈으로 판정한다.
    const program = state.playerTraining.find((t) => t.gamePlayerId === player.id);
    if (program?.position && outcome.positionGain) {
      const rated = Math.max(0, Math.min(POSITION_TRAIN_MAX, Math.round(outcome.positionGain)));
      const slot = player.positions.find((x) => x.position === program.position);
      // 처음 배우는 자리는 **주발을 벗긴 원값**에서 출발한다 — 저장에 보정을
      // 남기면 조회가 다시 얹는다 (player.md §8)
      const before = slot?.proficiency ?? storedProficiencyFor(player.positions, program.position);
      if (rated > 0 && before < PROFICIENCY_MAX) {
        /**
         * 자리 적응도는 **정수**라 하루치 결산의 0.2를 담을 곳이 없다 — 능력치와 같은
         * 그릇(`growthCarry`)의 `pos:<자리>` 칸에 쌓았다가 한 칸이 될 때 올린다.
         * 위끝에 닿은 자리에는 쌓지 않는다: 나갈 곳 없는 몫이 그릇에 남는다.
         */
        const carryKey = positionGrowthTarget(program.position);
        const carried = (player.growthCarry[carryKey] ?? 0) + rated * weeks;
        // 한 결산이 넘기는 눈금은 여전히 `POSITION_TRAIN_MAX`까지 — 나머지는 다음으로
        const gain = Math.min(POSITION_TRAIN_MAX, Math.trunc(carried));
        player.growthCarry = { ...player.growthCarry, [carryKey]: carried - gain };
        const after = Math.min(PROFICIENCY_MAX, before + gain);
        /**
         * **실제로 넘어간 만큼만 장부에 적는다.** 위끝에 걸린 자리는 판정이 +2를
         * 내도 한 칸밖에 안 오르는데, 그 구간마다 "적응 +2"가 성장 로그와
         * 요약에 남으면 감독은 두 칸이 올랐다고 읽는다.
         */
        const gained = after - before;
        if (gained > 0) {
          if (slot) slot.proficiency = after;
          else
            player.positions.push({
              position: program.position,
              proficiency: after,
              isNatural: false,
            });
          recordGrowth(
            state,
            player.id,
            session.entryId,
            "training",
            carryKey,
            gained,
            "position-conversion",
            session.date,
          );
          moved.push({ gamePlayerId: player.id, target: carryKey, delta: gained });
        }
        // 새 자리가 본업을 넘어서면 전향이 끝난 것이다 (장부 정리는 코어 몫)
        const natural = naturalPositionOf(player);
        const learned = player.positions.find((x) => x.position === program.position);
        if (
          learned &&
          learned.proficiency > natural.proficiency &&
          natural.position !== learned.position
        ) {
          setPlayerPosition(state, { playerId: player.id, position: learned.position });
          state.playerTraining = state.playerTraining.filter((t) => t.gamePlayerId !== player.id);
        }
      }
    }

    // ③ 능력치 — 그 구간에 훈련한 축 + 이 선수에게 걸린 개인 훈련 축 (공용 규칙)
    const stepped = applyAttributeStep(state, player, outcome.attribute, outcome.attributeStep, {
      allowed: allowedAxesFor(teamAxes, attributeAxisOf(program?.axis)),
      spent: attrSpent,
      cap: attrCap,
      weeks,
      source: "training",
      origin: "training-settlement",
      entryId: session.entryId,
      on: session.date,
    });
    // 인원 상한은 **건드린 인원**을 센다 — 캐리에만 쌓인 선수도 한 자리를 쓴다
    if (stepped) {
      attrSpent += 1;
      if (stepped.step !== 0) {
        moved.push({ gamePlayerId: player.id, target: stepped.axis, delta: stepped.step });
      }
    }

    /**
     * 훈련장의 갈래와 근거 한 줄 — **아무 일도 없던 줄은 적지 않는다.**
     *
     * 판정자는 대상 전원에게 한 줄씩 답하므로(프롬프트가 그렇게 요구한다) 그대로
     * 받으면 카드 한 장이 스물몇 줄의 "변화 없음"이 된다. 갈래를 적었거나 장부가
     * 실제로 움직인 선수만 남긴다 — 여백은 사실이 아니다.
     */
    const code = markOf(outcome.mark);
    const note = oneLine(outcome.note);
    const touched = moved.some((m) => m.gamePlayerId === player.id);
    if (code !== null || (touched && note.length > 0)) {
      marks.push({ gamePlayerId: player.id, code, note });
    }
  }

  // 이 구간은 반영이 끝났다 — 두 번째 제출은 맨 위에서 걸린다.
  // 엔트리를 찾지 못한 세션은 표식을 남길 자리가 없다 (합성 브리프)
  for (const session of brief.sessions) {
    const entry = state.schedule.find((e) => e.id === session.entryId);
    if (entry) entry.settled = true;
  }
  /**
   * **아무것도 움직이지 않은 구간에도 카드는 선다.** "장부가 움직이지 않았다"가
   * 사실이고, 카드가 없으면 다음 턴의 GM은 훈련장에서 무슨 일이 있었는지 지어낸다
   * (docs/common/season.md §4).
   */
  return cardFor(state, brief, moved, marks);
}
