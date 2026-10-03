import { describe, expect, it } from "vitest";
import {
  playerOverall,
  FIRST_TEAM_LIMIT,
  MATCHDAY_SQUAD,
  NON_HOMEGROWN_MAX,
  SQUAD_LIST_LIMIT,
  STARTING_XI,
  isUnder21,
  positionGroupOf,
  positionGroupOfPlayer,
  presetOf,
  naturalPositionOf,
} from "@story-fm/domain";
import {
  advanceTime,
  assembleUserLineup,
  buildAssignments,
  FAMILIARITY_BASELINE,
  playerById,
  squadLevelOf,
  firstTeamPlayers,
  isHomegrownFor,
  isTopFlight,
  squadRegistrationOf,
  reservePlayers,
  applyMonthlyDevelopment,
  developsByCore,
  recordGrowth,
  setCaptain,
  setLineup,
  setPlayerTraining,
  setSquadLevel,
  setSquadLevels,
  userPlayers,
  userTactics,
} from "../../src/index";
import { createMiniGame, createTestGame, playMockMatch } from "../helpers";

/** 열두 달 뒤에도 찾을 수 있어야 하는 첫 달의 표식 — 문장이 아니라 축이다 */
const FIRST_MONTH_AXIS = "passing";

describe("1·2군 스쿼드", () => {
  it("duplicate moves cannot inflate the squad floor and conflicting moves reject atomically", () => {
    const state = createTestGame();
    const starting = userTactics(state)
      .assignments.filter((a) => a.role === "starting")
      .map((a) => ({ playerId: a.playerId, position: a.position }));
    const first = firstTeamPlayers(state, state.userTeamId);
    const reserve = reservePlayers(state, state.userTeamId)[0]!;
    const demoted = first
      .filter((p) => !starting.some((s) => s.playerId === p.id))
      .slice(0, first.length - MATCHDAY_SQUAD + 2);
    expect(demoted.length).toBe(first.length - MATCHDAY_SQUAD + 2);
    const before = structuredClone(state);
    expect(
      setLineup(state, {
        starting,
        bench: [],
        squadLevels: [
          ...Array.from({ length: 5 }, () => ({ playerId: reserve.id, level: "first" as const })),
          ...demoted.map((p) => ({ playerId: p.id, level: "reserve" as const })),
        ],
      }).ok,
    ).toBe(false);
    expect(state).toEqual(before);
    expect(
      setLineup(state, {
        starting,
        squadLevels: [
          { playerId: reserve.id, level: "first" },
          { playerId: reserve.id, level: "reserve" },
        ],
      }).ok,
    ).toBe(false);
    expect(state).toEqual(before);
  });
  it("invalid combined armbands leave all state unchanged and reserves are ineligible", () => {
    const state = createTestGame();
    const player = firstTeamPlayers(state, state.userTeamId).find((p) => !p.isCaptain)!;
    const before = structuredClone(state);
    for (const vice of [player.id, "missing-player", ""]) {
      expect(setCaptain(state, { playerId: player.id, vice }).ok).toBe(false);
      expect(state).toEqual(before);
    }
    expect(setCaptain(state, { playerId: reservePlayers(state, state.userTeamId)[0]!.id }).ok).toBe(
      false,
    );
    expect(state).toEqual(before);
  });
  it("새 게임의 1군은 **등록 규칙을 지킨 채** 짜인다 (25 + U21)", () => {
    const state = createTestGame();
    const first = userPlayers(state).filter((p) => p.squadLevel === "first");
    const reg = squadRegistrationOf(state, state.userTeamId);

    // 부임하자마자 위반 상태로 시작하지 않는다
    expect(reg.issues).toEqual([]);
    expect(reg.listed).toBeLessThanOrEqual(SQUAD_LIST_LIMIT);
    // 규칙은 "홈그로운 8명 이상"이 아니라 **"비홈그로운 17명 이하"** 다 —
    // 홈그로운이 7명뿐인 구단은 25가 아니라 24명만 올릴 수 있고, 그건 적법하다
    expect(reg.listed - reg.homegrown).toBeLessThanOrEqual(NON_HOMEGROWN_MAX);
    // 매치데이(선발 11 + 벤치 9)를 채울 수 있어야 한다
    expect(first.length).toBeGreaterThanOrEqual(MATCHDAY_SQUAD);
    // U21은 명단 밖이라 1군 인원은 25를 넘을 수 있다
    expect(first.length).toBe(reg.listed + reg.under21);
    expect(reservePlayers(state, state.userTeamId).length).toBeGreaterThanOrEqual(18);
  });

  it("모든 1부 구단이 적법한 등록 명단으로 시작한다 — 골키퍼 없는 명단은 없다", () => {
    const state = createTestGame();
    for (const team of state.teams) {
      if (!isTopFlight(team.id)) continue;
      const reg = squadRegistrationOf(state, team.id);
      expect(reg.issues, `${team.id}: ${reg.issues.join(" / ")}`).toEqual([]);
      const keepers = firstTeamPlayers(state, team.id).filter(
        (p) => positionGroupOfPlayer(p) === "GK",
      );
      expect(keepers.length, `${team.id} 1군 골키퍼`).toBeGreaterThanOrEqual(2);
    }
  });

  /**
   * 1군 상한(`FIRST_TEAM_LIMIT`)은 등록 명단 25인과 다른 눈금이다 — U21은 명단
   * 밖이라 1군 인원이 25를 넘을 수 있고, 그 위 천장이 이 값이다. 새 게임이 이걸
   * 넘겨 시작하면 감독은 첫날부터 줄일 수 없는 명단을 쥔다.
   */
  it("어느 구단도 1군이 상한을 넘지 않는다", () => {
    const state = createTestGame();
    const over = state.teams
      .map((team) => ({ id: team.id, first: firstTeamPlayers(state, team.id).length }))
      .filter((t) => t.first > FIRST_TEAM_LIMIT)
      .map((t) => `${t.id} ${t.first}명`);

    expect(over).toEqual([]);
  });

  it("2군 선수는 승격 전 라인업에 들어갈 수 없고, 강등하면 배치에서 빠진다", () => {
    const state = createTestGame();
    // 등록 규칙(25인·홈그로운)에 막히지 않는 2군을 고른다 — 이 테스트가 보려는 건
    // 승격 여부가 아니라 "2군은 라인업에 못 들어간다"는 규칙이다
    const reserve = reservePlayers(state, state.userTeamId).find(
      (p) =>
        setSquadLevel(state, { playerId: p.id, level: "first" }).ok &&
        setSquadLevel(state, { playerId: p.id, level: "reserve" }).ok,
    )!;
    expect(reserve, "승격 가능한 2군이 없다").toBeDefined();
    const starters = userTactics(state)
      .assignments.filter((a) => a.role === "starting")
      .map((a) => ({ playerId: a.playerId, position: a.position }));
    starters[1] = { playerId: reserve.id, position: starters[1]!.position };

    expect(setLineup(state, { starting: starters }).ok).toBe(false);
    expect(setSquadLevel(state, { playerId: reserve.id, level: "first" }).ok).toBe(true);
    expect(setLineup(state, { starting: starters }).ok).toBe(true);
    expect(setSquadLevel(state, { playerId: reserve.id, level: "reserve" }).ok).toBe(true);
    expect(userTactics(state).assignments.some((a) => a.playerId === reserve.id)).toBe(false);
  });

  it("2군은 결산 판정 대신 코어의 월간 성장을 받는다", () => {
    const state = createTestGame();
    // 감독 팀 1군만 훈련·경기 결산이 판정한다. 2군은 타 팀 선수와 같은 코어 로직이다
    const first = userPlayers(state).find((p) => squadLevelOf(p) === "first")!;
    // 등록 규칙(25인·홈그로운)에 막히지 않는 2군을 고른다 — 이 테스트가 보려는 건
    // 승격 여부가 아니라 "2군은 라인업에 못 들어간다"는 규칙이다
    const reserve = reservePlayers(state, state.userTeamId).find(
      (p) =>
        setSquadLevel(state, { playerId: p.id, level: "first" }).ok &&
        setSquadLevel(state, { playerId: p.id, level: "reserve" }).ok,
    )!;
    expect(reserve, "승격 가능한 2군이 없다").toBeDefined();
    expect(developsByCore(state, first), "1군이 코어 성장 대상이 됐다").toBe(false);
    expect(developsByCore(state, reserve), "2군이 코어 성장에서 빠졌다").toBe(true);

    // 몇 달을 넘기면 2군에는 월간 성장 로그가 쌓인다
    for (let i = 0; i < 14; i++) {
      // 프리시즌에도 경기가 있다(친선) — 경기일에 멎으면 달이 넘어가지 않는다
      if (state.phase === "matchday") playMockMatch(state);
      else advanceTime(state, { days: 7 });
    }
    const ours = new Set(reservePlayers(state, state.userTeamId).map((p) => p.id));
    expect(
      state.growthLog.some((g) => g.source === "development" && ours.has(g.gamePlayerId)),
      "몇 달이 지났는데 2군에 아무 변화도 없다",
    ).toBe(true);
    // 1군은 코어가 건드리지 않는다 (판정만이 움직인다)
    const firstIds = new Set(
      userPlayers(state)
        .filter((p) => squadLevelOf(p) === "first")
        .map((p) => p.id),
    );
    expect(
      state.growthLog.some((g) => g.source === "development" && firstIds.has(g.gamePlayerId)),
      "1군이 코어 월간 성장을 받았다",
    ).toBe(false);
  });

  /**
   * 개인 훈련이 **2군에서 어디에 닿는가** — 결산이 없는 층이라 월간 성장의 축
   * 겨냥이 유일한 경로다 (season.md §2). 명령은 성공으로 답하는데 성장은
   * `playerTraining`을 읽지 않던 자리라, 화면에는 아무것도 드러나지 않는다.
   */
  it("2군에 건 개인 훈련 축이 월간 성장에 닿는다", () => {
    const aimed = "finishing";
    // 축소 세계로 잰다 — 전체 세계는 4,000명분을 마흔여덟 달 굴린다
    const growthOn = (aim: boolean): number => {
      const state = createMiniGame();
      const ours = reservePlayers(state, state.userTeamId);
      if (aim) {
        for (const p of ours) {
          expect(setPlayerTraining(state, { playerId: p.id, axis: aimed }).ok).toBe(true);
        }
      }
      const ids = new Set(ours.map((p) => p.id));
      for (let month = 0; month < 48; month++) {
        const year = 2026 + Math.floor((6 + month) / 12);
        const mm = String(((6 + month) % 12) + 1).padStart(2, "0");
        state.date = `${year}-${mm}-01`;
        applyMonthlyDevelopment(state);
      }
      return state.growthLog.filter(
        (g) => g.source === "development" && g.target === aimed && ids.has(g.gamePlayerId),
      ).length;
    };

    const without = growthOn(false);
    const withAim = growthOn(true);
    expect(without, "겨냥 없이도 오르지 않으면 잴 것이 없다").toBeGreaterThan(0);
    expect(withAim, `${without} → ${withAim}`).toBeGreaterThan(without);
  });

  it("월간 성장 로그는 감독 팀만 남긴다 — 한 시즌을 굴려도 첫 달 훈련 행이 살아 있다", () => {
    const state = createTestGame();
    // 부임 첫 달의 훈련 기록 한 줄. 열두 달 뒤에도 이 줄이 로그 안에 있어야 한다
    const ours = new Set(userPlayers(state).map((p) => p.id));
    const first = userPlayers(state)[0]!;
    recordGrowth(state, first.id, null, "training", FIRST_MONTH_AXIS, 1, "training-settlement");

    // 능력치는 매달 굴러도 로그는 우리 팀 몫만 쌓인다 — tick을 태우지 않고
    // 성장 함수만 열두 번 부른다(시즌 완주는 분 단위고 여기서 볼 것도 아니다)
    for (let month = 0; month < 12; month++) {
      const year = 2026 + Math.floor((6 + month) / 12);
      const mm = String(((6 + month) % 12) + 1).padStart(2, "0");
      state.date = `${year}-${mm}-01`;
      applyMonthlyDevelopment(state);
    }

    const strangers = state.growthLog.filter(
      (g) => g.source === "development" && !ours.has(g.gamePlayerId),
    );
    expect(strangers, "타 팀 성장이 로그에 남았다").toHaveLength(0);
    expect(
      state.growthLog.some(
        (g) => g.origin === "training-settlement" && g.target === FIRST_MONTH_AXIS,
      ),
      "첫 달 훈련 행이 월간 성장에 밀려났다",
    ).toBe(true);
  });
});

