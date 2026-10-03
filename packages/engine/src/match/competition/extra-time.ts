import { playerOverall, pairOfMatchId } from "@story-fm/domain";
import { type MatchRecord, type GamePlayer, type ShotOrigin } from "@story-fm/domain";
import { type GameState, playerById, firstTeamPlayers } from "../../common/core/state";

/**
 * 연장 30분 — 녹아웃에서 승부가 갈리지 않았을 때 **승부차기보다 먼저** 치른다.
 *
 * 유럽 대항전과 국내 컵이 같은 문을 쓴다 (승부차기와 같은 자리). 단판은 90분이
 * 같을 때, 2차전제는 **합계가 같을 때만** — 1차전 무승부는 연장이 아니다.
 * 그 판정은 이 파일의 `needsExtraTime` 하나가 갖는다: 대회마다 따로 판단하면
 * 어느 하나만 고쳐도 두 대회의 규칙이 조용히 갈린다.
 *
 * **감독의 경기는 여기를 지나지 않는다.** 실시간 경기가 120분까지 가므로
 * (`sim/live`의 `extra_first`·`extra_second`) 연장의 교체·카드·부상이 다 장부에 남고,
 * 그 경기는 `MatchResult.aet` 표식이 붙어 이 함수를 통과한다 — 그게 **이중 적용의
 * 문지기**다. 나머지 2,000여 경기는 여기서 한 번에 굴러간다: 우리 컵 8강도 남의 8강도
 * 같은 규칙을 지난다.
 */

/** 한 팀이 그라운드에 세우는 인원 — 종료 시점 온필드가 없는 결과에서 명단을 자를 때 */
const EXTRA_TIME_XI = 11;

/**
 * 대진 번호 — 녹아웃 경기 id에 박혀 있다 (`...-p{대진}-l{차수}`).
 *
 * 국내 컵과 대항전이 같은 규칙으로 id를 만들므로 여기 한 벌만 둔다.
 */
export function pairOf(match: MatchRecord): number {
  return Number(pairOfMatchId(match.id));
}

/** 이 경기가 속한 대진의 모든 차전 — 차수 순. 녹아웃이 아니면 자기 자신뿐이다 */
function tieLegs(state: GameState, match: MatchRecord): MatchRecord[] {
  const pair = pairOf(match);
  return state.matches
    .filter(
      (m) =>
        m.season === match.season &&
        m.competitionId === match.competitionId &&
        m.stage === match.stage &&
        pairOf(m) === pair,
    )
    .sort((a, b) => a.round - b.round);
}

/**
 * **이 경기가 연장까지 갈 수 있는 자리인가** — 스코어를 보기 전의 절반.
 *
 * 리그·친선·대항전 리그 페이즈는 무승부로 끝나고, 2차전제의 1차전도 마찬가지다 —
 * 승부는 마지막 다리가 가린다. 남은 절반(합계가 같은가)은 `needsExtraTime`이 얹는다.
 *
 * 경기 전에 묻는 자리가 있어서 갈라 둔다: 감독의 교체 계획은 킥오프 전에 서고, 그때는
 * 아직 스코어가 없으므로 "연장에 들면 한 장 더"를 말할 수 있는 조건이 이것뿐이다
 * (GM 스냅샷 `<now>`의 교체 한도 줄 — llm/agents.md §6).
 */
export function canReachExtraTime(state: GameState, match: MatchRecord): boolean {
  if (match.stage === "league") return false;
  const legs = tieLegs(state, match);
  return legs.length === 0 || legs[legs.length - 1]!.id === match.id;
}

/**
 * **이 경기 뒤에 연장이 붙는가** — 연장 판정의 단일 지점.
 *
 * 리그·친선·대항전 리그 페이즈는 무승부로 그냥 끝난다(`stage`가 없거나 `league`).
 * 녹아웃은 **마지막 다리**(단판 또는 2차전)에서, 그리고 **합계가 같을 때만** 간다 —
 * 1차전 무승부는 연장이 아니다.
 *
 * 진행 중인 경기(장부 스코어)와 이미 끝난 경기(`result`)를 같은 잣대로 재려고
 * 스코어를 인자로 받는다. 없으면 저장된 결과를 읽는다.
 */
export function needsExtraTime(
  state: GameState,
  match: MatchRecord,
  score?: { home: number; away: number },
): boolean {
  if (!canReachExtraTime(state, match)) return false;
  const legs = tieLegs(state, match);

  const now =
    score ?? (match.result ? { home: match.result.homeGoals, away: match.result.awayGoals } : null);
  if (!now) return false;

  // 앞 차전에서 넘어온 합계 — 이 경기의 홈·원정 기준으로 뒤집어 더한다
  const carry = tieAggregate(
    legs.filter((m) => m.id !== match.id),
    match,
  );
  return carry.home + now.home === carry.away + now.away;
}

/**
 * **실시간 경기가 드는 연장 규칙** — 90분 뒤 (스코어 + 이 값)이 같으면 연장이다.
 * 단판은 `{0,0}`, 2차전은 앞 차전의 합계(이 경기의 홈·원정 기준), 리그·친선은 `null`.
 * 판정은 `needsExtraTime`과 같은 자리에서 나온다 — 시뮬은 대회를 모르고 이 답만 든다.
 */
export function extraTimeRuleOf(
  state: GameState,
  match: MatchRecord,
): { home: number; away: number } | null {
  if (!canReachExtraTime(state, match)) return null;
  const legs = tieLegs(state, match);
  return tieAggregate(
    legs.filter((m) => m.id !== match.id),
    match,
  );
}

