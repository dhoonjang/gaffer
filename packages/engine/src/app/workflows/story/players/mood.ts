import {
  type GamePlayer,
  ageOf,
  familiarityTierKey,
  fatigueBand,
  fatigueOf,
} from "@story-fm/domain";
import { diffDays } from "../../../../common/core/dates";
import {
  type GameState,
  activeContract,
  activeSuspension,
  assignmentFor,
  familiarityOf,
  isOurPlayer,
  openInjury,
  seasonStatOf,
} from "../../../../common/core/state";
import { playerArchetypeOf } from "../../../../common/people/player-persona";
import { formLabel } from "../../../../common/players/form";
import { leaderRoleOf } from "../../../../common/players/hierarchy";
import { injuryHistoryOf } from "../../../../common/players/injury";
import { demotionPatienceDaysOf } from "../../../../match/squad/demotion";
import {
  type LastMatchIndex,
  type MoodFact,
  type MoodRead,
  afterglow,
  AFTERGLOW_DAYS,
  CONDITION_HEAVY,
  CONDITION_LIGHT,
  CONTRACT_ENDING_DAYS,
  demotionDaysOf,
  grievanceOf,
  lastMatchOf,
  mentoringFactOf,
  MOOD_FACT_LIMIT,
  MOOD_NOTE_DAYS,
  numberEchoOf,
  recentReturn,
  YOUNG_AGE,
} from "../../../../story/players/mood";

/**
 * **코어가 고른 심경의 사실** — 우선순위 순 최대 2장.
 *
 * 화면·조회 도구는 `moodOf`를 부른다. 이 함수를 직접 부르는 곳은 앵커를 세우는
 * 브리프뿐이다.
 */
export function moodFactsOf(
  state: GameState,
  player: GamePlayer,
  index?: LastMatchIndex,
): MoodFact[] {
  const facts: MoodFact[] = [];

  const injury = openInjury(state, player.id);
  const suspension = activeSuspension(state, player.id);
  const assignment = assignmentFor(state, player.id);
  const stat = seasonStatOf(state, player.id);
  const contract = activeContract(state, player.id);
  const demotionDays = demotionDaysOf(state, player);
  const { form, condition } = player.state;
  const retiring = player.state.retiringAfterSeason;

  if (injury)
    facts.push({
      cause: "injury",
      bodyPart: injury.bodyPart,
      daysToReturn: Math.max(0, diffDays(state.date, injury.expectedReturn)),
    });
  if (suspension)
    facts.push({ cause: "suspension", matchesLeft: suspension.lengthMatches - suspension.served });
  if (retiring)
    facts.push({
      cause: "retiring",
      days: diffDays(retiring.on, state.date),
      reason: retiring.reason,
    });
  for (const issue of state.issues.filter((i) => i.gamePlayerId === player.id)) {
    const grievance = grievanceOf({ ...state, issues: [issue] }, player);
    if (grievance) facts.push(grievance);
  }
  if (demotionDays !== null)
    facts.push({
      cause: "demotion",
      days: demotionDays,
      archetype: playerArchetypeOf(state.seed, player),
      patienceDays: demotionPatienceDaysOf(state, player),
    });
  const last = lastMatchOf(state, player.id, index);
  if (last && last.days <= AFTERGLOW_DAYS) facts.push(afterglow(state, player.id, last));
  if ((stat?.apps ?? 0) === 0 && state.date >= state.calendar.start) {
    if (assignment?.role === "bench") facts.push({ cause: "no-minutes", place: "bench" });
    else if (!assignment?.role) facts.push({ cause: "no-minutes", place: "out" });
  }
  const label = formLabel(form);
  if (label !== "평소") facts.push({ cause: "form", label });
  if (state.date >= state.calendar.start) {
    const tier = familiarityTierKey(familiarityOf(state, player.id));
    if (tier === "alien" || tier === "raw" || tier === "learning")
      facts.push({ cause: "familiarity", tier });
  }
  const ours = isOurPlayer(state, player);
  const history = ours ? injuryHistoryOf(state, player.id) : null;
  if (history && (history.count > 0 || recentReturn(history)))
    facts.push({ cause: "injury-history", history });
  const band =
    ours && state.date >= state.calendar.start ? fatigueBand(fatigueOf(player.state)) : null;
  if (band === "overloaded" || band === "heavy") facts.push({ cause: "fatigue", band });
  if (condition <= CONDITION_HEAVY) facts.push({ cause: "condition", level: "heavy" });
  if (condition >= CONDITION_LIGHT) facts.push({ cause: "condition", level: "light" });

  // ── 곁들임: 지금 조치하지 않으면 놓칠 사정 ──
  const mentoring = mentoringFactOf(state, player);
  /**
   * **끝난 멘토링이 곁들임의 맨 앞이다** (people.md §5) — 데리고 다니던 고참이
   * 사라진 것은 옆자리 동료가 떠난 것보다 그 아이에게 큰 일이다. 서 있는 사이는
   * 며칠씩 그대로라 아래(번호의 여운 다음)에 선다.
   */
  if (mentoring !== null && mentoring.ended !== undefined) {
    facts.push(mentoring);
  }
  /**
   * ⚠️ **`contract` 불만이 걸린 선수에겐 서지 않는다** (people.md §5) — 같은 사실을
   * 불만 카드가 이미 말하고 있어, 두 장 한도 안에서 폼이나 몸을 밀어낼 뿐이다.
   */
  if (contract) {
    const left = diffDays(state.date, contract.until);
    if (left >= 0 && left <= CONTRACT_ENDING_DAYS) {
      facts.push({ cause: "contract-ending", daysLeft: left });
    }
  }
  {
    const number = numberEchoOf(state, player);
    if (number) facts.push(number);
  }
  // 서 있는 사이 — 번호의 여운 다음이고 라커룸 자리 앞이다 (people.md §5)
  if (mentoring !== null && mentoring.ended === undefined) {
    facts.push(mentoring);
  }
  {
    const seat = leaderRoleOf(state, player);
    if (seat) facts.push({ cause: "leader", role: seat });
  }
  const age = ageOf(player.birthdate, state.date);
  if (!injury && !suspension && age <= YOUNG_AGE) {
    facts.push({ cause: "young", age });
  }

  if (facts.length === 0) facts.push({ cause: "steady" });
  return facts;
}

/**
 * **감독이 읽는 심경** — 코어 사실 위에 결산이 다시 쓴 한 줄이 있으면 그것도 함께.
 *
 * 화면과 조회 도구는 전부 이 함수를 부른다. 사실은 언제나 함께 나가므로 결산이
 * 실패해도 화면에 빈 자리가 남지 않는다.
 */
export function moodOf(state: GameState, player: GamePlayer): MoodRead {
  const facts = moodFactsOf(state, player).slice(0, MOOD_FACT_LIMIT);
  const note = player.state.moodNote;
  if (!note) return { note: null, facts };
  /**
   * **사실이 바뀌면 코어가 이긴다.** 다치거나 정지를 먹은 선수에게 지난주의
   * 결이 그대로 붙어 있으면 화면이 거짓말을 한다 — 그 둘은 다른 무엇보다 먼저
   * 말해야 하는 사실이라 사실 카드가 이미 전부를 차지한다.
   */
  if (openInjury(state, player.id) || activeSuspension(state, player.id)) {
    return { note: null, facts };
  }
  // 지난주의 결이 오늘의 심경인 척하지 않는다
  if (diffDays(note.on, state.date) > MOOD_NOTE_DAYS) return { note: null, facts };
  return { note: note.text, facts };
}
