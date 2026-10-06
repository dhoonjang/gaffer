import {
  type PlayerMoveKind,
  type CallUp,
  type GamePlayer,
  injuryHistoryText,
  josaOf,
  SQUAD_STATUS_KO,
  ageOf,
  associationName,
  capsOf,
  internationalGoalsOf,
  conditionLabel,
  growthLabel,
  milestoneTitle,
  naturalPositionOf,
  rolesFor,
  seasonRating,
} from "@gaffer/domain";
import { formatMoney } from "../../team/finance";
import { observedPlayerFacts, type Knowledge } from "../../players/observation";
import { suspensionScopeName } from "../../core/catalog/discipline-catalog";
import {
  daysUntilReturn,
  internationalBreaksOf,
  type InternationalBreak,
} from "../../players/international";
import {
  openCallUp,
  activeContract,
  activeSuspension,
  assignmentFor,
  groupOf,
  openInjury,
  resolvePlayerRef,
  seasonStatOf,
  teamNameIn,
  teamShortNameIn,
  type GameState,
} from "../../core/state";
import { careerOf, type CareerTotals } from "../../players/career";
import { formLabel } from "../../players/form";
import { INJURY_SEVERITY_KO, injuryHistoryOf } from "../../players/injury";
import { numberLineageOf } from "../../players/numbers";
import { squadStatusOf } from "../../players/contract-status";
import { competitionShortName } from "../../core/catalog/cup-catalog";
import {
  attributeLine,
  knowledgeNote,
  overallView,
  growthView,
  strengthsAndWeaknesses,
} from "../../players/observation-view";
import {
  type LookupResult,
  banWarningFor,
  competitionStatLine,
  pastCompetitionStatLine,
} from "./resolve";

// ── 선수 상세 ───────────────────────────────────────────

/**
 * 그 날짜의 성장을 낸 훈련 결산의 **근거 한 줄** — 없으면 null.
 *
 * 카드는 구간(`from`~`to`)을 갖고 성장 로그는 그 구간 안의 훈련 날짜를 가리키므로,
 * 그 날짜를 품은 카드에서 이 선수의 줄을 찾는다. 링에서 밀려난 옛 구간의 근거는
 * 없다 — 그때는 눈금만 남는다 (docs/players/training.md).
 */
function trainingNoteFor(state: GameState, playerId: string, date: string): string | null {
  for (const report of state.trainingReports) {
    if (date < report.from || date > report.to) continue;
    const note = report.marks.find((m) => m.gamePlayerId === playerId)?.note;
    if (note !== undefined && note.length > 0) return note;
  }
  return null;
}

const CAUSE_KO: Record<string, string> = { match: "경기", training: "훈련", other: "기타" };
/** 이동 한 줄의 낱말 — 갈래 코드마다 하나 */
const MOVE_KO: Record<PlayerMoveKind, string> = {
  youth: "유스 승격",
  reinforcement: "합류",
  transfer: "이적",
  free: "자유계약 합류",
  expiry: "계약 만료",
  retire: "은퇴",
};

/**
 * 카드에 세울 **시즌 행·팀 행의 상한.**
 *
 * 스무 시즌을 뛴 선수의 행을 전부 쏟으면 카드가 벽이 되는데, 모델이 판단에 쓰는
 * 것은 최근 몇 해다 — 계약이 보통 3~5년이라 다섯이면 "지금 이 선수가 어떤
 * 선수인가"를 가르는 구간이 통째로 들어온다. 잘린 앞쪽은 **통산 합이 말한다**:
 * 합은 전 시즌의 것이라, 적힌 행을 더해 통산이 안 나오면 그 차이가 곧 "더
 * 있다"는 뜻이다.
 */
const CAREER_ROWS_SHOWN = 5;

/**
 * 마일스톤 상한 — 문턱(50·100경기)은 드물지만 해트트릭은 시즌마다 쌓인다.
 * 고르기는 최근 것부터, 적기는 **오래된 것부터**다 (부상·이동 이력과 같은 결이고,
 * 한 경기가 여럿을 세웠을 때의 드문 순서도 장부에 적힌 그대로 남는다).
 */
