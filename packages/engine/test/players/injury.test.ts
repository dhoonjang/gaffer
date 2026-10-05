import { describe, expect, it } from "vitest";
import { applyEvents } from "@story-fm/sim";
import {
  leagueOfTeamIn,
  PRONENESS_BASE,
  pronenessFromDaysOut,
  pronenessOf,
  markEntered,
  advanceTime,
  diffDays,
  finalizeMatch,
  injuryProneness,
  injuryHistoryOf,
  addDays,
  injuryRiskFor,
  isInjured,
  openInjuryFor,
  playerById,
  playerCatalog,
  playersOf,
  quickSimulate,
  simSquadOf,
  startMatch,
  userSide,
} from "@story-fm/engine";
import { INJURY_HISTORY } from "../../src/players/catalog/injury-history";
import { advanceToMatchday, createTestGame, playToFullTime } from "../helpers";

/**
 * 조사된 선수 수는 **표가 정한다** — `INJURY_HISTORY`의 키(위키데이터 QID) 전부다.
 * 여기 숫자를 손으로 적어 두면 표에 한 줄 넣는 것만으로 테스트가 빨개진다
 * (그리고 그때 고쳐지는 것은 코드가 아니라 이 숫자다).
 */
const RESEARCHED = Object.keys(INJURY_HISTORY);

describe("부상 위험은 이력에서 파생된다", () => {
  const injury = {
    id: "i",
    gamePlayerId: "p",
    bodyPart: "무릎",
    severity: "major" as const,
    cause: "match" as const,
    occurredOn: "2026-01-01",
    expectedReturn: "2026-05-01",
    returnedOn: "2026-05-01",
  };
  it("기록 없음은 기본값이고 결장 기간에 단조 증가하며 상한을 지킨다", () => {
    expect(injuryProneness({ date: "2026-07-01", injuries: [] }, "p")).toBe(PRONENESS_BASE);
    expect(pronenessFromDaysOut(-1)).toBe(1);
    expect(pronenessFromDaysOut(40)).toBe(1.15);
    expect(pronenessFromDaysOut(80)).toBeCloseTo(1.3);
    expect(pronenessFromDaysOut(120)).toBe(1.45);
    expect(pronenessFromDaysOut(400)).toBe(2.2);
    expect(pronenessFromDaysOut(900)).toBe(2.2);
    for (let days = 1; days <= 730; days++)
      expect(pronenessFromDaysOut(days)).toBeGreaterThanOrEqual(pronenessFromDaysOut(days - 1));
  });
  it("겹친 부상은 한 번만 세고 오래된 기록은 영향만 줄인다", () => {
    const state = { date: "2026-07-01", injuries: [injury, { ...injury, id: "duplicate" }] };
    expect(injuryProneness(state, "p")).toBeCloseTo(1.45);
    expect(injuryProneness({ ...state, date: addDays(injury.returnedOn, 730) }, "p")).toBe(1);
    expect(state.injuries).toHaveLength(2);
    expect(pronenessOf(state, ["p", "unknown"])).toEqual({
      p: injuryProneness(state, "p"),
      unknown: 1,
    });
  });
  it("재활 중에는 실제 결장만 쌓이고 예상 복귀일을 바꿔도 위험 배수는 같다", () => {
    const state = { date: "2026-02-01", injuries: [{ ...injury, returnedOn: null }] };
    const before = injuryProneness(state, "p");
    state.injuries[0]!.expectedReturn = "2027-01-01";
    expect(injuryProneness(state, "p")).toBe(before);
    state.date = "2026-03-01";
    expect(injuryProneness(state, "p")).toBeGreaterThan(before);
  });
  it("위험 등급과 시뮬 입력도 같은 이력을 읽고 조회는 상태를 변경하지 않는다", () => {
    const state = createTestGame(11);
    const player = playersOf(state, state.userTeamId)[0]!;
    player.state.condition = 100;
    state.injuries = [];
    expect(injuryRiskFor(state, player).grade).toBe("low");
    state.injuries.push({
      ...injury,
      gamePlayerId: player.id,
      occurredOn: addDays(state.date, -401),
      returnedOn: addDays(state.date, -1),
    });
    const before = JSON.stringify(state);
    expect(injuryRiskFor(state, player).causes).toContain("proneness");
    expect(pronenessOf(state, [player.id])[player.id]).toBe(2.2);
    expect(JSON.stringify(state)).toBe(before);
    expect(player.state).not.toHaveProperty("injuryProneness");
  });
});

