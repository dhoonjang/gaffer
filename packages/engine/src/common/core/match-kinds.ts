import { type MatchRecord } from "@story-fm/domain";

/**
 * 이 경기가 어느 대회에도 속하지 않는가.
 *
 * 대회를 세는 자리(순위표·시즌 기록·징계·상금·대회 화면)는 전부 이 문을 먼저
 * 지난다. `competitionId`를 널 허용으로 연 것이 곧 그 자리들을 타입으로 드러내는
 * 장치다.
 */
export function isFriendly(match: Pick<MatchRecord, "competitionId">): boolean {
  return match.competitionId === null;
}
