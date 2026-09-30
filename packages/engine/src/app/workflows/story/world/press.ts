import { type GameState, teamNameIn, playerById, playersOf } from "../../../../common/core/state";
import {
  type PressConference,
  type PressFact,
  type PressTrigger,
  type TickSink,
  ageOf,
} from "@story-fm/domain";
import { isFriendly } from "../../../../common/core/match-kinds";
import {
  outcomeOf,
  WINLESS_WINDOW,
  WINLESS_STREAK,
  rivalQuoteFact,
  questionablePlayer,
  issueReasonOf,
  SLUMPING_FORM,
  farewellResultFacts,
  managerMilestoneFact,
  isSeasonFinale,
  reporterFor,
  weightOf,
  boardFacts,
  AWARD_FACTS_SHOWN,
  buildAppointmentPress,
  summerNumberInheritance,
  farewellFacts,
  buildDerbyPress,
  isSeasonOpener,
  buildFarewellPress,
  retiringPlayers,
  RETIREMENT_PRESS_DAYS,
  FAREWELL_NAMES_SHOWN,
  declinePendingPress,
  loadLeaks,
  loadIncidents,
  loadCallUps,
  loadManagerContract,
  KEPT_CONFERENCES,
} from "../../../../story/world/press";
import { recentOutcomes } from "../../../../story/players/slump";
import { derbyOf, derbyNameOf } from "../../../../common/data/derbies";
import { derbyRecordOf } from "../../../../common/world/derby";
import { formLabel } from "../../../../common/players/form";
import { matchMilestones, careerTotalsOf } from "../../../../story/players/career";
import { computeStandings } from "../../../../common/views/standings";
import {
  lastSeasonAwardsOf,
  awardFact,
  retirementJudgeDate,
} from "../../../../common/players/career";
import { predictionOf, predictedPlaceOf } from "../../../../common/views/prediction";
import { leagueOfTeamIn } from "../../../../common/core/league-membership";
import { addDays, diffDays } from "../../../../common/core/dates";

/**
 * 경기 뒤 회견 — **매 경기 붙는다.**
 * 실제 리그의 의무 회견이 그렇고, 무엇보다 이겼을 때만 열리면 회견이 상이 된다.
 * 대신 평범한 승리 뒤는 `weight` 1짜리 가벼운 자리다.
 */
