import { describe, expect, it } from "vitest";
import {
  MATCH_CREDIT,
  addDays,
  SETTLING_TARGET,
  isSettling,
  knowledgeOf,
  loanPlayer,
  observedRating,
  playerById,
  playersOf,
  recallLoan,
  returnDueLoans,
  settlingOf,
  settlingPercent,
  type GameState,
} from "@story-fm/engine";
import { createTestGame, resultOf } from "../helpers";

/**
 * 정착 — **날짜가 아니라 겪은 양이다** (settling.ts).
 * 경계선은 하나다: 같은 날 온 두 선수라도 **감독이 무엇을 했느냐로 갈린다.**
 */

const opponentsOf = (state: GameState) =>
  playersOf(state, "chelsea").filter((p) => p.teamId !== state.userTeamId);

/** 타 팀 선수를 우리 팀으로 옮기고 TRANSFER 원장에 남긴다 */
function sign(state: GameState, playerId: string, on = state.date) {
  const player = playerById(state, playerId)!;
  const fromTeamId = player.teamId;
  player.teamId = state.userTeamId;
  state.transfers.push({
    id: `t-${playerId}`,
    gamePlayerId: playerId,
    windowId: null,
    fromTeamId,
    toTeamId: state.userTeamId,
    date: on,
    type: "transfer",
    fee: 0,
  });
}

/** 우리 팀 경기에 출전시킨다 */
function play(state: GameState, playerId: string, count: number) {
  for (let i = 0; i < count; i++) {
    state.matches.push({
      id: `m-${playerId}-${i}`,
      season: state.season,
      competitionId: "friendly",
      stage: "league",
      round: 1,
      date: state.date,
      time: "15:00",
      homeTeamId: state.userTeamId,
      awayTeamId: "opponent",
      result: resultOf({ homeGoals: 1, awayGoals: 0, homeLineup: [playerId] }),
    });
  }
}

describe("정착은 감독이 무엇을 하느냐로 갈린다", () => {
  it("같은 날 온 두 선수라도 뛴 쪽이 먼저 녹아든다", () => {
    const state = createTestGame(11);
    const [used, benched] = opponentsOf(state);
    sign(state, used!.id);
    sign(state, benched!.id);
    play(state, used!.id, 6);

    expect(settlingPercent(state, used!.id)!).toBeGreaterThan(settlingPercent(state, benched!.id)!);
  });

  it("날짜만 흘려서는 끝나지 않는다 — 타이머가 아니다", () => {
    const state = createTestGame(11);
    const target = opponentsOf(state)[0]!;
    sign(state, target.id);
    // 훈련도 경기도 없이 두 달을 보낸다 (일정을 태우지 않고 날짜만 민다)
    state.date = "2026-09-01";
    expect(isSettling(state, target.id)).toBe(true);
    expect(knowledgeOf(state, target.id)).toBe("adapting");
  });

  it("충분히 뛰면 끝난다 — 그때 안개가 걷힌다", () => {
    const state = createTestGame(11);
    const target = opponentsOf(state)[0]!;
    sign(state, target.id);
    play(state, target.id, Math.ceil((SETTLING_TARGET * 2) / MATCH_CREDIT));

    expect(isSettling(state, target.id)).toBe(false);
    expect(knowledgeOf(state, target.id)).toBe("own");
    expect(observedRating(state, target.id, "vision", target.attributes.vision)).toBe(
      target.attributes.vision,
    );
  });

  it("안개는 진행도만큼 걷힌다 — 다 뛰기 전에도 좁아진다", () => {
    const state = createTestGame(11);
    const target = opponentsOf(state)[0]!;
    sign(state, target.id);
    const before = settlingOf(state, target.id)!;
    play(state, target.id, 5);
    const after = settlingOf(state, target.id)!;

    expect(after.progress).toBeGreaterThan(before.progress);
    expect(after.matches).toBe(5);
  });

  it("같은 출전과 훈련 기록은 나이와 국적이 달라도 같은 정착 진행도를 낸다", () => {
    const state = createTestGame(11);
    const [young, veteran] = opponentsOf(state);
    young!.birthdate = "2007-01-01";
    veteran!.birthdate = "1990-01-01";
    young!.nationality = "ENG";
    veteran!.nationality = "FRA";
    for (const target of [young!, veteran!]) {
      sign(state, target.id);
      play(state, target.id, 3);
    }
    const a = settlingOf(state, young!.id)!;
    const b = settlingOf(state, veteran!.id)!;
    expect(a.target).toBe(SETTLING_TARGET);
    expect(b.target).toBe(SETTLING_TARGET);
    expect(a.progress).toBe(b.progress);
  });

  it("원소속 선수는 정착 과정이 없다", () => {
    const state = createTestGame(11);
    for (const p of playersOf(state, state.userTeamId)) {
      expect(settlingOf(state, p.id)).toBeNull();
      expect(settlingPercent(state, p.id)).toBeNull();
    }
  });

  it("유스 콜업은 이미 이 클럽 사람이다", () => {
    const state = createTestGame(11);
    const target = opponentsOf(state)[0]!;
    playerById(state, target.id)!.teamId = state.userTeamId;
    state.transfers.push({
      id: `y-${target.id}`,
      gamePlayerId: target.id,
      windowId: null,
      fromTeamId: null,
      toTeamId: state.userTeamId,
      date: state.date,
      type: "youth",
      fee: 0,
    });
    expect(settlingOf(state, target.id)).toBeNull();
  });

  it("결정적이다 — 같은 상태면 같은 값", () => {
    const state = createTestGame(11);
    const target = opponentsOf(state)[0]!;
    sign(state, target.id);
    play(state, target.id, 3);
    expect(settlingOf(state, target.id)).toEqual(settlingOf(state, target.id));
  });
});

