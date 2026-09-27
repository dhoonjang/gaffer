import {
  type Approach,
  type ApproachContext,
  type Dismissal,
  type GamePlayer,
  type GameTeam,
  type InterviewOutcome,
  type ManagerContract,
  type ManagerOffer,
  type ManagerPoolEntry,
  type ManagerVacancy,
  type PressFact,
  type TickSink,
  AI_MANAGER_RATING_FALLBACK,
  MANAGER_TERMS_BY_TIER,
  RENEWAL_NOTICE_DAYS,
  ageOf,
  boardExpectationText,
  clampCondition,
  formatMoney,
  josa,
  naturalPositionOf,
} from "@story-fm/domain";
import { item } from "../../common/commands/brief";
import { type CommandResult } from "../../common/commands/result";
import { tierOfTeamIn } from "../../common/core/club-tier";
import { addDays, contractUntil, diffDays } from "../../common/core/dates";
import { leagueOfTeamIn, leagueSizeIn } from "../../common/core/league-membership";
import { positionAt, relegationLine } from "../../common/core/league-shape";
import { makeRng, randInt } from "../../common/core/rng";
import {
  type CommandBriefItem,
  type GameState,
  activeContract,
  financeOf,
  firstTeamPlayers,
  pendingApproach,
  playersOf,
  pushApproach,
  pushNarrative,
  teamNameIn,
  teamShortNameIn,
  weeklyWagesOf,
} from "../../common/core/state";
import { norm } from "../../common/core/team-ref";
import { topLeagues } from "../../common/data/league-catalog";
import { isWorldFigureName } from "../../common/data/world-figures";
import { generateOwner, inventPersonName, occupiedPersonNames } from "../../common/people/persona";
import { boardExpectation } from "../../common/views/board-expectation";
import { type StandingRow, computeStandings } from "../../common/views/standings";
import { annualRevenueEstimate, wageRatioTone } from "../finance/finance";

/**
 * 감독 시장 — **벤치의 사람도 바뀐다.**
 *
 * 이게 없으면 리그의 감독은 시즌이 끝나도 그대로다. 12월에 6연패를 한 구단이
 * 이듬해 5월까지 같은 벤치로 앉아 있고, 감독이 겪는 세계에서 "라이벌이 감독을
 * 갈아치웠다"는 사건이 아예 일어나지 않는다.
 *
 * 판단은 단순하다 — **기대와 실제의 거리**. 구단 등급이 기대 순위를 정하고
 * (`boardExpectation`), 그보다 한참 아래로 처지면 자리가 흔들린다. 실제 경질도
 * 대개 그 계산이다.
 *
 * ## 감독 팀도 예외가 아니다
 *
 * 다만 **감독은 미리 안다.** AI 구단은 조용히 자르지만 감독에게는 경고가 먼저
 * 온다(보드 평판이 깎이고 브리핑에 줄이 선다). 아무 예고 없이 세이브가 끝나면
 * 그건 사건이 아니라 사고다.
 */

/** 이만큼은 치러야 판단한다 — 개막 직후의 순위는 순위가 아니다 */
export const MIN_MATCHES = 8;

/** 부임 직후의 유예 (일) — 새 감독에게 시간을 준다 */
export const GRACE_DAYS = 75;

/**
 * 등급별 문턱 — **위험한 순위와 잘리는 순위**를 리그 크기의 비율로 적는다.
 *
 * ⚠️ 기대 순위와의 **차이**로만 재면 하위 구단은 영원히 안 잘린다: 잔류가 기대인
 * 팀은 꼴찌를 해도 차이가 강등 칸 수뿐이다. 실제로도 강등권 팀 감독이 가장 자주
 * 잘리는데 그 반대가 됐다. 그래서 등급마다 자리를 직접 적는다.
 *
 * ⚠️ **자리를 순위로 적으면 18팀 리그가 어긋난다** — tier 4의 20위는 분데스리가에
 * 없는 자리라 그 리그의 잔류권 구단은 아무리 처져도 감독이 안 잘렸다. 20팀을 넣으면
 * 예전 값 6·10 / 10·14 / 15·18 / 18·20이 그대로 나온다 (career.md §5).
 */
const SEAT_BAND: Record<number, { danger: number; sack: number }> = {
  1: { danger: 0.3, sack: 0.5 },
  2: { danger: 0.5, sack: 0.7 },
  3: { danger: 0.75, sack: 0.9 },
};

/**
 * 이 구단의 자리 — 체급은 **세이브가 갖는다**(team.md §2), 카탈로그가 아니다.
 * 잔류가 기대인 tier 4는 비율이 아니라 리그의 모양이 자리를 정한다: 강등권에
 * 들어가면 위험하고 꼴찌면 자리가 없다.
 */
export function managerSeatThresholds(
  state: GameState,
  teamId: string,
): { danger: number; sack: number } {
  const size = leagueSizeIn(state, teamId);
  const tier = tierOfTeamIn(state, teamId);
  if (tier === 4) return { danger: relegationLine(size), sack: size };
  const band = SEAT_BAND[tier]!;
  return { danger: positionAt(size, band.danger), sack: positionAt(size, band.sack) };
}

/** 하루에 잘리는 감독 수 상한 — 리그가 하루아침에 뒤집히지 않게 */
export const SACKINGS_PER_DAY = 2;

/** 문턱에 걸린 구단이 오늘 결단할 확률 — 시즌 96구단 중 30건 안팎이 되게 */
export const SACK_CHANCE = 0.09;

/** 새 감독 효과 — 실제로 관측되는 반등(잠깐이지만 분명하다) */
const NEW_MANAGER_BOUNCE = 6;

/**
 * **무직 감독 풀의 상한** — 시즌 30건 안팎의 경질이 나므로 한 시즌 반쯤이다
 * (transfer.md §7 「감독 풀」). 넘으면 자리를 잃은 지 오래된 순으로 민다: 두
 * 시즌째 부르는 데 없는 사람은 세계가 잊은 사람이다.
 */
export const MANAGER_POOL_MAX = 40;

/**
 * 공석이 **풀에서** 사람을 찾을 확률. 풀이 빈 첫 시즌은 이 값과 무관하게 예전처럼
 * 굴러가고(후보가 없으면 지어낸다), 시즌이 쌓일수록 아는 얼굴이 돌아온다.
 */
const POOL_HIRE_CHANCE = 0.6;

/** 그 벤치의 눈높이와 후보 역량치의 허용 차 — 이 폭이 곧 등급 문이다 */
const POOL_RATING_BAND = 8;

/**
 * 자리를 잃고 이만큼은 지나야 후보가 된다. 오늘 잘린 사람이 내일 옆 구단에 서면
 * 그건 이동이 아니라 자리 바꾸기다.
 */
const POOL_HIRE_COOLDOWN_DAYS = 21;

