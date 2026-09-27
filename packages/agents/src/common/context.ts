import {
  type PersonaRelation,
  RELATION_TIER_KO,
  type CharacterEntry,
  personaRoleLabel,
} from "@story-fm/domain";
import { type GameState, type ChatTurn, isPeaceTurn, type ScenePoint } from "@story-fm/engine";

/**
 * 인물 카드 — 인물지를 모델이 읽는 형태로 (people.md §6).
 *
 * 예시 대사까지 실어야 모델이 톤을 흉내 내는 대신 그 사람으로 말한다. 무엇이 실리고
 * 무엇이 빠지는지는 **깊이**가 정하고, 그 판단은 코어(`characterEntry`)의 것이다 —
 * 여기서는 온 것을 문장으로 옮기기만 한다.
 *
 * ⚠️ **카드는 데이터다 — 지시문을 싣지 않는다** (prompts.md §5). 조회 포인터도
 * 실명 가드도 여기 없다: 규칙은 시스템 프롬프트가 한 번 갖고, 실명 인물의 사람됨은
 * 원형과 장부의 사실이 묶는다. 화자 태그는 여는 태그의 속성이다 — 태그와 이름이
 * 갈리는 동명이인에서 모델이 태그를 알 자리가 여기뿐이다.
 *
 * 블록은 영어 태그로 싼다 (prompts.md §5) — 읽는 것(꺾쇠)과 쓰는 것(@ 줄)이 갈린다.
 */
/**
 * 관계 한 줄 — 근거가 있으면 함께 적는다.
 *
 * **감독이 붙여 준 사이**(멘토링 — people.md §5-3)에는 원형 축이 없다: 그 자리에
 * 섰다는 사실 하나가 근거다. **원형에서 시작한 사이**는 먼저 보는 것을 함께 든다.
 * 어느 쪽이든 앞에 서는 것은 지금의 등급이고, 등급이 빠지는 것은 가운데 둘
 * (`distant`·`cordial`)일 때다 — 결이 서지 않는 사이는 카드에 등급을 세우지 않는다.
 */
function relationLine(r: PersonaRelation): string {
  const grade = r.tier ? RELATION_TIER_KO[r.tier] : null;
  if (r.bond) {
    const seat = r.bond === "mentor" ? "멘토" : "멘티";
    return `관계: ${r.name} — 감독이 붙여 준 사이 (내가 ${seat})${grade ? ` · ${grade}` : ""}`;
  }
  return `관계: ${r.name} — ${grade ?? (r.stance === "aligned" ? "결이 맞는다" : "결이 부딪힌다")}`;
}

export function describePersona(entry: CharacterEntry): string {
  const label = personaRoleLabel(entry.role);
  return [
    `<character name="${entry.name}" tag="@${entry.characterId}:"${label ? ` role="${label}"` : ""}>`,
    `원형: ${entry.archetype}`,
    `성격: ${entry.traits.join(" · ")}`,
    ...(entry.motivation ? [`동기: ${entry.motivation}`] : []),
    ...(entry.speechStyle ? [`말투: ${entry.speechStyle.note}`] : []),
    ...(entry.speechStyle?.samples ?? []).map((s) => `  예) ${s}`),
    // 관계 — **지금의 등급**이다 (people.md §6 「관계 등급」). 숫자는 싣지 않는다:
    // 카드는 이력에 굳으므로 매 턴 달라지는 값을 실으면 지난 턴들의 바이트가 함께 바뀐다
    ...(entry.relations ?? []).map((r) => relationLine(r)),
    // 감독이 아는 만큼만 그린다 — 소문으로만 아는 사람에게 속내를 주면 만난 적 없는
    // 사람의 목소리가 난다. 사실로 적는다: 카드의 지시문은 모델이 그 문장대로 쓴다
    ...(entry.depth === "rumour" ? [`감독과의 거리: 평판으로만 안다 — 말투도 속내도 모른다`] : []),
    // 기억은 **이번 턴에 세우는 카드에만** 온다 — 이력이 다시 그리는 카드
    // (`characterEntryOf`)는 기억 없이 오므로 이 줄이 서지 않는다. 압축이 더한 기억이
    // 지난 턴의 바이트를 바꾸지 않는 자리다 (people.md §6 · agents.md §5)
    ...(entry.memories?.length
      ? [`있었던 일:`, ...entry.memories.map((m) => `  ${m.date} — ${m.text}`)]
      : []),
    `</character>`,
  ].join("\n");
}

