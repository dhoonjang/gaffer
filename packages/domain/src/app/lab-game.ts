/**
 * 경기 실험실의 세이브 — **id 머리로 가른다** (match/live-match.md §8.6). 읽기·쓰기·
 * 잠금은 게임과 같은 길이고, 목록에 서지 않고 오래되면 지워진다는 것만 다르다.
 * 게임 화면도 이 머리로 나가는 문(게임 목록 대신 실험실)을 고르므로 도메인에 산다.
 */
export const LAB_ID_PREFIX = "lab-";

export function isLabGame(id: string): boolean {
  return id.startsWith(LAB_ID_PREFIX);
}
