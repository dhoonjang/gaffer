import { describe, expect, it } from "vitest";
import {
  SET_PIECE_ROLES,
  anchorOf,
  cardChangeCost,
  placeOf,
  positionAtPoint,
  samePlace,
  type BoardPoint,
  type RoleCard,
} from "@gaffer/domain";
import {
  buildOfficeViews,
  createGame,
  setLineup,
  setPlayerCard,
  type GameState,
  type OfficeViews,
} from "@gaffer/engine";
import {
  boardCardOf,
  familiarityForCard,
  lineupBody,
  resetCardsForMovedPlayers,
  swappedLists,
  type BoardState,
} from "../../screens/squad/board-cards";

/**
 * **자리가 있어야 카드가 있다** (player.md §3.1) — 전술판이 보내는 카드는 선발
 * 것뿐이고, 고친 카드의 적응도는 저장을 기다리지 않고 명단이 곧바로 낸다 (§7.2).
 *
 * e2e로는 잡히지 않는다: 반려는 자동 저장 왕복 뒤에야 나타나고, 적응도는 서버가
 * 답하기 전의 화면 값이라 렌더를 기다리는 방식으로는 무엇이 어긋났는지 못 짚는다.
 */

type SquadRow = OfficeViews["squad"]["players"][number];

const RUN: RoleCard = { label: "올라가기", ip: { attack: 2, runBehind: 1 }, oop: {} };
const SIT: RoleCard = { label: "남기", ip: { attack: -2 }, oop: { recover: 2 } };
const SPREAD: RoleCard = { ip: { width: 2, cross: 1 }, oop: {} };

function game(seed = 71): GameState {
  const background = "K리그에서 뛰다 은퇴한 수비수 출신 분석가";
  return createGame({
    seed,
    userTeamId: "arsenal",
    managerName: "김감독",
    background,
  });
}

/** 서버가 준 배치 — `SquadView`의 `serverBoard`와 같은 꼴로 만든다 */
function boardOf(views: OfficeViews): BoardState {
  const rows = views.squad.players;
  const starters = rows.filter((p) => p.role === "선발");
  return {
    points: starters.map((p) => p.assignedPoint ?? anchorOf(p.assignedPosition ?? "CM")),
    occupants: starters.map((p) => p.id),
    bench: rows.filter((p) => p.role === "벤치").map((p) => p.id),
    reserve: rows.filter((p) => p.squadLevel === "reserve").map((p) => p.id),
    cards: {},
    tactics: views.squad.tactics,
    setPieces: Object.fromEntries(
      SET_PIECE_ROLES.map((role) => [role, views.squad.setPieces[role].designated] as const),
    ) as BoardState["setPieces"],
  };
}

/** 화면이 되찾기에 쓰는 근거 — 서버가 준 행 그대로 (자리 없는 행도 함께 온다) */
const rowsOf = (views: OfficeViews) => new Map(views.squad.players.map((p) => [p.id, p] as const));

const bodyOf = (b: BoardState, views: OfficeViews) =>
  lineupBody(b, new Set(boardOf(views).reserve), rowsOf(views));

/** 판 위 i번 칸에 그 카드를 고친 작업 사본 */
function choose(b: BoardState, index: number, card: RoleCard | null): BoardState {
  const id = b.occupants[index]!;
  const place = placeOf(positionAtPoint(b.points[index]!))!;
  return { ...b, cards: { ...b.cards, [id]: { place, card } } };
}

describe("판에서 내려간 선수의 카드는 함께 내려간다", () => {
  it("선발이던 선수를 벤치와 맞바꾸면 그 카드가 저장 본문에 실리지 않는다", () => {
    const views = buildOfficeViews(game());
    const rows = views.squad.players;
    const server = boardOf(views);

    // 1) 선발 한 명의 카드를 고친다 — 자동 저장 전이라 작업 사본에만 담긴다
    const index = server.occupants.findIndex(
      (id) => rows.find((p) => p.id === id)!.position !== "GK",
    );
    const benched = server.occupants[index]!;
    const chosen = choose(server, index, RUN);
    expect(bodyOf(chosen, views).cards).toContainEqual({ playerId: benched, card: RUN });

    // 2) 그 선수를 명단 화살표로 벤치와 맞바꾼다
    const sub = rows.find((p) => p.role === "벤치")!;
    const occupants = chosen.occupants.map((id) => (id === benched ? sub.id : id));
    const bench = [...chosen.bench.filter((id) => id !== sub.id), benched];
    const next = resetCardsForMovedPlayers({ ...chosen, occupants, bench });
    expect(occupants[index]).toBe(sub.id);

    // 자리가 없으니 카드도 없다 — 작업 사본에서 지워지고, 저장 본문에도 실리지 않는다
    expect(next.cards[benched]).toBeUndefined();
    expect(bodyOf(next, views).cards.map((r) => r.playerId)).not.toContain(benched);
  });

  it("작업 사본에 남아 있어도 저장 본문이 비선발을 거른다 (두 번째 방어선)", () => {
    const views = buildOfficeViews(game(72));
    const server = boardOf(views);
    const benched = views.squad.players.find((p) => p.role === "벤치")!;
    const leaked: BoardState = {
      ...server,
      cards: { ...server.cards, [benched.id]: { place: "ST", card: RUN } },
    };
    expect(bodyOf(leaked, views).cards.map((r) => r.playerId)).not.toContain(benched.id);
  });
});

