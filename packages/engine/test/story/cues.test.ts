import type { BoardRequestKind } from "@story-fm/domain";
import {
  BOARD_REQUEST,
  STADIUM_ASSET_MONTHS,
  activeOpenings,
  addDays,
  boardRequestCeiling,
  boardThriftFactor,
  boardTrustFactor,
  clubProfileIn,
  describePendingApproach,
  financeOf,
  internationalBreaksOf,
  leagueOfTeamIn,
  pendingApproach,
  playerById,
  recordIncident,
  recordStoryIncident,
  requestBoard,
  respondToApproach,
  seedOpenings,
  speakerCues,
  tickApproaches,
  tickBoardRequests,
  tierOfTeamIn,
  userPlayers,
  type GameState,
} from "@story-fm/engine";
import { describe, expect, it } from "vitest";
import { createTestGame, resultOf } from "../helpers";

/**
 * 선수 근황 — **세계에 지금 무슨 이야기가 있는가** (cues.ts).
 *
 * 이 줄이 없으면 스냅샷이 이름을 내보내는 자리는 부상·정지·불만 셋뿐이고,
 * 셋 다 몇 주씩 바뀌지 않아 GM이 아는 "이야기가 있는 선수"가 늘 같은 두세 명이다.
 */

/** 1군 선수를 앞에서부터 n명 — 근황을 심을 대상 */
const firsts = (state: GameState, n: number) =>
  userPlayers(state)
    .filter((p) => p.squadLevel === "first")
    .slice(0, n);

/** 근황이 하나도 없는 판 — 폼을 전부 평소로 눕힌다 */
function quiet(state: GameState) {
  for (const p of userPlayers(state)) p.state.form = 0;
  /**
   * 조용한 세계에는 **열린 자리도 없다.** 새 게임은 부임 회견 하나를 열고 시작하는데
   * (people.md §4), 갓 열린 회견은 그날의 다가옴을 막는 문이라(§8 소음의 문 5) 그대로
   * 두면 이 파일의 다가옴 케이스가 그 문에 걸린다.
   */
  state.pressConferences = [];
  return state;
}