describe("부상은 팀을 가리지 않는다", () => {
  it("타 팀 경기의 부상이 INJURY 표에 남는다", () => {
    const state = createTestGame(3);
    const player = state.players.find(
      (p) => p.teamId !== state.userTeamId && p.teamId !== "freeagents",
    )!;
    state.injuries = [];
    openInjuryFor(state, player, "match", () => 0.5);
    expect(state.injuries).toHaveLength(1);
    expect(state.injuries[0]).toMatchObject({ gamePlayerId: player.id, cause: "match" });
    expect(injuryHistoryOf(state, player.id).count).toBe(1);
  });

  it("유저 경기 — 중계에 쓰러진 상대가 다음 경기에 멀쩡히 서지 않는다", () => {
    const state = createTestGame(9);
    advanceToMatchday(state);
    expect(startMatch(state).ok).toBe(true);
    const pending = state.pendingMatch!;
    const oppSide = userSide(state) === "home" ? "away" : "home";
    const victim = pending.live.ledger[oppSide].onPitch[0]!;
    const hurt = applyEvents(pending.live.ledger, [
      { minute: 0, type: "injury", team: oppSide, actors: [victim], causes: [] },
    ]);
    expect(hurt.ok).toBe(true);
    if (hurt.ok) pending.live.ledger = hurt.state;
    markEntered(state);
    playToFullTime(state);
    finalizeMatch(state);
    expect(isInjured(state, victim)).toBe(true);
  });
});

