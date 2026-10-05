import {
  SUGGESTION_MAX_CHARS,
  TIME_PASSED,
  applyInstructionBatch,
  buildOnboardingTurn,
  runGmTurn,
  takeSuggestion,
} from "@story-fm/agents";
import { STOP_EVENT_TYPES } from "@story-fm/domain";
import {
  advanceLiveMatch,
  advanceShootout,
  advanceTime,
  awaitingShootout,
  createGame,
  liveFinished,
  resumeLiveInterval,
  tacticsOf,
  turnFactLines,
  type GameState,
} from "@story-fm/engine";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * **mock 모드가 실 경로를 지나는가** (docs/agents/agents.md §8).
 *
 * 재는 것은 대본의 문장이 아니라 **기록**이다: 표의 한 줄이 `gm-tools.ts`의 핸들러를
 * 지나 코어 명령의 이름으로 `recordCall`을 남기면, 화면의 칩·말풍선이 실모드와 같은
 * 것을 받는다. 그 이름이 갈리면 e2e가 실모드에 없는 동작을 통과시킨다 (#397).
 *
 * 대본이 감독의 말을 알아듣는지는 재지 않는다 — 표의 키와 글자까지 같을 때만 걸리는
 * 것이 계약이고, 그 계약 자체가 이 파일의 전제다.
 */
process.env.LLM_MODE = "mock";

function build(seed: number): GameState {
  const background = "프리미어리그에서 뛰었던 주장 출신 수비수";
  return createGame({
    seed,
    userTeamId: "arsenal",
    managerName: "김감독",
    background,
  });
}

/**
 * 시드 42의 세계를 **한 번만** 세우고 케이스마다 복제한다 — `createGame`은 판당
 * 수 초, 복제는 그 수십 분의 일이다.
 */
let BASE: GameState;
beforeAll(() => {
  BASE = build(42);
});
const newGame = (): GameState => structuredClone(BASE);

/**
 * 모델 턴 문법 — **첫 줄은 장면의 시점**이고 나머지 텍스트 줄은 `@`로 시작한다
 * (overview §2.1). 시점 줄이 시계를 움직이므로 문법의 일부다.
 */
function expectGmGrammar(text: string) {
  const lines = text.split("\n");
  const first = lines.find((line) => line.trim().length > 0)?.trim() ?? "";
  expect(/^\[[^\]]+\]$/u.test(first), `첫 줄이 시점이 아니다: "${first}"`).toBe(true);
  for (const line of lines.slice(lines.indexOf(first) + 1)) {
    if (line.trim().length === 0) continue;
    expect(line.startsWith("@"), `문법 위반 줄: "${line}"`).toBe(true);
  }
}

const namesOf = (turn: { toolCalls: ReadonlyArray<{ name: string }> }): string[] =>
  turn.toolCalls.map((call) => call.name);

describe("mock 대본 — 부임 첫 장면", () => {
  it("@문법으로 배경·스쿼드·다음 일정을 브리핑한다", () => {
    const turn = buildOnboardingTurn(newGame());
    expectGmGrammar(turn.text);
    expect(turn.text).toContain("김감독");
  });
});

