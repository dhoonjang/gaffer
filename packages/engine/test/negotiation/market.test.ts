import type { GamePlayer } from "@story-fm/domain";
import { PRECONTRACT_DAYS } from "@story-fm/domain";
import {
  MARKET_VALUE_AT_PEAK,
  activeContract,
  addDays,
  baseValueOf,
  betterAtPosition,
  validateDeal,
  isClubTeam,
  marketValueOf,
  observedMarketValue,
  playersOf,
  precontractDaysLeft,
  precontractStartOf,
  squadDepthOf,
  firstInstallmentOf,
  unilateralSeveranceOf,
} from "@story-fm/engine";
import { describe, expect, it } from "vitest";
import { createTestGame } from "../helpers";
function pick(state: ReturnType<typeof createTestGame>, overall: number): GamePlayer {
  const found = state.players.find(
    (p) => p.teamId !== state.userTeamId && p.attributes.overall === overall,
  );
  if (!found) throw new Error(`OVR ${overall} fixture missing`);
  return found;
}
describe("시장가", () => {
  it("등급 곡선은 단조 증가하고 80 OVR이 기준값이다", () => {
    expect(baseValueOf(80)).toBe(MARKET_VALUE_AT_PEAK);
    for (let ovr = 56; ovr < 95; ovr++) {
      expect(baseValueOf(ovr), `${ovr}`).toBeLessThan(baseValueOf(ovr + 1));
    }
    // 하한 아래는 이적료가 붙지 않는다
    expect(baseValueOf(50)).toBe(0);
  });

  it("나이·계약 잔여·리그가 값을 움직인다", () => {
    const state = createTestGame(42);
    const player = pick(state, 78);
    // 기준선은 **긴 계약**에서 잡는다 — 시드 계약이 1년 미만이면 아래 단축 비교가
    // 같은 계수(0.45)에 걸려 무의미해진다
    const contract = activeContract(state, player.id)!;
    contract.until = `${Number(state.date.slice(0, 4)) + 4}-06-30`;
    const year = Number(state.date.slice(0, 4));
    // **나이도 고정해서 재야 한다** — `pick`은 OVR만 보고 배열에서 처음 걸리는
    // 선수를 집으므로, 그 선수가 이미 서른이면 "서른셋과의 차이"가 나이 곡선이
    // 아니라 두 살 차이를 재게 된다. 실제로 라인업 배치가 바뀌어 등록 순서가
    // 흔들리자 이 테스트가 그렇게 깨졌다.
    const at = (age: number) => ({ ...player, birthdate: `${year - age}-01-01` });
    const baseline = marketValueOf(state, at(25));

    // 스물다섯 → 서른셋은 절반 이하
    expect(marketValueOf(state, at(33))).toBeLessThan(baseline);

    // 계약이 곧 끝나면 값이 빠지고, 만료되면 이적료가 0이다
    contract.until = `${state.date.slice(0, 4)}-12-31`;
    expect(marketValueOf(state, at(25))).toBeLessThan(baseline);
    contract.until = state.date;
    expect(marketValueOf(state, at(25))).toBe(0);
  });

  it("공개 참고 금액은 숨은 능력과 무관하며 최근 실제 이적료만 읽는다", () => {
    const state = createTestGame(42);
    const player = pick(state, 70);
    state.transfers = [];
    expect(observedMarketValue(state, player)).toBeNull();
    state.transfers.push({
      id: "public-fee",
      gamePlayerId: player.id,
      windowId: null,
      fromTeamId: "chelsea",
      toTeamId: player.teamId,
      date: state.date,
      type: "transfer",
      fee: 1234567,
    });
    expect(observedMarketValue(state, player)).toBe(1234567);
    player.attributes.potential = 99;
    player.attributes.overall = 99;
    state.transfers.push({
      id: "loan-fee",
      gamePlayerId: player.id,
      windowId: null,
      fromTeamId: player.teamId,
      toTeamId: "chelsea",
      date: state.date,
      type: "loan",
      fee: 99,
    });
    expect(observedMarketValue(state, player)).toBe(1234567);
  });

  it("유망주는 잠재력만큼 프리미엄이 붙는다", () => {
    const state = createTestGame(42);
    const player = pick(state, 70);
    const young = {
      ...player,
      birthdate: `${Number(state.date.slice(0, 4)) - 20}-01-01`,
      attributes: { ...player.attributes, potential: 88 },
    };
    const youngNoUpside = { ...young, attributes: { ...young.attributes, potential: 70 } };
    expect(marketValueOf(state, young)).toBeGreaterThan(marketValueOf(state, youngNoUpside));
  });
});