describe("골키퍼 없는 1군 — 골문은 필드 선수가 대신 설 수 없다", () => {
  it("등록 현황이 사유를 세우고, 자동 편성은 골문을 비운 채 열 명을 세우며, 킥오프는 2군 골키퍼를 부른다", () => {
    const state = createTestGame();
    const keepers = firstTeamPlayers(state, state.userTeamId).filter(
      (p) => positionGroupOfPlayer(p) === "GK",
    );
    expect(keepers.length).toBeGreaterThan(0);
    for (const keeper of keepers) keeper.squadLevel = "reserve";

    // 등록 검사 — 골키퍼 0명은 명단이 성립하지 않는다는 사실이고 사유로 선다
    const reg = squadRegistrationOf(state, state.userTeamId);
    expect(reg.goalkeepers).toBe(0);
    expect(reg.issues.join()).toContain("골키퍼 부족");

    // 자동 편성 — 감점(-400)을 안은 채 필드 선수가 골문에 서던 자리다
    const tactics = userTactics(state);
    tactics.assignments = buildAssignments(
      firstTeamPlayers(state, state.userTeamId),
      "4-3-3",
      FAMILIARITY_BASELINE,
    );
    const starting = tactics.assignments.filter((a) => a.role === "starting");
    expect(starting).toHaveLength(STARTING_XI - 1);
    expect(starting.some((a) => positionGroupOf(a.position) === "GK")).toBe(false);

    // 킥오프 — 빈 골문은 골키퍼만 채우고, 1군에 없으니 2군을 부른다
    const lineup = assembleUserLineup(state, null);
    expect(lineup.error).toBeNull();
    expect(lineup.onPitch).toHaveLength(STARTING_XI);
    const onPitchKeepers = lineup.onPitch.filter(
      (id) => positionGroupOfPlayer(playerById(state, id)!) === "GK",
    );
    expect(onPitchKeepers).toHaveLength(1);
    expect(lineup.replaced.join()).toContain("(빈 자리) →");
    expect(lineup.replaced.join()).toContain("2군 호출");
  });
});