describe("mock 대본 — 표의 한 줄이 코어 명령까지 닿는다", () => {
  it("훈련 지시가 해석기를 지나 set_training으로 남는다", async () => {
    const state = newGame();
    const turn = await runGmTurn(state, "월요일 오전은 세트피스 반복 훈련 잡아줘");
    expectGmGrammar(turn.text);
    const call = turn.toolCalls.find((c) => c.name === "set_training");
    expect(call, "set_training 기록이 없다").toBeDefined();
    /**
     * 기록은 **실모드의 것과 같아야 한다** — 항목 요약(`brief`)을 안 실으면 말풍선이
     * 조용히 옛 문자열로 폴백해, 요약을 고쳐도 mock으로 플레이하는 동안에는 아무것도
     * 달라지지 않는다.
     */
    expect(call?.brief?.items.length).toBeGreaterThan(0);
    // 월요일 오전 훈련이 일정 엔트리로 등록됐다 (v6 — 규칙 테이블 없음).
    // 기본 훈련(training-plan)과 섞이므로 감독이 지시한 세션만 본다
    const ordered = new Set(
      state.trainingSessions
        .filter((s) => s.label.includes("세트피스") && !s.auto)
        .map((s) => s.id),
    );
    const entries = state.schedule.filter((e) => e.type === "training" && ordered.has(e.refId));
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(new Date(`${e.date}T00:00:00Z`).getUTCDay()).toBe(1); // 월요일
      expect(e.time).toBe("10:00"); // 오전
    }
  });

  it("포메이션 이름은 프리셋을 적용하지 않고 전술 축만 반영한다", async () => {
    const state = newGame();
    const before = tacticsOf(state, state.userTeamId).spec.formation;
    const turn = await runGmTurn(state, "4-4-2로 바꾸고 공격적으로 가자");
    expect(namesOf(turn)).toContain("set_tactics");
    expect(tacticsOf(state, state.userTeamId).spec.formation).toBe(before);
    expect(tacticsOf(state, state.userTeamId).spec.mentality).toBe(4);
  });

  it("표에 없는 말은 아무 도구도 부르지 않고 장면만 낸다", async () => {
    const state = newGame();
    const turn = await runGmTurn(state, "음...");
    expectGmGrammar(turn.text);
    expect(turn.toolCalls).toHaveLength(0);
  });

  /**
   * 시계는 **시점 헤더가** 민다 — 실모드와 같은 입구다. 시계 이동은 감독이 부른 도구가
   * 아니라 코어의 처리 결과라 사람이 읽는 이름으로 남는다.
   */
  it("넘기는 말은 시점 헤더로 시계를 밀고 코어의 기록을 남긴다", async () => {
    const state = newGame();
    const from = state.date;
    const turn = await runGmTurn(state, "하루 넘기자");
    expectGmGrammar(turn.text);
    expect(namesOf(turn)).toContain(TIME_PASSED);
    expect(state.date).not.toBe(from);
  });

  /**
   * 감독의 다음 말은 **턴 결과에만** 실린다 (agents.md §2) — 본문에 남으면 화면에 태그가
   * 서고 다음 턴 이력이 그 문장을 감독의 말처럼 읽는다. 기록에도 없어야 압축 브리프의
   * `[장부]` 줄이 그것을 싣지 않는다.
   */
  it("매 턴 감독의 다음 말 하나가 제안으로 실리고, 본문과 기록에는 남지 않는다", async () => {
    const state = newGame();
    const turn = await runGmTurn(state, "음...");
    expect(turn.suggestion).toBe("하루 넘기자");
    expect(turn.text).not.toContain("suggest_reply");
    expect(turn.toolCalls).toHaveLength(0);
    expect(turnFactLines({ toolCalls: turn.toolCalls })).toEqual([]);
    // 경기일에는 킥오프를 여는 말이다
    for (let guard = 0; guard < 40 && state.phase !== "matchday"; guard += 1) {
      advanceTime(state, "next_match");
    }
    const matchday = await runGmTurn(state, "음...");
    expect(matchday.suggestion).toBe("경기 시작하자");
  });
});

/**
 * 마지막 줄의 태그는 **코어가 읽는 자유 텍스트**다 (prompts.md §1) — 시점 헤더와 같은 급이라
 * 경계가 조용히 어긋난다: 값을 못 꺼내면 placeholder만 비지만, 본문에서 못 지우면 태그가
 * 화면과 다음 턴의 이력에 선다.
 */
describe("다음 말 제안 — 마지막 줄의 태그에서 꺼낸다", () => {
  const SCENE = ["[2026-07-01 AM 9:45 · 감독실]", "@코치: 첫 주는 체력입니다."].join("\n");

  it("태그의 값을 꺼내고 본문에서는 지운다 — 감싼 따옴표와 안쪽 줄바꿈은 걷는다", () => {
    const taken = takeSuggestion(`${SCENE}\n<suggest_reply>“훈련\n잡아줘”</suggest_reply>`);
    expect(taken).toEqual({ text: SCENE, suggestion: "훈련 잡아줘" });
    // 줄 한복판의 태그도 지운다 — 위생은 줄 앞머리의 꺾쇠만 본다
    const inline = takeSuggestion(`@코치: 갑시다. <suggest_reply>가자</suggest_reply>`);
    expect(inline).toEqual({ text: "@코치: 갑시다. ", suggestion: "가자" });
  });

  it("태그가 없으면 본문 그대로, 값이 없거나 상한을 넘으면 제안 없이 태그만 지운다", () => {
    expect(takeSuggestion(SCENE)).toEqual({ text: SCENE });
    expect(takeSuggestion(`${SCENE}\n<suggest_reply>  </suggest_reply>`)).toEqual({ text: SCENE });
    const long = "가".repeat(SUGGESTION_MAX_CHARS + 1);
    expect(takeSuggestion(`${SCENE}\n<suggest_reply>${long}</suggest_reply>`)).toEqual({
      text: SCENE,
    });
    const fits = "가".repeat(SUGGESTION_MAX_CHARS);
    expect(takeSuggestion(`${SCENE}\n<suggest_reply>${fits}</suggest_reply>`).suggestion).toBe(
      fits,
    );
  });

  it("닫히지 않은 태그는 잘린 응답이다 — 꼬리를 지우고 제안은 없다", () => {
    expect(takeSuggestion(`${SCENE}\n<suggest_reply>하루 넘기`)).toEqual({ text: SCENE });
  });
});

