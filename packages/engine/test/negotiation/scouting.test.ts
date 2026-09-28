import { describe, expect, it } from "vitest";
import {
  advanceTime,
  knowledgeOf,
  loanPlayer,
  potentialMargin,
  observedRating,
  playersOf,
  POTENTIAL_FLOOR,
  settlingOf,
  potentialBand,
  scoutedAttributes,
  userPlayers,
  AXIS_OBSERVABILITY,
  OBSERVATION_MARGIN,
  readCondition,
  conditionMargin,
  SCOUT_ATTRS,
  type GameState,
  playerById,
  buildOfficeViews,
  changeScoutingRequest,
  applyScoutingPlan,
  captureScoutingEvidence,
  completeScoutingReport,
  scoutingEvidence,
  failScouting,
  scoutingLookup,
  scoutReportCard,
  addDays,
} from "@story-fm/engine";
import { type ScoutingPlan, type ScoutingRequest, type ScoutingAssessment } from "@story-fm/domain";
import { GASSED_CONDITION } from "@story-fm/sim";
import { createTestGame, advanceAndPlay, settleFully } from "../helpers";
function anyOpponent(state: GameState) {
  return playersOf(state, "chelsea")[0]!;
}
describe("지식 수준 파생", () => {
  it("우리 선수는 own — 능력치는 정확하지만 잠재력은 구간으로만 안다", () => {
    const state = createTestGame(11);
    const mine = userPlayers(state)[0]!;
    expect(knowledgeOf(state, mine.id)).toBe("own");
    for (const attr of scoutedAttributes(state, mine)) {
      expect(attr.exact).not.toBeNull();
    }
    // 잠재력만은 우리 선수도 단정하지 못한다 — 성장은 예언이 아니다
    const band = potentialBand(state, mine);
    expect(band).not.toBeNull();
    expect(band!.margin).toBeGreaterThanOrEqual(POTENTIAL_FLOOR);
  });

  /**
   * 임대 — **소속이 아니라 계약이 눈금을 정한다** (player.md §9).
   * 우리 계약의 유망주가 나가는 순간 능력치에 오차가 붙으면, 돌아온 날 감독이
   * "누가 얼마나 자랐는가"를 잃는다.
   */
  it("임대 보낸 우리 선수는 남의 셔츠를 입어도 own — 능력치는 그대로 정확하다", () => {
    const state = createTestGame(11);
    const target = userPlayers(state)
      .slice()
      .sort((a, b) => a.attributes.overall - b.attributes.overall)
      .find((p) => p.positions[0]?.position !== "GK")!;
    const res = loanPlayer(state, { playerId: target.id, teamId: "chelsea" });
    expect(res.ok, res.message).toBe(true);

    const after = playerById(state, target.id)!;
    expect(after.teamId).toBe("chelsea");
    expect(knowledgeOf(state, after.id)).toBe("own");
    for (const attr of scoutedAttributes(state, after)) {
      expect(attr.exact).not.toBeNull();
    }
  });

  it("빌린 구단의 출전은 잠재력 폭을 좁히지 않는다 — 매일 보는 것과 리포트는 다른 표본이다", () => {
    const state = createTestGame(11);
    const target = userPlayers(state)
      .slice()
      .sort((a, b) => a.attributes.overall - b.attributes.overall)
      .find((p) => p.positions[0]?.position !== "GK")!;
    const before = potentialMargin(state, target.id);
    expect(loanPlayer(state, { playerId: target.id, teamId: "chelsea" }).ok).toBe(true);

    // 그 셔츠로 한 시즌을 다 뛰어도 우리가 재는 폭은 그대로다
    state.seasonStats.push({
      gamePlayerId: target.id,
      season: state.season,
      teamId: "chelsea",
      competitionId: "epl",
      apps: 38,
      goals: 0,
    });
    expect(knowledgeOf(state, target.id)).toBe("own");
    expect(potentialMargin(state, target.id)).toBe(before);
  });

  it("남의 팀끼리의 임대는 걸리지 않는다 — 문이 읽는 것은 임대의 방향이다", () => {
    const state = createTestGame(11);
    const other = anyOpponent(state);
    const elsewhere = state.teams.find(
      (t) => t.id !== state.userTeamId && t.id !== other.teamId,
    )!.id;
    other.loan = { fromTeamId: other.teamId, until: `${state.season + 1}-06-30`, wageShare: 0.5 };
    other.teamId = elsewhere;
    expect(knowledgeOf(state, other.id)).toBe("rumoured");
  });

  it("만난 적 없는 타 팀 선수는 rumoured — 숫자를 감추고 잠재력도 미지", () => {
    const state = createTestGame(11);
    const other = anyOpponent(state);
    expect(knowledgeOf(state, other.id)).toBe("rumoured");
    for (const attr of scoutedAttributes(state, other)) {
      expect(attr.exact).toBeNull();
    }
    expect(potentialBand(state, other)).toBeNull();
  });

  it("맞대결에서 실제로 뛴 선수만 seen이 된다 (벤치에만 앉은 선수는 아니다)", () => {
    const state = createTestGame(11);
    advanceAndPlay(state); // 첫 경기를 끝까지
    // 우리가 치른 경기 — 같은 날 다른 팀 경기도 시뮬되므로 유저 경기를 명시적으로 찾는다
    const played = state.matches.find(
      (m) => m.result && (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
    )!;
    const userIsHome = played.homeTeamId === state.userTeamId;
    const opponentId = userIsHome ? played.awayTeamId : played.homeTeamId;
    const lineup = (userIsHome ? played.result!.awayLineup : played.result!.homeLineup) ?? [];
    expect(lineup.length).toBeGreaterThanOrEqual(11);

    for (const id of lineup) expect(knowledgeOf(state, id)).toBe("seen");

    // 같은 팀인데 출전 명단에 없던 선수는 여전히 평판 수준
    const benched = playersOf(state, opponentId).find((p) => !lineup.includes(p.id));
    expect(benched).toBeDefined();
    expect(knowledgeOf(state, benched!.id)).toBe("rumoured");
  });

  it("우리가 없던 경기의 선수는 seen이 되지 않는다 (남의 경기는 못 본다)", () => {
    const state = createTestGame(11);
    advanceAndPlay(state);
    // 우리 경기는 금요일 개막전일 수 있다 — 라운드가 끝나도록 며칠 더 보내
    // 타 팀 경기(간이 시뮬)가 치러지게 한다
    advanceTime(state, { days: 5 });
    const otherMatch = state.matches.find(
      (m) =>
        m.result &&
        m.homeTeamId !== state.userTeamId &&
        m.awayTeamId !== state.userTeamId &&
        (m.result.homeLineup?.length ?? 0) > 0,
    );
    expect(otherMatch).toBeDefined();
    const someone = otherMatch!.result!.homeLineup![0]!;
    expect(knowledgeOf(state, someone)).toBe("rumoured");
  });

  it("분석형 축이 관측형보다 넓게 틀린다 — 계층이 실제로 다르게 작동한다", () => {
    const state = createTestGame(11);
    const errorOf = (layer: "observable" | "analytical", knowledge: "seen" | "rumoured") => {
      let sum = 0;
      let n = 0;
      for (const p of playersOf(state, "chelsea")) {
        for (const axis of SCOUT_ATTRS) {
          if (AXIS_OBSERVABILITY[axis] !== layer) continue;
          sum += Math.abs(
            observedRating(state, p.id, axis, p.attributes[axis], knowledge) - p.attributes[axis],
          );
          n++;
        }
      }
      return sum / n;
    };
    expect(errorOf("analytical", "seen")).toBeGreaterThan(errorOf("observable", "seen"));
    expect(errorOf("analytical", "rumoured")).toBeGreaterThan(errorOf("observable", "rumoured"));
  });
});

describe("관측 오차", () => {
  it("결정적이다 — 같은 선수·능력치는 항상 같은 관측값", () => {
    const state = createTestGame(11);
    const other = anyOpponent(state);
    const first = SCOUT_ATTRS.map((a) => observedRating(state, other.id, a, other.attributes[a]));
    const second = SCOUT_ATTRS.map((a) => observedRating(state, other.id, a, other.attributes[a]));
    expect(second).toEqual(first);
  });

  it("오차는 축의 계층별 상한 안에 머문다 (관측형 ±3/±6 · 분석형 ±6/±10)", () => {
    const state = createTestGame(11);
    for (const p of playersOf(state, "chelsea")) {
      for (const attr of SCOUT_ATTRS) {
        const trueValue = p.attributes[attr];
        const rumoured = observedRating(state, p.id, attr, trueValue, "rumoured");
        const seen = observedRating(state, p.id, attr, trueValue, "seen");
        const layer = AXIS_OBSERVABILITY[attr];
        expect(Math.abs(rumoured - trueValue)).toBeLessThanOrEqual(
          OBSERVATION_MARGIN[layer].rumoured,
        );
        expect(Math.abs(seen - trueValue)).toBeLessThanOrEqual(OBSERVATION_MARGIN[layer].seen);
        expect(rumoured).toBeGreaterThanOrEqual(1);
        expect(rumoured).toBeLessThanOrEqual(99);
      }
    }
  });

  it("실제로 흔들린다 — 전원이 참값과 같지는 않다", () => {
    const state = createTestGame(11);
    const shifted = playersOf(state, "chelsea").filter((p) =>
      SCOUT_ATTRS.some(
        (a) => observedRating(state, p.id, a, p.attributes[a], "rumoured") !== p.attributes[a],
      ),
    );
    expect(shifted.length).toBeGreaterThan(5);
  });

  it("안개는 표현 계층 전용 — 선수의 실제 능력치는 그대로다", () => {
    const state = createTestGame(11);
    const other = anyOpponent(state);
    const before = { ...other.attributes };
    scoutedAttributes(state, other);
    observedRating(state, other.id, "pace", other.attributes.pace);
    expect(other.attributes).toEqual(before);
  });
});

describe("영입 직후 — 안개는 날짜가 아니라 정착으로 걷힌다", () => {
  /** 타 팀 선수를 우리 팀으로 옮기고 TRANSFER 원장에 남긴다 (협상 명령의 결과만 모사) */
  function signPlayer(state: ReturnType<typeof createTestGame>, playerId: string) {
    const player = playerById(state, playerId)!;
    const fromTeamId = player.teamId;
    player.teamId = state.userTeamId;
    state.transfers.push({
      id: `t-${playerId}`,
      gamePlayerId: playerId,
      windowId: null,
      fromTeamId,
      toTeamId: state.userTeamId,
      date: state.date,
      type: "transfer",
      fee: 0,
    });
  }

  it("영입 당일은 adapting — 우리 선수인데도 수치를 단정하지 못한다", () => {
    const state = createTestGame(11);
    const target = anyOpponent(state);
    signPlayer(state, target.id);

    expect(knowledgeOf(state, target.id)).toBe("adapting");
    for (const attr of scoutedAttributes(state, target)) {
      expect(attr.exact, `${attr.key}는 정착 전엔 확정되지 않는다`).toBeNull();
    }
    // 오차 폭은 스카우트 수준에서 출발한다
    for (const axis of SCOUT_ATTRS) {
      const limit = OBSERVATION_MARGIN[AXIS_OBSERVABILITY[axis]].adapting;
      const observed = observedRating(state, target.id, axis, target.attributes[axis]);
      expect(Math.abs(observed - target.attributes[axis])).toBeLessThanOrEqual(limit);
    }
    // 잠재력은 우리 선수보다도 넓게 본다 — 계약서에 사인해도 아직 모르는 몸이다
    expect(potentialBand(state, target)!.margin).toBeGreaterThan(POTENTIAL_FLOOR);
  });

  it("정착이 끝나면 own — 수치가 정확해진다", () => {
    const state = createTestGame(11);
    const target = anyOpponent(state);
    signPlayer(state, target.id);
    settleFully(state, target.id);

    expect(knowledgeOf(state, target.id)).toBe("own");
    for (const attr of scoutedAttributes(state, target)) {
      expect(attr.exact).not.toBeNull();
    }
  });

  it("원소속 선수는 정착 과정이 없다 — 이미 함께해 온 선수다", () => {
    const state = createTestGame(11);
    for (const p of userPlayers(state)) {
      expect(knowledgeOf(state, p.id)).toBe("own");
      expect(settlingOf(state, p.id)).toBeNull();
    }
  });

  it("오피스 스쿼드 뷰도 정착 중인 선수는 추정치를 보여준다", () => {
    const state = createTestGame(11);
    const target = anyOpponent(state);
    const trueOverall = target.attributes.overall;
    signPlayer(state, target.id);
    const row = buildOfficeViews(state).squad.players.find((p) => p.id === target.id)!;
    expect(row.settling).not.toBeNull();
    // 종합은 판단 계열을 포함하므로 분석형 오차 — 참값과 다를 수 있어야 안개가 작동한다
    expect(Math.abs(row.overall - trueOverall)).toBeLessThanOrEqual(
      OBSERVATION_MARGIN.analytical.adapting,
    );
  });
});

describe("체력 안개", () => {
  it("우리 선수도 값 하나로 서지 않는다 — 다만 폭이 좁다", () => {
    const state = createTestGame(11);
    const mine = userPlayers(state)[0]!;
    const them = anyOpponent(state);
    const mineRead = readCondition(state, mine.id, 64, 20, "match-1");
    const themRead = readCondition(state, them.id, 64, 20, "match-1");
    expect(mineRead.margin).toBeGreaterThan(0);
    expect(mineRead.low).toBeLessThanOrEqual(64);
    expect(mineRead.high).toBeGreaterThanOrEqual(64);
    // 출발점을 아는 쪽이 훨씬 좁다 — 아침에 쟀으니까
    expect(mineRead.margin).toBeLessThan(themRead.margin / 2);
  });

  it("뛴 만큼 흐려진다 — 킥오프엔 거의 정확하고 막판이 가장 흐리다", () => {
    const state = createTestGame(11);
    const mine = userPlayers(state)[0]!;
    const them = anyOpponent(state);
    for (const id of [mine.id, them.id]) {
      const fresh = conditionMargin(state, id, 0);
      const spent = conditionMargin(state, id, 34); // 90분 온전히 뛴 스트라이커
      expect(spent, id).toBeGreaterThan(fresh);
    }
    // 교체를 정해야 하는 그 순간이 가장 흐리다는 게 이 규칙의 요점이다
    expect(conditionMargin(state, mine.id, 34)).toBeGreaterThan(
      conditionMargin(state, mine.id, 10),
    );
  });

  it("참값은 언제나 구간 안에 있다 — 결정적이다", () => {
    const state = createTestGame(11);
    const them = anyOpponent(state);
    for (const truth of [0, 12, 37, 55, 78, 100]) {
      const read = readCondition(state, them.id, truth, 25, "match-1");
      expect(read.margin).toBeGreaterThan(0);
      expect(read.low).toBeLessThanOrEqual(truth);
      expect(read.high).toBeGreaterThanOrEqual(truth);
      expect(read.low).toBeGreaterThanOrEqual(0);
      expect(read.high).toBeLessThanOrEqual(100);
      // 같은 질문엔 같은 답 — 정지점마다 값이 튀면 상대가 지치는 건지 알 수 없다
      expect(readCondition(state, them.id, truth, 25, "match-1")).toEqual(read);
    }
  });

  it("다리가 멈춘 건 가리지 못한다 — 추정 구간이 구멍 문턱을 넘지 않는다", () => {
    const state = createTestGame(11);
    const mine = userPlayers(state)[0]!;
    const them = anyOpponent(state);
    for (const id of [mine.id, them.id]) {
      for (let truth = 0; truth <= 100; truth++) {
        const read = readCondition(state, id, truth, 34, "match-1");
        const gassed = truth <= GASSED_CONDITION;
        // 화면이 두 말을 하지 않는다: 읽은 값의 구멍 판정 = 참값의 구멍 판정
        expect(read.value <= GASSED_CONDITION, `${id} 체력 ${truth}`).toBe(gassed);
        expect(read.low <= GASSED_CONDITION, `${id} 체력 ${truth}`).toBe(gassed);
        expect(read.high <= GASSED_CONDITION, `${id} 체력 ${truth}`).toBe(gassed);
      }
    }
  });

  it("경기가 다르면 편향도 다시 뽑힌다 — 어제의 오독이 오늘까지 따라오지 않는다", () => {
    const state = createTestGame(11);
    const ids = playersOf(state, "chelsea").slice(0, 12);
    const a = ids.map((p) => readCondition(state, p.id, 70, 25, "match-1").value);
    const b = ids.map((p) => readCondition(state, p.id, 70, 25, "match-2").value);
    expect(a).not.toEqual(b);
  });

  it("코어 수치는 오염되지 않는다 — 안개는 읽는 쪽에만 씌운다", () => {
    const state = createTestGame(11);
    const them = anyOpponent(state);
    const before = them.state.condition;
    readCondition(state, them.id, before, 20, "match-1");
    expect(playerById(state, them.id)!.state.condition).toBe(before);
  });
});

describe("scouting request, due evidence and report ledger", () => {
  const plan: ScoutingPlan = {
    status: "ready",
    days: 2,
    depth: "match_review",
    focus: ["ability"],
    expectations: [],
    evidenceRefs: [],
    limitations: [],
  };
  function request(state: GameState): ScoutingRequest {
    const result = changeScoutingRequest(
      state,
      { action: "request", question: "주전 골키퍼로 적합한가", playerIds: [anyOpponent(state).id] },
      "이 선수를 조사해줘",
    );
    if (!result.ok) throw new Error(result.message);
    return result.request;
  }
  function assessments(r: ScoutingRequest): ScoutingAssessment[] {
    return r.evidence.map((e) => ({
      playerId: e.playerId,
      fit: "unknown",
      overall: null,
      potential: null,
      attributes: {},
      evidenceRefs: [],
      strengths: [],
      concerns: ["insufficient_evidence"],
    }));
  }
  it("does not complete at dispatch, freezes on the selected day, and commits once", () => {
    const state = createTestGame(11);
    const r = request(state);
    expect(applyScoutingPlan(state, r.id, r.revision, plan)).toBe(true);
    captureScoutingEvidence(state);
    expect(r.status).toBe("scheduled");
    state.date = addDays(state.date, 2);
    captureScoutingEvidence(state);
    expect(r.status).toBe("ready");
    expect(state.scoutReports).toHaveLength(0);
    const report = completeScoutingReport(state, r.id, r.revision, assessments(r))!;
    expect(completeScoutingReport(state, r.id, r.revision, [])).toBeNull();
    expect(state.pendingReportCards).toEqual([report.id]);
    expect(state.scoutReports).toHaveLength(1);
  });
  it("rejects stale results after revision or cancellation", () => {
    const state = createTestGame(11);
    const r = request(state);
    const oldRevision = r.revision;
    changeScoutingRequest(
      state,
      { action: "revise", requestId: r.id, question: "재계약 정보만" },
      "조사 내용을 바꿔줘",
    );
    expect(applyScoutingPlan(state, r.id, oldRevision, plan)).toBe(false);
    applyScoutingPlan(state, r.id, r.revision, { ...plan, days: 0 });
    captureScoutingEvidence(state);
    const current = r.revision;
    const result = assessments(r);
    changeScoutingRequest(state, { action: "cancel", requestId: r.id }, "취소해줘");
    expect(completeScoutingReport(state, r.id, current, result)).toBeNull();
    expect(state.scoutReports).toHaveLength(0);
  });
  it("keeps failed evidence across dates and permits retry without recreating it", () => {
    const state = createTestGame(11);
    const r = request(state);
    applyScoutingPlan(state, r.id, r.revision, { ...plan, days: 0 });
    captureScoutingEvidence(state);
    const frozen = structuredClone(r.evidence);
    const on = r.evidenceOn;
    failScouting(state, r.id, r.revision, "network");
    state.date = addDays(state.date, 10);
    anyOpponent(state).name = "changed";
    captureScoutingEvidence(state);
    expect(r.evidence).toEqual(frozen);
    expect(r.evidenceOn).toBe(on);
    const report = completeScoutingReport(state, r.id, r.revision, assessments(r))!;
    expect(report.evidenceOn).toBe(on);
    expect(report.completedOn).toBe(state.date);
    expect(report.candidates[0]!.evidence.name).not.toBe("changed");
  });
  it("never consults hidden attributes to form the evidence pool", () => {
    const state = createTestGame(11);
    const r = request(state);
    const before = scoutingEvidence(state, r);
    const p = anyOpponent(state);
    p.attributes.overall = 1;
    p.attributes.potential = 99;
    p.attributes.pace = 1;
    expect(scoutingEvidence(state, r)).toEqual(before);
    expect(JSON.stringify(before)).not.toContain('"attributes"');
  });
  it("rejects fabricated evidence and ability guesses without observed performance", () => {
    const state = createTestGame(11);
    const r = request(state);
    applyScoutingPlan(state, r.id, r.revision, { ...plan, days: 0 });
    captureScoutingEvidence(state);
    const result = assessments(r);
    result[0]!.evidenceRefs = ["invented"];
    expect(() => completeScoutingReport(state, r.id, r.revision, result)).toThrow("evidence");
    result[0]!.evidenceRefs = [r.evidence[0]!.sources[0]!.id];
    result[0]!.overall = { low: 80, high: 90 };
    expect(() => completeScoutingReport(state, r.id, r.revision, result)).toThrow("observation");
    expect(state.scoutReports).toHaveLength(0);
    expect(r.status).toBe("ready");
  });
  it("archives a report after a player leaves the world and read calls do not mutate it", () => {
    const state = createTestGame(11);
    const r = request(state);
    applyScoutingPlan(state, r.id, r.revision, { ...plan, days: 0 });
    captureScoutingEvidence(state);
    const report = completeScoutingReport(state, r.id, r.revision, assessments(r))!;
    const snapshot = structuredClone(report);
    state.players = state.players.filter((p) => p.id !== report.candidates[0]!.evidence.playerId);
    state.date = addDays(state.date, 20);
    expect(scoutReportCard(state, report.id)).toEqual(snapshot);
    const read = scoutingLookup(state, { reportId: report.id });
    read.reports[0]!.question = "mutated response";
    expect(state.scoutReports[0]).toEqual(snapshot);
  });
  it("does not impose a dispatch count or delete queued reports", () => {
    const state = createTestGame(11);
    for (let i = 0; i < 15; i++) {
      const changed = changeScoutingRequest(
        state,
        { action: "request", question: `질문 ${i}`, playerIds: [anyOpponent(state).id] },
        `의뢰 ${i}`,
      );
      if (!changed.ok) throw new Error(changed.message);
      const r = changed.request;
      applyScoutingPlan(state, r.id, r.revision, { ...plan, days: 0 });
      captureScoutingEvidence(state);
      completeScoutingReport(state, r.id, r.revision, assessments(r));
    }
    expect(state.scoutingRequests).toHaveLength(15);
    expect(state.pendingReportCards).toHaveLength(15);
  });
  it("stops the pure date runner at the due day before later facts can leak", () => {
    const state = createTestGame(11);
    const r = request(state);
    applyScoutingPlan(state, r.id, r.revision, plan);
    advanceTime(state, { days: 10 });
    expect(state.date).toBe(r.dueOn);
    expect(r.evidenceOn).toBe(r.dueOn);
    expect(r.status).toBe("ready");
  });
  it("processes an offseason due date before a season rollover", () => {
    const state = createTestGame(11);
    state.date = "2027-06-27";
    state.matches = [];
    const r = request(state);
    applyScoutingPlan(state, r.id, r.revision, plan);
    advanceTime(state, { days: 10 });
    expect(state.date).toBe("2027-06-29");
    expect(r.evidenceOn).toBe("2027-06-29");
  });
  it("holds a plan beyond the requested deadline at the core boundary", () => {
    const state = createTestGame(11);
    const changed = changeScoutingRequest(
      state,
      {
        action: "request",
        question: "오늘 확인",
        playerIds: [anyOpponent(state).id],
        deadline: state.date,
      },
      "오늘 확인",
    );
    if (!changed.ok) throw new Error(changed.message);
    const r = changed.request;
    expect(applyScoutingPlan(state, r.id, r.revision, plan)).toBe(true);
    expect(r.status).toBe("held");
    expect(r.dueOn).toBeNull();
    expect(r.plan?.status).toBe("needs_revision");
  });
  it("reuses an identical in-turn request and rejects invalid scope without mutation", () => {
    const state = createTestGame(11);
    const r = request(state);
    expect(request(state).id).toBe(r.id);
    const result = changeScoutingRequest(
      state,
      { action: "revise", requestId: r.id, minAge: 30, maxAge: 20 },
      "바꿔줘",
    );
    expect(result.ok).toBe(false);
    expect(r.revision).toBe(1);
  });
});
