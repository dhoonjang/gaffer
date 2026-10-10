import { describe, expect, it } from "vitest";
import { cardChangeCost, inheritedCard, placeOf, samePlace, type RoleCard } from "@gaffer/domain";
import {
  markEntered,
  assignmentsOf,
  finalizeMatch,
  movePlayerSlot,
  recallCard,
  setLineup,
  setPlayerCard,
  startMatch,
  userTactics,
  type GameState,
} from "@gaffer/engine";
import { advanceToMatchday, createTestGame, playToFullTime } from "../helpers";

/**
 * 카드 변경의 대가 — **결정 하나에 한 번만.**
 *
 * 카드를 바꾸면 적응도가 깎이는 게 맞다(하는 일이 달라진다). 그런데 감독은 단계를
 * 눌러 보며 고르고, UI는 누를 때마다 API를 부른다. 매번 매기면 고르는 행위 자체가
 * 벌이 된다 — 아직 그 카드로 훈련도 경기도 하지 않았는데.
 */

/** 서로 다른 세 카드 — 낱말이 겹치지 않아 거리가 분명하다 */
const RUN: RoleCard = { label: "올라가는 풀백", ip: { attack: 2, cross: 1 }, oop: {} };
const TUCK: RoleCard = { ip: { width: -2, passRisk: 1 }, oop: {} };
const HUNT: RoleCard = { ip: { dribble: 3 }, oop: { press: -1 } };

/** 필드 선발 하나 — 골키퍼는 카드의 칸이 다르다 */
function pick(state: GameState) {
  const a = assignmentsOf(state, state.userTeamId, "starting").find((x) => x.position !== "GK");
  if (!a) throw new Error("필드 선발이 없다");
  return a;
}

const famOf = (state: GameState, playerId: string) =>
  userTactics(state).assignments.find((a) => a.playerId === playerId)!.familiarity;

describe("카드를 고르는 동안은 벌하지 않는다", () => {
  it("왔다 갔다 해도 대가가 누적되지 않는다 — 기준은 그날 아침의 카드", () => {
    const state = createTestGame(11);
    const id = pick(state).playerId;
    const start = famOf(state, id);

    // 세 카드를 차례로 걸어 본다 (감독이 고르는 모습 그대로)
    for (const card of [RUN, TUCK, HUNT]) setPlayerCard(state, { playerId: id, card });
    const afterBrowsing = famOf(state, id);

    // 한 번만 바로 그 카드로 갔을 때와 같아야 한다
    const direct = createTestGame(11);
    setPlayerCard(direct, { playerId: id, card: HUNT });
    expect(afterBrowsing).toBeCloseTo(famOf(direct, id), 6);
    expect(afterBrowsing).toBeLessThan(start);
  });

  it("기본 행동으로 되돌아오면 복구된다", () => {
    const state = createTestGame(11);
    const id = pick(state).playerId;
    const start = famOf(state, id);

    setPlayerCard(state, { playerId: id, card: RUN });
    expect(famOf(state, id)).toBeLessThan(start);

    const back = setPlayerCard(state, { playerId: id, card: null });
    expect(back.ok, back.message).toBe(true);
    expect(famOf(state, id)).toBeCloseTo(start, 6);
  });

  it("이름만 바꾸면 대가가 없다 — 엔진은 낱말만 읽는다", () => {
    const state = createTestGame(11);
    const id = pick(state).playerId;
    setPlayerCard(state, { playerId: id, card: RUN });
    const after = famOf(state, id);
    const renamed = setPlayerCard(state, { playerId: id, card: { ...RUN, label: "윙백" } });
    expect(renamed.ok, renamed.message).toBe(true);
    expect(renamed.unchanged).toBeUndefined();
    expect(famOf(state, id)).toBe(after);
  });

  it("하루가 지나면 기준이 새로 잡힌다 — 몸에 밴 뒤의 변경엔 대가가 있다", () => {
    const state = createTestGame(11);
    const id = pick(state).playerId;

    setPlayerCard(state, { playerId: id, card: RUN });
    const afterFirst = famOf(state, id);

    // 날이 바뀌면 그 카드가 기준이 된다 — 되돌리는 것도 이제 값을 치른다
    state.date = "2026-07-03";
    setPlayerCard(state, { playerId: id, card: null });
    expect(famOf(state, id)).toBeLessThan(afterFirst);
  });

  it("같은 카드를 다시 걸면 아무 일도 없다", () => {
    const state = createTestGame(11);
    const id = pick(state).playerId;
    setPlayerCard(state, { playerId: id, card: TUCK });
    const before = famOf(state, id);
    const res = setPlayerCard(state, { playerId: id, card: TUCK });
    expect(res.ok).toBe(true);
    expect(res.unchanged).toBe(true);
    expect(famOf(state, id)).toBe(before);
  });
});

