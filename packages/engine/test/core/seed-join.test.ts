import { describe, expect, it } from "vitest";
import {
  FORMATION_SLOTS,
  positionGroupOf,
  positionGroupOfPlayer,
  isAssociation,
  type PositionGroup,
} from "@story-fm/domain";
import {
  checkPlayerNationality,
  deriveNationality,
  teamCatalog,
  isClubTeam,
  playerCatalog,
} from "@story-fm/engine";
import { REAL_SQUADS, type RealPlayerSeed } from "../../src/players/catalog/epl-players";
import { INJURY_HISTORY } from "../../src/players/catalog/injury-history";
import { EU_SQUADS } from "../../src/players/catalog/eu-squads";
import { MARKET_LEAGUE_SQUADS } from "../../src/players/catalog/market-leagues";

/** Structural seed joins: identity, dates, roster feasibility and nationalities. */
describe("자리표시자 생년월일 — 1월 1일이 실제 날짜인지 표시돼 있다", () => {
  const ALL_SQUADS: Record<string, readonly RealPlayerSeed[]> = {
    ...REAL_SQUADS,
    ...EU_SQUADS,
    ...MARKET_LEAGUE_SQUADS,
  };
  const allRows = Object.entries(ALL_SQUADS).flatMap(([team, squad]) =>
    squad.map((seed) => ({ seed, team })),
  );
  const isJan1 = (seed: RealPlayerSeed): boolean => seed.birthdate.endsWith("-01-01");

  it("1월 1일생 시드는 전부 birthdateApprox를 명시한다", () => {
    const violations = allRows
      .filter((r) => isJan1(r.seed) && r.seed.birthdateApprox === undefined)
      .map((r) => `${r.seed.nameKo}(${r.seed.nameEn}) ${r.team} — ${r.seed.birthdate}`);

    expect(violations).toEqual([]);
  });

  // 날짜를 바로잡고 표식만 남기면 자리표시자가 아닌 값이 자리표시자로 읽힌다.
  it("1월 1일이 아닌 시드에는 birthdateApprox가 남아 있지 않다", () => {
    const violations = allRows
      .filter((r) => !isJan1(r.seed) && r.seed.birthdateApprox !== undefined)
      .map((r) => `${r.seed.nameKo}(${r.seed.nameEn}) ${r.team} — ${r.seed.birthdate}`);

    expect(violations).toEqual([]);
  });
});

/**
 * 소속 불변식 — **한 선수는 한 구단에만 있고, 한 구단 안에서 번호가 겹치지 않는다**
 * (sources.md §4.1.1).
 *
 * 선수를 구단 사이로 옮기는 갱신이 조용히 깨는 자리다. 중복은 두 구단의 스쿼드
 * 깊이·급여 총액·라인업 후보를 함께 어긋내고, 겹친 번호는 `ensureSquadNumbers`가
 * 손대지 않는다 — 그 함수는 **빈 번호만** 채우므로 시드가 들여온 충돌은 그대로
 * 게임에 실린다.
 *
 * ⚠️ **이름은 중복을 다 잡지 못한다.** 생일이 19일 떨어진 동명이인이 실재하고
 * (알렉스 히메네스 2005-05-08 · 2005-04-19), 생일까지 어긋난 중복은 (이름 +
 * 생년월일) 축을 그대로 통과한다. 그 자리를 `wikidataId`가 메운다 — 위키 문서
 * 제목이 동명이인을 이미 갈라 두므로 QID는 사람마다 하나다. QID가 없는 선수는
 * 위키 문서가 없는 아카데미 자원이고, 그들에게는 (이름 + 생년월일)이 남는다.
 */