export function buildMatchPress(state: GameState, matchId: string): PressConference | null {
  const match = state.matches.find((m) => m.id === matchId);
  const result = match?.result;
  if (!match || !result) return null;
  /**
   * **친선 뒤에는 회견이 없다** (season.md §2). 프리시즌은 감독이 판을 시험하는
   * 자리이고, 회견은 시험을 값으로 만든다 — 친선 3경기 무승이 `pressure` 회견(무게 3,
   * 폭 ±12)을 열어, 답하지 않고 다음 친선으로 가는 것만으로 언론 평판이 무너졌다.
   */
  if (isFriendly(match)) return null;
  const outcome = outcomeOf(state, match);
  if (!outcome) return null;
  const home = match.homeTeamId === state.userTeamId;
  const opponentId = home ? match.awayTeamId : match.homeTeamId;
  const opponent = teamNameIn(state, opponentId);
  const usGoals = home ? result.homeGoals : result.awayGoals;
  const themGoals = home ? result.awayGoals : result.homeGoals;
  const score = `${result.homeGoals}-${result.awayGoals}`;

  /**
   * 무승 계단은 **시즌의 것이다** — 친선도 지난 시즌도 세지 않는다(`recentOutcomes`,
   * slump.ts와 같은 자). 라커룸의 연패 판정과 기자의 무승 판정이 다른 경기를 세면
   * 같은 국면을 두 눈금으로 말하게 된다.
   */
  const recent = recentOutcomes(state, state.userTeamId, WINLESS_WINDOW);
  const winless = recent.length >= WINLESS_STREAK && recent.every((r) => r !== "win");

  /**
   * **사실만 넘긴다.** 기자의 질문은 GM이 이 카드들로 직접 쓴다 — 코어가 문장을
   * 박아 두면 시즌 내내 같은 말이 반복되고, 기자의 성격도 그날의 맥락도 문장에
   * 닿지 못한다 (overview.md §1 철칙 4).
   */
  const facts: PressFact[] = [
    {
      kind: "result",
      data: {
        refId: opponentId,
        name: opponent,
        values: { for: usGoals, against: themGoals },
        tags: ["match", outcome, home ? "home" : "away"],
      },
      about: null,
      sharp: outcome === "loss" || (outcome === "draw" && winless),
    },
  ];
  /**
   * **더비는 끝난 뒤에도 자리를 남긴다** (people.md §4). 이기고도 묻는 것은 더비가
   * 결과와 무관하게 팬과 구단의 자리이기 때문이고(전야 회견이 무게 2인 것과 같은
   * 이유), 날 선 카드라 이 회견의 무게가 언제나 2가 된다.
   *
   * 전적은 **이번 경기를 빼고** 센다 — 넣으면 첫 더비가 이미 1승 0패로 시작한다.
   */
  const derby = derbyOf(state.userTeamId, opponentId);
  if (derby) {
    const record = derbyRecordOf(state, opponentId, matchId);
    facts.push({
      kind: "result",
      data: {
        refId: opponentId,
        name: opponent,
        values: { won: record.won, drawn: record.drawn, lost: record.lost, heat: derby.heat },
        tags: ["derby", derby.name],
      },
      about: null,
      sharp: true,
    });
  }
  /**
   * **상대 벤치도 그날 마이크 앞에 섰다** (people.md §4) — 자리를 열지 않고 이미
   * 열리는 자리에 얹힌다. 결과 카드 바로 뒤인 것은 그 말이 이 경기에 대한 것이라서다.
   */
  const rivalQuote = rivalQuoteFact(state, match, "post");
  if (rivalQuote) facts.push(rivalQuote);

  if (winless) {
    facts.push({
      kind: "winless",
      data: { values: { matches: recent.length }, tags: [...recent] },
      about: null,
      sharp: true,
    });
  }
  const target = questionablePlayer(state, state.seed + state.matches.length);
  if (target) {
    const reason = issueReasonOf(state, target.id);
    /**
     * ⚠️ **어긴 약속은 폼을 이긴다.** 약속 파기는 사기를 `PROMISE.brokenMorale`(−8)
     * 깎으므로 그 선수의 폼은 대개 함께 내려가 있다 — 폼으로 카드를 고르면 그를
     * 부른 이유가 지워지고 기자가 "폼이 떨어졌다"를 묻는다 (people.md §5-2).
     */
    const slumping = reason !== "promise" && target.state.form < SLUMPING_FORM;
    facts.push({
      kind: slumping ? "slump" : "unhappy",
      data: slumping
        ? { name: target.name, tags: [formLabel(target.state.form)] }
        : { name: target.name, tags: reason ? ["named", reason] : ["named"] },
      about: target.id,
      sharp: true,
    });
  }

  /**
   * **마일스톤은 그 경기의 회견에만 실린다** (people.md §4). 이 함수는 마감이
   * 정산을 끝낸 **뒤**에 불리므로(`finalizeMatch`) 그 경기의 기록이 이미 장부에 있다.
   *
   * 한 경기에 여럿이 서면 **드문 것 하나만** 오른다 — 셋을 다 실으면 그 회견이
   * 시상식이 된다. 목록은 이미 드문 순으로 온다(`compareMilestones`)므로 첫 줄이
   * 그 하나다. 나머지는 선수 상세와 서사 메모에 그대로 있다.
   *
   * 선수가 명부에서 잡히지 않으면 카드를 세우지 않는다 — 이름 자리에 id를 흘리면
   * 기자가 그것을 사람 이름으로 읽는다.
   */
  const milestone = matchMilestones(state, matchId)[0];
  const achiever = milestone ? playerById(state, milestone.gamePlayerId) : null;
  if (milestone && achiever) {
    facts.push({
      kind: "milestone",
      data: { name: achiever.name, values: { value: milestone.value }, tags: [milestone.code] },
      about: achiever.id,
      /** 날 선 자리가 아니다 — 기자가 캐물을 일이 아니라 물어봐 줄 일이다 (people.md §4) */
      sharp: false,
    });
  }

  /**
   * 은퇴 예고와 작별 — 1월에 선 예고는 2주 안의 회견에, 마지막 홈경기의 결과는 그
   * 경기의 회견에 실린다 (season.md §6). 둘은 같은 자리에 함께 서지 않는다: 예고는
   * 1월이고 마지막 홈경기는 5월이다.
   */
  facts.push(...retirementFacts(state), ...farewellResultFacts(state, match));

  /** 감독 자신의 통산이 넘은 문턱 — 그 경기의 회견에만 실린다 (career.md §6) */
  const managerHit = managerMilestoneFact(state, match, outcome);
  if (managerHit) facts.push(managerHit);

  /**
   * **시즌 최종전이면 그 시즌을 묻는 자리로 갈린다** (people.md §4). 결과도
   * 마일스톤도 평소처럼 서고, 그 위에 지금 선 자리와 보드가 건 자리가 얹힌다.
   *
   * ⚠️ 순위는 **그날의 순위표**다 — 같은 라운드의 남은 경기가 아직 안 치러졌을 수
   * 있어, 최종 확정은 시즌 리뷰의 것이다 (career.md §6). 감독이 보는 표와 기자가
   * 아는 표가 같아야 하므로 여기서 미리 확정하지 않는다.
   */
  const seasonFinale = isSeasonFinale(state, match);
  if (seasonFinale) facts.push(...seasonEndFacts(state));

  const trigger: PressTrigger = seasonFinale ? "season-end" : winless ? "pressure" : "match";
  const outcomeKo = outcome === "win" ? "승리" : outcome === "draw" ? "무승부" : "패배";
  return {
    id: `press-${matchId}`,
    date: state.date,
    trigger,
    reporterId: reporterFor(state, trigger),
    /**
     * 자리의 국면 한 줄 — **기록은 여기 오지 않는다.** 사실 카드가 이름과 눈금을
     * 이미 들고 있어(`milestone`), 같은 사실을 국면에도 적으면 기자가 한 회견에서
     * 두 번 묻는다. 국면은 그 자리의 온도(스코어·무승 계단)이지 그날의 사건 목록이 아니다.
     */
    context:
      `${seasonFinale ? "시즌 최종전 · " : ""}${derby ? `${derby.name} · ` : ""}` +
      `${opponent}전 ${score} ${outcomeKo}` +
      (winless ? ` · 최근 ${recent.length}경기 무승` : ""),
    facts,
    status: "pending",
    weight: weightOf(
      trigger,
      facts.some((f) => f.sharp),
      match.stage,
    ),
  };
}