const MILESTONES_SHOWN = 4;

/** 커리어 한 묶음의 수치 — 위 「시즌 기록」과 같은 낱말이라 여러 줄이 한 자로 읽힌다 */
export function careerStatText(t: CareerTotals): string {
  return (
    `${t.apps}경기 ${t.goals}골 ${t.assists}도움` +
    (t.rating === null ? "" : ` · 평점 ${t.rating.toFixed(2)}`) +
    (t.reserveApps > 0 ? ` (2군 ${t.reserveApps}경기 ${t.reserveGoals}골)` : "")
  );
}

/**
 * 통산 · 팀별 · 시즌별 · 마일스톤 — 전부 `careerOf` **하나에서** 나온다
 * (player.md §10). 화면의 스쿼드 상세가 읽는 표와 같은 함수라, 감독이 채팅에서
 * 듣는 "우리 팀에서 132경기"와 상세의 행이 갈리지 않는다.
 *
 * **기록은 안개 밖이다** — 흐리는 것은 능력치이지 장부가 아니라 타 팀 선수도
 * 참값 그대로 낸다. 다만 원장은 게임 시작 뒤만 알아 **부임 전 커리어는 없다**:
 * 없는 것은 지어내지 않고 줄을 세우지 않는다.
 *
 * 마일스톤은 **감독 팀 선수의 장부**다 (game-state.md §3.4) — 남의 팀 선수에게는
 * 줄이 서지 않는 것이 정상이고, 그것이 "기록이 없다"는 뜻은 아니다.
 */
function careerLines(state: GameState, p: GamePlayer): string[] {
  const lines: string[] = [];
  const career = careerOf(state, p.id);
  // 출전이 0인 행은 세우지 않는다 — 빈 자리를 만들어 두면 카드가 길어지기만 한다
  const played = (t: CareerTotals) => t.apps > 0 || t.reserveApps > 0;
  const seasons = career.seasons.filter(played);
  /**
   * 이번 시즌 이 팀 한 행뿐이면 위의 「시즌 기록」이 이미 같은 값을 말했다 —
   * 같은 수를 두 낱말로 두 번 적으면 모델은 그것을 다른 사실 둘로 읽는다.
   */
  const only = seasons.length === 1 ? seasons[0]! : null;
  const onlyCurrent = only !== null && only.season === state.season && only.teamId === p.teamId;
  if (played(career.totals) && !onlyCurrent) {
    lines.push(`통산: ${careerStatText(career.totals)}`);
    // 팀이 하나면 통산이 곧 그 셔츠의 기록이라, 같은 줄을 한 번 더 적는 셈이다
    const teams = career.teams.filter(played);
    if (teams.length > 1) {
      lines.push(
        `팀별: ${teams
          .slice(-CAREER_ROWS_SHOWN)
          .map((t) => `${teamShortNameIn(state, t.teamId)}(${t.from}~${t.to}) ${careerStatText(t)}`)
          .join(" / ")}`,
      );
    }
    // 시즌 안에 팀을 옮겼으면 행도 팀별로 갈린다 — 합치면 어느 셔츠로 몇 경기를 뛰었는지가 사라진다
    if (seasons.length > 1) {
      lines.push(
        `시즌별: ${seasons
          .slice(-CAREER_ROWS_SHOWN)
          .map((s) => `${s.season} ${teamShortNameIn(state, s.teamId)} ${careerStatText(s)}`)
          .join(" / ")}`,
      );
    }
  }
  /** 클럽 단위의 사실이라 어느 셔츠로 세웠는지를 함께 적는다 (match.md §6) */
  const milestones = state.milestones
    .filter((m) => m.gamePlayerId === p.id)
    .slice(-MILESTONES_SHOWN)
    .map((m) => `${m.date} ${teamShortNameIn(state, m.teamId)} ${milestoneTitle(m.code, m.value)}`);
  if (milestones.length > 0) lines.push(`마일스톤: ${milestones.join(" / ")}`);
  return lines;
}