/**
 * **무직 감독을 부르는 평판 문턱** — `(보드 + 미디어) / 2` (career.md §5.1).
 *
 * 경질 직후의 보드 평판은 25 이하라 합이 대개 40 언저리다. 그래서 잘린 감독이
 * 곧장 가는 곳은 tier 3·4이고, 위로 올라가려면 그 자리에서 성적을 내야 한다.
 * tier 4는 문턱이 없다 — 잔류가 기대인 구단은 사람을 가리지 않는다.
 */
export const OFFER_REPUTATION_GATE: Partial<Record<1 | 2 | 3 | 4, number>> = {
  1: 70,
  2: 55,
  3: 40,
};

/** 문턱을 넘은 공석이 오늘 부를 확률 — 매번 부르면 경질이 하루짜리 사건이 된다 */
const OFFER_CHANCE = 0.2;

/** 제안이 살아 있는 날 수 — 답을 미루는 것도 답이다 */
const OFFER_DAYS = 10;

/**
 * 마지막 제안으로부터 이만큼 지나도록 새 제안이 없으면 다음 문턱을 넘는 자리는
 * 확률을 건너뛴다 — 세이브가 무직으로 굳지 않게 하는 안전판이다 (career.md §5.1).
 * 기준이 "제안이 아예 없었다"이면 첫 제안(10일 만료)을 놓친 뒤로는 안전판이 없다.
 */
export const OFFER_DRY_SPELL_DAYS = 120;

/**
 * 공석 명부가 열려 있는 날 수 — 경질 뒤 이만큼은 무직 감독이 먼저 두드릴 수 있다
 * (career.md §5.1). 새 감독은 그날로 서지만, 갓 앉은 벤치는 아직 굳지 않았다.
 */
export const VACANCY_KNOCK_DAYS = 14;

/** 지원해서 선 제안의 연봉 배율 — 아쉬운 쪽이 깎인다 (career.md §5.1) */
export const KNOCK_SALARY_RATE = 0.85;

/**
 * **재직 감독을 부르는 자리의 등급 여유** — 우리 등급보다 이만큼 아래까지 부를 수
 * 있다 (career.md §5.1 「재직 중 접근·노크」). 0이면 우리보다 낮은 등급은 부르지
 * 않는다: 내려가는 이직은 세계가 먼저 부를 일이 아니라 감독이 두드릴 일이다.
 */
const POACH_TIER_MARGIN = 0;

/**
 * 재직 감독을 부르려면 평판이 문턱 위로 이만큼 서 있어야 한다 (career.md §5.1).
 *
 * 무직의 문턱(`OFFER_REPUTATION_GATE`)이 「이 사람을 앉혀도 되나」라면 여기는
 * 「위약금을 물고 서 있는 사람을 빼올 만한가」라, 같은 표에 여유가 얹힌다 —
 * tier 1 80 · 2 65 · 3 50 · 4 35. 시작 평판이 50이라 위는 성적으로만 열린다.
 */
const POACH_REPUTATION_MARGIN = 10;

/**
 * 문턱을 넘은 자리가 오늘 재직 감독을 부를 확률 — 무직의 `OFFER_CHANCE`보다 낮다.
 * 매 시즌 여러 번 오면 자리를 옮기는 일이 사건이 아니라 일상이 된다.
 */
const POACH_CHANCE = 0.06;

/**
 * 보드가 재계약 여부를 판정하는 시점 — 값은 도메인이 갖는다. 판정을 내리는 이
 * 파일과 그 뒤 회견마다 거취를 사실로 세우는 `club/press.ts`가 같은 값을 읽는다.
 */
export { RENEWAL_NOTICE_DAYS };

/**
 * 경질 위약금이 무는 **잔여 연봉의 비율** (career.md §5.4).
 *
 * 잔여 전액을 물리면 tier 1의 3년 계약이 £18M — 이적 예산 한 시즌치가 경질 하루에
 * 사라진다. 절반이면 tier 1 최대 £6M이고, 잔여가 짧을수록 싸져 시즌 말 경질이
 * 구단에 싸다는 실제 결이 남는다.
 *
 * 선수 합의 해지의 정산 비율(`market.ts`의 `SEVERANCE_RATE`)과 값이 같지만 **다른
 * 손잡이다** — 하나는 선수가 합의해 줄 앵커고 하나는 구단이 무는 대가라, 합치면
 * 어느 한쪽을 조율할 때 다른 쪽이 딸려 움직인다.
 */
export const MANAGER_SEVERANCE_RATE = 0.5;

/** 잔여를 연 단위로 환산하는 자 — 위약금은 남은 **날**에 비례한다 */
const DAYS_PER_YEAR = 365;

/**
 * tier 4의 흥정 기준점 — 문턱이 없는 등급이라 여유의 출발점만 여기서 잰다.
 * 경질 직후 보드 평판의 바닥(`USER_BOARD_FLOOR`)과 같은 값이다: 그 처지에서는
 * 여유도 바닥에서 시작한다.
 */
const TIER4_HEADROOM_ANCHOR = 25;

/** 문턱에 턱걸이인 감독이 받는 최소 폭 */
const COUNTER_HEADROOM_MIN = 0.05;

/** 아무리 이름값이 커도 여기서 멈춘다 */
const COUNTER_HEADROOM_MAX = 0.3;

/** 문턱 위 평판 1점이 폭을 넓히는 자 — `MIN`에서 `MAX`까지 딱 50점이 걸린다 */
const COUNTER_HEADROOM_SPAN = 200;

/**
 * **흥정의 여유** — 보드가 제시 조건 위로 물러설 수 있는 비율 (career.md §5.1).
 *
 * 문턱(`OFFER_REPUTATION_GATE`)을 얼마나 넘어서 있느냐가 폭이다: 문턱에 턱걸이면
 * 5%, 50을 넘으면 상한 30%. 평판이 문턱 아래인 제안(안전판·tier 4)은 최저 폭만
 * 받는다.
 */
export function counterHeadroom(reputation: number, tier: 1 | 2 | 3 | 4): number {
  const anchor = OFFER_REPUTATION_GATE[tier] ?? TIER4_HEADROOM_ANCHOR;
  return Math.min(
    COUNTER_HEADROOM_MAX,
    COUNTER_HEADROOM_MIN + Math.max(0, reputation - anchor) / COUNTER_HEADROOM_SPAN,
  );
}

/**
 * 경고 단계의 눈금은 **도메인이 갖는다**
 * (people.md §9). 여기서 부르던 자리가 옮기지 않게 다시 내보낸다.
 */

/**
 * 순위표를 리그당 한 번만 짓는 자 — **같은 표를 96번 세우지 않는다.**
 *
 * `runManagerMarket`은 96구단을 돌며 각자의 순위를 묻는데, 순위표는 경기 원장에서
 * 파생하고 이 루프는 원장을 건드리지 않는다(감독 이름·선수 상태만 바뀐다). 한 번
 * 세운 표를 그대로 돌려줘도 같은 답이다.
 */
