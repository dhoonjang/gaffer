import {
  type GameState,
  type ChatTurn,
  type Exhibit,
  isPeaceTurn,
  resolveExhibit,
  type ScenePoint,
  managedTeamId,
  clubHonoursLine,
  savedClubProfile,
  teamName,
} from "@gaffer/engine";
import {
  createMarkupLexer,
  closeVoice,
  exhibitTag,
  isExhibitTag,
  isSceneCommand,
  MATCH_EXHIBIT_TAGS,
  isVoiceTag,
  narration,
  openVoice,
  readSceneMarker,
  readSceneMarkup,
  sceneClock,
  sceneMarker,
  speak,
  SCENE_TAG,
  SPEAK_TAG,
  type MarkupToken,
  type SceneMarker,
  type VoiceTag,
} from "@gaffer/domain";

/**
 * 감독 — 이름은 속성, 배경은 본문. 세이브당 고정인 것만이다.
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
  return [`<manager name="${manager.name}">`, `배경: ${manager.background}`, `</manager>`].join(
    "\n",
  );
}

/**
 * 화면 조작 — 감독의 발화가 아니다. **모델의 출력 문법 밖 봉투로 싣는다**
 * (`<operator>시간 진행 — 하루</operator>`). `<narration>`은 GM이 지문을 쓰는 커맨드라 거기 담으면
 * 감독의 화면 조작이 모델 자신의 문법으로 이력에 서고, 인물이 그 손잡이를 아는
 * 것으로 읽힌다 (docs/agents/prompts.md §1).
 */
export function buildOperatorMessage(message: string): string {
  return `<operator>${message}</operator>`;
}

/** 해석기가 읽는 지난 턴 수 — 이름 없는 지목이 가리키는 대상은 직전 대화에 있다 */
const RECENT_TURNS = 5;

/**
 * 지난 턴 본문 하나를 다른 호출에 실을 때의 상한 — 해석기의 `<recent_turns>`·
 * `<match_log>`와 마감의 `<commentary>`가 같은 자를 쓴다. 읽는 쪽에 필요한 것은
 * 누가 무슨 말을 했고 흐름이 어땠는가지 장면 전부가 아니다.
 */
export const TURN_EXCERPT_CHARS = 1500;

/**
 * 턴 목록을 해석기가 읽는 줄로 — **평시의 `<recent_turns>`와 경기의 `<match_log>`가 같은
 * 함수를 쓴다.** 감독 턴은 감독의 발화 커맨드, 손잡이 턴은 오퍼레이터 봉투, 모델 턴은 본문을
 * 잘라서. 두 벌이면 한쪽만 고쳐져 두 해석기가 다른 말을 읽는다.
 */
function renderTurns(turns: readonly ChatTurn[]): string[] {
  return turns.map((t) => {
    if (t.role === "user") return speak("감독", t.text);
    if (t.role === "operator") return buildOperatorMessage(t.text);
    return t.text.slice(0, TURN_EXCERPT_CHARS);
  });
}

/**
 * **이번 턴에 밀어 넣은 꼬리를 뺀 지난 턴들** — 해석기의 `<recent_turns>`·`<match_log>`가
 * 읽는다. 턴 러너는 감독의 말을 모델 호출 전에 채팅에 넣으므로(`historyEnd`) 꼬리를
 * 그대로 실으면 같은 말이 이번 턴의 감독 발화와 두 벌이 된다 (agents.md §3).
 */
function pastTurns(turns: GameState["chat"]): GameState["chat"] {
  return turns.slice(0, historyEnd(turns));
}

/** `<recent_turns>`의 본문 — 평시의 지난 턴들. 이번 턴의 것은 감독 발화 블록이 싣는다 */
export function buildRecentTurnsBlock(state: GameState, count = RECENT_TURNS): string {
  const peace = pastTurns(state.chat.filter(isPeaceTurn));
  return renderTurns(peace.slice(-count)).join("\n");
}

/**
 * 장면 표식 → 시점. 날짜만 필수다 — 시각을 못 읽으면 그 때의 기본 시각, 그것도 없으면
 * 그 날의 시작이다. ⚠️ 시각·장소를 필수로 좁히면 표식 하나를 못 읽은 턴의 시계가 멎는다
 * (prompts.md §1). 경기의 분 표식은 시점이 아니다.
 */