/**
 * 선수의 **이력** — 부상·징계·이동. 현재 상태만 보여주면 "유리몸인가",
 * "경고 몇 장이야(5장이면 자동 정지)" 같은 판단을 감독이 할 수 없다.
 * 부상·징계·이동은 공개 기록이라 타 팀 선수에게도 안개를 걸지 않는다.
 */
function historyLines(state: GameState, p: GamePlayer): string[] {
  const lines: string[] = [];

  const injuries = state.injuries.filter((i) => i.gamePlayerId === p.id);
  if (injuries.length > 0) {
    const { daysOut } = injuryHistoryOf(state, p.id, null);
    const recent = injuries
      .slice(-3)
      .map(
        (i) =>
          `${i.occurredOn} ${i.bodyPart}(${INJURY_SEVERITY_KO[i.severity]}·${CAUSE_KO[i.cause] ?? i.cause})` +
          (i.returnedOn ? ` ~${i.returnedOn}` : " 복귀 전"),
      );
    lines.push(
      `부상 이력: 총 ${injuries.length}회 · 누적 결장 ${daysOut}일 — ${recent.join(" / ")}`,
    );
  }

  const bookings = state.bookings.filter(
    (b) => b.gamePlayerId === p.id && b.season === state.season,
  );
  const yellows = bookings.filter((b) => b.card === "yellow").length;
  const reds = bookings.filter((b) => b.card === "red").length;
  if (yellows > 0 || reds > 0) {
    /**
     * **대회별로 나눠 낸다** — 누적은 대회 안에서만 쌓이므로(match.md §6) 한 줄로
     * 합치면 컵에서 받은 두 장이 리그 정지를 부르는 것처럼 읽힌다.
     */
    const perCompetition = new Map<string | null, number>();
    for (const b of bookings) {
      if (b.card !== "yellow") continue;
      const c = b.competitionId;
      perCompetition.set(c, (perCompetition.get(c) ?? 0) + 1);
    }
    const split = [...perCompetition.entries()]
      .map(([c, n]) => ({ name: competitionShortName(c), n }))
      .sort((a, z) => z.n - a.n || (a.name < z.name ? -1 : 1))
      .map((r) => `${r.name} ${r.n}장`)
      .join(" · ");
    lines.push(
      `징계 이력 (이번 시즌): 경고 ${yellows}장${split ? ` (${split})` : ""} · 퇴장 ${reds}회` +
        (yellows > 0 ? banWarningFor(state, p) : ""),
    );
  }

  const moves = state.moves
    .filter((m) => m.gamePlayerId === p.id)
    .slice(-3)
    .map(
      (m) =>
        `${m.date} ${MOVE_KO[m.kind]} ` +
        `${m.fromTeamId ? teamShortNameIn(state, m.fromTeamId) : "—"}→${m.toTeamId ? teamShortNameIn(state, m.toTeamId) : "—"}`,
    );
  if (moves.length > 0) lines.push(`이동 이력: ${moves.join(" / ")}`);

  return lines;
}

/** 그 자리에서 맡고 있는 세부 역할의 한글 이름 (미지정이면 기본 역할) */
export function roleLabel(position: string, roleId?: string): string {
  const defs = rolesFor(position);
  return (defs.find((r) => r.id === roleId) ?? defs[0])?.ko ?? "기본";
}

/** 되물을 후보 줄 — 이름과 id를 함께 준다 (모델이 다음 호출에 쓸 것은 id다) */
export const candidateLine = (players: readonly GamePlayer[]): string =>
  players
    .slice(0, CANDIDATES_SHOWN)
    .map((p) => `${p.name}(${p.id})`)
    .join(" / ");

export const CANDIDATES_SHOWN = 6;

/**
 * 국적 한 칸 — 코드와 표기를 함께 낸다. 코드만 실으면 모델이 `KVX`를 읽고 말을
 * 지어내고, 표기만 실으면 규정을 논하는 자리에서 무엇으로 걸러야 할지가 사라진다.
 * 조사가 닿지 않은 선수는 없다고 적는다 — 지어내지 않는다.
 */
