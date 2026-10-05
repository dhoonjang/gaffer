import { describe, expect, it } from "vitest";
import {
  clampCondition,
  ATTRIBUTE_AXES,
  PlayerStateSchema,
  freshPlayerState,
  type GamePlayer,
} from "@story-fm/domain";
import {
  addDays,
  streakOf,
  userPlayers,
  type GameState,
  clampForm,
  decayedForm,
  formAngle,
  formDeltaFromMatch,
  formSwing,
  RECENT_APPEARANCE_MATCHES,
  startsInWindow,
} from "@story-fm/engine";
import { createTestGame, resultOf } from "../helpers";

describe("체력 — 몸과 마음이 한 축이다", () => {
  it("0~100 안에 머문다", () => {
    expect(clampCondition(120)).toBe(100);
    expect(clampCondition(-5)).toBe(0);
  });
});

describe("공식 경기 연속 기록", () => {
  it("다른 결과가 끼면 연속 기록이 끊긴다", () => {
    expect(streakOf(["loss", "loss", "loss"], "loss")).toBe(3);
    expect(streakOf(["loss", "draw", "loss"], "loss")).toBe(1);
    expect(streakOf(["win", "loss"], "loss")).toBe(0);
  });
});

// ─── 폼 (form.test.ts에서 옮겨 왔다 — 같은 선수 상태 도메인) ───
/**
 * 폼만 보는 최소 선수 — 침착성과 현재 폼이 전부다.
 *
 * 게임을 만들어 선수를 빌려오면 안 된다(`createTestGame`은 수천 명을 인스턴스화해
 * 수 초가 걸리고, 부하가 걸리면 기본 타임아웃 5초를 넘겨 **간헐 실패**한다).
 * 폼 계산은 `attributes.composure`와 `state.form`만 읽으므로 리터럴로 충분하다.
 */
function player(form: number, composure = 70): GamePlayer {
  const axes = Object.fromEntries(ATTRIBUTE_AXES.map((a) => [a, 70])) as Record<string, number>;
  return {
    id: "t",
    catalogId: null,
    teamId: "t",
    squadLevel: "first",
    name: "테스트",
    birthdate: "2000-01-01",
    positions: [{ position: "CM", proficiency: 90, isNatural: true }],
    attributes: { ...axes, composure, potential: 75 } as GamePlayer["attributes"],
    state: freshPlayerState({ form, condition: 75 }),
    isCaptain: false,
    isViceCaptain: false,
    growthCarry: {},
  };
}

describe("폼 — 시간 축을 가진 컨디션 (form.ts)", () => {
  it("같은 경기라도 평점이 다르면 폼이 다르게 움직인다 (개인차)", () => {
    const hero = formDeltaFromMatch(player(0), 8.2, "win");
    const anonymous = formDeltaFromMatch(player(0), 6.3, "win");
    const flop = formDeltaFromMatch(player(0), 4.8, "win");
    expect(hero).toBeGreaterThan(anonymous);
    expect(anonymous).toBeGreaterThan(flop);
    // **이긴 경기에도 부진하면 내려간다** — 예전엔 열한 명이 똑같이 +1이었다
    expect(flop).toBeLessThan(0);
  });

  it("팀 결과는 얹히지만 주인은 개인 활약이다", () => {
    const won = formDeltaFromMatch(player(0), 7.0, "win");
    const lost = formDeltaFromMatch(player(0), 7.0, "loss");
    expect(won).toBeGreaterThan(lost);
    // 잘한 선수는 진 경기에도 폼이 크게 깎이지 않는다
    expect(lost).toBeGreaterThan(-0.3);
  });

  it("기복은 침착성이 정한다 — 침착한 선수는 덜 흔들린다", () => {
    expect(formSwing(player(0, 99))).toBeLessThan(formSwing(player(0, 20)));
    const steady = formDeltaFromMatch(player(0, 95), 8.5, "win");
    const volatile = formDeltaFromMatch(player(0, 25), 8.5, "win");
    expect(volatile).toBeGreaterThan(steady);
    // 나쁜 쪽도 마찬가지 — 기복이 큰 선수는 더 깊이 떨어진다
    expect(formDeltaFromMatch(player(0, 25), 4.5, "loss")).toBeLessThan(
      formDeltaFromMatch(player(0, 95), 4.5, "loss"),
    );
  });

  it("절정에 가까울수록 더 오르기 어렵고, 식는 건 온전히 통한다", () => {
    const fromFlat = formDeltaFromMatch(player(0), 8.0, "win");
    const fromPeak = formDeltaFromMatch(player(0.85), 8.0, "win");
    expect(fromPeak).toBeLessThan(fromFlat * 0.5);
    // 반대 방향(절정에서 부진)은 감쇠 없이 그대로 깎인다
    const down = formDeltaFromMatch(player(0.85), 4.5, "loss");
    expect(down).toBeCloseTo(formDeltaFromMatch(player(0), 4.5, "loss"), 5);
  });

  it("매일 평균으로 끌린다 — 쉬면 식는다", () => {
    let hot = 0.8;
    for (let day = 0; day < 14; day++) hot = decayedForm(hot);
    expect(hot).toBeLessThan(0.8);
    expect(hot).toBeGreaterThan(0.5); // 2주에 사라지지는 않는다
    // 0은 0에 머물고, 음수는 위로 끌린다
    expect(decayedForm(0)).toBe(0);
    expect(decayedForm(-1)).toBeGreaterThan(-1);
    expect(decayedForm(0.001)).toBe(0);
  });

  it("범위와 해상도 — −1~1 실수이고 그 밖으로 나가지 않는다", () => {
    expect(clampForm(4.2)).toBe(1);
    expect(clampForm(-9)).toBe(-1);
    expect(clampForm(0.12345)).toBe(0.123);
    // 스키마가 소수를 통과시켜야 세이브에 남는다
    expect(() =>
      PlayerStateSchema.parse(freshPlayerState({ form: 0.42, condition: 75 })),
    ).not.toThrow();
    // 축 밖의 값은 거부한다
    expect(() =>
      PlayerStateSchema.parse({ ...freshPlayerState({ form: 0, condition: 75 }), form: 2 }),
    ).toThrow();
  });

  it("각도는 연속이고, 절정에서만 12시를 본다", () => {
    expect(formAngle(1)).toBe(0); // 12시 — 절정에서만
    expect(formAngle(0)).toBe(90); // 3시 — 평소
    expect(formAngle(-1)).toBe(180); // 6시 — 바닥
    expect(formAngle(0.5)).toBe(45);
    expect(formAngle(-0.5)).toBe(135);
    // 눈금이 아니라 연속이다 — 조금만 올라도 각도가 달라진다
    expect(formAngle(0.42)).not.toBe(formAngle(0.45));
    // 축 밖은 잘린다 (12시를 넘어 돌지 않는다)
    expect(formAngle(2)).toBe(0);
    expect(formAngle(-2)).toBe(180);
  });
});

