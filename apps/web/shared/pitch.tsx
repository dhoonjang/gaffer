"use client";

import { useCallback, useState, type KeyboardEvent } from "react";
import type { CSSProperties, PointerEvent, ReactNode, Ref } from "react";
import { type ClubColours, conditionBand } from "@gaffer/domain";
import type { ConditionRead } from "@gaffer/engine";
import { nextInDirection, type MarkerDirection } from "@/shared/pitch-layout";
import { Button } from "./button";
import { Portrait } from "./portrait";

/**
 * ── 전술판 ────────────────────────────────────────────────
 *
 * **우리 판과 상대 판은 같은 판이다.** 감독은 경기 중 두 화면을 번갈아 보며
 * 견주므로, 칩 한 줄의 구성이 갈리면 같은 것을 두 번 배워야 한다. 두 파일이
 * 각자 그리면 한쪽에만 들어간 손질이 다른 쪽에서는 빠진 채로 남는다.
 *
 * 여기가 **구조**를 갖는다 — 그라운드의 선, 칩의 얼굴과 두 줄. 상태(고른 칩·못 뛰는
 * 선수·지친 상대)는 부르는 쪽이 클래스로 얹는다.
 */

/**
 * 눈금은 **기본 배치의 칩 자리에 맞춰** 잡았다 — 보통(3)일 때 수비 라인은 센터백
 * 높이(75%)에, 폭은 윙어 자리(14%/86%)에 선다. 선이 칩과 어긋나 있으면 그림이
 * 배치를 설명하지 못하고 따로 도는 장식이 된다.
 */
const DEF_LINE_TOP = (v: number) => 87 - (v - 1) * 6;
const PRESS_LINE_TOP = (v: number) => 70 - (v - 1) * 11;
const WIDTH_INSET = (v: number) => 24 - (v - 1) * 5;

/** 자리를 뜻하는 세 축 — 판 위에 선으로 앉는 것들 */
type PitchTacticsAxes = { defensiveLine: number; pressing: number; width: number };

/**
 * 판 위의 전술 선 — 수비 라인 · 압박 시작선 · 공격 폭.
 *
 * 여섯 축 중 셋만 긋는다. 이 셋은 **자리를 뜻하는 축**이라 판 위에 그대로 앉지만,
 * 템포·패스는 공간이 아니라 속도와 거리라 선으로 그으면 뜻이 어긋난다. 멘탈리티는
 * 칩이 어디 서 있는지가 이미 말한다.
 *
 * 압박선은 늘 수비 라인보다 위다 — 압박은 그 앞에서 시작하는 것이라, 눈금이
 * 뒤집혀도(낮은 압박 + 높은 라인) 선이 교차하면 그림이 거짓말이 된다.
 */
function PitchTactics({ tactics }: { tactics: PitchTacticsAxes }) {
  const def = DEF_LINE_TOP(tactics.defensiveLine);
  const press = Math.min(PRESS_LINE_TOP(tactics.pressing), def - 6);
  const inset = WIDTH_INSET(tactics.width);
  return (
    <div className="pitch-tactics" aria-hidden>
      <span className="tac-width" style={{ left: `${inset}%`, right: `${inset}%` }} />
      <span className="tac-block" style={{ top: `${def}%` }} />
      <span className="tac-line press" style={{ top: `${press}%` }} />
      <span className="tac-line def" style={{ top: `${def}%` }} />
    </div>
  );
}

/**
 * 그라운드 — 선 · 박스 · 전술선 · 라인 이름. 칩은 `children`으로 얹는다.
 *
 * 판을 감싸는 `pitch-wrap`까지 여기서 그린다: 판은 남는 높이에 맞춰 줄어드는데
 * 그 높이를 알려 주는 것이 이 칸이라, 둘이 갈리면 한쪽 판만 넘친다.
 */
export function PitchGround({
  boardRef,
  variant,
  testId,
  tactics,
  children,
}: {
  boardRef?: Ref<HTMLDivElement>;
  /** 판의 상태 클래스 — 편집 중(`editing`) 같은 것 */
  variant?: string;
  testId: string;
  tactics: PitchTacticsAxes;
  children: ReactNode;
}) {
  return (
    <div className="pitch-wrap">
      <div
        ref={boardRef}
        className={`pitch-board${variant ? ` ${variant}` : ""}`}
        data-testid={testId}
      >
        <div className="pitch-lines" />
        <div className="pitch-box top" />
        <div className="pitch-box small top" />
        <div className="pitch-box bottom" />
        <div className="pitch-box small bottom" />
        <PitchTactics tactics={tactics} />
        <span className="pitch-zone" style={{ top: "6%" }}>
          공격
        </span>
        <span className="pitch-zone" style={{ top: "46%" }}>
          중원
        </span>
        <span className="pitch-zone" style={{ top: "84%" }}>
          수비
        </span>
        {children}
      </div>
    </div>
  );
}

