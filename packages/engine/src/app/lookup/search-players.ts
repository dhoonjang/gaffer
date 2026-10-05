import {
  GROWTH_OUTLOOKS,
  type GrowthOutlookKey,
  type StrongFoot,
  ageOf,
  strongFootOf,
} from "@gaffer/domain";
import { rankByName } from "../../core/name-match";
import { isHomegrownFor } from "../../team/registration";
import { competitionName } from "../../core/catalog/cup-catalog";
import {
  inPlayerPool,
  playerPoolOf,
  resolveCompetition,
  type PlayerPool,
} from "../../team/player-pool";
import { KNOWLEDGE_RANK } from "../../players/observation-view";
import { knowledgeOf, growthOutlook, type Knowledge } from "../../players/observation";
import {
  isAvailableFor,
  ourPlayers,
  playersOf,
  squadLevelOf,
  teamNameIn,
  type GameState,
} from "../../core/state";
import {
  LookupResult,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  resolveTeam,
  disciplineFixtureOf,
  playerRow,
  contractIndexOf,
  daysLeftOn,
  sortKeyOf,
} from "./resolve";

// ── 검색 ────────────────────────────────────────────────

export interface SearchPlayersInput {
  /** "mine" | 팀 id | 팀 이름 — 생략하면 competition(그것도 없으면 1·2부 전 클럽) */
  team?: string;
  /**
   * 대회로 좁히기 — 리그면 소속 팀, 대항전이면 참가 팀.
   * 없으면 풀이 **5대 리그 1·2부 전체**라 "우리 리그 최고 스트라이커"의 답이 조용히 어긋난다.
   */
  competition?: string;
  /** 포지션 코드 (주 포지션 또는 소화 가능 포지션) */
  position?: string;
  /** 이름·id 부분 일치 */
  name?: string;
  minAge?: number;
  maxAge?: number;
  /** 1군·2군 — 우리 팀에서 유망주만 보기 */
  squadLevel?: "first" | "reserve";
  /** 부상·정지 제외 */
  availableOnly?: boolean;
  /**
   * 계약이 이 일수 안에 끝나는 선수 — 만료되면 무소속으로 떠나는 사람들.
   * 무계약(무소속)은 잔여 0일이라 언제나 걸린다.
   */
  contractEndsWithinDays?: number;
  /** 주급 상한 (£/주) — 계약서의 값 그대로, 흐리지 않는다 */
  maxWage?: number;
  /** 우리 협회 기준 홈그로운 — 등록 명단 8명 규칙(team.md §5)의 그 자격 */
  homegrown?: boolean;
  /** 성장 가능성이 이 단계 이상. 판단 보류인 선수는 통과하지 못한다 */
  minGrowth?: GrowthOutlookKey;
  /** 최소 지식 수준 — `"seen"`이면 직접 상대해 봤거나 그보다 잘 아는 선수만 */
  knowledge?: Knowledge;
  /** 주발 — 행이 찍는 그 세 갈래 (`footLabel`과 같은 자) */
  foot?: StrongFoot;
  sortBy?:
    | "rating"
    | "age"
    | "fatigue"
    | "goals"
    | "apps"
    | "wage"
    | "contract"
    | "assists"
    | "seasonRating"
    | "growth";
  limit?: number;
}

