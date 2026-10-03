import { CLUB_TIER_KO, ageOf, naturalPositionOf } from "@story-fm/domain";
import { z } from "zod";
import {
  type GameState,
  playersOf,
  ownerOf,
  headCoachOf,
  teamNameIn,
  tierOfTeamIn,
} from "@story-fm/engine";
import { toToolSchema } from "../common/tool-schema";

/** 배경 해석과 첫 장면을 한 호출로 만들고 검증 후 함께 반영한다. */

export const ONBOARDING_JUDGE_SYSTEM = `당신은 새로 부임하는 축구 감독의 이력을 읽고, 그 감독의 부임 첫날을 여는 사람이다.

배경 한 문단과 부임 구단의 사실을 읽고 부임 첫날의 첫 장면을 쓴다.

# 입력
<club> — 부임 구단: 이름·격·구단주·수석코치·주장·핵심 선수·유망주.
<background> — 배경 문단.
<character_book> — 첫 장면에 활용할 인물의 기록.
<snapshot> — 오늘 날짜와 선수단·일정의 사실. 첫 장면이 짚을 것이 여기 있다.

# 산출
첫 장면을 JSON 하나로 낸다 — scene.

# 첫 장면 (scene)
오늘은 감독의 부임 첫날이다. 배경과 구단의 맥락에서 장면을 연다.
- <snapshot>의 사실을 짚는다 — 소집일, 다음 일정, 몸이 성치 않은 선수. 없는 사실을 지어내지 않는다.
- 감독은 유저가 연기한다 — 감독의 말은 쓰지 않는다. 장면은 감독이 답할 자리에서 닫는다.
- 내부 판정 수치나 확률은 장면에 적지 않는다.

# 출력 문법 (scene)
장면은 @로 연다 — 줄은 줄바꿈으로 가르고, 시각 줄은 코어가 붙인다.
- @이름: 사람의 말 — 이름을 화자 태그로 쓴다.
- @: 화자 없는 내레이션. *별표 하나*로 감싼 것이 행동·연출이다.
- 같은 화자가 이어 말하면 태그를 다시 적지 않는다.
- 한국어.
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
});

/** 모델이 보는 출력 스키마 — 위 Zod 한 벌에서 파생한다 (prompts.md §2 · models.md §3-2) */
export const REPORT_ONBOARDING_INPUT = toToolSchema(ReportInputSchema);

/** 핵심 선수 수 — 시작 사건이 걸 수 있는 이름의 수이지 스쿼드 목록이 아니다 */
const CLUB_KEY_PLAYERS = 4;

const CLUB_PROSPECTS = 2;

/** `<club>` — 시작 사건이 걸 수 있는 사람과 구단의 격. 사실만 (prompts.md §5) */
export function buildClubBlock(state: GameState): string {
  const squad = playersOf(state, state.userTeamId);
  const row = (p: (typeof squad)[number]): string =>
    `${p.id} ${p.name} · ${ageOf(p.birthdate, state.date)}세 ${naturalPositionOf(p).position} · 종합 ${p.attributes.overall}`;
  const captain = squad.find((p) => p.isCaptain);
  const key = [...squad]
    .sort((a, b) => b.attributes.overall - a.attributes.overall)
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
    `구단주: ${owner.characterId} ${owner.name}`,
    `수석코치: ${coach.characterId} ${coach.name}`,
    `주장: ${captain ? row(captain) : "없음"}`,
    `핵심 선수:`,
    ...key.map((p) => `- ${row(p)}`),
    ...(prospects.length > 0 ? [`유망주:`, ...prospects.map((p) => `- ${row(p)}`)] : []),
    `</club>`,
  ].join("\n");
}
