import {
  type GameState,
  managedTeamId,
  clubHonoursLine,
  savedClubProfile,
  teamName,
} from "@story-fm/engine";
import { describeManager } from "../../../common/context";

/**
 * 맡은 구단 — 이름은 여는 태그의 속성이다 (`<character name>`과 같은 표기, prompts.md §5).
 * 무직이면 서지 않는다 — 옛 구단을 세우면 모델은 아직 그 구단의 감독인 것처럼 쓴다
 * (career.md §5.1). 경질·부임에 한 번 바뀌고 그 사이엔 바이트가 같다.
 *
 * **역대 한 줄이 본문에 선다** (team.md §1) — 이 구단이 무엇을 든 구단인가는 세계가
 * 아는 사실이라, 없으면 GM이 지어낸다. 우승이 없거나 시드가 없는 구단은 줄이 서지
 * 않는다: 없는 것은 0회가 아니라 모르는 것이다. **시즌에 한 번**(우승이 하나 늘 때)만
 * 바뀌므로 캐시 프리픽스는 시즌 롤오버에만 깨진다.
 */
export function describeClub(state: GameState): string | null {
  const teamId = managedTeamId(state);
  if (teamId === null) return null;
  const honours = clubHonoursLine(state, teamId);
  /**
   * **홈구장의 이름** — 장면 헤더의 장소 필드가 이 이름을 부른다 (prompts.md §1).
   * 없으면 GM이 구장 이름을 지어내고, 재정 뷰가 부르는 이름과 갈린다. 세이브에
   * 실린 값만 싣는다 — 카탈로그 폴백(「홈 구장」)은 이름이 아니라 자리 표시다.
   * 보드가 새 구장을 올려 줄 때만 바뀌므로 캐시 프리픽스는 그때만 깨진다.
   */
  const stadium = savedClubProfile(state, teamId)?.stadium.trim();
  const body = [
    ...(honours === null ? [] : [`역대: ${honours}`]),
    ...(stadium ? [`홈구장: ${stadium}`] : []),
  ];
  return body.length === 0
    ? `<club name="${teamName(teamId)}" />`
    : [`<club name="${teamName(teamId)}">`, ...body, `</club>`].join("\n");
}

/**
 * 레퍼런스 층 — 캐시되는 시스템 블록. 구단과 감독, 세이브당 고정인 것만 (agents.md §5).
 * 세 에이전트(평시 GM · 중계 · 교섭)가 같은 두 블록을 읽는다.
 *
 * ⚠️ **인물 카드는 여기 없다.** 코치·구단주·기자 다섯 장은 회견도 협상도 없는 턴에
 * 한 번도 쓰이지 않는데 매 턴 읽혔다. 그렇다고 조건부로 넣었다 뺐다 하면 더 나쁘다 —
 * 프리픽스가 바뀌는 턴마다 이 블록과 그 뒤 이력이 통째로 무효가 된다. 카드는 인물 사전이
 * 골라 **이번 턴 층**에 싣고 다음 턴부터 이력의 일부가 된다 (people.md §6).
 * ⚠️ 선수의 이름도 id도 여기 두지 않는다 — 명단은 영입·매각·2군 승격·주장 변경마다
 * 바뀌고, 한 줄이 달라지면 이 블록과 그 뒤의 이력이 통째로 무효가 된다. 이름은 매 턴
 * 층(`buildGmStateNote`)의 「선수단」 줄이 싣는다.
 */
export function buildGmReference(state: GameState): string {
  return [describeClub(state), describeManager(state.manager)]
    .filter((block): block is string => block !== null)
    .join("\n\n");
}