describe("mock 대본 — 경기", () => {
  /**
   * 킥오프는 세 걸음이다 — 도구가 문을 열고(`start_match`), 감독이 들어서고(첫 휘슬),
   * 그다음 실행기가 시계를 밀며 정지점마다 중계 턴을 연다. 경기일까지는 코어로 걷는다: 브라우저도 감독도
   * 없는 자리에서 턴을 서른 번 도는 것은 이 케이스가 재려는 것이 아니다.
   */
  it("킥오프에서 종료까지 완주하고, 정지점마다 중계가 선다", async () => {
    const state = build(7);
    for (let guard = 0; guard < 40 && state.phase !== "matchday"; guard += 1) {
      advanceTime(state, "next_match");
    }
    expect(state.phase).toBe("matchday");

    const opened = await runGmTurn(state, "경기 시작하자");
    expect(namesOf(opened)).toContain("start_match");
    expect(state.pendingMatch?.entered).not.toBe(true);

    // 입장 턴은 첫 휘슬만 — 사건은 아직 없다. 도구 없는 턴에도 다음 말은 선다
    const entered = await runGmTurn(state, "진행", undefined, { kind: "enter_match" });
    expect(entered.text).toContain("@중계:");
    expect(entered.suggestion).toBe("계속 가자");
    expect(state.pendingMatch?.entered).toBe(true);
    expect(entered.goals ?? []).toHaveLength(0);

    // 실행기가 하는 일 — 1분씩 굴리고, 중계할 사건이 확정되면 정지점 턴을 연다
    let broadcasts = 0;
    for (let guard = 0; guard < 400 && state.phase === "match"; guard += 1) {
      const live = state.pendingMatch!.live;
      if (liveFinished(live)) {
        if (awaitingShootout(state)) {
          advanceShootout(state);
          continue;
        }
        // 종료 휘슬 — 마감 턴
        await runGmTurn(state, "경기 중단", undefined, { kind: "match_stop" });
        break;
      }
      if (live.state.interval) resumeLiveInterval(state);
      const { events } = advanceLiveMatch(state, 60 * 20);
      if (!events.some((e) => STOP_EVENT_TYPES.has(e.type))) continue;
      const turn = await runGmTurn(state, "경기 중단", undefined, { kind: "match_stop" });
      if (turn.text.includes("@중계:")) broadcasts += 1;
    }
    expect(state.phase).toBe("idle");
    expect(broadcasts).toBeGreaterThan(0);
    // 마감이 장부에 섰다 — 첫 라운드의 우리 경기에 결과가 있다
    const played = state.matches.find(
      (m) => m.result !== null && (m.homeTeamId === "arsenal" || m.awayTeamId === "arsenal"),
    );
    expect(played).toBeDefined();
  });
});

describe("지시 묶음의 상태 경계", () => {
  it("연속 목록 추가는 앞선 명령의 결과를 유지한다", () => {
    const state = newGame();
    const selected = state.players
      .filter((player) => player.teamId === state.userTeamId)
      .slice(0, 2);
    selected.forEach((player) => {
      player.squadLevel = "reserve";
    });
    state.developmentFocus = [];
    const result = applyInstructionBatch(
      state,
      [],
      {
        ops: {
          set_development_focus: selected.map((player) => ({
            listMode: "add",
            playerIds: [player.id],
          })),
        },
      },
      ["set_development_focus"],
    );
    expect(result).toMatchObject({ rejected: false, applied: 2 });
    expect(state.developmentFocus).toEqual(selected.map((player) => player.id));
    const before = structuredClone(state);
    expect(
      applyInstructionBatch(state, [], { ops: { set_development_focus: [{}] } }, [
        "set_development_focus",
      ]).rejected,
    ).toBe(true);
    expect(state).toEqual(before);
  });
});