describe("부임 전 부상 이력 — 조사된 선수만", () => {
  const state = createTestGame(42);
  /** 조인 키는 카탈로그의 `wikidataId`(QID)다 (`seedInjuryHistory`) */
  const qidById = new Map(playerCatalog().map((e) => [e.id, e.wikidataId]));
  const qidOf = (playerId: string) => {
    const player = playerById(state, playerId)!;
    return player.catalogId === null ? undefined : qidById.get(player.catalogId);
  };
  /** 표에 QID가 있고 이 세계에 실제로 있는 선수 */
  const researched = state.players.filter((p) => {
    const qid = p.catalogId === null ? undefined : qidById.get(p.catalogId);
    return qid !== undefined && INJURY_HISTORY[qid] !== undefined;
  });
  const seededRows = state.injuries.filter((i) => i.cause === "pre_appointment");

  it("표가 게임에 닿는다 — 값을 갖는 선수는 조사분 그들뿐이다", () => {
    expect(researched.length, "표의 이름이 한 명도 게임에 닿지 않았다").toBeGreaterThan(0);
    const withValue = state.players.filter((p) => injuryProneness(state, p.id) !== PRONENESS_BASE);
    expect(withValue.map((p) => p.id).sort()).toEqual(
      researched
        .filter((p) => injuryHistoryOf(state, p.id).daysOut > 0)
        .map((p) => p.id)
        .sort(),
    );
    // 나머지 전부는 평균에서 출발한다 (지어내지 않는다)
    expect(state.players.length - withValue.length).toBeGreaterThan(RESEARCHED.length);
  });

  /**
   * 행 하나하나가 표의 한 줄이다 — **코어는 부상을 지어내지 않는다.**
   * 특정 선수의 행 수를 손으로 적지 않는다: 표에 한 줄 넣는 것만으로 빨개지고,
   * 그때 고쳐지는 것은 코드가 아니라 그 숫자다.
   */
  it("씨앗 부상 행은 표에서만 나오고 날짜를 그대로 옮긴다", () => {
    expect(seededRows.length, "씨앗 부상 행이 하나도 없다").toBeGreaterThan(0);
    for (const row of seededRows) {
      const qid = qidOf(row.gamePlayerId);
      expect(qid, `${row.gamePlayerId}: QID 없는 선수에게 이력이 붙었다`).toBeDefined();
      const entry = INJURY_HISTORY[qid!]?.find((e) => e.from === row.occurredOn);
      expect(entry, `${qid} ${row.occurredOn}: 표에 없는 부상이다`).toBeDefined();
      expect(row.bodyPart, `${qid} ${row.occurredOn} 부위`).toBe(entry!.part);
      expect(row.expectedReturn, `${qid} ${row.occurredOn} 복귀 예정`).toBe(entry!.until);
      // 부임일 전에 끝난 부상만 닫혀 있다 — 아직 안 끝난 것은 열린 채로 온다
      expect(row.returnedOn, `${qid} ${row.occurredOn} 복귀일`).toBe(
        entry!.until > state.date ? null : entry!.until,
      );
    }
  });

  it("결장이 길수록 성향이 높다", () => {
    // 이름을 박지 않는다 — 씨앗 행의 결장 일수로 양 끝을 뽑는다
    const daysOf = (playerId: string) => injuryHistoryOf(state, playerId).daysOut;
    const ranked = [...researched].sort((a, b) => daysOf(a.id) - daysOf(b.id));
    const least = ranked[0]!;
    const most = ranked[ranked.length - 1]!;
    expect(daysOf(most.id), "표가 한 사람뿐이라 견줄 것이 없다").toBeGreaterThan(daysOf(least.id));
    expect(injuryProneness(state, most.id), `${most.name} vs ${least.name}`).toBeGreaterThan(
      injuryProneness(state, least.id),
    );
    expect(injuryProneness(state, most.id)).toBeGreaterThan(PRONENESS_BASE);
  });

  it("복귀일이 안 지난 선수는 **다친 채로** 인계된다", () => {
    const open = seededRows.filter((i) => i.returnedOn === null);
    expect(open.length, "부임 시점에 다친 선수가 표에 없다").toBeGreaterThan(0);
    for (const row of open) expect(isInjured(state, row.gamePlayerId), row.id).toBe(true);

    // 그리고 tick이 복귀일에 닫는다 — 특별 취급이 없다
    const soonest = [...open].sort((a, b) => (a.expectedReturn < b.expectedReturn ? -1 : 1))[0]!;
    const ticked = createTestGame(42);
    advanceTime(ticked, { days: diffDays(ticked.date, soonest.expectedReturn) + 2 });
    expect(isInjured(ticked, soonest.gamePlayerId)).toBe(false);
  });

  it("겹친 결장은 한 번만 세고 조회 창의 두 끝을 지킨다", () => {
    const game = createTestGame();
    const player = game.players[0]!;
    const from = addDays(game.date, -730);
    game.injuries = [
      {
        id: "old",
        gamePlayerId: player.id,
        cause: "pre_appointment",
        bodyPart: "무릎",
        severity: "major",
        occurredOn: addDays(from, -30),
        expectedReturn: addDays(from, 10),
        returnedOn: addDays(from, 10),
      },
      {
        id: "overlap",
        gamePlayerId: player.id,
        cause: "pre_appointment",
        bodyPart: "발목",
        severity: "minor",
        occurredOn: addDays(from, 5),
        expectedReturn: addDays(from, 20),
        returnedOn: addDays(from, 20),
      },
    ];
    expect(injuryHistoryOf(game, player.id).daysOut).toBe(20);
    expect(injuryHistoryOf(game, player.id).count).toBe(2);
  });
});

describe("간이 시뮬 — 성향은 뛴 선수 전원에게 걸린다", () => {
  /**
   * 세계 하나를 둘이 나눠 쓴다 (`createTestGame`은 한 번에 1초다). **경기를
   * 치르는 검증이 뒤에 온다** — 앞의 것은 읽기만 하므로 순서가 이 방향일 때만
   * 공유가 성립한다.
   */
  const state = createTestGame(11);

  it("부상 추첨도 교체 투입 선수를 후보로 센다", () => {
    const home = simSquadOf(state, "chelsea", leagueOfTeamIn(state, "chelsea"));
    const away = simSquadOf(state, "liverpool", leagueOfTeamIn(state, "liverpool"));
    const starters = new Set([...home.starters, ...away.starters].map((p) => p.id));

    let onSubs = 0;
    let total = 0;
    for (let i = 0; i < 200; i++) {
      for (const tag of quickSimulate(home, away, 3000 + i, `subs:${i}`).injuries) {
        total++;
        if (!starters.has(tag.slice(tag.indexOf(":") + 1))) onSubs++;
      }
    }
    expect(total).toBeGreaterThan(0);
    // 선발만 뽑던 시절엔 정확히 0이었다 (뛴 열넷 중 셋 남짓이 교체 자원이다)
    expect(onSubs).toBeGreaterThan(0);
  });
});