/**
 * 역할 카드의 표식 — 감독이 기본 행동이 아닌 카드를 건 칩에만 붙는다. 칩에는 이름의
 * 앞부분만 서고(칩 폭), 이름 전체와 낱말 줄은 툴팁이 든다.
 */
type PitchCardTag = { title: string; words: string };

/** 칩에 서는 카드 이름의 길이 — 넘으면 줄임표로 접는다 */
const CARD_TAG_CHARS = 5;

type PitchChipProps = {
  /** 만질 수 있는 칩은 버튼이다 — 상대 팀 칩처럼 읽기만 하는 것은 `span` */
  as?: "button" | "span" | undefined;
  /** 지금 서 있는 자리 (좌표에서 나온 코드) */
  code: string | null;
  /** 얼굴을 찾는 열쇠 — 빈 자리는 없다 */
  playerId?: string | null | undefined;
  /** 티셔츠 색을 정하는 소속 */
  teamId?: string | null | undefined;
  colours?: ClubColours | undefined;
  squadNumber?: number | null | undefined;
  cardTag?: PitchCardTag | null | undefined;
  /**
   * 완장 — 주장·부주장이 같은 자리에 같은 크기로 선다 (people.md §5-1).
   * 리더 그룹은 칩에 세우지 않는다: 열한 자리 중 다섯에 표식이 서면 그것은
   * 표식이 아니라 배경이 된다. 서열은 명단 표가 낸다.
   */
  captain?: "captain" | "vice" | null | undefined;
  /** 이름 — 칩에 그대로 선다(안 들어가면 접힌다). 빈 자리는 `null` */
  name: string | null;
  /** 이 자리에서 내는 전력 */
  ovr: ReactNode;
  /** 남은 체력 — 얼굴 둘레의 호가 된다. 모르면 호가 서지 않는다 */
  condition?: ConditionRead | undefined;
  /** 전력 뒤에 서는 표식 — 오차·부상·경고 */
  metaExtra?: ReactNode | undefined;
  /** 상태 클래스 (`selected` · `theirs` · `unavailable` …) — 구조는 여기가, 상태는 부르는 쪽이 */
  variant?: string | undefined;
  style?: CSSProperties | undefined;
  title?: string | undefined;
  testId?: string | undefined;
  /** 방향키 묶음의 정지점인가 — `useRovingMarkers`가 낸 값 (버튼일 때만 뜻이 있다) */
  tabIndex?: number | undefined;
  /** 그 묶음이 자기를 되찾는 표식 — 같은 훅이 읽는다 */
  markerId?: string | undefined;
  onPointerDown?: ((e: PointerEvent<HTMLElement>) => void) | undefined;
  onClick?: (() => void) | undefined;
};

/**
 * 칩 — **얼굴 하나와 두 줄.** 얼굴(번호 · 완장 · 전력) / 이름 / (자리 · 카드)
 *
 * 누구인지는 얼굴이 말하고, 숫자 셋은 얼굴의 모서리에 붙는다: 왼쪽 위가 등번호, 오른쪽 위가
 * 완장, 오른쪽 아래가 이 자리의 전력이다. **둘레의 호는 남은 체력이다** — 명단으로 건너가지
 * 않아도 판에서 누가 지쳤는지가 보인다 (색은 명단 막대와 같은 밴드다).
 *
 * 얼굴은 여기서 손잡이가 아니다 — 칩 전체가 고르고 끄는 손잡이라 그 안에 또 하나를 두지
 * 않는다. 카드는 칩을 고른 뒤의 상세가 연다.
 */
