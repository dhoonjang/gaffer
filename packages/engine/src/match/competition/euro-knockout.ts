import { cupLegMatchId } from "@story-fm/domain";
import { type MatchStage, type MatchRecord, type TickSink } from "@story-fm/domain";
import { type GameState } from "../../common/core/state";
import { tieLegsOf, stageMatchesOf, reportOurTie } from "./knockout";
import { settledTieWinner, pairOf } from "./extra-time";
import { computeStandings } from "../../common/views/standings";
import {
  type CupCatalogEntry,
  competitionShortName,
  stageLabel,
  cupCatalogById,
  knockoutStages,
} from "../../common/data/cup-catalog";
import { knockoutDates, EURO_NIGHT_KICKOFF, euroMatchdayDates } from "./europe";
import { makeRng, shuffleInPlace } from "../../common/core/rng";
import { addDays } from "../../common/core/dates";
import { scheduleDraw } from "./draw-schedule";

/**
 * 유럽 대항전 녹아웃 — 리그 페이즈가 끝난 뒤부터 결승까지.
 *
 * 대진을 시즌 시작에 미리 짤 수 없다 (누가 올라올지 모른다). 그래서 **단계가
 * 끝나면 다음 단계를 만드는** 진행형이다. `advanceEuroKnockouts`가 매일 tick에서
 * 호출되고, 직전 단계가 완결됐을 때만 다음 단계를 편성한다. 날짜는 시즌 시작에
 * 이미 예약돼 있으므로(`knockoutDates`) 리그 일정과 부딪히지 않는다.
 *
 * 2차전제는 합계 득점으로 가리고, 같으면 승부차기다 (원정 다득점 규칙은 2021년에
 * 폐지됐다). 결승은 중립 경기장 단판.
 */

/** 녹아웃 경기 id — 단계·대진 번호·차수를 id에 박아 브래킷 순서를 잃지 않는다 */
function knockoutId(cupId: string, season: number, stage: MatchStage, pair: number, leg: number) {
  return cupLegMatchId({ cupId, season, stage, pair, leg });
}

/** 이 대회 이 단계의 경기 — 대진 번호, 그다음 차수 순 */
export { stageMatchesOf as euroStageMatches } from "./knockout";

/** 리그 페이즈 완주 여부 — 녹아웃 편성의 전제 */
export function euroLeaguePhaseDone(state: GameState, cupId: string): boolean {
  const phase = state.matches.filter(
    (m) => m.season === state.season && m.competitionId === cupId && m.stage === "league",
  );
  return phase.length > 0 && phase.every((m) => m.result !== null);
}

/** 이 대진의 모든 차전 — 차수 순 */
export function euroTieLegs(
  state: GameState,
  cupId: string,
  stage: MatchStage,
  pair: number,
): MatchRecord[] {
  return tieLegsOf(stageMatchesOf(state, cupId, stage), pair);
}

/**
 * 대진의 승자 — **이미 적힌 결과만 읽는다.** 갈리지 않았으면 null.
 *
 * ⚠️ 여기서 연장·승부차기를 굴리지 않는다. 이 함수는 달력이 예약을 지울 때
 * (`reservedEuroDatesFor`), 화면이 브래킷을 그릴 때마다 열리는 조회 경로다 —
 * 굴리는 것은 `resolveEuroTie` 하나다 (competition.md §6).
 */
export function euroTieWinner(
  state: GameState,
  cupId: string,
  stage: MatchStage,
  pair: number,
): string | null {
  return settledTieWinner(euroTieLegs(state, cupId, stage, pair));
}

/** 리그 페이즈 최종 순위 — 시드의 원본 (녹아웃 경기는 순위표에 들어가지 않는다) */
export function leaguePhaseSeeds(state: GameState, cupId: string): string[] {
  return computeStandings(state, cupId).map((r) => r.teamId);
}

/** 이 팀의 리그 페이즈 순위 (0-based) — 홈/원정 이점 배정에 쓴다 */
export function seedIndex(seeds: string[], teamId: string): number {
  const i = seeds.indexOf(teamId);
  return i < 0 ? seeds.length : i;
}

