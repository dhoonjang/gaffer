import { BROADCAST_SPEAKER } from "../people/persona";

/**
 * ── 장면 커맨드 — 모델턴의 출력 문법 ──────────────────────────────────────
 *
 * 모델턴은 커맨드로만 이루어진다 (docs/agents/prompts.md §1):
 * `<scene date time place />` · `<speak name>` · `<narration>` · `<commentary>` · 자료 카드.
 * 코어의 위생(`packages/agents` — `createSceneSieve`)과 화면의 파서가 **같은 어휘기와
 * 같은 이름**을 읽는다 — 두 벌이면 한쪽만 고쳐져 저장된 장면과 화면이 갈린다.
 *
 * 화면과 코어가 함께 쓰므로 도메인에 산다 (AGENTS.md §5).
 */

export const SCENE_TAG = "scene";
export const SPEAK_TAG = "speak";
export const NARRATION_TAG = "narration";
export const COMMENTARY_TAG = "commentary";

/** 목소리 — 장면 표식을 뺀 장면 커맨드 */
export const VOICE_TAGS = [SPEAK_TAG, NARRATION_TAG, COMMENTARY_TAG] as const;
export type VoiceTag = (typeof VOICE_TAGS)[number];

export function isVoiceTag(name: string): name is VoiceTag {
  return (VOICE_TAGS as readonly string[]).includes(name);
}

/**
 * 자료 카드 — 스스로 닫는 참조 태그 (prompts.md §1 「자료 카드」).
 *
 * 속성은 참조(이름·달)뿐이고 수치는 코어가 장부에서 채운다. 태그마다 **받는 속성의
 * 목록**이 정본의 꼴을 정한다 — 그 밖의 속성은 위생이 버린다.
 */
export const EXHIBIT_ATTRS = {
  player_card: ["players", "type"],
  negotiation_card: ["player"],
  finance_card: ["month"],
} as const;
export type ExhibitTag = keyof typeof EXHIBIT_ATTRS;

/**
 * 선수 카드의 갈래 — 인물이 말하는 주제에 맞는 칸만 선다 (prompts.md §1 「자료 카드」).
 * 첫 것이 기본이다. 부상 이력을 말하는 자리에 주급 표가 서면 장면과 어긋난다.
 */
export const PLAYER_CARD_TYPES = ["overview", "fitness", "stats", "contract", "ability"] as const;
export type PlayerCardType = (typeof PLAYER_CARD_TYPES)[number];

/** 속성값 → 갈래. 모르는 값은 기본 갈래다 */
export function playerCardType(value: string | undefined): PlayerCardType {
  const v = value?.trim();
  return (PLAYER_CARD_TYPES as readonly string[]).includes(v ?? "")
    ? (v as PlayerCardType)
    : "overview";
}
export const EXHIBIT_TAGS = Object.keys(EXHIBIT_ATTRS) as ExhibitTag[];

/** 경기 장면에도 서는 카드 — 교체 후보를 견주는 선수 카드뿐이다 (prompts.md §1) */
export const MATCH_EXHIBIT_TAGS: readonly ExhibitTag[] = ["player_card"];

export function isExhibitTag(name: string): name is ExhibitTag {
  return (EXHIBIT_TAGS as readonly string[]).includes(name);
}

/** 장면 커맨드인가 — 위생이 남기는 것은 표식·목소리·자료 카드뿐이다 */
export function isSceneCommand(name: string): boolean {
  return name === SCENE_TAG || isVoiceTag(name) || isExhibitTag(name);
}

// ── 어휘기 ──────────────────────────────────────────────────────────────

export type MarkupToken =
  | { kind: "text"; text: string }
  | { kind: "open"; name: string; attrs: Record<string, string> }
  | { kind: "close"; name: string }
  /** 스스로 닫은 태그 — `<scene … />` */
  | { kind: "empty"; name: string; attrs: Record<string, string> };