describe("근황은 사실에서 온다", () => {
  it("폼이 절정이거나 바닥이면 이야기가 된다 — 평소는 아니다", () => {
    const state = quiet(createTestGame(11));
    const [peak, slump] = firsts(state, 2);
    peak!.state.form = 0.8;
    slump!.state.form = -0.8;

    const cues = speakerCues(state, 10);
    expect(cues.find((c) => c.playerId === peak!.id)?.fact).toContain("절정");
    expect(cues.find((c) => c.playerId === slump!.id)?.fact).toContain("바닥");
    expect(cues).toHaveLength(2);
  });

  it("복귀가 눈앞인 부상만 근황이다 — 재활 초입은 주의 줄이 이미 말한다", () => {
    const state = quiet(createTestGame(11));
    const [soon, far] = firsts(state, 2);
    for (const [player, days] of [
      [soon!, 7],
      [far!, 60],
    ] as const) {
      state.injuries.push({
        id: `inj-${player.id}`,
        gamePlayerId: player.id,
        bodyPart: "햄스트링",
        severity: "moderate",
        cause: "training",
        occurredOn: state.date,
        expectedReturn: addDays(state.date, days),
        returnedOn: null,
      });
    }
    const cues = speakerCues(state, 10);
    expect(cues.find((c) => c.playerId === soon!.id)?.fact).toContain("복귀 임박");
    expect(cues.some((c) => c.playerId === far!.id)).toBe(false);
  });

  /**
   * **대표팀은 폼보다 앞이다** (people.md §7 · competition.md §5-1). 순서가 곧
   * 크기라, 소집이 폼 뒤로 밀리면 이번 주 클럽에 없는 선수가 「폼 절정」으로만
   * 세계에 선다 — 화면에는 아무 소리도 나지 않는 종류다.
   */
  it("소집 중이면 그것이 그의 이야기다 — 폼보다 앞이다", () => {
    const state = quiet(createTestGame(11));
    const window = internationalBreaksOf(state.season)[0]!;
    state.date = window.from;
    const player = firsts(state, 1)[0]!;
    player.state.form = 0.9;
    player.state.caps = 34;
    state.callUps = [
      {
        gamePlayerId: player.id,
        country: "ENG",
        breakKey: window.key,
        apps: 0,
        goals: 0,
        returnedOn: null,
      },
    ];

    const fact = speakerCues(state, 10).find((c) => c.playerId === player.id)?.fact;
    expect(fact).toContain("소집");
    expect(fact).not.toContain("절정");
  });

  it("돌아온 주까지가 그의 이야기다 — 그 뒤는 아니다", () => {
    const state = quiet(createTestGame(11));
    const window = internationalBreaksOf(state.season)[0]!;
    const player = firsts(state, 1)[0]!;
    state.callUps = [
      {
        gamePlayerId: player.id,
        country: "ENG",
        breakKey: window.key,
        apps: 2,
        goals: 1,
        returnedOn: window.to,
        returnState: "tired",
      },
    ];

    state.date = addDays(window.to, 7);
    expect(speakerCues(state, 10).find((c) => c.playerId === player.id)?.fact).toContain("복귀");
    state.date = addDays(window.to, 8);
    expect(speakerCues(state, 10).find((c) => c.playerId === player.id)?.fact ?? "").not.toContain(
      "복귀",
    );
  });

  it("2군은 세지 않는다 — 감독의 일상에 닿지 않는다", () => {
    const state = quiet(createTestGame(11));
    const target = firsts(state, 1)[0]!;
    target.state.form = 0.9;
    expect(speakerCues(state, 10).some((c) => c.playerId === target.id)).toBe(true);
    playerById(state, target.id)!.squadLevel = "reserve";
    expect(speakerCues(state, 10).some((c) => c.playerId === target.id)).toBe(false);
  });

  it("아무 일도 없으면 빈 목록 — 없는 이야기를 만들지 않는다", () => {
    expect(speakerCues(quiet(createTestGame(11)), 10)).toEqual([]);
  });

  it("결정적이다 — 같은 날 같은 세이브면 같은 목록", () => {
    const state = quiet(createTestGame(11));
    for (const p of firsts(state, 5)) p.state.form = 0.8;
    expect(speakerCues(state)).toEqual(speakerCues(state));
  });
});

/**
 * **"최근 세 경기"는 날짜의 것이다.**
 *
 * `state.matches`는 날짜순이 아니다 — 컵·대항전 대진은 그 라운드가 확정될 때 배열
 * 뒤에 붙는다. 배열 끝에서 세면 시즌 후반의 "최근"이 방금 편성된 컵 경기가 되고,
 * 리그 3연속 미출전이 조용히 새어 나간다. 화면에 아무 소리도 나지 않는 종류라
 * 여기가 아니면 드러날 자리가 없다.
 */
