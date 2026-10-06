import {
  type GameState,
  type PendingMatch,
  userPlayers,
  isSuspendedFor,
  playerById,
  ensureSeasonStat,
  firstTeamPlayers,
  isInjured,
} from "../../core/state";
import {
  type MatchRecord,
  isReserveMatch,
  parseScorerEntry,
  type MatchSide,
  shootoutSettled,
  shootoutTally,
  type MatchEvent,
  matchMinutesOf,
  positionGroupOfPlayer,
  addToSeasonStat,
  keptCleanSheet,
  clampFatigue,
  fatigueOf,
  clampCondition,
  compareMilestones,
} from "@gaffer/domain";
import {
  type LiveMatch,
  applyEvents,
  possessionOf,
  matchFatigueOf,
  fatigueFromMinutes,
} from "@gaffer/sim";
import { simSquadOf } from "../../match/simulation";
import { serveSuspensions, simulateOtherMatches } from "../tick";
import {
  buildLiveMatch,
  type FlowResult,
  assembleUserLineup,
  snapshotTactics,
  type MatchDigest,
  currentMatch,
  buildRatingBrief,
  type MilestoneNote,
  userSide,
  wentToExtraTime,
  gainMatchProficiency,
  seatOf,
  makeInjuryRng,
  milestoneNote,
  restoreTactics,
} from "../../match/match-flow";
import { matchesOn, isFriendly } from "../../core/calendar";
import { quickSimulate, quickSimKeyOf, quickSimOptionsOf } from "../../match/quick-sim";
import { derbyForMatch } from "../../core/derby";
import { type KickoffSide, journal } from "../../core/journal";
import { matchCaptainOf } from "../../players/hierarchy";
import { item, briefNames } from "../../core/command-result";
import { matchRating } from "../../match/ratings";
import { careerTotalsOf, settleMilestones } from "../../players/career";
import { clampForm, formDeltaFromMatch } from "../../players/form";
import { recordCard } from "../../match/discipline";
import { openInjuryFor } from "../../players/injury";
import { applyMatchFinance } from "../../team/finance";
import { advanceEuroKnockouts } from "../../season/euro-knockout";
import { advanceDomesticCups } from "../../season/domestic-cup";
import { advanceSuperCups } from "../../season/super-cup";

/** 두 AI 팀의 경기 — 명단은 간이 시뮬이 짜는 그대로다 (match.md §3.1) */
export function buildAiLiveMatch(state: GameState, match: MatchRecord): LiveMatch {
  const sideOf = (teamId: string) => {
    const squad = simSquadOf(state, teamId, match.competitionId);
    return {
      onPitch: squad.starters.map((p) => p.id),
      bench: (squad.bench ?? []).map((p) => p.id),
    };
  };
  return buildLiveMatch(
    state,
    match,
    { home: sideOf(match.homeTeamId), away: sideOf(match.awayTeamId) },
    null,
  );
}

/**
 * 우리와 **같은 대회, 같은 날, 같은 시각에 킥오프하는 경기**의 골 시각 — 라이브
 * 스코어의 원본 (match.md §8.6). 채널과 경기의 사실은 `quickSimKeyOf`·`quickSimOptionsOf`가
 * 조립하므로 여기서 본 스코어가 그대로 결과가 된다.
 */
function rollConcurrentMatches(state: GameState, ours: MatchRecord): PendingMatch["otherScores"] {
  if (ours.competitionId === null) return [];
  const kickoff = ours.time;
  const rows: PendingMatch["otherScores"] = [];
  for (const match of matchesOn(state.matches, state.date)) {
    if (match.result || match.id === ours.id) continue;
    if (match.competitionId !== ours.competitionId) continue;
    // 2군 리그는 조용히 돈다 — 옆 구장의 스코어가 아니다
    if (isReserveMatch(match)) continue;
    if (match.time !== kickoff) continue;
    const result = quickSimulate(
      simSquadOf(state, match.homeTeamId, match.competitionId),
      simSquadOf(state, match.awayTeamId, match.competitionId),
      state.seed,
      quickSimKeyOf(state.season, match),
      quickSimOptionsOf(match),
    );
    const minutes = result.goalMinutes;
    const goals = result.scorers
      .map((entry, i) => ({
        minute: minutes[i] ?? 0,
        side: parseScorerEntry(entry).side ?? "home",
      }))
      .sort((a, b) => a.minute - b.minute);
    rows.push({ matchId: match.id, goals });
  }
  return rows;
}

