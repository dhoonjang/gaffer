import {
  playerOverall,
  observedOverall,
  type Contract,
  type GamePlayer,
  type MatchRecord,
  type MatchStage,
  type SeasonStat,
  type SeasonStatTotal,
  yellowBanMatches,
  ageOf,
  competitionRowsOf,
  footLabel,
  physiqueLabel,
  naturalPositionOf,
  seasonRating,
  sumSeasonStats,
} from "@gaffer/domain";
import { pickTeam } from "../../core/team-ref";
import { formatMoney } from "../../team/finance";
import { diffDays } from "../../core/dates";
import { disciplineOf, suspensionScopeName } from "../../core/catalog/discipline-catalog";
import { formLabel } from "../../players/form";
import { isHomegrownFor, occupiesSquadList } from "../../team/registration";
import { competitionShortName } from "../../core/catalog/cup-catalog";
import { norm } from "../../team/player-pool";
import { overallView } from "../../players/observation-view";
import {
  knowledgeOf,
  observationOf,
  growthOutlook,
  readCondition,
} from "../../players/observation";
import {
  activeContract,
  activeSuspension,
  seasonYellowsOf,
  assignmentFor,
  familiarityOf,
  isOurPlayer,
  openInjury,
  seasonStatOf,
  seasonStatsByCompetitionOf,
  squadLevelOf,
  teamShortNameIn,
  type GameState,
} from "../../core/state";
import { SearchPlayersInput } from "./search-players";

// ── 이름 해석 (팀·대회) ─────────────────────────────────
//
// 감독은 카탈로그 표기를 모른다 — "맨유", "레알", "챔스"로 말한다. 해석을 도구
// 입구에 두면 모델이 id를 외우거나 추측하지 않아도 되고, 못 찾았을 때 후보를
// 돌려줄 수 있다 (조용히 빈 결과를 주면 모델이 지어내기 시작한다).

/** 우리 팀을 가리키는 말 */
const MINE = new Set(["mine", "우리", "우리팀", "our", "us"]);
/** 팀을 좁히지 말라는 말 — 대회 전체 일정 */
export const EVERY_TEAM = new Set(["all", "전체", "리그", "리그전체", "모두", "everyone"]);

type Resolved = { ok: true; teamId: string } | { ok: false; message: string };

/**
 * 조회의 팀 자리 — **이름 해석 자체는 `pickTeam`의 것이다** (core/team-ref.ts).
 * 여기 남는 것은 조회에만 있는 말뿐이다: 빈 값과 「우리」는 우리 팀이다.
 */
export function resolveTeam(state: GameState, team?: string): Resolved {
  const said = (team ?? "").trim();
  if (said === "" || MINE.has(norm(said))) return { ok: true, teamId: state.userTeamId };
  return pickTeam(state, said);
}

/** 이름 뒤에 실제 주장·부주장 지정을 표시한다. */
export function armband(p: GamePlayer): string {
  return p.isCaptain ? " (주장)" : p.isViceCaptain === true ? " (부주장)" : "";
}

/** 징계를 재는 기준 경기 — 어느 대회의 몇 라운드·어느 단계에서 묻는가 */
export type DisciplineFixture = { competitionId: string; round: number; stage: MatchStage };

/**
 * **경고 눈금을 재는 다음 경기** — 친선·2군은 규정이 없어 건너뛴다 (match.md §6).
 *
 * 남은 대회 경기가 없으면(프리시즌 앞·시즌 끝) 그 팀의 리그를 1라운드로 가정한다 —
 * 감독이 읽는 눈금은 결국 리그의 것이고, 화면이 아무 말도 하지 않는 것보다 낫다.
 * 리그조차 없으면(무소속) 널이다: 그에게는 다음 대회 경기가 없다.
 */
export function disciplineFixtureOf(state: GameState, teamId: string): DisciplineFixture | null {
  let next: MatchRecord | null = null;
  for (const m of state.matches) {
    if (m.result || m.date < state.date) continue;
    if (m.homeTeamId !== teamId && m.awayTeamId !== teamId) continue;
    if (disciplineOf(m.competitionId) === null) continue;
    if (next === null || m.date < next.date || (m.date === next.date && m.id < next.id)) next = m;
  }
  if (next !== null && next.competitionId !== null) {
    return { competitionId: next.competitionId, round: next.round, stage: next.stage };
  }
  /**
   * 폴백은 **던지지 않는다** — 무소속(`freeagents`)도 카탈로그가 모르는 id도 이 함수를
   * 지난다. 뷰가 매 턴 부르는 자리라 예외 하나가 오피스 화면 전체를 떨군다.
   */
  const league = state.leagueOf?.[teamId] ?? state.teams.find((t) => t.id === teamId)?.leagueId;
  return league === undefined ? null : { competitionId: league, round: 1, stage: "league" };
}

