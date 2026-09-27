import type { LiveMatch } from "./runner";
import { hashChannel } from "../rng";

/**
 * 체크포인트 digest — 클라이언트가 굴린 결과와 서버의 재실행이 같은가 (live-match.md §8.1).
 *
 * 경기 상태와 장부 전체를 객체 키의 정렬 순서로
 * 직렬화해 해시한다. 부동소수점을 그대로 문자열로 넣으므로 마지막 비트까지 같아야 통과한다 —
 * 그것이 이 검증의 뜻이다.
 */
export function liveDigest(match: LiveMatch): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, child]) => [key, canonical(child)]),
      );
    }
    return value;
  };
  const simulation = Object.fromEntries(
    Object.entries(match).filter(([key]) => key !== "committedTick"),
  );
  const text = JSON.stringify(canonical(simulation));
  const half = Math.floor(text.length / 2);
  return `${hashChannel(text).toString(16)}-${hashChannel(text.slice(half) + text.slice(0, half)).toString(16)}-${hashChannel(text.length + text).toString(16)}`;
}