export function PitchChip({
  as = "span",
  code,
  playerId,
  teamId,
  colours,
  squadNumber,
  cardTag,
  captain,
  name,
  ovr,
  condition,
  metaExtra,
  variant,
  style,
  title,
  testId,
  tabIndex,
  markerId,
  onPointerDown,
  onClick,
}: PitchChipProps) {
  const body = (
    <>
      <span
        className={`chip-face${condition ? ` ${conditionBand(condition.value)}` : ""}`}
        style={condition ? ({ "--fit": condition.low } as CSSProperties) : undefined}
      >
        {name === null ? (
          <span className="chip-empty" aria-hidden />
        ) : (
          <Portrait
            playerId={playerId}
            name={name}
            squadNumber={squadNumber}
            teamId={teamId}
            colours={colours}
            size="m"
          />
        )}
        {squadNumber !== null && squadNumber !== undefined && (
          <i className="shirt-no">{squadNumber}</i>
        )}
        {captain && (
          <b className="slot-cap" title={captain === "captain" ? "주장" : "부주장"}>
            {captain === "captain" ? "C" : "V"}
          </b>
        )}
        <span className="slot-meta">
          <b>{ovr}</b>
          {metaExtra}
        </span>
      </span>
      <span className="slot-name">{name || "—"}</span>
      <span className="slot-pos">
        {/* 자리 코드는 자기 요소를 갖는다 — 한 줄에 카드가 함께 서므로
            "이 칩의 자리"를 가리킬 자리가 하나 있어야 한다 */}
        <span className="slot-code">{code}</span>
        {cardTag && (
          <em
            className="slot-role"
            title={cardTag.words ? `${cardTag.title} — ${cardTag.words}` : cardTag.title}
          >
            {cardTag.title.length > CARD_TAG_CHARS
              ? `${cardTag.title.slice(0, CARD_TAG_CHARS - 1)}…`
              : cardTag.title}
          </em>
        )}
      </span>
    </>
  );
  const className = `pitch-slot pitch-chip${variant ? ` ${variant}` : ""}`;
  if (as === "button")
    return (
      <Button
        variant="bare"
        className={className}
        style={style}
        title={title}
        data-testid={testId}
        tabIndex={tabIndex}
        data-marker={markerId}
        onPointerDown={onPointerDown}
        onClick={onClick}
      >
        {body}
      </Button>
    );
  return (
    <span className={className} style={style} title={title} data-testid={testId}>
      {body}
    </span>
  );
}

/**
 * ── 판 위의 손잡이 묶음 — **정지점 하나, 안에서는 방향키** ────────
 *
 * 판 하나에 열 개 넘는 버튼이 서면 탭만으로는 판을 지날 수 없다(overview.md §5).
 * 그래서 묶음이 탭 정지점 하나를 갖고(`tabIndexOf`), 그 안에서는 방향키가 자리를
 * 옮긴다.
 *
 * **자리는 화면에서 읽는다** — 마커의 좌표는 겹침을 푼 뒤의 값이라 컴포넌트가 쥔
 * 숫자와 실제로 그려진 자리가 다를 수 있고, 판마다 가로세로 비도 다르다. 눌린
 * 순간의 `getBoundingClientRect()`가 두 사정을 한 번에 지운다.
 *
 * 쥔 것은 **id**다: 교체로 명단이 바뀌어도 정지점이 엉뚱한 자리로 옮겨 가지 않고,
 * 그 선수가 판에서 사라지면 첫 마커가 정지점을 되받는다.
 */
export function useRovingMarkers(ids: readonly string[]): {
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
  tabIndexOf: (id: string) => 0 | -1;
} {
  const [held, setHeld] = useState<string | null>(null);
  const stop = held !== null && ids.includes(held) ? held : (ids[0] ?? null);
  const onKeyDown = useCallback((e: KeyboardEvent<HTMLElement>) => {
    const dir = ARROW_DIRS[e.key];
    if (!dir) return;
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-marker]")];
    const from = items.indexOf(document.activeElement as HTMLElement);
    if (from < 0) return;
    const next = nextInDirection(items.map(centerOf), from, dir);
    if (next === null) return;
    // 판 위에서 방향키는 자리를 옮긴다 — 그 아래 패널이 함께 스크롤되면 판이 달아난다
    e.preventDefault();
    const target = items[next]!;
    target.focus();
    setHeld(target.dataset.marker ?? null);
  }, []);
  return { onKeyDown, tabIndexOf: (id) => (id === stop ? 0 : -1) };
}

const ARROW_DIRS: Record<string, MarkerDirection | undefined> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

const centerOf = (el: HTMLElement) => {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};