describe("승격·강등 스왑은 2군행 선수를 벤치에 남기지 않는다 (#500)", () => {
  // 스왑 산수는 목록 계산뿐이라 세계 하나를 나눠 쓴다
  const views = buildOfficeViews(game(84));
  const server = boardOf(views);
  const r1 = server.reserve[0]!;

  it("선발↔2군: 강등 선수는 벤치에도, 저장 본문의 bench에도 없다", () => {
    const starter = server.occupants[0]!;
    const next = swappedLists(server, starter, r1)!;
    expect(next).not.toBeNull();
    // 서로의 칸을 넘겨받는다
    expect(next.occupants).toContain(r1);
    expect(next.occupants).not.toContain(starter);
    expect(next.reserve).toContain(starter);
    expect(next.reserve).not.toContain(r1);
    // 핵심 회귀 — 2군행 선수가 벤치 목록에 남으면 서버가 강등을 반려한다
    expect(next.bench).not.toContain(starter);

    const body = lineupBody({ ...server, ...next }, new Set(server.reserve), rowsOf(views));
    expect(body.bench.map((b) => b.playerId)).not.toContain(starter);
    expect(body.squadLevels).toContainEqual({ playerId: starter, level: "reserve" });
    expect(body.squadLevels).toContainEqual({ playerId: r1, level: "first" });
  });

  it("벤치↔2군: 내려가는 선수는 벤치에서 빠지고, 올라온 선수가 그 벤치 칸을 받는다", () => {
    const benched = server.bench[0]!;
    const next = swappedLists(server, benched, r1)!;
    expect(next.bench).toContain(r1);
    expect(next.bench).not.toContain(benched);
    expect(next.reserve).toContain(benched);
    expect(next.reserve).not.toContain(r1);
  });

  it("예비↔2군: 둘 다 벤치와 무관하다 — 올라온 선수는 예비로 선다", () => {
    const spare = views.squad.players.find(
      (p) =>
        p.squadLevel !== "reserve" &&
        !server.occupants.includes(p.id) &&
        !server.bench.includes(p.id),
    )!;
    const next = swappedLists(server, spare.id, r1)!;
    expect(next.bench).not.toContain(spare.id);
    expect(next.bench).not.toContain(r1);
    expect(next.reserve).toContain(spare.id);
    expect(next.reserve).not.toContain(r1);
    expect(next.occupants).toEqual(server.occupants);
  });

  it("같은 칸끼리, 그리고 자기 자신과는 바꿀 게 없다", () => {
    expect(swappedLists(server, server.occupants[0]!, server.occupants[1]!)).toBeNull();
    expect(swappedLists(server, r1, r1)).toBeNull();
  });
});

/** 전술판 위를 훑어 조건에 맞는 좌표 하나 — 코드는 좌표의 파생이라 자리는 격자로 찾는다 */
function pointWhere(ok: (code: string) => boolean): BoardPoint | null {
  for (let y = 10; y <= 90; y += 5) {
    for (let x = 10; x <= 90; x += 5) {
      if (ok(positionAtPoint({ x, y }))) return { x, y };
    }
  }
  return null;
}