describe("연속 미출전은 날짜순 직전 세 경기로 센다", () => {
  /**
   * 치른 경기 하나 — `lineup`에 있는 선수만 뛴 것으로 남는다. `bench`를 주지 않으면
   * 벤치를 안 남긴 옛 경기다(그 칸은 우리 경기에만 생겼다 — match.md §4).
   */
  function played(
    state: GameState,
    id: string,
    date: string,
    lineup: readonly string[],
    bench?: readonly string[],
  ) {
    state.matches.push({
      id,
      season: state.season,
      competitionId: "epl",
      stage: "league",
      time: "15:00",
      round: 1,
      date,
      homeTeamId: state.userTeamId,
      awayTeamId: "chelsea",
      result: resultOf({
        homeGoals: 1,
        awayGoals: 0,
        homeLineup: [...lineup],
        ...(bench ? { homeBench: [...bench] } : {}),
      }),
    });
  }

  /** 세 경기를 벤치에서 본 선수 하나를 만들고, 그 선수를 돌려준다 */
  function benchedForThree(state: GameState) {
    const target = firsts(state, 1)[0]!;
    const others = userPlayers(state)
      .filter((p) => p.id !== target.id)
      .map((p) => p.id);
    for (const [i, day] of [4, 3, 2].entries()) {
      played(state, `m-league-${i}`, addDays(state.date, -day), others);
    }
    return target;
  }

  it("배열 뒤에 붙은 옛 경기가 최근 세 경기를 밀어내지 않는다", () => {
    const state = quiet(createTestGame(11));
    const target = benchedForThree(state);
    // 3주 전 컵 경기가 이제야 배열 끝에 붙는다 — 그날은 이 선수가 뛰었다
    played(state, "m-cup-old", addDays(state.date, -21), [target.id]);

    const cue = speakerCues(state, 40).find((c) => c.playerId === target.id);
    expect(cue?.fact).toMatch(/^3경기 연속 출전 0/u);
  });

  /**
   * **못 뛴 것과 빠진 것은 다른 사실이다** (people.md §7).
   *
   * 세는 값은 출전이 없는 경기 수인데 그 줄이 「명단 제외」라고 불러, 매 경기
   * 벤치에 앉아 있던 선수에게 「감독이 명단에서 뺐다」는 장면이 붙었다. 화면에는
   * 아무 소리도 나지 않고 GM의 문장에서만 드러나는 종류라 여기가 아니면 볼 자리가
   * 없다.
   */
  describe("벤치에 앉은 것과 명단에 없던 것이 다른 줄로 선다", () => {
    /** 세 경기 내내 못 뛴 선수 하나 — 그 경기의 벤치를 `seat`가 정한다 */
    function threeWithout(state: GameState, seat: (target: string) => string[] | undefined) {
      const target = firsts(state, 1)[0]!;
      const others = userPlayers(state)
        .filter((p) => p.id !== target.id)
        .map((p) => p.id);
      for (const [i, day] of [4, 3, 2].entries()) {
        played(state, `m-league-${i}`, addDays(state.date, -day), others, seat(target.id));
      }
      return target;
    }

    const factOf = (state: GameState, id: string) =>
      speakerCues(state, 40).find((c) => c.playerId === id)?.fact;

    it("세 경기 내내 벤치였으면 「벤치」다 — 명단 제외가 아니다", () => {
      const state = quiet(createTestGame(11));
      const target = threeWithout(state, (id) => [id]);
      expect(factOf(state, target.id)).toMatch(/^3경기 연속 출전 0 · 벤치/u);
    });

    it("세 경기 내내 명단 밖이었으면 「명단 밖」이다", () => {
      const state = quiet(createTestGame(11));
      const target = threeWithout(state, () => []);
      expect(factOf(state, target.id)).toMatch(/^3경기 연속 출전 0 · 명단 밖/u);
    });

    it("자리가 섞이면 말하지 않는다 — 한 단어로 부를 수 없다", () => {
      const state = quiet(createTestGame(11));
      const target = threeWithout(state, () => []);
      // 그중 한 경기만 벤치에 앉았다 — 셋을 한 단어로 부를 수 없다
      state.matches.find((m) => m.id === "m-league-1")!.result!.homeBench = [target.id];
      expect(factOf(state, target.id)).toBe("3경기 연속 출전 0");
    });

    it("벤치를 안 남긴 옛 경기가 끼면 자리를 지어내지 않는다", () => {
      const state = quiet(createTestGame(11));
      const target = threeWithout(state, (id) => [id]);
      delete state.matches.find((m) => m.id === "m-league-1")!.result!.homeBench;
      expect(factOf(state, target.id)).toBe("3경기 연속 출전 0");
    });
  });

  it("직전 경기에 나섰으면 근황이 아니다 — 배열 끝이 옛 대진이어도", () => {
    const state = quiet(createTestGame(11));
    const target = firsts(state, 1)[0]!;
    played(state, "m-yesterday", addDays(state.date, -1), [target.id]);
    // 배열 끝의 셋은 3주 전 컵 대진이다 — 편성 순서지 날짜 순서가 아니다
    for (const [i, day] of [21, 22, 23].entries()) {
      played(state, `m-cup-${i}`, addDays(state.date, -day), []);
    }
    expect(speakerCues(state, 40).some((c) => c.playerId === target.id)).toBe(false);
  });
});