/**
 * 태그 하나의 꼴 — 이름은 **글자로 열린다**(`\p{L}`). 숫자나 공백으로 여는 꺾쇠는 태그가
 * 아니라 부등호다(`3 < 4`). 모델이 지어내는 태그는 한글일 수 있다(`<생각>`).
 */
const TAG_RE = /^<(\/?)([\p{L}_][\p{L}\p{N}_-]*)((?:\s[^<>]*?)?)\s*(\/?)>$/u;
const ATTR_RE = /([\p{L}_][\p{L}\p{N}_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu;
/** 꺾쇠 뒤가 태그 이름으로 이어질 수 있는가 — 아니면 그 꺾쇠는 글자다 */
const TAG_START_RE = /^<\/?[\p{L}_]/u;
/**
 * 닫는 `>`를 기다리는 상한 — 넘으면 그 꺾쇠는 글자다. 짝 없는 꺾쇠 하나가 스트리밍을
 * **끝을 모른 채** 붙들지 않게 한다. 장소와 이름을 실은 표식도 이 안에 든다.
 */
const MAX_TAG_CHARS = 400;

function unescapeAttr(value: string): string {
  return value.replace(/&quot;/gu, '"').replace(/&amp;/gu, "&");
}

function escapeAttr(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;");
}

function readAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of raw.matchAll(ATTR_RE)) {
    const name = match[1];
    if (name) attrs[name] = unescapeAttr(match[2] ?? match[3] ?? "");
  }
  return attrs;
}

/**
 * 조각으로 오는 글을 토큰으로 — **스트리밍과 통짜 글이 같은 함수를 지난다.**
 *
 * 글자는 도착하는 대로 내보내고, 태그는 닫는 `>`까지만 미룬다. 응답이 끝날 때 닫히지
 * 않은 꺾쇠는 글자로 돌려준다(`end`) — 잘린 응답의 마지막 조각이 사라지지 않게.
 */
export function createMarkupLexer(): {
  push(chunk: string): MarkupToken[];
  end(): MarkupToken[];
} {
  let buffer = "";
  const drain = (final: boolean): MarkupToken[] => {
    const tokens: MarkupToken[] = [];
    const text = (value: string) => {
      if (value.length === 0) return;
      const last = tokens[tokens.length - 1];
      if (last?.kind === "text") last.text += value;
      else tokens.push({ kind: "text", text: value });
    };
    for (;;) {
      const lt = buffer.indexOf("<");
      if (lt < 0) {
        text(buffer);
        buffer = "";
        break;
      }
      text(buffer.slice(0, lt));
      buffer = buffer.slice(lt);
      // 꺾쇠 뒤의 첫 글자들이 아직 안 왔다 — 태그인지 부등호인지 갈리지 않는다
      if (!final && buffer.length < 3 && /^<\/?$/u.test(buffer)) break;
      if (!TAG_START_RE.test(buffer)) {
        text("<");
        buffer = buffer.slice(1);
        continue;
      }
      const gt = buffer.indexOf(">");
      const next = buffer.indexOf("<", 1);
      // 닫는 `>`보다 다음 꺾쇠가 먼저 오면 이 꺾쇠는 태그가 아니다
      if (gt < 0 || (next >= 0 && next < gt)) {
        // 아직 아무것도 어긋나지 않았다 — `>`를 기다린다
        if (gt < 0 && next < 0 && !final && buffer.length < MAX_TAG_CHARS) break;
        text("<");
        buffer = buffer.slice(1);
        continue;
      }
      const raw = buffer.slice(0, gt + 1);
      const tag = TAG_RE.exec(raw);
      buffer = buffer.slice(gt + 1);
      if (!tag) {
        text(raw);
        continue;
      }
      const [, slash, name = "", attrs = "", selfClose] = tag;
      if (slash) tokens.push({ kind: "close", name });
      else if (selfClose) tokens.push({ kind: "empty", name, attrs: readAttrs(attrs) });
      else tokens.push({ kind: "open", name, attrs: readAttrs(attrs) });
    }
    return tokens;
  };
  return {
    push(chunk) {
      buffer += chunk;
      return drain(false);
    },
    end() {
      return drain(true);
    },
  };
}