describe("자리를 옮기면 카드가 그 자리의 것이 된다", () => {
  const views = buildOfficeViews(game(74));
  const server = boardOf(views);
  const index = views.squad.players.findIndex((p) => p.role === "선발" && p.position !== "GK");
  const mover = views.squad.players[index]!;
  const slot = server.occupants.indexOf(mover.id);
  const from = positionAtPoint(server.points[slot]!);
  const chosen = choose(server, slot, RUN);

  it("다른 자리로 옮기면 고친 카드가 내려가고, 그 자리의 기억(없으면 기본)이 선다", () => {
    const target = pointWhere((to) => !samePlace(to, from) && to !== "GK")!;
    const points = chosen.points.map((pt, i) => (i === slot ? target : pt));
    const next = resetCardsForMovedPlayers({ ...chosen, points });
    expect(next.cards[mover.id]).toBeUndefined();
    expect(boardCardOf(next, mover, positionAtPoint(target))).toEqual(
      mover.cardMemory[placeOf(positionAtPoint(target))!],
    );
  });

  it("같은 자리의 다른 칸으로 옮기면 고친 카드가 남는다", () => {
    const target = pointWhere((to) => to !== from && samePlace(to, from));
    if (target === null) return; // 그 자리가 칸 하나뿐이면(측면) 잴 것이 없다
    const points = chosen.points.map((pt, i) => (i === slot ? target : pt));
    const next = resetCardsForMovedPlayers({ ...chosen, points });
    expect(boardCardOf(next, mover, positionAtPoint(target))).toEqual(RUN);
  });
});

/**
 * 카드를 맡긴 선수를 **같은 자리 기준으로** 벤치에 내린 상태 — 코어가 기억에 적고
 * (`rememberCard`) 오늘의 흔적을 잇는(`settleCardCost`) 경로를 실제로 밟아 만든다.
 */
function benchedWithMemory(seed: number) {
  const state = game(seed);
  const before = buildOfficeViews(state).squad.players;
  const starter = before.find(
    (p) =>
      p.role === "선발" &&
      p.position !== "GK" &&
      p.assignedPosition !== null &&
      p.assignedPoint !== null,
  )!;
  const position = starter.assignedPosition!;
  const morning = starter.card;
  const paid = cardChangeCost(morning, RUN);
  expect(setPlayerCard(state, { playerId: starter.id, card: RUN }).ok).toBe(true);

  // 그 자리에 벤치 하나를 대신 세우고 본인은 벤치로 — 자리는 그대로고 사람만 바뀐다
  const sub = before.find((p) => p.role === "벤치")!;
  const res = setLineup(state, {
    starting: before
      .filter((p) => p.role === "선발")
      .map((p) => ({ playerId: p.id === starter.id ? sub.id : p.id, point: p.assignedPoint! })),
    bench: [
      ...before
        .filter((p) => p.role === "벤치" && p.id !== sub.id)
        .map((p) => ({ playerId: p.id })),
      // 벤치도 자리를 일러 준다 — 로테이션 화면이 보내는 값이고, 코어는 이때만 흔적을 잇는다
      { playerId: starter.id, position },
    ],
  });
  expect(res.ok).toBe(true);

  const views = buildOfficeViews(state);
  const row = views.squad.players.find((p) => p.id === starter.id)!;
  return { views, row, subId: sub.id, position, morning, paid };
}

