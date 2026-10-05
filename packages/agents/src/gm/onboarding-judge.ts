import {
  playerOverall,
  CLUB_TIER_KO,
  ageOf,
  naturalPositionOf,
  lorebookText,
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
import { SUGGESTION_MAX_CHARS } from "../shared/suggest-reply";
import { parseSceneHeader } from "../shared/context";
import { buildGmStateNote } from "./gm-input";

/** 배경 해석과 첫 장면을 한 호출로 만들고 검증 후 함께 반영한다. */

export const ONBOARDING_JUDGE_SYSTEM = `당신은 새로 부임하는 축구 감독의 이력을 읽고, 그 감독의 부임 첫날을 여는 사람이다.

배경 한 문단과 부임 구단의 사실을 읽고 부임 첫날의 첫 장면을 쓴다.

# 입력
<club> — 부임 구단: 이름·격·구단주·수석코치·주장·핵심 선수·유망주.
<background> — 배경 문단.
<lorebook> — 첫 장면에 활용할 인물의 기록.
<snapshot> — 오늘 날짜와 선수단·일정의 사실. 첫 장면이 짚을 것이 여기 있다.

# 산출
JSON 하나로 낸다 — scene, suggestion.

# 첫 장면 (scene)
오늘은 감독의 부임 첫날이다. 배경과 구단의 맥락에서 장면을 연다.
- 짧게 — 여섯 줄 안팎. 한 사람이 감독을 맞는다.
- <snapshot>의 사실 한두 개만 짚는다. 없는 사실을 지어내지 않는다.
- 감독은 유저가 연기한다 — 감독의 말은 쓰지 않는다. 장면은 감독에게 묻는 한 문장으로 닫는다.
- 내부 판정 수치나 확률은 장면에 적지 않는다.

# 출력 문법 (scene)
장면은 @로 연다 — 줄은 줄바꿈으로 가르고, 시각 줄은 코어가 붙인다.
- @이름: 사람의 말 — 이름을 화자 태그로 쓴다.
- @: 화자 없는 내레이션. *별표 하나*로 감싼 것이 행동·연출이다.
- 같은 화자가 이어 말하면 태그를 다시 적지 않는다.
- 한국어.

# 감독의 첫 말 (suggestion)
장면 끝의 물음에 감독이 할 법한 답 한 문장 — 감독의 말투로, 그대로 보낼 수 있게. 선택지가 아니다.
`;

/** 첫 장면의 출력 크기 상한 */
const SCENE_MAX = 3000;

export const ReportInputSchema = z.object({
  /** 첫 장면 — 판정과 한 JSON이라 같은 머리가 실마리를 고르고 심는다 (agents.md §4-2) */
  scene: z
    .string()
    .min(1)
    .max(SCENE_MAX)
    .describe("부임 첫날의 첫 장면 — 출력 문법 그대로, 줄은 줄바꿈으로"),
  /** 상한을 넘거나 비면 제안만 빠진다 — 장면을 반려할 이유는 아니다 (agents.md §2) */
  suggestion: z.string().describe(`감독의 첫 말 한 문장 — ${SUGGESTION_MAX_CHARS}자 안쪽`),
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
 * 첫 장면 검사 — 문법과 화자(수석코치 등장·감독 미발화)까지만 본다. 내용은 보지 않는다.
 */
export function isValidOnboardingText(state: GameState, text: string): boolean {
  // 첫 줄의 시점 헤더는 문법의 일부다 — 본문만 떼어 검사한다
  const lines = parseSceneHeader(text)
    .body.split("\n")
    .filter((line) => line.trim().length > 0);
  return (
    lines.length >= 1 &&
    // 장면은 `@`로 연다 — 그 뒤의 태그 없는 줄은 이어쓰기다 (prompts.md §1)
    (lines[0] ?? "").startsWith("@") &&
    // 감독은 유저의 몫이다 — GM이 대신 말하면 첫 턴부터 규약이 깨진다
    !lines.some((line) => line.startsWith(`@${state.manager.name}:`))
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