function nationalityText(p: Pick<GamePlayer, "nationality" | "secondNationality">): string {
  if (p.nationality === undefined) return "국적 정보 없음";
  const one = (code: string): string => `${associationName(code)}(${code})`;
  return `국적 ${one(p.nationality)}${p.secondNationality === undefined ? "" : ` · 둘째 국적 ${one(p.secondNationality)}`}`;
}

/** 그 소집이 선 창 — 키가 시즌을 들고 있어 날짜는 거기서 파생한다 */
function breakOfKey(breakKey: string): InternationalBreak | null {
  const season = Number(breakKey.split(":")[0]);
  if (!Number.isFinite(season)) return null;
  return internationalBreaksOf(season).find((w) => w.key === breakKey) ?? null;
}

/**
 * 정산이 끝난 가장 최근 소집 — 소집 표는 감독 팀 행만 남기므로 남의 선수에게는
 * 늘 없다 (competition.md §5-1). 행은 창 순서로 쌓이므로 뒤에서 찾는다.
 */
function lastReturnedCallUp(state: GameState, playerId: string): CallUp | null {
  const rows = state.callUps.filter((c) => c.gamePlayerId === playerId && c.returnedOn !== null);
  return rows[rows.length - 1] ?? null;
}

/**
 * **통산 A매치 한 줄** (competition.md §5-1) — 통산 커리어와 같은 결로 선다.
 *
 * 캡이 0이면 줄을 세우지 않는다: 세계의 대다수가 그렇고, 카드의 규약이 「0인 칸은
 * 적지 않는다」다. 어느 협회인지는 머리글의 국적 줄이 이미 말하므로 두 번 적지
 * 않는다. 최근 소집이 남긴 출전·골은 어느 창의 것인지와 함께 조각으로 붙는다 —
 * 창 이름이 없으면 모델이 그 수를 통산 옆의 다른 통산으로 읽는다.
 *
 * **안개 밖의 사실이다** — 흐리는 것은 능력치이지 공개된 기록이 아니라 남의 팀
 * 선수도 통산 그대로 낸다 (`careerLines`와 같은 기준).
 */
function internationalLine(state: GameState, p: GamePlayer): string | null {
  const caps = capsOf(p.state);
  if (caps === 0) return null;
  const goals = internationalGoalsOf(p.state);
  const last = lastReturnedCallUp(state, p.id);
  const window = last === null ? null : breakOfKey(last.breakKey);
  // 첫 소집이어도 그 창에서 못 뛰었으면 데뷔가 아니다 — `debut`은 소집 시점의 캡이 0이었다는 표식이다
  const debut = last !== null && last.debut === true && last.apps > 0;
  return (
    `A매치: 통산 ${caps}경기${goals > 0 ? ` ${goals}골` : ""}` +
    (last !== null && window !== null
      ? ` · ${window.label} ${last.apps}경기${last.goals > 0 ? ` ${last.goals}골` : ""}${debut ? " (대표팀 데뷔)" : ""}`
      : "")
  );
}

/**
 * **지금 클럽을 떠나 있다** — 부상·정지와 같은 갈래의 사실이라 같은 자리에 선다
 * (competition.md §5-1 · season.md §8 불변식). 소집이든 여름 대회든 감독이 이번
 * 주에 그를 쓸 수 없다는 뜻은 하나다.
 */
function awayFromClubLine(state: GameState, p: GamePlayer): string | null {
  const callUp = openCallUp(state, p.id);
  if (callUp !== null) {
    const window = breakOfKey(callUp.breakKey);
    return (
      `대표팀 소집 중: ${associationName(callUp.country)}(${callUp.country})` +
      (window === null ? "" : ` — ${window.to} 복귀 (${daysUntilReturn(state, window)}일 남음)`)
    );
  }
  const summer = p.state.summerReturn;
  if (summer !== undefined && state.date < summer) {
    return `여름 대회 참가 중: ${summer} 합류 예정`;
  }
  return null;
}