export function scenePointOf(marker: SceneMarker): ScenePoint | null {
  const date = marker.date?.match(/^\d{4}-\d{2}-\d{2}/u)?.[0];
  if (!date) return null;
  return { date, clock: sceneClock(marker.time) ?? "09:00" };
}

/**
 * 한 턴에 서는 자료 카드의 상한 — 넘치면 채팅이 표 묶음이 되어 장면이 밀려난다
 * (prompts.md §1 「자료 카드」).
 */
export const EXHIBITS_PER_TURN = 3;

/** 위생의 갈래 — 경기는 모델의 표식을 걷고 코어가 장부의 분을 세운다 */
export interface SieveOptions {
  match?: boolean;
  /** 감독의 이름 — 그 이름의 발화는 모델턴에 서지 않는다 (prompts.md §1) */
  manager?: string;
  /** 장면 커맨드가 없는 응답을 지문으로 구제하는가 — 기본은 그렇다 */
  rescue?: boolean;
}

/** 위생 하나의 결과 — 걷은 글자는 구제(`sanitizeSceneText`)가 읽는다 */
interface SceneSieve {
  push(delta: string): string;
  end(): string;
  /** 목소리가 하나라도 섰는가 */
  voiced(): boolean;
  /** 커맨드 밖에 흘린 글자 — 꺾쇠 블록 안의 것은 없다 */
  stray(): string;
}

/**
 * **장면 위생의 체** — 장면 커맨드만 남기고 정본의 꼴로 다시 적는다 (prompts.md §1).
 *
 * 줄을 보지 않고 커맨드를 본다: 작업 로그(커맨드 밖의 글자), 되받아 쓴 입력 블록
 * (`<points>`·`<ledger>`), 값이 같은 반복 표식, 감독 이름의 발화가 걷힌다.
 * 저장(`sanitizeSceneText`)과 스트리밍(`filterSceneStream`)이 같은 체를 지난다 —
 * 둘이 갈리면 화면과 저장에 다른 장면이 선다.
 *
 * 정본의 꼴: 커맨드마다 새 줄에서 열고, 여는 태그 바로 뒤에 첫 줄이, 닫는 태그 바로
 * 앞에 끝 줄이 붙는다. 그래서 본문의 빈 줄 아닌 줄 수가 곧 화면의 줄 수다.
 */
