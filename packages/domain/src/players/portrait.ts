import { PORTRAIT_IDS, PORTRAIT_VERSION } from "./portrait-index";

/**
 * ── 선수 초상 (player.md §9.6 · tokens.css 「초상」) ─────────────────────
 *
 * 초상은 **선수 id로 찾는다.** 카탈로그의 id는 이름에서 결정적으로 나오므로 세이브에 아무것도
 * 싣지 않아도 화면이 주소를 낸다 — 게임이 만든 선수(유스·합성)와 가명본 시드의 선수는 목록에
 * 없어 폴백으로 선다.
 *
 * 한 사람에 두 벌이다: 원형 자리에 서는 머리(`head`)와 4:5 틀에 서는 흉상(`bust`).
 */
export type PortraitCut = "head" | "bust";

/** 초상의 주소 — 자산 폴더 아래의 상대 경로. 초상이 없는 선수는 `null` */
export function portraitPath(playerId: string, cut: PortraitCut): string | null {
  if (!PORTRAIT_IDS.has(playerId)) return null;
  return `${cut === "head" ? "h" : "p"}/${playerId}.webp?v=${PORTRAIT_VERSION}`;
}

/**
 * 초상이 없는 자리에 서는 글자 — 등번호가 있으면 그 수, 없으면 이름의 머리글자다.
 *
 * 머리글자는 첫 어절과 마지막 어절의 첫 글자 둘(「알베르트 스투이벤베르흐」 → 「알스」),
 * 한 어절뿐이면 그 한 글자다.
 */
export function portraitFallback(name: string, squadNumber?: number | null): string {
  if (squadNumber !== null && squadNumber !== undefined) return String(squadNumber);
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0];
  if (first === undefined) return "";
  const last = words.length > 1 ? words[words.length - 1] : undefined;
  return (first[0] ?? "") + (last?.[0] ?? "");
}