describe("팀×자리 색인 — 세는 규칙이 하나여야 한다", () => {
  /**
   * `squadDepthOf`는 `betterAtPosition`을 원장 한 번 훑기로 바꿔 놓은 것이다.
   * 두 벌이 되는 순간 재계약·오퍼 판단이 조용히 갈리므로 답이 같은지 못 박는다.
   */
  it("색인이 세는 수는 `betterAtPosition`과 같다", () => {
    const state = createTestGame(31);
    const depth = squadDepthOf(state);
    // 팀을 갈라 본다 — 우리 팀·라이벌·2부, 그리고 그 자리가 빈 조합까지
    for (const teamId of [state.userTeamId, "chelsea", "leeds"]) {
      for (const player of playersOf(state, teamId)) {
        expect(depth.betterThan(teamId, player)).toBe(betterAtPosition(state, teamId, player));
      }
      // 남의 팀 선수를 그 팀에 대 보는 것도 같은 답이어야 한다 (영입 검토가 그 모양이다)
      for (const player of playersOf(state, "arsenal").slice(0, 5)) {
        expect(depth.betterThan(teamId, player)).toBe(betterAtPosition(state, teamId, player));
      }
    }
    // 선수가 없는 팀은 0 — 색인에 칸 자체가 없다
    const anyone = playersOf(state, "chelsea")[0]!;
    expect(depth.betterThan("존재하지않는팀", anyone)).toBe(0);
  });
});

describe("사전 계약 — 반년 앞의 시장", () => {
  const state = createTestGame(42);
  // 이 갈래가 창과 무관하다는 것이 재는 대상이므로 픽스처의 창은 전부 닫아 둔다
  for (const w of state.windows) w.opensOn = "2099-01-01";
  const target = state.players.find(
    (p) => p.teamId !== state.userTeamId && isClubTeam(p.teamId) && activeContract(state, p.id),
  )!;
  const contract = activeContract(state, target.id)!;
  const leaving = (days: number) => {
    contract.until = addDays(state.date, days);
  };
  const offer = (fee: number) =>
    validateDeal(state, { kind: "buy", playerId: target.id, fee, weeklyWage: 1, years: 3 });
  it("창의 경계는 잔여 PRECONTRACT_DAYS다 — 하루 더면 밖이다", () => {
    leaving(PRECONTRACT_DAYS);
    expect(precontractDaysLeft(state, target.id)).toBe(PRECONTRACT_DAYS);
    leaving(PRECONTRACT_DAYS + 1);
    expect(precontractDaysLeft(state, target.id)).toBeNull();
    // 만료 당일은 아직 남의 선수라 창 안이고, 하루 지나면 무소속 영입이다
    leaving(0);
    expect(precontractDaysLeft(state, target.id)).toBe(0);
    leaving(-1);
    expect(precontractDaysLeft(state, target.id)).toBeNull();
  });

  it("창 안의 이적료 0은 창도 이적 예산도 묻지 않는다", () => {
    leaving(PRECONTRACT_DAYS);
    const blockers = offer(0).blockers.join();
    expect(blockers).not.toContain("이적시장이 닫혀 있습니다");
    expect(blockers).not.toContain("이적 예산을 넘습니다");
  });

  it("창 밖의 이적료 0은 그냥 헐값 오퍼다 — 창 관문이 그대로 선다", () => {
    leaving(PRECONTRACT_DAYS + 1);
    expect(offer(0).blockers.join()).toContain("이적시장이 닫혀 있습니다");
  });

  it("이미 다른 구단과 예약한 선수는 막힌다", () => {
    leaving(PRECONTRACT_DAYS);
    const rivalTeamId = state.players.find(
      (p) => p.teamId !== state.userTeamId && p.teamId !== target.teamId && isClubTeam(p.teamId),
    )!.teamId;
    const startsOn = precontractStartOf(state);
    state.contracts.push({
      id: "contract-precontract-test",
      gamePlayerId: target.id,
      teamId: rivalTeamId,
      weeklyWage: 10_000,
      since: startsOn,
      until: addDays(startsOn, 364),
      status: "pending",
    });
    expect(offer(0).blockers.join()).toContain("사전 계약을 맺었습니다");
  });
});

describe("거래의 실행 경계", () => {
  it("개인 조건 미제안은 허용하지만 비정상 금액과 기간은 거른다", () => {
    const state = createTestGame(42);
    const player = pick(state, 78);
    const terms = { playerId: player.id, fee: 1, weeklyWage: 0, years: 0 };
    expect(validateDeal(state, terms).blockers).toEqual([]);
    for (const patch of [
      { fee: NaN },
      { weeklyWage: Infinity },
      { fee: -1 },
      { years: -1 },
      { years: 1.5 },
      { years: 7 },
    ])
      expect(validateDeal(state, { ...terms, ...patch }).blockers.length).toBeGreaterThan(0);
    expect(
      validateDeal(state, {
        ...terms,
        playerId: state.players.find((p) => p.teamId === state.userTeamId)!.id,
      }).blockers.length,
    ).toBeGreaterThan(0);
  });
  it("분할 첫 회분은 잔차를 먼저 당겨 쓰지 않는다", () => {
    expect(firstInstallmentOf(10, 3)).toBe(3);
    expect(firstInstallmentOf(10)).toBe(10);
  });
  it("일방 해지는 긴 계약의 잔여 급여도 삭제하지 않는다", () => {
    const state = createTestGame(42);
    const player = playersOf(state, state.userTeamId)[0]!;
    const contract = activeContract(state, player.id)!;
    contract.weeklyWage = 1000;
    contract.until = addDays(state.date, 3 * 364);
    expect(unilateralSeveranceOf(state, player.id)).toBe(156000);
  });
});