describe("장부는 한 공식만 쓴다", () => {
  it("openInjuryFor는 팀과 무관하게 같은 표에 쓴다 — 치료비만 우리 몫이다", () => {
    const state = createTestGame(5);
    const ours = () => state.finances.find((f) => f.teamId === state.userTeamId)!.ledger.length;
    const rival = playersOf(state, "chelsea")[0]!;
    const before = ours();
    openInjuryFor(state, rival, "match", () => 0.5);
    expect(state.injuries.some((i) => i.gamePlayerId === rival.id)).toBe(true);
    expect(ours()).toBe(before);

    const mine = playersOf(state, state.userTeamId)[0]!;
    openInjuryFor(state, mine, "match", () => 0.5);
    expect(ours()).toBeGreaterThan(before);
  });

  /**
   * **미복귀는 선수당 하나다** (`domain/records.ts` · player.md §5.3). 두 번째 행이
   * 열리면 복귀일이 둘이 되고 — 화면·조회·간이 시뮬이 각자 다른 하나를 집는다 —
   * 성향과 치료비가 한 부상에 두 번 걸린다. 호출부의 `isInjured` 필터는 여기서 다시
   * 확인하지 않으면 없어져도 아무 테스트도 울지 않는 종류의 가드다.
   */
  it("열린 부상이 있는 선수에게 두 번째가 열리지 않는다", () => {
    const state = createTestGame(5);
    const ledger = () => state.finances.find((f) => f.teamId === state.userTeamId)!.ledger.length;
    const mine = playersOf(state, state.userTeamId).find((p) => !isInjured(state, p.id))!;
    const openOf = () =>
      state.injuries.filter((i) => i.gamePlayerId === mine.id && i.returnedOn === null);

    openInjuryFor(state, mine, "match", () => 0.5);
    const first = openOf()[0]!;
    const proneness = injuryProneness(state, mine.id);
    const spent = ledger();

    // 두 번째 굴림은 심각도까지 다르다 — 새 행이 열렸다면 값으로 드러난다
    const again = openInjuryFor(state, mine, "training", () => 0.99);

    expect(openOf()).toEqual([first]);
    // 돌려주는 것은 안고 있는 그 부상이다 — 일어나지 않은 결장을 호출부가 말하지 않는다
    expect(again).toEqual({
      part: first.bodyPart,
      days: diffDays(state.date, first.expectedReturn),
    });
    // 성향도 치료비도 한 부상에 한 번뿐
    expect(injuryProneness(state, mine.id)).toBe(proneness);
    expect(ledger()).toBe(spent);
  });
});

describe("부상 이력 집계의 시간 경계", () => {
  const closed = {
    id: "closed",
    gamePlayerId: "p",
    cause: "match" as const,
    bodyPart: "무릎",
    severity: "minor" as const,
    occurredOn: "2026-06-01",
    expectedReturn: "2026-06-20",
    returnedOn: "2026-06-20",
  };
  const current = {
    ...closed,
    id: "current",
    occurredOn: "2026-06-15",
    expectedReturn: "2026-08-01",
    returnedOn: null,
  };
  const state = { date: "2026-07-01", injuries: [closed, current] };

  it("전체 이력도 겹치는 결장과 미래의 예상 결장을 중복해서 세지 않는다", () => {
    expect(injuryHistoryOf(state, "p", null)).toMatchObject({
      count: 2,
      daysOut: 30,
      last: { open: true, daysAgo: 16 },
    });
    expect(injuryHistoryOf(state, "p", 10)).toMatchObject({ count: 1, daysOut: 10 });
  });

  it("창 시작에 이미 복귀한 행과 미래 발생 행은 제외한다", () => {
    const input = {
      date: "2026-06-30",
      injuries: [closed, { ...current, occurredOn: "2026-07-01" }],
    };
    expect(injuryHistoryOf(input, "p", 10)).toEqual({ count: 0, daysOut: 0, last: null });
  });
});