export function createSceneSieve(options: SieveOptions = {}): SceneSieve {
  const lexer = createMarkupLexer();
  let mode:
    | { kind: "outside" }
    | { kind: "voice"; tag: VoiceTag; name: string; started: boolean; gap: string }
    | { kind: "drop"; name: string } = { kind: "outside" };
  let lastMarker: string | null = null;
  /** 이번 응답에 이미 선 카드의 정본 — 같은 카드는 한 번이다 */
  const exhibits = new Set<string>();
  let wrote = false;
  let voiced = false;
  let stray = "";

  const take = (tokens: readonly MarkupToken[]): string => {
    let out = "";
    const element = (open: string) => {
      out += `${wrote ? "\n" : ""}${open}`;
      wrote = true;
    };
    const endVoice = () => {
      if (mode.kind === "voice" && mode.started) out += closeVoice(mode.tag);
      mode = { kind: "outside" };
    };
    const outside = (token: MarkupToken) => {
      if (token.kind === "text") {
        stray += token.text;
        return;
      }
      if (token.kind === "close") return;
      if (token.name === SCENE_TAG) {
        if (options.match) return;
        const marker = sceneMarker(readSceneMarker(token.attrs));
        // 값이 같은 반복 표식은 도구 반복이 다시 찍은 소음이다 — 시각이 바뀐 것만 전환이다
        if (marker !== lastMarker) element(marker);
        lastMarker = marker;
        return;
      }
      if (isExhibitTag(token.name)) {
        // 카드는 스스로 닫는다 — 여닫는 꼴로 오면 본문(모델이 쓴 수치)을 버린다
        if (token.kind === "open") mode = { kind: "drop", name: token.name };
        const card = exhibitTag(token.name, token.attrs);
        // 경기 장면에는 선수 카드만 선다 — 재정·협상은 경기의 흐름과 무관하다
        if (options.match && !MATCH_EXHIBIT_TAGS.includes(token.name)) return;
        if (exhibits.has(card) || exhibits.size >= EXHIBITS_PER_TURN) return;
        exhibits.add(card);
        element(card);
        return;
      }
      if (token.kind === "empty") return;
      if (isVoiceTag(token.name)) {
        const name = (token.attrs.name ?? "").trim();
        if (token.name === SPEAK_TAG && options.manager && name === options.manager.trim()) {
          mode = { kind: "drop", name: token.name };
          return;
        }
        mode = { kind: "voice", tag: token.name, name, started: false, gap: "" };
        return;
      }
      mode = { kind: "drop", name: token.name };
    };
    for (const token of tokens) {
      if (mode.kind === "voice") {
        if (token.kind === "text") {
          // 앞뒤 공백은 정본에서 빠진다
          const lead = mode.started ? token.text : token.text.trimStart();
          // 안의 빈 줄은 줄바꿈 하나로 접는다 — 화면은 빈 줄을 세우지 않는다
          const body = lead.trimEnd().replace(/\n\s*\n/gu, "\n");
          const tail = lead.slice(body.length);
          if (body.length > 0) {
            if (!mode.started) {
              element(openVoice(mode.tag, mode.name));
              mode.started = true;
              voiced = true;
            }
            out += (mode.gap.includes("\n") ? "\n" : mode.gap) + body;
            mode.gap = "";
          }
          mode.gap += tail;
          continue;
        }
        if (token.kind === "close" && token.name === mode.tag) {
          endVoice();
          continue;
        }
        // 목소리 안에 카드가 섰다 — 대사를 거기서 끊고 카드 뒤에 같은 화자로 다시 연다
        if (token.kind === "empty" && isExhibitTag(token.name)) {
          const { tag, name } = mode;
          endVoice();
          outside(token);
          mode = { kind: "voice", tag, name, started: false, gap: "" };
          continue;
        }
        // 목소리 안에서 다른 태그가 열렸다 — 닫는 태그를 잊은 발화가 그 뒤를 삼키지 않게
        endVoice();
        outside(token);
        continue;
      }
      if (mode.kind === "drop") {
        if (token.kind === "close" && token.name === mode.name) {
          mode = { kind: "outside" };
          continue;
        }
        // 닫히지 않은 블록은 장면 커맨드가 다시 열리는 자리에서 끝난다
        if ((token.kind === "open" || token.kind === "empty") && isSceneCommand(token.name)) {
          mode = { kind: "outside" };
          outside(token);
        }
        continue;
      }
      outside(token);
    }
    return out;
  };

  return {
    push: (delta) => take(lexer.push(delta)),
    end: () => {
      let out = take(lexer.end());
      // 잘린 응답도 거기까지는 장면이다 — 열린 목소리를 닫아 준다
      if (mode.kind === "voice" && mode.started) out += closeVoice(mode.tag);
      mode = { kind: "outside" };
      return out;
    },
    voiced: () => voiced,
    stray: () => stray,
  };
}

/**
 * 장면 위생 — 저장할 본문. 체를 한 번 지나고, **장면 커맨드가 하나도 없는 응답**은 커맨드
 * 밖의 글자를 내레이션 하나로 감싸 남긴다: 규약을 통째로 어긴 응답까지 지우면 빈 턴이
 * 되어 무슨 일이 있었는지조차 사라진다 (prompts.md §1).
 */
export function sanitizeSceneText(text: string, options: SieveOptions = {}): string {
  const sieve = createSceneSieve(options);
  const kept = sieve.push(text) + sieve.end();
  if (sieve.voiced() || options.rescue === false) return kept;
  const stray = sieve
    .stray()
    .replace(/\n{2,}/gu, "\n")
    .trim();
  if (stray.length === 0) return kept;
  return [kept, narration(stray)].filter((part) => part.length > 0).join("\n");
}

/**
 * **자료 카드를 장부로 푼다** — 위생을 지난 평시 본문의 카드 줄마다 코어가 값을 채우고
 * (`resolveExhibit`), 참조를 이름으로 편 정본으로 다시 적는다 (prompts.md §1 「자료 카드」).
 *
 * 값은 본문과 **순서로** 짝짓는다 — n번째 카드 줄이 `exhibits[n]`이다. 풀리지 않는 카드와
 * 이름으로 편 뒤 겹친 카드는 줄째로 걷고, 걷은 줄의 자리(본문 안 빈 줄 아닌 줄의 1-기준
 * 번호)를 돌려준다 — 호출 칩의 줄 수(`ToolCallRecord.line`)를 그만큼 당겨야 한다.
 */