/**
 * 이번 장면의 인물들 — 인물 사전이 고른 카드 묶음 (people.md §6).
 *
 * ⚠️ **여기 있는 것은 "이 사람이 누구인가"뿐이다.** 카드는 이력에 굳으므로 변하는
 * 값(폼·컨디션·부상·심경·계약)이 들어가면 3주 뒤 모델이 낡은 사실로 말한다. 지금의
 * 사실은 조회 도구가 갖고, **조회하고 답하라는 지시는 이 블록이 아니라 `GM_SYSTEM`의
 * 철칙과 그 도구의 설명이 갖는다** — 카드에는 사실만 선다 (prompts.md §5).
 */
export function describeCharacters(entries: readonly CharacterEntry[]): string | null {
  if (entries.length === 0) return null;
  return [`<characters>`, ...entries.map(describePersona), `</characters>`].join("\n");
}

/**
 * 감독 — 이름과 화자 태그는 속성, 배경은 본문. 세이브당 고정인 것만이다.
 *
 * **데이터만 싣는다** (prompts.md §5). 선수 이름이 스냅샷에 있다는 것, 선수 인자는
 * 이름으로 받는다는 것, 감독을 대신 연기하지 않는다는 것은 전부 시스템 프롬프트가
 * 한 번 갖는 규칙이라 여기 다시 적지 않는다 (prompts.md §5-3).
 * ⚠️ 감독의 능력·평판은 여기 없다 — 경기마다 평판이 움직이고 능력도 자라므로
 * 여기 있으면 경기 한 번에 이 블록과 그 뒤가 통째로 무효가 된다. 매 턴
 * 층(`buildGmStateNote`)이 구간 어휘로 싣는다.
 */
export function describeManager(
  manager: Pick<GameState["manager"], "name" | "background">,
): string {
  return [
    `<manager name="${manager.name}" tag="@${manager.name}:">`,
    `배경: ${manager.background}`,
    `</manager>`,
  ].join("\n");
}

/**
 * 화면 조작 — 감독의 발화가 아니다. **모델의 출력 문법 밖 봉투로 싣는다**
 * (`<operator>시간 진행 — 하루</operator>`). `@:`는 GM이 내레이션을 쓰는 채널이라 거기 담으면
 * 감독의 화면 조작이 모델 자신의 문법으로 이력에 서고, 인물이 그 손잡이를 아는
 * 것으로 읽힌다 (docs/common/llm/prompts.md §1).
 */
export function buildOperatorMessage(message: string): string {
  return `<operator>${message}</operator>`;
}

/** 해석기가 읽는 지난 턴 수 — 이름 없는 지목이 가리키는 대상은 직전 대화에 있다 */
export const RECENT_TURNS = 5;

/**
 * 지난 턴 본문 하나를 다른 호출에 실을 때의 상한 — 해석기의 `<recent_turns>`·
 * `<match_log>`와 마감의 `<commentary>`가 같은 자를 쓴다. 읽는 쪽에 필요한 것은
 * 누가 무슨 말을 했고 흐름이 어땠는가지 장면 전부가 아니다.
 */
export const TURN_EXCERPT_CHARS = 1500;

/**
 * 턴 목록을 해석기가 읽는 줄로 — **평시의 `<recent_turns>`와 경기의 `<match_log>`가 같은
 * 함수를 쓴다.** 감독 턴은 `@감독:` 봉투, 손잡이 턴은 오퍼레이터 봉투, 모델 턴은 본문을
 * 잘라서. 두 벌이면 한쪽만 고쳐져 두 해석기가 다른 말을 읽는다.
 */
export function renderTurns(turns: readonly ChatTurn[]): string[] {
  return turns.map((t) => {
    if (t.role === "user") return `@감독: ${t.text}`;
    if (t.role === "operator") return buildOperatorMessage(t.text);
    return t.text.slice(0, TURN_EXCERPT_CHARS);
  });
}