// ── 쓰기 — 정본의 꼴 ───────────────────────────────────────────────────

/** 장면 표식의 값 — 평시는 날짜·시각·장소, 경기는 장부의 분 */
export interface SceneMarker {
  date?: string;
  time?: string;
  place?: string;
  minute?: number;
}

/** `<scene … />` — 속성 순서가 정본이다(값 비교가 글자 비교로 족하게) */
export function sceneMarker(marker: SceneMarker): string {
  const attrs = [
    ...(marker.minute !== undefined ? [`minute="${marker.minute}"`] : []),
    ...(marker.date ? [`date="${escapeAttr(marker.date)}"`] : []),
    ...(marker.time ? [`time="${escapeAttr(marker.time)}"`] : []),
    ...(marker.place ? [`place="${escapeAttr(marker.place)}"`] : []),
  ];
  return `<${SCENE_TAG} ${attrs.join(" ")} />`;
}

/** 속성 → 표식 값. 숫자가 아닌 분은 없는 것이다 */
export function readSceneMarker(attrs: Record<string, string>): SceneMarker {
  const minute = attrs.minute === undefined ? NaN : Number.parseInt(attrs.minute, 10);
  const pick = (value: string | undefined) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  };
  const date = pick(attrs.date);
  const time = pick(attrs.time);
  const place = pick(attrs.place);
  return {
    ...(Number.isFinite(minute) ? { minute } : {}),
    ...(date ? { date } : {}),
    ...(time ? { time } : {}),
    ...(place ? { place } : {}),
  };
}

/** 여는 태그 — 발화만 이름을 갖는다 */
export function openVoice(tag: VoiceTag, name?: string): string {
  return tag === SPEAK_TAG ? `<${tag} name="${escapeAttr(name ?? "")}">` : `<${tag}>`;
}

export function closeVoice(tag: VoiceTag): string {
  return `</${tag}>`;
}

export function speak(name: string, text: string): string {
  return `${openVoice(SPEAK_TAG, name)}${text}${closeVoice(SPEAK_TAG)}`;
}

export function narration(text: string): string {
  return `${openVoice(NARRATION_TAG)}${text}${closeVoice(NARRATION_TAG)}`;
}

export function commentary(text: string): string {
  return `${openVoice(COMMENTARY_TAG)}${text}${closeVoice(COMMENTARY_TAG)}`;
}

/** 자료 카드의 정본 — 받는 속성만, 정해진 순서로. 빈 값은 싣지 않는다 */
export function exhibitTag(tag: ExhibitTag, attrs: Record<string, string>): string {
  const kept = EXHIBIT_ATTRS[tag]
    .map((name) => [name, attrs[name]?.trim() ?? ""] as const)
    .filter(([, value]) => value.length > 0)
    .map(([name, value]) => ` ${name}="${escapeAttr(value)}"`);
  return `<${tag}${kept.join("")} />`;
}

// ── 읽기 — 위생을 지난 본문 ─────────────────────────────────────────────

export type SceneItem =
  | { kind: "scene"; marker: SceneMarker }
  /** 자료 카드 — 값은 본문이 아니라 턴에 저장된다(`ChatTurn.exhibits`), 순서로 짝짓는다 */
  | { kind: "exhibit"; tag: ExhibitTag; attrs: Record<string, string> }
  | {
      kind: "voice";
      tag: VoiceTag;
      /** 발화의 이름 · 중계는 `BROADCAST_SPEAKER` · 지문은 `""` */
      speaker: string;
      text: string;
      /** 닫는 태그가 아직 안 왔다 — 스트리밍 중이거나 잘린 응답이다 */
      open: boolean;
    };

function speakerOf(tag: VoiceTag, attrs: Record<string, string>): string {
  if (tag === COMMENTARY_TAG) return BROADCAST_SPEAKER;
  if (tag === NARRATION_TAG) return "";
  return (attrs.name ?? "").trim();
}