/**
 * 정지가 얼마나 가까운지 말해 주는 창(장) — 이보다 멀면 아무 말도 하지 않는다.
 * 5는 유럽 대부분의 눈금 폭이라, 그 대회의 카드가 0장이어도 거리를 낸다.
 */
const BAN_WARNING_RANGE = 5;

/**
 * 정지까지 **몇 장 남았나** — 그 팀의 **다음 경기 대회**로 잰다 (match.md §6).
 *
 * 대회마다 눈금이 다르므로("EPL 5장 / FA컵 2장 / UCL 3장") 대회 없이 낸 수는
 * 감독을 잘못된 다음 경기로 데려간다. 눈금이 멀면 아무 말도 하지 않는다.
 */
export function banWarningFor(state: GameState, p: GamePlayer): string {
  const at = disciplineFixtureOf(state, p.teamId);
  const rule = at === null ? null : disciplineOf(at.competitionId);
  if (at === null || rule === null) return "";
  const held = seasonYellowsOf(state, p.id, state.season, at.competitionId);
  for (let more = 1; more <= BAN_WARNING_RANGE; more++) {
    if (yellowBanMatches(rule, held + more, at) === null) continue;
    const name = competitionShortName(at.competitionId);
    return ` — ${name} 경고 ${held}장, ${more}장 더 받으면 출장 정지`;
  }
  return "";
}

/**
 * 우리 팀 선수 한 줄 — 정확 수치 (오피스 뷰가 이미 보여주는 정보).
 *
 */
export function ourRow(state: GameState, p: GamePlayer): string {
  const assignment = assignmentFor(state, p.id);
  const contract = activeContract(state, p.id);
  const stat = seasonStatOf(state, p.id);
  const injury = openInjury(state, p.id);
  const suspension = activeSuspension(state, p.id);
  const role =
    squadLevelOf(p) === "reserve"
      ? state.developmentFocus.includes(p.id)
        ? "[2군·집중 육성]"
        : "[2군]"
      : assignment
        ? `[${assignment.role === "starting" ? "선발" : "벤치"}:${assignment.position}]`
        : "[1군]";
  const adaptation = `적응${familiarityOf(state, p.id)} `;
  const status = injury
    ? ` 부상(${injury.bodyPart}, ~${injury.expectedReturn})`
    : suspension
      ? ` 정지(${suspensionScopeName(suspension)} ${suspension.lengthMatches - suspension.served}경기)`
      : "";
  // 무엇에 대한 불만인지까지 낸다 — 사유가 여덟이라 "불만" 한 마디로는 할 일이 안 보인다
  /**
   * **등번호는 이 줄에 선다** — 화면의 명단 행은 이미 번호를 세우는데 GM 조회 줄에만
   * 없어서, 모델이 번호를 물으면 있지도 않은 번호를 지어냈다 (player.md §1.1).
   */
  const number = p.squadNumber === undefined ? "" : `${p.squadNumber}번 `;
  return (
    `${p.id} ${number}${p.name} ${ageOf(p.birthdate, state.date)}세 ${naturalPositionOf(p).position} ` +
    `${physiqueLabel(p.height, p.weight)}(${footLabel(p.foot)}) ` +
    `OVR${playerOverall(p)} 폼 ${formLabel(p.state.form)} ` +
    `체력${p.state.condition} ${adaptation}` +
    `${formatMoney(contract?.weeklyWage ?? 0)}${contractLabel(contract)} ` +
    `${role} ${statLine(stat)}${status}${armband(p)}` +
    // 홈그로운은 **우리 협회** 기준이다 — 임대 나간 선수를 빌린 구단 기준으로 재면
    // 같은 선수의 자격이 나가 있는 동안만 뒤집힌다 (searchPlayers의 필터와 같은 자)
    `${isHomegrownFor(p, state.userTeamId) ? " [홈그로운]" : ""}${occupiesSquadList(state, p) ? "" : " [U21·명단 밖]"}`
  );
}