/**
 * **이번 턴에 밀어 넣은 꼬리를 뺀 지난 턴들** — 해석기의 `<recent_turns>`·`<match_log>`가
 * 읽는다. 턴 러너는 감독의 말을 모델 호출 전에 채팅에 넣으므로(`historyEnd`) 꼬리를
 * 그대로 실으면 같은 말이 `@감독:` 줄과 두 벌이 된다 (agents.md §3).
 */
export function pastTurns(turns: GameState["chat"]): GameState["chat"] {
  return turns.slice(0, historyEnd(turns));
}

/** `<recent_turns>`의 본문 — 평시의 지난 턴들. 이번 턴의 것은 `@감독:` 줄이 싣는다 */
export function buildRecentTurnsBlock(state: GameState, count = RECENT_TURNS): string {
  const peace = pastTurns(state.chat.filter(isPeaceTurn));
  return renderTurns(peace.slice(-count)).join("\n");
}

/**
 * 장면 헤더 — 모델이 첫 줄에 적는 시점과 장소. 시계를 움직이는 유일한 입구다.
 * 일상 `[2026-07-13 오후 · 훈련장]` · 경기 `[67']`. 형식이 어긋나면 시간이 멈춘다
 * (로그로 드러낸다).
 * ⚠️ 날짜만 필수 — 시:분을 필수로 좁히면 `[2026-07-20 월요일 오전]`을 못 잡아
 * 시계가 며칠씩 멈춘다. **장소도 같은 이유로 흘려 읽는다**: 시계는 날짜가 미는 것이고
 * 장소는 화면이 데이트라인으로 세우는 것이라(`partOfDayStamp`), 장소가 없거나
 * 구분자가 다르다고 그 턴의 시계를 멈출 이유가 없다 (prompts.md §1).
 */
const SCENE_HEADER_RE = new RegExp(
  [
    /^\[\s*(\d{4}-\d{2}-\d{2})/, // 날짜 — 이것만 필수
    /(?:\s*[,·]?\s*\(?\s*[월화수목금토일](?:요일)?\s*\)?)?/, // 요일 (수) · 월요일
    /(?:\s*[,·]?\s*(AM|PM|오전|오후|아침|점심|저녁|밤|새벽))?/, // 시간대
    /(?:\s*(\d{1,2}):(\d{2}))?/, // 시각
    /(?:\s*[·—–,-]?\s*[^\]]*)?/, // 장소 — 구분자가 무엇이든, 없어도 읽는 것은 화면이다
    /\s*\]/,
  ]
    .map((r) => r.source)
    .join(""),
  "i",
);