/** 대진 하나를 2차전제로 만든다 — 상위 시드가 2차전 홈 */
export function createTie(
  state: GameState,
  cup: CupCatalogEntry,
  stage: MatchStage,
  pair: number,
  better: string,
  worse: string,
): MatchRecord[] {
  const dates = knockoutDates(state.season, stage);
  const twoLegged = stage !== "final";
  if (!twoLegged) {
    return [
      {
        id: knockoutId(cup.id, state.season, stage, pair, 1),
        season: state.season,
        competitionId: cup.id,
        stage,
        round: 1,
        date: dates[0]!,
        time: EURO_NIGHT_KICKOFF,
        neutral: true,
        homeTeamId: better,
        awayTeamId: worse,
        result: null,
      },
    ];
  }
  return [0, 1].map((leg) => ({
    id: knockoutId(cup.id, state.season, stage, pair, leg + 1),
    season: state.season,
    competitionId: cup.id,
    stage,
    round: leg + 1,
    date: dates[leg] ?? dates[0]!,
    time: EURO_NIGHT_KICKOFF,
    // 1차전은 하위 시드 홈, 2차전은 상위 시드 홈 (실제 대회의 이점 배분)
    homeTeamId: leg === 0 ? worse : better,
    awayTeamId: leg === 0 ? better : worse,
    result: null,
  }));
}

/** 플레이오프 대진 — 상위 시드(직행 다음 순위)가 하위 시드를 만난다 */
export function playoffPairs(cup: CupCatalogEntry, seeds: string[]): Array<[string, string]> {
  const pool = seeds.slice(cup.directSlots, cup.directSlots + cup.playoffSlots);
  const half = pool.length / 2;
  return Array.from({ length: half }, (_, i) => [pool[i]!, pool[pool.length - 1 - i]!]);
}

/**
 * 본선 첫 단계 대진 — 직행 팀과 플레이오프 승자를 붙인다.
 * 상위 시드가 하위(=플레이오프를 거친) 팀을 만나는 것은 실제 대회와 같고,
 * 어느 승자를 만나는지는 시드 해시로 결정적으로 추첨한다.
 */
export function mainDrawPairs(
  state: GameState,
  cup: CupCatalogEntry,
  seeds: string[],
  winners: string[],
): Array<[string, string]> {
  const direct = seeds.slice(0, cup.directSlots);
  const rng = makeRng(state.seed, `draw:${cup.id}:${state.season}`);
  const pool = [...winners];
  shuffleInPlace(pool, rng);
  return direct.map((teamId, i) => [teamId, pool[i] ?? pool[pool.length - 1]!]);
}

/** 브래킷 순서대로 인접한 두 팀을 붙인다 (승자 위치가 다음 대진을 정한다) */
export function pairUp(teams: string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i + 1 < teams.length; i += 2) pairs.push([teams[i]!, teams[i + 1]!]);
  return pairs;
}

/** 우리 팀이 뛴 단계의 결과 보고 — 다음 단계 편성과 같은 시점에 한 번만 */
export function reportEuroTie(
  state: GameState,
  cup: CupCatalogEntry,
  stage: MatchStage,
  winners: string[],
  digest: TickSink,
): void {
  reportOurTie(
    state,
    {
      matches: stageMatchesOf(state, cup.id, stage),
      short: competitionShortName(cup.id),
      label: stageLabel(stage, 1, false),
      winners,
    },
    digest,
  );
}

/** 대항전 라운드 사이 추첨 — 직전 라운드가 끝나고 며칠 뒤, 늦어도 1차전 전날 */
const EURO_DRAW_LEAD_DAYS = 4;

export function scheduleEuroDraw(
  state: GameState,
  cup: CupCatalogEntry,
  stage: MatchStage,
  participants: string[],
  digest: TickSink,
): boolean {
  const firstLeg = knockoutDates(state.season, stage)[0];
  const latest = firstLeg ? addDays(firstLeg, -1) : addDays(state.date, EURO_DRAW_LEAD_DAYS);
  const soonest = addDays(state.date, EURO_DRAW_LEAD_DAYS);
  const date = soonest < latest ? soonest : latest;
  const forUser = participants.includes(state.userTeamId);
  const created = scheduleDraw(state, cup.id, stage, date, forUser);
  if (created && forUser) {
    const short = competitionShortName(cup.id);
    digest.push(`${short} ${stageLabel(stage, 1, false)} 대진 추첨 — ${date}`);
  }
  return created;
}