/**
 * 시즌 최종전의 사실 — **지금 선 자리와 보드가 건 자리.** 기대에 못 미치면 날 선
 * 자리가 된다: 그 시즌을 묻는 자리에서 감독이 답해야 할 것이 그것이다.
 */
export function seasonEndFacts(state: GameState): PressFact[] {
  const standings = computeStandings(state);
  const index = standings.findIndex((row) => row.ours);
  const row = standings[index];
  const facts: PressFact[] = [];
  if (row) {
    facts.push({
      kind: "standing",
      data: { values: { rank: index + 1, played: row.played }, tags: [] },
      about: null,
      sharp: false,
    });
  }
  facts.push(...boardFacts(state));
  facts.push(...awardFacts(state));
  return facts;
}

/**
 * 지금 우리 선수단이 **가장 최근에 매겨진 시즌**에 받은 상 — 개막 전야와 시즌
 * 최종전이 같은 함수를 쓴다 (season.md §6 「상이 사실로 서는 자리」).
 * 어느 셔츠로 받았는지는 묻지 않는다.
 *
 * ⚠️ **명단 배열 순서로 자르지 않는다** — 유스 승격·은퇴가 배열을 흔들면 같은 세이브가
 * 다른 두 장을 싣는다. `id`로 한 겹 정렬해 자르는 자리를 결정적으로 만든다.
 */