/**
 * 이번 시즌 **대회별** 한 줄 — `리그 12경기 3골 · FA컵 2경기 1골`.
 *
 * 위의 「시즌 기록」이 대회 합이라 "리그에서 몇 골"을 말할 자리가 없었다
 * (→ docs/season/season.md §6). 많이 뛴 대회부터 서고, 대회가 하나뿐이면
 * 합계 줄이 이미 같은 수를 말했으므로 세우지 않는다 (game-state.md §3.4).
 */
export function competitionStatLine(state: GameState, playerId: string): string | null {
  const rows = seasonStatsByCompetitionOf(state, playerId);
  if (rows.length < 2) return null;
  return competitionStatText(rows);
}

/** 대회별 줄 한 토막 — `리그 12경기 3골 1도움`. 0도움은 적지 않는다 (match.md §6) */
export function competitionStatText(rows: readonly SeasonStat[]): string {
  return rows
    .map(
      (r) =>
        `${competitionShortName(r.competitionId)} ${r.apps}경기 ${r.goals}골` +
        ((r.assists ?? 0) > 0 ? ` ${r.assists}도움` : ""),
    )
    .join(" · ");
}

/**
 * 지난 시즌 **대회별** 한 줄 — `리그 30경기 10골 · UCL 8경기 2골`.
 *
 * 이번 시즌 줄과 달리 **대회가 하나여도 선다**: 카드에 지난 시즌 합계 줄이 따로 없어
 * 그 수를 말하는 자리가 여기뿐이다. 행이 없으면(첫 시즌) 서지 않는다.
 *
 * ⚠️ **그 시즌 그때의 팀으로 읽는다.** `seasonStatsByCompetitionOf`는 지금 소속의 행만
 * 주므로 여름에 옮겨 온 선수의 지난 시즌이 통째로 빈다. 팀이 둘 이상이면 약칭을 앞에
 * 세운다 — 어느 셔츠의 30경기인지가 빠지면 사실이 아니다.
 */
export function pastCompetitionStatLine(state: GameState, playerId: string): string | null {
  const season = state.season - 1;
  const rows = competitionRowsOf(
    state.seasonStats.filter((s) => s.gamePlayerId === playerId && s.season === season),
  );
  if (rows.length === 0) return null;
  const groups = groupByTeam(rows);
  return groups
    .map(
      ([teamId, teamRows]) =>
        (groups.length > 1 ? `${teamShortNameIn(state, teamId)} ` : "") +
        competitionStatText(teamRows),
    )
    .join(" / ");
}

/** 대회 행을 팀으로 묶는다 — 많이 뛴 팀부터, 같으면 팀 id 사전순 (행 안의 순서는 그대로) */
function groupByTeam(rows: readonly SeasonStat[]): [string, SeasonStat[]][] {
  const byTeam = new Map<string, SeasonStat[]>();
  for (const row of rows) {
    const found = byTeam.get(row.teamId);
    if (found) found.push(row);
    else byTeam.set(row.teamId, [row]);
  }
  const appsOf = (group: readonly SeasonStat[]): number => group.reduce((n, r) => n + r.apps, 0);
  return [...byTeam].sort((a, b) => appsOf(b[1]) - appsOf(a[1]) || (a[0] < b[0] ? -1 : 1));
}

/** 시즌 기록 축약 — 출전/득점/도움, 평점은 출전이 있을 때만. 2군 리그 기록은 따로 */
export function statLine(
  stat: {
    apps: number;
    goals: number;
    assists?: number;
    ratingSum?: number;
    reserveApps?: number;
    reserveGoals?: number;
  } | null,
): string {
  const rating = seasonRating(stat);
  const reserve =
    (stat?.reserveApps ?? 0) > 0
      ? ` · 2군 출전${stat?.reserveApps}/득점${stat?.reserveGoals ?? 0}`
      : "";
  return (
    `출전${stat?.apps ?? 0}/득점${stat?.goals ?? 0}/도움${stat?.assists ?? 0}` +
    (rating === null ? "" : `/평점${rating.toFixed(2)}`) +
    reserve
  );
}