/**
 * 리그 페이즈에서 이미 떨어졌는가 — 최종 순위가 통과선(`directSlots + playoffSlots`) 밖.
 *
 * ⚠️ **플레이오프 결장으로는 판정할 수 없다.** 직행 팀도 그 단계에 없기 때문이다.
 * 통과선 밖 팀(UEL 13~16위·UECL 7~10위)이 살아 있는 것으로 남으면, 다음 단계가
 * 뽑혀 "거기 없다"가 드러날 때까지 4~5월 자리를 붙들고 있게 된다.
 *
 * 순위가 확정되는 것은 리그 페이즈를 완주한 순간이다 — 그 전 순위는 잠정이다.
 */
function outOfLeaguePhase(state: GameState, cup: CupCatalogEntry, teamId: string): boolean {
  if (!euroLeaguePhaseDone(state, cup.id)) return false;
  // 순위표에 없는 팀(-1)은 판정하지 않는다 — 예약을 잘못 지우는 쪽이 대가가 크다
  const rank = leaguePhaseSeeds(state, cup.id).indexOf(teamId);
  return rank >= 0 && rank >= cup.directSlots + cup.playoffSlots;
}

/**
 * 이 팀에게 **아직 유효한** 대항전 예약일 — 컵 편성·리그 연기가 비워 둬야 할 자리.
 *
 * 예약의 근거는 하나다: **그 경기는 나중에 편성되므로 지금 장부에 없다**
 * (`reservedEuroDates`). 녹아웃에서는 그 근거가 두 자리에서 사라진다.
 *
 * ① **이미 뽑힌 단계** — 그 경기는 장부에 있고 48시간 규칙이 직접 잰다.
 * ② **이미 떨어진 팀** — 그 경기는 영영 생기지 않는다. 리그 페이즈 통과선 밖도
 *    여기다(`outOfLeaguePhase`) — 다음 단계가 뽑히기를 기다릴 이유가 없다.
 *
 * ⚠️ **걸러내지 않으면 4~5월 주중이 통째로 잠긴다.** 준결승 예약일(4/28·5/5)이 그
 * 대회에 나갔던 **모든** 팀을 막아, 국내 컵은 주중으로 못 가고 리그 연기도 자리를
 * 못 찾는다. 남는 선택지가 연이틀 경기(`HARD_MIN_REST_HOURS` 아래)거나 라운드를
 * 한 달 뒤로 가르는 것뿐이 된다 — 실제로 FA컵 준결승이 그렇게 갈라졌다.
 *
 * ⚠️ **리그 페이즈는 그대로 막는다.** 여덟 날이 시즌 시작에 고정이고 참가 팀이
 * **전원** 뛴다 — 떨어질 일도, 나중에 뽑힐 일도 없어서 위 두 근거가 닿지 않는다.
 * 여기를 함께 풀었더니 쿠프 드 프랑스 라운드가 UCL 리그 페이즈 **다음 날**로
 * 앉았다(23시간). 국내 컵 라운드가 대항전 주간을 피하는 것은 실제 대회의 골격이다.
 */
export function reservedEuroDatesFor(state: GameState, teamId: string): string[] {
  const entry = state.euroEntrants.find((e) => e.teams.includes(teamId));
  if (!entry) return [];
  const cup = cupCatalogById(entry.cupId);
  if (!cup) return [];

  const dates: string[] = [...euroMatchdayDates(state.season)];
  if (outOfLeaguePhase(state, cup, teamId)) return dates;

  let alive = true;
  for (const stage of knockoutStages(cup)) {
    const drawn = stageMatchesOf(state, entry.cupId, stage);
    if (drawn.length === 0) {
      // 아직 안 뽑혔다 — 살아 있는 동안은 그 자리를 비워 둬야 한다
      if (alive) dates.push(...knockoutDates(state.season, stage));
      continue;
    }
    const ours = drawn.find((m) => m.homeTeamId === teamId || m.awayTeamId === teamId);
    if (!ours) {
      // ⚠️ **플레이오프 결장은 탈락이 아니다** — 직행 팀은 이 단계를 건너뛴다.
      // 본선 단계는 다르다: 거기 없으면 올라오지 못한 것이다.
      if (stage !== "playoff") alive = false;
      continue;
    }
    const winner = euroTieWinner(state, entry.cupId, stage, pairOf(ours));
    if (winner !== null && winner !== teamId) alive = false;
  }
  return dates;
}

/** 이 대회의 우승 팀 — 결승이 끝났을 때만 (시즌 리뷰·트로피의 원본) */
export function euroChampion(state: GameState, cupId: string): string | null {
  const cup = cupCatalogById(cupId);
  if (!cup) return null;
  return euroTieWinner(state, cupId, "final", 0);
}