// ── 킥오프 ──────────────────────────────────────────────────────────────────

export function startMatch(state: GameState): FlowResult {
  if (state.phase === "match") return { ok: false, message: "이미 경기가 진행 중입니다" };
  if (state.phase !== "matchday") {
    return { ok: false, message: "오늘은 경기일이 아닙니다 — 먼저 경기일로 이동하세요" };
  }
  const match = matchesOn(state.matches, state.date).find(
    (m) =>
      !m.result &&
      !isReserveMatch(m) &&
      (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
  );
  if (!match) return { ok: false, message: "오늘 예정된 경기를 찾지 못했습니다" };

  const lineup = assembleUserLineup(state, match.competitionId);
  if (lineup.error) return { ok: false, message: lineup.error };

  // 이번 경기에 정지를 소화하는 선수 — **이 대회에 걸리는 정지만**
  const serving = userPlayers(state)
    .filter((p) => isSuspendedFor(state, p.id, match.competitionId))
    .map((p) => p.id);

  const userIsHome = match.homeTeamId === state.userTeamId;
  const opponentId = userIsHome ? match.awayTeamId : match.homeTeamId;
  /** **상대의 명단은 간이 시뮬이 짠 그대로다** (match.md §3.1) */
  const aiSquad = simSquadOf(state, opponentId, match.competitionId);
  const userLedger = { onPitch: lineup.onPitch, bench: lineup.bench };
  const aiLedger = {
    onPitch: aiSquad.starters.map((p) => p.id),
    bench: (aiSquad.bench ?? []).map((p) => p.id),
  };
  const sides = {
    home: userIsHome ? userLedger : aiLedger,
    away: userIsHome ? aiLedger : userLedger,
  };
  const teamIdOf = { home: match.homeTeamId, away: match.awayTeamId } as const;
  const derby = derbyForMatch(match);
  const live = buildLiveMatch(state, match, sides, state.userTeamId);
  const { setup } = live;
  // 첫 휘슬 — 장부의 첫 줄이다. 시계는 감독이 들어선 뒤 클라이언트가 민다
  const whistle = applyEvents(live.ledger, [
    { minute: 0, type: "kickoff", actors: [], causes: [] },
  ]);
  if (whistle.ok) live.ledger = whistle.state;

  state.pendingMatch = {
    matchId: match.id,
    live,
    startingXI: { home: [...sides.home.onPitch], away: [...sides.away.onPitch] },
    entered: false,
    eventsSeen: 0,
    casterHistory: [],
    servingSuspension: serving,
    tacticsBefore: snapshotTactics(state),
    otherScores: rollConcurrentMatches(state, match),
  };
  state.phase = "match";
  {
    const sideOf = (side: MatchSide): KickoffSide => ({
      teamId: teamIdOf[side],
      onPitch: [...sides[side].onPitch],
      bench: [...sides[side].bench],
      tactics: setup.sides[side].kickoffTactics,
      managerTactics: setup.sides[side].managerTactics,
    });
    journal({
      kind: "match.kickoff",
      matchId: match.id,
      competitionId: match.competitionId,
      stage: match.stage,
      round: match.round,
      neutral: match.neutral === true,
      derby: derby ? { name: derby.name, heat: derby.heat } : null,
      userSide: userIsHome ? "home" : "away",
      home: sideOf("home"),
      away: sideOf("away"),
      replaced: [...lineup.replaced],
      serving: [...serving],
      extraTime: setup.extraTime,
      seed: setup.seed,
    });
  }
  const note = lineup.replaced.length > 0 ? ` (자동 대체: ${lineup.replaced.join(", ")})` : "";
  /**
   * 경기 명단의 주장·부주장을 우선하고, 둘 다 없으면 명단 전체에서
   * 리더십·생일·id 순으로 완장을 배정한다. 지정 주장과 다를 때만 결과에 알린다.
   */
  const squadIds = new Set([...lineup.onPitch, ...lineup.bench]);
  const wornBy = matchCaptainOf(state, state.userTeamId, squadIds);
  const captain = userPlayers(state).find((p) => p.isCaptain);
  const inherited =
    wornBy !== null && wornBy !== captain?.id ? (playerById(state, wornBy)?.name ?? null) : null;
  return {
    ok: true,
    message: `킥오프 준비 완료${note}`,
    brief: {
      head: "킥오프 준비",
      items: [
        ...(lineup.replaced.length > 0
          ? [item({ label: "자동 대체", text: briefNames(lineup.replaced) })]
          : []),
        ...(inherited ? [item({ label: "완장", text: inherited, note: "주장 결장" })] : []),
      ],
    },
  };
}

/** 경기 후 반영 — 사건은 창발, 반영은 공식 (match.md §7) */
export function finalizeMatch(state: GameState): MatchDigest {
  const pending = state.pendingMatch;
  if (!pending) return { ours: [], finance: [], others: [] };
  const match = currentMatch(state);
  const { live } = pending;
  const { ledger } = live;
  /** 평점 브리프 — **상태를 바꾸기 전에** 만든다 */
  const brief = buildRatingBrief(state);
  const digest: string[] = [];
  const milestoneNotes: MilestoneNote[] = [];
  const financeLines: string[] = [];
  const otherLines: string[] = [];
  const side = userSide(state);
  const userGoals = side === "home" ? ledger.score.home : ledger.score.away;
  const oppGoals = side === "home" ? ledger.score.away : ledger.score.home;
  const outcome = userGoals > oppGoals ? "win" : userGoals === oppGoals ? "draw" : "loss";

  /** 그라운드를 밟은 선수 — 교체 투입·퇴장까지 포함한다 */
  const participantsOf = (which: MatchSide): string[] => {
    const teamId = which === "home" ? match.homeTeamId : match.awayTeamId;
    const set = new Set(ledger[which].onPitch);
    for (const e of ledger.events) {
      if (e.type === "substitution" && e.team === which) for (const a of e.actors) set.add(a);
    }
    for (const id of ledger.sentOff) if (playerById(state, id)?.teamId === teamId) set.add(id);
    return [...set];
  };
  const homeLineup = participantsOf("home");
  const awayLineup = participantsOf("away");
  /** **킥오프에 벤치에 앉은 선수** (people.md §7) — 나간 사람을 돌려놓는다 */
  const benchOf = (which: MatchSide): string[] => {
    const started = new Set(pending.startingXI[which]);
    const played = which === "home" ? homeLineup : awayLineup;
    const cameOn = played.filter((id) => !started.has(id));
    return [...ledger[which].bench, ...cameOn];
  };
  const statSum = (ids: readonly string[], read: (line: (typeof ledger.stats)[string]) => number) =>
    ids.reduce((sum, id) => {
      const line = ledger.stats[id];
      return sum + (line ? read(line) : 0);
    }, 0);

  /** 점유 — 공을 가졌던 시간의 몫. 실시간 경기가 잰 값 그대로다 */
  const possession = possessionOf(live);
  const goalEvents = ledger.events.filter((e) => e.type === "goal");
  match.result = {
    homeGoals: ledger.score.home,
    awayGoals: ledger.score.away,
    scorers: goalEvents.map((e) => `${e.team}:${e.actors[0] ?? "?"}`),
    assists: goalEvents.map((e) => (e.actors[1] ? `${e.team}:${e.actors[1]}` : "")),
    goalMinutes: goalEvents.map((e) => e.minute),
    goalOrigins: goalEvents.map((e) => e.shotOrigin ?? "open"),
    homeShots: statSum(homeLineup, (line) => line.shots),
    awayShots: statSum(awayLineup, (line) => line.shots),
    homeXg: statSum(homeLineup, (line) => line.xg),
    awayXg: statSum(awayLineup, (line) => line.xg),
    homeExpectedGoals: statSum(homeLineup, (line) => line.scoringExpectation),
    awayExpectedGoals: statSum(awayLineup, (line) => line.scoringExpectation),
    homeLineup,
    awayLineup,
    homeStarters: [...pending.startingXI.home],
    awayStarters: [...pending.startingXI.away],
    homeBench: benchOf("home"),
    awayBench: benchOf("away"),
    /** **사건과 선수별 기록은 장부에서 결과로 건너온다** (match.md §4) — 자르지 않는다 */
    events: [...ledger.events],
    playerStats: { ...ledger.stats },
    possession,
    homeOnPitch: [...ledger.home.onPitch],
    awayOnPitch: [...ledger.away.onPitch],
    ...(wentToExtraTime(ledger) ? { aet: true } : {}),
    ...(pending.shootout && shootoutSettled(pending.shootout.kicks)
      ? {
          penalties: {
            ...shootoutTally(pending.shootout.kicks),
            kicks: [...pending.shootout.kicks],
          },
        }
      : {}),
  };
  const entry = state.schedule.find((e) => e.type === "match" && e.refId === match.id);
  if (entry) entry.status = "done";

  const anchorOfPlayer = new Map((brief?.players ?? []).map((p) => [p.playerId, p.anchor]));

  /** **친선은 장부에 남지 않는다** — 몸에 남는 것만 정산한다 (season.md §2) */
  const friendly = isFriendly(match);
  const competitionId = match.competitionId;
  /** **경기가 실제로 가져간 만큼 깎는다** — 말이 뛴 부하가 낸 값 그대로 (match.md §6) */
  const drained = matchFatigueOf(live);
  const lineupOf = { home: homeLineup, away: awayLineup } as const;
  const teamIdOf = { home: match.homeTeamId, away: match.awayTeamId } as const;

  /** **한 팀의 마감** — 양 팀이 이 함수를 지난다. 간이 시뮬이 자기 경기에 적는 것과 같은 함수를 쓴다 */
  const settleSide = (which: MatchSide): void => {
    const teamId = teamIdOf[which];
    const ours = which === side;
    const events = ledger.events.filter((e) => e.team === which);
    const goals = events.filter((e) => e.type === "goal");
    const scored = which === "home" ? ledger.score.home : ledger.score.away;
    const conceded = which === "home" ? ledger.score.away : ledger.score.home;
    const result = scored > conceded ? "win" : scored === conceded ? "draw" : "loss";
    const cardsOf = (id: string, type: MatchEvent["type"]) =>
      events.filter((e) => e.type === type && e.actors[0] === id).length;
    const minutesOf = matchMinutesOf(events, wentToExtraTime(ledger));

    for (const id of lineupOf[which]) {
      const player = playerById(state, id);
      if (!player) continue;
      const scoredBy = goals.filter((e) => e.actors[0] === id).length;
      const assists = goals.filter((e) => e.actors[1] === id).length;
      const line = ledger.stats[id];
      const minutes = minutesOf(id);
      const rating =
        anchorOfPlayer.get(id) ??
        matchRating({
          group: positionGroupOfPlayer(player),
          goals: scoredBy,
          assists,
          yellows: cardsOf(id, "yellow_card"),
          reds: cardsOf(id, "red_card"),
          conceded,
          outcome: result,
        });
      if (competitionId !== null) {
        const before =
          player.teamId === state.userTeamId ? careerTotalsOf(state, id, player.teamId) : null;
        addToSeasonStat(ensureSeasonStat(state, id, player.teamId, competitionId, player), {
          apps: 1,
          goals: scoredBy,
          assists,
          ratingSum: rating,
          minutes,
          shots: line?.shots ?? 0,
          xg: line?.xg ?? 0,
          saves: line?.saves ?? 0,
          cleanSheets: keptCleanSheet({ group: positionGroupOfPlayer(player), conceded, minutes })
            ? 1
            : 0,
        });
        if (before) {
          const rows = settleMilestones(state, {
            playerId: id,
            teamId: player.teamId,
            matchId: match.id,
            before,
            after: { apps: before.apps + 1, goals: before.goals + scoredBy },
            goalsInMatch: scoredBy,
          });
          for (const row of rows)
            milestoneNotes.push({ name: player.name, code: row.code, value: row.value });
        }
      }
      /** **시즌의 잔고는 킥오프 체력으로 잰다** — 체력을 깎기 전이어야 한다 (player.md §5.5) */
      player.state.fatigue = clampFatigue(
        fatigueOf(player.state) + fatigueFromMinutes(minutes, player.state.condition),
      );
      player.state.condition = clampCondition(player.state.condition - (drained[id] ?? 0));
      player.state.form = clampForm(player.state.form + formDeltaFromMatch(player, rating, result));
      gainMatchProficiency(state, player, seatOf(state, player), entry?.id ?? null);
    }

    /** 정지 소화 — **새 카드보다 먼저** 처리한다 */
    if (!friendly) {
      serveSuspensions(
        state,
        ours
          ? pending.servingSuspension
          : firstTeamPlayers(state, teamId)
              .filter((p) => isSuspendedFor(state, p.id, match.competitionId))
              .map((p) => p.id),
        match.competitionId,
      );
    }

    /** 카드 → BOOKING, 누적/퇴장 → SUSPENSION. **정지 한 건에 브리핑 한 줄** */
    const notes = new Map<string, string>();
    for (const e of friendly ? [] : events) {
      if (e.type !== "yellow_card" && e.type !== "red_card") continue;
      const target = e.actors[0];
      if (!target || !playerById(state, target)) continue;
      const ruling = recordCard(state, {
        playerId: target,
        match,
        card: e.type === "yellow_card" ? "yellow" : "red",
        minute: e.minute,
      });
      if (ruling.revoked) notes.delete(ruling.revoked);
      if (ruling.issued && ruling.note) notes.set(ruling.issued, ruling.note);
    }
    if (ours) digest.push(...notes.values());
  };
  settleSide("home");
  settleSide("away");

  // 경기 평점 — 기준선은 여기서 결정적으로 박고, 경기 후 LLM이 이 위에서 다듬는다.
  // 경기별 평점은 **우리 팀만** 남는다 — 상대의 평점은 시즌 합계에만 들어간다
  const ratings: Record<string, number> = {};
  for (const p of brief?.players ?? []) ratings[p.playerId] = p.anchor;
  match.result = { ...match.result, ratings };

  /** 경기 중 부상 확정 → INJURY row — **양 팀 모두.** 채널은 경기 하나에 하나다 */
  const rng = makeInjuryRng(state.seed, match.id);
  for (const e of ledger.events) {
    if (e.type !== "injury" || !e.actors[0]) continue;
    const player = playerById(state, e.actors[0]);
    if (!player || isInjured(state, player.id)) continue;
    const { days, part } = openInjuryFor(state, player, "match", rng);
    digest.push(
      e.team === side
        ? `부상: ${player.name} — ${part}, 약 ${days}일 결장 예상`
        : `상대 ${player.name} ${part} 부상`,
    );
  }
  // 재정 — 매치데이(관중)·생중계 수당·승리 수당·원정 비용 (finance.ts)
  applyMatchFinance(state, match, outcome, financeLines);

  const pens = match.result.penalties;
  const scoreline =
    `${ledger.score.home}:${ledger.score.away}` +
    (wentToExtraTime(ledger) ? " (연장)" : "") +
    (pens ? ` (승부차기 ${pens.home}:${pens.away})` : "");
  const outcomeKo = outcome === "win" ? "승리" : outcome === "draw" ? "무승부" : "패배";
  digest.push(`최종 스코어 ${scoreline} — ${outcomeKo}`);
  /** 이 경기가 세운 기록 — **말풍선도 서사 메모도 한 줄이다** */
  if (milestoneNotes.length > 0) {
    const line = `기록: ${[...milestoneNotes].sort(compareMilestones).map(milestoneNote).join(" · ")}`;
    digest.push(line);
  }
  // 경기 중 조정을 킥오프 상태로 — pendingMatch가 지워지기 전에 (스냅샷이 거기 있다)
  const restored = restoreTactics(state);
  if (restored) digest.push(restored);

  state.phase = "idle";
  state.pendingMatch = null;
  /** **우리보다 늦게 시작하는 경기는 지금 굴린다** — tick은 우리 킥오프 전까지만 소화했다 */
  simulateOtherMatches(state, otherLines);
  advanceEuroKnockouts(state, otherLines);
  advanceDomesticCups(state, otherLines);
  advanceSuperCups(state, otherLines);
  /** 회견은 **대회 경기마다** 열린다 (press.ts) — 친선은 자리 자체가 없다 */

  {
    const result = match.result;
    journal({
      kind: "match.finalized",
      matchId: match.id,
      competitionId: match.competitionId,
      score: { home: ledger.score.home, away: ledger.score.away },
      outcome,
      shots: { home: result.homeShots, away: result.awayShots },
      xg: { home: result.homeXg, away: result.awayXg },
      expectedGoals: { home: result.homeExpectedGoals, away: result.awayExpectedGoals },
      possession,
      aet: result.aet === true,
      penalties: result.penalties
        ? { home: result.penalties.home, away: result.penalties.away }
        : null,
      ratings: { ...(result.ratings ?? {}) },
      fatigue: { ...drained },
      digest: { ours: [...digest], finance: [...financeLines], others: [...otherLines] },
    });
  }
  return { ours: digest, finance: financeLines, others: otherLines };
}
