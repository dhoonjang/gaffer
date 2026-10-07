import { describe, expect, it } from "vitest";
import {
  isReserveMatch,
  FAMILIARITY_AWAY_TARGET,
  FAMILIARITY_MAX,
  familiarityAfterAwayDay,
  familiarityAwayDayOf,
  ageOf,
  clampFatigue,
  CONDITION_MAX,
  fatigueOf,
  freshPlayerState,
  FATIGUE_BASE,
  FATIGUE_BAND_FLOOR,
  FATIGUE_MAX,
  SESSION_LOAD,
  SESSION_LOAD_DEFAULT,
  sessionLoad,
  type TrainAttr,
} from "@gaffer/domain";
import {
  fatigueAfterDay,
  fatigueDayOf,
  fatigueFromMinutes,
  fatigueFromTraining,
  recoveryFactor,
  stateModifier,
  famFactor,
} from "@gaffer/sim";
import type { PlayerState } from "@gaffer/domain";
import type { GameState } from "@gaffer/engine";
import {
  bindJournal,
  familiarityOf,
  addDays,
  advanceTime,
  CALL_UP_FATIGUE_PER_APP,
  CALL_UP_TRAVEL_FATIGUE,
  diffDays,
  endSeason,
  dueExpiryStage,
  seasonYear,
  assignmentsOf,
  financeOf,
  internationalBreaksOf,
  openCallUp,
  openInjury,
  playersOf,
  PLAYER_REST_MAX_DAYS,
  restingOn,
  setPlayerTraining,
  setTraining,
  trainsWithFirstTeam,
  clockOf,
  userPlayers,
  weeklyWagesOf,
  eventTexts,
  type JournalEntry,
} from "@gaffer/engine";
import {
  advanceDays,
  advanceToMatchday,
  createMiniGame,
  createTestGame,
  drillUserTactics,
  settleMatchdayQuick,
} from "../helpers";

