"use client";

import { memo, useState, type CSSProperties } from "react";
import { type ClubColours, kitColourOf, portraitFallback, portraitPath } from "@gaffer/domain";
import { usePlayerCard } from "@/shared/player-card";
import { Button } from "./button";

/**
 * ── 초상 — 화면이 사람을 그리는 모든 자리가 여기를 지난다 (tokens.css 「초상」) ──
 *
 * 한 장이 가로 두 칸이다: 왼쪽이 사람, 오른쪽이 같은 틀의 티셔츠 마스크. 사람 위에 구단 색을
 * 그 마스크로 곱해 칠하므로 이적한 선수는 다음 렌더에 새 구단의 색을 입는다.
 *
 * 초상이 없는 사람(게임이 만든 선수·스태프·기자)과 자산이 올라와 있지 않은 배포에서는 같은
 * 틀에 등번호나 머리글자가 선다 — 틀의 크기가 같아 표와 판의 줄이 흐트러지지 않는다.
 */

/** 자산 폴더 — 배포가 주소를 주지 않으면 초상 없이 폴백만으로 선다 (player.md §9.6) */
export const PORTRAIT_BASE: string | null =
  (import.meta.env.VITE_PORTRAIT_BASE as string | undefined) ??
  (import.meta.env.DEV ? "/portraits" : null);

/** 크기 눈금 — 원형 셋(xs 24 · s 32 · m 48)은 머리, 4:5 둘(l 72 · xl 168)은 흉상 */
export type PortraitSize = "xs" | "s" | "m" | "l" | "xl";

const CUT = { xs: "head", s: "head", m: "head", l: "bust", xl: "bust" } as const;

/** 못 불러온 주소 — 같은 얼굴이 한 화면에 여러 번 서므로 한 번 실패한 것은 다시 묻지 않는다 */
const missing = new Set<string>();

interface PortraitProps {
  /** 선수가 아닌 사람(스태프·기자)은 id가 없다 — 머리글자로 선다 */
  playerId?: string | null | undefined;
  name: string;
  squadNumber?: number | null | undefined;
  /** 티셔츠 색을 정하는 소속 — 주지 않으면 이름 사전에서 찾고, 거기도 없으면 무채색이다 */
  teamId?: string | null | undefined;
  colours?: ClubColours | undefined;
  size?: PortraitSize;
  /** 눌러서 선수 카드를 여는 손잡이로 선다 — 카드를 열 수 없는 자리에서는 그림으로 남는다 */
  opens?: boolean;
  className?: string | undefined;
}

export const Portrait = memo(function Portrait({
  playerId,
  name,
  squadNumber,
  teamId,
  colours,
  size = "s",
  opens = false,
  className,
}: PortraitProps) {
  const card = usePlayerCard();
  const cut = CUT[size];
  const path = playerId && PORTRAIT_BASE !== null ? portraitPath(playerId, cut) : null;
  const src = path === null ? null : `${PORTRAIT_BASE}/${path}`;
  const [failed, setFailed] = useState(false);
  const shown = src !== null && !failed && !missing.has(src);

  const kit = kitColourOf(teamId ?? (playerId ? card?.teamOf(playerId) : undefined), colours);
  const style = {
    ...(kit === null ? {} : { "--kit": kit }),
    ...(shown ? { "--portrait-src": `url("${src}")` } : {}),
  } as CSSProperties;
  const look = `portrait ${cut} ${size}${shown ? "" : " blank"}${className ? ` ${className}` : ""}`;

  const body = shown ? (
    <>
      <img
        src={src}
        alt=""
        draggable={false}
        loading="lazy"
        onError={() => {
          missing.add(src);
          setFailed(true);
        }}
      />
      <i className="portrait-kit" aria-hidden />
    </>
  ) : (
    <b className={squadNumber == null ? undefined : "fig"} aria-hidden>
      {portraitFallback(name, squadNumber)}
    </b>
  );

  if (opens && card && playerId)
    return (
      <Button
        variant="bare"
        className={`${look} opens`}
        style={style}
        title={`${name} — 선수 카드`}
        aria-label={`${name} 선수 카드`}
        onClick={(e) => {
          // 행 전체가 접히거나 펼쳐지는 자리 안에 서므로, 이 눌림은 여기서 끝난다
          e.stopPropagation();
          card.open(playerId);
        }}
      >
        {body}
      </Button>
    );
  return (
    <span className={look} style={style} role="img" aria-label={name}>
      {body}
    </span>
  );
});