describe("소속 불변식 — 한 선수 한 구단, 한 구단 안에서 번호는 하나", () => {
  const ALL_SQUADS: Record<string, readonly RealPlayerSeed[]> = {
    ...REAL_SQUADS,
    ...EU_SQUADS,
    ...MARKET_LEAGUE_SQUADS,
  };

  /**
   * 오타 난 키는 다른 사람의 키가 아니라 **아무의 키도 아니다** — 아래 중복 검사를
   * 조용히 빠져나가므로, 모양부터 잠근다.
   */
  it("wikidataId는 Q + 숫자다", () => {
    const violations = Object.entries(ALL_SQUADS).flatMap(([team, squad]) =>
      squad
        .filter((s) => s.wikidataId !== undefined && !/^Q[1-9]\d*$/.test(s.wikidataId))
        .map((s) => `${s.nameKo}(${s.nameEn}) ${team} — ${s.wikidataId}`),
    );

    expect(violations).toEqual([]);
  });

  /**
   * **이 검사가 이슈의 목적이다** — 위키 구단 문서를 다시 받지 않고 시드만 읽어서
   * 중복을 가른다. 두 구단에 걸친 중복도, 한 구단 안에 두 번 실린 것도 같은 축이
   * 잡는다: 한 사람은 QID 하나이고, 그 QID는 시드에 한 번만 나온다.
   */
  it("같은 wikidataId가 두 행에 실려 있지 않다", () => {
    const rowsOfQid = new Map<string, string[]>();
    for (const [team, squad] of Object.entries(ALL_SQUADS)) {
      for (const seed of squad) {
        if (seed.wikidataId === undefined) continue;
        const at = `${team}:${seed.nameEn}(${seed.birthdate})`;
        rowsOfQid.set(seed.wikidataId, [...(rowsOfQid.get(seed.wikidataId) ?? []), at]);
      }
    }
    const violations = [...rowsOfQid]
      .filter(([, rows]) => rows.length > 1)
      .map(([qid, rows]) => `${qid} — ${rows.join(", ")}`);

    expect(violations).toEqual([]);
  });

  it("같은 (이름 + 생년월일)이 두 구단에 실려 있지 않다", () => {
    const teamsOf = new Map<string, string[]>();
    for (const [team, squad] of Object.entries(ALL_SQUADS)) {
      for (const seed of squad) {
        const key = `${seed.nameEn}|${seed.birthdate}`;
        teamsOf.set(key, [...(teamsOf.get(key) ?? []), team]);
      }
    }
    const violations = [...teamsOf]
      .filter(([, teams]) => new Set(teams).size > 1)
      .map(([key, teams]) => `${key} — ${teams.join(", ")}`);

    expect(violations).toEqual([]);
  });

  it("한 구단이 같은 등번호를 두 명에게 주지 않는다", () => {
    const violations = Object.entries(ALL_SQUADS).flatMap(([team, squad]) => {
      const namesOf = new Map<number, string[]>();
      for (const seed of squad) {
        if (seed.squadNumber === undefined) continue;
        namesOf.set(seed.squadNumber, [...(namesOf.get(seed.squadNumber) ?? []), seed.nameEn]);
      }
      return [...namesOf]
        .filter(([, names]) => names.length > 1)
        .map(([number, names]) => `${team} #${number} — ${names.join(", ")}`);
    });

    expect(violations).toEqual([]);
  });
});

/**
 * 부상 이력 조인 — **표의 키가 전부 시드에 닿는가.**
 *
 * `INJURY_HISTORY`는 `RealPlayerSeed.wikidataId`(QID)로 잇는다(`injury.ts`
 * `seedInjuryHistory`). 그 선수가 시드에서 빠지거나 QID가 지워지면 그 이력은
 * **조용히 죽는다** — 부상 행도 초기 성향도 생기지 않고, 화면엔 아무 일도 안 난
 * 것처럼 보인다. 오타 하나로 리스 제임스가 철인이 되는 자리다.
 *
 * 반대 방향(시드에 있는데 이력이 없다)은 위반이 아니다 — 조사가 닿은 선수만
 * 적는 표다 (injury-history.ts 상단).
 */
describe("부상 이력 조인 — 이력의 QID가 시드에 없다", () => {
  const ALL_SQUADS: Record<string, readonly RealPlayerSeed[]> = {
    ...REAL_SQUADS,
    ...EU_SQUADS,
    ...MARKET_LEAGUE_SQUADS,
  };
  const ALL_SEEDS = Object.values(ALL_SQUADS).flat();

  it("INJURY_HISTORY의 모든 키가 실선수 시드의 wikidataId에 있다", () => {
    const seeded = new Set(
      ALL_SEEDS.flatMap((s) => (s.wikidataId === undefined ? [] : [s.wikidataId])),
    );
    const orphans = Object.keys(INJURY_HISTORY).filter((qid) => !seeded.has(qid));

    expect(orphans).toEqual([]);
  });
});

// ─── 로스터 깊이 (roster-depth.test.ts에서 옮겨 왔다 — 같은 시드 배열 불변식) ───
/** 스쿼드를 갖는 클럽만 — 무소속은 방출·계약 만료로만 사람이 들어온다 */
const CLUBS = teamCatalog().filter((t) => isClubTeam(t.id));
const GROUPS: readonly PositionGroup[] = ["GK", "DF", "MF", "FW"];