/**
 * 자동으로 채우는 선발이 **선수의 주 포지션**을 자리로 삼던 때의 판을 세운다. 왼쪽 윙어가
 * 계약 만료로 떠난 여름에 남은 오른쪽 자원 둘이 나란히 `RW`의 기본 좌표에 서고 왼쪽
 * 측면이 빈 채로 시즌이 시작됐다 — 감독이 판에서 하지 않은 일이고 이름 붙일 수 있는
 * 모양도 아니다 (→ docs/common/team.md §6).
 */
describe("자동으로 채운 선발 — 자리가 먼저고 사람이 나중이다", () => {
  /** 이 자리가 왼쪽인가·오른쪽인가 — 전술판 x의 양 끝 3분의 1 */
  const FLANK = { left: 35, right: 65 };

  it("주 포지션이 한쪽에 몰린 열한 명을 세워도 같은 자리 코드가 둘 서지 않는다", () => {
    const state = createTestGame();
    const tactics = userTactics(state);
    // 이어받을 자리가 하나도 없는 판 — 코어가 열한 자리를 통째로 고르는 그 자리다
    tactics.assignments = [];

    const pool = firstTeamPlayers(state, state.userTeamId);
    const keeper = pool.find((p) => positionGroupOfPlayer(p) === "GK")!;
    // 왼쪽 자원을 통째로 뺀 풀 — 이슈의 여름(쿠냐·래시포드가 떠난 뒤)과 같은 모양이다
    const right = pool
      .filter((p) => p.id !== keeper.id && !naturalPositionOf(p).position.startsWith("L"))
      .sort((a, b) => playerOverall(b) - playerOverall(a))
      .slice(0, STARTING_XI - 1);
    expect(right).toHaveLength(STARTING_XI - 1);

    const res = setLineup(state, { starting: [keeper.id, ...right.map((p) => p.id)] });
    expect(res.ok).toBe(true);

    const starting = userTactics(state).assignments.filter((a) => a.role === "starting");
    expect(starting).toHaveLength(STARTING_XI);
    // 같은 자리 코드가 둘 서지 않는다
    expect(new Set(starting.map((a) => a.position)).size).toBe(STARTING_XI);
    // 한 점에 둘이 포개지지도 않는다
    const points = starting.map((a) => a.point!);
    expect(new Set(points.map((p) => `${p.x},${p.y}`)).size).toBe(STARTING_XI);
    // 좌우가 한쪽만 비지 않는다
    const left = points.filter((p) => p.x < FLANK.left).length;
    const wide = points.filter((p) => p.x > FLANK.right).length;
    expect(left).toBeGreaterThan(0);
    expect(Math.abs(left - wide)).toBeLessThanOrEqual(1);
    // 그리고 그 판은 이름이 붙는 모양이다
    expect(presetOf(userTactics(state).spec.formation)).not.toBeNull();
  });

  it("자리를 비운 선발이 있으면 그 자리를 잇는다 — 판의 모양은 감독의 것이다", () => {
    const state = createTestGame();
    const before = userTactics(state).assignments.filter((a) => a.role === "starting");
    const shape = userTactics(state).spec.formation;
    const dropped = before.find((a) => positionGroupOf(a.position) !== "GK")!;
    const spare = userPlayers(state).find(
      (p) =>
        squadLevelOf(p) === "first" &&
        !before.some((a) => a.playerId === p.id) &&
        positionGroupOfPlayer(p) !== "GK",
    )!;

    // 자리도 좌표도 말하지 않고 사람만 바꾼다 — 비운 자리를 그대로 물려받아야 한다
    const res = setLineup(state, {
      starting: [
        ...before.filter((a) => a.playerId !== dropped.playerId).map((a) => a.playerId),
        spare.id,
      ],
    });
    expect(res.ok).toBe(true);
    const after = userTactics(state).assignments.find((a) => a.playerId === spare.id)!;
    expect(after.point).toEqual(dropped.point);
    expect(userTactics(state).spec.formation).toBe(shape);
  });
});