/**
 * 계약 만료 꼬리 — ` ~YYYY-MM-DD`, 계약이 없으면 빈 문자열. **안개를 걸지 않는다**:
 * 계약 만료일은 부상·징계와 같은 공개 기록 계열이다 (player.md §10).
 */
export function contractLabel(contract: Contract | null): string {
  // 주급 바로 뒤에 서므로 사이를 띄운다 — 붙이면 `£150k~2028-06-30`이 금액 구간으로 읽힌다
  return contract ? ` ~${contract.until}` : "";
}

/**
 * 타 팀 선수 한 줄 — 능력치는 안개, **계약은 공개 정보**다. 계약 만료일은 계약
 * 원장을 읽는다.
 *
 * 등번호는 싣지 않는다 — 셔츠에 적힌 공개 사실이지만 이 줄이 답하는 물음은 값·계약·
 * 기량이고, 남의 구단 번호로 감독이 할 일은 없다. 우리 번호를 GM이 지어내던 것이
 * 이 이슈이지 남의 번호를 알려 주는 것이 아니다.
 */
export function theirRow(state: GameState, p: GamePlayer): string {
  const stat = seasonStatOf(state, p.id);
  const knowledge = knowledgeOf(state, p.id);
  const source = knowledge === "seen" ? "직접 관전" : "평판";
  const injury = openInjury(state, p.id);
  const contract = activeContract(state, p.id);
  return (
    `${p.id} ${p.name} ${ageOf(p.birthdate, state.date)}세 ${naturalPositionOf(p).position} ` +
    `${teamShortNameIn(state, p.teamId)} · ${overallView(state, p)} (${source}) · ` +
    `계약 ${contract ? contract.until : "없음(무소속)"} · ` +
    `${statLine(stat)}${injury ? ` · 부상 중(~${injury.expectedReturn})` : ""}`
  );
}

/** 우리 행인가 남의 행인가 */
export function playerRow(state: GameState, p: GamePlayer): string {
  return isOurPlayer(state, p) ? ourRow(state, p) : theirRow(state, p);
}

/**
 * **줄 세우는 값도 노출이다** (player.md §10) — 행이 라벨만 보여도 참값으로 세운
 * 순서는 그 값을 그대로 말한다. 정렬 키는 그 행이 찍는 관측값과 같아야 한다.
 */
export function sortRating(state: GameState, p: GamePlayer): number {
  return observedOverall(playerOverall(p), observationOf(state, p.id));
}

/**
 * 체력은 지식 5단계가 아니라 §9.2의 채널 — 경기 밖 **우리 선수**는 참값이고 타 팀은
 * 읽은 값이다(`ourRow`가 찍는 값과 같은 자다).
 */
function sortCondition(state: GameState, p: GamePlayer): number {
  return isOurPlayer(state, p)
    ? p.state.condition
    : readCondition(state, p.id, p.state.condition).value;
}

/**
 * 활성 계약 색인 — **원장을 한 번만 훑는다.** `activeContract`는 선수 하나에 원장
 * 전체를 훑으므로 5,700명에 그대로 부르면 그 선형 탐색이 5,700번 돈다. `find`가
 * 첫 줄을 고르므로 색인도 **먼저 만난 줄을 남긴다** — 같은 선수에 줄이 둘이어도
 * 고르는 값이 달라지지 않는다.
 */
export function contractIndexOf(state: GameState): Map<string, Contract> {
  const index = new Map<string, Contract>();
  for (const c of state.contracts) {
    if (c.status !== "active") continue;
    if (!index.has(c.gamePlayerId)) index.set(c.gamePlayerId, c);
  }
  return index;
}

/**
 * 계약 잔여 일수 — **계약이 없으면 0일이다.** 무소속 선수는 "이미 끝난 계약"이라
 * 잔여가 가장 짧은 쪽이고, 거르는 자와 세우는 자가 같은 규칙을 읽는다.
 */
export function daysLeftOn(state: GameState, contract: Contract | undefined): number {
  return contract ? Math.max(0, diffDays(state.date, contract.until)) : 0;
}

/**
 * 풀 하나의 정렬 키 — **선수당 한 번만** 뽑는다.
 *
 * 원장에서 읽는 키(득점·출전·주급·계약)는 원장을 한 번 훑어 색인으로 세우고,
 * 안개에서 파생하는 키(평점·체력·값·성장 가능성)는 지식 수준을 다시 세지 않도록
 * 풀당 한 번 뽑아 둔다.
 */