describe("한 사람이 계속 말하지 않는다", () => {
  it("최근에 말한 선수는 뒤로 밀린다", () => {
    const state = quiet(createTestGame(11));
    const [a, b] = firsts(state, 2);
    a!.state.form = 0.8;
    b!.state.form = 0.8;
    state.chat.push({
      role: "model",
      text: `[${state.date} AM 9:00]\n@${a!.name}: 감독님, 드릴 말씀이 있습니다.`,
      toolCalls: [],
      at: state.date,
    });
    expect(speakerCues(state, 1)[0]!.playerId).toBe(b!.id);
  });

  it("공백만 다른 이름도 같은 사람이다 — 모델이 붙여 써도 회전에서 빠지지 않는다", () => {
    const state = quiet(createTestGame(11));
    const [a, b] = firsts(state, 2);
    a!.state.form = 0.8;
    b!.state.form = 0.8;
    // 모델은 같은 사람을 "스티브 홀랜드"로도 "스티브홀랜드"로도 쓴다
    const spaced = a!.name.replace(/^(.)/u, "$1 ");
    state.chat.push({
      role: "model",
      text: `[${state.date} AM 9:00]\n@${spaced}: 감독님, 드릴 말씀이 있습니다.`,
      toolCalls: [],
      at: state.date,
    });
    expect(speakerCues(state, 1)[0]!.playerId).toBe(b!.id);
  });

  it("날짜가 바뀌면 차례가 돈다 — 근황이 그대로여도", () => {
    const state = quiet(createTestGame(11));
    for (const p of firsts(state, 4)) p.state.form = 0.8;
    const seen = new Set<string>();
    for (let i = 0; i < 4; i++) {
      seen.add(speakerCues(state, 1)[0]!.playerId);
      state.date = addDays(state.date, 1);
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});

/** 하루씩 민다 — tick 전체가 아니라 압력만 굴려 다른 사건이 섞이지 않게 한다 */
function pressDays(state: GameState, days: number): string[] {
  const digest: string[] = [];
  for (let i = 0; i < days; i++) {
    state.date = addDays(state.date, 1);
    tickApproaches(state, digest);
  }
  return digest;
}

/**
 * 시즌 리뷰 면담 — **압력이 아니라 달력이 여는 유일한 자리** (career.md §5 ·
 * people.md §8). 세계를 굴리는 대신 지난 시즌의 줄과 날짜를 손으로 세운다:
 * 재는 것이 시즌을 어떻게 치렀는가가 아니라 그 줄을 읽는 문이기 때문이다.
 */
describe("시즌이 끝나면 구단주가 마주 앉는다", () => {
  /** 지난 시즌 줄 하나 — 기대의 갈래와 목표만 케이스가 정한다 */
  function recordSeason(state: GameState, season: number, board: { position: number }) {
    state.seasonRecords.push({
      season,
      teamId: state.userTeamId,
      position: board.position,
      wins: 12,
      draws: 8,
      losses: 18,
      goalsFor: 40,
      goalsAgainst: 55,
      leagueId: leagueOfTeamIn(state, state.userTeamId),
      tier: 4,
      board: { ...structuredClone(state.boardAgenda), expectations: ["젊은 선수에게 기회를 준다"] },
    });
  }

  /** 프리시즌 첫날에 세운다 — `pressDays(1)`이 곧 전환 다음 tick이다 */
  function preseason(state: GameState): GameState {
    state.date = state.calendar.preseasonStart;
    return state;
  }

  it("무직으로 맞은 시즌엔 열리지 않는다 — 그 시즌은 줄을 남기지 않는다", () => {
    const state = preseason(quiet(createTestGame(11)));
    // 지난 시즌은 무직이었다 — 마지막 줄이 두 시즌 전의 것이다
    recordSeason(state, state.season - 2, { position: 9 });
    pressDays(state, 1);
    expect(pendingApproach(state)).toBeNull();

    // 무직 그 자체도 문이다 — 줄이 지난 시즌의 것이어도 마주 앉을 구단주가 없다
    state.dismissal = {
      on: state.date,
      season: state.season,
      teamId: state.userTeamId,
      kind: "sacked",
      tier: tierOfTeamIn(state, state.userTeamId),
      target: 10,
      expectationCode: "mid",
    };
    recordSeason(state, state.season - 1, { position: 9 });
    pressDays(state, 1);
    expect(pendingApproach(state)).toBeNull();

    delete state.dismissal;
    pressDays(state, 1);
    expect(pendingApproach(state)?.topic).toBe("season-review");
  });

  it("기대의 갈래가 바뀌면 옛 기대가 함께 선다 — 승강이 체급을 옮긴 해다", () => {
    const state = preseason(quiet(createTestGame(11)));
    // 지난 시즌의 갈래는 잔류였고 올해는 그것이 아니다 (tier 1의 우승 경쟁)
    recordSeason(state, state.season - 1, { position: 15 });
    pressDays(state, 1);

    const open = pendingApproach(state)!;
    expect(open.topic).toBe("season-review");
    // 계단 2 고정 — 압력 줄을 세우지 않으므로 되돌릴 눈금도 없다
    expect(describePendingApproach(state)).not.toContain("계단");

    expect(
      open.facts.some((f) => f.kind === "board" && f.data?.text === "젊은 선수에게 기회를 준다"),
    ).toBe(true);
  });
});

/**
 * 감독이 보드에 거는 요청 — **위와 방향이 반대인 별개 상태다** (board-request.ts ·
 * finance.md §9.3). 판정이 굴림이 아니라 한도라, 값이 도는 자리는 전부 경계다:
 * 신뢰 계수의 바닥, 살림 계수의 계단, 한도와 부른 값이 갈리는 선, 공기가 차는 날.
 */
describe("보드 요청 (감독 → 보드) — 한도가 답을 정한다", () => {
  /** 답이 나오는 판 — 잔고와 보드 평판을 원하는 자리에 세운다 */
  function board(state: GameState, balance: number, reputation: number): GameState {
    financeOf(state, state.userTeamId).balance = balance;
    state.manager.reputation.board = reputation;
    return state;
  }

  /** 답이 오는 날까지 시계를 민다 */
  function untilAnswer(state: GameState, kind: BoardRequestKind) {
    state.date = addDays(state.date, BOARD_REQUEST.RESPOND_DAYS[kind]);
    tickBoardRequests(state, []);
  }

  it("신뢰 계수는 평판 30에서 0이고 80에서 1.0, 위로는 1.2에서 멈춘다", () => {
    expect(boardTrustFactor(BOARD_REQUEST.TRUST_FLOOR)).toBe(0);
    expect(boardTrustFactor(BOARD_REQUEST.TRUST_FLOOR - 10)).toBe(0);
    expect(boardTrustFactor(80)).toBeCloseTo(1);
    expect(boardTrustFactor(100)).toBe(BOARD_REQUEST.TRUST_MAX);
  });

  it("살림 계수는 급여 비중 경고선에서 반, 위험선에서 0으로 떨어진다", () => {
    expect(boardThriftFactor(BOARD_REQUEST.WAGE_RATIO_CAUTION - 0.001)).toBe(1);
    expect(boardThriftFactor(BOARD_REQUEST.WAGE_RATIO_CAUTION)).toBe(0.5);
    expect(boardThriftFactor(BOARD_REQUEST.WAGE_RATIO_DANGER)).toBe(0);
  });

  it("한도를 넘겨 부르면 한도만큼만 나온다 — 부분 승인은 granted < amount다", () => {
    const state = board(createTestGame(11), 2_000_000_000, 80);
    const ceiling = boardRequestCeiling(state);
    expect(ceiling).toBeGreaterThan(0);
    requestBoard(state, { kind: "stadium", amount: ceiling + 1000 });
    untilAnswer(state, "stadium");

    const answered = state.boardRequests[0]!;
    expect(answered.status).toBe("approved");
    expect(answered.granted).toBe(ceiling);
    // 답은 보드 평판을 옮기지 않는다 — 구단주 요청과 갈리는 자리다
    expect(state.manager.reputation.board).toBe(80);
  });

  it("보드 평판이 바닥이면 한도가 0이라 거절이다", () => {
    const poor = board(createTestGame(11), 2_000_000_000, BOARD_REQUEST.TRUST_FLOOR);
    expect(boardRequestCeiling(poor)).toBe(0);
    requestBoard(poor, { kind: "stadium", amount: 1000 });
    untilAnswer(poor, "stadium");
    expect(poor.boardRequests[0]!.status).toBe("rejected");
  });

  it("열린 요청은 하나뿐이고, 같은 안건은 쿨다운이 지나야 다시 걸린다", () => {
    const state = board(createTestGame(11), 2_000_000_000, BOARD_REQUEST.TRUST_FLOOR);
    expect(requestBoard(state, { kind: "stadium", amount: 1000 }).ok).toBe(true);
    // 답을 기다리는 동안에는 다시 걸 수 없다
    expect(requestBoard(state, { kind: "stadium", amount: 1000 }).ok).toBe(false);
    untilAnswer(state, "stadium");

    const resolved = state.boardRequests[0]!.resolvedOn!;
    state.date = addDays(resolved, BOARD_REQUEST.COOLDOWN_DAYS - 1);
    expect(requestBoard(state, { kind: "stadium", amount: 1000 }).ok).toBe(false);
    state.date = addDays(resolved, BOARD_REQUEST.COOLDOWN_DAYS);
    expect(requestBoard(state, { kind: "stadium", amount: 1000 }).ok).toBe(true);
  });

  it("구장은 승인 즉시 공사비가 나가고 좌석은 공기가 찬 날에 선다", () => {
    const state = board(createTestGame(11), 2_000_000_000, 80);
    const teamId = state.userTeamId;
    const before = clubProfileIn(state, teamId).capacity;
    const seats = boardRequestCeiling(state);
    // 잔고가 넉넉하면 여력을 정하는 것은 지금 수용인원이다
    expect(seats).toBe(Math.floor(before * BOARD_REQUEST.SEATS_OF_CAPACITY));

    const balanceBefore = financeOf(state, teamId).balance;
    requestBoard(state, { kind: "stadium", amount: seats });
    untilAnswer(state, "stadium");
    const built = state.boardRequests!.find((r) => r.kind === "stadium")!;
    expect(built.status).toBe("approved");
    expect(financeOf(state, teamId).balance).toBe(balanceBefore - seats * BOARD_REQUEST.SEAT_COST);
    /**
     * 공사비는 **자본 지출**이다 — 현금은 오늘 나가지만 손익은 자산이 내용연수에
     * 나눠 문다 (finance.md §6.1). 착공 달 하나가 손익을 통째로 먹지 않는다.
     */
    const spent = financeOf(state, teamId).ledger.filter((e) => e.category === "capex");
    expect(spent).toHaveLength(1);
    const asset = financeOf(state, teamId).assets?.[0];
    expect(asset?.cost).toBe(seats * BOARD_REQUEST.SEAT_COST);
    expect(asset?.months).toBe(STADIUM_ASSET_MONTHS);
    // 돈은 나갔지만 좌석은 아직 없다
    expect(clubProfileIn(state, teamId).capacity).toBe(before);
    // 공사 중에는 다시 걸 수 없다 — 여력이 수용인원에서 나오므로 복리로 커진다
    state.date = addDays(built.resolvedOn!, BOARD_REQUEST.COOLDOWN_DAYS);
    expect(requestBoard(state, { kind: "stadium", amount: 100 }).ok).toBe(false);

    state.date = addDays(built.deliversOn!, -1);
    tickBoardRequests(state, []);
    expect(clubProfileIn(state, teamId).capacity).toBe(before);

    state.date = built.deliversOn!;
    tickBoardRequests(state, []);
    expect(clubProfileIn(state, teamId).capacity).toBe(before + seats);
    // 두 번 얹지 않는다
    state.date = addDays(state.date, 1);
    tickBoardRequests(state, []);
    expect(clubProfileIn(state, teamId).capacity).toBe(before + seats);
  });
});

describe("GM이 여는 면담과 명시적 해소", () => {
  const base = quiet(createTestGame(11));
  it("현재 사실 없는 요청은 사건도 남기지 않는다", () => {
    const state = structuredClone(base);
    state.issues = [];
    const player = firsts(state, 1)[0]!;
    const before = structuredClone(state);
    expect(
      recordStoryIncident(state, {
        kind: "mediation",
        playerIds: [player.id],
        intensity: 1,
        summary: "면담",
        reaction: { reason: "면담 요청" },
        approach: { topic: "minutes", playerId: player.id },
      }).ok,
    ).toBe(false);
    expect(state).toEqual(before);
  });
  it("명시한 현재 사유만 지우고 다른 사유는 남긴다", () => {
    const state = structuredClone(base);
    const player = firsts(state, 1)[0]!;
    state.issues = ["minutes", "out-of-position"].map((reason) => ({
      gamePlayerId: player.id,
      kind: "unhappy" as const,
      reason: reason as "minutes" | "out-of-position",
      since: state.date,
    }));
    expect(
      recordStoryIncident(state, {
        kind: "mediation",
        playerIds: [player.id],
        intensity: 1,
        summary: "출전 계획 면담",
        reaction: { reason: "설명을 기다린다" },
        approach: { topic: "minutes", playerId: player.id },
      }).ok,
    ).toBe(true);
    expect(
      respondToApproach(state, {
        reaction: { reason: "계획에 동의했다", target: 0.6 },
        resolveIssues: [{ playerId: player.name, reason: "minutes" }],
      }).ok,
    ).toBe(true);
    expect(state.issues.map((i) => i.reason)).toEqual(["out-of-position"]);
  });
  it("열리지 않은 실마리를 함께 해소하면 사건과 모든 실마리가 그대로다", () => {
    const state = structuredClone(base);
    seedOpenings(state, [{ kind: "personal", title: "배경", line: "감독의 선택" }]);
    const id = activeOpenings(state)[0]!.id;
    const before = structuredClone(state);
    expect(
      recordIncident(state, {
        kind: "mediation",
        playerIds: [firsts(state, 1)[0]!.id],
        intensity: 1,
        summary: "결말",
        reaction: { reason: "해소" },
        resolveOpeningIds: [id, "missing"],
      }).ok,
    ).toBe(false);
    expect(state).toEqual(before);
    expect(
      recordIncident(state, {
        kind: "mediation",
        playerIds: [firsts(state, 1)[0]!.id],
        intensity: 1,
        summary: "결말",
        reaction: { reason: "해소" },
        resolveOpeningIds: [id],
      }).ok,
    ).toBe(true);
    expect(activeOpenings(state)).toHaveLength(0);
  });
});