export function standingsCache(state: GameState): (leagueId: string) => StandingRow[] {
  const built = new Map<string, StandingRow[]>();
  return (leagueId) => {
    let table = built.get(leagueId);
    if (!table) {
      table = computeStandings(state, leagueId);
      built.set(leagueId, table);
    }
    return table;
  };
}

/** 그 팀이 리그에서 몇 위인가 (1부만 — 2부는 리그전이 없다) */
function positionOf(
  state: GameState,
  teamId: string,
  tableOf: (leagueId: string) => StandingRow[],
): { position: number; played: number } | null {
  const leagueId = leagueOfTeamIn(state, teamId);
  if (!topLeagues().some((l) => l.id === leagueId)) return null;
  const table = tableOf(leagueId);
  const index = table.findIndex((r) => r.teamId === teamId);
  if (index < 0) return null;
  return { position: index + 1, played: table[index]!.played };
}

/** 지금 자리 — 순위와 소화 경기 수 */
export function seatStatus(
  state: GameState,
  teamId: string,
  tableOf: (leagueId: string) => StandingRow[] = standingsCache(state),
): { position: number; played: number } | null {
  return positionOf(state, teamId, tableOf);
}

/** 부임한 지 얼마나 됐나 — 무소속(부임일이 없다)은 시즌 시작으로 본다 */
export function daysInCharge(
  state: GameState,
  team: { managerSince?: string } | undefined,
): number {
  const since = team?.managerSince ?? state.calendar.preseasonStart;
  // 부임일이 오늘보다 뒤인 세이브는 없지만, 음수를 그대로 흘리면 유예 판정이 뒤집힌다
  return Math.max(0, diffDays(since, state.date));
}

/**
 * **벤치에서 내려온 사람을 무직 감독 풀에 앉힌다** (transfer.md §7 「감독 풀」).
 *
 * 경질도, 유저가 그 자리에 부임하는 것도 그 사람에게는 같은 하루다 — 자리를
 * 잃었다. 그래서 두 자리가 이 함수 하나를 부른다.
 *
 * 벤치에 이름이 없으면(유저 팀) 앉힐 사람이 없다.
 */
export function poolSacked(state: GameState, team: GameTeam): void {
  const name = team.managerName;
  if (name === undefined) return;
  /**
   * ⚠️ **감독 자신은 앉지 않는다** (transfer.md §7 「감독 풀」). 감독이 떠난 벤치도
   * 그날로 후임을 세우지만, 거기 서 있던 이름은 감독의 것이라 풀에 넣으면 세계가
   * 그 이름으로 다른 벤치를 채운다 — 감독이 둘이 된다.
   */
  if (name === state.manager.name) return;
  const pool = state.managerPool;
  // 이름이 곧 `characterId`(전역 유일)라 같은 이름이 두 줄에 앉을 수 없다 (people.md §1)
  if (pool.some((e) => e.name === name)) return;

  const spell = {
    teamId: team.id,
    from: team.managerSince ?? state.calendar.preseasonStart,
    to: state.date,
  };
  const entry: ManagerPoolEntry = {
    name,
    ...(isWorldFigureName(name) ? { real: true } : {}),
    rating: team.aiManagerTacticsRating ?? AI_MANAGER_RATING_FALLBACK,
    lastTeamId: team.id,
    sackedOn: state.date,
    spells: [...team.managerSpells, spell],
  };

  /**
   * 상한을 넘으면 **자리를 잃은 지 오래된 순으로 민다** — 같은 날이면 먼저 앉은
   * 사람이 먼저 밀린다. 정렬이 안정적이어야 같은 시드가 같은 세계를 돌린다.
   */
  const next = [...pool, entry];
  state.managerPool =
    next.length <= MANAGER_POOL_MAX
      ? next
      : next
          .map((e, index) => ({ e, index }))
          .sort((a, b) => b.e.sackedOn.localeCompare(a.e.sackedOn) || b.index - a.index)
          .slice(0, MANAGER_POOL_MAX)
          .sort((a, b) => a.index - b.index)
          .map(({ e }) => e);
}

/**
 * 이 벤치의 눈높이에 맞는 무직 감독 — 없으면 `null` (transfer.md §7 「감독 풀」).
 *
 * 등급 문턱을 따로 적지 않는 이유: **체급은 이미 역량치 안에 있다.** 톱클럽에서
 * 잘린 사람의 역량치는 그대로라 하위 구단의 눈높이와 `POOL_RATING_BAND`를 넘게
 * 벌어진다.
 */
function hireFromPool(
  state: GameState,
  teamId: string,
  target: number,
  rng: () => number,
): ManagerPoolEntry | null {
  const candidates = state.managerPool.filter(
    (e) =>
      // 자기가 방금 자른 사람을 다시 부르지는 않는다 — 그건 선임이 아니라 번복이다.
      // 그 앞의 구단은 막지 않는다: 몇 해 뒤의 복귀는 이야기가 되는 자리다
      e.lastTeamId !== teamId &&
      diffDays(e.sackedOn, state.date) >= POOL_HIRE_COOLDOWN_DAYS &&
      Math.abs(e.rating - target) <= POOL_RATING_BAND,
  );
  // 확률을 후보 유무와 무관하게 먼저 굴린다 — 순서가 흔들리면 같은 시드가 다른 세계를 돈다
  const drawn = rng() < POOL_HIRE_CHANCE;
  if (!drawn || candidates.length === 0) return null;
  const picked = candidates[randInt(rng, 0, candidates.length - 1)]!;
  state.managerPool = state.managerPool.filter((e) => e.name !== picked.name);
  return picked;
}

/**
 * 새 감독을 앉힌다 — 이름·전술 역량치·부임일, 그리고 선수단의 짧은 반등.
 *
 * **풀에서 먼저 찾고, 없으면 지어낸다** (transfer.md §7 「감독 풀」). 풀에서 온
 * 사람은 이름·사람됨·역량치·이력을 그대로 들고 오므로, 그 벤치는 아는 얼굴을
 * 맞는다. 유저가 잘린 구단도 이 길로 후임을 세운다 — 감독이 없는 구단은 세계에 없다.
 *
 * @returns 풀에서 온 사람이면 그 줄, 지어냈으면 `null`
 */