describe("최근 선발과 출전 사실", () => {
  /**
   * 지난 경기 여덟 판을 장부에 세운다 — 선발 명단만 다르다. 시즌을 굴리지 않는 이유는
   * 재는 것이 **경기가 아니라 창의 셈**이어서다 (people.md §5-2).
   */
  function recordPastMatches(
    state: GameState,
    startersOf: (index: number) => string[],
    /** 그 경기에 그라운드를 밟은 사람 전부 — 없으면 선발이 곧 출전이다 */
    lineupOf?: (index: number) => string[],
  ): void {
    for (let i = 0; i < RECENT_APPEARANCE_MATCHES; i += 1) {
      const starters = startersOf(i);
      state.matches.push({
        id: `m-promise-test-${i}`,
        season: state.season,
        competitionId: "epl",
        stage: "league",
        time: "15:00",
        round: i + 1,
        date: addDays(state.date, -(RECENT_APPEARANCE_MATCHES - i) * 7),
        homeTeamId: state.userTeamId,
        awayTeamId: "chelsea",
        result: resultOf({
          homeGoals: 1,
          awayGoals: 0,
          homeStarters: starters,
          homeLineup: lineupOf ? lineupOf(i) : starters,
        }),
      });
    }
  }

  /** 부상 이력이 없는 우리 1군 — 창의 분모가 온전한 선수만 고른다 */
  function healthy(state: GameState): GamePlayer[] {
    return userPlayers(state).filter(
      (p) => p.squadLevel === "first" && !state.injuries.some((i) => i.gamePlayerId === p.id),
    );
  }

  /**
   * 판정은 선발만 세는 것이 맞다 — 이 약속의 뜻이 "주전으로 세우겠다"라서다. 갈리는
   * 것은 **카드**다 (people.md §5-2): 후반 45분을 뛴 선수와 벤치에만 앉아 있던 선수가
   * 같은 사실로 가면, GM이 자기가 방금 집행한 교체를 경기 뒤에 부정한다.
   */
  it("교체로만 뛴 선수는 「선발 0 · 출전 1」로 서고, 못 뛴 선수와 갈린다", () => {
    const state = createTestGame();
    const [starter, sub, benched] = healthy(state);
    expect(starter && sub && benched).toBeTruthy();
    // 마지막 한 경기에만 교체로 들어갔다 — 선발 명단은 창 내내 그대로다
    recordPastMatches(
      state,
      () => [starter!.id],
      (i) => (i === RECENT_APPEARANCE_MATCHES - 1 ? [starter!.id, sub!.id] : [starter!.id]),
    );

    const subRead = startsInWindow(state, sub!);
    expect(subRead.played).toBe(RECENT_APPEARANCE_MATCHES);
    expect(subRead.starts).toBe(0);
    expect(subRead.apps).toBe(1);
    // 판정의 자는 그대로다 — 교체 출전은 선발 비율을 올리지 않는다
    expect(subRead.share).toBe(0);

    const benchedRead = startsInWindow(state, benched!);
    expect(benchedRead.starts).toBe(0);
    expect(benchedRead.apps, "한 번도 못 뛴 선수가 출전으로 셌다").toBe(0);

    // 선발은 언제나 출전이다 — 두 칸이 다른 장부에서 나와도 이 부등식은 선다
    const starterRead = startsInWindow(state, starter!);
    expect(starterRead.starts).toBe(RECENT_APPEARANCE_MATCHES);
    expect(starterRead.apps).toBe(RECENT_APPEARANCE_MATCHES);
  });
});