export function playerCard(state: GameState, playerId: string): LookupResult {
  // id가 정확하지 않으면 이름으로 푼다 — 모델은 감독이 부른 이름을 그대로 넣는다
  const { player: p, candidates } = resolvePlayerRef(state.players, playerId);
  if (!p) {
    return {
      ok: false,
      message:
        candidates.length > 0
          ? `"${playerId}"${josaOf(playerId, "은/는")} 여러 선수와 맞습니다 — ${candidateLine(candidates)}`
          : `"${playerId}"${josaOf(playerId, "이라는/라는")} 선수를 찾지 못했습니다 — search_players로 id를 먼저 확인하라`,
    };
  }
  const facts = observedPlayerFacts(state, p);
  const knowledge: Knowledge = facts.knowledge;
  const stat = seasonStatOf(state, p.id);
  const contract = activeContract(state, p.id);
  const injury = openInjury(state, p.id);
  const suspension = activeSuspension(state, p.id);
  const lines: string[] = [
    `[선수 카드] ${p.name} — ${teamNameIn(state, p.teamId)} · ${ageOf(p.birthdate, state.date)}세 · ` +
      `${nationalityText(p)} · 주포지션 ${naturalPositionOf(p).position} (${groupOf(p)}) · id ${p.id}`,
    knowledgeNote(state, p.id),
    `능력치: ${attributeLine(state, p, facts)}`,
    `종합: ${overallView(state, p, facts)} · 성장 가능성: ${growthView(state, p, facts)}`,
  ];

  if (knowledge === "own") {
    // 등급이 아니라 이력이다 — 위태로운지는 읽는 쪽이 판단한다 (player.md §5.3)
    const history = injuryHistoryText(injuryHistoryOf(state, p.id));
    lines.push(
      `컨디션: 폼 ${formLabel(p.state.form)} · 체력 ${p.state.condition} (${conditionLabel(p.state.condition)})`,
      ...(history === null ? [] : [`부상 이력: ${history}`]),
      `소화 포지션: ${p.positions
        .map((x) => `${x.position}${x.isNatural ? "*" : ""}${x.proficiency}`)
        .join(" / ")}`,
    );
    const assignment = assignmentFor(state, p.id);
    lines.push(
      assignment
        ? `전술: ${assignment.role === "starting" ? "선발" : "벤치"} ${assignment.position}` +
            ` (${roleLabel(assignment.position, assignment.roleId)})` +
            ` · 전술적응 ${assignment.familiarity}`
        : "전술: 배치 없음 (예비 스쿼드)",
    );
    /**
     * 최근 성장 — **대상은 낱말로 싣는다.** `pos:CB`는 장부의 코드지 표기가
     * 아닌데, 그대로 실으면 모델이 그 코드를 그대로 감독에게 옮긴다.
     * 훈련 결산이 올린 줄에는 그 판정의 **근거 한 줄**이 함께 선다 — 근거가
     * 닿는 조회 자리는 여기 하나다 (docs/players/training.md).
     */
    const growth = state.growthLog
      .filter((g) => g.gamePlayerId === p.id)
      .slice(-5)
      .map((g) => {
        const head = `${g.date} ${growthLabel(g.target)} ${g.delta > 0 ? "+" : ""}${g.delta}`;
        const why =
          g.origin === "training-settlement" ? trainingNoteFor(state, p.id, g.date) : null;
        return why ? `${head} (${why})` : head;
      });
    if (growth.length > 0) lines.push(`최근 성장: ${growth.join(" / ")}`);
  } else {
    const { strengths, weaknesses } = strengthsAndWeaknesses(state, p);
    lines.push(`인상: 강점 ${strengths.join("·")} / 약점 ${weaknesses.join("·")}`);
  }

  /**
   * 계약 줄이 **장부를 함께 든다** — 지위·조항·조건 (people.md §5-2 ·
   * transfer.md §12-3).
   *
   * 지위와 조건은 우리 계약의 칸이라 남의 선수에게는 적지 않는다 — 안개 밖에서 지어낸
   * 사실이 된다.
   * ⚠️ 문장이 아니라 사실이다: 갈래와 기한·금액, 그뿐이다. 표 밖의 조건(`other`)만은
   * 감독이 한 말 그대로가 사실이라 그 줄이 그대로 선다.
   */
  const contractFacts =
    knowledge === "own" ? [`${SQUAD_STATUS_KO[squadStatusOf(state, p)]} 지위`] : [];
  /**
   * 등번호와 그 번호의 **계보** — 지위·약속과 같은 결의 장부 줄이다 (player.md §1.1).
   *
   * ⚠️ 문장이 아니라 사실이다: 지금 번호와, 앞서 그것을 달던 사람·시즌 수·몇 시즌
   * 만인가뿐이다. 계보는 시즌 기록에서 파생하므로 우리 선수 카드에서만 세운다 —
   * 남의 구단 번호의 계보는 감독이 조사한 적 없는 사실이다.
   */
  if (knowledge === "own" && p.squadNumber !== undefined) {
    const past = numberLineageOf(state, p.teamId, p.squadNumber).past;
    lines.push(
      `등번호: ${p.squadNumber}번` +
        (past.length === 0
          ? ""
          : ` — 앞서 ${past
              .map((entry, i) =>
                i === 0
                  ? `${entry.name} ${entry.seasons}시즌 · ${state.season - entry.lastSeason}시즌 만에`
                  : `${entry.name} ${entry.seasons}시즌`,
              )
              .join(" / ")}`),
    );
  }
  /**
   * 시즌 기록의 나머지 — **0인 칸은 적지 않는다** (match.md §6). 스트라이커의 카드에
   * "선방 0"이, 골키퍼의 카드에 "슛 0"이 서면 모델이 그 0을 사실로 옮겨 적는다.
   */
  const seasonMore = [
    stat?.minutes ? `${stat.minutes}분` : null,
    stat?.shots ? `슛 ${stat.shots}` : null,
    stat?.xg ? `xG ${stat.xg.toFixed(2)}` : null,
    stat?.saves ? `선방 ${stat.saves}` : null,
    stat?.cleanSheets ? `클린시트 ${stat.cleanSheets}` : null,
    stat?.yellows ? `경고 ${stat.yellows}` : null,
    stat?.reds ? `퇴장 ${stat.reds}` : null,
  ].filter((x): x is string => x !== null);
  const international = internationalLine(state, p);
  const byCompetition = competitionStatLine(state, p.id);
  const lastByCompetition = pastCompetitionStatLine(state, p.id);
  lines.push(
    `시즌 기록: ${stat?.apps ?? 0}경기 ${stat?.goals ?? 0}골 ${stat?.assists ?? 0}도움` +
      (seasonRating(stat) === null ? "" : ` · 평점 ${seasonRating(stat)!.toFixed(2)}`) +
      (seasonMore.length > 0 ? ` · ${seasonMore.join(" · ")}` : ""),
    ...(byCompetition === null ? [] : [`대회별: ${byCompetition}`]),
    ...(lastByCompetition === null ? [] : [`지난 시즌 대회별: ${lastByCompetition}`]),
    ...careerLines(state, p),
    ...(international === null ? [] : [international]),
    [
      contract
        ? [
            `계약: 주급 ${formatMoney(contract.weeklyWage)} · 만료 ${contract.until}`,
            ...contractFacts,
          ].join(" · ")
        : "계약: 정보 없음",
    ].join(" · "),
  );
  if (injury) {
    lines.push(
      `부상: ${injury.bodyPart} (${INJURY_SEVERITY_KO[injury.severity]}) — 복귀 예상 ${injury.expectedReturn}`,
    );
  }
  if (suspension) {
    lines.push(
      `징계: ${suspensionScopeName(suspension)} 출장 정지 ${suspension.lengthMatches - suspension.served}경기 남음`,
    );
  }
  const away = awayFromClubLine(state, p);
  if (away !== null) lines.push(away);
  lines.push(...historyLines(state, p));
  return { ok: true, message: lines.join("\n") };
}