describe("승격·강등은 등록 규칙을 따른다", () => {
  it("21세 초과는 명단이 차면 못 올라온다 — U21은 올라온다", () => {
    const state = createTestGame();
    const reserves = reservePlayers(state, state.userTeamId);
    const seasonStart = 2026;

    const senior = reserves.find((p) => !isUnder21(p.birthdate, seasonStart));
    const young = reserves.find((p) => isUnder21(p.birthdate, seasonStart));
    expect(young, "2군에 U21이 없다").toBeDefined();

    // 명단을 25까지 채운다 (홈그로운 여유가 있는 만큼)
    for (const p of reserves) {
      if (isUnder21(p.birthdate, seasonStart)) continue;
      setSquadLevel(state, { playerId: p.id, level: "first" });
    }
    const after = squadRegistrationOf(state, state.userTeamId);
    expect(after.listed).toBeLessThanOrEqual(SQUAD_LIST_LIMIT);
    expect(after.listed - after.homegrown).toBeLessThanOrEqual(NON_HOMEGROWN_MAX);
    expect(after.issues).toEqual([]);

    // 명단이 닫힌 뒤에도 U21은 언제든 올라온다
    const stillReserve = reservePlayers(state, state.userTeamId).find((p) =>
      isUnder21(p.birthdate, seasonStart),
    );
    if (stillReserve) {
      expect(setSquadLevel(state, { playerId: stillReserve.id, level: "first" }).ok).toBe(true);
    }
    if (senior) {
      const blocked = reservePlayers(state, state.userTeamId).find(
        (p) => !isUnder21(p.birthdate, seasonStart),
      );
      // 남아 있는 21세 초과가 있다면 그건 규칙에 막힌 것이다
      if (blocked) {
        const res = setSquadLevel(state, { playerId: blocked.id, level: "first" });
        expect(res.ok).toBe(false);
        expect(res.message).toMatch(/등록 명단이 찼습니다|홈그로운이 모자랍니다/);
      }
    }
  });

  it("매치데이 20명 밑으로는 내릴 수 없다", () => {
    const state = createTestGame();
    let guard = 60;
    while (guard-- > 0) {
      const first = userPlayers(state).filter((p) => p.squadLevel === "first");
      if (first.length <= MATCHDAY_SQUAD) break;
      const victim = first[first.length - 1]!;
      if (!setSquadLevel(state, { playerId: victim.id, level: "reserve" }).ok) break;
    }
    const first = userPlayers(state).filter((p) => p.squadLevel === "first");
    expect(first.length).toBeGreaterThanOrEqual(MATCHDAY_SQUAD);
    const res = setSquadLevel(state, { playerId: first[0]!.id, level: "reserve" });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("선발 11 + 벤치 9");
  });
});