export function searchPlayers(state: GameState, input: SearchPlayersInput): LookupResult {
  let teamId: string | null = null;
  if (input.team) {
    const team = resolveTeam(state, input.team);
    if (!team.ok) return team;
    teamId = team.teamId;
  }

  const competition = resolveCompetition(input.competition);
  if (!competition.ok) return competition;
  const competitionId = competition.competitionId;
  // 대회·자리·나이로 거른다 (team/player-pool.ts)
  const poolFilter: PlayerPool = playerPoolOf(state, {
    competitionId,
    ...(input.position === undefined ? {} : { position: input.position }),
    ...(input.minAge === undefined ? {} : { minAge: input.minAge }),
    ...(input.maxAge === undefined ? {} : { maxAge: input.maxAge }),
  });

  // 원장·목록을 읽는 조건은 색인을 한 번 세워 둔다 — 선수마다 훑으면 5,700번이다
  const contracts =
    input.contractEndsWithinDays !== undefined || input.maxWage !== undefined
      ? contractIndexOf(state)
      : null;

  /**
   * **싼 조건이 앞에 선다.** 안개에서 파생하는 둘(지식 수준·성장 가능성)은 선수마다
   * 기록을 훑으므로, 앞의 조건이 좁혀 준 만큼만 계산한다.
   */
  /**
   * 「지금 뛸 수 있나」는 **그 선수 팀의 다음 대회 경기**로 답한다 (match.md §6) —
   * 컵 정지 선수는 리그 명단에 그대로 선다. 팀마다 한 번만 찾아 둔다: 선수마다
   * 일정을 훑으면 5,700번이다.
   */
  const nextCompetitionCache = new Map<string, string | null>();
  const nextCompetitionFor = (ownerId: string): string | null => {
    const cached = nextCompetitionCache.get(ownerId);
    if (cached !== undefined) return cached;
    const found = disciplineFixtureOf(state, ownerId)?.competitionId ?? null;
    nextCompetitionCache.set(ownerId, found);
    return found;
  };
  const ourPool = teamId !== null && teamId === state.userTeamId;
  const pool0 = teamId ? (ourPool ? ourPlayers(state) : playersOf(state, teamId)) : state.players;
  const narrowed = pool0.filter((p) => {
    if (!inPlayerPool(state, p, poolFilter)) return false;
    if (input.squadLevel && squadLevelOf(p) !== input.squadLevel) return false;
    if (input.foot !== undefined && strongFootOf(p.foot) !== input.foot) return false;
    // 홈그로운은 **우리 협회** 기준이다 — 지금 소속이 아니라 우리가 등록할 때의 자격
    if (input.homegrown !== undefined && isHomegrownFor(p, state.userTeamId) !== input.homegrown) {
      return false;
    }
    if (input.availableOnly && !isAvailableFor(state, p, nextCompetitionFor(p.teamId))) {
      return false;
    }
    if (contracts) {
      const contract = contracts.get(p.id);
      if (
        input.contractEndsWithinDays !== undefined &&
        daysLeftOn(state, contract) > input.contractEndsWithinDays
      ) {
        return false;
      }
      if (input.maxWage !== undefined && (contract?.weeklyWage ?? 0) > input.maxWage) return false;
    }
    if (
      input.knowledge !== undefined &&
      KNOWLEDGE_RANK[knowledgeOf(state, p.id)] < KNOWLEDGE_RANK[input.knowledge]
    ) {
      return false;
    }
    if (input.minGrowth !== undefined) {
      // 판단 보류인 선수를 통과시키면 모르는 것을 "넘는다"고 답하게 된다
      const growth = growthOutlook(state, p);
      if (growth === null || growth.tier < GROWTH_OUTLOOKS.indexOf(input.minGrowth)) return false;
    }
    return true;
  });
  // 이름은 마지막에 — 다른 조건으로 좁힌 만큼만 자모까지 내려가면 된다
  const pool = input.name ? rankByName(input.name, narrowed).matches : narrowed;

  const sortBy = input.sortBy ?? "rating";
  /**
   * **정렬 키는 비교자가 아니라 풀에서 뽑는다.**
   *
   * 비교자 안의 `seasonStatOf`·`activeContract`는 한 번이 원장 전체 훑기라,
   * 5,700명을 세우면 그 선형 탐색이 n·log n번 돈다(주급 정렬 실측 2.7초).
   * 키를 선수당 한 번만 뽑아 두면 비교는 숫자 대 숫자가 된다 — 순서는 그대로다.
   */
  const key = sortKeyOf(state, pool, sortBy, competitionId);
  const sorted = [...pool].sort((a, b) => {
    switch (sortBy) {
      case "age":
        return ageOf(a.birthdate, state.date) - ageOf(b.birthdate, state.date);
      case "fatigue":
      case "contract":
        // 지친 순·계약이 먼저 끝나는 순 — 낮은 쪽이 앞
        return key(a) - key(b);
      default:
        return key(b) - key(a);
    }
  });

  // 무엇을 뒤졌는지 밝힌다 — 풀을 모르면 "리그 득점왕"이라는 답이 조용히 어긋난다
  const scope =
    [
      teamId ? teamNameIn(state, teamId) : null,
      competitionId ? competitionName(competitionId) : null,
      input.squadLevel ? (input.squadLevel === "first" ? "1군" : "2군") : null,
    ]
      .filter((x): x is string => x !== null)
      .join(" · ") || "5대 리그 1·2부 전체 — 한 대회로 좁히려면 competition을 주라";

  if (sorted.length === 0) {
    return { ok: true, message: `[검색 결과] 대상: ${scope}\n조건에 맞는 선수가 없습니다` };
  }
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const shown = sorted.slice(0, limit);
  const head = `[검색 결과] 대상: ${scope} — ${sorted.length}명 중 ${shown.length}명 (정렬: ${sortBy})`;
  const tail =
    sorted.length > shown.length
      ? `\n…그 외 ${sorted.length - shown.length}명 — 조건을 좁히거나 limit을 올려라`
      : "";
  return { ok: true, message: [head, ...shown.map((p) => playerRow(state, p))].join("\n") + tail };
}
