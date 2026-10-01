import {
  type GameState,
  ensureSeasonStat,
  isInjured,
  tacticsOf,
  assignmentsOf,
} from "../../../../common/core/state";
import {
  type MatchRecord,
  addToSeasonStat,
  FULL_TIME_MINUTES,
  positionGroupOfPlayer,
  naturalPositionOf,
  clampCondition,
} from "@story-fm/domain";
import { needsExtraTime, finishingXi, appendGoals } from "../../../../match/competition/extra-time";
import { derbyForMatch } from "../../../../common/world/derby";
import { simulateExtraTime, EXTRA_TIME_MINUTES } from "../../../../match/flow/quick-sim";
import { simSquadFor } from "../../../../match/squad/simulation";
import { recordCard } from "../../../../match/flow/discipline";
import { makeRng } from "../../../../common/core/rng";
import { openInjuryFor } from "../health/injury";
import { conditionAfterLoad, expectedLoadOf } from "@story-fm/sim";

/**
 * 연장 30분을 치른다 — 이미 치른 경기면 아무 일도 하지 않는다(`aet`).
 *
 * 대진 승자를 묻는 자리에서 호출되므로 **멱등**이어야 한다: 화면이 브래킷을
 * 그릴 때마다 연장이 다시 굴러가면 스코어가 계속 자란다. 감독이 실시간 경기로
 * 직접 치른 연장에도 `aet`가 붙어 있으므로 여기서 두 번 굴러가지 않는다.
 *
 * @returns 이번 호출에서 연장을 치렀으면 true
 */