describe("1·2군 이동 — 한 요청이 여럿을 옮긴다", () => {
  it("주전을 내리면 배치·주장·적응도가 함께 정리된다", () => {
    const state = createTestGame();
    const starter = userTactics(state).assignments.find((a) => a.role === "starting")!;
    const player = userPlayers(state).find((p) => p.id === starter.playerId)!;
    expect(setCaptain(state, { playerId: player.id }).ok).toBe(true);

    const res = setSquadLevels(state, { moves: [{ playerId: player.id, level: "reserve" }] });

    expect(res.ok).toBe(true);
    expect(squadLevelOf(player)).toBe("reserve");
    // 2군은 배치를 갖지 않는다 — 판에서도 완장에서도 함께 빠진다
    expect(userTactics(state).assignments.some((a) => a.playerId === player.id)).toBe(false);
    expect(player.isCaptain).toBe(false);
    // 적응도는 선반으로 — 없으면 하루 다녀온 주전이 신입으로 돌아온다 (player.md §7.3)
    expect(userTactics(state).shelved?.some((s) => s.playerId === player.id)).toBe(true);
    // 판이 열 명이 된 것은 결과가 적는다 (team.md §6)
    expect(res.brief?.items.some((i) => i.label === "선발")).toBe(true);
  });

  it("명단이 차 있어도 자리를 비우는 강등과 함께면 올라온다", () => {
    const state = createTestGame();
    const seasonStart = 2026;
    const team = state.userTeamId;
    // 21세 초과를 전부 올려 명단을 닫는다
    for (const p of reservePlayers(state, team)) {
      if (isUnder21(p.birthdate, seasonStart)) continue;
      setSquadLevel(state, { playerId: p.id, level: "first" });
    }
    const blocked = reservePlayers(state, team).find((p) => !isUnder21(p.birthdate, seasonStart));
    expect(blocked, "명단이 닫히지 않았다").toBeDefined();
    expect(setSquadLevel(state, { playerId: blocked!.id, level: "first" }).ok).toBe(false);

    // 비우는 자리는 **같은 종류여야** 한다 — 홈그로운 자리는 홈그로운이 비운다
    const out = userPlayers(state).find(
      (p) =>
        squadLevelOf(p) === "first" &&
        !isUnder21(p.birthdate, seasonStart) &&
        isHomegrownFor(p, team) === isHomegrownFor(blocked!, team),
    )!;
    const res = setSquadLevels(state, {
      moves: [
        { playerId: out.id, level: "reserve" },
        { playerId: blocked!.id, level: "first" },
      ],
    });

    expect(res.ok, res.message).toBe(true);
    expect(squadLevelOf(out)).toBe("reserve");
    expect(squadLevelOf(blocked!)).toBe("first");
  });

  it("하한을 뚫는 요청은 **아무도** 옮기지 않는다", () => {
    const state = createTestGame();
    // 하한 바로 위까지 미리 줄여 둔다 — 둘을 함께 내리면 그때 하한을 뚫는다
    let guard = 60;
    while (guard-- > 0) {
      const first = userPlayers(state).filter((p) => squadLevelOf(p) === "first");
      if (first.length <= MATCHDAY_SQUAD + 1) break;
      setSquadLevel(state, { playerId: first[first.length - 1]!.id, level: "reserve" });
    }
    const first = userPlayers(state).filter((p) => squadLevelOf(p) === "first");
    expect(first.length).toBe(MATCHDAY_SQUAD + 1);

    const two = first.slice(0, 2);
    const res = setSquadLevels(state, {
      moves: two.map((p) => ({ playerId: p.id, level: "reserve" as const })),
    });

    expect(res.ok).toBe(false);
    expect(res.message).toContain("선발 11 + 벤치 9");
    // 한 명씩 재고 그때그때 적용했다면 앞사람은 이미 내려가 있다
    expect(two.map((p) => squadLevelOf(p))).toEqual(["first", "first"]);
  });
});

/**
 * **합성 유스의 공식은 `world.test.ts`가 잰다** — 「유스 인테이크 — 천장이 먼저 선다」.
 *
 * 여기 있던 「합성이 실명 유망주 위에 서지 않는다」는 지금 실력 쪽에 기준선을 박아
 * 지키던 선이고, 그 대가로 천장이 체급 아래에 서서 세계가 시즌마다 가라앉았다
 * (season.md §6). 이제 막는 것은 개인이 아니라 **무리의 평균**이라, 재는 자리도
 * 세계 생성이 아니라 공식 쪽이다.
 */