export function sortKeyOf(
  state: GameState,
  pool: readonly GamePlayer[],
  sortBy: NonNullable<SearchPlayersInput["sortBy"]>,
  /** 대회로 좁혔으면 **그 대회의 기록**으로 줄을 세운다 (season.md §6) */
  competitionId: string | null,
): (p: GamePlayer) => number {
  if (sortBy === "age") return () => 0;
  if (sortBy === "rating" || sortBy === "fatigue" || sortBy === "growth") {
    // 안개 키는 지식 수준 파생이라 비싸다 — 풀당 한 번만 뽑고 비교는 그 값으로 한다
    const fogged = new Map(pool.map((p) => [p.id, foggedKeyOf(state, p, sortBy)] as const));
    return (p) => fogged.get(p.id) ?? 0;
  }
  if (sortBy === "wage" || sortBy === "contract") {
    const contracts = contractIndexOf(state);
    return sortBy === "wage"
      ? (p) => contracts.get(p.id)?.weeklyWage ?? 0
      : (p) => daysLeftOn(state, contracts.get(p.id));
  }
  /**
   * 스탯은 시즌·팀까지 같아야 그 선수의 줄이다 — 시즌 중 소속이 바뀌면 팀별로 갈린다.
   *
   * **대회로 좁힌 물음은 그 대회의 행으로 답한다** ("우리 리그 최다 득점"). 안 좁혔으면
   * 대회 행을 모두 접은 시즌 합계다 — 화면의 "출전 N"과 같은 수여야 한다
   * (`sumSeasonStats` — game-state.md §3.4).
   */
  const rows = new Map<string, SeasonStat[]>();
  for (const s of state.seasonStats) {
    if (s.season !== state.season) continue;
    if (competitionId !== null && s.competitionId !== competitionId) continue;
    const k = `${s.gamePlayerId}\u0000${s.teamId}`;
    const found = rows.get(k);
    if (found) found.push(s);
    else rows.set(k, [s]);
  }
  const stat = new Map<string, SeasonStatTotal>();
  for (const [k, group] of rows) {
    const folded = sumSeasonStats(group);
    if (folded) stat.set(k, folded);
  }
  const of = (p: GamePlayer) => stat.get(`${p.id}\u0000${p.teamId}`);
  switch (sortBy) {
    case "goals":
      return (p) => of(p)?.goals ?? 0;
    case "assists":
      return (p) => of(p)?.assists ?? 0;
    // 출전이 없으면 평점이 없다 — 0으로 두어 뛴 선수 뒤에 선다
    case "seasonRating":
      return (p) => seasonRating(of(p)) ?? 0;
    default:
      return (p) => of(p)?.apps ?? 0;
  }
}

/** 안개에서 파생하는 정렬 키 — 셋 다 그 행이 찍는 값과 같은 관측값이다 */
function foggedKeyOf(
  state: GameState,
  p: GamePlayer,
  sortBy: "rating" | "fatigue" | "growth",
): number {
  switch (sortBy) {
    case "rating":
      return sortRating(state, p);
    case "fatigue":
      return sortCondition(state, p);
    // 판단 보류는 맨 뒤에 선다
    default:
      return growthOutlook(state, p)?.tier ?? -1;
  }
}

/**
 * 읽기 전용 조회 (lookup) — GM이 온디맨드로 부르는 조회 도구의 엔진 구현.
 *
 * 왜 컨텍스트 대신 도구인가: 매 턴 스쿼드 표를 프롬프트에 밀어넣으면 (a) 캐시
 * 밖 토큰을 매번 다시 읽고 (b) 그래도 타 팀·순위·일정은 못 담는다. 조회를
 * 도구로 열면 필요할 때만 읽고, 안개(observation.ts)를 같은 자리에서 적용할 수 있다.
 *
 * 규약: 상태를 절대 바꾸지 않는다. 타 팀 정보는 반드시 observation.ts를 거친다 —
 * 여기서 참값 숫자를 흘리면 안개가 무의미해진다.
 */

export interface LookupResult {
  ok: boolean;
  message: string;
}

/** 결과 행 수 상한 — 컨텍스트 폭주 방지 */
export const DEFAULT_LIMIT = 8;
export const MAX_LIMIT = 15;