export function awardFacts(state: GameState): PressFact[] {
  return playersOf(state, state.userTeamId)
    .map((p) => p.id)
    .sort()
    .flatMap((id) => lastSeasonAwardsOf(state, id))
    .slice(0, AWARD_FACTS_SHOWN)
    .map((a) => awardFact(a, { named: true }));
}

/**
 * 부임 회견을 연다 — **하루에 한 번.** 같은 날을 다시 지나도 자리가 둘이 되지 않는다.
 */
export function openAppointmentPress(state: GameState): void {
  const conference = buildAppointmentPress(state);
  if (state.pressConferences.some((c) => c.id === conference.id)) return;
  openPress(state, conference);
}

// ── 감독 자신의 거취 (career.md §5.4) ──────────────────

/**
 * 만료 90일 안이면 **어느 회견이든** 감독의 거취가 선다 (people.md §4).
 *
 * ⚠️ 유출과 달리 **소비되지 않는다.** 원인이 계약 그 자체라 만료일까지 사라지지
 * 않고, 보드의 판정이 갈리면 다음 회견이 새 코드로 다시 묻는다.
 */
/**
 * 시즌 개막 전야 — 한 시즌에 한 번뿐인 자리라 id도 시즌으로 잡는다.
 * 무게 1인 것은 아직 아무 일도 일어나지 않았기 때문이다 — 물을 수 있는 것은 기대뿐이다.
 */
export function buildOpeningPress(
  state: GameState,
  input: { opponent: string; home: boolean },
): PressConference {
  const facts: PressFact[] = [
    {
      kind: "fixture",
      data: { name: input.opponent, tags: ["opening", input.home ? "home" : "away"] },
      about: null,
      sharp: false,
    },
    ...boardFacts(state),
  ];
  /**
   * **언론이 매긴 예상** — 보드 기대 카드 바로 옆이다 (people.md §4-1 · season.md §2).
   * 둘이 갈릴 때가 기자가 물을 자리라, 하나만 서면 그 질문이 서지 않는다. 예상이
   * 서지 않은 시즌(소집일을 지나지 않은 시즌)에는 카드도 없다.
   */
  const predictionRow = predictionOf(state, leagueOfTeamIn(state, state.userTeamId));
  const predicted = predictedPlaceOf(state, state.userTeamId);
  if (predictionRow && predicted !== null) {
    facts.push({
      kind: "standing",
      data: {
        values: { rank: predicted, teams: predictionRow.order.length },
        tags: ["media-prediction"],
      },
      about: null,
      // 예상이 보드 기대보다 아래면 날 선 자리다 — 감독이 답해야 할 것이 그것이다
      sharp: false,
    });
  }
  const inherited = summerNumberInheritance(state);
  if (inherited) facts.push(inherited);
  facts.push(...awardFacts(state));

  return {
    id: `press-opening-${state.season}`,
    date: state.date,
    trigger: "opening",
    reporterId: reporterFor(state, "opening"),
    context: `시즌 개막 전야 · ${input.opponent}전`,
    facts,
    status: "pending",
    weight: 1,
  };
}

/**
 * 전야 회견 — **경기 전날에 선다** (people.md §4). tick이 하루에 한 번 부른다.
 *
 * 경기를 치르고 나면 경기 뒤 회견이 이 자리를 밀어내므로(`openPress`) 전야가
 * 아니면 자리가 없다. 트리거는 둘이고 **더비가 개막을 이긴다** — 개막전이 더비면
 * 물어야 할 것은 더비 쪽이다.
 */