const MATCH_HEADER_RE = /^\[\s*(\d{1,3})\s*['′분]?\s*\]/;

/** 시간대만 적힌 헤더의 기본 시각 — 하루 안에서 되감기지 않을 만큼만 민다 */
const PART_OF_DAY: Record<string, string> = {
  새벽: "06:00",
  아침: "08:00",
  오전: "09:00",
  am: "09:00",
  점심: "12:30",
  오후: "14:00",
  pm: "14:00",
  저녁: "19:00",
  밤: "21:00",
};

/**
 * `AM 9:30` · `PM 7:05` · `14:30` → "HH:MM" (24시간). 읽을 수 없으면 null.
 *
 * ⚠️ **시간대가 붙었는지가 12시간제인지를 가른다.** 시간대 없는 `14:30`까지 12로
 * 접으면 `02:30`이 되어 시각이 오전으로 뒤집히고, 코어가 되감기를 막으므로 그 턴의
 * 시계가 통째로 멎는다. 그래서 시간대가 없으면 적힌 값이 곧 24시간 값이다 —
 * `오전 12:05`는 자정 00:05, 시간대 없는 `12:05`는 정오 12:05.
 */
function toClock(meridiem: string | undefined, hour: string, minute: string): string | null {
  const h = Number(hour);
  if (h > 23 || Number(minute) > 59) return null;
  const h24 = meridiem ? (h % 12) + (/^(PM|오후|저녁|밤)$/i.test(meridiem) ? 12 : 0) : h;
  return `${String(h24).padStart(2, "0")}:${minute}`;
}

/** 헤더가 가리키는 시각 — 시:분이 있으면 그것, 없으면(또는 읽을 수 없으면) 시간대의 기본값 */
function clockFromHeader(meridiem: string | undefined, hour?: string, minute?: string): string {
  const clock = hour && minute ? toClock(meridiem, hour, minute) : null;
  return clock ?? PART_OF_DAY[(meridiem ?? "").toLowerCase()] ?? "09:00";
}

/** 위생이 지금까지 본 것 — 직전에 살린 헤더는 무엇이었나, 장면이 열렸나 */
export interface SceneScan {
  /** 마지막으로 살아남은 시점 헤더의 값 — 아직 하나도 없으면 null */
  lastHeader: string | null;
  /** 첫 `@` 줄이 지나갔다 — 그 뒤의 태그 없는 줄은 이어쓰기다 */
  sceneOpen: boolean;
  /** 열려 있는 꺾쇠 블록의 이름 — 그 안의 줄은 어느 국면에서도 장면이 아니다 */
  block: string | null;
  /** 헤더·작업 로그 규칙까지 거는가 — 중계는 꺾쇠 규칙 하나만 읽는다 */
  scenes: boolean;
}

/** 헤더 값 비교용 — 안쪽 공백의 차이는 같은 시각이다 */
function headerKey(line: string): string {
  return line.trim().replace(/\s+/gu, " ");
}

/**
 * 줄 앞머리의 여는 태그 이름 — `<points>` · `<ledger>` (`</…>`·`<…/>`는 아니다).
 *
 * ⚠️ 이름은 **글자로 열린다**(`\p{L}`) — 코어의 블록은 영어지만 모델이 지어내는
 * 태그는 한글일 수 있고(`<생각>`), 숫자로 여는 것은 태그가 아니라 부등호다(`3 < 4`).
 */
const OPENS_TAG_RE = /^<([\p{L}_][\p{L}\p{N}_-]*)(?:\s[^<>]*)?>/u;

/** 줄 하나로 끝난 꺾쇠 — 짝 없는 닫는 태그이거나 스스로 닫은 태그 */
const LONE_TAG_RE = /^<\/[\p{L}_][\p{L}\p{N}_-]*\s*>$|^<[\p{L}_][\p{L}\p{N}_-]*(?:\s[^<>]*?)?\/>$/u;

/** 이 줄이 그 이름의 블록을 닫는가 — 한 줄로 여닫은 블록도 여기서 걸린다 */
function closesTag(trimmed: string, name: string): boolean {
  return new RegExp(`</${name}\\s*>`, "u").test(trimmed);
}

/** 장면이 다시 서는 줄인가 — 화자(`@`)이거나 시점 헤더(`[`)다 */
function opensScene(trimmed: string): boolean {
  return trimmed.startsWith("@") || trimmed.startsWith("[");
}

/**
 * 꺾쇠로 여닫는 블록은 **읽는 것**이고 장면이 아니다 (prompts.md §1).
 *
 * `<points>`·`<ledger>`는 코어가 읽으라고 넣어 준 입력 구조인데, 모델이 그것을
 * 되받아 쓰면 프롬프트 내부 구조가 감독이 읽는 자리에 그대로 선다. 평시도 중계도
 * 이 한 규칙을 함께 읽는다.
 *
 * 판정은 **줄 단위**다 — `@`로 연 줄 안의 꺾쇠는 대사의 일부라 손대지 않는다.
 */
function opensTagBlock(trimmed: string): string | null {
  const opened = OPENS_TAG_RE.exec(trimmed);
  // 한 줄에서 여닫았으면 블록을 열지 않는다 — 그 줄 하나만 걷힌다
  return opened && !closesTag(trimmed, opened[1] ?? "") ? (opened[1] ?? "") : null;
}

/** 줄 전체가 꺾쇠 하나인가 — 열든 닫든 스스로 닫든, 장면에는 설 수 없다 */
function isTagLine(trimmed: string): boolean {
  return trimmed.startsWith("<") && (OPENS_TAG_RE.test(trimmed) || LONE_TAG_RE.test(trimmed));
}

/**
 * 장면에 설 수 있는 줄인가 — 꺾쇠 블록 밖이면서, 시점 헤더(**직전 것과 값이 다른 것**),
 * `@`로 시작하는 화자·내레이션, 빈 줄(문단 간격), 그리고 **장면이 선 뒤의 이어쓰기
 * 줄**(prompts.md §1). 중계(`scenes: false`)는 꺾쇠 규칙까지만 읽는다.
 *
 * ⚠️ 이어쓰기가 되는 것은 첫 `@` 줄 **뒤**부터다 — 그 앞의 태그 없는 줄은 도구
 * 앞에 흘린 작업 로그라, 살리면 "…확인하겠습니다"가 코치의 대사로 붙는다.
 * 헤더 꼴(`[`)은 이어쓰기보다 헤더 규칙이 앞선다.
 *
 * ⚠️ **뒤 헤더를 일괄로 걷지 않는다.** 도구 반복이 다시 찍는 헤더는 값이 같고, 한 턴
 * 안에서 오전 훈련 뒤 오후 면담을 여는 헤더는 값이 다르다 — 값 비교만이 소음과 전환을
 * 가른다. 일괄로 걷으면 그 전환이 화면에서 통째로 사라진다.
 */
export function keepsSceneLine(line: string, scan: SceneScan): boolean {
  const trimmed = line.trim();
  // 닫히지 않은 블록은 장면이 다시 서는 줄에서 끝난다 — 짝 없는 꺾쇠 하나가
  // 그 뒤의 장면을 통째로 삼키지 않게 (prompts.md §1)
  if (scan.block !== null && !opensScene(trimmed)) return false;
  if (isTagLine(trimmed)) return false;
  if (!scan.scenes) return true;
  if (trimmed.length === 0) return true;
  if (trimmed.startsWith("@")) return true;
  if (trimmed.startsWith("[")) return headerKey(trimmed) !== scan.lastHeader;
  return scan.sceneOpen;
}

/** 판정을 마친 줄이 다음 판정에 남기는 것 */
export function afterSceneLine(line: string, scan: SceneScan): void {
  const trimmed = line.trim();
  if (scan.block !== null) {
    if (opensScene(trimmed)) scan.block = null;
    else {
      if (closesTag(trimmed, scan.block)) scan.block = null;
      // 블록 안에서는 헤더도 이어쓰기도 나지 않는다
      return;
    }
  } else if (trimmed.startsWith("<")) {
    scan.block = opensTagBlock(trimmed);
    if (isTagLine(trimmed)) return;
  }
  if (trimmed.startsWith("[")) scan.lastHeader = headerKey(trimmed);
  if (trimmed.startsWith("@")) scan.sceneOpen = true;
}

/** 걷어낸 자리에 남은 빈 줄이 겹치지 않게 (문단 간격은 하나면 족하다) */
function joinScene(kept: readonly string[]): string {
  return kept
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function sieve(text: string, scenes: boolean): string {
  const lines = text.split("\n");
  const scan: SceneScan = {
    lastHeader: null,
    sceneOpen: false,
    block: null,
    // ⚠️ **`@` 줄이 하나도 없으면 장면 규칙은 걸지 않는다** — 규약을 통째로 어긴
    // 응답까지 지우면 빈 턴이 되어 무슨 일이 있었는지조차 사라진다. 꺾쇠 블록은
    // 그런 응답에서도 걷는다 — 그것은 장면 규약이 아니라 프롬프트 내부 구조다
    scenes: scenes && lines.some((line) => line.trim().startsWith("@")),
  };
  const kept: string[] = [];
  for (const line of lines) {
    const keeps = keepsSceneLine(line, scan);
    afterSceneLine(line, scan);
    if (keeps) kept.push(line);
  }
  return joinScene(kept);
}

/**
 * 장면 위생 — **도구 앞에 흘린 작업 서술과 값이 같은 반복 헤더를 걷어낸다.**
 *
 * 도구를 부르는 턴에서 모델은 반복마다 "…확인하겠습니다" 한 줄과 헤더를 새로
 * 찍는다(프롬프트로 몇 번을 눌러도 남는 습성이다). 그 줄들은 장면이 아니라
 * 작업 로그인데 화면에는 코치의 말과 나란히 선다. 걷는 것은 **장면이 서기 전**의
 * 태그 없는 줄까지다 — 그 뒤의 것은 이어쓰기라 살린다.
 *
 * **시각이 달라진 헤더는 남는다** — 그것은 소음이 아니라 장면 전환이고, 화면이
 * 그 자리에서 시각 표시로 세운다(`cutStamps`).
 */
export function sanitizeSceneText(text: string): string {
  return sieve(text, true);
}

/**
 * 중계 위생 — **꺾쇠 블록만 걷는다** (prompts.md §1).
 *
 * 평시 규칙을 그대로 갖다 붙일 수 없다: 턴마다 헤더를 새로 찍는 것이 중계에서는
 * 정상이고, 이어쓰기의 경계도 다르다. 남는 것은 두 국면이 함께 읽는 좁은 규칙
 * 하나 — 모델이 `<points>`를 되받아 써도 화면에도 저장에도 서지 않는다.
 */
export function sanitizeCasterText(text: string): string {
  return sieve(text, false);
}

export interface ParsedScene {
  /** 헤더를 걷어낸 본문 */
  body: string;
  /**
   * 읽어낸 원문 헤더 줄 — 없으면 null. ⚠️ 저장할 때 본문에 되붙여야 한다 —
   * 떼면 화면(scene-stamp)의 시각이 스트리밍이 끝나는 순간 사라진다.
   */
  header: string | null;
  point: ScenePoint | null;
  /** 경기 헤더의 목표 분 */
  minute: number | null;
}

/** 한 줄이 가리키는 시점 — 평시의 시점 헤더가 아니면 null (경기 분 헤더도 아니다) */
export function scenePointOf(line: string): ScenePoint | null {
  const scene = SCENE_HEADER_RE.exec(line.trim());
  if (!scene) return null;
  // 시각을 빼먹었으면 시간대의 기본 시각, 그것도 없으면 그 날의 시작
  return { date: scene[1] ?? "", clock: clockFromHeader(scene[2], scene[3], scene[4]) };
}

/** 첫 줄의 헤더를 떼어 시점을 읽는다. 헤더가 없으면 시간은 흐르지 않는다. */
export function parseSceneHeader(text: string): ParsedScene {
  const lines = text.split("\n");
  const firstIndex = lines.findIndex((line) => line.trim().length > 0);
  if (firstIndex < 0) return { body: text, header: null, point: null, minute: null };
  const first = (lines[firstIndex] ?? "").trim();

  const point = scenePointOf(first);
  if (point) {
    const rest = [...lines.slice(0, firstIndex), ...lines.slice(firstIndex + 1)];
    return { body: rest.join("\n").trim(), header: first, point, minute: null };
  }
  const match = MATCH_HEADER_RE.exec(first);
  if (match) {
    const rest = [...lines.slice(0, firstIndex), ...lines.slice(firstIndex + 1)];
    return { body: rest.join("\n").trim(), header: first, point: null, minute: Number(match[1]) };
  }
  return { body: text, header: null, point: null, minute: null };
}

/**
 * 이력이 끝나는 자리 — 뒤에서부터 **모델 턴이 나올 때까지가 이번 턴의 입력**이다.
 *
 * 한 턴은 채팅에 하나가 아니라 여럿을 남긴다(전술판 조작이 오퍼레이터 턴으로 먼저
 * 서고 감독 발화가 그 뒤에 선다). 저장이 성공한 채팅은 언제나 모델 턴으로 끝나므로
 * (실패한 턴은 저장되지 않는다) 꼬리의 비-모델 턴이 곧 이번 턴에 밀어 넣은 입력이고,
 * 그것들은 이번 호출의 발화 블록이 이미 싣는다.
 *
 * ⚠️ 한 줄만 빼면 두 자리에서 틀린다 — 조작이 이력과 발화 블록에 두 번 실리고,
 * 킥오프처럼 이번 턴 발화가 경기 이력으로 갈린 턴에서는 뺄 줄이 이 목록에 애초에
 * 없어 직전 평시 발화가 대신 잘려 나간다.
 */
export function historyEnd(chat: GameState["chat"]): number {
  for (let i = chat.length - 1; i >= 0; i -= 1) if (chat[i]?.role === "model") return i + 1;
  return 0;
}