/**
 * `type:"loan"` 한 종류가 네 가지 이동을 다 적는다 — 임대 영입 · 그 선수의 반납 ·
 * 우리 선수 임대 송출 · 그 선수의 복귀. 방향만 보면 복귀와 영입이 같은 모양이라
 * 원장을 걸으며 직전까지의 사이로 갈라야 한다 (settling.ts `joinedUserTeamOn`).
 */
describe("임대 복귀는 새 영입이 아니다", () => {
  /** 스쿼드 하한에 걸리지 않을 선수 — 뒤에서 고른다 */
  const spare = (state: GameState) =>
    [...playersOf(state, state.userTeamId)]
      .sort((a, b) => a.attributes.overall - b.attributes.overall)
      .find((p) => p.positions[0]?.position !== "GK")!;

  /** 타 팀 선수를 임대로 데려온다 — 임대 영입 원장 한 줄 (negotiation.ts와 같은 모양) */
  function loanIn(state: GameState, playerId: string) {
    const player = playerById(state, playerId)!;
    const from = player.teamId;
    player.teamId = state.userTeamId;
    player.loan = { fromTeamId: from, until: addDays(state.date, 300), wageShare: 0.5 };
    state.transfers.push({
      id: `l-${playerId}-${state.date}`,
      gamePlayerId: playerId,
      windowId: null,
      fromTeamId: from,
      toTeamId: state.userTeamId,
      date: state.date,
      type: "loan",
      fee: 0,
    });
  }

  it("원소속 선수는 임대를 다녀와도 정착이 없다", () => {
    const state = createTestGame(11);
    const target = spare(state);
    expect(loanPlayer(state, { playerId: target.id, teamId: "chelsea" }).ok).toBe(true);
    expect(recallLoan(state, { playerId: target.id }).ok).toBe(true);

    expect(settlingOf(state, target.id)).toBeNull();
    expect(isSettling(state, target.id)).toBe(false);
    expect(knowledgeOf(state, target.id)).toBe("own");
  });

  it("사 온 선수가 임대를 다녀와도 처음 온 날이 그대로 남는다", () => {
    const state = createTestGame(11);
    const target = spare(state);
    const joinedOn = addDays(state.date, -40);
    state.transfers.push({
      id: `t-in-${target.id}`,
      gamePlayerId: target.id,
      windowId: null,
      fromTeamId: "chelsea",
      toTeamId: state.userTeamId,
      date: joinedOn,
      type: "transfer",
      fee: 0,
    });
    expect(loanPlayer(state, { playerId: target.id, teamId: "chelsea" }).ok).toBe(true);
    expect(recallLoan(state, { playerId: target.id }).ok).toBe(true);

    expect(settlingOf(state, target.id)!.joinedOn).toBe(joinedOn);
  });

  it("임대로 데려온 선수는 새로 온 사람이다 — 복귀 판정이 영입을 삼키지 않는다", () => {
    const state = createTestGame(11);
    const target = opponentsOf(state)[0]!;
    loanIn(state, target.id);
    expect(settlingOf(state, target.id)!.joinedOn).toBe(state.date);
    expect(knowledgeOf(state, target.id)).toBe("adapting");

    // 원소속에 돌려보냈다가 다시 빌려 오면 그때가 다시 온 날이다
    playerById(state, target.id)!.loan!.until = state.date;
    returnDueLoans(state, []);
    expect(settlingOf(state, target.id)).toBeNull();
    state.date = addDays(state.date, 30);
    loanIn(state, target.id);
    expect(settlingOf(state, target.id)!.joinedOn).toBe(state.date);
  });
});