export function openEvePress(state: GameState, digest?: TickSink): void {
  const leagueId = leagueOfTeamIn(state, state.userTeamId);
  const tomorrow = addDays(state.date, 1);
  /**
   * **우리 리그 경기만이다.** 친선은 회견이 없고(season.md §2), 컵과 대항전은
   * 대회 id로 갈린다 — 대항전 리그 페이즈는 `stage`가 없어 단계로는 리그와
   * 구분되지 않는다.
   */
  const match = state.matches.find(
    (m) =>
      m.date === tomorrow &&
      !m.result &&
      m.competitionId === leagueId &&
      !isFriendly(m) &&
      (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
  );
  if (!match) return;

  const home = match.homeTeamId === state.userTeamId;
  const opponentId = home ? match.awayTeamId : match.homeTeamId;
  const opponent = teamNameIn(state, opponentId);
  const derby = derbyNameOf(state.userTeamId, opponentId);

  /**
   * **전야의 자리는 하나다** (people.md §4). 우선순위는 더비 > 개막 > 작별이고,
   * 앞의 것이 그날을 이미 잡았으면 뒤의 것은 자리를 빼앗지 않고 카드만 얹힌다 —
   * 같은 날 회견 둘을 열면 하나가 방치로 닫힌다.
   */
  const farewell = farewellFacts(state, match);
  const conference = derby
    ? buildDerbyPress(state, match, { derby, opponentId, opponent, home })
    : isSeasonOpener(state, match, leagueId)
      ? buildOpeningPress(state, { opponent, home })
      : farewell.length > 0
        ? buildFarewellPress(state, { opponent, facts: farewell })
        : null;
  if (!conference) return;
  if (conference.trigger !== "farewell") conference.facts.push(...farewell);
  /**
   * 전야의 상대 감독 — 경기 뒤와 **다른 채널로 뽑는다** (people.md §4). 찌르는 말은
   * 유출과 같은 규약으로 자리를 키운다.
   */
  const rivalQuote = rivalQuoteFact(state, match, "eve");
  if (rivalQuote) {
    conference.facts.push(rivalQuote);
    if (rivalQuote.sharp) conference.weight = Math.max(conference.weight, 2);
  }
  // 하루에 한 번 — 같은 날을 다시 지나도 자리가 둘이 되지 않는다
  if (state.pressConferences.some((c) => c.id === conference.id)) return;
  openPress(state, conference, digest);
}

/**
 * 방금 선 은퇴 예고 — 경기 뒤 회견이 싣는다 (people.md §4).
 *
 * 날 선 자리가 아니다: 감독을 몰아세우는 사실이 아니라 그 자리에 있는 사람의 마지막
 * 시즌이다. 사유 코드를 함께 드는 것은 서른다섯의 은퇴와 뛰지 못한 서른넷의 은퇴가
 * 기자에게 다른 질문이기 때문이다.
 */
export function retirementFacts(state: GameState): PressFact[] {
  const judgeDate = retirementJudgeDate(state.season);
  const facts: PressFact[] = [];
  for (const player of retiringPlayers(state)) {
    const declared = player.state.retiringAfterSeason;
    if (!declared || diffDays(declared.on, state.date) > RETIREMENT_PRESS_DAYS) continue;
    const ours = careerTotalsOf(state, player.id, state.userTeamId);
    facts.push({
      kind: "retirement",
      data: {
        name: player.name,
        values: {
          age: ageOf(player.birthdate, judgeDate),
          apps: ours.apps,
          goals: ours.goals,
        },
        tags: [declared.reason],
        date: declared.on,
      },
      about: player.id,
      sharp: false,
    });
    if (facts.length >= FAREWELL_NAMES_SHOWN) break;
  }
  return facts;
}

/**
 * 회견을 상태에 올린다.
 *
 * ⚠️ **앞의 회견이 열린 채로 새 회견이 오면 앞의 것은 거절로 닫힌다.** 감독이
 * 답하지 않고 다음 경기로 가버린 것이고, 실제로도 그 자리는 지나간 것이다.
 * 대가도 거절과 같아야 한다 — 무시가 공짜면 아무도 답하지 않는다.
 */
export function openPress(state: GameState, conference: PressConference, digest?: TickSink): void {
  declinePendingPress(state, digest);
  loadLeaks(state, conference);
  loadIncidents(state, conference);
  loadCallUps(state, conference);
  loadManagerContract(state, conference);
  state.pressConferences.push(conference);
  // 지나간 회견은 서사에 남지 상태로 쌓일 이유가 없다
  if (state.pressConferences.length > KEPT_CONFERENCES) {
    state.pressConferences = state.pressConferences.slice(-KEPT_CONFERENCES);
  }
  digest?.push(`기자회견 — ${conference.context}`);
}