export function installNewManager(
  state: GameState,
  team: GameTeam,
  rng: () => number,
): ManagerPoolEntry | null {
  // 순위표가 없는 팀은 부르는 쪽에서 걸러지므로 무소속은 여기 닿지 않는다 —
  // 폴백은 타입이 요구하는 자리다 (평균 AI 감독)
  const before = team.aiManagerTacticsRating ?? AI_MANAGER_RATING_FALLBACK;
  /** 구단이 원하는 사람 — 직전보다 조금 나은 쪽으로 기운다 */
  const target = Math.min(92, Math.max(50, before + randInt(rng, -4, 10)));

  /**
   * **전임을 풀에 넣기 전에 고른다** — 오늘 잘린 사람이 오늘 자기 자리에 다시
   * 앉는 일이 없어야 한다. 식은 기간이 이미 막지만, 순서로도 막는다.
   */
  const hired = hireFromPool(state, team.id, target, rng);
  const outgoing = { ...team };

  if (hired !== null) {
    team.managerName = hired.name;
    // 역량치는 사람이 들고 다닌다 — 그래서 아는 얼굴이 아는 축구를 데려온다
    team.aiManagerTacticsRating = hired.rating;
    team.managerSpells = hired.spells;
  } else {
    team.aiManagerTacticsRating = target;
    // 이미 선 사람들의 이름은 피한다 — 전임도 그 집합에 있으므로 후임은 반드시
    // 다른 이름, 곧 다른 사람이다 (사람됨 채널이 이름이다 — people.md §2)
    team.managerName = inventPersonName(rng, team.id, occupiedPersonNames(state));
    // 전임의 이력이 남으면 지어낸 사람이 남의 과거를 갖는다
    team.managerSpells = [];
  }
  team.managerSince = state.date;
  poolSacked(state, outgoing);

  /**
   * **새 감독 효과** — 실제로 관측되는 짧은 반등이다. 선수단이 다시 뛴다:
   * 폼과 컨디션이 조금 오르고, 그 덕에 다음 몇 경기의 결과가 달라진다.
   */
  for (const player of playersOf(state, team.id)) {
    player.state.condition = clampCondition(player.state.condition + NEW_MANAGER_BOUNCE);
    player.state.form = Math.min(1, player.state.form + 0.1);
  }
  return hired;
}

/** 지금 열려 있는 제안 — 만료일 순 (가장 먼저 사라질 것이 앞) */
export function openManagerOffers(state: GameState): ManagerOffer[] {
  return state.managerOffers
    .filter((o) => o.status === "open" && o.expiresOn >= state.date)
    .sort((a, b) => a.expiresOn.localeCompare(b.expiresOn) || a.id.localeCompare(b.id));
}

/** 제안에 걸린 기대 한 줄 — 코드에서 만든다 (career.md §5.1) */
export function offerExpectation(offer: ManagerOffer): string {
  return boardExpectationText(offer.expectationCode, offer.target);
}

/** 기한이 지난 제안은 사라진다 — 답하지 않은 것도 답이다 */
export function expireStaleOffers(state: GameState, digest: TickSink): void {
  for (const offer of state.managerOffers) {
    if (offer.status !== "open" || offer.expiresOn >= state.date) continue;
    offer.status = "expired";
    if (offer.via === "renewal") {
      digest.push(`${teamShortNameIn(state, offer.teamId)}의 재계약 제안이 만료됐다`);
      continue;
    }
    /**
     * **부름을 흘려보낸 것도 답이다** (career.md §5.1) — 재직 중에 온 접근을 그냥
     * 지나가게 두면 보드가 그것을 읽는다. 자기가 두드려 선 제안(`knock`)에는 붙지
     * 않는다: 남은 것이 아니라 두드려 놓고 안 간 것이다.
     */
    if (offer.via === "poach" && !state.dismissal) {
      digest.push(
        `${teamShortNameIn(state, offer.teamId)}의 접근이 답 없이 지나갔다 —` +
          ` 재직 중인 감독은 구단에 남았다`,
      );
      pushNarrative(state, `${teamNameIn(state, offer.teamId)} 접근 무응답`, 4);
      continue;
    }
    digest.push(`${teamShortNameIn(state, offer.teamId)}의 감독직 제안이 만료됐다`);
  }
}

/**
 * **이번 기간이 시작된 날** — 무직이면 자리를 잃은 날, 재직 중이면 부임한 날
 * (career.md §5.1).
 *
 * 「한 구단은 한 번만 부른다」와 「이번에 이미 이야기가 오간 구단」이 같은 자를 읽어야
 * 한다. 세이브 전체로 세면 재임이 쌓일수록 부를 수 있는 구단 풀 자체가 준다.
 */
export function spellStart(state: GameState): string {
  if (state.dismissal) return state.dismissal.on;
  const team = state.teams.find((t) => t.id === state.userTeamId);
  return team?.managerSince ?? state.calendar.preseasonStart;
}

/** 14일이 지난 공석은 명부에서 내려간다 — 새 벤치가 굳은 자리다 (career.md §5.1) */
export function pruneVacancies(state: GameState): void {
  if (state.managerVacancies.length === 0) return;
  state.managerVacancies = state.managerVacancies.filter(
    (v) => diffDays(v.on, state.date) < VACANCY_KNOCK_DAYS,
  );
}

/**
 * 무직 안전판 — **이번 무직 기간의 마지막 제안**으로부터 120일이 지났는가
 * (career.md §5.1). 제안이 아직 없었으면 경질일에서 잰다.
 *
 * 지난 무직 기간의 제안(`madeOn < dismissal.on`)은 세지 않는다 — 기준일이
 * 경질일에서 시작하므로 그보다 앞선 기록은 저절로 걸러진다.
 */
export function offerDrySpell(
  offers: ManagerOffer[] | undefined,
  dismissal: { on: string },
  today: string,
): boolean {
  const anchor = (offers ?? []).reduce(
    (latest, o) => (o.madeOn > latest ? o.madeOn : latest),
    dismissal.on,
  );
  return diffDays(anchor, today) >= OFFER_DRY_SPELL_DAYS;
}

/**
 * 공석이 된 구단이 감독을 부른다 — **무직이면 제안, 재직 중이면 접근**
 * (career.md §5.1).
 *
 * 갈리는 것은 문과 돈이다: 무직은 앉히면 그만이고, 재직 중인 감독은 등급·평판의
 * 문을 더 지나야 하며 옛 구단에 보상금이 간다. 두 길이 한 함수에서 갈리는 것은
 * **부르는 자리가 하나**이기 때문이다 — AI 경질이 낸 그 벤치다.
 *
 * @returns 오늘 제안이 붙었으면 true
 */
export function offerVacancy(
  state: GameState,
  teamId: string,
  position: number,
  digest: TickSink,
): boolean {
  // 감독이 답할 자리는 한 번에 하나다 — 열린 제안도, 답을 기다리는 면접도 그 하나다
  if (openManagerOffers(state).length > 0 || pendingInterview(state)) return false;
  const dismissal = state.dismissal;
  return dismissal
    ? offerToUnemployed(state, dismissal, teamId, position, digest)
    : poachInPost(state, teamId, position, digest);
}