/**
 * **이 경기 뒤에 승부차기가 붙는가** — 연장의 문 다음에 서는 문.
 *
 * 연장을 치르고도 합계가 같으면 승부차기다. 그래서 판정은 `needsExtraTime`과 같은
 * 잣대에 **연장을 이미 치렀는가**를 더한 것이다. 진행 중인 경기는 그 시계가 아직
 * 장부에 없으므로(`result`가 비어 있다) 넘겨받은 스코어를 믿는다 — 감독의 경기는
 * 120분이 끝난 자리에서 이 함수를 스코어와 함께 묻는다.
 */
export function needsShootout(
  state: GameState,
  match: MatchRecord,
  score?: { home: number; away: number },
): boolean {
  if (!score && match.result?.aet !== true) return false;
  return needsExtraTime(state, match, score);
}

/**
 * **이미 적힌 결과로 갈리는 승자** — 갈리지 않으면 null. 아무것도 굴리지 않는다.
 *
 * 국내 컵과 대항전이 같은 한 벌을 쓴다. 합계가 먼저고, 같으면 승부차기 합계다 —
 * 연장·승부차기를 굴리는 것은 `resolveDomesticTie` · `resolveEuroTie`이고 승자를
 * **묻는** 자리는 여기를 지난다 (competition.md §6).
 */
export function settledTieWinner(legs: readonly MatchRecord[]): string | null {
  if (legs.length === 0 || legs.some((m) => !m.result)) return null;
  const decider = legs[legs.length - 1]!;
  const agg = tieAggregate(legs, decider);
  if (agg.home !== agg.away) {
    return agg.home > agg.away ? decider.homeTeamId : decider.awayTeamId;
  }
  const pens = decider.result!.penalties;
  if (!pens || pens.home === pens.away) return null;
  return pens.home > pens.away ? decider.homeTeamId : decider.awayTeamId;
}

/** 대진 합계 — 마지막 경기(단판·2차전)의 홈·원정 기준 */
export function tieAggregate(
  legs: readonly MatchRecord[],
  decider: MatchRecord,
): { home: number; away: number } {
  const goals = new Map<string, number>();
  for (const leg of legs) {
    const r = leg.result;
    if (!r) continue;
    goals.set(leg.homeTeamId, (goals.get(leg.homeTeamId) ?? 0) + r.homeGoals);
    goals.set(leg.awayTeamId, (goals.get(leg.awayTeamId) ?? 0) + r.awayGoals);
  }
  return {
    home: goals.get(decider.homeTeamId) ?? 0,
    away: goals.get(decider.awayTeamId) ?? 0,
  };
}

/**
 * **경기를 끝낸 사람들** — 연장을 뛰고 페널티를 차는 열한 명(퇴장이 있었으면 그보다 적다).
 *
 * 명단(`homeLineup`)은 **뛴 사람 전부**라 앞 열한 명을 자르면 교체로 나간 선수와
 * 퇴장당한 선수가 연장을 뛴다. 그래서 두 시뮬 다 종료 시점 온필드를 따로 남기고
 * (`homeOnPitch`) 여기가 그것을 읽는다. 결과도 장부도 없으면(아직 치르지 않은 경기)
 * 1군 상위로 물러선다 (match.md §7).
 */
export function finishingXi(
  state: GameState,
  match: MatchRecord,
  side: "home" | "away",
): GamePlayer[] {
  const result = match.result;
  const teamId = side === "home" ? match.homeTeamId : match.awayTeamId;
  /**
   * **진행 중인 장부가 결과보다 앞선다.**
   *
   * 감독의 경기는 마감(`finalizeMatch`)이 승부차기 **뒤**에 온다 — 승부차기를 굴리는
   * 동안 `match.result`는 아직 `null`이라 결과만 읽으면 1군 상위 열한 명까지 밀려나
   * 벤치에 앉아 있던 에이스와 **퇴장당한 선수가 페널티를 찬다.** 살아 있는 장부의
   * 온필드가 곧 경기를 끝낸 열한 명이고, 마감이 `homeOnPitch`로 적는 것도 이 목록이다.
   */
  const live =
    state.pendingMatch?.matchId === match.id ? state.pendingMatch.live.ledger[side].onPitch : null;
  const onPitch = live ?? (side === "home" ? result?.homeOnPitch : result?.awayOnPitch) ?? [];
  /** 같은 id가 두 번 실린 장부가 있다 — 한 사람이 연달아 차지 않도록 접는다 */
  const unique = [...new Set(onPitch)];
  const listed = unique
    .map((id) => playerById(state, id))
    .filter((p): p is GamePlayer => p !== null && p.teamId === teamId);
  if (listed.length > 0) return listed;
  return [...firstTeamPlayers(state, teamId)]
    .sort((a, b) => playerOverall(b) - playerOverall(a))
    .slice(0, EXTRA_TIME_XI);
}

/** 골 목록에 연장 골을 이어 붙인다 — 세 배열의 길이는 언제나 같다 */
export function appendGoals(
  result: NonNullable<MatchRecord["result"]>,
  added: {
    scorers: string[];
    assists: string[];
    goalMinutes: number[];
    goalOrigins: ShotOrigin[];
  },
): void {
  result.scorers = [...result.scorers, ...added.scorers];
  result.assists = [...result.assists, ...added.assists];
  result.goalMinutes = [...result.goalMinutes, ...added.goalMinutes];
  result.goalOrigins = [...result.goalOrigins, ...added.goalOrigins];
}