export function fileExhibits(
  state: GameState,
  body: string,
): { body: string; exhibits: Exhibit[]; dropped: number[] } {
  const exhibits: Exhibit[] = [];
  const dropped: number[] = [];
  const seen = new Set<string>();
  const kept: string[] = [];
  let written = 0;
  for (const line of body.split("\n")) {
    if (line.trim().length === 0) {
      kept.push(line);
      continue;
    }
    written += 1;
    const item = readSceneMarkup(line)[0];
    if (item?.kind !== "exhibit") {
      kept.push(line);
      continue;
    }
    const resolved = resolveExhibit(state, item.tag, item.attrs);
    const canonical = resolved ? exhibitTag(item.tag, resolved.attrs) : null;
    if (!resolved || canonical === null || seen.has(canonical)) {
      dropped.push(written);
      continue;
    }
    seen.add(canonical);
    exhibits.push(resolved.exhibit);
    kept.push(canonical);
  }
  return { body: kept.join("\n"), exhibits, dropped };
}

/** 중계 위생 — 같은 체다. 모델의 표식은 걷히고 장부의 분은 `stampMatchScene`이 세운다 */
export function sanitizeCasterText(text: string): string {
  return sanitizeSceneText(text, { match: true });
}

interface ParsedScene {
  /** 여는 표식을 뗀 본문 */
  body: string;
  /**
   * 여는 표식(정본) — 없으면 null. ⚠️ 저장할 때 본문에 되붙여야 한다 —
   * 떼면 화면(scene-stamp)의 시각이 스트리밍이 끝나는 순간 사라진다.
   */
  header: string | null;
  point: ScenePoint | null;
  /** 경기 표식의 분 */
  minute: number | null;
}

const LEADING_SCENE_RE = /^\s*(<scene\b[^<>]*>)/u;

/** 본문을 여는 장면 표식을 떼어 시점을 읽는다. 표식이 없으면 시간은 흐르지 않는다. */
export function parseSceneHeader(text: string): ParsedScene {
  const lead = LEADING_SCENE_RE.exec(text);
  const item = lead ? readSceneMarkup(lead[1] ?? "")[0] : undefined;
  if (!lead || item?.kind !== "scene")
    return { body: text, header: null, point: null, minute: null };
  return {
    body: text.slice(lead[0].length).trim(),
    header: sceneMarker(item.marker),
    point: scenePointOf(item.marker),
    minute: item.marker.minute ?? null,
  };
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

/**
 * 맡은 구단 — 이름은 여는 태그의 속성이다 (`<character name>`과 같은 표기, prompts.md §5).
 * 커리어가 끝났으면 서지 않는다 (career.md §5). 그 사이엔 바이트가 같다.
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
 * 두 에이전트(평시 GM · 중계)가 같은 두 블록을 읽는다.
 *
 * ⚠️ **인물 카드는 여기 없다.** 코치·구단주·기자 다섯 장은 회견이 없는 턴에
 * 한 번도 쓰이지 않는데 매 턴 읽혔다. 그렇다고 조건부로 넣었다 뺐다 하면 더 나쁘다 —
 * 프리픽스가 바뀌는 턴마다 이 블록과 그 뒤 이력이 통째로 무효가 된다. 카드는 인물 사전이
 * 골라 **이번 턴 층**에 싣고 다음 턴부터 이력의 일부가 된다 (people.md §6).
 * ⚠️ 선수의 이름도 id도 여기 두지 않는다 — 명단은 계약 만료·유스 승격·주장 변경마다
 * 바뀌고, 한 줄이 달라지면 이 블록과 그 뒤의 이력이 통째로 무효가 된다. 이름은 매 턴
 * 층(`buildGmStateNote`)의 「선수단」 줄이 싣는다.
 */
export function buildGmReference(state: GameState): string {
  return [describeClub(state), describeManager(state.manager)]
    .filter((block): block is string => block !== null)
    .join("\n\n");
}