describe("벤치를 다녀와도 감독의 결정이 남는다", () => {
  it("같은 자리에 다시 넣으면 저장 없이 곧바로 기억한 카드로 선다", () => {
    const { views, row, subId, position } = benchedWithMemory(80);
    // 자리 없는 행이라 카드는 없고, 기억만 그 자리를 가리킨다
    expect(row.card).toBeNull();
    expect(row.cardMemory[placeOf(position)!]).toEqual(RUN);

    const board = boardOf(views);
    const slot = board.occupants.indexOf(subId);
    expect(samePlace(positionAtPoint(board.points[slot]!), position)).toBe(true);
    const occupants = board.occupants.map((id) => (id === subId ? row.id : id));
    const bench = [...board.bench.filter((id) => id !== row.id), subId];
    const next = resetCardsForMovedPlayers({ ...board, occupants, bench });

    // 자동 저장 응답을 기다리지 않는다 — 화면이 코어와 같은 순서로 스스로 닿는다
    expect(boardCardOf(next, row, positionAtPoint(next.points[slot]!))).toEqual(RUN);
    // 화면이 되찾은 카드는 저장 본문에 실리지 않는다 — 감독이 고친 것만 실린다
    expect(bodyOf(next, views).cards.map((r) => r.playerId)).not.toContain(row.id);

    // 감독이 다른 카드를 걸면 그때는 실린다
    const changed = choose(next, slot, SIT);
    expect(bodyOf(changed, views).cards).toContainEqual({ playerId: row.id, card: SIT });
  });

  it("벤치로 내려가면 오늘 낸 값이 되돌아온다 — 흔적은 남아 다시 세울 때 물린다", () => {
    const { row, position, morning, paid } = benchedWithMemory(82);
    expect(paid).toBeGreaterThan(0);
    /**
     * 자리를 잃으면 코어가 오늘 낸 카드 대가를 되돌린다(`settleCardCost` →
     * player.md §7.2). 그래서 벤치 행의 적응도는 **그날 아침 값**이고 `paid`는 0이다.
     * 흔적 자체는 남아, 같은 자리에 다시 세울 때 아침의 카드와 견줄 자가 된다.
     */
    expect(row.assignedPosition).toBe(position);
    expect(row.cardToday).toEqual({ card: morning, paid: 0 });

    // 아침 카드는 공짜고, 고쳤던 카드는 다시 그 대가를 문다 — 왕복이 제자리로 닫힌다
    expect(familiarityForCard(row, position, morning)).toBe(row.familiarity);
    expect(familiarityForCard(row, position, RUN)).toBe(row.familiarity - paid);

    // 다른 자리에는 흔적이 닿지 않는다 — 같은 단계가 자리마다 다른 움직임이다 (§3.1)
    const elsewhere = pointWhere((code) => !samePlace(code, position) && code !== "GK")!;
    const other = positionAtPoint(elsewhere);
    expect(familiarityForCard(row, other, row.cardMemory[placeOf(other)!])).toBe(row.familiarity);
  });
});

describe("고친 카드의 적응도는 저장 전에 화면이 낸다", () => {
  const starter = (seed: number): SquadRow =>
    buildOfficeViews(game(seed)).squad.players.find(
      (x) => x.role === "선발" && x.position !== "GK" && x.assignedPosition !== null,
    )!;

  it("값의 출처는 도메인 하나다 — 깎이는 만큼이 cardChangeCost와 같다", () => {
    const p = starter(76);
    const position = p.assignedPosition!;
    expect(p.cardToday).toBeNull();
    // 지금 걸린 카드는 대가가 없다
    expect(familiarityForCard(p, position, p.card)).toBe(p.familiarity);
    expect(familiarityForCard(p, position, SPREAD)).toBe(
      p.familiarity - cardChangeCost(p.card, SPREAD),
    );
  });

  it("오늘 이미 치른 값이 있으면 차액만 움직인다 — 왔다 갔다 해도 누적되지 않는다", () => {
    const p = starter(77);
    const position = p.assignedPosition!;
    const morning = p.card;
    const paid = cardChangeCost(morning, RUN);
    expect(paid).toBeGreaterThan(0);
    // 서버가 대가를 매긴 뒤의 행 — 아침 카드와 이미 낸 값을 함께 들고 온다
    const after: SquadRow = {
      ...p,
      card: RUN,
      familiarity: p.familiarity - paid,
      cardToday: { card: morning, paid },
    };
    // 아침 카드로 되돌리면 낸 값이 복구된다 (0에서 다시 시작하지 않는다)
    expect(familiarityForCard(after, position, morning)).toBe(p.familiarity);
    // 같은 카드를 다시 거는 것은 공짜다
    expect(familiarityForCard(after, position, RUN)).toBe(after.familiarity);
    // 세 번째 카드는 아침 카드와의 거리만큼만 — 오늘 낸 것 위에 다시 얹지 않는다
    expect(familiarityForCard(after, position, SIT)).toBe(
      p.familiarity - cardChangeCost(morning, SIT),
    );
  });

  it("다른 자리로 옮기면 옛 자리에서 낸 값을 견주지 않는다 — 그 자리의 기본은 공짜다", () => {
    const p = starter(79);
    const from = p.assignedPosition!;
    const moved = pointWhere((code) => !samePlace(code, from) && code !== "GK");
    expect(moved).not.toBeNull();
    const position = positionAtPoint(moved!);

    const paid = cardChangeCost(p.card, RUN);
    expect(paid).toBeGreaterThan(0);
    const after: SquadRow = {
      ...p,
      card: RUN,
      familiarity: p.familiarity - paid,
      cardToday: { card: p.card, paid },
    };
    // 새 자리의 되찾은 카드는 공짜다 — 옮긴 것만으로 적응도가 오르지도 내리지도 않는다
    expect(familiarityForCard(after, position, after.cardMemory[placeOf(position)!])).toBe(
      after.familiarity,
    );
  });
});