describe("advance_time — 시간은 도구로만 흐른다 (season.md §5)", () => {
  it("프리시즌에서 다음 경기일까지 전진하면 개막전에서 멈춘다", () => {
    const state = createTestGame();
    expect(state.date).toBe("2026-07-01"); // 7/1 프리시즌 시작
    // attention 정지(부상·이적 오퍼)는 넘긴다 — 결국 경기일에서 멈춘다
    let result = advanceTime(state, "next_match");
    let guard = 30;
    while (result.stopped === "attention" && guard-- > 0) {
      result = advanceTime(state, "next_match");
    }
    expect(result.ok).toBe(true);
    expect(result.stopped).toBe("matchday");
    expect(state.phase).toBe("matchday");
    // 멈춘 날은 유저의 첫 경기 날짜
    const first = state.matches
      .filter((m) => m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId)
      .sort((a, b) => (a.date < b.date ? -1 : 1))[0];
    expect(state.date).toBe(first?.date);
    // 사건 배열은 **종류를 달고 나온다** — 화면이 그것으로 카드의 꼬리표를 고른다
    // (season.md §5). 종류가 조용히 전부 `news`로 무너지면 카드가 다 같은 얼굴이 된다.
    const matchday = result.events.filter((e) => e.kind === "matchday");
    expect(matchday.some((e) => e.text.includes("경기일"))).toBe(true);
  });

  /**
   * 하루하루와 남의 경기가 **기록의 사실**로 남는다 (models.md §5-3) — 날짜마다 한
   * 줄, 간이 시뮬 한 경기에 한 줄. 멈춘 날은 멈춘 이유를 든다.
   */
  it("하루하루와 남의 경기가 기록의 사실로 남는다", () => {
    const state = createTestGame();
    const from = state.date;
    const entries: JournalEntry[] = [];
    bindJournal((entry) => entries.push(entry));
    try {
      let result = advanceTime(state, "next_match");
      let guard = 30;
      while (result.stopped === "attention" && guard-- > 0) {
        result = advanceTime(state, "next_match");
      }
      expect(result.stopped).toBe("matchday");

      const days = entries.filter((entry) => entry.kind === "tick.day");
      const elapsed = Math.round((Date.parse(state.date) - Date.parse(from)) / 86_400_000);
      expect(days).toHaveLength(elapsed);
      const last = days.at(-1);
      expect(last?.kind === "tick.day" && last.stopped).toBe("matchday");
      expect(last?.kind === "tick.day" && last.date).toBe(state.date);

      // 결과가 박힌 남의 경기(2군 포함)마다 한 줄 — 감독의 1군 경기는 아직 안 치렀다
      const played = state.matches.filter(
        (m) =>
          m.result &&
          !(
            (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId) &&
            !isReserveMatch(m)
          ),
      );
      expect(entries.filter((entry) => entry.kind === "tick.match")).toHaveLength(played.length);
    } finally {
      bindJournal(null);
    }
  });

  it("경기일에는 시간이 흐르지 않는다 — 경기가 우선", () => {
    const state = createTestGame();
    advanceToMatchday(state);
    const blocked = advanceTime(state, { days: 1 });
    expect(blocked.ok).toBe(false);
    expect(blocked.stopped).toBe("blocked");
  });

  /**
   * **tick은 우리 킥오프 앞까지만 굴린다** — 예전엔 하루치를 통째로 굴려서,
   * 순위표를 열면 "이기면 몇 위"가 이미 확정돼 있었다.
   *
   * 예전 이 케이스는 **리그 1라운드**를 훑었다. 그런데 시즌 첫 경기일은 프리시즌
   * 친선(7/18)이고 1라운드는 한 달 뒤라, `if (m.date > state.date) continue` 가
   * 그 전부를 걸러 **단언이 한 줄도 돌지 않았다.** 그날 실제로 잡혀 있는 경기로 본다.
   */
  it("우리 킥오프와 같은 시각의 남의 경기는 미리 굴러 있지 않다", () => {
    const state = createTestGame();
    advanceToMatchday(state);
    const kickoff = (m: { time?: string }) => m.time ?? "15:00";
    const ours = state.matches.find(
      (m) =>
        m.date === state.date &&
        (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
    )!;
    expect(ours, "경기일인데 우리 경기가 없다").toBeDefined();
    expect(ours.result, "유저 경기를 tick이 굴렸다").toBeNull();

    // 프리시즌 친선은 온 세계가 같은 날 같은 시각에 치른다 — 전부 우리 뒤에 선다
    const notEarlier = state.matches.filter(
      (m) => m.id !== ours.id && m.date === state.date && kickoff(m) >= kickoff(ours),
    );
    expect(notEarlier.length, "같은 날 남의 경기가 없다").toBeGreaterThan(10);
    for (const m of notEarlier) expect(m.result, `${m.id} 우리보다 먼저 굴렀다`).toBeNull();
    // 지난 날짜에 미소화가 남지도 않았다
    expect(state.matches.filter((m) => m.date < state.date && !m.result)).toEqual([]);

    /**
     * 리그 1라운드 편성은 손대지 않은 채 남아 있다 — 우리 리그의 나머지 아홉 경기.
     * (우리 킥오프 뒤에 남의 경기가 굴러가는지는 `quick-sim-events.test.ts`가
     * 실제 리그 경기일을 찾아 잰다 — 프리시즌에는 앞선 킥오프가 존재하지 않는다.)
     */
    const round1 = state.matches.filter(
      (m) =>
        m.competitionId === "epl" &&
        m.round === 1 &&
        m.homeTeamId !== state.userTeamId &&
        m.awayTeamId !== state.userTeamId,
    );
    expect(round1).toHaveLength(9);
  });

  /**
   * 훈련 일정은 코어가 깔지만 **능력치는 코어가 올리지 않는다** — 상승은 결산(LLM)이
   * 낸다(`settleTraining`). 예전 이 자리는 `>= before`만 재고 진짜 단언을
   * `if (오른 경우)` 안에 두어, 코어가 몰래 올려도 초록이었다.
   *
   * 우리 팀 1군은 월간 성장(`developsByCore`)에서도 빠지므로, 훈련만 소화한
   * 두 달은 이 선수의 축을 한 칸도 움직이지 못한다.
   */
  it("훈련 일정은 깔리지만 코어가 능력치를 올리지는 않는다", () => {
    const state = createTestGame(11);
    // 1군만 팀 훈련 일정을 소화한다 — 2군을 고르면 성장 출처가 개발 프로그램(reserve)이 된다
    const young = userPlayers(state).find(
      (p) => p.squadLevel !== "reserve" && ageOf(p.birthdate, state.date) <= 21,
    )!;
    expect(young, "1군 유망주가 없다").toBeDefined();
    const before = { ...young.attributes };
    // 평일 오전·오후 슈팅 훈련 등록 (기본 훈련 없음 → 명령이 일정을 만든다)
    setTraining(state, {
      repeatWeekly: [1, 2, 3, 4, 5].flatMap((dow) => [
        { dow, slot: "am" as const, label: "슈팅 마무리", focus: ["finishing" as const] },
        { dow, slot: "pm" as const, label: "슈팅 마무리", focus: ["finishing" as const] },
      ]),
      weeks: 3,
    });
    expect(state.schedule.filter((e) => e.type === "training").length).toBeGreaterThan(10);

    for (let i = 0; i < 20; i++) {
      const r = advanceTime(state, { days: 3 });
      if (!r.ok || r.stopped === "matchday") break;
    }
    // 일정은 실제로 소화됐다 — 날짜가 훈련 구간을 지났다
    expect(state.date > "2026-07-13").toBe(true);
    expect(young.attributes, "코어가 훈련만으로 능력치를 올렸다").toEqual(before);
    expect(
      state.growthLog.filter((g) => g.gamePlayerId === young.id && g.source === "training"),
      "결산 없이 훈련 성장 로그가 생겼다",
    ).toEqual([]);
  });

  it("전술 훈련은 결산에 넘길 기준값만 낸다 — 코어가 직접 올리지 않는다", () => {
    const state = createTestGame(5);
    const assignment = assignmentsOf(state, state.userTeamId, "starting")[0]!;
    const before = assignment.familiarity;
    setTraining(state, {
      repeatWeekly: [1, 2, 3, 4, 5].map((dow) => ({
        dow,
        slot: "am" as const,
        label: "전술 조직 훈련",
        focus: ["tactical" as const],
      })),
      weeks: 2,
    });
    advanceDays(state, 8);
    const after = assignmentsOf(state, state.userTeamId, "starting").find(
      (a) => a.playerId === assignment.playerId,
    );
    // 상승은 훈련 결산(LLM)만이 낸다 — 코어는 기준값을 계산해 넘길 뿐이다
    expect(after?.familiarity ?? 0, "코어가 몰래 올렸다").toBe(before);
  });

  it("주급이 매주 월요일 팀 재정에서 빠져나간다 (계약 합)", () => {
    const state = createTestGame();
    const finance = financeOf(state, state.userTeamId);
    const before = finance.balance;
    const wages = weeklyWagesOf(state, state.userTeamId);
    advanceDays(state, 8); // 최소 한 번의 월요일 포함
    // 유저 팀 원장은 선수별로 적힌다 (§4.2) — 한 날짜의 합이 계약 합이다
    const paid = finance.ledger.filter((l) => l.category === "player_wages");
    const byDate = new Map<string, number>();
    for (const e of paid) byDate.set(e.date, (byDate.get(e.date) ?? 0) + e.amount);
    expect(byDate.size).toBeGreaterThanOrEqual(1);
    for (const [date, sum] of byDate) {
      // 항목마다 반올림하므로 합계가 계약 합에서 항목 수만큼 어긋날 수 있다
      const lines = paid.filter((e) => e.date === date).length;
      expect(Math.abs(sum - wages), date).toBeLessThanOrEqual(lines);
    }
    // 잔고는 원장 전체와 맞는다 — 같은 기간에 중계권·스폰서 수입도 들어온다
    const net = finance.ledger
      .filter((l) => l.accounting !== "noncash")
      .reduce((s, l) => s + (l.kind === "income" ? l.amount : -l.amount), 0);
    expect(finance.balance).toBe(before + net);
  });

  it("부상은 INJURY row로 기록되고 복귀 시 이력으로 닫힌다", () => {
    const state = createTestGame(3);
    const victim = userPlayers(state)[3]!;
    // 부상을 직접 열고 tick이 복귀를 처리하는지 확인
    state.injuries.push({
      id: "inj-test",
      gamePlayerId: victim.id,
      bodyPart: "발목",
      severity: "minor",
      cause: "training",
      occurredOn: state.date,
      expectedReturn: state.date, // 오늘 복귀 예정
      returnedOn: null,
    });
    expect(openInjury(state, victim.id)).not.toBeNull();
    advanceDays(state, 2);
    expect(openInjury(state, victim.id)).toBeNull();
    // 이력은 남는다
    expect(state.injuries.find((i) => i.id === "inj-test")?.returnedOn).toBeTruthy();
  });

  it("AI 팀도 재정·주급이 돌아간다", () => {
    const state = createTestGame();
    const ai = state.teams.find((t) => t.id !== state.userTeamId)!;
    const before = financeOf(state, ai.id).balance;
    expect(weeklyWagesOf(state, ai.id)).toBeGreaterThan(0);
    expect(playersOf(state, ai.id).length).toBeGreaterThan(11);
    advanceDays(state, 8);
    expect(financeOf(state, ai.id).balance).not.toBe(before);
  });
});

/**
 * 하루 안의 시각 — 장부의 시간(날짜)과 장면의 시간을 가른다.
 * 같은 날 안에서는 굴릴 것이 없으므로 tick이 돌지 않아야 한다.
 */
describe("시각 축", () => {
  it("같은 날 안의 이동은 날짜도 장부도 건드리지 않는다", () => {
    const state = createTestGame(9);
    const date = state.date;
    const growthBefore = state.growthLog.length;

    const res = advanceTime(state, { clock: "14:30" });
    expect(res.ok).toBe(true);
    expect(state.date).toBe(date);
    expect(clockOf(state)).toBe("14:30");
    expect(state.growthLog.length).toBe(growthBefore);
  });

  it("지난 시각으로는 돌아갈 수 없다", () => {
    const state = createTestGame(9);
    advanceTime(state, { clock: "19:00" });
    const res = advanceTime(state, { clock: "09:30" });
    expect(res.ok).toBe(false);
    expect(clockOf(state)).toBe("19:00");
  });

  it("날짜가 넘어가면 하루의 시작으로 돌아온다", () => {
    const state = createTestGame(9);
    advanceTime(state, { clock: "19:00" });
    advanceTime(state, { days: 1 });
    expect(clockOf(state)).toBe("09:00");
  });
});

describe("계약 만료 예고 — 문턱마다 한 번 (season.md §5)", () => {
  it("넘어선 문턱 중 가장 낮은 것만, 이미 낸 단계는 다시 내지 않는다", () => {
    expect(dueExpiryStage(181, undefined)).toBeNull();
    expect(dueExpiryStage(180, undefined)).toBe(180);
    // 하루로 재지 않는다 — 문턱 날에 tick이 없었어도 다음 날 선다
    expect(dueExpiryStage(179, undefined)).toBe(180);
    expect(dueExpiryStage(100, 180)).toBeNull();
    expect(dueExpiryStage(89, 180)).toBe(90);
    // 최종전이 5월 말인 시즌 — 30일 문턱(05-31)에 닿는 날이 아예 없다
    expect(dueExpiryStage(31, 90)).toBeNull();
    // 시즌이 끝나는 tick은 남은 문턱을 소진한다
    expect(dueExpiryStage(0, 90)).toBe(30);
    expect(dueExpiryStage(0, 30)).toBeNull();
  });

  it("최종전 뒤 30일 문턱에 tick이 없는 시즌에도 세 문턱이 한 번씩 나간다", () => {
    const state = createMiniGame();
    const player = userPlayers(state)[0]!;
    const contract = state.contracts.find(
      (c) => c.gamePlayerId === player.id && c.status === "active",
    )!;
    const expiresOn = `${seasonYear(state.season) + 1}-06-30`;
    contract.until = expiresOn;

    const warnings: string[] = [];
    let lastTicked = state.date;
    for (let i = 0; i < 400; i++) {
      const result = advanceTime(state, "next_match");
      expect(result.ok, eventTexts(result.events).join(" / ")).toBe(true);
      warnings.push(
        ...eventTexts(result.events).filter((d) => d.includes(`${player.name}의 계약이`)),
      );
      if (result.stopped === "season_end") break;
      lastTicked = state.date;
      if (result.stopped === "matchday") {
        drillUserTactics(state, 7);
        settleMatchdayQuick(state);
      }
    }

    // 이 시즌은 30일 문턱을 지나지 않는다 — 최종전이 05-31보다 앞이다
    expect(diffDays(lastTicked, expiresOn)).toBeGreaterThan(30);
    expect(warnings.map((line) => line.match(/계약이 (\d+)일/)?.[1])).toEqual([
      "180",
      "90",
      String(diffDays(lastTicked, expiresOn)),
    ]);
  });
});

/**
 * 전술 적응도의 **결장 감쇠** (player.md §7.4).
 *
 * 곡선 자체는 순수 함수라 세계를 세우지 않고 직접 부른다. 세계가 필요한 것은
 * "리그 전체가 같은 규칙으로 도는가"와 "훈련장에 있으면 잃지 않는가" 둘뿐이다.
 *
 * ⚠️ 이 감쇠가 **「오래 못 뛰었다」의 대가를 진다.** 능력치를 평평하게 깎는 항이
 * 아니라 판을 몸으로 기억하는 정도로 서므로, 같은 결장이라도 중원이 최전방보다
 * 크게 문다 (`famFactor`).
 */
describe("전술 적응도의 결장 감쇠 (player.md §7.4)", () => {
  it("클럽에 있는 하루는 끌지 않는다 — 주말도 훈련 주간의 일부다", () => {
    expect(familiarityAwayDayOf(false, false)).toBeNull();
    // 감독이 뺀 기간 · 대표팀 · 여름 휴가 — 셋이 같은 하루다 (`offSite`)
    expect(familiarityAwayDayOf(true, false)).toBe("idle");
    // 재활은 그보다 아래다 — 팀 훈련에서 떨어져 있는 시간이다
    expect(familiarityAwayDayOf(false, true)).toBe("rehab");
    expect(familiarityAwayDayOf(true, true)).toBe("rehab");
  });

  it("자리 쪽으로만 끌린다 — 아래에 있는 값을 끌어올리지 않는다", () => {
    expect(familiarityAfterAwayDay(90, "idle")).toBeLessThan(90);
    expect(familiarityAfterAwayDay(FAMILIARITY_AWAY_TARGET.idle, "idle")).toBeCloseTo(
      FAMILIARITY_AWAY_TARGET.idle,
      10,
    );
    // 오르는 길은 판정 하나뿐이다 (§7) — 감쇠가 대신 올려 주지 않는다
    expect(familiarityAfterAwayDay(20, "idle")).toBe(20);
    expect(familiarityAfterAwayDay(20, "rehab")).toBe(20);
    // 재활이 더 빨리 빠진다 — 팀 훈련이 잡아 주는 것이 없다
    expect(familiarityAfterAwayDay(90, "rehab")).toBeLessThan(familiarityAfterAwayDay(90, "idle"));
  });

  it("90일 재활이면 판이 몸에서 빠진다 — 돌아온 날 온전한 전력이 아니다", () => {
    let hurt = FAMILIARITY_MAX;
    for (let d = 0; d < 90; d++) hurt = familiarityAfterAwayDay(hurt, "rehab");
    // 「익히는 중」 아래 — 완숙으로 돌아오지 않는다
    expect(hurt).toBeLessThan(45);
    // 그 대가는 자리마다 다르다: 중원이 최전방보다 크게 문다
    expect(famFactor(hurt, "CM")).toBeLessThan(famFactor(hurt, "ST"));
    expect(famFactor(hurt, "CM")).toBeLessThan(0.9);
  });

  it("여름 휴가가 프리시즌을 만든다 — 6주를 쉬면 완숙으로 열지 못한다", () => {
    let rested = FAMILIARITY_MAX;
    for (let d = 0; d < 42; d++) rested = familiarityAfterAwayDay(rested, "idle");
    expect(rested).toBeLessThan(90);
    expect(rested).toBeGreaterThan(FAMILIARITY_AWAY_TARGET.idle);
  });

  it("재활 중인 선수만 빠진다 — 훈련장에 있는 선수는 그대로다", () => {
    const state = createTestGame(7);
    const starters = assignmentsOf(state, state.userTeamId, "starting");
    const hurtId = starters[0]!.playerId;
    const fitId = starters[1]!.playerId;
    for (const a of starters) a.familiarity = 90;
    state.injuries.push({
      id: `inj-test-${hurtId}`,
      gamePlayerId: hurtId,
      bodyPart: "햄스트링",
      severity: "major",
      cause: "training",
      occurredOn: state.date,
      expectedReturn: addDays(state.date, 90),
      returnedOn: null,
    });
    advanceDays(state, 7);
    expect(familiarityOf(state, hurtId)).toBeLessThan(90);
    // 훈련장에 있었던 선수는 한 칸도 잃지 않는다 — 오르는 길만 판정의 것이다
    expect(familiarityOf(state, fitId)).toBe(90);
  });
});

/**
 * **누적 피로 — 시즌이 몸에 쌓는 잔고** (player.md §5.5).
 *
 * 화면에 보이는 등급·문장은 여기서 재지 않는다. 재는 것은 눈에 안 띄게 어긋나는
 * 것들이다: 적립·해소 곡선의 경계, 전력에 닿지 않는다는 계약, 리그 전체가 같은
 * 눈금으로 도는가, 시즌 전환이 통을 비우는가, 그리고 개인 휴식이라는 상태 전이.
 */
describe("누적 피로 (player.md §5.5)", () => {
  it("새 선수의 통은 비어 있고, 전력에는 한 칸도 닿지 않는다", () => {
    const old: PlayerState = freshPlayerState({ form: 0, condition: 75 });
    expect(fatigueOf(old)).toBe(FATIGUE_BASE);
    // ⚠️ 이 축의 계약 — 유효 능력치의 항은 폼·체력 둘뿐이다 (적응도는 `famFactor`가 따로 문다)
    expect(stateModifier({ ...old, fatigue: FATIGUE_MAX })).toBe(stateModifier(old));
    expect(clampFatigue(-5)).toBe(0);
    expect(clampFatigue(FATIGUE_MAX + 5)).toBe(FATIGUE_MAX);
  });

  it("적립은 분에 비례하고, 덜 회복된 몸으로 나설수록 더 남는다", () => {
    expect(fatigueFromMinutes(0, 100)).toBe(0);
    // 45분 두 번은 90분 한 번과 같다 — 교체로 나눠 뛴 선수가 손해 보지 않는다
    expect(fatigueFromMinutes(45, 100) * 2).toBeCloseTo(fatigueFromMinutes(90, 100), 10);
    // **연전 간격 항** — 같은 90분이 지친 몸에 더 남는다 (킥오프 체력이 곧 간격이다)
    expect(fatigueFromMinutes(90, 60)).toBeGreaterThan(fatigueFromMinutes(90, 100));
    expect(fatigueFromMinutes(90, 20)).toBeGreaterThan(fatigueFromMinutes(90, 60));
    // 체력이 0이어도 배수는 유한하다 — 한 경기가 통을 채우지는 않는다
    expect(fatigueFromMinutes(90, 0)).toBeLessThan(FATIGUE_BAND_FLOOR.building);
    // 훈련은 부하에 비례한다 — 프리시즌 이중 세션이 그대로 두 배다
    expect(fatigueFromTraining(2)).toBeCloseTo(fatigueFromTraining(1) * 2, 10);
    expect(fatigueFromTraining(0)).toBe(0);
  });

  it("세션의 부하는 종류가 정한다 — 몸을 쓰는 세션이 무겁고 회복 세션이 가볍다", () => {
    const load = (focus: TrainAttr[]) => sessionLoad(focus);
    expect(load(["stamina", "strength"])).toBe(SESSION_LOAD.physical);
    expect(load(["stamina"])).toBeGreaterThan(load(["passing"]));
    expect(load(["passing"])).toBeGreaterThan(load(["tactical"]));
    expect(load(["tactical"])).toBeGreaterThan(load(["recovery"]));
    expect(load(["recovery"])).toBeGreaterThan(0);
    // 섞인 세션은 평균이다 — 항목을 늘려 부하를 부풀릴 수 없다
    expect(load(["pace", "dribbling"])).toBeCloseTo(
      (SESSION_LOAD.physical + SESSION_LOAD.technical) / 2,
      10,
    );
    expect(load([])).toBe(SESSION_LOAD_DEFAULT);
  });

  it("해소는 남은 양에 비례하고, 훈련장을 떠난 날이 가장 빠르다", () => {
    expect(fatigueAfterDay(0, "training")).toBe(0);
    // 위에 있을수록 많이 빠진다 — 고정폭이면 격주로 뛰는 선수가 0에 눕는다
    expect(80 - fatigueAfterDay(80, "idle")).toBeGreaterThan(20 - fatigueAfterDay(20, "idle"));
    // 본훈련 < 훈련 없는 날 < 회복 세션 < 휴식 순으로 빨라진다
    expect(fatigueAfterDay(80, "training")).toBeGreaterThan(fatigueAfterDay(80, "idle"));
    expect(fatigueAfterDay(80, "idle")).toBeGreaterThan(fatigueAfterDay(80, "recovery"));
    expect(fatigueAfterDay(80, "recovery")).toBeGreaterThan(fatigueAfterDay(80, "rest"));
    // 0 아래로 내려가지 않는다 — 지수라 닿지도 않는다
    let left = 80;
    for (let d = 0; d < 400; d++) left = fatigueAfterDay(left, "rest");
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThan(0.001);
  });

  it("하루의 성격은 회복 눈금과 같고, 훈련장 밖만 따로 본다", () => {
    expect(fatigueDayOf("training", false)).toBe("training");
    expect(fatigueDayOf("recovery", false)).toBe("recovery");
    expect(fatigueDayOf("idle", false)).toBe("idle");
    expect(fatigueDayOf("training", true)).toBe("rest");
  });

  it("잔고는 회복 배율에만 곱해진다 — 소모에는 걸리지 않는다", () => {
    const state = createTestGame(7);
    const player = userPlayers(state)[0]!;
    const fresh = recoveryFactor(player);
    player.state.fatigue = FATIGUE_MAX;
    expect(recoveryFactor(player)).toBeLessThan(fresh);
    // 잔고 0이면 옛 세이브와 값이 같다 — 셈이 한 칸도 달라지지 않는다
    player.state.fatigue = 0;
    expect(recoveryFactor(player)).toBe(fresh);
  });

  it("남의 팀 잔고도 하루마다 움직인다 — 감독 팀에만 걸리지 않는다", () => {
    const state = createTestGame(7);
    const mine = userPlayers(state)[0]!;
    const theirs = playersOf(state, "mancity")[0]!;
    mine.state.fatigue = 60;
    theirs.state.fatigue = 60;
    advanceDays(state, 5);
    /**
     * 남의 팀이 멈춰 있으면 12월에 우리만 회복이 늦고 우리만 부상 저울이 올라
     * 순위표가 규칙이 아니라 규칙의 비대칭으로 기운다.
     *
     * ⚠️ **두 값이 같기를 요구하지는 않는다** — 하루의 성격이 다르면 속도도 다르고
     * (여기 프리시즌은 우리가 휴가, 남의 팀은 본훈련이다) 그건 규칙이 같다는 것과
     * 다른 말이다. 우리와 리그의 격차가 밴드 안인지는 `pnpm balance live-season`(`ai-fitness`)가
     * 한 시즌을 돌려 잰다 (AGENTS.md §5 — 밸런스는 하네스의 일이다).
     */
    expect(fatigueOf(mine.state)).toBeLessThan(60);
    expect(fatigueOf(theirs.state)).toBeLessThan(60);
  });

  it("시즌 전환이 누적 피로를 초기화한다", () => {
    const state = createTestGame(42, "arsenal");
    state.date = "2027-06-01";
    for (const p of state.players) {
      p.state.fatigue = 90;
    }
    endSeason(state);
    expect(state.players.length).toBeGreaterThan(0);
    for (const p of state.players) {
      expect(fatigueOf(p.state)).toBe(FATIGUE_BASE);
    }
  });

  it("개인 휴식 — 걸린 동안만 훈련장에서 빠지고, 기간이 끝나면 돌아온다", () => {
    const state = createTestGame(7);
    const player = userPlayers(state).find((p) => trainsWithFirstTeam(state, p))!;
    const until = addDays(state.date, 3);
    expect(setPlayerTraining(state, { playerId: player.id, rest: { until } }).ok).toBe(true);

    expect(restingOn(state, player.id)).toBe(true);
    // 결산 브리프도 훈련 부상 후보도 이 문 하나를 지난다 (season.md §8 불변식)
    expect(trainsWithFirstTeam(state, player)).toBe(false);
    // 기한 마지막 날까지는 그대로 쉬고, 그 이튿날 훈련장으로 돌아온다
    expect(restingOn(state, player.id, until)).toBe(true);
    expect(restingOn(state, player.id, addDays(until, 1))).toBe(false);
    advanceDays(state, 4);
    expect(restingOn(state, player.id)).toBe(false);
    expect(trainsWithFirstTeam(state, player)).toBe(true);
  });

  it("개인 휴식은 걸어 둔 축을 지우지 않고, 지난 날짜와 한 달 넘는 기간은 반려한다", () => {
    const state = createTestGame(7);
    const player = userPlayers(state)[0]!;
    expect(setPlayerTraining(state, { playerId: player.id, axis: "passing" }).ok).toBe(true);
    expect(
      setPlayerTraining(state, { playerId: player.id, rest: { until: addDays(state.date, 5) } }).ok,
    ).toBe(true);
    // 쉬는 것과 무엇을 배우는지는 다른 지시다 — 한쪽이 다른 쪽을 조용히 거두지 않는다
    const program = state.playerTraining.find((t) => t.gamePlayerId === player.id)!;
    expect(program.axis).toBe("passing");
    expect(program.rest?.until).toBe(addDays(state.date, 5));

    expect(
      setPlayerTraining(state, { playerId: player.id, rest: { until: addDays(state.date, -1) } })
        .ok,
    ).toBe(false);
    expect(
      setPlayerTraining(state, {
        playerId: player.id,
        rest: { until: addDays(state.date, PLAYER_REST_MAX_DAYS) },
      }).ok,
    ).toBe(false);
    // 반려는 아무것도 바꾸지 않는다 — 걸려 있던 휴식이 그대로다
    expect(state.playerTraining.find((t) => t.gamePlayerId === player.id)?.rest?.until).toBe(
      addDays(state.date, 5),
    );
    // 거두는 문은 하나 — 축·자리·휴식이 함께 간다
    expect(setPlayerTraining(state, { playerId: player.id, clear: true }).ok).toBe(true);
    expect(state.playerTraining.some((t) => t.gamePlayerId === player.id)).toBe(false);
  });
});

/**
 * **A매치 휴식기는 빈 주말이 아니라 사건이다** (→ docs/season/competition.md §5-1).
 *
 * tick이 창의 첫날에 세계의 소집을 열고 마지막 날에 정산한다. 창까지 두 달을
 * 굴리지 않고 **전야로 옮겨** 하루씩 민다 — 지나온 경기들은 결과 없이 남지만
 * 소집이 읽는 것은 오늘의 명단과 시즌 출전뿐이다.
 */
describe("A매치 휴식기 — 소집과 복귀", () => {
  /** 9월 창의 전야에 선 세이브 */
  function atBreakEve(): { state: GameState; window: { from: string; to: string } } {
    const state = createTestGame();
    const window = internationalBreaksOf(state.season)[0]!;
    state.date = addDays(window.from, -1);
    return { state, window };
  }

  /** 그 날짜까지 하루씩 — 창 안에 경기가 걸리면 치르고 지나간다 (3월 창엔 컵 결승이 선다) */
  function tickTo(state: GameState, target: string): void {
    let guard = 20;
    while (state.date < target && guard-- > 0) {
      const advanced = advanceTime(state, { days: 1 });
      if (!advanced.ok) throw new Error(eventTexts(advanced.events).join(" / "));
      if (advanced.stopped === "matchday") settleMatchdayQuick(state);
    }
    expect(state.date).toBe(target);
  }

  /** 그 창이 남긴 사실 전부 — 누가 몇 경기 뛰고 어떤 몸으로 돌아왔나 */
  function snapshot(state: GameState): string {
    const condition = new Map(userPlayers(state).map((p) => [p.id, p.state.condition]));
    return state.callUps
      .map((c) =>
        [c.gamePlayerId, c.apps, c.goals, c.returnState, condition.get(c.gamePlayerId)].join(":"),
      )
      .sort()
      .join("|");
  }

  it("같은 세이브는 같은 명단·같은 몸을 돌려주고, 열린 소집을 남기지 않는다", () => {
    const runs = [0, 1].map(() => {
      const { state, window } = atBreakEve();
      tickTo(state, window.to);
      return state;
    });
    const first = snapshot(runs[0]!);
    expect(first).not.toBe("");
    expect(snapshot(runs[1]!)).toBe(first);
    // 소집과 복귀는 짝이다 — 창이 닫히면 클럽 밖에 남는 선수가 없다
    for (const state of runs) {
      expect(state.callUps.filter((c) => c.returnedOn === null)).toHaveLength(0);
    }
  });

  it("소집된 선수는 우리 훈련장에 서지 않는다", () => {
    const { state, window } = atBreakEve();
    tickTo(state, window.from);
    const called = userPlayers(state).filter((p) => openCallUp(state, p.id) !== null);
    expect(called.length).toBeGreaterThan(0);
    for (const player of called) expect(trainsWithFirstTeam(state, player)).toBe(false);
    // 창이 팀을 통째로 비우지는 않는다 — 남은 선수의 훈련장은 그대로다
    expect(userPlayers(state).some((p) => trainsWithFirstTeam(state, p))).toBe(true);
  });

  it("이동과 출전만큼 깎여 돌아온다", () => {
    const { state, window } = atBreakEve();
    tickTo(state, addDays(window.to, -1));
    const twoCaps = userPlayers(state).find((p) => openCallUp(state, p.id)?.apps === 2);
    expect(twoCaps).toBeDefined();
    // 마지막 날의 회복은 상한에 막힌다 — 그 위에 얹히는 것이 정산뿐이 되도록
    twoCaps!.state.condition = CONDITION_MAX;
    tickTo(state, window.to);
    expect(twoCaps!.state.condition).toBe(
      CONDITION_MAX - CALL_UP_TRAVEL_FATIGUE - 2 * CALL_UP_FATIGUE_PER_APP,
    );
  });
});