describe("자동 저장이 배치를 다시 써도 오늘의 흔적은 남는다", () => {
  it("카드 변경 → 라인업 저장 → 되돌리기가 여전히 복구된다", () => {
    const state = createTestGame(11);
    const id = pick(state).playerId;
    const start = famOf(state, id);

    setPlayerCard(state, { playerId: id, card: RUN });
    // 전술판은 조작마다 배치를 다시 쓴다 — 그 사이에 저장이 한 번 끼어든다
    const starting = assignmentsOf(state, state.userTeamId, "starting").map((a) => ({
      playerId: a.playerId,
      position: a.position,
      ...(a.point ? { point: a.point } : {}),
    }));
    const saved = setLineup(state, { starting });
    expect(saved.ok, saved.message).toBe(true);

    setPlayerCard(state, { playerId: id, card: null });
    expect(famOf(state, id)).toBeCloseTo(start, 6);
  });
});

describe("공 있을 때의 자리 (player.md §3.3)", () => {
  it("전술판과 같은 자리는 걷히고, 골키퍼는 갖지 못하며, 자리를 바꾸면 그 대가를 낸다", () => {
    const state = createTestGame(11);
    const { playerId: id, position } = pick(state);
    const board = placeOf(position)!;
    const same = setPlayerCard(state, { playerId: id, card: { ip: { place: board }, oop: {} } });
    expect(same.ok && same.unchanged, same.message).toBe(true);

    const start = famOf(state, id);
    const other = board === "DM" ? "CM" : "DM";
    const moved: RoleCard = { ip: { place: other }, oop: {} };
    expect(setPlayerCard(state, { playerId: id, card: moved }).ok).toBe(true);
    const slot = userTactics(state).assignments.find((a) => a.playerId === id)!;
    expect(slot.card?.ip.place).toBe(other);
    expect(start - famOf(state, id)).toBeCloseTo(cardChangeCost(undefined, moved), 6);

    const keeper = assignmentsOf(state, state.userTeamId, "starting").find(
      (a) => a.position === "GK",
    )!;
    const refused = setPlayerCard(state, {
      playerId: keeper.playerId,
      card: { ip: { place: "CB" }, oop: {} },
    });
    expect(refused.ok).toBe(false);
  });
});

/**
 * 경기 중 대응은 그 경기에서 끝난다 — 카드 기억도 (player.md §3.2 · match.md §2).
 *
 * 기억이 새면 다음에 같은 자리에 세우는 순간 감독이 평시에 고른 적 없는 카드가
 * 서고, 카드는 `cardFit`으로 전력에 그대로 닿는다. 화면 어디에도 "지난 경기
 * 하프타임에 바꾼 것"이라고 적히지 않으므로 눈으로는 잡히지 않는다.
 */