export function resolveExtraTime(state: GameState, decider: MatchRecord, channel: string): boolean {
  const result = decider.result;
  if (!result || result.aet) return false;
  // 연장이 필요한 경기인지도 같은 문에서 묻는다 — 호출부마다 따로 판단하지 않는다
  if (!needsExtraTime(state, decider)) return false;
  /**
   * 연장 몫이 얹히는 **대회 행** (game-state.md §3.4). 연장은 녹아웃뿐이라 실제로
   * 널이 오지 않지만, 널을 앞에서 끊어야 장부가 축 없는 행에 섞이지 않는다.
   */
  const competitionId = decider.competitionId;
  if (competitionId === null) return false;

  const xi = {
    home: finishingXi(state, decider, "home"),
    away: finishingXi(state, decider, "away"),
  };
  /**
   * **전력 모델은 90분과 같은 원본에서 선다** — 전술판의 자리·좌표·역할, 팀 전술,
   * 개인 적응도, 감독의 전술 눈금까지 `simSquadFor`가 한 벌로 세운다. 팀 id와
   * 선수 목록만 넘기면 입력이 자연 포지션·기본 전술·적응도 60·감독 65로 서서
   * 연장에서만 약팀이 살아나거나 죽는다 (match.md §7).
   */
  const extraDerby = derbyForMatch(decider);
  const extra = simulateExtraTime(
    simSquadFor(state, decider.homeTeamId, xi.home),
    simSquadFor(state, decider.awayTeamId, xi.away),
    state.seed,
    channel,
    {
      neutral: decider.neutral === true,
      // 연장도 같은 경기다 — 더비의 강도가 90분에서만 걸리면 장부가 두 말을 한다
      ...(extraDerby ? { derby: { name: extraDerby.name, heat: extraDerby.heat } } : {}),
      /**
       * 90분의 경고가 연장으로 이어진다 — 이 목록이 없으면 90분에 경고를 받은
       * 선수의 연장 경고가 첫 장으로 세어져 두 번째 경고 퇴장이 성립하지 않는다.
       */
      bookedIn90: state.bookings
        .filter((b) => b.matchId === decider.id && b.card === "yellow")
        .map((b) => b.gamePlayerId),
    },
  );

  /** 90분의 스코어 — 아래 클린시트 판정이 마감이 세던 그 수를 다시 본다 */
  const goals90 = { home: result.homeGoals, away: result.awayGoals };
  result.aet = true;
  result.homeGoals += extra.homeGoals;
  result.awayGoals += extra.awayGoals;
  result.homeShots += extra.homeShots;
  result.awayShots += extra.awayShots;
  result.homeXg += extra.homeXg;
  result.awayXg += extra.awayXg;
  result.homeExpectedGoals += extra.homeExpectedGoals;
  result.awayExpectedGoals += extra.awayExpectedGoals;
  appendGoals(result, extra);

  /**
   * 연장이 시즌 기록에 얹는 몫 — **출전은 90분에 이미 섰다**(`apps: 0`). 분·슛·xG·
   * 선방·골·도움만 더하고, 얹는 문은 90분과 **같은 하나**다 (match.md §6).
   * 카드는 아래 `recordCard`가 지나며 함께 센다.
   */
  for (const side of ["home", "away"] as const) {
    const teamId = side === "home" ? decider.homeTeamId : decider.awayTeamId;
    const idOf = (tag: string) => (tag.startsWith(`${side}:`) ? tag.slice(side.length + 1) : null);
    const countIn = (tags: readonly string[], playerId: string) =>
      tags.filter((tag) => idOf(tag) === playerId).length;
    for (const player of xi[side]) {
      const line = extra.playerStats[player.id];
      // 연장의 퇴장은 그 분에서 시간을 끊는다 — 90분의 규칙 그대로다
      const red = extra.cards.find((c) => c.playerId === player.id && c.card === "red");
      addToSeasonStat(ensureSeasonStat(state, player.id, teamId, competitionId, player), {
        goals: countIn(extra.scorers, player.id),
        assists: countIn(extra.assists, player.id),
        minutes: red ? Math.max(0, red.minute - FULL_TIME_MINUTES) : EXTRA_TIME_MINUTES,
        shots: line?.shots ?? 0,
        xg: line?.xg ?? 0,
        saves: line?.saves ?? 0,
      });
    }
  }

  /**
   * 연장의 실점은 90분에 적힌 클린시트를 **무른다** — 마감이 90분 스코어로 세고
   * 연장은 그 뒤에 붙기 때문이다 (match.md §6). 실시간 경기는 120분을 한 장부로
   * 마감하므로 애초에 이 자리가 없다.
   *
   * 무르는 대상은 **선발로 나와 90분을 지킨 골키퍼**뿐이다 — 그 사람만 문턱
   * (`CLEAN_SHEET_MINUTES`)을 넘은 것이 확실하다. 중간에 바뀐 골키퍼는 90분에
   * 받았는지 알 수 없어, 깎으면 다른 경기의 기록을 깎는다.
   */
  for (const side of ["home", "away"] as const) {
    const concededIn90 = side === "home" ? goals90.away : goals90.home;
    const concededInEt = side === "home" ? extra.awayGoals : extra.homeGoals;
    if (concededIn90 > 0 || concededInEt === 0) continue;
    const started = new Set(side === "home" ? result.homeStarters : result.awayStarters);
    const keeper = xi[side].find((p) => positionGroupOfPlayer(p) === "GK" && started.has(p.id));
    if (!keeper) continue;
    const teamId = side === "home" ? decider.homeTeamId : decider.awayTeamId;
    const stat = ensureSeasonStat(state, keeper.id, teamId, competitionId, keeper);
    if (stat.cleanSheets) stat.cleanSheets -= 1;
  }

  /**
   * 연장의 카드 → BOOKING·SUSPENSION — **90분과 같은 문**(`discipline.ts`).
   * 같은 경기 id로 적히므로 90분의 경고와 이어져, 두 번째 경고 퇴장이 정지
   * 한 건으로 남는다. 연장은 녹아웃뿐이라 친선 예외가 없다.
   */
  const sentOffInEt = new Map<string, number>();
  for (const card of extra.cards) {
    recordCard(state, {
      playerId: card.playerId,
      match: decider,
      card: card.card,
      minute: card.minute,
    });
    if (card.card === "red") sentOffInEt.set(card.playerId, card.minute);
  }
  /**
   * 연장 퇴장자는 승부차기를 차지 못한다 — 종료 시점 온필드(`homeOnPitch`)가
   * 승부차기 명단의 원본이므로(§8.6) 여기서 빼야 퇴장당한 발이 페널티를 차지 않는다.
   */
  if (sentOffInEt.size > 0) {
    result.homeOnPitch = result.homeOnPitch.filter((id) => !sentOffInEt.has(id));
    result.awayOnPitch = result.awayOnPitch.filter((id) => !sentOffInEt.has(id));
  }

  // 연장의 부상 — 심각도·기간은 90분과 같은 공식(`openInjuryFor`)으로 굴린다
  const injuryRng = makeRng(state.seed, `et-injury:${decider.id}`);
  for (const tag of extra.injuries) {
    const [side, playerId] = tag.split(":") as ["home" | "away", string];
    const player = xi[side].find((p) => p.id === playerId);
    if (!player || isInjured(state, player.id)) continue;
    openInjuryFor(state, player, "match", injuryRng);
  }

  // 30분치 부하 — 자리·전술·지구력은 90분과 같은 함수가 정한다 (match.md §6). 퇴장자는 그 분까지만
  for (const side of ["home", "away"] as const) {
    const teamId = side === "home" ? decider.homeTeamId : decider.awayTeamId;
    const spec = tacticsOf(state, teamId).spec;
    const slotOf = new Map(assignmentsOf(state, teamId).map((a) => [a.playerId, a.position]));
    const possession = result.possession[side];
    for (const player of xi[side]) {
      const position = slotOf.get(player.id) ?? naturalPositionOf(player).position;
      const off = sentOffInEt.get(player.id);
      const minutes = off === undefined ? EXTRA_TIME_MINUTES : Math.max(0, off - 90);
      player.state.condition = clampCondition(
        conditionAfterLoad(
          player.state.condition,
          expectedLoadOf(position, spec, minutes, possession),
          player.attributes.stamina,
        ),
      );
    }
  }

  return true;
}
