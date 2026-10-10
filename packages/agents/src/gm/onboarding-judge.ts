import {
  playerOverall,
  CLUB_TIER_KO,
  ageOf,
  naturalPositionOf,
  lorebookText,
  readSceneMarkup,
} from "@gaffer/domain";
import { z } from "zod";
import {
  type GameState,
  playersOf,
  ownerOf,
  headCoachOf,
  teamNameIn,
  tierOfTeamIn,
  selectLorebook,
  stampLorebook,
} from "@gaffer/engine";
import { toToolSchema } from "../shared/tool-schema";
import { OUTPUT_LANGUAGE } from "../shared/output-language";
import { SUGGESTION_MAX_CHARS } from "../shared/suggest-reply";
import { buildGmStateNote } from "./gm-input";

/** 배경 해석과 첫 장면을 한 호출로 만들고 검증 후 함께 반영한다. */

export const ONBOARDING_JUDGE_SYSTEM = `You read the record of a newly appointed football manager and open that manager's first day in the job.

Read one paragraph of background and the facts of the new club, and write the first scene of the first day.

# Input
<club> — the new club: name, standing, owner, head coach, captain, key players, prospects.
<background> — the background paragraph.
<lorebook> — records of people to use in the first scene.
<snapshot> — today's date and facts about the squad and schedule. What the first scene touches on is here.

# Output
Return one JSON — scene, suggestion.

# First scene (scene)
Today is the manager's first day. Open the scene from the background and the club's context.
- Short — about six lines. One person greets the manager.
- Touch on only one or two facts from <snapshot>. Do not invent facts.
- The user plays the manager — do not write the manager's words. Close the scene with one sentence asking the manager something.
- Do not put internal judging numbers or probabilities in the scene.

# Output grammar (scene)
The scene is written only in commands; the core adds the scene marker.
- <speak name="Name">…</speak> — a person's words. name is the person's name. Inside, what is wrapped in *single asterisks* is action and staging. Change lines inside one <speak> while the same person keeps talking; open a new command when the speaker changes.
- <narration>…</narration> — narration without a speaker, written without asterisks.
- ${OUTPUT_LANGUAGE}.

# The manager's first words (suggestion)
One sentence the manager would plausibly say in answer to the question at the end of the scene — in the manager's voice, ready to send as is. It is not a choice.
`;

/** 첫 장면의 출력 크기 상한 */
const SCENE_MAX = 3000;

export const ReportInputSchema = z.object({
  /** 첫 장면 — 판정과 한 JSON이라 같은 머리가 실마리를 고르고 심는다 (agents.md §4-2) */
  scene: z
    .string()
    .min(1)
    .max(SCENE_MAX)
    .describe("The first scene of the first day — written in the output grammar's commands"),
  /** 상한을 넘거나 비면 제안만 빠진다 — 장면을 반려할 이유는 아니다 (agents.md §2) */
  suggestion: z
    .string()
    .describe(
      `One sentence of the manager's first words — within ${SUGGESTION_MAX_CHARS} characters`,
    ),
});

/** 모델이 보는 출력 스키마 — 위 Zod 한 벌에서 파생한다 (prompts.md §2 · models.md §3-2) */
export const REPORT_ONBOARDING_INPUT = toToolSchema(ReportInputSchema);

/** 핵심 선수 수 — 시작 사건이 걸 수 있는 이름의 수이지 스쿼드 목록이 아니다 */
const CLUB_KEY_PLAYERS = 4;

const CLUB_PROSPECTS = 2;

/** `<club>` — 시작 사건이 걸 수 있는 사람과 구단의 격. 사실만 (prompts.md §5) */
function buildClubBlock(state: GameState): string {
  const squad = playersOf(state, state.userTeamId);
  const row = (p: (typeof squad)[number]): string =>
    `${p.id} ${p.name} · ${ageOf(p.birthdate, state.date)}세 ${naturalPositionOf(p).position} · 종합 ${playerOverall(p)}`;
  const captain = squad.find((p) => p.isCaptain);
  const key = [...squad]
    .sort((a, b) => playerOverall(b) - playerOverall(a))
    .slice(0, CLUB_KEY_PLAYERS);
  const prospects = squad
    .filter((p) => ageOf(p.birthdate, state.date) <= 21)
    .sort((a, b) => b.attributes.potential - a.attributes.potential)
    .slice(0, CLUB_PROSPECTS);
  const owner = ownerOf(state);
  const coach = headCoachOf(state);
  return [
    `<club name="${teamNameIn(state, state.userTeamId)}">`,
    `격: ${CLUB_TIER_KO[tierOfTeamIn(state, state.userTeamId)]}`,
    `구단주: ${personLabel(owner)}`,
    `수석코치: ${personLabel(coach)}`,
    `주장: ${captain ? row(captain) : "없음"}`,
    `핵심 선수:`,
    ...key.map((p) => `- ${row(p)}`),
    ...(prospects.length > 0 ? [`유망주:`, ...prospects.map((p) => `- ${row(p)}`)] : []),
    `</club>`,
  ].join("\n");
}

/**
 * 첫 장면 검사 — 문법과 화자(감독 미발화)까지만 본다. 내용은 보지 않는다.
 */
export function isValidOnboardingText(state: GameState, text: string): boolean {
  const voices = readSceneMarkup(text).filter(
    (item) => item.kind === "voice" && item.text.length > 0,
  );
  return (
    // 장면은 커맨드로 선다 — 커맨드 밖의 글자는 장면이 아니다 (prompts.md §1)
    voices.length >= 1 &&
    // 감독은 유저의 몫이다 — GM이 대신 말하면 첫 턴부터 규약이 깨진다
    !voices.some((item) => item.kind === "voice" && item.speaker === state.manager.name)
  );
}

/**
 * 프롬프트 본문 — 구단 · 배경 · 수석코치 카드 · 스냅샷.
 *
 * ⚠️ **수석코치의 카드는 지목으로 세운다.** 이력도 지난 발화도 없어 키워드가 걸릴 문장
 * 자체가 없다 — 검증(`isValidOnboardingText`)이 요구하는 그 id가 프롬프트에 실리는
 * 자리가 여기뿐이다. 카드가 내려가면 모델은 직책으로 태그를 달고 첫 장면이 매번 반려된다.
 *
 * 스냅샷은 첫 장면이 짚을 사실(소집일·일정·몸 상태)을 갖는다. `<openings>`는 아직 비어
 * 있다 — 이 호출이 그것을 **정하는** 자리라, 장면의 재료는 스냅샷이 아니라 방금 부른
 * 도구의 인자다.
 */
export function buildOnboardingJudgePrompt(state: GameState, background: string): string {
  const coach = lorebookText(
    stampLorebook(state, selectLorebook(state.lorebook, headCoachOf(state).name, [])),
  );
  return [
    buildClubBlock(state),
    `<background>`,
    background,
    `</background>`,
    ...(coach ? [coach] : []),
    buildGmStateNote(state),
  ].join("\n");
}

/** id가 이름과 같으면 이름 한 번이다 */
function personLabel(person: { characterId: string; name: string }): string {
  return person.characterId === person.name ? person.name : `${person.characterId} ${person.name}`;
}