/**
 * **재직 중인 감독에게 다른 구단이 손을 뻗는다** (career.md §5.1 「재직 중 접근·노크」).
 *
 * 문이 넷이다 — 부임 유예, 등급, 평판, 확률. 넷을 다 지나야 제안이 서고, 그 제안은
 * 옛 구단에 물 보상금(`compensation`)을 들고 온다.
 */
function poachInPost(
  state: GameState,
  teamId: string,
  position: number,
  digest: TickSink,
): boolean {
  const contract = state.manager.contract;
  // 무직에게는 손을 뻗을 자리가 없다 — 물 위약금도 없다
  if (!contract) return false;
  // 갓 앉은 벤치는 아직 굳지 않았다 — AI 구단의 유예와 같은 값이다
  const ourTeam = state.teams.find((t) => t.id === state.userTeamId);
  if (daysInCharge(state, ourTeam) < GRACE_DAYS) return false;

  const tier = tierOfTeamIn(state, teamId);
  // 내려가는 이직은 세계가 먼저 부를 일이 아니다 — 그건 감독이 두드릴 일이다
  if (tier > tierOfTeamIn(state, state.userTeamId) + POACH_TIER_MARGIN) return false;

  const offers = state.managerOffers;
  const since = spellStart(state);
  // 한 번 부른 구단은 **이번 재임 안에서는** 다시 부르지 않는다
  if (offers.some((o) => o.madeOn >= since && o.teamId === teamId)) return false;

  /**
   * 문턱이 없는 등급(tier 4)은 `counterHeadroom`이 쓰는 기준점에서 잰다 — 부르는
   * 쪽이 아쉬운 무직의 제안과 달리, 서 있는 사람을 빼오는 데에는 어느 등급이든
   * 「그럴 만한 사람인가」가 있다.
   */
  const gate = (OFFER_REPUTATION_GATE[tier] ?? TIER4_HEADROOM_ANCHOR) + POACH_REPUTATION_MARGIN;
  const reputation = (state.manager.reputation.board + state.manager.reputation.media) / 2;
  if (reputation < gate) return false;

  // 채널을 갈라 뽑는다 — 무직의 제안도 AI 경질의 난수열도 흔들지 않는다
  const rng = makeRng(state.seed, `manager-poach:${state.date}:${teamId}`);
  if (rng() > POACH_CHANCE) return false;

  const expectation = boardExpectation(state, teamId);
  const terms = MANAGER_TERMS_BY_TIER[tier];
  // 금액은 **부를 때** 잰다 — 그 구단이 물기로 한 값이 곧 이 값이다 (career.md §5.1)
  const compensation = managerSeveranceOf(contract, state.date);
  state.managerOffers = [
    ...offers,
    {
      id: `mgr-poach-${teamId}-${state.date}`,
      teamId,
      madeOn: state.date,
      expiresOn: addDays(state.date, OFFER_DAYS),
      tier,
      position,
      target: expectation.target,
      expectationCode: expectation.code,
      salary: terms.salary,
      years: terms.years,
      budgetPledge: terms.budgetPledge,
      ...(compensation > 0 ? { compensation } : {}),
      via: "poach",
      status: "open",
    },
  ];
  digest.push(
    `${josa(teamShortNameIn(state, teamId), "이/가")} 재직 중인 감독에게 손을 뻗었다 —` +
      ` 기대는 ${boardExpectationText(expectation.code, expectation.target)}` +
      ` · 연봉 ${formatMoney(terms.salary)}·${terms.years}년` +
      (compensation > 0 ? ` · 우리 구단에 보상금 ${formatMoney(compensation)}` : "") +
      ` · ${OFFER_DAYS}일 안에 답해야 한다`,
  );
  pushNarrative(state, `${teamNameIn(state, teamId)} 감독직 접근`, 5);
  return true;
}

/** 공석이 된 구단이 무직 감독을 부른다 (career.md §5.1) */
function offerToUnemployed(
  state: GameState,
  dismissal: Dismissal,
  teamId: string,
  position: number,
  digest: TickSink,
): boolean {
  const offers = state.managerOffers;
  /**
   * 한 번 부른 구단은 다시 부르지 않는다 — 단 **이번 무직 기간** 안에서다.
   * 기록은 세이브 전체에 쌓이므로 전부 세면 경질이 되풀이될수록 부를 수 있는
   * 구단 풀 자체가 준다.
   */
  if (offers.some((o) => o.madeOn >= dismissal.on && o.teamId === teamId)) return false;

  const tier = tierOfTeamIn(state, teamId);
  const gate = OFFER_REPUTATION_GATE[tier];
  const reputation = (state.manager.reputation.board + state.manager.reputation.media) / 2;
  if (gate !== undefined && reputation < gate) return false;

  const dry = offerDrySpell(offers, dismissal, state.date);
  // 구단·날짜마다 채널을 갈라 뽑는다 — AI 경질의 난수열을 흔들지 않는다
  const rng = makeRng(state.seed, `manager-offer:${state.date}:${teamId}`);
  if (!dry && rng() > OFFER_CHANCE) return false;

  const expectation = boardExpectation(state, teamId);
  const terms = MANAGER_TERMS_BY_TIER[tier];
  state.managerOffers = [
    ...offers,
    {
      // 같은 시드·같은 날이면 같은 id — 난수로 지으면 재현이 깨진다
      id: `mgr-offer-${teamId}-${state.date}`,
      teamId,
      madeOn: state.date,
      expiresOn: addDays(state.date, OFFER_DAYS),
      tier,
      position,
      target: expectation.target,
      expectationCode: expectation.code,
      salary: terms.salary,
      years: terms.years,
      budgetPledge: terms.budgetPledge,
      via: "vacancy",
      status: "open",
    },
  ];
  digest.push(
    `${josa(teamShortNameIn(state, teamId), "이/가")} 감독직을 제안했다 — 기대는 ${boardExpectationText(expectation.code, expectation.target)}` +
      ` · 연봉 ${formatMoney(terms.salary)}·${terms.years}년 · ${OFFER_DAYS}일 안에 답해야 한다`,
  );
  pushNarrative(state, `${teamNameIn(state, teamId)} 감독직 제안`, 5);
  return true;
}

/**
 * **경질 위약금** — 잔여 계약에 비례하되 연봉 1년치에서 멈춘다 (career.md §5.4).
 *
 * 만료로 끝난 계약에는 잔여가 없어 0이다 — 끝까지 간 계약에 물 것은 없다.
 *
 * ⚠️ **스태프 해고도 이 식이다** (people.md §2-2 · `releaseStaff`). 인자를 연봉과
 * 만료일까지로 좁혀 둔 이유가 그것이다 — 두 곳이 같은 자를 쓰지 않으면 한쪽만
 * 조정되는 날이 온다 (AGENTS.md §5 — 한 규칙 한 정의).
 */
