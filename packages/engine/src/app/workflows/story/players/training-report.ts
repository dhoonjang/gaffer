import { deliverTrainingReportMail } from "../../mail-reports";
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
  trainingSlots,
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
   * 훈련 날짜 → 그 날의 첫 세션(오전)과 세션 수. **반영의 단위는 날짜다** (player.md §6.1) —
   * 날짜마다 그날의 몫(`세션 수 ÷ SESSIONS_PER_WEEK`)만 접어 그 날짜로 장부에 남기므로,
   * 구간을 한 번에 넘기든 나눠 넘기든 같은 날짜가 같은 몫을 받는다.
   */
  const days = new Map<string, { session: TrainedSession; weeks: number }>();
  for (const s of brief.sessions) {
    const day = days.get(s.date);
    if (day) day.weeks += settlementWeeks(1);
    else days.set(s.date, { session: s, weeks: settlementWeeks(1) });
  }
  /** 능력치 판정의 칸 — 판정자가 질문을 세운 그 함수다 */
  const slots = trainingSlots(brief);
  const slotIndex = new Map(slots.map((slot, k) => [slot.date, k] as const));
  /** 칸마다 인원 상한을 센다 */
  const attrSpent = slots.map(() => 0);
  const assignments = new Map(
    assignmentsOf(state, state.userTeamId).map((a) => [a.playerId, a] as const),
  );
  // 팀 세션의 축 — 개인 훈련 축은 걸어 둔 선수에게만 얹는다 (`allowedAxesFor`)
  const teamAxes = teamAxesOf(brief.sessions);
  const subjects = new Map(brief.subjects.map((s) => [s.playerId, s] as const));
  /**
   * 카드에 실릴 것 — **장부가 실제로 움직인 것만.** 판정이 낸 값이 아니라
   * `recordGrowth`가 남긴 줄과 같은 눈금이라, 천장에 막혀 한 칸도 안 오른 `+2`는
   * 여기에도 없다. 날짜마다 따로 쌓인다.
   */
  const moved: TrainingReport["moved"] = [];
  const marks: TrainingReport["marks"] = [];

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
     * 계약 만료·은퇴로 떠난 선수를 여기서 다시 걸러 낸다.
     */
    if (player.teamId !== state.userTeamId) continue;

    // ① 전술 적응도 — **여기가 유일한 변화 경로다.** 코어는 훈련 중에 아무것도
    //    올리지 않았다. 구간 판정 하나를 날짜마다 그날의 몫으로 나눠 얹는다.
    const assignment = assignments.get(outcome.playerId);
    const gain = clampGain(outcome.tacticGain);
    if (assignment && gain !== 0) {
      for (const { session, weeks } of days.values()) {
        const before = assignment.familiarity;
        // 상승은 **위로 갈수록 깎이고, 잘 읽는 선수가 더 가져간다** — 소수로 쌓인다.
        assignment.familiarity = applyFamiliarityGain(
          before,
          gain * weeks,
          "training",
          tacticalUptake(player.attributes),
        );
        // 장부·요약은 **눈금이 실제로 넘어갔을 때만** 남긴다 (성장 로그는 정수다)
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

    // ② 자리 — **개인 훈련으로 배우는 중일 때만.** 구간 판정 하나를 날짜마다 나눠 얹는다.
    const program = state.playerTraining.find((t) => t.gamePlayerId === player.id);
    const rated =
      program?.position && outcome.positionGain
        ? Math.max(0, Math.min(POSITION_TRAIN_MAX, Math.round(outcome.positionGain)))
        : 0;
    if (program?.position && rated > 0) {
      const position = program.position;
      const carryKey = positionGrowthTarget(position);
      for (const { session, weeks } of days.values()) {
        const slot = player.positions.find((x) => x.position === position);
        // 처음 배우는 자리는 **주발을 벗긴 원값**에서 출발한다 — 저장에 보정을
        // 남기면 조회가 다시 얹는다 (player.md §8)
        const before = slot?.proficiency ?? storedProficiencyFor(player.positions, position);
        if (before >= PROFICIENCY_MAX) break;
        /**
         * 자리 적응도는 **정수**라 하루치의 0.2를 담을 곳이 없다 — 능력치와 같은
         * 그릇(`growthCarry`)의 `pos:<자리>` 칸에 쌓았다가 한 칸이 될 때 올린다.
         */
        const carried = (player.growthCarry[carryKey] ?? 0) + rated * weeks;
        // 한 날짜가 넘기는 눈금은 `POSITION_TRAIN_MAX`까지 — 나머지는 다음으로
        const step = Math.min(POSITION_TRAIN_MAX, Math.trunc(carried));
        player.growthCarry = { ...player.growthCarry, [carryKey]: carried - step };
        const after = Math.min(PROFICIENCY_MAX, before + step);
        // **실제로 넘어간 만큼만 장부에 적는다** — 위끝에 걸린 자리는 판정보다 덜 오른다
        const gained = after - before;
        if (gained > 0) {
          if (slot) slot.proficiency = after;
          else player.positions.push({ position, proficiency: after, isNatural: false });
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
        const learned = player.positions.find((x) => x.position === position);
        if (
          learned &&
          learned.proficiency > natural.proficiency &&
          natural.position !== learned.position
        ) {
          setPlayerPosition(state, { playerId: player.id, position: learned.position });
          state.playerTraining = state.playerTraining.filter((t) => t.gamePlayerId !== player.id);
          break;
        }
      }
    }

    // ③ 능력치 — 칸마다 따로. 그 구간에 훈련한 축 + 이 선수에게 걸린 개인 훈련 축 (공용 규칙)
    const allowed = allowedAxesFor(teamAxes, attributeAxisOf(program?.axis));
    const judged = new Set<number>();
    for (const change of outcome.attributes ?? []) {
      const k = slotIndex.get(change.date);
      // 칸에 없는 날짜 · 같은 칸의 두 번째 줄은 받지 않는다
      if (k === undefined || judged.has(k)) continue;
      judged.add(k);
      const slot = slots[k]!;
      const session = days.get(slot.date)!.session;
      const stepped = applyAttributeStep(state, player, change.axis, change.step, {
        allowed,
        spent: attrSpent[k]!,
        cap: TRAINING_ATTR_CAP,
        weeks: settlementWeeks(slot.sessions),
        source: "training",
        origin: "training-settlement",
        entryId: session.entryId,
        on: slot.date,
      });
      // 인원 상한은 **건드린 인원**을 센다 — 캐리에만 쌓인 선수도 한 자리를 쓴다
      if (stepped) {
        attrSpent[k]! += 1;
        if (stepped.step !== 0) {
          moved.push({ gamePlayerId: player.id, target: stepped.axis, delta: stepped.step });
        }
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
  const report = cardFor(state, brief, moved, marks);
  deliverTrainingReportMail(state, report);
  return report;
}