/**
 * 본문을 장면 항목으로 — 화면과 코어가 저장된 장면을 읽는 자리다.
 *
 * 규칙은 위생과 같다: 목소리 안에서 다른 태그가 열리면 그 목소리는 거기서 닫히고,
 * 커맨드 밖의 글자는 장면이 아니다. 닫히지 않은 채 끝난 목소리는 `open`으로 선다 —
 * 스트리밍 화면은 그것을 지금까지 온 만큼 그린다. 끝에 걸린 미완성 태그(`<spe`)는
 * 다음 조각을 기다리는 것이라 버린다.
 */
export function readSceneMarkup(text: string): SceneItem[] {
  const lexer = createMarkupLexer();
  const tokens = lexer.push(text);
  const items: SceneItem[] = [];
  let voice: Extract<SceneItem, { kind: "voice" }> | null = null;
  const closeCurrent = () => {
    if (voice) voice.open = false;
    voice = null;
  };
  for (const token of tokens) {
    if (voice) {
      if (token.kind === "text") {
        voice.text += token.text;
        continue;
      }
      if (token.kind === "close" && token.name === voice.tag) {
        closeCurrent();
        continue;
      }
      closeCurrent();
    }
    if (token.kind === "text" || token.kind === "close") continue;
    if (token.name === SCENE_TAG) {
      items.push({ kind: "scene", marker: readSceneMarker(token.attrs) });
      continue;
    }
    if (isExhibitTag(token.name)) {
      items.push({ kind: "exhibit", tag: token.name, attrs: token.attrs });
      continue;
    }
    if (token.kind === "open" && isVoiceTag(token.name)) {
      voice = {
        kind: "voice",
        tag: token.name,
        speaker: speakerOf(token.name, token.attrs),
        text: "",
        open: true,
      };
      items.push(voice);
    }
  }
  return items.map((item) => (item.kind === "voice" ? { ...item, text: item.text.trim() } : item));
}

/** 장면에 목소리가 하나라도 섰는가 — 표식만 있는 본문은 장면이 아니다 */
export function hasVoice(text: string): boolean {
  return readSceneMarkup(text).some((item) => item.kind === "voice" && item.text.length > 0);
}

// ── 시각 ───────────────────────────────────────────────────────────────

/** 시간대 낱말만 적힌 시각의 기본값 — 하루 안에서 되감기지 않을 만큼만 민다 */
const PART_OF_DAY_CLOCK: Record<string, string> = {
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

const TIME_RE = /^(AM|PM|오전|오후|아침|점심|저녁|밤|새벽)?\s*(?:(\d{1,2}):(\d{2}))?$/iu;

/**
 * 표식의 `time` → "HH:MM" (24시간). 읽을 수 없으면 null.
 *
 * ⚠️ **시간대가 붙었는지가 12시간제인지를 가른다.** 문법은 24시간 `HH:MM`이지만 모델이
 * `AM 9:30`·`오후 2:00`을 적기도 한다. 시간대 없는 `14:30`까지 12로 접으면 `02:30`이
 * 되어 시각이 오전으로 뒤집히고, 코어가 되감기를 막으므로 그 턴의 시계가 통째로
 * 멎는다 — `오전 12:05`는 자정 00:05, 시간대 없는 `12:05`는 정오 12:05.
 * 시간대 낱말만 있으면(`오후`) 그 때의 기본 시각이다.
 */
export function sceneClock(time: string | undefined): string | null {
  const match = TIME_RE.exec((time ?? "").trim());
  if (!match) return null;
  const [, meridiem, hour, minute] = match;
  if (hour === undefined || minute === undefined) {
    return meridiem ? (PART_OF_DAY_CLOCK[meridiem.toLowerCase()] ?? null) : null;
  }
  const h = Number(hour);
  if (h > 23 || Number(minute) > 59) return null;
  const h24 = meridiem ? (h % 12) + (/^(PM|오후|저녁|밤)$/iu.test(meridiem) ? 12 : 0) : h;
  return `${String(h24).padStart(2, "0")}:${minute}`;
}