export function managerSeveranceOf(
  contract: Pick<ManagerContract, "salary" | "until">,
  today: string,
): number {
  const left = Math.max(0, diffDays(today, contract.until));
  return Math.min(
    contract.salary,
    Math.round((contract.salary * left * MANAGER_SEVERANCE_RATE) / DAYS_PER_YEAR),
  );
}

/**
 * **재계약 제안** — 지금 구단이 거는 다음 임기 (career.md §5.4).
 *
 * 조건은 지금 등급의 기본 표이되 현 연봉이 그보다 높으면 현 연봉을 유지한다 —
 * 구단이 스스로 깎아 부르지는 않는다. 흥정도 수락도 이직 제안과 같은 길을 탄다.
 */
export function standRenewalOffer(
  state: GameState,
  contract: ManagerContract,
  digest: TickSink,
): void {
  const teamId = state.userTeamId;
  const tier = tierOfTeamIn(state, teamId);
  const terms = MANAGER_TERMS_BY_TIER[tier];
  const expectation = boardExpectation(state, teamId);
  const salary = Math.max(contract.salary, terms.salary);
  state.managerOffers = [
    ...state.managerOffers,
    {
      id: `mgr-renewal-${teamId}-${state.date}`,
      teamId,
      madeOn: state.date,
      expiresOn: addDays(state.date, OFFER_DAYS),
      tier,
      target: expectation.target,
      expectationCode: expectation.code,
      salary,
      years: terms.years,
      budgetPledge: terms.budgetPledge,
      via: "renewal",
      status: "open",
    },
  ];
  digest.push(
    `보드가 재계약을 제안했다 — 연봉 ${formatMoney(salary)}·${terms.years}년 ·` +
      ` 이적 예산 약속 ${formatMoney(terms.budgetPledge)} · ${OFFER_DAYS}일 안에 답해야 한다`,
  );
  pushNarrative(state, `${teamNameIn(state, teamId)} 재계약 제안`, 5);
}

/** 부르는 말을 견주기 위한 정규화 — 사이의 공백·구두점은 같은 말이다 */

/** 제안이 가리키는 말인가 — 제안 id 또는 그 구단의 id·약칭·이름 */
export function offerMatches(state: GameState, offer: ManagerOffer, ref: string): boolean {
  const key = norm(ref);
  return (
    norm(offer.id) === key ||
    norm(offer.teamId) === key ||
    norm(teamShortNameIn(state, offer.teamId)) === key ||
    norm(teamNameIn(state, offer.teamId)) === key
  );
}

/**
 * **재계약을 받아들인다 — 같은 구단에서 임기가 다시 시작된다** (career.md §5.4).
 *
 * 계약만 다시 서고 그 밖에는 아무것도 움직이지 않는다: 경고도 압력도 사람도 훈련도
 * 지금 구단의 것이라 지울 이유가 없다. 이적 예산 약속은 부임과 같이 그 자리에서
 * 이행된다.
 */
export function acceptRenewal(state: GameState, offer: ManagerOffer): CommandResult {
  if (offer.teamId !== state.userTeamId) {
    return { ok: false, message: `${teamNameIn(state, offer.teamId)}의 제안이 아닙니다` };
  }
  if (offer.status !== "open" || offer.expiresOn < state.date) {
    return {
      ok: false,
      message: `보드의 재계약 제안은 ${offer.expiresOn}에 만료됐습니다`,
    };
  }
  offer.status = "accepted";
  // 새 임기의 계약이라 재계약 판정 자국은 지고 가지 않는다 — 다음 만료 90일 전에 다시 선다
  state.manager.contract = {
    salary: offer.salary,
    signedOn: state.date,
    until: contractUntil(state.date, offer.years),
  };
  if (offer.budgetPledge > 0)
    financeOf(state, state.userTeamId).transferBudget += offer.budgetPledge;

  const salary = offer.salary;
  const pledge = offer.budgetPledge;
  const name = teamNameIn(state, state.userTeamId);
  pushNarrative(state, `${name} 재계약`, 5);
  return {
    ok: true,
    tone: "good",
    message:
      `${josa(name, "과/와")} 재계약했습니다 — 연봉 ${formatMoney(salary)}에 ${state.manager.contract.until}까지` +
      (pledge > 0
        ? `, 이적 예산 ${josa(formatMoney(pledge), "이/가")} 약속대로 더해졌습니다`
        : `입니다`),
    brief: {
      head: "재계약",
      items: [
        item({ label: "구단", text: name }),
        item({
          label: "연봉",
          text: formatMoney(salary),
          note: `${state.manager.contract.until}까지`,
        }),
        ...(pledge > 0
          ? [item({ label: "이적 예산", text: formatMoney(pledge), delta: pledge })]
          : []),
      ],
    },
  };
}

/**
 * **제안에 한 차례 조건을 되부른다** — 연봉·이적 예산 약속 (career.md §5.1).
 *
 * 보드의 답은 천장이 정한다: 제시 조건 × (1 + `counterHeadroom`). 되부른 값이
 * 천장 이하면 그대로, 넘으면 천장에서 멈춘다. 어느 쪽이든 흥정은 이 한 번으로
 * 끝난다(`counteredOn`) — 남는 것은 수락 여부뿐이다.
 *
 * @param ref 제안 id 또는 구단 이름·약칭
 */
