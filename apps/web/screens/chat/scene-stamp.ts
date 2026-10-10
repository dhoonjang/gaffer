import type { ChatTurn } from "@gaffer/engine";
import { readSceneMarkup, sceneClock, type SceneMarker } from "@gaffer/domain";
import { humanDate } from "../../shared/dateline";

/**
 * 장면의 줄과 시각 — 저장된 본문의 커맨드(`<scene>` · `<speak>` · `<narration>` ·
 * `<commentary>`)를 화면이 읽는 줄로 편다 (docs/agents/prompts.md §1).
 *
 * 컴포넌트가 아니라 여기 있는 이유는 **순수 규칙**이기 때문이다 — 화면이 없어도
 * 성립하고, 그래서 테스트가 JSX를 거치지 않는다.
 */

/** 말 한 줄 — `speaker`가 `""`면 지문이다. `block`은 그 줄이 든 커맨드의 자리다 */
export interface SayLine {
  speaker: string;
  block: number;
  text: string;
}

/**
 * 화면이 읽는 줄 하나 — **저장된 본문의 빈 줄 아닌 줄 하나와 맞선다.** 위생이 커맨드를
 * 정본의 꼴로 적으므로(여는 태그 뒤에 첫 줄, 닫는 태그 앞에 끝 줄) 그 셈이 같고, 호출 칩의
 * 자리(`ToolCallRecord.line`)가 그 셈으로 저장된다.
 */
export type SceneLine = ({ kind: "say" } & SayLine) | { kind: "stamp"; stamp: string };

/**
 * 본문 → 줄. 스트리밍 중 닫히지 않은 커맨드는 지금까지 온 만큼 서고, 끝에 걸린
 * 미완성 태그(`<spe`)는 다음 델타까지 보류된다(`readSceneMarkup`) — 안 그러면 한
 * 프레임 날것으로 보인다.
 */
export function sceneLines(text: string): SceneLine[] {
  const lines: SceneLine[] = [];
  readSceneMarkup(text).forEach((item, block) => {
    if (item.kind === "scene") {
      lines.push({ kind: "stamp", stamp: sceneStamp(item.marker) });
      return;
    }
    for (const line of item.text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length > 0)
        lines.push({ kind: "say", speaker: item.speaker, block, text: trimmed });
    }
  });
  return lines;
}

/**
 * 표식을 **때(part of day)로 접는다** — `7월 2일 목 오후 — 훈련장`.
 *
 * 정확한 시각은 **상단 띠가 갖는다**(`game-date`). 채팅에서까지 분을 세우면 두
 * 시계가 나란히 서서 같은 것을 두 번 말하고, 스탬프가 장면마다 서서 "바뀔 때만
 * 선다"는 규칙이 무력해진다. 채팅이 알려야 하는 건 **장면이 언제로 넘어갔나**뿐이라
 * 눈금은 굵을수록 좋다 — 오전에서 오후로 넘어간 것이 12:10에서 12:40으로 간 것보다
 * 훨씬 큰 사건이다.
 *
 * 날짜는 **사람 표기**로 선다(`7월 2일 목 오전`) — ISO는 프롬프트의 문법이고 감독이
 * 읽는 문법이 아니다 (tokens.css 「숫자와 표기」). ISO가 아니면 그대로다.
 *
 * **장소는 시각 뒤에 붙는다** — 데이트라인이 「7월 18일 토 오전 — 에미레이츠」로 세우고,
 * 그래서 장면의 첫 문장은 같은 장소를 다시 말하지 않는다 (prompts.md §1).
 * 경기의 분 표식은 분 그대로다.
 */
export function sceneStamp(marker: SceneMarker): string {
  if (marker.minute !== undefined) return `${marker.minute}'`;
  const clock = sceneClock(marker.time);
  const when = [
    ...(marker.date ? [humanDate(marker.date)] : []),
    ...(clock === null ? [] : [partOfDay(minutesOf(clock))]),
  ].join(" ");
  return [when, ...(marker.place ? [marker.place] : [])].filter((s) => s.length > 0).join(" — ");
}

function minutesOf(clock: string): number {
  const [hour = "0", minute = "0"] = clock.split(":");
  return Number(hour) * 60 + Number(minute);
}

/** 하루를 다섯 때로 — 새벽·아침·오전·오후·저녁·밤 */
function partOfDay(minutes: number): string {
  if (minutes < 6 * 60) return "새벽";
  if (minutes < 9 * 60) return "아침";
  if (minutes < 12 * 60) return "오전";
  if (minutes < 17 * 60 + 30) return "오후";
  if (minutes < 21 * 60) return "저녁";
  return "밤";
}

/** 걷어낸 표식 하나 — 남은 줄 기준으로 어디에 서 있었나 */
interface StampCut {
  /** 이 줄 수만큼 지난 자리에 선다 */
  after: number;
  stamp: string;
}

/** 표식을 걷어낸 말 줄과, 그것이 서 있던 자리들 */
interface CutScene {
  lines: SayLine[];
  stamps: StampCut[];
  /** 걷어낸 줄의 인덱스 — 호출 칩의 자리(`ToolCallRecord.line`)를 당길 때 쓴다 */
  cuts: number[];
}

/**
 * 줄 목록에서 표식을 **어디에 있든** 걷어낸다 — 한 턴 안에서 시간이 흐르면 표식이
 * 본문 한복판에 선다. 걷힌 자리는 시각 표시로 다시 선다.
 */
export function cutStamps(lines: readonly SceneLine[]): CutScene {
  const kept: SayLine[] = [];
  const stamps: StampCut[] = [];
  const cuts: number[] = [];
  lines.forEach((line, i) => {
    if (line.kind === "say") {
      kept.push({ speaker: line.speaker, block: line.block, text: line.text });
      return;
    }
    if (line.stamp.length > 0) stamps.push({ after: kept.length, stamp: line.stamp });
    cuts.push(i);
  });
  return { lines: kept, stamps, cuts };
}

/**
 * 앞 턴의 시각 — 목록이 **같은 시각을 다시 적지 않기 위해** 미리 읽는다.
 * 한 턴이 여러 장면을 열었으면 **마지막** 시각이 다음 턴의 기준이다.
 *
 * ⚠️ **화자 이름은 접지 않는다.** 시각과 달리 이름은 턴마다 서야 한다 — 감독의 말과
 * 코치의 답이 번갈아 오는 화면에서, 이름이 빠진 턴은 누가 말하는지를 위쪽까지
 * 거슬러 올라가 찾아야 한다. 한 턴 안에서 같은 사람이 이어 말할 때 묶는 것
 * (`groupUtterances`)과는 다른 이야기다.
 */
export function turnStamp(turn: ChatTurn): string | null {
  if (turn.role !== "model") return null;
  const { stamps } = cutStamps(sceneLines(turn.text));
  return stamps[stamps.length - 1]?.stamp ?? null;
}