/** 골키퍼만 슬롯 하나를 넘겨 잡는다 — 부상·정지로 주전이 빠져도 골문은 비지 않는다 */
const GK_FLOOR = 2;

describe("실선수 로스터 깊이 (30인+, 유망주 포함)", () => {
  const catalog = playerCatalog();
  const rosterOf = (teamId: string) => catalog.filter((e) => e.teamId === teamId);

  it("팀당 18인 이상, 전역 id 유일", () => {
    const global = new Set<string>();
    for (const team of CLUBS) {
      const ids = rosterOf(team.id).map((e) => e.id);
      expect(ids.length).toBeGreaterThanOrEqual(18);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) {
        expect(global.has(id)).toBe(false);
        global.add(id);
      }
    }
    expect(global.size).toBeGreaterThanOrEqual(600);
  });

  it("포지션 그룹별 최소 인원 — 선발·시즌 전환이 고갈로 막히지 않는다", () => {
    for (const team of CLUBS) {
      const roster = rosterOf(team.id);
      const count = (g: PositionGroup) =>
        roster.filter((e) => positionGroupOfPlayer(e) === g).length;
      /**
       * 엔진이 요구하는 것은 **프리셋 하나를 제자리 선수로 채울 수 있는가**뿐이다 —
       * `pickFormation`은 스쿼드가 감당하는 모양을 고르지 특정 모양을 강요하지 않는다.
       * 수비수가 넷인 구단은 5백을 안 설 뿐 깨진 것이 아니다.
       */
      const fillable = Object.values(FORMATION_SLOTS).some((slots) =>
        GROUPS.every((g) => count(g) >= slots.filter((s) => positionGroupOf(s) === g).length),
      );
      expect(fillable, `${team.id}: 어떤 프리셋도 제자리 선수로 채울 수 없다`).toBe(true);
      expect(count("GK"), `${team.id}: 백업 골키퍼가 없다`).toBeGreaterThanOrEqual(GK_FLOOR);
    }
  });
});

/**
 * 국적 — **한 명도 빠지지 않는다** (core/sources.md §4.1 · domain/nationality.ts).
 *
 * 이 축은 비어 있는 것을 허용할 수 없다: 등록 규정도 대표팀도 "국적을 모르는 선수"
 * 갈래를 따로 들 수 없어서, 하나가 비면 그 위의 규칙이 통째로 서지 못한다. 그래서
 * 시드가 답하지 않는 선수는 클럽 협회로 파생하고, 그 파생이 실제로 전원을 덮는지를
 * 여기서 센다.
 */
describe("국적 — 시드와 파생이 전원을 덮는다", () => {
  const seeds: RealPlayerSeed[] = [
    ...Object.values(REAL_SQUADS).flat(),
    ...Object.values(EU_SQUADS).flat(),
    ...Object.values(MARKET_LEAGUE_SQUADS).flat(),
  ];

  it("시드에 적힌 국적 코드는 전부 협회 표에 있다", () => {
    const bad = seeds.filter(
      (s) =>
        (s.nationality !== undefined && !isAssociation(s.nationality)) ||
        (s.secondNationality !== undefined && !isAssociation(s.secondNationality)),
    );
    expect(bad.map((s) => `${s.nameEn}(${s.nationality}·${s.secondNationality})`)).toEqual([]);
    // 둘째 국적은 첫째와 달라야 한다 — 같은 값이 두 칸에 있으면 EU 판정이 한 사실을 두 번 센다
    expect(
      seeds
        .filter((s) => s.secondNationality !== undefined && s.nationality === s.secondNationality)
        .map((s) => s.nameEn),
    ).toEqual([]);
  });

  it("카탈로그의 모든 선수에게 국적이 서고, 아는 협회 코드다", () => {
    expect(checkPlayerNationality(playerCatalog())).toEqual([]);
  });

  it("시드가 답하지 않으면 그 클럽 협회로 서고, 몇 번을 물어도 같은 값이다", () => {
    expect(deriveNationality("arsenal", undefined)).toBe("ENG");
    expect(deriveNationality("arsenal", undefined)).toBe("ENG");
    expect(deriveNationality("realmadrid", undefined)).toBe("ESP");
    // 시드에 값이 있으면 파생은 물러난다
    expect(deriveNationality("arsenal", "BRA")).toBe("BRA");
    // 카탈로그가 모르는 팀에는 협회가 없다
    expect(deriveNationality("no-such-team", undefined)).toBeUndefined();
  });
});