export function counterManagerOffer(
  state: GameState,
  ref: string,
  ask: { salary?: number; transferBudget?: number },
): CommandResult {
  const offer =
    state.managerOffers.find((o) => o.id === ref) ??
    state.managerOffers.find(
      (o) => o.status === "open" && o.expiresOn >= state.date && offerMatches(state, o, ref),
    ) ??
    state.managerOffers.find((o) => offerMatches(state, o, ref));
  /**
   * 재직 중에 되부를 수 있는 것은 재직 중에 설 수 있는 제안뿐이다 — 보드의 재계약
   * (career.md §5.4)과 이직 제안(§5.1). 흥정의 길은 셋 다 같다.
   */
  const inPost = offer?.via === "renewal" || offer?.via === "poach" || offer?.via === "knock";
  if (!state.dismissal && !inPost) {
    return { ok: false, message: `${teamNameIn(state, state.userTeamId)} 감독으로 재직 중입니다` };
  }
  if (!offer) return { ok: false, message: `"${ref}"에 해당하는 감독직 제안이 없습니다` };
  if (offer.status !== "open" || offer.expiresOn < state.date) {
    return {
      ok: false,
      message: `${teamNameIn(state, offer.teamId)}의 제안은 ${offer.expiresOn}에 만료됐습니다`,
    };
  }
  if (offer.counteredOn) {
    return {
      ok: false,
      message: `${josa(teamNameIn(state, offer.teamId), "과/와")}의 흥정은 이미 한 차례 끝났습니다 — 남은 것은 수락 여부뿐입니다`,
    };
  }
  if (ask.salary === undefined && ask.transferBudget === undefined) {
    return { ok: false, message: "연봉·이적 예산 중 하나는 불러야 합니다" };
  }

  const tier = offer.tier as 1 | 2 | 3 | 4;
  const reputation = (state.manager.reputation.board + state.manager.reputation.media) / 2;
  const headroom = counterHeadroom(reputation, tier);
  const parts: string[] = [];
  /** 흥정이 실제로 선 값 — 축마다 한 줄이다 (모델이 읽는 줄과 같은 자에서 갈린다) */
  const items: CommandBriefItem[] = [];

  /** 한 축의 흥정 — 제시액 아래로는 내려가지 않고, 천장 위로는 올라가지 않는다 */
  const settle = (label: string, offered: number, asked: number): number => {
    const ceiling = Math.round(offered * (1 + headroom));
    if (asked <= offered) {
      parts.push(`${label} ${formatMoney(offered)} — 제시액 아래로는 내려가지 않는다`);
      items.push(item({ label, text: formatMoney(offered), note: "제시액 그대로" }));
      return offered;
    }
    if (asked <= ceiling) {
      parts.push(`${label} ${formatMoney(asked)} — 요구대로`);
      items.push(item({ label, text: formatMoney(asked), note: "요구대로" }));
      return asked;
    }
    parts.push(`${label} ${formatMoney(ceiling)} — 천장에서 멈췄다 (요구 ${formatMoney(asked)})`);
    items.push(item({ label, text: formatMoney(ceiling), note: "천장에서 멈췄다" }));
    return ceiling;
  };

  // 흥정이 끝난 제안의 조건은 확정 사실로 적힌다
  if (ask.salary !== undefined) offer.salary = settle("연봉", offer.salary, ask.salary);
  if (ask.transferBudget !== undefined) {
    offer.budgetPledge = settle("이적 예산 약속", offer.budgetPledge, ask.transferBudget);
  }
  offer.counteredOn = state.date;

  pushNarrative(state, `${teamNameIn(state, offer.teamId)} 조건 흥정`, 4);
  return {
    ok: true,
    message:
      `${josa(teamNameIn(state, offer.teamId), "이/가")} 답했습니다 — ${parts.join(" · ")}.` +
      ` 흥정은 여기까지입니다 — 남은 것은 수락 여부입니다 (${offer.expiresOn}까지)`,
    brief: {
      head: `${teamNameIn(state, offer.teamId)} 조건 흥정`,
      items: [...items, item({ label: "기한", text: `${offer.expiresOn}까지` })],
    },
  };
}

/** 이적 예산 등급을 가르는 리그 안 삼분위 — 위 1/3 · 가운데 · 아래 1/3 */
const BUDGET_TERTILE = 1 / 3;

/** 주급을 연 수입과 견주는 자 — 비전의 재정 항목과 같은 결이다 (career.md §5) */
const WEEKS_PER_YEAR = 52;

/** 면접 카드가 화면에서 서는 이름 — 다섯 줄이 전부 「보드」이면 무엇을 읽는지가 사라진다 */
export const INTERVIEW_FACT_KO: Partial<Record<PressFact["kind"], string>> = {
  standing: "자리",
  vacancy: "전임",
  "key-player": "선수단",
  "finance-grade": "재정",
};

/** 답을 기다리는 면접 — 무직인 동안 열릴 수 있는 유일한 자리다 */
export function pendingInterview(state: GameState): Approach | null {
  const open = pendingApproach(state);
  return open?.topic === "interview" ? open : null;
}

/** 이번 무직 기간에 이미 마주 앉은 구단인가 — 같은 문을 두 번 두드릴 수는 없다 */
export function interviewedSince(state: GameState, teamId: string, since: string): boolean {
  return state.approaches.some(
    (a) => a.topic === "interview" && a.teamId === teamId && a.date >= since,
  );
}

/**
 * 그 선수단의 중심 — **1군 최고 종합 자원.** 부임 회견이 짚는 것과 같은 카드다
 * (people.md §4). 감독이 그 이름을 부를 수 있어야 면접이 「이 선수단을 어떻게
 * 쓰겠는가」의 자리가 된다.
 *
 * ⚠️ `about`을 걸지 않는다 — 아직 남의 구단 선수라 감독의 답이 그의 사기에 닿지
 * 않는다. 이름은 카드의 `name`이 든다.
 */
function keyPlayerOf(state: GameState, teamId: string): PressFact | null {
  const best = firstTeamPlayers(state, teamId).reduce<GamePlayer | null>(
    (top, p) => (top === null || p.attributes.overall > top.attributes.overall ? p : top),
    null,
  );
  if (!best) return null;
  const contract = activeContract(state, best.id);
  return {
    kind: "key-player",
    data: {
      name: best.name,
      tags: [naturalPositionOf(best).position],
      values: {
        age: ageOf(best.birthdate, state.date),
        ...(contract ? { contractDays: Math.max(0, diffDays(state.date, contract.until)) } : {}),
      },
    },
    about: null,
    sharp: false,
  };
}

/**
 * 재정 두 줄 — **등급이지 숫자가 아니다** (career.md §5.1). 아직 그 구단의 사람이
 * 아니라 장부를 열어 보여 주지 않는다.
 *
 * 급여 비중은 재정 보고서와 **같은 구간표**(`wageRatioTone`)를 읽고, 이적 예산은 그
 * 리그 안에서 선 자리를 삼분위로 가른다 — 절대액은 리그마다 자릿수가 달라 등급이
 * 되지 못한다.
 */
function financeGradeFacts(state: GameState, teamId: string): PressFact[] {
  const facts: PressFact[] = [];
  const revenue = annualRevenueEstimate(state, teamId);
  if (revenue > 0) {
    const ratio = (weeklyWagesOf(state, teamId) * WEEKS_PER_YEAR) / revenue;
    facts.push({
      kind: "finance-grade",
      data: { tags: ["wage-share", wageRatioTone(ratio)] },
      about: null,
      // 급여가 수입을 잡아먹는 구단은 감독이 첫날 알아야 하는 사실이다
      sharp: wageRatioTone(ratio) !== "ok",
    });
  }
  const league = leagueOfTeamIn(state, teamId);
  const budgets = state.finances
    .filter((f) => leagueOfTeamIn(state, f.teamId) === league)
    .map((f) => f.transferBudget)
    .sort((a, b) => a - b);
  const mine = state.finances.find((f) => f.teamId === teamId);
  if (mine && budgets.length >= 3) {
    const rank = budgets.filter((b) => b < mine.transferBudget).length / budgets.length;
    const grade = rank >= 1 - BUDGET_TERTILE ? "rich" : rank < BUDGET_TERTILE ? "tight" : "mid";
    facts.push({
      kind: "finance-grade",
      data: { tags: ["transfer-budget", grade] },
      about: null,
      sharp: false,
    });
  }
  return facts;
}