describe("경기 중에 바꾼 카드는 기억에 남지 않고 대가도 없다", () => {
  const slotOf = (state: GameState, playerId: string) =>
    userTactics(state).assignments.find((a) => a.playerId === playerId)!;

  it("경기 중 카드 변경·자리 이동 뒤에도 기억은 평시에 고른 것 그대로다", () => {
    const state = createTestGame(11);
    advanceToMatchday(state);
    const { playerId: id, position } = pick(state);

    // 평시 — 감독이 고른 것이 그 자리의 기억이다
    const chose = setPlayerCard(state, { playerId: id, card: RUN });
    expect(chose.ok, chose.message).toBe(true);
    expect(recallCard(state, id, position)).toEqual(RUN);

    const started = startMatch(state);
    expect(started.ok, started.message).toBe(true);

    // 경기 중 — 배치엔 걸리지만 기억에도 적응도에도 닿지 않는다 (player.md §7.2)
    const famBefore = famOf(state, id);
    const changed = setPlayerCard(state, { playerId: id, card: HUNT });
    expect(changed.ok, changed.message).toBe(true);
    expect(slotOf(state, id).card).toEqual(HUNT);
    expect(recallCard(state, id, position)).toEqual(RUN);
    expect(famOf(state, id)).toBe(famBefore);

    // 다른 자리로 옮기면 내려지는 카드가 기억으로 넘어간다 — 그 경로도 경기 중엔 막힌다
    const away = ["ST", "CB", "CM", "RW", "CAM"].find((code) => !samePlace(code, position))!;
    const moved = movePlayerSlot(state, { playerId: id, position: away });
    expect(moved.ok, moved.message).toBe(true);
    expect(recallCard(state, id, position)).toEqual(RUN);
    expect(recallCard(state, id, away)).toBeUndefined();

    // 끝까지 치른다 — `restoreTactics`가 도는 자리
    markEntered(state);
    playToFullTime(state);
    finalizeMatch(state);

    expect(slotOf(state, id).position).toBe(position);
    expect(slotOf(state, id).card).toEqual(RUN);
    expect(recallCard(state, id, position)).toEqual(RUN);
    expect(recallCard(state, id, away)).toBeUndefined();

    // 경기 뒤 첫 자동 저장이 배치를 다시 써도 — 기억이 받아 가는 건 킥오프 값뿐이다
    const saved = setLineup(state, {
      starting: assignmentsOf(state, state.userTeamId, "starting").map((a) => ({
        playerId: a.playerId,
        position: a.position,
        ...(a.point ? { point: a.point } : {}),
      })),
    });
    expect(saved.ok, saved.message).toBe(true);
    expect(recallCard(state, id, position)).toEqual(RUN);
  });
});

/**
 * 자리를 옮겼을 때 되찾는 카드 (`inheritedCard`) — 세계 없이 규칙만 본다.
 *
 * 코어의 배치(`setLineup`)와 전술판이 **같은 이 함수**를 부른다. 순서를 한쪽에
 * 옮겨 적으면 감독이 누른 적 없는 카드 변경이 자동 저장 응답과 함께 혼자 일어나고,
 * 카드는 `cardFit`으로 전력에 그대로 닿는다.
 */
describe("카드 되찾기 (inheritedCard)", () => {
  it("① 같은 자리 안의 이동이면 지금 카드가 기억보다 먼저다 — LCB → RCB", () => {
    expect(inheritedCard("LCB", "RCB", RUN, TUCK)).toBe(RUN);
    expect(inheritedCard("CF", "ST", RUN, TUCK)).toBe(RUN);
  });

  it("② 다른 자리로 옮기면 그 자리의 기억이 선다", () => {
    expect(inheritedCard("CB", "DM", RUN, TUCK)).toBe(TUCK);
    // 벤치·예비에서 올라오면 지금 카드가 없다 — 기억이 선다
    expect(inheritedCard(null, "CB", undefined, TUCK)).toBe(TUCK);
  });

  it("③ 둘 다 없으면 undefined다 — 코어는 스스로 닿는 값을 배치에 적지 않는다", () => {
    expect(inheritedCard("CB", "DM", RUN, undefined)).toBeUndefined();
    expect(inheritedCard(null, "CB", null, null)).toBeUndefined();
  });
});
