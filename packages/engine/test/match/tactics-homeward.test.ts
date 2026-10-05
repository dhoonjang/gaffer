import { describe, expect, it } from "vitest";
import { MEMORY_FADE_DAYS, familiarityForSetup, tacticsSignature } from "@story-fm/domain";
import {
  playersOf,
  setLineup,
  setTactics,
  userTactics,
  type GameState,
  assignmentsOf,
  memoryRetention,
  playerById,
} from "@story-fm/engine";
import { createTestGame } from "../helpers";

/**
 * 전술을 바꿔도 **모두가 똑같이 헤매지는 않는다** (team/lineup.ts `personalDistance`·`memoryRetention`).
 * 각자 자기 기억과 성향을 기준으로 흔들린다.
 */

const famOf = (state: GameState, id: string) =>
  userTactics(state).assignments.find((a) => a.playerId === id)!.familiarity;

describe("적합도는 절대 평가다 — 남과 견주지 않는다", () => {
  /**
   * 예전엔 팀 평균을 뺀 상대값이라, 전술이 안 맞는 동료가 있으면 내 적응도가
   * 올랐다("남이 못 맞아서 내가 이득"). 같은 선수·같은 변경이면 동료가 누구든
   * 결과가 같아야 한다.
   */
  it("동료를 바꿔도 그 선수의 변화량이 거의 같다", () => {
    const shiftOf = (swapCount: number): number => {
      const state = createTestGame(11);
      const starters = userTactics(state).assignments.filter((a) => a.role === "starting");
      const subject = starters[0]!.playerId;

      // 동료 몇 명을 예비 자원으로 갈아 끼운다 — 팀 평균 적합도가 달라진다
      const spares = playersOf(state, state.userTeamId)
        .filter((p) => !starters.some((a) => a.playerId === p.id))
        .slice(0, swapCount);
      const starting = starters.map((a, i) => ({
        playerId: i > 0 && i <= swapCount ? spares[i - 1]!.id : a.playerId,
      }));
      const ok = setLineup(state, { starting });
      // 셋업이 실패하면 아래 비교는 잴 것이 없다 — 조용히 빠져나가지 않는다
      expect(ok.ok, `동료 ${swapCount}명 교체: ${ok.message}`).toBe(true);

      const before = famOf(state, subject);
      setTactics(state, { pressing: 5, defensiveLine: 5 });
      return Math.round((famOf(state, subject) - before) * 1000) / 1000;
    };

    const none = shiftOf(0);
    const swapped = shiftOf(4);
    /**
     * 완전히 같지는 않다 — `swing`은 팀 눈금의 변화를 개인 습득력대로 나눈 몫이라
     * 선발 구성이 바뀌면 분모(`baseFactor`)가 조금 움직인다. 그건 뜻이 있는
     * 의존이고, 적합도가 상대값이던 때의 몇 점짜리 흔들림과는 크기가 다르다.
     */
    expect(Math.abs(swapped - none)).toBeLessThan(1);
  });
});

describe("왕복은 닫힌다", () => {
  it("전술 기억이 없는 선수가 껴도 왕복은 닫힌다 — 오가는 것만으로 불릴 수 없다", () => {
    const state = createTestGame(11);
    const chelsea = state.tactics.find((t) => t.teamId === "chelsea")!;
    chelsea.spec = { ...chelsea.spec, pressing: 5, defensiveLine: 5 };

    const target = playersOf(state, "chelsea").find((p) => p.teamId !== state.userTeamId)!;
    const out = userTactics(state).assignments.find((a) => a.role === "starting")!;
    target.teamId = state.userTeamId;
    target.squadLevel = "first";
    setLineup(state, {
      starting: userTactics(state)
        .assignments.filter((a) => a.role === "starting")
        .map((a) => ({ playerId: a.playerId === out.playerId ? target.id : a.playerId })),
    });
    const t = userTactics(state);
    for (const a of t.assignments) a.familiarity = 70;
    const origin = { ...t.spec };
    const famOf = (id: string) =>
      userTactics(state).assignments.find((a) => a.playerId === id)!.familiarity;
    const before = famOf(target.id);

    for (let i = 0; i < 5; i++) {
      setTactics(state, { pressing: 5, defensiveLine: 5 });
      setTactics(state, { pressing: origin.pressing, defensiveLine: origin.defensiveLine });
    }
    // 왕복은 정확히 닫혀야 한다 — 오가는 것만으로 적응도를 불릴 수 없다
    expect(famOf(target.id)).toBeCloseTo(before, 6);
  });
});

// ─── 전술 기억의 감쇠 (memory-fade.test.ts에서 옮겨 왔다 — 같은 전술 적응도 도메인) ───
/**
 * 기억은 안 쓰면 옅어진다 — **그 속도가 선수마다 다르다.**
 * 전술 이해(시야·위치선정·침착성)가 그림을 오래 붙잡는다.
 */

const AXES = { vision: 0, positioning: 0, composure: 0 };

function withUptake(state: GameState, playerId: string, value: number) {
  const p = playerById(state, playerId)!;
  Object.assign(p.attributes, { ...AXES, vision: value, positioning: value, composure: value });
  return p;
}

describe("기억을 붙잡는 힘", () => {
  it("이해가 높을수록 크다", () => {
    const state = createTestGame(11);
    const id = assignmentsOf(state, state.userTeamId, "starting")[0]!.playerId;
    const dull = memoryRetention(withUptake(state, id, 30));
    const sharp = memoryRetention(withUptake(state, id, 95));
    expect(sharp).toBeGreaterThan(dull);
    expect(dull).toBeGreaterThanOrEqual(0.7);
    expect(sharp).toBeLessThanOrEqual(1.5);
  });

  it("주기가 곧 망각 속도다 — 같은 기간에 덜 잊는다", () => {
    const spec = {
      formation: "4-4-2",
      mentality: 3,
      defensiveLine: 3,
      pressing: 3,
      tempo: 3,
      width: 3,
      passStyle: 3,
    } as const;
    const drilled = [
      { signature: tacticsSignature(spec), familiarity: 80, lastUsedOn: "2026-07-01" },
    ];
    const after90 = (retention: number) =>
      familiarityForSetup(drilled, spec, "2026-09-29", { retention });

    expect(after90(1.3)).toBeGreaterThan(after90(0.7));
    // 기준(1)은 14일마다 1 — 90일이면 6 남짓
    expect(80 - after90(1)).toBe(Math.floor(90 / MEMORY_FADE_DAYS));
  });
});

describe("실제 전술 변경에서도 갈린다", () => {
  it("오래 안 쓴 전술로 돌아가면, 이해가 낮은 선수가 더 많이 잊었다", () => {
    const run = (uptake: number) => {
      const state = createTestGame(11);
      const tactics = userTactics(state);
      const id = assignmentsOf(state, state.userTeamId, "starting")[0]!.playerId;
      withUptake(state, id, uptake);
      for (const a of tactics.assignments) a.familiarity = 80;
      const origin = { ...tactics.spec };

      // 다른 전술로 갔다가 반년을 보낸 뒤 돌아온다
      setTactics(state, { pressing: 5, tempo: 5 });
      state.date = "2027-01-15";
      setTactics(state, { pressing: origin.pressing, tempo: origin.tempo });
      return userTactics(state).assignments.find((a) => a.playerId === id)!.familiarity;
    };

    expect(run(95)).toBeGreaterThan(run(30));
  });
});