/**
 * **면접 자리를 연다** — 노크가 문턱을 넘은 그 자리에서 (career.md §5.1).
 *
 * 다가옴에서 **세계가 아니라 감독이 여는 유일한 자리**라 소음의 문 넷을 지나지
 * 않는다: 감독 자신이 두드린 문이고, 무직인 동안에는 압력이 여는 자리도 회견도
 * 서지 않는다. 문은 `applyForManagerJob`이 이미 본 둘뿐이다 — 열린 제안, 열린 면접.
 */
export function openInterview(state: GameState, vacancy: ManagerVacancy): Approach {
  const teamId = vacancy.teamId;
  const expectation = boardExpectation(state, teamId);
  const facts: PressFact[] = [
    {
      kind: "standing",
      data: { values: { rank: expectation.target }, tags: ["board-target", expectation.code] },
      about: null,
      sharp: true,
    },
    {
      kind: "vacancy",
      data: {
        values: {
          days: Math.max(0, diffDays(vacancy.on, state.date)),
          ...(vacancy.position === undefined ? {} : { position: vacancy.position }),
        },
      },
      about: null,
      sharp: true,
    },
  ];
  const key = keyPlayerOf(state, teamId);
  if (key) facts.push(key);
  facts.push(...financeGradeFacts(state, teamId));

  const contextCard: ApproachContext = {
    code: "interview",
    ...(vacancy.position === undefined ? {} : { value: vacancy.position }),
    limit: expectation.target,
  };
  const approach: Approach = {
    id: `approach-interview-${teamId}-${state.date}`,
    date: state.date,
    channel: "owner",
    topic: "interview",
    // 우리 구단주가 아니라 **마주 앉은 쪽**의 사람이다 (people.md §8)
    speakerId: generateOwner(state.seed, teamId).characterId,
    about: null,
    teamId,
    contextCard,
    facts,
    status: "pending",
  };
  pushApproach(state, approach);
  pushNarrative(state, `${teamNameIn(state, teamId)} 감독직 면접`, 5);
  return approach;
}

/**
 * **면접의 답이 조건이 된다** (career.md §5.1) — `respondToApproach`가 자리를 닫은
 * 뒤에 부른다. 표가 문을 닫으면 제안이 서지 않고, 열면 노크의 조건이 선다.
 */
export function settleInterview(
  state: GameState,
  approach: Approach,
  outcome: InterviewOutcome,
): CommandResult {
  const teamId = approach.teamId ?? "";
  const name = teamNameIn(state, teamId);
  if (!outcome.offer) {
    pushNarrative(state, `${name} 감독직 면접 결렬`, 4);
    return {
      ok: true,
      tone: "bad",
      message: `${josa(name, "은/는")} 제안 없이 자리를 닫았습니다 — 보드는 확신을 얻지 못했습니다`,
      brief: { head: "감독직 면접", items: [item({ label: name, text: "제안 없음" })] },
    };
  }

  const tier = tierOfTeamIn(state, teamId);
  const base = MANAGER_TERMS_BY_TIER[tier];
  const expectation = boardExpectation(state, teamId);
  /**
   * 지원한 쪽이라 연봉은 기본의 0.85배다 (`KNOCK_SALARY_RATE`) — 그 위에서만
   * `bold`가 흥정의 천장까지 올린다. 두 손잡이가 곱해지는 것이 아니라 순서대로 선다.
   */
  const reputation = (state.manager.reputation.board + state.manager.reputation.media) / 2;
  const lift = 1 + outcome.leverage * counterHeadroom(reputation, tier);
  const salary = Math.round(base.salary * KNOCK_SALARY_RATE * lift);
  const budgetPledge = Math.round(base.budgetPledge * lift);
  const position = approach.contextCard.value;
  /**
   * **재직 중에 두드린 자리면 보상금이 실린다** (career.md §5.1) — 감독이 먼저
   * 두드렸든 구단이 불렀든 옛 구단이 받는 돈은 같은 식이다(`managerSeveranceOf`).
   */
  const contract = state.manager.contract;
  const compensation = state.dismissal || !contract ? 0 : managerSeveranceOf(contract, state.date);

  state.managerOffers = [
    ...state.managerOffers,
    {
      id: `mgr-offer-${teamId}-${state.date}`,
      teamId,
      madeOn: state.date,
      expiresOn: addDays(state.date, OFFER_DAYS),
      tier,
      ...(position === undefined ? {} : { position }),
      target: expectation.target,
      expectationCode: expectation.code,
      salary,
      years: base.years,
      budgetPledge,
      ...(compensation > 0 ? { compensation } : {}),
      via: "knock",
      // 미리 당겨 쓴 흥정은 되부를 기회를 남기지 않는다
      ...(outcome.leverage > 0 ? { counteredOn: state.date } : {}),
      status: "open",
    },
  ];
  pushNarrative(state, `${name} 감독직 제안 (면접)`, 5);
  return {
    ok: true,
    tone: "good",
    message:
      `${josa(name, "이/가")} 제안으로 답했습니다 — 기대는 ${boardExpectationText(expectation.code, expectation.target)},` +
      ` 연봉 ${formatMoney(salary)}·${base.years}년·이적 예산 약속 ${formatMoney(budgetPledge)}.` +
      (compensation > 0
        ? ` 수락하면 ${teamNameIn(state, state.userTeamId)}에 보상금 ${josa(formatMoney(compensation), "을/를")} 뭅니다.`
        : "") +
      (outcome.leverage > 0
        ? ` 자리에서 조건을 불렀으므로 흥정은 여기까지입니다 — 남은 것은 수락 여부입니다.`
        : ` 흥정은 한 차례 남아 있습니다.`) +
      ` ${OFFER_DAYS}일 안에 답해야 합니다`,
    brief: {
      head: "감독직 면접",
      items: [
        item({
          label: name,
          text: "제안",
          note: boardExpectationText(expectation.code, expectation.target),
        }),
        item({
          label: "연봉",
          text: formatMoney(salary),
          note: outcome.leverage > 0 ? `${base.years}년 · 천장까지` : `${base.years}년`,
        }),
        item({ label: "이적 예산 약속", text: formatMoney(budgetPledge) }),
        ...(compensation > 0
          ? [
              item({
                label: "보상금",
                text: formatMoney(compensation),
                note: josa(teamShortNameIn(state, state.userTeamId), "으로/로"),
              }),
            ]
          : []),
        item({ label: "흥정", text: outcome.leverage > 0 ? "소진" : "한 차례 남음" }),
      ],
    },
  };
}
